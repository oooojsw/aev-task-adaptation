import type { KnowledgeMaintainerRequest } from "./contract"
import { listKnowledgeMaintenanceOps, resolveKnowledgeMaintenanceOps } from "./maintenance-ops"
import {
  resolveKnowledgeMaintainerLoadingStrategy,
  type KnowledgeMaintainerLoadingStrategy,
} from "./loading-strategies"
import { resolveKnowledgeMaintainerScopeLevel, type KnowledgeMaintainerScopeLevel } from "./scope-levels"
import {
  resolveReversePropagationModule,
  type ResolvedReversePropagationModule,
} from "./reverse-propagation-modules"
import type { KnowledgeMaintenanceOpDefinition } from "./maintenance-ops"
import { buildAccessProfile } from "../access-profile"

export interface ResolvedKnowledgeMaintainerSystem {
  reversePropagationModule: ResolvedReversePropagationModule
  loadingStrategy: KnowledgeMaintainerLoadingStrategy
  scopeLevel: KnowledgeMaintainerScopeLevel
  maintenanceOps: KnowledgeMaintenanceOpDefinition[]
  reversePropagationModuleBlock: string
  loadingStrategyBlock: string
  maintenanceScopeBlock: string
  maintenanceOpsBlock: string
  referencePaths: string[]
  permissionReadPaths: string[]
  permissionEditPaths: string[]
}

function bulletList(items: string[]) {
  return items.map((item) => `- ${item}`).join("\n")
}

function renderReversePropagationModuleBlock(module: ResolvedReversePropagationModule) {
  return [
    `Module id: ${module.descriptor.id}`,
    `Title: ${module.descriptor.title}`,
    `Summary: ${module.descriptor.summary}`,
    "",
    module.promptBody.trim(),
  ].join("\n")
}

function renderLoadingStrategyBlock(scope: KnowledgeMaintainerLoadingStrategy) {
  return [
    `Strategy id: ${scope.descriptor.id}`,
    `Title: ${scope.descriptor.title}`,
    `Summary: ${scope.descriptor.summary}`,
    "Guidance:",
    bulletList(scope.descriptor.guidance),
  ].join("\n")
}

function renderMaintenanceScopeBlock(scopeLevel: KnowledgeMaintainerScopeLevel) {
  return [
    `Scope id: ${scopeLevel.id}`,
    `Title: ${scopeLevel.title}`,
    `Summary: ${scopeLevel.summary}`,
    "Guidance:",
    bulletList(scopeLevel.guidance),
  ].join("\n")
}

function renderMaintenanceOpsBlock(ops: KnowledgeMaintenanceOpDefinition[]) {
  return ops
    .map((op, index) => {
      const lines = [`${index + 1}. ${op.id}`, `   - ${op.summary}`]
      if (op.notes?.length) {
        for (const note of op.notes) {
          lines.push(`   - ${note}`)
        }
      }
      return lines.join("\n")
    })
    .join("\n")
}

export async function resolveKnowledgeMaintainerSystem(
  request: KnowledgeMaintainerRequest,
): Promise<ResolvedKnowledgeMaintainerSystem> {
  const reversePropagationModule = await resolveReversePropagationModule(
    request.cwd,
    request.config,
    request.intent.reversePropagationModuleID,
  )
  const loadingStrategy = resolveKnowledgeMaintainerLoadingStrategy(
    request.intent.loadingStrategyID ?? reversePropagationModule.descriptor.defaultLoadingStrategyID,
  )
  const scopeLevel = resolveKnowledgeMaintainerScopeLevel(
    request.intent.scopeLevelID ?? reversePropagationModule.descriptor.defaultScopeLevelID,
  )
  const maintenanceOps = await resolveKnowledgeMaintenanceOps(
    request.cwd,
    request.config,
    request.intent.operationIDs ?? reversePropagationModule.descriptor.defaultOperationIDs,
  )
  const pathPlan = loadingStrategy.collectPaths({
    workspace: request.workspace,
    workspaceSnapshot: request.workspaceSnapshot,
    templateLibrary: request.templateLibrary,
    loadedCase: request.loadedCase,
    inputPaths: request.inputPaths,
    sessionReports: request.intent.sessionReports,
  })
  const access = await buildAccessProfile({
    role: "knowledge_maintainer",
    mode: "maintenance",
    referencePaths: pathPlan.referencePaths,
    readPaths: pathPlan.permissionReadPaths,
    editPaths: [request.workspace.root],
  })

  return {
    reversePropagationModule,
    loadingStrategy,
    scopeLevel,
    maintenanceOps,
    reversePropagationModuleBlock: renderReversePropagationModuleBlock(reversePropagationModule),
    loadingStrategyBlock: renderLoadingStrategyBlock(loadingStrategy),
    maintenanceScopeBlock: renderMaintenanceScopeBlock(scopeLevel),
    maintenanceOpsBlock: renderMaintenanceOpsBlock(maintenanceOps),
    referencePaths: access.referencePaths,
    permissionReadPaths: access.permissionReadPaths,
    permissionEditPaths: access.permissionEditPaths,
  }
}

export { listKnowledgeMaintenanceOps, resolveKnowledgeMaintenanceOps }
