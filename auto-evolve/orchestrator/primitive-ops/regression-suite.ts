import path from "node:path"
import { selectRegressionCases } from "../acceptance"
import { writeJsonFile } from "../fs"
import type { CaseRuntimeContext, RegressionCaseSummary, RegressionSuiteResult } from "../case-runtime"
import { executeSolveStage } from "./solve-stage"

async function runRegressionSuite(input: {
  context: CaseRuntimeContext
  cases: CaseRuntimeContext["allCases"]
  suiteDir: string
  titlePrefix: string
}): Promise<RegressionSuiteResult> {
  const results: RegressionCaseSummary[] = []

  for (const item of input.cases) {
    const regressionContext: CaseRuntimeContext = {
      ...input.context,
      loaded: item,
      expectedPath: path.join(item.caseDir, item.spec.expected.path),
      expectedText: await Bun.file(path.join(item.caseDir, item.spec.expected.path)).text(),
    }

    const stage = await executeSolveStage({
      context: regressionContext,
      stageDir: path.join(input.suiteDir, item.spec.id),
      title: `${input.titlePrefix} ${item.spec.id}`,
      phase: "regression",
    })

    results.push({
      caseID: item.spec.id,
      passed: stage.evaluation.passed,
      summary: stage.evaluation.summary,
      exitCode: stage.task.result.exitCode,
      toolFailureCount: stage.task.result.toolFailures.length,
      solveSessionID: stage.task.result.sessionID,
      sessionExecutionReportPath: stage.sessionExecutionReportPath,
    })
  }

  return {
    cases: results,
    passedCount: results.filter((item) => item.passed).length,
    failedCount: results.filter((item) => !item.passed).length,
  }
}

export async function runRegressionBeforeMaintenancePrimitive(context: CaseRuntimeContext) {
  const regressionCases = selectRegressionCases(
    context.allCases,
    context.datasetSplit,
    context.loaded.spec.id,
    context.config.regressionSampleSize,
  )
  context.acceptance.regressionCases = regressionCases
  context.attemptSummary.regressionCaseIDs = regressionCases.map((item) => item.spec.id)

  const baselineRegression = await runRegressionSuite({
    context,
    cases: regressionCases,
    suiteDir: path.join(context.acceptanceDir, "regression-before-maintain"),
    titlePrefix: `auto-evolve regression before maintain ${context.loaded.spec.id} attempt ${context.attempt}`,
  })

  context.acceptance.baselineRegression = baselineRegression
  context.attemptSummary.regressionPassedBeforeRefine = baselineRegression.passedCount
  context.attemptSummary.regressionBeforeReports = baselineRegression.cases
    .filter((item) => item.sessionExecutionReportPath)
    .map((item) => ({ caseID: item.caseID, path: item.sessionExecutionReportPath! }))
  await writeJsonFile(path.join(context.acceptanceDir, "regression-before-maintain.summary.json"), baselineRegression)
}

export async function runRegressionAfterMaintenancePrimitive(context: CaseRuntimeContext) {
  const afterRegression = await runRegressionSuite({
    context,
    cases: context.acceptance.regressionCases ?? [],
    suiteDir: path.join(context.acceptanceDir, "regression-after-maintain"),
    titlePrefix: `auto-evolve regression after maintain ${context.loaded.spec.id} attempt ${context.attempt}`,
  })

  context.acceptance.afterRegression = afterRegression
  context.attemptSummary.regressionPassedAfterRefine = afterRegression.passedCount
  context.attemptSummary.regressionAfterReports = afterRegression.cases
    .filter((item) => item.sessionExecutionReportPath)
    .map((item) => ({ caseID: item.caseID, path: item.sessionExecutionReportPath! }))
  await writeJsonFile(path.join(context.acceptanceDir, "regression-after-maintain.summary.json"), afterRegression)
}
