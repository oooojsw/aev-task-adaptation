import path from "node:path"
import { ensureDirectory, writeJsonFile } from "../fs"
import { writeTaskArtifacts } from "../task-artifacts"
import type { CaseRuntimeContext } from "../case-runtime"
import type { MethodStrategyDecision } from "../method-strategies"
import type { JudgePlan } from "../judge/contract"
import { runHardJudgeTools } from "../judge/hard-tools"
import { runSoftJudge } from "../judge/run"

export async function runPreJudgePrimitive(context: CaseRuntimeContext, judgePlan: JudgePlan) {
  await ensureDirectory(context.judgeDir)

  const judgeSummaryPath = path.join(context.judgeDir, "judge_summary.json")
  const judgeReportPath = path.join(context.judgeDir, "judge_report.md")
  const routingPath = path.join(context.acceptanceDir, "routing.json")
  const { artifacts, indexPath } = await runHardJudgeTools(context, context.judgeDir)

  const result = await runSoftJudge({
    cwd: context.cwd,
    config: context.config,
    methodID: context.methodID,
    loadedCase: context.loaded,
    workspace: context.workspace,
    inputPaths: {
      runDir: context.runDir,
      baselinePath: context.baselinePath,
      expectedPath: context.expectedPath,
      actualPath: context.feedback.actualOutputPath!,
      evaluationPath: context.feedback.evaluationPath!,
      actionTracePath: context.feedback.actionTracePath!,
      routingPath,
      judgeSummaryPath,
      judgeReportPath,
    },
    judgePlan,
    hardCheckArtifacts: artifacts,
  })

  context.judge.judgeTask = result.task
  context.judge.judgeSummaryPath = result.summaryPath
  context.judge.judgeReportPath = result.reportPath
  context.judge.hardCheckIndexPath = result.hardCheckIndexPath
  context.judge.hardCheckResultPaths = result.hardCheckArtifacts.map((item) => item.outputPath)
  context.judge.summary = result.summary
  context.judge.shouldStartMaintainer = result.summary?.shouldStartMaintainer
  context.judge.judgeMode = context.config.judgeConfig.mode

  context.attemptSummary.judgeSessionID = result.task.result.sessionID
  context.attemptSummary.judgeSessionExecutionReportPath = (
    await writeTaskArtifacts(context.judgeDir, result.task, {
      phase: "judge",
      taskKind: "judge",
      caseID: context.loaded.spec.id,
      attempt: context.attempt,
      methodID: context.methodID,
    })
  ).sessionExecutionReportPath
  context.attemptSummary.judgeExitCode = result.task.result.exitCode
  context.attemptSummary.judgeSummaryPath = result.summaryPath
  context.attemptSummary.judgeReportPath = result.reportPath
  context.attemptSummary.judgeMode = context.config.judgeConfig.mode
  context.attemptSummary.judgeShouldStartMaintainer = result.summary?.shouldStartMaintainer

  await writeJsonFile(path.join(context.judgeDir, "judge_run_summary.json"), {
    judgeMode: context.config.judgeConfig.mode,
    judgeSummaryPath: result.summaryPath,
    judgeReportPath: result.reportPath,
    hardCheckIndexPath: indexPath ?? null,
    hardCheckArtifacts: result.hardCheckArtifacts,
    softJudgeExitCode: result.task.result.exitCode,
    shouldStartMaintainer: result.summary?.shouldStartMaintainer ?? null,
  })
}

export async function finishIfJudgeSkippedMaintenancePrimitive(
  context: CaseRuntimeContext,
): Promise<Exclude<MethodStrategyDecision, "continue"> | null> {
  if (context.judge.judgeTask?.result.exitCode && context.judge.judgeTask.result.exitCode !== 0) {
    context.stopReason = "soft judge failed"
    return "finish_run"
  }
  if (!context.judge.summary) {
    context.stopReason = "soft judge produced no summary"
    return "finish_run"
  }
  if (context.judge.summary.shouldStartMaintainer) return null
  context.stopReason = "judge declined maintainer start"
  return "finish_run"
}
