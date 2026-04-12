import type { CaseRuntimeContext } from "../case-runtime"
import { readExperienceWorkspace } from "../experience-workspace"
import type { KnowledgeMaintainerPlan, KnowledgeMaintainerRequest } from "../knowledge-maintainer/contract"
import { buildKnowledgeMaintainerContractBlock } from "../primitive-ops/feedback-packet"
import type { MaintenanceRequest } from "./contract"

export async function buildKnowledgeMaintainerRequest(input: {
  context: CaseRuntimeContext
  plan: KnowledgeMaintainerPlan
  maintenanceRequest: MaintenanceRequest
}): Promise<KnowledgeMaintainerRequest> {
  const { context, plan, maintenanceRequest } = input

  return {
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
      actualPath: context.feedback.actualOutputPath!,
      evaluationPath: context.feedback.evaluationPath!,
      actionTracePath: context.feedback.actionTracePath!,
      judgeSummaryPath: context.judge.judgeSummaryPath,
      judgeReportPath: context.judge.judgeReportPath,
    },
    intent: {
      methodID: context.methodID,
      attempt: context.attempt,
      maintenanceRound: plan.maintenanceRound,
      contractBlock: buildKnowledgeMaintainerContractBlock(context, plan.contractBlock),
      methodExtensionBlock: plan.methodExtensionBlock,
      reversePropagationModuleID: maintenanceRequest.maintenanceModuleID ?? plan.reversePropagationModuleID,
      loadingStrategyID: maintenanceRequest.loadingStrategyID ?? plan.loadingStrategyID,
      scopeLevelID: maintenanceRequest.scopeLevelID ?? plan.scopeLevelID,
      operationIDs: maintenanceRequest.operationIDs,
      preferredFiles: maintenanceRequest.routing?.preferredFiles ?? context.feedback.routing!.preferredFiles,
      suggestedRoles: maintenanceRequest.routing?.suggestedRoles ?? context.feedback.routing!.suggestedRoles,
      allowNewMarkdownFiles:
        maintenanceRequest.routing?.allowNewMarkdownFiles ?? context.feedback.routing!.allowNewMarkdownFiles,
      classification: maintenanceRequest.routing?.classification ?? context.feedback.routing?.classification,
      reasons: maintenanceRequest.routing?.reasons ?? context.feedback.routing?.reasons,
      sessionReports: maintenanceRequest.sessionReports,
    },
  }
}
