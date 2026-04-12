import path from "node:path"
import { buildKnowledgeMaintainerContractBlock } from "./feedback-packet"
import {
  readExperienceWorkspace,
  restoreExperienceWorkspace,
  resolveExperienceWorkspaceLayout,
  validateExperienceWorkspaceLayout,
  writeExperienceWorkspaceSnapshot,
} from "../experience-workspace"
import type { KnowledgeMaintainerPlan } from "../knowledge-maintainer/contract"
import { runKnowledgeMaintainer } from "../knowledge-maintainer/run"
import { writeJsonFile } from "../fs"
import { maintenanceGatewayPaths, writeMaintenanceRequest } from "../maintenance-gateway/repository"
import { appendShortTaskRetryLessons, buildShortTaskMaintenanceRequest } from "../maintenance-gateway/short-task"
import { writeTaskArtifacts } from "../task-artifacts"
import type { CaseRuntimeContext } from "../case-runtime"
import type { MethodStrategyDecision } from "../method-strategies"

export async function invokeKnowledgeMaintainerPrimitive(
  context: CaseRuntimeContext,
  input: KnowledgeMaintainerPlan,
) {
  if (
    !context.feedback.routing ||
    !context.feedback.actualOutputPath ||
    !context.feedback.evaluationPath ||
    !context.feedback.actionTracePath
  ) {
    throw new Error("invokeKnowledgeMaintainer requires prepared feedback artifacts.")
  }

  await appendShortTaskRetryLessons(context)
  const maintenanceRequest = buildShortTaskMaintenanceRequest(context, input)
  const gatewayWrite = await writeMaintenanceRequest(maintenanceGatewayPaths(context.cwd, context.config), {
    ...maintenanceRequest,
    mirrorPath: path.join(context.maintainDir, "maintenance_request.json"),
  })
  context.attemptSummary.maintenanceRequestPath = gatewayWrite.path
  const currentRoundSummary =
    context.currentMaintenanceRound !== undefined
      ? context.attemptSummary.maintenanceRounds?.find((item) => item.round === context.currentMaintenanceRound)
      : undefined
  if (currentRoundSummary) {
    currentRoundSummary.maintenanceRequestPath = gatewayWrite.path
  }

  const result = await runKnowledgeMaintainer({
    cwd: context.cwd,
    config: context.config,
    methodID: context.methodID,
    loadedCase: context.loaded,
    workspace: context.workspace,
    workspaceSnapshot: await readExperienceWorkspace(context.workspace),
    templateLibrary: context.templateLibrary,
    inputPaths: {
      runDir: context.runDir,
      baselinePath: context.baselinePath,
      scriptsDir: context.scriptsDir,
      expectedPath: context.expectedPath,
      actualPath: context.feedback.actualOutputPath,
      evaluationPath: context.feedback.evaluationPath,
      actionTracePath: context.feedback.actionTracePath,
      judgeSummaryPath: context.judge.judgeSummaryPath,
      judgeReportPath: context.judge.judgeReportPath,
    },
    intent: {
      methodID: context.methodID,
      attempt: context.attempt,
      maintenanceRound: input.maintenanceRound,
      contractBlock: buildKnowledgeMaintainerContractBlock(context, input.contractBlock),
      methodExtensionBlock: input.methodExtensionBlock,
      reversePropagationModuleID: maintenanceRequest.maintenanceModuleID ?? input.reversePropagationModuleID,
      loadingStrategyID: maintenanceRequest.loadingStrategyID ?? input.loadingStrategyID,
      scopeLevelID: maintenanceRequest.scopeLevelID ?? input.scopeLevelID,
      operationIDs: maintenanceRequest.operationIDs,
      preferredFiles: maintenanceRequest.routing?.preferredFiles ?? context.feedback.routing.preferredFiles,
      suggestedRoles: maintenanceRequest.routing?.suggestedRoles ?? context.feedback.routing.suggestedRoles,
      allowNewMarkdownFiles:
        maintenanceRequest.routing?.allowNewMarkdownFiles ?? context.feedback.routing.allowNewMarkdownFiles,
      classification: maintenanceRequest.routing?.classification ?? context.feedback.routing.classification,
      reasons: maintenanceRequest.routing?.reasons ?? context.feedback.routing.reasons,
      sessionReports: maintenanceRequest.sessionReports,
    },
  })

  context.maintenance.workspaceBeforeMaintenance = result.beforeSnapshot
  context.maintenance.maintainTask = result.task
  context.maintenance.workspaceAfterMaintenance = result.afterSnapshot
  context.maintenance.workspaceChanged = result.changed
  context.maintenance.workspaceChangedFiles = result.changedFiles
  const currentRound = context.currentMaintenanceRound
  const roundSummary =
    currentRound !== undefined
      ? context.attemptSummary.maintenanceRounds?.find((item) => item.round === currentRound)
      : undefined

  context.attemptSummary.refineSessionID = result.task.result.sessionID
  const artifactPaths = await writeTaskArtifacts(context.maintainDir, result.task, {
    phase: "maintain",
    taskKind: "maintain",
    caseID: context.loaded.spec.id,
    attempt: context.attempt,
    maintenanceRound: context.currentMaintenanceRound,
    methodID: context.methodID,
  })
  context.attemptSummary.refineSessionExecutionReportPath = artifactPaths.sessionExecutionReportPath
  context.attemptSummary.refineExitCode = result.task.result.exitCode
  context.attemptSummary.knowledgePackChangedByRefine = result.changed
  context.attemptSummary.knowledgePackChangedFilesByRefine = result.changedFiles
  if (roundSummary) {
    roundSummary.maintainSessionID = result.task.result.sessionID
    roundSummary.maintainSessionExecutionReportPath = artifactPaths.sessionExecutionReportPath
    roundSummary.maintainExitCode = result.task.result.exitCode
    roundSummary.workspaceChanged = result.changed
    roundSummary.workspaceChangedFiles = result.changedFiles
  }

  await writeExperienceWorkspaceSnapshot(
    path.join(context.maintainDir, "experience_workspace.before_maintain"),
    result.beforeSnapshot,
  )
  await writeJsonFile(path.join(context.maintainDir, "maintain_summary.json"), {
    ...result.summary,
    changed: result.changed,
    changedFiles: result.changedFiles,
    expectedPath: context.expectedPath,
    actualOutputPath: context.feedback.actualOutputPath,
    evaluationPath: context.feedback.evaluationPath,
    actionTracePath: context.feedback.actionTracePath,
    templateLibraryRoot: context.templateLibrary.root,
    reversePropagationModuleID: result.summary.reversePropagationModuleID,
    loadingStrategyID: result.summary.loadingStrategyID,
    scopeLevelID: result.summary.scopeLevelID,
    selectedOperationIDs: result.summary.operationIDs,
    maintenanceRound: result.summary.maintenanceRound ?? null,
    selectedSessionReports: result.summary.sessionReports.map((item) => ({
      label: item.label,
      relativePath: item.relativePath,
      absolutePath: item.absolutePath,
      learningLogRelativePath: item.learningLogRelativePath ?? null,
      learningLogAbsolutePath: item.learningLogAbsolutePath ?? null,
      taskManifestRelativePath: item.taskManifestRelativePath ?? null,
      taskManifestAbsolutePath: item.taskManifestAbsolutePath ?? null,
      phase: item.phase,
      caseID: item.caseID ?? null,
      attempt: item.attempt ?? null,
      sessionID: item.sessionID ?? null,
    })),
  })
  await writeExperienceWorkspaceSnapshot(
    path.join(context.maintainDir, "experience_workspace.after_maintain"),
    result.afterSnapshot,
  )

  context.workspace = await resolveExperienceWorkspaceLayout(context.workspacePaths)
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
  return "finish_run"
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
  return "next_attempt"
}
