import type { CaseSpec, LoadedCase } from "../schema"
import type { ExperienceWorkspaceLayout } from "../experience-workspace"
import type { KnowledgeMaintainerSessionReportRef } from "../knowledge-maintainer/contract"

export interface JudgeHardCheckArtifact {
  skillID: string
  outputPath: string
  relativeOutputPath: string
  status: "completed" | "failed"
}

export interface JudgePlan {
  attempt: number
  judgeExtensionBlock: string
  sessionReports: KnowledgeMaintainerSessionReportRef[]
}

export interface SoftJudgeInputPaths {
  runDir: string
  baselinePath: string
  expectedPath: string
  actualPath: string
  evaluationPath: string
  actionTracePath: string
  routingPath: string
  judgeSummaryPath: string
  judgeReportPath: string
}

export interface SoftJudgeRequest {
  cwd: string
  config: import("../case-runtime").LoadedAutoEvolveConfig
  methodID: string
  loadedCase: LoadedCase
  workspace: ExperienceWorkspaceLayout
  inputPaths: SoftJudgeInputPaths
  judgePlan: JudgePlan
  hardCheckArtifacts: JudgeHardCheckArtifact[]
}

export interface SoftJudgeSummary {
  judgeMode: string
  shouldStartMaintainer: boolean
  failureClass: string
  keyIssues: string[]
  toolIssues: string[]
  behaviorIssues: string[]
  suggestedWorkspaceTargets: string[]
  recommendedSessionReports: string[]
  hardChecksUsed: string[]
  hardCheckResultPaths: string[]
  riskLevel: string
}

export interface SoftJudgeResult {
  prompt: string
  task: import("../opencode").OpencodeTaskRun
  summaryPath: string
  reportPath: string
  hardCheckIndexPath?: string
  hardCheckArtifacts: JudgeHardCheckArtifact[]
  summary?: SoftJudgeSummary
}

export interface SoftJudgePromptInput {
  workspace: ExperienceWorkspaceLayout
  baselinePath: string
  caseSpec: CaseSpec
  attempt: number
  expectedPath: string
  actualPath: string
  evaluationPath: string
  actionTracePath: string
  routingPath: string
  runDir: string
  sessionReports: KnowledgeMaintainerSessionReportRef[]
  judgeMode: string
  judgeSkillsIndexPath: string
  judgeSkillsRoot: string
  hardCheckArtifacts: JudgeHardCheckArtifact[]
  judgeSummaryPath: string
  judgeReportPath: string
  judgeExtensionBlock: string
}
