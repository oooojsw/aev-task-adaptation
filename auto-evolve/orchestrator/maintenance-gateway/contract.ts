import type { ExperienceWorkspaceRole } from "../experience-workspace"

export type MaintenanceRequestStatus = "hold" | "ready_for_maintainer" | "applied" | "rejected"

export type MaintenanceRequestMode = "short" | "long" | "batch"

export type MaintenanceEvidenceKind =
  | "execution_report"
  | "failure_packet"
  | "retry_lesson"
  | "learning_unit"
  | "scratch_memory"
  | "shadow_memory"
  | "judge_summary"
  | "judge_report"
  | "evaluation"
  | "action_trace"
  | "actual_output"
  | "candidate_summary"
  | "progress_state"
  | "work_graph"
  | "task_spec"
  | "task_manifest"

export interface MaintenanceEvidenceRef {
  kind: MaintenanceEvidenceKind
  path: string
  label?: string
  required?: boolean
}

export interface MaintenanceRoutingHint {
  classification?: string
  preferredFiles: string[]
  suggestedRoles: ExperienceWorkspaceRole[]
  allowNewMarkdownFiles: boolean
  reasons: string[]
}

export interface MaintenanceSessionReportRef {
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

export interface MaintenanceRequest {
  id: string
  createdAt: string
  updatedAt: string
  status: MaintenanceRequestStatus
  mode: MaintenanceRequestMode
  sourceRunID: string
  caseID?: string
  attempt?: number
  maintenanceRound?: number
  title: string
  goal: string
  taskFamily?: string
  domainTags: string[]
  summary: string
  runtimeRoot: string
  workspaceRoot?: string
  templateLibraryRoot?: string
  recipeID?: string
  maintenanceModuleID?: string
  acceptancePolicyID?: string
  loadingStrategyID?: string
  scopeLevelID?: string
  operationIDs: string[]
  routing?: MaintenanceRoutingHint
  sessionReports: MaintenanceSessionReportRef[]
  evidence: MaintenanceEvidenceRef[]
  notes: string[]
}
