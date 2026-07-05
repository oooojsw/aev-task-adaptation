import path from "node:path"
import { randomUUID } from "node:crypto"
import { ensureDirectory, writeJsonFile, writeTextFile } from "../fs"
import { runBlankEval } from "./runner"
import type {
  BlankEvalPlanCase,
  BlankEvalPlanCaseResult,
  BlankEvalPlanInput,
  BlankEvalPlanResult,
  BlankEvalPlanSuccessCriterion,
} from "./contract"

export type BlankEvalCaseRunner = (input: {
  plan: BlankEvalPlanInput
  caseItem: BlankEvalPlanCase
  runRoot: string
  runtimeScope: string
  concurrencyScope?: string
}) => Promise<BlankEvalPlanCaseResult>

function nowISO() {
  return new Date().toISOString()
}

function compactStamp() {
  const now = new Date()
  const p = (value: number, width = 2) => String(value).padStart(width, "0")
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${randomUUID().slice(0, 8)}`
}

function safeName(input: string, fallback: string) {
  const cleaned = input
      .replace(/[\u0000-\u001F\u007F]+/g, "-")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/[. ]+$/g, "")
      .slice(0, 80)
  const candidate = cleaned || fallback
  const upper = candidate.toUpperCase()
  if (
    upper === "CON" ||
    upper === "PRN" ||
    upper === "AUX" ||
    upper === "NUL" ||
    /^COM[1-9]$/.test(upper) ||
    /^LPT[1-9]$/.test(upper)
  ) {
    return `${fallback}-${candidate}`
  }
  return candidate
}

function oneLine(input: string) {
  return input.replace(/[\r\n\t]+/g, " ").slice(0, 300)
}

function isPathInside(parent: string, child: string) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function caseRootFor(runDir: string, caseItem: BlankEvalPlanCase, index: number) {
  const root = path.join(runDir, "cases", `${String(index + 1).padStart(3, "0")}-${safeName(caseItem.id, "case")}`)
  if (!isPathInside(path.join(runDir, "cases"), root)) {
    throw new Error(`Unsafe blank eval case root computed for case id: ${caseItem.id}`)
  }
  return root
}

function scopeSegment(input: string) {
  return safeName(input, "case")
}

function invalidPlanCaseResults(input: { cases: BlankEvalPlanCase[]; message: string }): BlankEvalPlanCaseResult[] {
  return input.cases.map((caseItem, index) => ({
    id: caseItem.id || `case-${index + 1}`,
    specPath: caseItem.specPath || "",
    title: caseItem.title,
    passed: false,
    failureKind: "validator_infrastructure",
    summary: input.message,
  }))
}

function validatePlanInput(input: BlankEvalPlanInput): string | undefined {
  if (!input.cases.length) return "Invalid blank eval plan: at least one case is required."
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const [index, caseItem] of input.cases.entries()) {
    if (!caseItem.id || !caseItem.id.trim()) return `Invalid blank eval plan: case ${index + 1} is missing id.`
    if (!caseItem.specPath || !caseItem.specPath.trim()) return `Invalid blank eval plan: case ${caseItem.id} is missing specPath.`
    if (seen.has(caseItem.id)) duplicates.add(caseItem.id)
    seen.add(caseItem.id)
  }
  if (duplicates.size) {
    return `Invalid blank eval plan: duplicate case id(s): ${Array.from(duplicates).map(oneLine).join(", ")}.`
  }
  return undefined
}

function resolveCriterion(input: BlankEvalPlanInput): BlankEvalPlanSuccessCriterion {
  return input.successCriterion ?? "all_pass"
}

function resolveMode(input: BlankEvalPlanInput) {
  return input.mode === "single" || input.mode === "sequence" || input.mode === "parallel" ? input.mode : "sequence"
}

function resolveConcurrency(input: BlankEvalPlanInput) {
  const raw = typeof input.concurrency === "number" ? Math.floor(input.concurrency) : 1
  if (!Number.isFinite(raw) || raw < 1) return 1
  return raw
}

function normalizeMinPassRate(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1
  return Math.max(0, Math.min(1, value))
}

function evaluatePlan(input: {
  criterion: BlankEvalPlanSuccessCriterion
  minPassRate?: number
  total: number
  passedCount: number
}) {
  if (input.total <= 0) return false
  if (input.criterion === "allow_partial") return input.passedCount > 0
  if (input.criterion === "min_pass_rate") {
    const min = normalizeMinPassRate(input.minPassRate)
    return input.passedCount / input.total >= min
  }
  return input.passedCount === input.total
}

function summarize(input: {
  passed: boolean
  passedCount: number
  total: number
  failedCases: string[]
  criterion: BlankEvalPlanSuccessCriterion
}) {
  const base = `${input.passedCount}/${input.total} blank eval case(s) passed`
  if (input.passed) return `${base}; criterion ${input.criterion} satisfied.`
  const failed = input.failedCases.length ? ` Failed cases: ${input.failedCases.join(", ")}.` : ""
  return `${base}; criterion ${input.criterion} not satisfied.${failed}`
}

async function writePlanResult(input: {
  runID: string
  runDir: string
  mode: ReturnType<typeof resolveMode>
  criterion: BlankEvalPlanSuccessCriterion
  minPassRate?: number
  total: number
  passedCount: number
  skippedCount: number
  failedCases: string[]
  caseResults: BlankEvalPlanCaseResult[]
  passed: boolean
  summary: string
}) {
  const evidenceBundlePath = path.join(input.runDir, "evidence-bundle.json")
  const resultPath = path.join(input.runDir, "plan-result.json")
  const summaryPath = path.join(input.runDir, "summary.md")
  const failedCount = input.total - input.passedCount - input.skippedCount
  const result: BlankEvalPlanResult = {
    schema: "blank-eval-plan-result/v1",
    runID: input.runID,
    runDir: input.runDir,
    mode: input.mode,
    passed: input.passed,
    successCriterion: input.criterion,
    minPassRate: input.minPassRate,
    total: input.total,
    passedCount: input.passedCount,
    failedCount,
    skippedCount: input.skippedCount,
    score: input.total > 0 ? input.passedCount / input.total : 0,
    failedCases: input.failedCases,
    summary: input.summary,
    caseResults: input.caseResults,
    resultPath,
    evidenceBundlePath,
    summaryPath,
  }
  await writeJsonFile(evidenceBundlePath, {
    schema: "blank-eval-plan-evidence/v1",
    runID: input.runID,
    summary: input.summary,
    failedCases: input.failedCases,
    caseEvidence: input.caseResults.map((item) => ({
      id: item.id,
      passed: item.passed,
      skipped: item.skipped,
      failureKind: item.failureKind,
      summary: item.summary,
      runDir: item.runDir,
      resultPath: item.resultPath,
      validatorResults: item.validatorResults?.map((validator) => ({
        validatorID: validator.validatorID,
        passed: validator.passed,
        failureKind: validator.failureKind,
        summary: validator.summary,
      })),
    })),
  })
  await writeJsonFile(resultPath, result)
  await writeTextFile(
    summaryPath,
    [
      `# Blank Eval Plan ${input.runID}`,
      "",
      `- mode: ${input.mode}`,
      `- passed: ${input.passed}`,
      `- score: ${input.passedCount}/${input.total}`,
      `- criterion: ${input.criterion}`,
      `- failed_cases: ${input.failedCases.join(", ") || "none"}`,
      "",
      "## Cases",
      ...input.caseResults.map((item) => `- ${oneLine(item.id)}: ${item.passed ? "passed" : item.skipped ? "skipped" : "failed"} - ${oneLine(item.summary)}`),
      "",
    ].join("\n"),
  )
  return result
}

