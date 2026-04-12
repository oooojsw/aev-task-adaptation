import path from "node:path"
import {
  resolveExperienceWorkspaceLayout,
  writeExperienceWorkspaceSnapshot,
} from "../experience-workspace"
import type { KnowledgeMaintainerPlan } from "../knowledge-maintainer/contract"
import { runKnowledgeMaintainer } from "../knowledge-maintainer/run"
import { writeJsonFile } from "../fs"
import { buildKnowledgeMaintainerRequest } from "../maintenance-gateway/knowledge-maintainer"
import { maintenanceGatewayPaths, writeMaintenanceRequest } from "../maintenance-gateway/repository"
import { appendShortTaskRetryLessons, buildShortTaskMaintenanceRequest } from "../maintenance-gateway/short-task"
import { writeTaskArtifacts } from "../task-artifacts"
import type { CaseRuntimeContext } from "../case-runtime"

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

  const result = await runKnowledgeMaintainer(
    await buildKnowledgeMaintainerRequest({
      context,
      plan: input,
      maintenanceRequest,
    }),
  )

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
