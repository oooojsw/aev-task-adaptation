import path from "node:path"
import { diffExperienceWorkspace, readExperienceWorkspace } from "./experience-workspace"
import { buildBatchKnowledgeMaintainerPrompt } from "./prompts"
import { runOpencodeTask } from "./opencode"
import { resolveModelSelection } from "./model-selection"
import type { LoadedAutoEvolveConfig } from "./case-runtime"
import type { ExperienceWorkspaceLayout, ExperienceWorkspaceSnapshot, TemplateLibraryPaths } from "./experience-workspace"
import type { KnowledgeMaintainerSessionReportRef } from "./knowledge-maintainer/contract"
import { resolveKnowledgeMaintenanceOps } from "./knowledge-maintainer/maintenance-ops"
import { resolveKnowledgeMaintainerLoadingStrategy } from "./knowledge-maintainer/loading-strategies"
import { resolveKnowledgeMaintainerScopeLevel } from "./knowledge-maintainer/scope-levels"
import { resolveReversePropagationModule } from "./knowledge-maintainer/reverse-propagation-modules"
import { readMethodPrompt } from "./methods"
import { methodPaths } from "./methods"
import type { BatchLearningPacket } from "./batch-packetization"

export interface BatchKnowledgeMaintainerRequest {
  cwd: string
  config: LoadedAutoEvolveConfig
  methodID: string
  maintenanceMethodID: string
  reversePropagationModuleID: string
  workspace: ExperienceWorkspaceLayout
  workspaceSnapshot: ExperienceWorkspaceSnapshot
  templateLibrary: TemplateLibraryPaths
  baselinePath: string
  scriptsDir: string
  batchIndex: number
  packet: BatchLearningPacket
  packetPath: string
  packetSummaryPath: string
  sessionReports: KnowledgeMaintainerSessionReportRef[]
  loadingStrategyID?: string
  scopeLevelID?: string
  operationIDs?: string[]
}

export interface BatchKnowledgeMaintainerResult {
  prompt: string
  task: import("./opencode").OpencodeTaskRun
  beforeSnapshot: ExperienceWorkspaceSnapshot
  afterSnapshot: ExperienceWorkspaceSnapshot
  changed: boolean
  changedFiles: string[]
  summary: {
    batchIndex: number
    maintenanceMethodID: string
    reversePropagationModuleID: string
    loadingStrategyID: string
    scopeLevelID: string
    operationIDs: string[]
    packetPath: string
    packetSummaryPath: string
    sessionReports: KnowledgeMaintainerSessionReportRef[]
  }
}

function bulletList(items: string[]) {
  return items.map((item) => `- ${item}`).join("\n")
}

function renderReversePropagationModuleBlock(module: Awaited<ReturnType<typeof resolveReversePropagationModule>>) {
  return [
    `Module id: ${module.descriptor.id}`,
    `Title: ${module.descriptor.title}`,
    `Summary: ${module.descriptor.summary}`,
    "",
    module.promptBody.trim(),
  ].join("\n")
}

function renderLoadingStrategyBlock(scope: ReturnType<typeof resolveKnowledgeMaintainerLoadingStrategy>) {
  return [
    `Strategy id: ${scope.descriptor.id}`,
    `Title: ${scope.descriptor.title}`,
    `Summary: ${scope.descriptor.summary}`,
    "Guidance:",
    bulletList(scope.descriptor.guidance),
  ].join("\n")
}

function renderMaintenanceScopeBlock(scopeLevel: ReturnType<typeof resolveKnowledgeMaintainerScopeLevel>) {
  return [
    `Scope id: ${scopeLevel.id}`,
    `Title: ${scopeLevel.title}`,
    `Summary: ${scopeLevel.summary}`,
    "Guidance:",
    bulletList(scopeLevel.guidance),
  ].join("\n")
}

