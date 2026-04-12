import type { CaseRuntimeContext } from "../case-runtime"
import type { PostJudgePlan } from "../post-judge/contract"
import { runPostJudge } from "../post-judge/run"

export async function runPostJudgePrimitive(context: CaseRuntimeContext, plan: PostJudgePlan) {
  const result = await runPostJudge(context, plan)
  context.postJudge.strategyID = result.summary.strategyID
  context.postJudge.decision = result.summary.decision
  context.postJudge.summaryPath = result.summaryPath
  context.postJudge.reportPath = result.reportPath
  context.postJudge.riskLevel = result.summary.riskLevel
  context.postJudge.summary = result.summary

  context.attemptSummary.postJudgeStrategyID = result.summary.strategyID
  context.attemptSummary.postJudgeDecision = result.summary.decision
  context.attemptSummary.postJudgeSummaryPath = result.summaryPath
  context.attemptSummary.postJudgeReportPath = result.reportPath
  context.attemptSummary.postJudgeRiskLevel = result.summary.riskLevel

  const roundSummary =
    context.currentMaintenanceRound !== undefined
      ? context.attemptSummary.maintenanceRounds?.find((item) => item.round === context.currentMaintenanceRound)
      : undefined
  if (roundSummary) {
    roundSummary.postJudgeStrategyID = result.summary.strategyID
    roundSummary.postJudgeDecision = result.summary.decision
    roundSummary.postJudgeSummaryPath = result.summaryPath
    roundSummary.postJudgeReportPath = result.reportPath
    roundSummary.postJudgeRiskLevel = result.summary.riskLevel
  }
}
