import path from "node:path"
import process from "node:process"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import type {
  LongTaskPromptValidatorContract,
  LongTaskScriptValidatorContract,
  LongTaskSpec,
  LongTaskValidatorContract,
  LongTaskValidatorResult,
  LongTaskWorkUnit,
} from "./contract"
import { writeJsonFile, writeTextFile } from "../fs"
import { runOpencodeTask, type OpencodeTaskInput } from "../opencode"
import type { AutoEvolveConfig } from "../schema"
import { resolveModelSelection } from "../model-selection"
import { writeTaskArtifacts } from "../task-artifacts"
import { runManagedProcess } from "../managed-process"
import { buildLongTaskPromptValidatorPrompt } from "./prompts"
import { extractJsonObject } from "./json-extract"

const GLOBAL_SCRIPT_VALIDATOR_TIMEOUT_MS = (() => {
  const value = Number.parseInt(process.env.AUTO_EVOLVE_SCRIPT_VALIDATOR_TIMEOUT_MS ?? "", 10)
  if (Number.isFinite(value) && value > 0) return value
  return 60 * 60 * 1000
})()

function resolveScriptValidatorTimeoutMs(timeoutMs: number | undefined) {
  if (typeof timeoutMs === "number" && timeoutMs > 0) {
    // Enforce a global lower bound so per-task specs cannot shrink script validators below platform policy.
    return Math.max(timeoutMs, GLOBAL_SCRIPT_VALIDATOR_TIMEOUT_MS)
  }
  return GLOBAL_SCRIPT_VALIDATOR_TIMEOUT_MS
}

function nowISO() {
  return new Date().toISOString()
}

function normalizeDetails(input: unknown) {
  if (!Array.isArray(input)) return []
  return input.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function uniqueStrings(items: string[]) {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)))
}

function capabilityReferencePaths(spec: LongTaskSpec) {
  return uniqueStrings((spec.capabilities ?? []).flatMap((capability) => capability.referencePaths ?? []))
}

function capabilityAttachedFiles(spec: LongTaskSpec) {
  return uniqueStrings((spec.capabilities ?? []).flatMap((capability) => capability.attachedFiles ?? []))
}

function readBooleanField(raw: Record<string, unknown> | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = raw?.[key]
    if (typeof value === "boolean") return value
  }
  return undefined
}