async function defaultRunCase(input: {
  plan: BlankEvalPlanInput
  caseItem: BlankEvalPlanCase
  runRoot: string
  runtimeScope: string
  concurrencyScope?: string
}): Promise<BlankEvalPlanCaseResult> {
  const result = await runBlankEval({
    cwd: input.plan.cwd,
    specPath: input.caseItem.specPath,
    skillRoots: input.plan.skillRoots,
    runRoot: input.runRoot,
    title: input.caseItem.title,
    sourceID: input.caseItem.sourceID ?? input.caseItem.id,
    mode: input.caseItem.mode,
    runtimeScope: input.runtimeScope,
    concurrencyScope: input.concurrencyScope,
    promptInlinePaths: input.caseItem.promptInlinePaths,
  })
  return {
    id: input.caseItem.id,
    specPath: input.caseItem.specPath,
    title: input.caseItem.title,
    passed: result.passed,
    failureKind: result.failureKind,
    summary: result.summary,
    runID: result.runID,
    runDir: result.runDir,
    resultPath: result.resultPath,
    validatorResults: result.validatorResults,
  }
}

function failedInfrastructureCase(input: {
  caseItem: BlankEvalPlanCase
  runRoot: string
  error: unknown
}): BlankEvalPlanCaseResult {
  const message = input.error instanceof Error ? input.error.message : String(input.error)
  return {
    id: input.caseItem.id,
    specPath: input.caseItem.specPath,
    title: input.caseItem.title,
    passed: false,
    failureKind: "validator_infrastructure",
    summary: `Blank eval case crashed before producing a valid result: ${message}`,
    runDir: input.runRoot,
  }
}

