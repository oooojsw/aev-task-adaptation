import { diffExperienceWorkspace, readExperienceWorkspace } from "../experience-workspace"
import { resolveModelSelection } from "../model-selection"
import { runOpencodeTask } from "../opencode"
import { buildKnowledgeMaintainerPrompt } from "../prompts"
import type { KnowledgeMaintainerRequest, KnowledgeMaintainerResult } from "./contract"
import { resolveKnowledgeMaintainerSystem } from "./system"
import { cleanupRuntimeProcessScope } from "../runtime-process-registry"

export async function runKnowledgeMaintainer(request: KnowledgeMaintainerRequest): Promise<KnowledgeMaintainerResult> {
  const runtimeScope = `maintainer:${request.loadedCase.spec.id}:attempt:${request.intent.attempt}:round:${request.intent.maintenanceRound}`
  const beforeSnapshot = request.workspaceSnapshot
  const execution = resolveModelSelection(request.config, "refine", request.loadedCase.spec.execution)
  const system = await resolveKnowledgeMaintainerSystem(request)

  const prompt = await buildKnowledgeMaintainerPrompt({
    cwd: request.cwd,
    config: request.config,
    methodID: request.methodID,
    runDir: request.inputPaths.runDir,
    caseSpec: request.loadedCase.spec,
    caseDir: request.loadedCase.caseDir,
    workspace: request.workspace,
    templateLibrary: request.templateLibrary,
    baselinePath: request.inputPaths.baselinePath,
    scriptsDir: request.inputPaths.scriptsDir,
    expectedPath: request.inputPaths.expectedPath,
    actualPath: request.inputPaths.actualPath,
    evaluationPath: request.inputPaths.evaluationPath,
    actionTracePath: request.inputPaths.actionTracePath,
    judgeBlock: [
      request.inputPaths.judgeSummaryPath ? `Judge summary path: ${request.inputPaths.judgeSummaryPath}` : "",
      request.inputPaths.judgeReportPath ? `Judge report path: ${request.inputPaths.judgeReportPath}` : "",
      request.inputPaths.judgeSummaryPath || request.inputPaths.judgeReportPath
        ? "- Read the judge outputs before maintaining the experience workspace."
        : "No judge outputs were provided for this maintenance round.",
    ]
      .filter(Boolean)
      .join("\n"),
    attempt: request.intent.attempt,
    methodContractBlock: request.intent.contractBlock,
    methodExtensionBlock: request.intent.methodExtensionBlock,
    reversePropagationModuleBlock: system.reversePropagationModuleBlock,
    loadingStrategyBlock: system.loadingStrategyBlock,
    maintenanceScopeBlock: system.maintenanceScopeBlock,
    maintenanceOpsBlock: system.maintenanceOpsBlock,
    sessionReports: request.intent.sessionReports,
  })

  try {
    const task = await runOpencodeTask({
      cwd: request.cwd,
      config: request.config,
      title: `auto-evolve knowledge maintainer ${request.loadedCase.spec.id} attempt ${request.intent.attempt}`,
      prompt,
      referencePaths: system.referencePaths,
      permissionReadPaths: system.permissionReadPaths,
      permissionEditPaths: system.permissionEditPaths,
      model: execution.model,
      agent: execution.agent,
      variant: execution.variant,
      runtimeScope,
    })

    const afterSnapshot = await readExperienceWorkspace(request.workspace)
    const changedFiles = diffExperienceWorkspace(beforeSnapshot, afterSnapshot)

    return {
      prompt,
      task,
      beforeSnapshot,
      afterSnapshot,
      changed: changedFiles.length > 0,
      changedFiles,
      summary: {
        caseID: request.loadedCase.spec.id,
        attempt: request.intent.attempt,
        maintenanceRound: request.intent.maintenanceRound,
        preferredFiles: request.intent.preferredFiles,
        suggestedRoles: request.intent.suggestedRoles,
        allowNewMarkdownFiles: request.intent.allowNewMarkdownFiles,
        reversePropagationModuleID: system.reversePropagationModule.descriptor.id,
        loadingStrategyID: system.loadingStrategy.descriptor.id,
        scopeLevelID: system.scopeLevel.id,
        operationIDs: system.maintenanceOps.map((item) => item.id),
        classification: request.intent.classification,
        sessionReports: request.intent.sessionReports,
      },
    }
  } finally {
    const cleanup = await cleanupRuntimeProcessScope(runtimeScope)
    if (cleanup.remainingCount > 0) {
      await cleanupRuntimeProcessScope(runtimeScope)
    }
  }
}
