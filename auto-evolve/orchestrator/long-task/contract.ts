import type { ExecutionSpec } from "../schema"

export type LongTaskRunStatus =
  | "planning"
  | "bootstrapping"
  | "running"
  | "waiting_for_retry"
  | "verified_success"
  | "exhausted_failure"
  | "stagnation_failure"
  | "blocked_failure"
  | "archived"

export type LongTaskWorkUnitStatus = "planned" | "active" | "verified" | "failed" | "blocked"

export type LongTaskRetryLevel = "tool_retry" | "work_unit_retry" | "subgraph_retry" | "run_retry"

export type LongTaskValidatorType = "script" | "prompt_json"

export type LongTaskCapabilityKind = "inspect" | "transform" | "validate" | "compare" | "synthesize"

export type LongTaskScratchUnitKind = "claim" | "obs" | "map" | "hyp" | "fail" | "fix" | "rule_candidate" | "verified"

export type LongTaskLearningUnitKind =
  | "obs"
  | "map"
  | "rule"
  | "exception"
  | "failure_pattern"
  | "repair_pattern"
  | "tooling_hint"
  | "validator_hint"

export type LongTaskLearningScope = "instance" | "local" | "pattern" | "global_candidate"

export type LongTaskOperationalContextKind =
  | "confirmed_fact"
  | "validated_method"
  | "blocking_issue"
  | "failed_path"
  | "tool_entrypoint"
  | "package_gap"

export interface LongTaskPathRef {
  path: string
  label?: string
  role?: string
}

export interface LongTaskCapabilityContract {
  id: string
  title: string
  kind: LongTaskCapabilityKind
  description: string
  referencePaths?: string[]
  attachedFiles?: string[]
  execution?: ExecutionSpec
}

export interface LongTaskBudgets {
  maxAttemptsPerUnit: number
  maxTotalUnitAttempts: number
  maxGraphReplans: number
  maxValidatorCalls: number
  maxNoProgressCycles: number
  maxUnitsPerGraph: number
}

export interface LongTaskShadowMemoryScope {
  namespace: string
  tags: string[]
  retrievalMode: "isolated" | "related_only" | "manual"
}

export interface LongTaskReversePropagationHints {
  recipeID?: string
  maintenanceModuleID?: string
  acceptancePolicyID?: string
  constraintPolicyIDs?: string[]
}

export interface LongTaskInitialGraphUnitDraft {
  id: string
  title: string
  goal: string
  inputs: string[]
  depends_on: string[]
  expected_artifacts: string[]
  claim: string
  check_plan: string
  validator_ids: string[]
  retry_budget: number
}

export interface LongTaskInitialGraphDraft {
  planner_summary?: string
  completion_validator_ids?: string[]
  units: LongTaskInitialGraphUnitDraft[]
}

export interface LongTaskScriptValidatorContract {
  id: string
  type: "script"
  title: string
  path: string
  placement?: "unit" | "completion_only"
  runner?: "python" | "bun" | "node" | "powershell" | "direct"
  args?: string[]
  cwd?: string
  required?: boolean
  blocking?: boolean
  inputMode?: "json_file" | "none"
  successExitCodes?: number[]
  timeoutMs?: number
}

export interface LongTaskPromptValidatorContract {
  id: string
  type: "prompt_json"
  title: string
  prompt: string
  placement?: "unit" | "completion_only"
  required?: boolean
  blocking?: boolean
  referencePaths?: string[]
  attachedFiles?: string[]
  execution?: ExecutionSpec
}

export type LongTaskValidatorContract = LongTaskScriptValidatorContract | LongTaskPromptValidatorContract

