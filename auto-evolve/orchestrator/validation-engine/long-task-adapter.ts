import path from "node:path"
import process from "node:process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import type {
  LongTaskBlankEvalPlanValidatorContract,
  LongTaskPromptValidatorContract,
  LongTaskScriptValidatorContract,
  LongTaskSpec,
  LongTaskValidatorContract,
  LongTaskWorkUnit,
} from "../long-task/contract"
import type { AutoEvolveConfig } from "../schema"
import type { OpencodeTaskInput } from "../opencode"
import { pathExists, writeJsonFile, writeTextFile } from "../fs"
import { extractJsonObject } from "../long-task/json-extract"
import { buildLongTaskPromptValidatorPrompt } from "../long-task/prompts"
import { resolveModelSelection } from "../model-selection"
import { runManagedProcess } from "../managed-process"
import { runOpencodeTask } from "../opencode"
import { writeTaskArtifacts } from "../task-artifacts"
import { runBlankEvalPlan } from "../blank-eval/plan-runner"
import type { BlankEvalPlanCase, BlankEvalPlanMode, BlankEvalPlanSuccessCriterion } from "../blank-eval/contract"
import { buildValidationResultViews, writeValidationResultViews } from "./result-views"
import { assertNoBlankAgentAudience } from "./registry"
import type {
  ValidationEngineResult,
  ValidationMechanism,
  ValidationModuleDescriptor,
  ValidationStage,
  ValidationTargetKind,
} from "./contract"

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

const AUTO_EVOLVE_ROOT = path.resolve(import.meta.dir, "..", "..")

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
  if (input.spec.taskFamily === "paper-review-learnbench") {
    const id = input.spec.id ?? input.spec.title
    const answerRoot = path.resolve(
      AUTO_EVOLVE_ROOT,
      "task-packs",
      "real-long-tasks",
      "paper-review-learnbench",
      "private-answers",
      id,
    )
    for (const name of ["gold-review.txt", "gold-review.md", "gold-review.docx"]) {
      const answer = path.join(answerRoot, name)
      if (await pathExists(answer)) return answer
    }
  }
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

async function inferCandidateFromBundle(input: { bundle: unknown }) {
  const pool: string[] = []
  const collectPaths = (value: unknown) => {
    if (typeof value === "string") {
      pool.push(value)
      return
    }
    if (Array.isArray(value)) {
      value.forEach(collectPaths)
      return
    }
    if (value && typeof value === "object") {
      const maybe = value as Record<string, unknown>
      if (typeof maybe.path === "string") pool.push(maybe.path)
      Object.values(maybe).forEach(collectPaths)
    }
  }
  if (input.bundle && typeof input.bundle === "object") {
    const bundle = input.bundle as Record<string, unknown>
    collectPaths(bundle.expectedArtifacts)
    collectPaths(bundle.targetPaths)
  }
  const sorted = uniqueStrings(pool)
    .filter((item) => !isPrivateAnswerPath(item))
    .filter((item) => {
      const base = path.basename(item).toLowerCase()
      return (
        base === "review.md" ||
        base === "review.txt" ||
        base === "review.docx" ||
        base === "answer.txt" ||
        base === "answer.json" ||
        base.includes("candidate") ||
        base.includes("output")
      )
    })
    .sort((a, b) => candidatePriority(a) - candidatePriority(b))
  for (const item of sorted) {
    if (await pathExists(item)) return item
  }
  return undefined
}

