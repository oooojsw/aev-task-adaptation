import path from "node:path"
import type { RefineRouting } from "./acceptance"
import type { DatasetSplit, DatasetSplitName } from "./dataset-split"
import type { EvaluationResult } from "./evaluator"
import type {
  ExperienceWorkspaceLayout,
  ExperienceWorkspacePaths,
  ExperienceWorkspaceSnapshot,
  TemplateLibraryPaths,
} from "./experience-workspace"
import type { MethodStrategy } from "./method-strategies"
import type { OpencodeTaskRun } from "./opencode"
import type { LoadedCase, CompareMode } from "./schema"
import type { AutoEvolveConfig } from "./schema"

export interface LoadedAutoEvolveConfig extends AutoEvolveConfig {
  configPath: string
}

export type CaseExecutionProfile = "full" | "light_shard"

export interface MaintenanceRoundSummary {
  round: number
  maintainSessionID?: string
  maintainSessionExecutionReportPath?: string
  maintainExitCode?: number
  workspaceChanged?: boolean
  workspaceChangedFiles?: string[]
  acceptancePassed?: boolean
  acceptanceRejected?: boolean
  acceptanceReason?: string
  acceptanceRejectionReasons?: string[]
  currentCaseVerificationPassed?: boolean
  currentCaseVerificationReportPath?: string
  regressionAfterReports?: { caseID: string; path: string }[]
  regressionPassedAfterRefine?: number
  postJudgeStrategyID?: string
  postJudgeDecision?: "accept" | "retry"
  postJudgeSummaryPath?: string
  postJudgeReportPath?: string
  postJudgeRiskLevel?: string
}

export interface AttemptSummary {
  attempt: number
  solveSessionID?: string
  solveSessionExecutionReportPath?: string
  solveExitCode: number
  passed: boolean
  knowledgePackChangedDuringSolve: boolean
  knowledgePackChangedFilesDuringSolve: string[]
  refineSessionID?: string
  refineSessionExecutionReportPath?: string
  refineExitCode?: number
  refineRoutingClass?: string
  refinePreferredFiles?: string[]
  refineSuggestedRoles?: string[]
  judgeSessionID?: string
  judgeSessionExecutionReportPath?: string
  judgeExitCode?: number
  judgeSummaryPath?: string
  judgeReportPath?: string
  judgeMode?: string
  judgeShouldStartMaintainer?: boolean
  postJudgeStrategyID?: string
  postJudgeDecision?: "accept" | "retry"
  postJudgeSummaryPath?: string
  postJudgeReportPath?: string
  postJudgeRiskLevel?: string
  knowledgePackChangedByRefine?: boolean
  knowledgePackChangedFilesByRefine?: string[]
  acceptancePassed?: boolean
  acceptanceRejected?: boolean
  acceptanceRejectionReasons?: string[]
  currentCaseVerificationPassed?: boolean
  currentCaseVerificationReportPath?: string
  regressionCaseIDs?: string[]
  regressionBeforeReports?: { caseID: string; path: string }[]
  regressionPassedBeforeRefine?: number
  regressionAfterReports?: { caseID: string; path: string }[]
  regressionPassedAfterRefine?: number
  maintenanceRounds?: MaintenanceRoundSummary[]
}

export interface RunCaseResult {
  runDir: string
  caseID: string
  methodID: string
  mode: "learn" | "eval"
  split: DatasetSplitName
  executionProfile?: CaseExecutionProfile
  evaluation: EvaluationResult
  attempts: AttemptSummary[]
}

export interface SolveStageResult {
  task: OpencodeTaskRun
  evaluation: EvaluationResult
  sessionExecutionReportPath: string
  knowledgePackChangedDuringSolve: boolean
  knowledgePackChangedFilesDuringSolve: string[]
}

export interface RegressionCaseSummary {
  caseID: string
  passed: boolean
  summary: string
  exitCode: number
  toolFailureCount: number
  solveSessionID?: string
  sessionExecutionReportPath?: string
}

export interface RegressionSuiteResult {
  cases: RegressionCaseSummary[]
  passedCount: number
  failedCount: number
}

export interface FeedbackPacketState {
  actualOutputPath?: string
  evaluationPath?: string
  actionTracePath?: string
  routing?: RefineRouting
}

export interface MaintenanceState {
  workspaceBeforeMaintenance?: ExperienceWorkspaceSnapshot
  maintainTask?: OpencodeTaskRun
  workspaceAfterMaintenance?: ExperienceWorkspaceSnapshot
  workspaceChanged?: boolean
  workspaceChangedFiles?: string[]
}

export interface AcceptanceState {
  regressionCases?: LoadedCase[]
  baselineRegression?: RegressionSuiteResult
  currentCaseVerification?: SolveStageResult
  afterRegression?: RegressionSuiteResult
}

export interface JudgeState {
  judgeTask?: OpencodeTaskRun
  judgeSummaryPath?: string
  judgeReportPath?: string
  hardCheckIndexPath?: string
  hardCheckResultPaths?: string[]
  shouldStartMaintainer?: boolean
  judgeMode?: string
  summary?: Record<string, unknown>
}

export interface PostJudgeState {
  strategyID?: string
  decision?: "accept" | "retry"
  summaryPath?: string
  reportPath?: string
  riskLevel?: string
  summary?: Record<string, unknown>
}