async function runCaseSafely(input: {
  plan: BlankEvalPlanInput
  caseItem: BlankEvalPlanCase
  runRoot: string
  runtimeScope: string
  concurrencyScope?: string
  runner: BlankEvalCaseRunner
}) {
  try {
    return await input.runner({
      plan: input.plan,
      caseItem: input.caseItem,
      runRoot: input.runRoot,
      runtimeScope: input.runtimeScope,
      concurrencyScope: input.concurrencyScope,
    })
  } catch (error) {
    return failedInfrastructureCase({
      caseItem: input.caseItem,
      runRoot: input.runRoot,
      error,
    })
  }
}

async function runSequence(input: {
  plan: BlankEvalPlanInput
  runDir: string
  runner: BlankEvalCaseRunner
  stopOnFirstFailure: boolean
}) {
  const results: BlankEvalPlanCaseResult[] = []
  for (const [index, caseItem] of input.plan.cases.entries()) {
    const caseRoot = caseRootFor(input.runDir, caseItem, index)
    const caseResult = await runCaseSafely({
      plan: input.plan,
      caseItem,
      runRoot: caseRoot,
      runtimeScope: `${input.plan.runtimeScope ?? "blank-eval-plan"}:${scopeSegment(caseItem.id)}`,
      concurrencyScope: input.plan.concurrencyScope,
      runner: input.runner,
    })
    results.push(caseResult)
    if (input.stopOnFirstFailure && !caseResult.passed) {
      for (const skipped of input.plan.cases.slice(index + 1)) {
        results.push({
          id: skipped.id,
          specPath: skipped.specPath,
          title: skipped.title,
          passed: false,
          skipped: true,
          summary: "Skipped because a previous sequence case failed.",
        })
      }
      break
    }
  }
  return results
}

async function runParallel(input: {
  plan: BlankEvalPlanInput
  runDir: string
  runner: BlankEvalCaseRunner
  concurrency: number
}) {
  const results: BlankEvalPlanCaseResult[] = []
  const inFlight = new Set<Promise<void>>()
  const runOne = async (caseItem: BlankEvalPlanCase, index: number) => {
    const caseRoot = caseRootFor(input.runDir, caseItem, index)
    const caseResult = await runCaseSafely({
      plan: input.plan,
      caseItem,
      runRoot: caseRoot,
      runtimeScope: `${input.plan.runtimeScope ?? "blank-eval-plan"}:${scopeSegment(caseItem.id)}`,
      concurrencyScope: input.plan.concurrencyScope,
      runner: input.runner,
    })
    results[index] = caseResult
  }
  for (const [index, caseItem] of input.plan.cases.entries()) {
    while (inFlight.size >= input.concurrency) await Promise.race(inFlight)
    const job = runOne(caseItem, index).finally(() => inFlight.delete(job))
    inFlight.add(job)
  }
  await Promise.all(inFlight)
  return results.filter(Boolean)
}

