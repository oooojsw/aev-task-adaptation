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
  return (
    input
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || fallback
  )
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
    const caseRoot = path.join(input.runDir, "cases", `${String(index + 1).padStart(3, "0")}-${safeName(caseItem.id, "case")}`)
    const caseResult = await runCaseSafely({
      plan: input.plan,
      caseItem,
      runRoot: caseRoot,
      runtimeScope: `${input.plan.runtimeScope ?? "blank-eval-plan"}:${caseItem.id}`,
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
    const caseRoot = path.join(input.runDir, "cases", `${String(index + 1).padStart(3, "0")}-${safeName(caseItem.id, "case")}`)
    const caseResult = await runCaseSafely({
      plan: input.plan,
      caseItem,
      runRoot: caseRoot,
      runtimeScope: `${input.plan.runtimeScope ?? "blank-eval-plan"}:${caseItem.id}`,
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
  const failedCount = total - passedCount - skippedCount
  const score = total > 0 ? passedCount / total : 0
  const passed = evaluatePlan({ criterion, minPassRate: input.minPassRate, total, passedCount })
  const summary = summarize({ passed, passedCount, total, failedCases, criterion })
  const evidenceBundlePath = path.join(runDir, "evidence-bundle.json")
  const resultPath = path.join(runDir, "plan-result.json")
  const summaryPath = path.join(runDir, "summary.md")
  const result: BlankEvalPlanResult = {
    schema: "blank-eval-plan-result/v1",
    runID,
    runDir,
    mode,
    passed,
    successCriterion: criterion,
    minPassRate: input.minPassRate,
    total,
    passedCount,
    failedCount,
    skippedCount,
    score,
    failedCases,
    summary,
    caseResults,
    resultPath,
    evidenceBundlePath,
    summaryPath,
  }
  await writeJsonFile(evidenceBundlePath, {
    schema: "blank-eval-plan-evidence/v1",
    runID,
    summary,
    failedCases,
    caseEvidence: caseResults.map((item) => ({
      id: item.id,
      passed: item.passed,
      skipped: item.skipped,
      summary: item.summary,
      runDir: item.runDir,
      resultPath: item.resultPath,
    })),
  })
  await writeJsonFile(resultPath, result)
  await writeTextFile(
    summaryPath,
    [
      `# Blank Eval Plan ${runID}`,
      "",
      `- mode: ${mode}`,
      `- passed: ${passed}`,
      `- score: ${passedCount}/${total}`,
      `- criterion: ${criterion}`,
      `- failed_cases: ${failedCases.join(", ") || "none"}`,
      "",
      "## Cases",
      ...caseResults.map((item) => `- ${item.id}: ${item.passed ? "passed" : item.skipped ? "skipped" : "failed"} - ${item.summary}`),
      "",
    ].join("\n"),
  )
  return result
}
