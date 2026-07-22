export type ExperimentStage =
  | "benchmark"
  | "training"
  | "surface_validation"
  | "blank_acceptance"
  | "merge"
  | "train_replay"
  | "test"
  | "baseline"
  | "direct_chat"
  | "recovery"
  | "unknown"

export type ExperimentSkillMode = "none" | "initial" | "trained" | "merged" | "with-skill" | "no-skill" | "unknown"

export interface ExperimentManifest {
  schema: "auto-evolve/experiment-manifest/v1"
  experimentID: string
  runID: string
  runRoot: string
  createdAt: string
  updatedAt: string
  source: "benchmark" | "direct-chat" | "merge" | "unknown"
  dataset?: string
  taskPackRoot?: string
  trainSplit?: string
  testSplit?: string
  splitHash?: string
  gitCommit?: string
  cwd?: string
  platform?: NodeJS.Platform
  configSummary?: Record<string, unknown>
}

export interface ExperimentConfigFingerprint {
  schema: "auto-evolve/config-fingerprint/v1"
  experimentID: string
  updatedAt: string
  models?: Record<string, unknown>
  dataset?: Record<string, unknown>
  execution?: Record<string, unknown>
  validation?: Record<string, unknown>
  directChat?: Record<string, unknown>
  rawConfigHash?: string
}

export interface ExperimentDatasetSplits {
  schema: "auto-evolve/dataset-splits/v1"
  experimentID: string
  updatedAt: string
  dataset?: string
  trainIDs: string[]
  validationIDs?: string[]
  testIDs: string[]
  trainSplitPath?: string
  testSplitPath?: string
  splitSource?: string
  splitHash?: string
  seed?: number
}

export interface ExperimentTaskResult {
  schema: "auto-evolve/task-result/v1"
  experimentID: string
  runID: string
  taskID: string
  split: "train" | "validation" | "test" | "replay" | "baseline" | "unknown"
  stage: ExperimentStage
  status: string
  passed: boolean
  score?: number
  modelID?: string
  provider?: string
  resolvedModel?: string
  skillMode?: ExperimentSkillMode
  skillPath?: string
  skillHash?: string
  contextMode?: string
  materialMode?: string
  campaignID?: string
  campaignDir?: string
  attemptID?: string
  round?: number
  attempts?: number
  failureCategory?: string
  error?: string | null
  validatorID?: string
  validatorResultPath?: string
  rawResponsePath?: string
  durationMs?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  tokenSource?: "provider" | "opencode" | "estimated" | "unknown"
  evidencePath?: string
  updatedAt: string
}

export interface ExperimentStageEvent {
  schema: "auto-evolve/stage-event/v1"
  experimentID: string
  runID: string
  stage: ExperimentStage
  event: string
  status?: string
  taskID?: string
  campaignID?: string
  details?: Record<string, unknown>
  createdAt: string
}

export interface ExperimentCostEvent {
  schema: "auto-evolve/cost-event/v1"
  experimentID: string
  runID: string
  stage: ExperimentStage
  role: string
  taskID?: string
  campaignID?: string
  round?: number
  provider?: string
  modelID?: string
  resolvedModel?: string
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  estimated?: boolean
  durationMs?: number
  success?: boolean
  createdAt: string
}

export interface ExperimentSkillLineage {
  schema: "auto-evolve/skill-lineage/v1"
  experimentID: string
  runID: string
  skillID: string
  parentSkillID?: string
  source: string
  stage: ExperimentStage
  taskIDs: string[]
  path: string
  sha256?: string
  charCount?: number
  estimatedTokens?: number
  surfacePassed?: boolean
  blankAcceptancePassed?: boolean
  createdAt: string
}

export interface ExperimentValidationEvent {
  schema: "auto-evolve/validation-event/v1"
  experimentID: string
  runID: string
  validatorID: string
  validatorType: "surface" | "product" | "replay" | "soft" | "unknown"
  stage: ExperimentStage
  target: "skill" | "blank-output" | "merged-skill" | "task-output" | "unknown"
  passed: boolean
  blocking?: boolean
  failureCategory?: string
  inputPath?: string
  resultPath?: string
  taskID?: string
  campaignID?: string
  summary?: string
  createdAt: string
}

export interface ExperimentRunSummary {
  schema: "auto-evolve/run-summary/v1"
  experimentID: string
  runID: string
  updatedAt: string
  status?: string
  source: "benchmark" | "direct-chat" | "merge" | "unknown"
  totals: {
    trainTotal?: number
    trainPassed?: number
    testTotal?: number
    testPassed?: number
    baselineTotal?: number
    baselinePassed?: number
    taskRows?: number
  }
  accuracy?: {
    train?: number
    test?: number
    baseline?: number
    deltaVsBaseline?: number
  }
  cost?: {
    calls: number
    promptTokens: number
    completionTokens: number
    reasoningTokens: number
    totalTokens: number
    estimatedRows: number
  }
  merge?: {
    mergePath?: "merge-as-old" | "merge-as-long-task" | "merge-both-smoke" | string
    internalMode?: string
    strategy?: string
    mergedSkillDir?: string
    inputSkillCount?: number
    sourceTrainVerified?: number
    sourceTrainTotal?: number
    acceptanceProfile?: string
  }
  comparability?: {
    sameModel?: boolean
    sameSplit?: boolean
    sameContextMode?: boolean
    sameMaterialMode?: boolean
    comparable?: boolean
    warnings: string[]
  }
}