export async function runBlankEvalPlan(
  input: BlankEvalPlanInput,
  options: { runner?: BlankEvalCaseRunner } = {},
): Promise<BlankEvalPlanResult> {
  const runID = `blank-eval-plan-${compactStamp()}`
  const runDir = path.join(input.runRoot ?? path.join(input.cwd, "auto-evolve", "runtime-state", "blank-eval-plans"), runID)
  const runner = options.runner ?? defaultRunCase
  const mode = resolveMode(input)
  const criterion = resolveCriterion(input)
  const concurrency = resolveConcurrency(input)
  await ensureDirectory(runDir)
  await ensureDirectory(path.join(runDir, "cases"))

  const invalidPlanMessage = validatePlanInput(input)
  if (invalidPlanMessage) {
    const caseResults = invalidPlanCaseResults({ cases: input.cases, message: invalidPlanMessage })
    return await writePlanResult({
      runID,
      runDir,
      mode,
      criterion,
      minPassRate: input.minPassRate,
      total: input.cases.length,
      passedCount: 0,
      skippedCount: 0,
      failedCases: caseResults.map((item) => item.id),
      caseResults,
      passed: false,
      summary: invalidPlanMessage,
    })
  }

  if (mode === "single" && input.cases.length !== 1) {
    const caseResults: BlankEvalPlanCaseResult[] = input.cases.map((caseItem) => ({
      id: caseItem.id,
      specPath: caseItem.specPath,
      title: caseItem.title,
      passed: false,
      failureKind: "validator_infrastructure",
      summary:
        "Invalid blank eval plan: mode=single requires exactly one case. " +
        "Use mode=sequence or mode=parallel for multi-case replay.",
    }))
    return await writePlanResult({
      runID,
      runDir,
      mode,
      criterion,
      minPassRate: input.minPassRate,
      total: input.cases.length,
      passedCount: 0,
      skippedCount: 0,
      failedCases: input.cases.map((item) => item.id),
      caseResults,
      passed: false,
      summary: `Invalid blank eval plan: mode=single received ${input.cases.length} cases.`,
    })
  }

  await writeJsonFile(path.join(runDir, "plan-input.json"), {
    schema: "blank-eval-plan-input/v1",
    mode,
    title: input.title,
    skillRoots: input.skillRoots,
    caseCount: input.cases.length,
    cases: input.cases.map((item) => ({ id: item.id, specPath: item.specPath, title: item.title })),
    concurrency,
    stopOnFirstFailure: input.stopOnFirstFailure,
    successCriterion: criterion,
    minPassRate: input.minPassRate,
    createdAt: nowISO(),
  })

  const planForExecution = mode === "single" ? { ...input, cases: input.cases.slice(0, 1) } : input
  const caseResults =
    mode === "parallel"
      ? await runParallel({ plan: planForExecution, runDir, runner, concurrency })
      : await runSequence({
          plan: planForExecution,
          runDir,
          runner,
          stopOnFirstFailure: input.stopOnFirstFailure === true,
        })

  const total = planForExecution.cases.length
  const passedCount = caseResults.filter((item) => item.passed).length
  const skippedCount = caseResults.filter((item) => item.skipped).length
  const failedCases = caseResults.filter((item) => !item.passed && !item.skipped).map((item) => item.id)
  const passed = evaluatePlan({ criterion, minPassRate: input.minPassRate, total, passedCount })
  const summary = summarize({ passed, passedCount, total, failedCases, criterion })
  return await writePlanResult({
    runID,
    runDir,
    mode,
    criterion,
    minPassRate: input.minPassRate,
    total,
    passedCount,
    skippedCount,
    failedCases,
    caseResults,
    passed,
    summary,
  })
}
