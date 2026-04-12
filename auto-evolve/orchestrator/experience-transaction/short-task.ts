import path from "node:path"
import { readExperienceWorkspace, restoreExperienceWorkspace, resolveExperienceWorkspaceLayout, validateExperienceWorkspaceLayout, writeExperienceWorkspaceSnapshot } from "../experience-workspace"
import { writeJsonFile } from "../fs"
import type { CaseRuntimeContext } from "../case-runtime"
import type { EvaluationResult } from "../evaluator"
import type { MethodStrategyDecision } from "../method-strategies"
import { experienceTransactionPaths, writeExperienceTransactionRecord } from "./repository"

function pad(value: number) {
  return String(value).padStart(2, "0")
}

function transactionMirrorPath(context: CaseRuntimeContext, stage: string) {
  const roundSegment =
    context.currentMaintenanceRound !== undefined
      ? path.join(`round-${pad(context.currentMaintenanceRound)}`)
      : "attempt"
  return path.join(context.transactionDir, roundSegment, `${stage}.json`)
}

async function recordTransaction(
  context: CaseRuntimeContext,
  input: {
    stage: string
    decision: "observe" | "accept" | "retry" | "rollback"
    status: "observed" | "accepted" | "rejected"
    reason: string
    reasons: string[]
    summary: string
    controlDecision?: "next_attempt" | "finish_run" | null
    changedFiles?: string[]
    workspaceValidationErrors?: string[]
    currentCaseVerification?: EvaluationResult | null
    regressionBefore?: Record<string, unknown> | null
    regressionAfter?: Record<string, unknown> | null
    postJudge?: Record<string, unknown> | null
    acceptance?: Record<string, unknown> | null
  },
) {
  const currentRound = context.currentMaintenanceRound
  const result = await writeExperienceTransactionRecord(experienceTransactionPaths(context.cwd, context.config), {
    id: `txn-${context.loaded.spec.id}-attempt-${pad(context.attempt)}-${input.stage}${currentRound !== undefined ? `-round-${pad(currentRound)}` : ""}`,
    status: input.status,
    decision: input.decision,
    stage: input.stage,
    sourceRunID: path.basename(context.runDir),
    caseID: context.loaded.spec.id,
    attempt: context.attempt,
    maintenanceRound: currentRound,
    summary: input.summary,
    reason: input.reason,
    reasons: input.reasons,
    controlDecision: input.controlDecision ?? null,
    changedFiles: input.changedFiles,
    workspaceValidationErrors: input.workspaceValidationErrors,
    currentCaseVerification: input.currentCaseVerification
      ? {
          passed: input.currentCaseVerification.passed,
          summary: input.currentCaseVerification.summary,
          mismatches: input.currentCaseVerification.mismatches,
        }
      : null,
    regressionBefore: input.regressionBefore ?? null,
    regressionAfter: input.regressionAfter ?? null,
    postJudge: input.postJudge ?? null,
    acceptance: input.acceptance ?? null,
    notes: [
      "Transaction gate audit record.",
      "This record is distinct from maintainer output and canonical experience state.",
    ],
    mirrorPath: transactionMirrorPath(context, input.stage),
  })

  context.attemptSummary.transactionRecordPath = result.path
  const roundSummary =
    currentRound !== undefined
      ? context.attemptSummary.maintenanceRounds?.find((item) => item.round === currentRound)
      : undefined
  if (roundSummary) {
    roundSummary.transactionRecordPath = result.path
  }

  return result
}

export async function verifyCurrentCasePrimitive(context: CaseRuntimeContext) {
  const { executeSolveStage } = await import("../primitive-ops/solve-stage")
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

  await recordTransaction(context, {
    stage: "verify_current_case",
    decision: currentCaseVerification.evaluation.passed ? "accept" : "retry",
    status: "observed",
    reason: currentCaseVerification.evaluation.passed ? "verification passed" : "verification failed",
    reasons: currentCaseVerification.evaluation.passed ? [] : currentCaseVerification.evaluation.mismatches.slice(0, 8),
    summary: currentCaseVerification.evaluation.summary,
    currentCaseVerification: currentCaseVerification.evaluation,
  })
}

export async function finishAfterAcceptPrimitive(
  context: CaseRuntimeContext,
): Promise<"finish_run" | null> {
  if (!context.attemptSummary.acceptancePassed) return null
  context.stopReason = "case passed after accepted maintenance"
  return "finish_run"
}

export async function rejectIfMaintenanceFailedPrimitive(
  context: CaseRuntimeContext,
): Promise<Exclude<MethodStrategyDecision, "continue"> | null> {
  if (context.maintenance.maintainTask?.result.exitCode === 0) return null
  if (context.maintenance.workspaceBeforeMaintenance) {
    await restoreExperienceWorkspace(context.workspace, context.maintenance.workspaceBeforeMaintenance)
    context.workspace = await resolveExperienceWorkspaceLayout(context.workspacePaths)
    await writeExperienceWorkspaceSnapshot(
      path.join(context.acceptanceDir, "experience_workspace.after_acceptance_rollback"),
      await readExperienceWorkspace(context.workspace),
    )
  }
  const rejectionReasons = [
    `Knowledge maintainer exited with code ${context.maintenance.maintainTask?.result.exitCode ?? "unknown"}.`,
  ]
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
    roundSummary.acceptanceReason = "maintenance_failed"
    roundSummary.acceptanceRejectionReasons = rejectionReasons
  }
  context.stopReason = "knowledge maintainer failed"
  await recordTransaction(context, {
    stage: "maintenance_failed",
    decision: "rollback",
    status: "rejected",
    reason: rejectionReasons[0],
    reasons: rejectionReasons,
    summary: "Maintainer failed before the transaction could be accepted.",
    controlDecision: "finish_run",
  })
  return "finish_run"
}

