import path from "node:path"
import type { LoadedAutoEvolveConfig } from "../case-runtime"
import { recordAcceptanceResult } from "../acceptance-framework/run"
import { experienceTransactionPaths, writeExperienceTransactionRecord } from "./repository"

function pad(value: number) {
  return String(value).padStart(2, "0")
}

export async function writeBatchTransactionRecord(input: {
  cwd: string
  config: LoadedAutoEvolveConfig
  roundRunID: string
  batchIndex: number
  maintenanceRound: number
  acceptanceDir: string
  stage: string
  decision: "observe" | "accept" | "retry" | "rollback"
  status: "observed" | "accepted" | "rejected"
  reason: string
  reasons: string[]
  summary: string
  controlDecision?: "next_attempt" | "finish_run" | null
  changedFiles?: string[]
  workspaceValidationErrors?: string[]
  regressionBefore?: Record<string, unknown> | null
  regressionAfter?: Record<string, unknown> | null
  postJudge?: Record<string, unknown> | null
  acceptance?: Record<string, unknown> | null
  acceptancePolicyID: string
  acceptanceStageID: string
  acceptancePassed?: boolean
  acceptanceOutcome: "observe" | "accept" | "retry" | "rollback" | "hold" | "promote" | "archive_only"
  acceptanceEvidenceRefs?: string[]
  acceptanceNotes?: string[]
}) {
  const transactionResult = await writeExperienceTransactionRecord(experienceTransactionPaths(input.cwd, input.config), {
    id: `txn-${input.roundRunID}-batch-${pad(input.batchIndex)}-round-${pad(input.maintenanceRound)}-${input.stage}`,
    status: input.status,
    decision: input.decision,
    stage: input.stage,
    sourceRunID: input.roundRunID,
    caseID: `batch-${pad(input.batchIndex)}`,
    attempt: input.maintenanceRound,
    maintenanceRound: input.maintenanceRound,
    summary: input.summary,
    reason: input.reason,
    reasons: input.reasons,
    controlDecision: input.controlDecision ?? null,
    changedFiles: input.changedFiles,
    workspaceValidationErrors: input.workspaceValidationErrors,
    regressionBefore: input.regressionBefore ?? null,
    regressionAfter: input.regressionAfter ?? null,
    postJudge: input.postJudge ?? null,
    acceptance: input.acceptance ?? null,
    notes: [
      "Batch maintenance transaction gate audit record.",
      "This record captures accept-or-rollback evidence after a canonical batch maintenance attempt.",
    ],
    mirrorPath: path.join(input.acceptanceDir, "transaction.json"),
  })

  const acceptanceResult = await recordAcceptanceResult({
    cwd: input.cwd,
    config: input.config,
    sourceRunID: input.roundRunID,
    mode: "batch",
    policyID: input.acceptancePolicyID,
    stageID: input.acceptanceStageID,
    targetKind: "maintenance_transaction",
    targetID: `batch-${pad(input.batchIndex)}:round-${pad(input.maintenanceRound)}`,
    passed: input.acceptancePassed,
    outcome: input.acceptanceOutcome,
    summary: input.summary,
    reason: input.reason,
    reasons: input.reasons,
    evidenceRefs: input.acceptanceEvidenceRefs ?? [],
    details: {
      changedFiles: input.changedFiles ?? [],
      workspaceValidationErrors: input.workspaceValidationErrors ?? [],
      regressionBefore: input.regressionBefore ?? null,
      regressionAfter: input.regressionAfter ?? null,
      postJudge: input.postJudge ?? null,
      acceptance: input.acceptance ?? null,
    },
    notes: input.acceptanceNotes ?? [],
    mirrorPath: path.join(input.acceptanceDir, "framework", `${input.stage}.json`),
  })

  return {
    ...transactionResult,
    acceptancePath: acceptanceResult.path,
  }
}
