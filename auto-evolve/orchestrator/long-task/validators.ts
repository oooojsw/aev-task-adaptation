import path from "node:path"
import process from "node:process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import type {
  LongTaskPromptValidatorContract,
  LongTaskScriptValidatorContract,
  LongTaskSpec,
  LongTaskValidatorContract,
  LongTaskValidatorResult,
  LongTaskWorkUnit,
} from "./contract"
import { pathExists, writeJsonFile, writeTextFile } from "../fs"
import { runOpencodeTask, type OpencodeTaskInput } from "../opencode"
import type { AutoEvolveConfig } from "../schema"
import { resolveModelSelection } from "../model-selection"
import { writeTaskArtifacts } from "../task-artifacts"
import { runManagedProcess } from "../managed-process"
import { buildLongTaskPromptValidatorPrompt } from "./prompts"
import { extractJsonObject } from "./json-extract"
import { runLongTaskValidatorViaValidationEngine } from "../validation-engine/long-task-adapter"

const GLOBAL_SCRIPT_VALIDATOR_TIMEOUT_MS = (() => {
  const value = Number.parseInt(process.env.AUTO_EVOLVE_SCRIPT_VALIDATOR_TIMEOUT_MS ?? "", 10)
  if (Number.isFinite(value) && value > 0) return value
  return 10 * 60 * 1000
})()

const FAILURE_CLASSES = new Set([
  "missing_candidate",
  "issue_mismatch",
  "evidence_missing",
  "not_actionable",
  "infra_error",
  "schema_invalid",
  "candidate_missing",
  "candidate_format_invalid",
  "score_below_threshold",
])

function resolveScriptValidatorTimeoutMs(timeoutMs: number | undefined) {
  if (typeof timeoutMs === "number" && timeoutMs > 0) {
    return timeoutMs
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

function collectJsonStrings(value: unknown, out: string[]) {
  if (typeof value === "string") {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonStrings(item, out))
    return
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectJsonStrings(item, out))
  }
}

