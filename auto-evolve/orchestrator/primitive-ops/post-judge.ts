import path from "node:path"
import { readExperienceWorkspace, resolveExperienceWorkspaceLayout, restoreExperienceWorkspace, writeExperienceWorkspaceSnapshot } from "../experience-workspace"
import { writeJsonFile } from "../fs"
import type { CaseRuntimeContext } from "../case-runtime"
import type { MethodStrategyDecision } from "../method-strategies"
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

export async function applyPostJudgeDecisionPrimitive(
  context: CaseRuntimeContext,
): Promise<Exclude<MethodStrategyDecision, "continue"> | null> {
  if (!context.postJudge.summary || !context.maintenance.workspaceBeforeMaintenance || !context.acceptance.currentCaseVerification) {
    throw new Error("applyPostJudgeDecision requires post-judge summary, maintenance baseline, and verification state.")
  }

  if (context.postJudge.summary.decision === "accept") {
    context.attemptSummary.acceptancePassed = true
    context.attemptSummary.acceptanceRejected = false
    const roundSummary =
      context.currentMaintenanceRound !== undefined
        ? context.attemptSummary.maintenanceRounds?.find((item) => item.round === context.currentMaintenanceRound)
        : undefined
    if (roundSummary) {
      roundSummary.acceptancePassed = true
      roundSummary.acceptanceRejected = false
      roundSummary.acceptanceReason = "accepted"
      roundSummary.acceptanceRejectionReasons = []
    }

    await writeJsonFile(path.join(context.acceptanceDir, "acceptance.json"), {
      accepted: true,
      reason: "accepted",
      strategyID: context.postJudge.summary.strategyID,
      changedFiles: context.maintenance.workspaceChangedFiles ?? [],
      currentCaseVerification: context.acceptance.currentCaseVerification.evaluation,
      regressionBefore: context.acceptance.baselineRegression ?? null,
      regressionAfter: context.acceptance.afterRegression ?? null,
      postJudge: context.postJudge.summary,
    })
    await writeExperienceWorkspaceSnapshot(
      path.join(context.acceptanceDir, "experience_workspace.after_acceptance"),
      await readExperienceWorkspace(context.workspace),
    )

    context.finalEvaluation = context.acceptance.currentCaseVerification.evaluation
    return null
  }

  await restoreExperienceWorkspace(context.workspace, context.maintenance.workspaceBeforeMaintenance)
  context.workspace = await resolveExperienceWorkspaceLayout(context.workspacePaths)
  await writeExperienceWorkspaceSnapshot(
    path.join(context.acceptanceDir, "experience_workspace.after_acceptance_rollback"),
    await readExperienceWorkspace(context.workspace),
  )

  const rejectionReasons = context.postJudge.summary.reasons.length
    ? context.postJudge.summary.reasons
    : ["Post-judge rejected the maintenance transaction."]

  context.attemptSummary.acceptancePassed = false
  context.attemptSummary.acceptanceRejected = true
  context.attemptSummary.acceptanceRejectionReasons = rejectionReasons

  const roundSummary =
    context.currentMaintenanceRound !== undefined
      ? context.attemptSummary.maintenanceRounds?.find((item) => item.round === context.currentMaintenanceRound)
      : undefined
  if (roundSummary) {
    roundSummary.acceptancePassed = false
    roundSummary.acceptanceRejected = true
    roundSummary.acceptanceReason = "post_judge_retry"
    roundSummary.acceptanceRejectionReasons = rejectionReasons
  }

  await writeJsonFile(path.join(context.acceptanceDir, "acceptance.json"), {
    accepted: false,
    reason: "post_judge_retry",
    strategyID: context.postJudge.summary.strategyID,
    changedFiles: context.maintenance.workspaceChangedFiles ?? [],
    currentCaseVerification: context.acceptance.currentCaseVerification.evaluation,
    regressionBefore: context.acceptance.baselineRegression ?? null,
    regressionAfter: context.acceptance.afterRegression ?? null,
    postJudge: context.postJudge.summary,
  })
  return "next_attempt"
}
