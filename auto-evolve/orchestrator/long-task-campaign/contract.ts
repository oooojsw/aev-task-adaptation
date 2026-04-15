import type {
  LongTaskBudgets,
  LongTaskOperationalContextItem,
  LongTaskRunStatus,
} from "../long-task/contract"

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
  includeCampaignOperationalMemory: boolean
  includeCampaignSeedContext: boolean
  includeFailurePackets: boolean
  includeRetryLessons: boolean
  includeLearningUnits: boolean
  includeRoundSummaries: boolean
  recentRoundSummaryCount: number
}

export interface LongTaskCampaignOperationalMemoryRecord extends LongTaskOperationalContextItem {
  roundNumber: number
  lastRound: number
  occurrenceCount: number
  sourceRunIDs: string[]
}

export type LongTaskCampaignWorkerRole =
  | "success_synthesizer"
  | "failure_synthesizer"
  | "forbidden_path_synthesizer"
  | "exploration_tree_synthesizer"
  | "custom"

export interface LongTaskCampaignWorkerSuggestion {
  id: string
  roundNumber: number
  role: LongTaskCampaignWorkerRole
  createdAt: string
  summary: string
  findings: string[]
  packageAdvice: string[]
  explorationAdvice: string[]
  refs: string[]
  responsePath?: string
}

export interface LongTaskCampaignReviewSuggestion {
  id: string
  roundNumber: number
  createdAt: string
  readyForFinalAcceptance: boolean
  summary: string
  reasons: string[]
  nextAttentionAreas: string[]
  refs: string[]
  responsePath?: string
}

export interface LongTaskCampaignExplorationNode {
  nodeID: string
  parentID?: string
  hypothesis: string
  status:
    | "unexplored"
    | "in_progress"
    | "weak_fail"
    | "strong_fail"
    | "promising"
    | "validated_success"
    | "deprecated"
  confidence: number
  evidenceRefs: string[]
  lastUpdatedRound: number
  notes?: string[]
}

export interface LongTaskCampaignRunTraceCommandRecord {
  id: string
  tool: string
  status: "success" | "failure"
  title?: string
  command?: string
  error?: string
  outputPreview?: string
  timestamp?: number
  refs: string[]
}

export interface LongTaskCampaignRunTraceAttemptRecord {
  unitID: string
  unitTitle: string
  attempt: number
  executeDir: string
  retryInputBundlePath?: string
  responsePath?: string
  sessionExecutionReportPath?: string
  eventsPath?: string
  toolFailuresPath?: string
  claimID?: string
  claimRefs: string[]
  failurePacketID?: string
  failurePacketRefs: string[]
  exitCode?: number
  claimStatement?: string
  claimedSuccess?: boolean
  failureSummary?: string
  scratchUnits: Array<{
    id: string
    kind: string
    statement: string
    refs: string[]
  }>
  learningUnits: Array<{
    id: string
    kind: string
    scope: string
    strength: number
    statement: string
    refs: string[]
  }>
  retryLessons: Array<{
    id: string
    failureType: string
    failureSignature: string
    whatFailed: string
    whyFailed: string[]
    doNotRepeat: string[]
    nextAttemptStrategy: string[]
    evidenceRefs: string[]
  }>
  operationalContext: Array<{
    id: string
    kind: string
    status: string
    statement: string
    rationale?: string
    refs: string[]
    tags: string[]
  }>
  commandRecords: LongTaskCampaignRunTraceCommandRecord[]
}

export interface LongTaskCampaignRunTrace {
  campaignID: string
  roundNumber: number
  runID: string
  createdAt: string
  finalStatus: LongTaskRunStatus
  summary: string
  materials: string[]
  capabilityPaths: string[]
  exploredRegions: string[]
  keySuccessPaths: string[]
  keyFailurePaths: string[]
  blockers: string[]
  pendingPackageImpact: string[]
  attempts: LongTaskCampaignRunTraceAttemptRecord[]
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
  runTracePath?: string
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
  includeCampaignOperationalMemory: true,
  includeCampaignSeedContext: true,
  includeFailurePackets: true,
  includeRetryLessons: true,
  includeLearningUnits: true,
  includeRoundSummaries: true,
  recentRoundSummaryCount: 6,
}