export interface LongTaskSpec {
  id?: string
  title: string
  goal: string
  taskFamily?: string
  domainTags?: string[]
  materials: LongTaskPathRef[]
  targetPaths?: LongTaskPathRef[]
  editablePaths?: string[]
  initialExpertContextPaths?: string[]
  formalPackageRoots?: string[]
  campaignPendingPackageRoot?: string
  campaignExplorationTreePath?: string
  campaignWorkingMemoryPath?: string
  campaignRoutingControlPath?: string
  capabilities?: LongTaskCapabilityContract[]
  validators: LongTaskValidatorContract[]
  planning?: ExecutionSpec
  execution?: ExecutionSpec
  validation?: ExecutionSpec
  budgets?: Partial<LongTaskBudgets>
  disableCompletionValidators?: boolean
  shadowMemoryScope?: LongTaskShadowMemoryScope
  reversePropagation?: LongTaskReversePropagationHints
  initialGraph?: LongTaskInitialGraphDraft
  notes?: string
}

export interface LongTaskWorkUnit {
  id: string
  title: string
  goal: string
  inputs: string[]
  dependsOn: string[]
  expectedArtifacts: string[]
  claim: string
  checkPlan: string
  validatorIDs: string[]
  retryBudget: number
  status: LongTaskWorkUnitStatus
  attemptCount: number
  lastAttemptAt?: string
  lastClaimID?: string
  lastFailurePacketID?: string
}

export interface LongTaskWorkGraph {
  createdAt: string
  updatedAt: string
  revision: number
  plannerSummary?: string
  completionValidatorIDs: string[]
  units: LongTaskWorkUnit[]
}

export interface LongTaskProgressState {
  runID: string
  createdAt: string
  updatedAt: string
  ownerPID?: number
  ownerCommandHint?: string
  heartbeatAt?: string
  status: LongTaskRunStatus
  graphRevision: number
  activeUnitID?: string
  activeAttempt?: number
  completedUnitIDs: string[]
  blockedUnitIDs: string[]
  failedUnitIDs: string[]
  nextPriorityUnitIDs: string[]
  lastClaimID?: string
  lastFailurePacketID?: string
  totalUnitAttempts: number
  validatorCalls: number
  graphReplanCount: number
  noProgressCycles: number
  lastProgressAt?: string
  finalSummary?: string
}

export interface LongTaskVerificationClaim {
  id: string
  runID: string
  unitID: string
  attempt: number
  createdAt: string
  statement: string
  claimedSuccess: boolean
  checkTools: string[]
  blockers: string[]
  nextPriorityFix?: string
  evidenceRefs: string[]
}

export interface LongTaskValidatorResult {
  id: string
  runID: string
  unitID: string
  attempt: number
  validatorID: string
  validatorType: LongTaskValidatorType
  createdAt: string
  passed: boolean
  blocking: boolean
  summary: string
  details: string[]
  evidenceRefs: string[]
  rawOutputPath?: string
}

export interface LongTaskFailurePacket {
  id: string
  runID: string
  unitID: string
  attempt: number
  createdAt: string
  failureType:
    | "validator_failed"
    | "invalid_execution_output"
    | "planning_failed"
    | "replanning_failed"
    | "blocked"
    | "budget_exhausted"
  retryLevel: LongTaskRetryLevel
  claimedSuccess: boolean
  verificationPassed: boolean
  mismatchSummary: string
  suspectedCauses: string[]
  nextPriorityFix?: string
  evidenceRefs: string[]
  promotionHint: "archive_only" | "shadow_candidate" | "canonical_candidate"
}

export interface LongTaskScratchUnit {
  id: string
  runID: string
  unitID: string
  attempt: number
  createdAt: string
  kind: LongTaskScratchUnitKind
  statement: string
  refs: string[]
  relatedUnitIDs: string[]
}

export interface LongTaskLearningRelation {
  type: "supports" | "conflicts" | "exception_of" | "derived_from" | "blocks"
  targetID: string
}

export interface LongTaskLearningUnit {
  id: string
  runID: string
  unitID?: string
  createdAt: string
  kind: LongTaskLearningUnitKind
  statement: string
  scope: LongTaskLearningScope
  strength: 1 | 2 | 3
  refs: string[]
  relations: LongTaskLearningRelation[]
}

export interface LongTaskRetryLesson {
  id: string
  runID: string
  unitID: string
  attempt: number
  createdAt: string
  sourceFailurePacketID?: string
  sourceClaimID?: string
  failureType:
    | "validator_failed"
    | "invalid_execution_output"
    | "planning_failed"
    | "replanning_failed"
    | "blocked"
    | "budget_exhausted"
  failureSignature: string
  whatFailed: string
  whyFailed: string[]
  doNotRepeat: string[]
  nextAttemptStrategy: string[]
  requiredSelfChecks: string[]
  evidenceRefs: string[]
}

