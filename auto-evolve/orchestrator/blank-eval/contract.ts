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
  failureKind?: "product_failure" | "validator_infrastructure"
  summary: string
  validatorResults: LongTaskValidatorResult[]
  sessionExecutionReportPath: string
  resultPath: string
  validationStageResultPath?: string
}