async function resolveAttachedPath(input: { expected: string; bundle: unknown }) {
  if (await pathExists(input.expected)) return input.expected
  const base = path.basename(input.expected).toLowerCase()
  const pool: string[] = []
  collectJsonStrings(input.bundle, pool)
  const sorted = uniqueStrings(pool)
    .filter((item) => item.toLowerCase().endsWith(base))
    .sort((a, b) => b.length - a.length)
  for (const item of sorted) {
    if (await pathExists(item)) return item
    const norm = item.replace(/\//g, path.sep)
    if (await pathExists(norm)) return norm
  }
  return undefined
}

const ANSWER_FILE_NAMES = new Set(["answer.md", "answer.json", "answer.txt"])

function isAnswerFileName(filePath: string) {
  return ANSWER_FILE_NAMES.has(path.basename(filePath).toLowerCase())
}

function normalizedPathForRole(filePath: string | undefined) {
  return (filePath ?? "").replace(/\\/g, "/").toLowerCase()
}

function isPrivateAnswerPath(filePath: string | undefined) {
  const normalized = normalizedPathForRole(filePath)
  return normalized.includes("/private-answers/") || normalized.includes("/answer/")
}

function isHumanOrContextPath(filePath: string | undefined) {
  const normalized = normalizedPathForRole(filePath)
  const base = path.basename(filePath ?? "").toLowerCase()
  return (
    base.includes("human-guidance") ||
    base.includes("guidance") ||
    base.includes("context") ||
    normalized.includes("/human-guidance") ||
    normalized.includes("/context")
  )
}

function candidatePriority(filePath: string) {
  const base = path.basename(filePath).toLowerCase()
  if (base === "answer.txt") return 0
  if (base === "answer.json") return 1
  if (base === "plan.json") return 2
  if (base.startsWith("answer.")) return 3
  if (base.includes("candidate")) return 4
  if (base.includes("output")) return 5
  return 100
}

async function inferPrivateAnswer(input: { spec: LongTaskSpec; contract: LongTaskPromptValidatorContract }) {
  const human = input.contract.inputFiles?.humanGuidancePath
  if (!human) return undefined
  const id = input.spec.id ?? input.spec.title
  const dir = path.dirname(human)
  const parent = path.dirname(dir)
  if (path.basename(parent) !== "test-shadow") return undefined
  const answerRoot = path.join(path.dirname(parent), "private-answers", id)
  for (const name of ANSWER_FILE_NAMES) {
    const answer = path.join(answerRoot, name)
    if (await pathExists(answer)) return answer
  }
  return undefined
}

async function buildPromptValidatorInput(input: {
  spec: LongTaskSpec
  unit: LongTaskWorkUnit
  contract: LongTaskPromptValidatorContract
  bundlePath: string
  resultPath: string
  validatorDir: string
}) {
  const raw = await readFile(input.bundlePath, "utf8").catch(() => "{}")
  const bundle = extractJsonObject(raw) ?? {}
  const attached = await Promise.all(
    (input.contract.attachedFiles ?? []).map(async (item) => {
      const resolved = await resolveAttachedPath({ expected: item, bundle })
      return { expected: item, resolved }
    }),
  )
  const explicit = input.contract.inputFiles
  const attachedAnswer = attached.find((item) => {
    if (!item.resolved) return false
    return (isAnswerFileName(item.expected) || isAnswerFileName(item.resolved)) && isPrivateAnswerPath(item.resolved)
  })?.resolved
  const candidateLike = attached
    .filter((item): item is { expected: string; resolved: string } => typeof item.resolved === "string")
    .filter((item) => item.resolved !== attachedAnswer)
    .filter((item) => !isPrivateAnswerPath(item.resolved))
    .filter((item) => !isHumanOrContextPath(item.expected) && !isHumanOrContextPath(item.resolved))
    .sort((a, b) => candidatePriority(a.resolved) - candidatePriority(b.resolved))
  const answer =
    explicit?.answerPath && (await pathExists(explicit.answerPath))
      ? explicit.answerPath
      : attachedAnswer ?? (await inferPrivateAnswer({ spec: input.spec, contract: input.contract }))
  const candidate =
    explicit?.candidatePath && (await pathExists(explicit.candidatePath))
      ? explicit.candidatePath
      : candidateLike[0]?.resolved
  const human =
    explicit?.humanGuidancePath && (await pathExists(explicit.humanGuidancePath))
      ? explicit.humanGuidancePath
      : answer && (await pathExists(path.join(path.dirname(path.dirname(answer)), "human-guidance.md")))
        ? path.join(path.dirname(path.dirname(answer)), "human-guidance.md")
        : undefined
  const context = await Promise.all(
    (explicit?.contextPaths ?? []).map(async (item) => ({
      expected: item,
      resolved: (await pathExists(item)) ? item : undefined,
    })),
  )
  const missing = attached.filter((item) => !item.resolved).map((item) => item.expected)
  if (explicit?.answerPath && !answer) missing.push(explicit.answerPath)
  if (explicit?.candidatePath && !candidate) missing.push(explicit.candidatePath)
  if (explicit?.humanGuidancePath && !human) missing.push(explicit.humanGuidancePath)
  for (const item of context) {
    if (!item.resolved) missing.push(item.expected)
  }
  const payload = {
    schema: "soft-validator/v2",
    validator_id: input.contract.id,
    result_path: input.resultPath,
    task: {
      id: input.spec.id ?? input.spec.title,
      unit: input.unit.id,
      goal: input.unit.goal,
    },
    files: {
      bundle_path: input.bundlePath,
      answer_path: answer,
      candidate_path: candidate,
      human_guidance_path: human,
      context_paths: context.map((item) => item.resolved).filter((item): item is string => typeof item === "string"),
    },
    constraints: {
      human_guidance_role: "background_constraints_not_primary_task",
      missing_required_files: missing,
    },
    rubric: {
      contract_prompt: input.contract.prompt,
      criteria: input.contract.rubric ?? {},
      required_keys: ["passed", "blocking"],
      recommended_keys: ["failure_class", "summary", "details"],
    },
  }
  const inputPath = path.join(input.validatorDir, "validator_input.json")
  await writeJsonFile(inputPath, payload)
  return { inputPath, payload }
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

function fallbackPromptSummary(parsed: Record<string, unknown> | undefined, title: string) {
  const passed = readBooleanField(parsed, "passed", "ok", "success")
  if (passed === true) return `${title} passed.`
  if (passed === false) return `${title} failed.`
  return `${title} did not return a valid validator summary.`
}

function fallbackPromptDetails(parsed: Record<string, unknown> | undefined, raw: string) {
  const details = readDetailsField(parsed)
  if (details.length > 0) return details
  if (parsed && typeof parsed === "object") return [JSON.stringify(parsed)]
  return [raw.trim()].filter(Boolean)
}

function normalizeFailureClass(parsed: Record<string, unknown> | undefined) {
  const value = readStringField(parsed, "failure_class", "failureClass", "error_class", "errorClass")
  if (!value) return undefined
  if (FAILURE_CLASSES.has(value)) return value
  return "schema_invalid"
}

function validatePromptResultShape(input: {
  parsed: Record<string, unknown> | undefined
  fallbackSummary: string
  fallbackDetails: string[]
}) {
  const passed = readBooleanField(input.parsed, "passed", "ok", "success")
  const blocking = readBooleanField(input.parsed, "blocking", "is_blocking")
  const summary = readStringField(input.parsed, "summary", "message", "result_summary")
  const details = readDetailsField(input.parsed)
  if (typeof passed !== "boolean" || typeof blocking !== "boolean") {
    return {
      passed: false,
      blocking: false,
      failureClass: "schema_invalid",
      summary: "Soft validator returned invalid schema: missing boolean passed/blocking.",
      details: input.fallbackDetails.length ? input.fallbackDetails : [input.fallbackSummary],
      valid: false,
    }
  }
  return {
    passed,
    blocking,
    failureClass: normalizeFailureClass(input.parsed),
    summary: summary ?? input.fallbackSummary,
    details: details.length ? details : input.fallbackDetails,
    valid: true,
  }
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
  const infraOK = !timedOut && successExitCodes.includes(exitCode)
  const reportedPassed = readBooleanField(parsed, "passed", "ok", "success")
  const passed = infraOK && (reportedPassed ?? true)
  const reportedFailureKind = readStringField(parsed, "failureKind", "failure_kind")
  const parsedSummary = readStringField(parsed, "summary", "message", "result_summary")
  const summary = parsedSummary
    ? parsedSummary
    : timedOut
      ? `${input.contract.title} timed out after ${timeoutMs} ms.`
      : infraOK
        ? reportedPassed === false
          ? `${input.contract.title} reported product failure.`
          : `${input.contract.title} passed.`
        : `${input.contract.title} failed with exit code ${exitCode}.`
  const failureText = [summary, normalizedStderr, stdout].join("\n").toLowerCase()
  const failureKind = passed
    ? undefined
    : reportedFailureKind === "dataset_failure"
      ? ("dataset_failure" as const)
      : !infraOK ||
        timedOut ||
        failureText.includes("validator crashed") ||
        failureText.includes("validator runtime bootstrap failed") ||
        failureText.includes("usage:") ||
        failureText.includes("unrecognized arguments") ||
        failureText.includes("expected one argument")
      ? ("validator_infrastructure" as const)
      : ("product_failure" as const)

  return {
    id: `validator-${randomUUID().slice(0, 8)}`,
    runID: input.runID,
    unitID: input.unit.id,
    attempt: input.attempt,
    validatorID: input.contract.id,
    validatorType: "script",
    createdAt: nowISO(),
    passed,
    blocking: readBooleanField(parsed, "blocking", "is_blocking") ?? input.contract.blocking === true,
    failureKind,
    summary,
    details: [
      `exitCode=${exitCode}`,
      `timedOut=${timedOut}`,
      `successExitCodes=${successExitCodes.join(",")}`,
      ...(reportedPassed !== undefined ? [`reportedPassed=${reportedPassed}`] : []),
      ...(readDetailsField(parsed).length > 0
        ? readDetailsField(parsed)
        : [normalizedStderr.trim() || stdout.trim()].filter(Boolean)),
    ],
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
  const resultPath = path.join(input.validatorDir, "result.json")
  const built = await buildPromptValidatorInput({
    spec: input.spec,
    unit: input.unit,
    contract: input.contract,
    bundlePath: input.bundlePath,
    resultPath,
    validatorDir: input.validatorDir,
  })
  const validatorInputPath = built.inputPath
  const answerPath = typeof built.payload.files.answer_path === "string" ? built.payload.files.answer_path : undefined
  const candidatePath =
    typeof built.payload.files.candidate_path === "string" ? built.payload.files.candidate_path : undefined
  const humanPath =
    typeof built.payload.files.human_guidance_path === "string"
      ? built.payload.files.human_guidance_path
      : undefined
  const promptPath = path.join(input.validatorDir, "validator_prompt.txt")
  const prompt = buildLongTaskPromptValidatorPrompt({
    validator: input.contract,
    validatorInputPath,
    resultPath,
  })
  await writeTextFile(promptPath, prompt)

  const selection = resolveModelSelection(input.config, "verify", input.contract.execution ?? input.spec.validation)
  const readPaths = uniqueStrings(
    [
      validatorInputPath,
      input.bundlePath,
      answerPath,
      candidatePath,
      humanPath,
      ...(Array.isArray(built.payload.files.context_paths) ? built.payload.files.context_paths : []),
      ...(input.contract.referencePaths ?? []),
    ].filter((item): item is string => typeof item === "string" && item.length > 0),
  )
  const task = await runOpencodeTask({
    cwd: input.cwd,
    config: input.config,
    title: `Long Task Validator ${input.contract.id}`,
    prompt,
    concurrencyScope: `long-task:${input.spec.id ?? input.spec.taskFamily ?? input.spec.title}`,
    referencePaths: readPaths,
    attachedFiles: [],
    permissionReadPaths: readPaths,
    permissionEditPaths: [input.validatorDir],
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

  const parsedFromFile = await readFile(resultPath, "utf8")
    .then((raw) =>
      extractJsonObject(raw, {
        preferredKeys: ["passed", "summary", "details", "blocking"],
      }),
    )
    .catch(() => undefined)
  const parsed =
    parsedFromFile ??
    extractJsonObject(task.result.responseText, {
      preferredKeys: ["passed", "summary", "details", "blocking"],
    })
  const fallbackSummary = fallbackPromptSummary(parsed, input.contract.title)
  const fallbackDetails = fallbackPromptDetails(parsed, task.result.responseText)
  const shape = validatePromptResultShape({
    parsed,
    fallbackSummary,
    fallbackDetails,
  })
  const details = shape.failureClass
    ? uniqueStrings([
        ...shape.details,
        shape.valid
          ? `failure_class=${shape.failureClass}`
          : "failure_class=schema_invalid (auto-assigned by orchestrator)",
      ])
    : shape.details

  return {
    id: `validator-${randomUUID().slice(0, 8)}`,
    runID: input.runID,
    unitID: input.unit.id,
    attempt: input.attempt,
    validatorID: input.contract.id,
    validatorType: "prompt_json",
    createdAt: nowISO(),
    passed: shape.passed,
    blocking: shape.blocking,
    summary: shape.summary,
    details,
    evidenceRefs: [resultPath, path.join(input.validatorDir, "session", "response.txt"), input.bundlePath],
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
  const engineResult = await runLongTaskValidatorViaValidationEngine(input)
  const viewPaths = engineResult.viewPaths ?? {}
  // Merge oracle view paths (private + training) into evidenceRefs so that
  // downstream expert-oracle collectors (collectExpertOracleReadPaths) can
  // discover result.private.json / result.training.json paths. Without this,
  // the oracle channel stays empty and non-Blank workers never see the
  // open-book evidence they're entitled to.
  const oracleViewRefs = [viewPaths.private, viewPaths.training].filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  )
  return {
    ...engineResult.result,
    evidenceRefs: [...(engineResult.result.evidenceRefs ?? []), ...oracleViewRefs],
  }
}
