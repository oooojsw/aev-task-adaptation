import type { LongTaskBudgets, LongTaskRunStatus } from "../long-task/contract"

export type LongTaskCampaignMode = "graph_iterative" | "single_session_iterative"

export type LongTaskCampaignStatus =
  | "running"
  | "verified_success"
  | "round_limit_reached"
  | "failed"

export interface LongTaskCampaignSeedTarget {
  targetPath: string
  seedPath: string
  kind?: "experience_workspace" | "path_copy"
  resetOnStart?: boolean
}

export interface LongTaskCampaignLessonsMirror {
  workspaceTargetPath: string
  relativePath: string
  addManifestPointer?: boolean
}

export interface LongTaskCampaignCarryoverConfig {
  includeFailurePackets: boolean
  includeRetryLessons: boolean
  includeLearningUnits: boolean
  includeRoundSummaries: boolean
  recentRoundSummaryCount: number
}

export interface LongTaskCampaignSpec {
  title: string
  baseSpecPath: string
  taskFamily?: string
  mode: LongTaskCampaignMode
  maxRounds: number
  seedTargets: LongTaskCampaignSeedTarget[]
  lessonsMirror?: LongTaskCampaignLessonsMirror
  carryover?: Partial<LongTaskCampaignCarryoverConfig>
  roundBudgetOverrides?: Partial<LongTaskBudgets>
  notes?: string
}

export interface LongTaskCampaignRoundRecord {
  roundNumber: number
  roundID: string
  roundSpecPath: string
  sourceRunID: string
  sourceRunDir: string
  finalStatus: LongTaskRunStatus
  summary: string
  failurePacketCount: number
  retryLessonCount: number
  learningUnitCount: number
  roundSummaryPath: string
  snapshotPaths: Array<{
    targetPath: string
    snapshotPath: string
    kind: "experience_workspace" | "path_copy"
  }>
  createdAt: string
}

export interface LongTaskCampaignState {
  id: string
  title: string
  taskFamily?: string
  mode: LongTaskCampaignMode
  baseSpecPath: string
  maxRounds: number
  currentRound: number
  status: LongTaskCampaignStatus
  createdAt: string
  updatedAt: string
  notes?: string
  lastRunID?: string
  lastSummary?: string
  lastRoundSummaryPath?: string
}

export const DEFAULT_LONG_TASK_CAMPAIGN_CARRYOVER: LongTaskCampaignCarryoverConfig = {
  includeFailurePackets: true,
  includeRetryLessons: true,
  includeLearningUnits: true,
  includeRoundSummaries: true,
  recentRoundSummaryCount: 6,
}