export async function buildPromptValidatorInput(input: {
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
      : candidateLike[0]?.resolved ?? (await inferCandidateFromBundle({ bundle }))
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

function resolveScriptValidatorTimeoutMs(timeoutMs: number | undefined) {
  if (typeof timeoutMs === "number" && timeoutMs > 0) return timeoutMs
  return GLOBAL_SCRIPT_VALIDATOR_TIMEOUT_MS
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

function inferTargetKind(contract: LongTaskValidatorContract): ValidationTargetKind {
  const descriptor = [
    contract.id,
    contract.title,
    contract.type === "script"
      ? contract.path
      : contract.type === "prompt_json"
        ? contract.prompt
        : `${contract.planPath} ${contract.skillRootPath}`,
  ]
    .join(" ")
    .toLowerCase()
  if (descriptor.includes("layout")) return "layout"
  if (descriptor.includes("surface") || descriptor.includes("generalization") || descriptor.includes("leak")) {
    return "surface"
  }
  if (descriptor.includes("regression")) return "regression"
  return "product"
}

function inferStage(contract: LongTaskValidatorContract): ValidationStage {
  if (contract.placement === "completion_only") return "post_blank"
  return "local_training"
}

function descriptorForLongTask(contract: LongTaskValidatorContract): ValidationModuleDescriptor {
  const mechanism: ValidationMechanism =
    contract.type === "script" ? "hard_script" : contract.type === "prompt_json" ? "soft_llm" : "engine"
  const target = contract.validation?.target ?? inferTargetKind(contract)
  const descriptor = {
    id: contract.id,
    title: contract.title,
    target,
    mechanism,
    stage: contract.validation?.stage ?? inferStage(contract),
    blocking: contract.blocking === true,
    answerAccess: contract.validation?.answerAccess ?? (target === "product" ? "private_oracle" : "full_training"),
    allowedAudiences: contract.validation?.allowedAudiences ?? [
      "executor",
      "worker",
      "lead",
      "reviewer",
      "dashboard",
      "memory",
      "audit",
    ],
  }
  assertNoBlankAgentAudience(contract, descriptor.allowedAudiences)
  return descriptor
}

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function normalizeBlankEvalPlanMode(value: unknown): BlankEvalPlanMode {
  return value === "single" || value === "sequence" || value === "parallel" ? value : "parallel"
}

function normalizeBlankEvalPlanCriterion(value: unknown): BlankEvalPlanSuccessCriterion {
  return value === "all_pass" || value === "allow_partial" || value === "min_pass_rate" ? value : "all_pass"
}

function normalizeBlankEvalPlanConcurrency(value: unknown) {
  if (typeof value !== "number") return 1
  const normalized = Math.floor(value)
  if (!Number.isFinite(normalized) || normalized < 1) return 1
  return normalized
}

function normalizeBlankEvalPlanMinPassRate(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(1, value))
}

function normalizeBlankEvalPlanCases(raw: unknown, planPath: string): BlankEvalPlanCase[] {
  const rows = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.cases) ? raw.cases : []
  const baseDir = path.dirname(planPath)
  return rows
    .filter(isObject)
    .filter((row) => {
      const rawSpecPath = typeof row.specPath === "string" ? row.specPath : typeof row.spec === "string" ? row.spec : ""
      return rawSpecPath.trim().length > 0
    })
    .map((row, index) => {
      const rawSpecPath = (typeof row.specPath === "string" ? row.specPath : typeof row.spec === "string" ? row.spec : "").trim()
      const id =
        typeof row.id === "string" && row.id.trim()
          ? row.id.trim()
          : rawSpecPath
            ? path.basename(path.dirname(rawSpecPath)) || `case-${index + 1}`
            : `case-${index + 1}`
      return {
        id,
        specPath: path.isAbsolute(rawSpecPath) ? path.resolve(rawSpecPath) : path.resolve(baseDir, rawSpecPath),
        title: typeof row.title === "string" && row.title.trim() ? row.title.trim() : undefined,
        sourceID: typeof row.sourceID === "string" && row.sourceID.trim() ? row.sourceID.trim() : id,
        mode:
          row.mode === "train-backtest" || row.mode === "test" || row.mode === "deployment" || row.mode === "smoke"
            ? row.mode
            : undefined,
        promptInlinePaths: Array.isArray(row.promptInlinePaths)
          ? row.promptInlinePaths
              .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
              .map((item) => item.trim())
              .map((item) => path.isAbsolute(item) ? path.resolve(item) : path.resolve(baseDir, item))
          : undefined,
      }
    })
    .filter((item) => item.specPath.trim().length > 0)
}

function blankEvalPlanInfrastructureFailure(input: {
  contract: LongTaskBlankEvalPlanValidatorContract
  runID: string
  unitID: string
  attempt: number
  summary: string
  details: string[]
  evidenceRefs: string[]
  raw?: Record<string, unknown>
}) {
  return {
    result: {
      id: `validator-${randomUUID().slice(0, 8)}`,
      runID: input.runID,
      unitID: input.unitID,
      attempt: input.attempt,
      validatorID: input.contract.id,
      validatorType: "engine" as const,
      createdAt: nowISO(),
      passed: false,
      blocking: input.contract.blocking === true,
      failureKind: "validator_infrastructure" as const,
      summary: input.summary,
      details: input.details,
      evidenceRefs: input.evidenceRefs,
    },
    raw: input.raw ?? {},
  }
}

async function runBlankEvalPlanLongTaskValidation(input: {
  cwd: string
  contract: LongTaskBlankEvalPlanValidatorContract
  spec: LongTaskSpec
  unit: LongTaskWorkUnit
  runID: string
  attempt: number
  validatorDir: string
  runtimeScope?: string
}) {
  await mkdir(input.validatorDir, { recursive: true })
  const planRaw = await readFile(input.contract.planPath, "utf8")
  let parsedPlan: unknown
  try {
    parsedPlan = extractJsonObject(planRaw) ?? JSON.parse(planRaw)
  } catch (error) {
    return blankEvalPlanInfrastructureFailure({
      contract: input.contract,
      runID: input.runID,
      unitID: input.unit.id,
      attempt: input.attempt,
      summary: `${input.contract.title} could not parse blank eval plan JSON.`,
      details: [`planPath=${input.contract.planPath}`, error instanceof Error ? error.message : String(error)],
      evidenceRefs: [input.contract.planPath],
      raw: { planPath: input.contract.planPath, parseError: error instanceof Error ? error.message : String(error) },
    })
  }
  const cases = normalizeBlankEvalPlanCases(parsedPlan, input.contract.planPath)
  const mode = input.contract.mode ?? (isObject(parsedPlan) ? normalizeBlankEvalPlanMode(parsedPlan.mode) : "parallel")
  const successCriterion =
    input.contract.successCriterion ??
    (isObject(parsedPlan) ? normalizeBlankEvalPlanCriterion(parsedPlan.successCriterion) : "all_pass")
  const concurrency =
    input.contract.concurrency ?? (isObject(parsedPlan) ? normalizeBlankEvalPlanConcurrency(parsedPlan.concurrency) : 1)
  const minPassRate =
    input.contract.minPassRate ?? (isObject(parsedPlan) ? normalizeBlankEvalPlanMinPassRate(parsedPlan.minPassRate) : undefined)
  const stopOnFirstFailure =
    input.contract.stopOnFirstFailure ??
    (isObject(parsedPlan) && typeof parsedPlan.stopOnFirstFailure === "boolean" ? parsedPlan.stopOnFirstFailure : undefined)

  const inputPath = path.join(input.validatorDir, "blank-eval-plan-input.json")
  await writeJsonFile(inputPath, {
    schema: "blank-eval-plan-validator-input/v1",
    validatorID: input.contract.id,
    planPath: input.contract.planPath,
    skillRootPath: input.contract.skillRootPath,
    mode,
    concurrency,
    successCriterion,
    minPassRate,
    stopOnFirstFailure,
    caseCount: cases.length,
    cases: cases.map((item) => ({ id: item.id, specPath: item.specPath })),
  })

  if (!cases.length) {
    return blankEvalPlanInfrastructureFailure({
      contract: input.contract,
      runID: input.runID,
      unitID: input.unit.id,
      attempt: input.attempt,
      summary: `${input.contract.title} has no replay cases.`,
      details: [`planPath=${input.contract.planPath}`],
      evidenceRefs: [inputPath, input.contract.planPath],
      raw: { inputPath, planPath: input.contract.planPath },
    })
  }

  const missingSpecPaths: string[] = []
  for (const item of cases) {
    if (!(await pathExists(item.specPath))) missingSpecPaths.push(`${item.id}: ${item.specPath}`)
  }
  if (missingSpecPaths.length > 0) {
    return blankEvalPlanInfrastructureFailure({
      contract: input.contract,
      runID: input.runID,
      unitID: input.unit.id,
      attempt: input.attempt,
      summary: `${input.contract.title} references missing replay case spec(s).`,
      details: missingSpecPaths,
      evidenceRefs: [inputPath, input.contract.planPath],
      raw: { inputPath, planPath: input.contract.planPath, missingSpecPaths },
    })
  }

  if (!(await pathExists(input.contract.skillRootPath))) {
    return {
      result: {
        id: `validator-${randomUUID().slice(0, 8)}`,
        runID: input.runID,
        unitID: input.unit.id,
        attempt: input.attempt,
        validatorID: input.contract.id,
        validatorType: "engine" as const,
        createdAt: nowISO(),
        passed: false,
        blocking: input.contract.blocking === true,
        failureKind: "product_failure" as const,
        summary: `${input.contract.title} could not find candidate skill root.`,
        details: [`skillRootPath=${input.contract.skillRootPath}`],
        evidenceRefs: [inputPath, input.contract.planPath],
      },
      raw: { inputPath, planPath: input.contract.planPath, missingSkillRoot: input.contract.skillRootPath },
    }
  }

  const planResult = await runBlankEvalPlan({
    cwd: input.cwd,
    mode,
    skillRoots: [input.contract.skillRootPath],
    cases,
    runRoot: path.join(input.validatorDir, "blank-eval-plan"),
    title: input.contract.title,
    concurrency,
    stopOnFirstFailure,
    successCriterion,
    minPassRate,
    runtimeScope: input.runtimeScope ? `${input.runtimeScope}:${input.contract.id}` : `blank-eval-plan:${input.runID}:${input.contract.id}`,
    concurrencyScope: `blank-eval-plan:${input.spec.id ?? input.spec.taskFamily ?? input.spec.title}`,
  })

  return {
    result: {
      id: `validator-${randomUUID().slice(0, 8)}`,
      runID: input.runID,
      unitID: input.unit.id,
      attempt: input.attempt,
      validatorID: input.contract.id,
      validatorType: "engine" as const,
      createdAt: nowISO(),
      passed: planResult.passed,
      blocking: input.contract.blocking === true,
      failureKind: planResult.passed ? undefined : ("product_failure" as const),
      summary: planResult.summary,
      details: [
        `mode=${planResult.mode}`,
        `score=${planResult.passedCount}/${planResult.total}`,
        `successCriterion=${planResult.successCriterion}`,
        ...(planResult.failedCases.length ? [`failedCases=${planResult.failedCases.join(",")}`] : []),
      ],
      evidenceRefs: [
        inputPath,
        input.contract.planPath,
        planResult.resultPath,
        planResult.evidenceBundlePath,
        planResult.summaryPath,
      ],
      rawOutputPath: planResult.resultPath,
    },
    raw: {
      inputPath,
      planPath: input.contract.planPath,
      skillRootPath: input.contract.skillRootPath,
      planResultPath: planResult.resultPath,
      evidenceBundlePath: planResult.evidenceBundlePath,
      summaryPath: planResult.summaryPath,
      caseResults: planResult.caseResults,
    },
  }
}

async function runScriptLongTaskValidation(input: {
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
}) {
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
  const hasStructuredFailure = parsed !== undefined && reportedPassed === false
  const explicitProductFailure =
    reportedPassed === false &&
    (reportedFailureKind === "product_failure" ||
      reportedFailureKind === "answer_mismatch" ||
      reportedFailureKind === "quality_mismatch")
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
      : explicitProductFailure || hasStructuredFailure
        ? ("product_failure" as const)
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
    result: {
      id: `validator-${randomUUID().slice(0, 8)}`,
      runID: input.runID,
      unitID: input.unit.id,
      attempt: input.attempt,
      validatorID: input.contract.id,
      validatorType: "script" as const,
      createdAt: nowISO(),
      passed,
      blocking: input.contract.blocking === true || (readBooleanField(parsed, "blocking", "is_blocking") ?? false),
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
    },
    raw: {
      parsed,
      command,
      payload: input.payload,
      exitCode,
      timedOut,
      stdoutPath,
      stderrPath,
      payloadPath,
    },
  }
}

