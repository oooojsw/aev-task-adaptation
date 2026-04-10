import path from "node:path"
import { writeJsonFile } from "../fs"
import {
  readExperienceWorkspace,
  resolveExperienceWorkspaceLayout,
  restoreExperienceWorkspace,
  writeExperienceWorkspaceSnapshot,
} from "../experience-workspace"
import { collectRegressionLosses, type CaseRuntimeContext } from "../case-runtime"
import type { MethodStrategyDecision } from "../method-strategies"
import { executeSolveStage } from "./solve-stage"

export async function verifyCurrentCasePrimitive(context: CaseRuntimeContext) {
  const currentCaseVerification = await executeSolveStage({
    context,
    stageDir: path.join(context.acceptanceDir, "current-case-verify"),
    title: `auto-evolve current case verify ${context.loaded.spec.id} attempt ${context.attempt}`,
    phase: "verify",
  })

  context.acceptance.currentCaseVerification = currentCaseVerification
  context.attemptSummary.currentCaseVerificationPassed = currentCaseVerification.evaluation.passed
  context.attemptSummary.currentCaseVerificationReportPath = currentCaseVerification.sessionExecutionReportPath
  const roundSummary =
    context.currentMaintenanceRound !== undefined
      ? context.attemptSummary.maintenanceRounds?.find((item) => item.round === context.currentMaintenanceRound)
      : undefined
  if (roundSummary) {
    roundSummary.currentCaseVerificationPassed = currentCaseVerification.evaluation.passed
    roundSummary.currentCaseVerificationReportPath = currentCaseVerification.sessionExecutionReportPath
  }
}

export async function rejectIfCurrentCaseNotFixedPrimitive(
  context: CaseRuntimeContext,
): Promise<Exclude<MethodStrategyDecision, "continue"> | null> {
  if (!context.acceptance.currentCaseVerification || !context.maintenance.workspaceBeforeMaintenance || !context.feedback.routing) {
    throw new Error("rejectIfCurrentCaseNotFixed requires current-case verification and maintenance baseline snapshot.")
  }
  if (context.acceptance.currentCaseVerification.evaluation.passed) return null

  await restoreExperienceWorkspace(context.workspace, context.maintenance.workspaceBeforeMaintenance)
  context.workspace = await resolveExperienceWorkspaceLayout(context.workspacePaths)
  await writeExperienceWorkspaceSnapshot(
    path.join(context.acceptanceDir, "experience_workspace.after_acceptance_rollback"),
    await readExperienceWorkspace(context.workspace),
  )
  context.attemptSummary.acceptancePassed = false
  context.attemptSummary.acceptanceRejected = true
  context.attemptSummary.acceptanceRejectionReasons = [
    "The maintained experience workspace still failed to solve the current case during verification.",
  ]
  const roundSummary =
    context.currentMaintenanceRound !== undefined
      ? context.attemptSummary.maintenanceRounds?.find((item) => item.round === context.currentMaintenanceRound)
      : undefined
  if (roundSummary) {
    roundSummary.acceptancePassed = false
    roundSummary.acceptanceRejected = true
    roundSummary.acceptanceReason = "current_case_not_fixed"
    roundSummary.acceptanceRejectionReasons = [
      "The maintained experience workspace still failed to solve the current case during verification.",
    ]
  }
  await writeJsonFile(path.join(context.acceptanceDir, "acceptance.json"), {
    accepted: false,
    reason: "current_case_not_fixed",
    routing: context.feedback.routing,
    changedFiles: context.maintenance.workspaceChangedFiles ?? [],
    currentCaseVerification: context.acceptance.currentCaseVerification.evaluation,
  })
  return "next_attempt"
}