function renderMaintenanceOpsBlock(
  ops: Awaited<ReturnType<typeof resolveKnowledgeMaintenanceOps>>,
) {
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

export async function runBatchKnowledgeMaintainer(
  request: BatchKnowledgeMaintainerRequest,
): Promise<BatchKnowledgeMaintainerResult> {
  const beforeSnapshot = request.workspaceSnapshot
  const execution = resolveModelSelection(request.config, "refine")
  const paths = methodPaths(request.cwd, request.config, request.methodID)
  const reversePropagationModule = await resolveReversePropagationModule(
    request.cwd,
    request.config,
    request.reversePropagationModuleID,
  )
  const loadingStrategy = resolveKnowledgeMaintainerLoadingStrategy(
    request.loadingStrategyID ?? reversePropagationModule.descriptor.defaultLoadingStrategyID,
  )
  const scopeLevel = resolveKnowledgeMaintainerScopeLevel(
    request.scopeLevelID ?? reversePropagationModule.descriptor.defaultScopeLevelID,
  )
  const maintenanceOps = await resolveKnowledgeMaintenanceOps(
    request.cwd,
    request.config,
    request.operationIDs ?? reversePropagationModule.descriptor.defaultOperationIDs,
  )
  const methodExtensionTemplate = await readMethodPrompt(paths, "batch_maintain_extension")
  const methodContractBlock = [
    `Batch maintenance contract for ${request.methodID}:`,
    "- This run is maintaining one coherent canonical experience workspace from a batch learning packet.",
    "- Preserve useful existing expert memory and avoid per-case clutter.",
    "- Prefer one durable batch-level update over many repetitive one-case notes.",
  ].join("\n")

  const materialAndExpectedPaths = request.packet.shardCases.flatMap((item) => [
    item.casePath,
    ...item.materialPaths,
    item.expectedPath,
    item.evaluationPath ?? "",
    item.actualOutputPath ?? "",
    item.actionTracePath ?? "",
    item.routingPath ?? "",
    item.judgeSummaryPath ?? "",
    item.judgeReportPath ?? "",
  ])

  const referencePaths = [
    request.workspace.root,
    request.workspace.entryPath,
    ...Object.keys(request.workspaceSnapshot).map((relative) =>
      path.join(request.workspace.root, ...relative.split("/")),
    ),
    request.templateLibrary.root,
    ...request.templateLibrary.files,
    request.baselinePath,
    request.scriptsDir,
    request.packetPath,
    request.packetSummaryPath,
    ...materialAndExpectedPaths,
    ...request.sessionReports.map((item) => item.absolutePath),
    ...request.sessionReports.flatMap((item) => [
      item.learningLogAbsolutePath ?? "",
      item.taskManifestAbsolutePath ?? "",
    ]),
  ].filter(Boolean)

  const prompt = await buildBatchKnowledgeMaintainerPrompt({
    cwd: request.cwd,
    config: request.config,
    methodID: request.methodID,
    runDir: path.dirname(request.packetPath),
    workspace: request.workspace,
    templateLibrary: request.templateLibrary,
    baselinePath: request.baselinePath,
    scriptsDir: request.scriptsDir,
    batchIndex: request.batchIndex,
    packetPath: request.packetPath,
    packetSummaryPath: request.packetSummaryPath,
    methodContractBlock,
    methodExtensionBlock: methodExtensionTemplate,
    reversePropagationModuleBlock: renderReversePropagationModuleBlock(reversePropagationModule),
    loadingStrategyBlock: renderLoadingStrategyBlock(loadingStrategy),
    maintenanceScopeBlock: renderMaintenanceScopeBlock(scopeLevel),
    maintenanceOpsBlock: renderMaintenanceOpsBlock(maintenanceOps),
    sessionReports: request.sessionReports,
  })

  const task = await runOpencodeTask({
    cwd: request.cwd,
    config: request.config,
    title: `auto-evolve batch maintainer batch-${String(request.batchIndex).padStart(2, "0")}`,
    prompt,
    referencePaths,
    permissionReadPaths: referencePaths,
    permissionEditPaths: [request.workspace.root],
    model: execution.model,
    agent: execution.agent,
    variant: execution.variant,
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
      batchIndex: request.batchIndex,
      maintenanceMethodID: request.maintenanceMethodID,
      reversePropagationModuleID: reversePropagationModule.descriptor.id,
      loadingStrategyID: loadingStrategy.descriptor.id,
      scopeLevelID: scopeLevel.id,
      operationIDs: maintenanceOps.map((item) => item.id),
      packetPath: request.packetPath,
      packetSummaryPath: request.packetSummaryPath,
      sessionReports: request.sessionReports,
    },
  }
}
