import type { CaseSpec, LoadedCase } from "../schema"
import type {
  ExperienceWorkspaceLayout,
  ExperienceWorkspaceRole,
  ExperienceWorkspaceSnapshot,
  TemplateLibraryPaths,
} from "../experience-workspace"

export interface KnowledgeMaintainerIntent {
  methodID: string
  attempt: number
  maintenanceRound?: number
  contractBlock: string
  methodExtensionBlock: string
  reversePropagationModuleID: string
  loadingStrategyID?: string
  scopeLevelID?: string
  operationIDs?: string[]
  preferredFiles: string[]
  suggestedRoles: ExperienceWorkspaceRole[]
  allowNewMarkdownFiles: boolean
  classification?: string
  reasons?: string[]
  sessionReports: KnowledgeMaintainerSessionReportRef[]
}

export interface KnowledgeMaintainerInputPaths {
  runDir: string
  baselinePath: string
  scriptsDir: string
  expectedPath: string
  actualPath: string
  evaluationPath: string
  actionTracePath: string
  judgeSummaryPath?: string
  judgeReportPath?: string
}

export interface KnowledgeMaintainerSessionReportRef {
  label: string
  absolutePath: string
  relativePath: string
  learningLogAbsolutePath?: string
  learningLogRelativePath?: string
  taskManifestAbsolutePath?: string
  taskManifestRelativePath?: string
  phase: string
  caseID?: string
  attempt?: number
  sessionID?: string
}

export interface KnowledgeMaintainerPlan {
  contractBlock: string
  methodExtensionBlock: string
  reversePropagationModuleID: string
  maintenanceRound?: number
  loadingStrategyID?: string
  scopeLevelID?: string
  operationIDs?: string[]
  sessionReports: KnowledgeMaintainerSessionReportRef[]
}

export interface KnowledgeMaintainerRequest {
  cwd: string
  config: import("../case-runtime").LoadedAutoEvolveConfig
  methodID: string
  loadedCase: LoadedCase
  workspace: ExperienceWorkspaceLayout
  workspaceSnapshot: ExperienceWorkspaceSnapshot
  templateLibrary: TemplateLibraryPaths
  inputPaths: KnowledgeMaintainerInputPaths
  intent: KnowledgeMaintainerIntent
}

export interface KnowledgeMaintainerResult {
  prompt: string
  task: import("../opencode").OpencodeTaskRun
  beforeSnapshot: ExperienceWorkspaceSnapshot
  afterSnapshot: ExperienceWorkspaceSnapshot
  changed: boolean
  changedFiles: string[]
  summary: {
    caseID: string
    attempt: number
    maintenanceRound?: number
    preferredFiles: string[]
    suggestedRoles: ExperienceWorkspaceRole[]
    allowNewMarkdownFiles: boolean
    reversePropagationModuleID: string
    loadingStrategyID: string
    scopeLevelID: string
    operationIDs: string[]
    classification?: string
    sessionReports: KnowledgeMaintainerSessionReportRef[]
  }
}

export interface KnowledgeMaintainerPromptInput {
  methodID: string
  runDir: string
  workspace: ExperienceWorkspaceLayout
  templateLibrary: TemplateLibraryPaths
  baselinePath: string
  scriptsDir: string
  caseSpec: CaseSpec
  caseDir: string
  expectedPath: string
  actualPath: string
  evaluationPath: string
  actionTracePath: string
  judgeBlock: string
  attempt: number
  methodContractBlock: string
  methodExtensionBlock: string
  reversePropagationModuleBlock: string
  loadingStrategyBlock: string
  maintenanceScopeBlock: string
  maintenanceOpsBlock: string
  sessionReports: KnowledgeMaintainerSessionReportRef[]
}