export interface CaseRuntimeContext {
  cwd: string
  config: LoadedAutoEvolveConfig
  methodID: string
  strategy: MethodStrategy
  loaded: LoadedCase
  expectedPath: string
  expectedText: string
  workspacePaths: ExperienceWorkspacePaths
  workspace: ExperienceWorkspaceLayout
  templateLibrary: TemplateLibraryPaths
  baselinePath: string
  scriptsDir: string
  datasetSplit: DatasetSplit
  allCases: LoadedCase[]
  mode: "learn" | "eval"
  split: DatasetSplitName
  executionProfile: CaseExecutionProfile
  runDir: string
  attempt: number
  currentAttemptDir: string
  solveDir: string
  judgeDir: string
  baseMaintainDir: string
  maintainDir: string
  maintainInputDir: string
  baseAcceptanceDir: string
  acceptanceDir: string
  currentMaintenanceRound?: number
  attempts: AttemptSummary[]
  attemptSummary: AttemptSummary
  finalEvaluation?: EvaluationResult
  stopReason?: string
  solveStage?: SolveStageResult
  solveTask?: OpencodeTaskRun
  evaluation?: EvaluationResult
  feedback: FeedbackPacketState
  judge: JudgeState
  postJudge: PostJudgeState
  maintenance: MaintenanceState
  acceptance: AcceptanceState
}

export function makeRunID(caseID: string) {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`
  return `${stamp}-${caseID}`
}

export function attemptDir(runDir: string, attempt: number) {
  return path.join(runDir, `attempt-${String(attempt).padStart(2, "0")}`)
}

export function maintenanceRoundRoot(currentAttemptDir: string, round: number) {
  return path.join(currentAttemptDir, "maintenance-rounds", `round-${String(round).padStart(2, "0")}`)
}

export function maintenanceRoundPhaseDir(currentAttemptDir: string, round: number, phase: "maintain" | "acceptance") {
  return path.join(maintenanceRoundRoot(currentAttemptDir, round), phase)
}

export function markSolvePhaseViolation(evaluation: EvaluationResult) {
  evaluation.passed = false
  evaluation.summary = `${evaluation.summary} Solve phase violated the read-only experience workspace contract.`
  evaluation.mismatches.push("Solve phase modified one or more experience workspace files, which is not allowed.")
}

export function createAttemptContext(input: {
  cwd: string
  config: LoadedAutoEvolveConfig
  methodID: string
  strategy: MethodStrategy
  loaded: LoadedCase
  expectedPath: string
  expectedText: string
  workspacePaths: ExperienceWorkspacePaths
  workspace: ExperienceWorkspaceLayout
  templateLibrary: TemplateLibraryPaths
  baselinePath: string
  scriptsDir: string
  datasetSplit: DatasetSplit
  allCases: LoadedCase[]
  mode: "learn" | "eval"
  split: DatasetSplitName
  executionProfile?: CaseExecutionProfile
  runDir: string
  attempt: number
  attempts: AttemptSummary[]
}) {
  const currentAttemptDir = attemptDir(input.runDir, input.attempt)
  const solveDir = path.join(currentAttemptDir, "solve")
  const judgeDir = path.join(currentAttemptDir, "judge")
  const maintainDir = path.join(currentAttemptDir, "maintain")
  const maintainInputDir = path.join(currentAttemptDir, "maintain-input")
  const acceptanceDir = path.join(currentAttemptDir, "acceptance")
  const attemptSummary: AttemptSummary = {
    attempt: input.attempt,
    solveExitCode: -1,
    passed: false,
    knowledgePackChangedDuringSolve: false,
    knowledgePackChangedFilesDuringSolve: [],
  }

  input.attempts.push(attemptSummary)

  return {
    ...input,
    executionProfile: input.executionProfile ?? "full",
    currentAttemptDir,
    solveDir,
    judgeDir,
    baseMaintainDir: maintainDir,
    maintainDir,
    maintainInputDir,
    baseAcceptanceDir: acceptanceDir,
    acceptanceDir,
    currentMaintenanceRound: undefined,
    attemptSummary,
    feedback: {},
    judge: {},
    postJudge: {},
    maintenance: {},
    acceptance: {},
  } satisfies CaseRuntimeContext
}

export function enterMaintenanceRound(context: CaseRuntimeContext, round: number) {
  context.currentMaintenanceRound = round
  context.maintainDir = maintenanceRoundPhaseDir(context.currentAttemptDir, round, "maintain")
  context.acceptanceDir = maintenanceRoundPhaseDir(context.currentAttemptDir, round, "acceptance")
  const rounds = (context.attemptSummary.maintenanceRounds ??= [])
  let summary = rounds.find((item) => item.round === round)
  if (!summary) {
    summary = { round }
    rounds.push(summary)
  }
  return summary
}

export function collectRegressionLosses(before: RegressionCaseSummary[], after: RegressionCaseSummary[]) {
  const afterMap = new Map(after.map((item) => [item.caseID, item]))
  return before
    .filter((item) => item.passed && !afterMap.get(item.caseID)?.passed)
    .map((item) => item.caseID)
    .sort((left, right) => left.localeCompare(right))
}

export function buildRegressionSummary(result: RegressionSuiteResult) {
  return {
    cases: result.cases,
    passedCount: result.passedCount,
    failedCount: result.failedCount,
  }
}

export function needsExactOutput(mode: CompareMode) {
  return mode === "text_exact" || mode === "json_exact"
}