export async function acceptOrRejectChangePrimitive(
  context: CaseRuntimeContext,
): Promise<Exclude<MethodStrategyDecision, "continue"> | null> {
  if (
    !context.feedback.routing ||
    !context.acceptance.currentCaseVerification ||
    !context.acceptance.afterRegression ||
    !context.acceptance.baselineRegression ||
    !context.maintenance.workspaceBeforeMaintenance ||
    !context.maintenance.workspaceChangedFiles
  ) {
    throw new Error("acceptOrRejectChange requires maintenance verification and regression state.")
  }

  const regressionLosses = collectRegressionLosses(
    context.acceptance.baselineRegression.cases,
    context.acceptance.afterRegression.cases,
  )
  if (
    context.acceptance.afterRegression.passedCount < context.acceptance.baselineRegression.passedCount ||
    regressionLosses.length > 0
  ) {
    await restoreExperienceWorkspace(context.workspace, context.maintenance.workspaceBeforeMaintenance)
    context.workspace = await resolveExperienceWorkspaceLayout(context.workspacePaths)
    await writeExperienceWorkspaceSnapshot(
      path.join(context.acceptanceDir, "experience_workspace.after_acceptance_rollback"),
      await readExperienceWorkspace(context.workspace),
    )
    const rejectionReasons: string[] = []
    if (context.acceptance.afterRegression.passedCount < context.acceptance.baselineRegression.passedCount) {
      rejectionReasons.push(
        `Regression pass count dropped from ${context.acceptance.baselineRegression.passedCount} to ${context.acceptance.afterRegression.passedCount}.`,
      )
    }
    if (regressionLosses.length > 0) {
      rejectionReasons.push(`Previously passing regression cases failed after maintain: ${regressionLosses.join(", ")}`)
    }
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
      roundSummary.acceptanceReason = "regression_loss"
      roundSummary.acceptanceRejectionReasons = rejectionReasons
      roundSummary.regressionAfterReports = context.acceptance.afterRegression.cases
        .filter((item) => item.sessionExecutionReportPath)
        .map((item) => ({ caseID: item.caseID, path: item.sessionExecutionReportPath! }))
      roundSummary.regressionPassedAfterRefine = context.acceptance.afterRegression.passedCount
    }
    await writeJsonFile(path.join(context.acceptanceDir, "acceptance.json"), {
      accepted: false,
      reason: "regression_loss",
      routing: context.feedback.routing,
      changedFiles: context.maintenance.workspaceChangedFiles,
      currentCaseVerification: context.acceptance.currentCaseVerification.evaluation,
      regressionBefore: context.acceptance.baselineRegression,
      regressionAfter: context.acceptance.afterRegression,
      regressionLosses,
    })
    return "next_attempt"
  }

  context.attemptSummary.acceptancePassed = true
  const roundSummary =
    context.currentMaintenanceRound !== undefined
      ? context.attemptSummary.maintenanceRounds?.find((item) => item.round === context.currentMaintenanceRound)
      : undefined
  if (roundSummary) {
    roundSummary.acceptancePassed = true
    roundSummary.acceptanceRejected = false
    roundSummary.acceptanceReason = "accepted"
    roundSummary.regressionAfterReports = context.acceptance.afterRegression.cases
      .filter((item) => item.sessionExecutionReportPath)
      .map((item) => ({ caseID: item.caseID, path: item.sessionExecutionReportPath! }))
    roundSummary.regressionPassedAfterRefine = context.acceptance.afterRegression.passedCount
  }
  await writeJsonFile(path.join(context.acceptanceDir, "acceptance.json"), {
    accepted: true,
    reason: "accepted",
    routing: context.feedback.routing,
    changedFiles: context.maintenance.workspaceChangedFiles,
    currentCaseVerification: context.acceptance.currentCaseVerification.evaluation,
    regressionBefore: context.acceptance.baselineRegression,
    regressionAfter: context.acceptance.afterRegression,
    regressionLosses: [],
  })
  await writeExperienceWorkspaceSnapshot(
    path.join(context.acceptanceDir, "experience_workspace.after_acceptance"),
    await readExperienceWorkspace(context.workspace),
  )

  context.finalEvaluation = context.acceptance.currentCaseVerification.evaluation
  return null
}

export async function finishAfterAcceptPrimitive(
  context: CaseRuntimeContext,
): Promise<Exclude<MethodStrategyDecision, "continue"> | null> {
  if (!context.attemptSummary.acceptancePassed) return null
  context.stopReason = "case passed after accepted maintenance"
  return "finish_run"
}
