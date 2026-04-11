import path from "node:path"
import { ensureDirectory, runDirectory, writeJsonFile, writeTextFile } from "./fs"
import { loadDatasetSplit, selectCasesBySplit, type DatasetSplitName } from "./dataset-split"
import { runCase } from "./case-runner"
import { resolveExecutionStrategy } from "./execution-strategies"
import { resolveLocalLearningRecipe } from "./local-learning-recipes"
import { loadAllCases, loadConfig, type RuntimePathOverrides } from "./schema"
import { runBatchRound } from "./batch-kernel"

export interface RoundCaseSummary {
  caseID: string
  runDir: string
  passed: boolean
  attempts: number
  summary: string
  acceptedRefines: number
  rejectedRefines: number
}

export interface RunRoundResult {
  roundDir: string
  methodID: string
  caseLimit: number
  split: DatasetSplitName
  mode: "learn" | "eval"
  totalCases: number
  passedCases: number
  failedCases: number
  acceptedRefines: number
  rejectedRefines: number
  cases: RoundCaseSummary[]
}

function makeRoundID() {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`
  return `${stamp}-round`
}

export async function runRound(
  cwd: string,
  options?: {
    methodID?: string
    caseLimit?: number
    split?: DatasetSplitName
    mode?: "learn" | "eval"
    runtimePaths?: RuntimePathOverrides
  },
): Promise<RunRoundResult> {
  const config = await loadConfig(cwd, options?.runtimePaths)
  const methodID = options?.methodID ?? config.defaultMethod
  const recipe = resolveLocalLearningRecipe(methodID)
  const executionStrategy = resolveExecutionStrategy(recipe.executionStrategyID)
  if (executionStrategy.kind === "parallel_batch") {
    return runBatchRound(cwd, options)
  }
  const splitName = options?.split ?? "train"
  const mode = options?.mode ?? (splitName === "test" ? "eval" : "learn")
  const caseLimit = Math.max(1, options?.caseLimit ?? config.roundCaseLimit)
  const split = await loadDatasetSplit(cwd, config)
  const cases = selectCasesBySplit(await loadAllCases(cwd, config), split, splitName).slice(0, caseLimit)
  const roundDir = runDirectory(cwd, config, makeRoundID())
  await ensureDirectory(roundDir)

  const summaries: RoundCaseSummary[] = []

  for (const item of cases) {
    const result = await runCase(cwd, item.spec.id, {
      methodID,
      mode,
      split: splitName,
      runtimePaths: options?.runtimePaths,
    })
    const acceptedRefines = result.attempts.filter((attempt) => attempt.acceptancePassed).length
    const rejectedRefines = result.attempts.filter((attempt) => attempt.acceptanceRejected).length
    summaries.push({
      caseID: item.spec.id,
      runDir: result.runDir,
      passed: result.evaluation.passed,
      attempts: result.attempts.length,
      summary: result.evaluation.summary,
      acceptedRefines,
      rejectedRefines,
    })
  }

  const passedCases = summaries.filter((item) => item.passed).length
  const failedCases = summaries.length - passedCases
  const acceptedRefines = summaries.reduce((total, item) => total + item.acceptedRefines, 0)
  const rejectedRefines = summaries.reduce((total, item) => total + item.rejectedRefines, 0)

  await writeJsonFile(path.join(roundDir, "round.json"), {
    methodID,
    caseLimit,
    split: splitName,
    mode,
    totalCases: summaries.length,
    passedCases,
    failedCases,
    acceptedRefines,
    rejectedRefines,
    cases: summaries,
  })

  await writeTextFile(
    path.join(roundDir, "round-summary.md"),
    [
      "# Round Summary",
      "",
      `- method: ${methodID}`,
      `- split: ${splitName}`,
      `- mode: ${mode}`,
      `- case limit: ${caseLimit}`,
      `- total cases: ${summaries.length}`,
      `- passed cases: ${passedCases}`,
      `- failed cases: ${failedCases}`,
      `- accepted refines: ${acceptedRefines}`,
      `- rejected refines: ${rejectedRefines}`,
      "",
      ...summaries.map(
        (item) =>
          `- ${item.caseID}: ${item.passed ? "passed" : "failed"} after ${item.attempts} attempt(s), accepted refines ${item.acceptedRefines}, rejected refines ${item.rejectedRefines} | ${item.runDir}`,
      ),
      "",
    ].join("\n"),
  )

  return {
    roundDir,
    methodID,
    caseLimit,
    split: splitName,
    mode,
    totalCases: summaries.length,
    passedCases,
    failedCases,
    acceptedRefines,
    rejectedRefines,
    cases: summaries,
  }
}