function readStringField(raw: Record<string, unknown> | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = raw?.[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function readDetailsField(raw: Record<string, unknown> | undefined) {
  return normalizeDetails(raw?.details ?? raw?.detailLines ?? raw?.messages)
}

function inferRunner(contract: LongTaskScriptValidatorContract) {
  if (contract.runner) return contract.runner
  const ext = path.extname(contract.path).toLowerCase()
  if (ext === ".py") return "python"
  if (ext === ".ts" || ext === ".js" || ext === ".mjs" || ext === ".cjs") return "bun"
  if (ext === ".ps1") return "powershell"
  if (ext === ".exe" || ext === ".cmd" || ext === ".bat") return "direct"
  return "python"
}

function buildScriptCommand(contract: LongTaskScriptValidatorContract, inputPath: string) {
  const runner = inferRunner(contract)
  const args = contract.args ?? []

  switch (runner) {
    case "python":
      return ["python", contract.path, ...(contract.inputMode === "none" ? [] : [inputPath]), ...args]
    case "bun":
      return [process.execPath, "run", contract.path, ...(contract.inputMode === "none" ? [] : [inputPath]), ...args]
    case "node":
      return ["node", contract.path, ...(contract.inputMode === "none" ? [] : [inputPath]), ...args]
    case "powershell":
      return ["powershell", "-File", contract.path, ...(contract.inputMode === "none" ? [] : [inputPath]), ...args]
    case "direct":
      return [contract.path, ...(contract.inputMode === "none" ? [] : [inputPath]), ...args]
    default:
      return ["python", contract.path, ...(contract.inputMode === "none" ? [] : [inputPath]), ...args]
  }
}

async function runScriptValidator(input: {
  cwd: string
  contract: LongTaskScriptValidatorContract
  spec: LongTaskSpec
  unit: LongTaskWorkUnit
  runID: string
  attempt: number
  validatorDir: string
  payload: Record<string, unknown>
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
  onPulse?: OpencodeTaskInput["onPulse"]
}): Promise<LongTaskValidatorResult> {
  await mkdir(input.validatorDir, { recursive: true })
  const payloadPath = path.join(input.validatorDir, "validator_input.json")
  const stdoutPath = path.join(input.validatorDir, "stdout.log")
  const stderrPath = path.join(input.validatorDir, "stderr.log")
  await writeJsonFile(payloadPath, input.payload)

  const command = buildScriptCommand(input.contract, payloadPath)
  const timeoutMs = resolveScriptValidatorTimeoutMs(input.contract.timeoutMs)
  let managed
  try {
    managed = await runManagedProcess({
      title: input.contract.title,
      command,
      cwd: input.contract.cwd ?? input.cwd,
      runtimeScope: input.runtimeScope,
      timeoutMs,
      onSpawn: async () => {
        await input.onActivation?.()
        await input.onPulse?.()
      },
      onPulse: input.onPulse,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writeTextFile(stdoutPath, "")
    await writeTextFile(stderrPath, [`Validator runtime bootstrap failed after spawn: ${message}`].join("\n\n"))
    throw error
  }
  const stdout = managed.stdout
  const stderr = managed.stderr
  const exitCode = managed.exitCode
  const timedOut = managed.timedOut
  const normalizedStderr = timedOut
    ? [`Validator timed out after ${timeoutMs} ms and the full process tree was terminated.`, stderr]
        .filter(Boolean)
        .join("\n\n")
    : stderr

  await writeTextFile(stdoutPath, stdout)
  await writeTextFile(stderrPath, normalizedStderr)

  const parsed =
    extractJsonObject(stdout, {
      preferredKeys: ["passed", "summary", "details", "blocking"],
    }) ??
    extractJsonObject(stderr, {
      preferredKeys: ["passed", "summary", "details", "blocking"],
    })
  const successExitCodes = input.contract.successExitCodes ?? [0]
  const passedFromExit = !timedOut && successExitCodes.includes(exitCode)

  return {
    id: `validator-${randomUUID().slice(0, 8)}`,
    runID: input.runID,
    unitID: input.unit.id,
    attempt: input.attempt,
    validatorID: input.contract.id,
    validatorType: "script",
    createdAt: nowISO(),
    passed: readBooleanField(parsed, "passed", "ok", "success") ?? passedFromExit,
    blocking: readBooleanField(parsed, "blocking", "is_blocking") ?? input.contract.blocking === true,
    summary: readStringField(parsed, "summary", "message", "result_summary")
      ? (readStringField(parsed, "summary", "message", "result_summary") as string)
      : timedOut
        ? `${input.contract.title} timed out after ${timeoutMs} ms.`
        : passedFromExit
          ? `${input.contract.title} passed.`
          : `${input.contract.title} failed with exit code ${exitCode}.`,
    details:
      readDetailsField(parsed).length > 0
        ? readDetailsField(parsed)
        : [normalizedStderr.trim() || stdout.trim()].filter(Boolean),
    evidenceRefs: [payloadPath, stdoutPath, stderrPath],
    rawOutputPath: stdoutPath,
  }
}

async function runPromptValidator(input: {
  cwd: string
  config: AutoEvolveConfig
  contract: LongTaskPromptValidatorContract
  spec: LongTaskSpec
  unit: LongTaskWorkUnit
  runID: string
  attempt: number
  validatorDir: string
  bundlePath: string
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
  onPulse?: OpencodeTaskInput["onPulse"]
}): Promise<LongTaskValidatorResult> {
  await mkdir(input.validatorDir, { recursive: true })
  const promptPath = path.join(input.validatorDir, "validator_prompt.txt")
  const prompt = buildLongTaskPromptValidatorPrompt({
    spec: input.spec,
    unit: input.unit,
    validator: input.contract,
    bundlePath: input.bundlePath,
  })
  await writeTextFile(promptPath, prompt)

  const selection = resolveModelSelection(input.config, "verify", input.contract.execution ?? input.spec.validation)
  const capabilityPaths = capabilityReferencePaths(input.spec)
  const capabilityFiles = capabilityAttachedFiles(input.spec)
  const task = await runOpencodeTask({
    cwd: input.cwd,
    config: input.config,
    title: `Long Task Validator ${input.contract.id}`,
    prompt,
    referencePaths: [
      ...input.spec.materials.map((item) => item.path),
      ...(input.spec.targetPaths ?? []).map((item) => item.path),
      ...(input.spec.initialExpertContextPaths ?? []),
      ...(input.contract.referencePaths ?? []),
      ...capabilityPaths,
      input.bundlePath,
    ],
    attachedFiles: uniqueStrings([...(input.contract.attachedFiles ?? []), ...capabilityFiles]),
    permissionReadPaths: [
      ...input.spec.materials.map((item) => item.path),
      ...(input.spec.targetPaths ?? []).map((item) => item.path),
      ...(input.spec.initialExpertContextPaths ?? []),
      ...(input.contract.referencePaths ?? []),
      ...capabilityPaths,
      input.bundlePath,
    ],
    permissionEditPaths: [],
    model: selection.model,
    agent: selection.agent,
    variant: selection.variant,
    runtimeScope: input.runtimeScope,
    onSpawn: input.onActivation,
    onPulse: input.onPulse,
    live: {
      stageDir: path.join(input.validatorDir, "session"),
      phase: "long_task_validate",
      taskKind: "long_task_validate",
      methodID: input.spec.reversePropagation?.recipeID,
    },
  })

  await writeTaskArtifacts(path.join(input.validatorDir, "session"), task, {
    phase: "long_task_validate",
    taskKind: "long_task_validate",
    methodID: input.spec.reversePropagation?.recipeID,
  })

  const parsed = extractJsonObject(task.result.responseText, {
    preferredKeys: ["passed", "summary", "details", "blocking"],
  })

  return {
    id: `validator-${randomUUID().slice(0, 8)}`,
    runID: input.runID,
    unitID: input.unit.id,
    attempt: input.attempt,
    validatorID: input.contract.id,
    validatorType: "prompt_json",
    createdAt: nowISO(),
    passed: readBooleanField(parsed, "passed", "ok", "success") ?? false,
    blocking: readBooleanField(parsed, "blocking", "is_blocking") ?? input.contract.blocking === true,
    summary: readStringField(parsed, "summary", "message", "result_summary")
      ? (readStringField(parsed, "summary", "message", "result_summary") as string)
      : `${input.contract.title} did not return a valid validator summary.`,
    details:
      readDetailsField(parsed).length > 0
        ? readDetailsField(parsed)
        : [task.result.responseText.trim()].filter(Boolean),
    evidenceRefs: [path.join(input.validatorDir, "session", "response.txt"), input.bundlePath],
    rawOutputPath: path.join(input.validatorDir, "session", "response.txt"),
  }
}

export async function runLongTaskValidator(input: {
  cwd: string
  config: AutoEvolveConfig
  contract: LongTaskValidatorContract
  spec: LongTaskSpec
  unit: LongTaskWorkUnit
  runID: string
  attempt: number
  validatorDir: string
  bundlePath: string
  payload: Record<string, unknown>
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
  onPulse?: OpencodeTaskInput["onPulse"]
}) {
  if (input.contract.type === "script") {
    return runScriptValidator({
      cwd: input.cwd,
      contract: input.contract,
      spec: input.spec,
      unit: input.unit,
      runID: input.runID,
      attempt: input.attempt,
      validatorDir: input.validatorDir,
      payload: input.payload,
      runtimeScope: input.runtimeScope,
      onActivation: input.onActivation,
      onPulse: input.onPulse,
    })
  }

  return runPromptValidator({
    cwd: input.cwd,
    config: input.config,
    contract: input.contract,
    spec: input.spec,
    unit: input.unit,
    runID: input.runID,
    attempt: input.attempt,
    validatorDir: input.validatorDir,
    bundlePath: input.bundlePath,
    runtimeScope: input.runtimeScope,
    onActivation: input.onActivation,
    onPulse: input.onPulse,
  })
}
