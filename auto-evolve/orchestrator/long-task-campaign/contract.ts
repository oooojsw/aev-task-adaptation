import type {
  LongTaskBudgets,
  LongTaskOperationalContextItem,
  LongTaskRoundClosure,
  LongTaskRunStatus,
  LongTaskRunVerificationSignal,
} from "../long-task/contract"

export type LongTaskCampaignMode = "graph_iterative" | "single_session_iterative"

export type LongTaskCampaignStatus =
  | "bootstrapping"
  | "running"
  | "recovery_pending"
  | "verified_success"
  | "round_limit_reached"
  | "failed"

export type LongTaskCampaignRecoveryAction =
  | "restart_round"
  | "resume_round_run"
  | "harvest_round_run"

export interface LongTaskCampaignRecoveryDecision {
  action: LongTaskCampaignRecoveryAction
  roundNumber: number
  runID?: string
  reason: string
  detectedAt: string
}

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

export interface LongTaskCampaignSurfaceGeneralizationConfig {
  enabled: boolean
  validatorPath: string
  configPath: string
  blocking: boolean
  timeoutMs: number
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

export type LongTaskCampaignWorkingMemoryKind =
  | "stable_fact"
  | "validated_method"
  | "real_blocker"
  | "forbidden_path"
  | "package_gap"

export type LongTaskCampaignConfidence = "low" | "medium" | "high"

export interface LongTaskCampaignWorkingMemoryRecord {
  key: string
  kind: LongTaskCampaignWorkingMemoryKind
  statement: string
  confidence: LongTaskCampaignConfidence
  evidenceCount: number
  firstSeenRound: number
  lastSeenRound: number
  refs: string[]
  applicableUnits?: string[]
}

export interface LongTaskCampaignWorkingMemoryDocument {
  updatedAt: string
  updatedThroughRound: number
  items: LongTaskCampaignWorkingMemoryRecord[]
}

export interface LongTaskCampaignRoutingControl {
  updatedAt: string
  updatedThroughRound: number
  currentPhase: string
  requiredNextRegions: string[]
  forbiddenUnits: string[]
  forbiddenRegions: string[]
  prerequisites: string[]
  blockedBy: string[]
  readyForFinalAcceptance: boolean
  summary?: string
  evidenceRefs: string[]
  notes?: string[]
}

export type LongTaskCampaignWorkerRole =
  | "blank_acceptance_diagnostician"
  | "success_synthesizer"
  | "failure_synthesizer"
  | "tool_failure_synthesizer"
  | "forbidden_path_synthesizer"
  | "learning_promoter"
  | "exploration_tree_synthesizer"
  | "drift_guard_synthesizer"
  | "custom"

export interface LongTaskCampaignWorkerSuggestion {
  id: string
  roundNumber: number
  role: LongTaskCampaignWorkerRole
  createdAt: string
  summary: string
  findings: string[]
  memoryAdvice: string[]
  packageAdvice: string[]
  explorationAdvice: string[]
  refs: string[]
  responsePath?: string
  suggestionPath?: string
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
  region: string
  branch?: LongTaskCampaignTreeBranch
  parentID?: string
  summary: string
  status: "unexplored" | "in_progress" | "weak_fail" | "strong_fail" | "promising" | "validated_success" | "deprecated"
  confidence: number
  evidenceRefs: string[]
  lastUpdatedRound: number
  prerequisites?: string[]
  attemptCount?: number
  successCount?: number
  failCount?: number
  notes?: string[]
}

export type LongTaskCampaignTreeBranch = "solution" | "anti_drift" | "acceptance"

export type LongTaskCampaignTreeViewerRole =
  | "planner"
  | "executor"
  | "campaign_worker"
  | "campaign_lead"
  | "campaign_reviewer"
  | "blank_agent"

export interface LongTaskCampaignTreeBranchSummary {
  branch: LongTaskCampaignTreeBranch
  summary: string
  focusRegions: string[]
}

export interface LongTaskCampaignTreeRolePosition {
  role: LongTaskCampaignTreeViewerRole
  branch: LongTaskCampaignTreeBranch
  focusRegions: string[]
  note: string
}

export interface LongTaskCampaignExplorationTreeDocument {
  updatedAt: string
  updatedThroughRound: number
  currentPhase: string
  globalSummary?: string
  branchSummaries: LongTaskCampaignTreeBranchSummary[]
  rolePositions: LongTaskCampaignTreeRolePosition[]
  frontierRegions: string[]
  requiredNextRegions: string[]
  forbiddenRepeatRegions: string[]
  nodes: LongTaskCampaignExplorationNode[]
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
  attemptFindings: string[]
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
  runVerificationSignal?: LongTaskRunVerificationSignal
  attempts: LongTaskCampaignRunTraceAttemptRecord[]
}

export interface LongTaskCampaignRunTraceDigest {
  campaignID: string
  roundNumber: number
  runID: string
  createdAt: string
  finalStatus: LongTaskRunStatus
  summary: string
  exploredRegions: string[]
  keySuccessPaths: string[]
  keyFailurePaths: string[]
  blockers: string[]
  pendingPackageImpact: string[]
  runVerificationSignal?: LongTaskRunVerificationSignal
  validatedMethods: string[]
  forbiddenPaths: string[]
  packageGaps: string[]
  commandOutcomes: Array<{
    unitID: string
    attempt: number
    successCommands: string[]
    failedCommands: string[]
  }>
  refs: string[]
}

export interface LongTaskCampaignSpec {
  title: string
  baseSpecPath: string
  taskFamily?: string
  mode: LongTaskCampaignMode
  maxRounds: number
  seedTargets: LongTaskCampaignSeedTarget[]
  lessonsMirror?: LongTaskCampaignLessonsMirror
  surfaceGeneralization?: LongTaskCampaignSurfaceGeneralizationConfig
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
  runVerificationSignal?: LongTaskRunVerificationSignal
  roundClosure?: LongTaskRoundClosure
  gateFailureKind?:
    | "completion_gate_failed"
    | "execution_blocked"
    | "infrastructure_failure"
    | "final_acceptance_failed"
    | "dataset_failure"
  gateFailureSummary?: string
  finalAcceptanceSignal?: {
    executed: boolean
    passed: boolean
    failureKind?: "product_failure" | "infrastructure_failure" | "dataset_failure"
    failedValidatorIDs: string[]
    feedbackPath?: string
  }
  roundSummaryPath: string
  snapshotPaths: Array<{
    targetPath: string
    snapshotPath: string
    kind: "experience_workspace" | "path_copy"
  }>
  createdAt: string
}

export type LongTaskCampaignDispatchTicketStatus = "open" | "resolved"

export interface LongTaskCampaignDispatchTicket {
  id: string
  key: string
  status: LongTaskCampaignDispatchTicketStatus
  createdAt: string
  updatedAt: string
  firstSeenRound: number
  lastSeenRound: number
  resolvedRound?: number
  occurrenceCount: number
  validatorID?: string
  title: string
  issue: string
  actionableFix: string
  evidenceRefs: string[]
}

export interface LongTaskCampaignDispatchTicketDocument {
  updatedAt: string
  updatedThroughRound: number
  tickets: LongTaskCampaignDispatchTicket[]
}

export type LongTaskCampaignHistoryPolicy =
  | "resume-current-generation"
  | "fresh-non-verified"
  | "fresh-all"
  | "resume-explicit-only"
  | "audit-only"

export interface LongTaskCampaignRunLineage {
  benchmarkRunID: string
  generationID: string
  taskID: string
  attemptID: string
  historyPolicy: LongTaskCampaignHistoryPolicy
  taskPackRoot?: string
  trainSplitHash?: string
  testSplitHash?: string
  specHash?: string
  modelRequested?: string
  modelResolved?: string
  validatorProfileHash?: string
}

export interface LongTaskCampaignReuseState {
  allowed: boolean
  scope: "current-generation-only" | "explicit-only" | "audit-only"
  tainted: boolean
  superseded: boolean
  reason?: string
  supersededBy?: string
  taintReason?: string
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
  ownerPID?: number
  ownerCommandHint?: string
  ownerCreationTick?: string
  heartbeatAt?: string
  notes?: string
  lastRunID?: string
  lastSummary?: string
  lastRoundSummaryPath?: string
  lastRunHardVerified?: boolean
  lastFinalAcceptancePassed?: boolean
  lastFinalAcceptanceResultPath?: string
  lastRoundClosure?: LongTaskRoundClosure
  lastGateFailureKind?: LongTaskCampaignRoundRecord["gateFailureKind"]
  lastGateFailureSummary?: string
  runLineage?: LongTaskCampaignRunLineage
  reuse?: LongTaskCampaignReuseState
  recovery?: LongTaskCampaignRecoveryDecision
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