async function runPromptLongTaskValidation(input: {
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
}) {
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
    result: {
      id: `validator-${randomUUID().slice(0, 8)}`,
      runID: input.runID,
      unitID: input.unit.id,
      attempt: input.attempt,
      validatorID: input.contract.id,
      validatorType: "prompt_json" as const,
      createdAt: nowISO(),
      passed: shape.passed,
      blocking: shape.blocking,
      summary: shape.summary,
      details,
      evidenceRefs: [resultPath, path.join(input.validatorDir, "session", "response.txt"), input.bundlePath],
      rawOutputPath: path.join(input.validatorDir, "session", "response.txt"),
    },
    raw: {
      parsed,
      resultPath,
      validatorInputPath,
      promptPath,
      responsePath: path.join(input.validatorDir, "session", "response.txt"),
    },
  }
}

export async function runLongTaskValidatorViaValidationEngine(input: {
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
}): Promise<ValidationEngineResult> {
  const descriptor = descriptorForLongTask(input.contract)
  const executed =
    input.contract.type === "script"
      ? await runScriptLongTaskValidation({
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
      : input.contract.type === "blank_eval_plan"
        ? await runBlankEvalPlanLongTaskValidation({
            cwd: input.cwd,
            contract: input.contract,
            spec: input.spec,
            unit: input.unit,
            runID: input.runID,
            attempt: input.attempt,
            validatorDir: input.validatorDir,
            runtimeScope: input.runtimeScope,
          })
        : await runPromptLongTaskValidation({
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
  const views = buildValidationResultViews({
    descriptor,
    result: executed.result,
    raw: executed.raw,
  })
  const viewPaths =
    input.contract.validation?.writeViews === false
      ? undefined
      : await writeValidationResultViews({ dir: input.validatorDir, views })
  return {
    descriptor,
    result: executed.result,
    views,
    viewPaths,
  }
}
