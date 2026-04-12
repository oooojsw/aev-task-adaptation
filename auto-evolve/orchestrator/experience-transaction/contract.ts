export type ExperienceTransactionStatus = "observed" | "accepted" | "rejected"

export type ExperienceTransactionDecision = "observe" | "accept" | "retry" | "rollback"

export interface ExperienceTransactionRecord {
  id: string
  createdAt: string
  updatedAt: string
  status: ExperienceTransactionStatus
  decision: ExperienceTransactionDecision
  stage: string
  sourceRunID: string
  caseID: string
  attempt: number
  maintenanceRound?: number
  summary: string
  reason: string
  reasons: string[]
  controlDecision?: "next_attempt" | "finish_run" | null
  changedFiles?: string[]
  workspaceValidationErrors?: string[]
  currentCaseVerification?: Record<string, unknown> | null
  regressionBefore?: Record<string, unknown> | null
  regressionAfter?: Record<string, unknown> | null
  postJudge?: Record<string, unknown> | null
  acceptance?: Record<string, unknown> | null
  notes: string[]
}