export interface LongTaskRetryJournalEntry {
  id: string
  runID: string
  createdAt: string
  level: LongTaskRetryLevel
  fromUnitID?: string
  toUnitID?: string
  reason: string
}

export interface LongTaskOperationalContextItem {
  id: string
  runID: string
  createdAt: string
  updatedAt: string
  sourceUnitID?: string
  sourceAttempt?: number
  kind: LongTaskOperationalContextKind
  status: "candidate" | "confirmed"
  statement: string
  rationale?: string
  refs: string[]
  tags: string[]
}

export interface LongTaskRetryInputBundle {
  id: string
  runID: string
  unitID: string
  createdAt: string
  progressState: LongTaskProgressState
  currentUnit: LongTaskWorkUnit
  recentClaims: LongTaskVerificationClaim[]
  recentFailurePackets: LongTaskFailurePacket[]
  sameUnitRecentClaims: LongTaskVerificationClaim[]
  dependencyClaims: LongTaskVerificationClaim[]
  sameUnitLastFailure?: LongTaskFailurePacket
  sameUnitRetryLessons: LongTaskRetryLesson[]
  relevantScratchUnits: LongTaskScratchUnit[]
  relevantLearningUnits: LongTaskLearningUnit[]
  relevantShadowMemory: LongTaskShadowMemoryRecord[]
  runGlobalOperationalContext: LongTaskOperationalContextItem[]
  formalPackageRoots: string[]
}

export interface LongTaskArchiveRecord {
  id: string
  runID: string
  createdAt: string
  status: LongTaskRunStatus
  taskFamily?: string
  domainTags: string[]
  title: string
  goal: string
  summary: string
  failurePacketCount: number
  learningUnitCount: number
  runRoot: string
}

export interface LongTaskShadowMemoryRecord {
  id: string
  runID: string
  createdAt: string
  namespace: string
  tags: string[]
  retrievalMode: "isolated" | "related_only" | "manual"
  status: "hold" | "candidate"
  summary: string
  evidenceRef: string
}

export interface LongTaskRunVerificationSignal {
  unitsConverged: boolean
  completionGateMode: "required" | "deferred_or_disabled"
  completionValidatorsRequired: number
  completionValidatorsExecuted: number
  completionValidatorsPassed: number
  completionValidatorsFailed: number
  completionGatePassed: boolean
}

export interface LongTaskRunSummary {
  runID: string
  title: string
  goal: string
  status: LongTaskRunStatus
  taskFamily?: string
  domainTags: string[]
  graphRevision: number
  totalUnits: number
  verifiedUnits: number
  failedUnits: number
  blockedUnits: number
  totalUnitAttempts: number
  validatorCalls: number
  failurePacketCount: number
  learningUnitCount: number
  retryLessonCount: number
  operationalContextCount: number
  verificationSignal: LongTaskRunVerificationSignal
  summary: string
}

export interface LongTaskCandidatePackage {
  id: string
  createdAt: string
  updatedAt: string
  status: "hold" | "ready_for_maintainer"
  mode: "long"
  runID: string
  title: string
  goal: string
  taskFamily?: string
  domainTags: string[]
  finalStatus: LongTaskRunStatus
  summary: string
  summaryPath: string
  taskPath: string
  progressStatePath: string
  workGraphPath: string
  failurePacketsPath: string
  learningUnitsPath: string
  retryLessonsPath: string
  operationalContextPath: string
  shadowMemoryRecordID?: string
  notes: string[]
}

export const DEFAULT_LONG_TASK_BUDGETS: LongTaskBudgets = {
  maxAttemptsPerUnit: 3,
  maxTotalUnitAttempts: 18,
  maxGraphReplans: 3,
  maxValidatorCalls: 40,
  maxNoProgressCycles: 5,
  maxUnitsPerGraph: 12,
}
