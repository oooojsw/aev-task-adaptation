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
import { runOpencodeTask } from "../opencode"
import type { AutoEvolveConfig } from "../schema"
import { resolveModelSelection } from "../model-selection"
import { writeTaskArtifacts } from "../task-artifacts"
import { buildLongTaskPromptValidatorPrompt } from "./prompts"

function nowISO() {
  return new Date().toISOString()
}

function normalizeDetails(input: unknown) {
  if (!Array.isArray(input)) return []
  return input.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function extractJsonObject(raw: string) {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const attempts = [trimmed]
  const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)```/i)
  if (fencedMatch?.[1]) attempts.push(fencedMatch[1].trim())
  const firstObjectMatch = trimmed.match(/\{[\s\S]*\}/)
  if (firstObjectMatch?.[0]) attempts.push(firstObjectMatch[0].trim())

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as Record<string, unknown>
    } catch {
      continue
    }
  }
  return undefined
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
      return ["bun", "run", contract.path, ...(contract.inputMode === "none" ? [] : [inputPath]), ...args]
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
}): Promise<LongTaskValidatorResult> {
  await mkdir(input.validatorDir, { recursive: true })
  const payloadPath = path.join(input.validatorDir, "validator_input.json")
  const stdoutPath = path.join(input.validatorDir, "stdout.log")
  const stderrPath = path.join(input.validatorDir, "stderr.log")
  await writeJsonFile(payloadPath, input.payload)

  const command = buildScriptCommand(input.contract, payloadPath)
  const child = Bun.spawn(command, {
    cwd: input.contract.cwd ?? input.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  await writeTextFile(stdoutPath, stdout)
  await writeTextFile(stderrPath, stderr)

  const parsed = extractJsonObject(stdout)
  const successExitCodes = input.contract.successExitCodes ?? [0]
  const passedFromExit = successExitCodes.includes(exitCode)

  return {
    id: `validator-${randomUUID().slice(0, 8)}`,
    runID: input.runID,
    unitID: input.unit.id,
    attempt: input.attempt,
    validatorID: input.contract.id,
    validatorType: "script",
    createdAt: nowISO(),
    passed:
      typeof parsed?.passed === "boolean"
        ? parsed.passed
        : passedFromExit,
    blocking: typeof parsed?.blocking === "boolean" ? parsed.blocking : input.contract.blocking === true,
    summary:
      typeof parsed?.summary === "string" && parsed.summary.trim()
        ? parsed.summary
        : passedFromExit
          ? `${input.contract.title} passed.`
          : `${input.contract.title} failed with exit code ${exitCode}.`,
    details:
      normalizeDetails(parsed?.details).length > 0
        ? normalizeDetails(parsed?.details)
        : [stderr.trim() || stdout.trim()].filter(Boolean),
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
      input.bundlePath,
    ],
    attachedFiles: input.contract.attachedFiles ?? [],
    permissionReadPaths: [
      ...input.spec.materials.map((item) => item.path),
      ...(input.spec.targetPaths ?? []).map((item) => item.path),
      ...(input.spec.initialExpertContextPaths ?? []),
      ...(input.contract.referencePaths ?? []),
      input.bundlePath,
    ],
    permissionEditPaths: [],
    model: selection.model,
    agent: selection.agent,
    variant: selection.variant,
  })

  await writeTaskArtifacts(path.join(input.validatorDir, "session"), task, {
    phase: "long_task_validate",
    taskKind: "long_task_validate",
    methodID: input.spec.reversePropagation?.recipeID,
  })

  const parsed = extractJsonObject(task.result.responseText)

  return {
    id: `validator-${randomUUID().slice(0, 8)}`,
    runID: input.runID,
    unitID: input.unit.id,
    attempt: input.attempt,
    validatorID: input.contract.id,
    validatorType: "prompt_json",
    createdAt: nowISO(),
    passed: typeof parsed?.passed === "boolean" ? parsed.passed : false,
    blocking: typeof parsed?.blocking === "boolean" ? parsed.blocking : input.contract.blocking === true,
    summary:
      typeof parsed?.summary === "string" && parsed.summary.trim()
        ? parsed.summary
        : `${input.contract.title} did not return a valid validator summary.`,
    details:
      normalizeDetails(parsed?.details).length > 0
        ? normalizeDetails(parsed?.details)
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
  })
}

