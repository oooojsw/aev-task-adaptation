export type AcceptanceLevel = "local" | "transaction" | "candidate" | "deployment"

export type AcceptanceTargetKind =
  | "work_unit"
  | "maintenance_transaction"
  | "candidate_experience"
  | "canonical_experience"
  | "deployment_run"

export type AcceptanceOutcome =
  | "observe"
  | "accept"
  | "retry"
  | "rollback"
  | "hold"
  | "promote"
  | "archive_only"

export type AcceptanceRecordStatus = "observed" | "passed" | "failed" | "held"

export type AcceptanceHarnessKind =
  | "maintainer_exit_check"
  | "workspace_diff_check"
  | "workspace_layout_check"
  | "verify_current_case"
  | "regression_suite"
  | "post_judge_review"
  | "long_task_validator"
  | "candidate_package_review"
  | "blank_agent_single_session_case"
  | "blank_agent_single_session_task"

export interface AcceptanceStandardDescriptor {
  id: string
  title: string
  summary: string
  level: AcceptanceLevel
  targetKinds: AcceptanceTargetKind[]
  pluginFriendly: boolean
  notes?: string[]
}

export interface AcceptanceHarnessDescriptor {
  id: string
  title: string
  summary: string
  kind: AcceptanceHarnessKind
  levels: AcceptanceLevel[]
  targetKinds: AcceptanceTargetKind[]
  pluginFriendly: boolean
  stateful: boolean
  notes?: string[]
}

export interface AcceptancePolicyStageDescriptor {
  id: string
  title: string
  summary: string
  level: AcceptanceLevel
  targetKind: AcceptanceTargetKind
  standardIDs: string[]
  harnessIDs: string[]
  successOutcome: AcceptanceOutcome
  failureOutcome: AcceptanceOutcome
  required: boolean
  notes?: string[]
}

export interface AcceptancePolicyDescriptor {
  id: string
  title: string
  summary: string
  status: "active" | "experimental" | "planned"
  pluginFriendly: boolean
  stages: AcceptancePolicyStageDescriptor[]
  notes?: string[]
}

export interface AcceptanceRecord {
  id: string
  createdAt: string
  updatedAt: string
  sourceRunID: string
  mode?: "short" | "long" | "batch" | "governance" | "deployment"
  policyID: string
  stageID: string
  level: AcceptanceLevel
  targetKind: AcceptanceTargetKind
  targetID: string
  status: AcceptanceRecordStatus
  outcome: AcceptanceOutcome
  summary: string
  reason: string
  reasons: string[]
  standardIDs: string[]
  harnessIDs: string[]
  evidenceRefs: string[]
  details?: Record<string, unknown> | null
  notes: string[]
}
