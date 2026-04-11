import type { ExecutionStrategyID } from "../execution-strategies"
import type { PacketizationPolicyID } from "../packetization-policies"

export type OptimizationCandidateStatus = "draft" | "ready_for_propagation" | "archived"

export type OptimizationOutcomeStatus =
  | "recorded"
  | "campaign_started"
  | "campaign_completed"
  | "promoted"
  | "archived"

export interface OptimizationCandidatePackage {
  id: string
  createdAt: string
  updatedAt: string
  status: OptimizationCandidateStatus
  strategyID: string
  title: string
  summary: string
  baseCommitID: string
  workspaceSnapshotPath: string
  trackedDocumentPaths: string[]
  trackedAssetPaths: Array<{ relativePath: string; kind: string }>
  optimizerMemoryRefs: string[]
  recommendedPropagationMethodID?: string
  recommendedMaintenanceMethodID?: string
  recommendedExecutionStrategyID?: ExecutionStrategyID
  recommendedPacketizationPolicyID?: PacketizationPolicyID
  notes: string[]
}

export interface OptimizationOutcome {
  id: string
  createdAt: string
  updatedAt: string
  candidatePackageID: string
  status: OptimizationOutcomeStatus
  campaignID?: string
  candidateCommitID?: string
  notes: string[]
}

export interface OptimizerMemoryEntry {
  id: string
  createdAt: string
  title: string
  summary: string
  tags: string[]
  evidenceRefs: string[]
}