export async function rejectIfNoExperienceChangePrimitive(
  context: CaseRuntimeContext,
): Promise<Exclude<MethodStrategyDecision, "continue"> | null> {
  if (context.maintenance.workspaceChanged) return null
  const rejectionReasons = ["Knowledge maintainer produced no experience workspace update."]
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
    roundSummary.acceptanceReason = "no_experience_change"
    roundSummary.acceptanceRejectionReasons = rejectionReasons
  }
  context.stopReason = "knowledge maintainer produced no experience workspace update"
  await recordTransaction(context, {
    stage: "no_experience_change",
    decision: "rollback",
    status: "rejected",
    reason: rejectionReasons[0],
    reasons: rejectionReasons,
    summary: "Maintainer changed nothing, so the transaction cannot be accepted.",
    controlDecision: "next_attempt",
  })
  return "next_attempt"
}

export async function rejectIfOutOfPolicyFilesPrimitive(
  context: CaseRuntimeContext,
): Promise<Exclude<MethodStrategyDecision, "continue"> | null> {
  if (
    !context.feedback.routing ||
    !context.maintenance.workspaceChangedFiles ||
    !context.maintenance.workspaceBeforeMaintenance
  ) {
    throw new Error("rejectIfOutOfPolicyFiles requires maintenance results and routing.")
  }

  const layoutValidation = validateExperienceWorkspaceLayout(context.workspace)
  if (layoutValidation.valid) return null

  await restoreExperienceWorkspace(context.workspace, context.maintenance.workspaceBeforeMaintenance)
  context.workspace = await resolveExperienceWorkspaceLayout(context.workspacePaths)
  await writeExperienceWorkspaceSnapshot(
    path.join(context.acceptanceDir, "experience_workspace.after_acceptance_rollback"),
    await readExperienceWorkspace(context.workspace),
  )
  context.attemptSummary.acceptancePassed = false
  context.attemptSummary.acceptanceRejected = true
  context.attemptSummary.acceptanceRejectionReasons = layoutValidation.errors
  const roundSummary =
    context.currentMaintenanceRound !== undefined
      ? context.attemptSummary.maintenanceRounds?.find((item) => item.round === context.currentMaintenanceRound)
      : undefined
  if (roundSummary) {
    roundSummary.acceptancePassed = false
    roundSummary.acceptanceRejected = true
    roundSummary.acceptanceReason = "invalid_workspace_layout"
    roundSummary.acceptanceRejectionReasons = layoutValidation.errors
  }
  await writeJsonFile(path.join(context.acceptanceDir, "acceptance.json"), {
    accepted: false,
    reason: "invalid_workspace_layout",
    routing: context.feedback.routing,
    changedFiles: context.maintenance.workspaceChangedFiles,
    workspaceValidationErrors: layoutValidation.errors,
    workspaceAssets: context.workspace.assets.map((item) => ({
      relativePath: item.relativePath,
      kind: item.kind,
    })),
    runtimeSidecarFiles: context.workspace.runtimeSidecarFiles,
    unsupportedFiles: context.workspace.unsupportedFiles,
  })
  await recordTransaction(context, {
    stage: "out_of_policy_files",
    decision: "rollback",
    status: "rejected",
    reason: layoutValidation.errors[0] ?? "Workspace layout violated the policy.",
    reasons: layoutValidation.errors,
    summary: "Maintenance output violated the experience workspace policy.",
    changedFiles: context.maintenance.workspaceChangedFiles,
    workspaceValidationErrors: layoutValidation.errors,
    controlDecision: "next_attempt",
  })
  return "next_attempt"
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
    await recordTransaction(context, {
      stage: "post_judge",
      decision: "accept",
      status: "accepted",
      reason: "Post-judge accepted the maintenance transaction.",
      reasons: [],
      summary: "Post-judge accepted the transaction and kept the modified workspace.",
      changedFiles: context.maintenance.workspaceChangedFiles ?? [],
      currentCaseVerification: context.acceptance.currentCaseVerification.evaluation,
      regressionBefore: context.acceptance.baselineRegression ?? null,
      regressionAfter: context.acceptance.afterRegression ?? null,
      postJudge: context.postJudge.summary,
      acceptance: { accepted: true, reason: "accepted" },
    })
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
  await recordTransaction(context, {
    stage: "post_judge",
    decision: "retry",
    status: "rejected",
    reason: rejectionReasons[0],
    reasons: rejectionReasons,
    summary: "Post-judge rejected the maintenance transaction.",
    controlDecision: "next_attempt",
    changedFiles: context.maintenance.workspaceChangedFiles ?? [],
    currentCaseVerification: context.acceptance.currentCaseVerification.evaluation,
    regressionBefore: context.acceptance.baselineRegression ?? null,
    regressionAfter: context.acceptance.afterRegression ?? null,
    postJudge: context.postJudge.summary,
    acceptance: { accepted: false, reason: "post_judge_retry" },
  })
  return "next_attempt"
}
