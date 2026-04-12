import type { AttemptSummary } from "./case-runtime"
import { buildSessionRecordRef } from "./method-strategy-helpers"

function recordBundle(absolutePath: string, relativePath: string, phase: string, sessionID?: string) {
  const bundle = buildSessionRecordRef({
    label: phase,
    absolutePath,
    relativePath,
    phase,
    sessionID,
  })

  return {
    phase,
    sessionID: sessionID ?? null,
    executionReportPath: bundle.relativePath,
    learningLogPath: bundle.learningLogRelativePath ?? null,
    taskManifestPath: bundle.taskManifestRelativePath ?? null,
  }
}

export function buildAttemptTaskIndex(attemptSummary: AttemptSummary, runDir: string) {
  const tasks: Record<string, unknown>[] = []

  if (attemptSummary.solveSessionExecutionReportPath) {
    tasks.push(
      recordBundle(
        attemptSummary.solveSessionExecutionReportPath,
        attemptSummary.solveSessionExecutionReportPath.replace(runDir, "").replace(/^[\\/]/, "").replace(/\\/g, "/"),
        "solve",
        attemptSummary.solveSessionID,
      ),
    )
  }

  if (attemptSummary.judgeSessionExecutionReportPath) {
    tasks.push(
      recordBundle(
        attemptSummary.judgeSessionExecutionReportPath,
        attemptSummary.judgeSessionExecutionReportPath.replace(runDir, "").replace(/^[\\/]/, "").replace(/\\/g, "/"),
        "judge",
        attemptSummary.judgeSessionID,
      ),
    )
  }

  if (attemptSummary.transactionRecordPath) {
    tasks.push({
      phase: "transaction_gate",
      sessionID: null,
      recordPath: attemptSummary.transactionRecordPath.replace(runDir, "").replace(/^[\\/]/, "").replace(/\\/g, "/"),
    })
  }
  for (const item of attemptSummary.acceptanceRecordPaths ?? []) {
    tasks.push({
      phase: "acceptance_framework",
      sessionID: null,
      recordPath: item.replace(runDir, "").replace(/^[\\/]/, "").replace(/\\/g, "/"),
    })
  }

  for (const item of attemptSummary.regressionBeforeReports ?? []) {
    tasks.push(
      recordBundle(
        item.path,
        item.path.replace(runDir, "").replace(/^[\\/]/, "").replace(/\\/g, "/"),
        `regression_before:${item.caseID}`,
      ),
    )
  }

  for (const round of attemptSummary.maintenanceRounds ?? []) {
    if (round.maintainSessionExecutionReportPath) {
      tasks.push(
        recordBundle(
          round.maintainSessionExecutionReportPath,
          round.maintainSessionExecutionReportPath.replace(runDir, "").replace(/^[\\/]/, "").replace(/\\/g, "/"),
          `maintain:round-${String(round.round).padStart(2, "0")}`,
          round.maintainSessionID,
        ),
      )
    }
    if (round.currentCaseVerificationReportPath) {
      tasks.push(
        recordBundle(
          round.currentCaseVerificationReportPath,
          round.currentCaseVerificationReportPath.replace(runDir, "").replace(/^[\\/]/, "").replace(/\\/g, "/"),
          `verify:round-${String(round.round).padStart(2, "0")}`,
        ),
      )
    }
    if (round.transactionRecordPath) {
      tasks.push({
        phase: `transaction_gate:round-${String(round.round).padStart(2, "0")}`,
        sessionID: null,
        recordPath: round.transactionRecordPath.replace(runDir, "").replace(/^[\\/]/, "").replace(/\\/g, "/"),
      })
    }
    for (const item of round.acceptanceRecordPaths ?? []) {
      tasks.push({
        phase: `acceptance_framework:round-${String(round.round).padStart(2, "0")}`,
        sessionID: null,
        recordPath: item.replace(runDir, "").replace(/^[\\/]/, "").replace(/\\/g, "/"),
      })
    }
    for (const report of round.regressionAfterReports ?? []) {
      tasks.push(
        recordBundle(
          report.path,
          report.path.replace(runDir, "").replace(/^[\\/]/, "").replace(/\\/g, "/"),
          `regression_after:${report.caseID}:round-${String(round.round).padStart(2, "0")}`,
        ),
      )
    }
    if (round.postJudgeSummaryPath || round.postJudgeReportPath) {
      tasks.push({
        phase: `post_judge:round-${String(round.round).padStart(2, "0")}`,
        sessionID: null,
        summaryPath: round.postJudgeSummaryPath
          ? round.postJudgeSummaryPath.replace(runDir, "").replace(/^[\\/]/, "").replace(/\\/g, "/")
          : null,
        reportPath: round.postJudgeReportPath
          ? round.postJudgeReportPath.replace(runDir, "").replace(/^[\\/]/, "").replace(/\\/g, "/")
          : null,
        strategyID: round.postJudgeStrategyID ?? null,
        decision: round.postJudgeDecision ?? null,
      })
    }
  }

  return {
    attempt: attemptSummary.attempt,
    passed: attemptSummary.passed,
    taskCount: tasks.length,
    tasks,
  }
}
