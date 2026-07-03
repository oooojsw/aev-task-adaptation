import type { LongTaskValidatorResult } from "../long-task/contract"

export type BlankEvalMode = "train-backtest" | "test" | "deployment" | "smoke"

export interface BlankEvalInput {
  cwd: string
  specPath: string
  skillRoots: string[]
  runRoot?: string
  title?: string
  sourceID?: string
  mode?: BlankEvalMode
  runtimeScope?: string
  concurrencyScope?: string
  resetEditablePaths?: boolean
  promptInlinePaths?: string[]
}

export interface BlankEvalResult {
  runID: string
  runDir: string
  passed: boolean
  failureKind?: "product_failure" | "validator_infrastructure" | "dataset_failure"
  summary: string
  validatorResults: LongTaskValidatorResult[]
  sessionExecutionReportPath: string
  resultPath: string
  validationStageResultPath?: string
}

export type BlankEvalPlanMode = "single" | "sequence" | "parallel"

export type BlankEvalPlanSuccessCriterion = "all_pass" | "allow_partial" | "min_pass_rate"

export interface BlankEvalPlanCase {
  id: string
  specPath: string
  title?: string
  sourceID?: string
  mode?: BlankEvalMode
  promptInlinePaths?: string[]
}

export interface BlankEvalPlanInput {
  cwd: string
  mode: BlankEvalPlanMode
  skillRoots: string[]
  cases: BlankEvalPlanCase[]
  runRoot?: string
  title?: string
  concurrency?: number
  stopOnFirstFailure?: boolean
  successCriterion?: BlankEvalPlanSuccessCriterion
  minPassRate?: number
  runtimeScope?: string
  concurrencyScope?: string
}

export interface BlankEvalPlanCaseResult {
  id: string
  specPath: string
  title?: string
  passed: boolean
  skipped?: boolean
  failureKind?: BlankEvalResult["failureKind"]
  summary: string
  runID?: string
  runDir?: string
  resultPath?: string
  validatorResults?: BlankEvalResult["validatorResults"]
}

export interface BlankEvalPlanResult {
  schema: "blank-eval-plan-result/v1"
  runID: string
  runDir: string
  mode: BlankEvalPlanMode
  passed: boolean
  successCriterion: BlankEvalPlanSuccessCriterion
  minPassRate?: number
  total: number
  passedCount: number
  failedCount: number
  skippedCount: number
  score: number
  failedCases: string[]
  summary: string
  caseResults: BlankEvalPlanCaseResult[]
  resultPath: string
  evidenceBundlePath: string
  summaryPath: string
}
