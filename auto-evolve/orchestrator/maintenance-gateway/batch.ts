import type { BatchLearningPacket } from "../batch-packetization"
import type { KnowledgeMaintainerSessionReportRef } from "../knowledge-maintainer/contract"
import type { MaintenanceRequest } from "./contract"

function pad(value: number) {
  return String(value).padStart(2, "0")
}

function nowISO() {
  return new Date().toISOString()
}

function short(text: string, limit = 220) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return normalized.slice(0, limit - 3) + "..."
}

export function buildBatchMaintenanceRequest(input: {
  roundRunID: string
  batchDir: string
  batchIndex: number
  maintenanceRound: number
  packet: BatchLearningPacket
  packetPath: string
  packetSummaryPath: string
  workspaceRoot: string
  templateLibraryRoot: string
  maintenanceMethodID: string
  reversePropagationModuleID: string
  acceptancePolicyID?: string
  sessionReports: KnowledgeMaintainerSessionReportRef[]
  loadingStrategyID?: string
  scopeLevelID?: string
  operationIDs?: string[]
}): MaintenanceRequest {
  const candidateCaseCount = input.packet.maintenanceCandidateCaseIDs.length
  const candidateCases = input.packet.maintenanceCandidateCaseIDs.join(", ") || "(none)"

  return {
    id: `maint-req-batch-${input.roundRunID}-batch-${pad(input.batchIndex)}-round-${pad(input.maintenanceRound)}`,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    status: candidateCaseCount > 0 ? "ready_for_maintainer" : "hold",
    mode: "batch",
    sourceRunID: input.roundRunID,
    caseID: `batch-${pad(input.batchIndex)}`,
    attempt: input.maintenanceRound,
    maintenanceRound: input.maintenanceRound,
    title: `Batch Maintenance batch-${pad(input.batchIndex)} round-${pad(input.maintenanceRound)}`,
    goal: "Synthesize one durable canonical experience update from shard evidence.",
    taskFamily: "batch_learning_round",
    domainTags: ["batch", input.packet.mode, input.packet.split],
    summary: short(
      `Batch ${input.batchIndex} round ${input.maintenanceRound} aggregates ${candidateCaseCount} maintenance candidate case(s): ${candidateCases}.`,
    ),
    runtimeRoot: input.batchDir,
    workspaceRoot: input.workspaceRoot,
    templateLibraryRoot: input.templateLibraryRoot,
    recipeID: input.maintenanceMethodID,
    maintenanceModuleID: input.reversePropagationModuleID,
    acceptancePolicyID: input.acceptancePolicyID,
    loadingStrategyID: input.loadingStrategyID,
    scopeLevelID: input.scopeLevelID,
    operationIDs: input.operationIDs ?? [],
    sessionReports: input.sessionReports,
    evidence: [
      {
        kind: "task_manifest",
        path: input.packetPath,
        label: "batch_learning_packet",
        required: true,
      },
      {
        kind: "candidate_summary",
        path: input.packetSummaryPath,
        label: "batch_learning_packet_summary",
        required: true,
      },
    ],
    notes: [
      "Batch maintenance request emitted by the maintenance gateway.",
      "This request summarizes shard evidence before any canonical experience transaction is accepted.",
    ],
  }
}
