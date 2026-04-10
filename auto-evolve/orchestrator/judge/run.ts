import path from "node:path"
import { readJsonFile, pathExists } from "../fs"
import { runOpencodeTask } from "../opencode"
import { buildSoftJudgePrompt } from "../prompts"
import { resolveModelSelection } from "../model-selection"
import type { SoftJudgeRequest, SoftJudgeResult, SoftJudgeSummary } from "./contract"

export async function runSoftJudge(request: SoftJudgeRequest): Promise<SoftJudgeResult> {
  const execution = resolveModelSelection(request.config, "refine", request.loadedCase.spec.execution)
  const judgeSkillsRoot = path.join(request.cwd, "auto-evolve", request.config.judgeSkillsDir)
  const judgeSkillsIndexPath = path.join(judgeSkillsRoot, "INDEX.md")

  const prompt = await buildSoftJudgePrompt({
    cwd: request.cwd,
    config: request.config,
    methodID: request.methodID,
    runDir: request.inputPaths.runDir,
    caseSpec: request.loadedCase.spec,
    workspace: request.workspace,
    baselinePath: request.inputPaths.baselinePath,
    expectedPath: request.inputPaths.expectedPath,
    actualPath: request.inputPaths.actualPath,
    evaluationPath: request.inputPaths.evaluationPath,
    actionTracePath: request.inputPaths.actionTracePath,
    routingPath: request.inputPaths.routingPath,
    attempt: request.judgePlan.attempt,
    judgeMode: request.config.judgeConfig.mode,
    judgeSkillsRoot,
    judgeSkillsIndexPath,
    hardCheckArtifacts: request.hardCheckArtifacts,
    judgeSummaryPath: request.inputPaths.judgeSummaryPath,
    judgeReportPath: request.inputPaths.judgeReportPath,
    judgeExtensionBlock: request.judgePlan.judgeExtensionBlock,
    sessionReports: request.judgePlan.sessionReports,
  })

  const referencePaths = [
    request.workspace.root,
    request.inputPaths.baselinePath,
    request.inputPaths.expectedPath,
    request.inputPaths.actualPath,
    request.inputPaths.evaluationPath,
    request.inputPaths.actionTracePath,
    request.inputPaths.routingPath,
    judgeSkillsRoot,
    judgeSkillsIndexPath,
    ...request.judgePlan.sessionReports.map((item) => item.absolutePath),
    ...request.hardCheckArtifacts.map((item) => item.outputPath),
  ]

  const task = await runOpencodeTask({
    cwd: request.cwd,
    config: request.config,
    title: `auto-evolve soft judge ${request.loadedCase.spec.id} attempt ${request.judgePlan.attempt}`,
    prompt,
    referencePaths,
    permissionReadPaths: referencePaths,
    permissionEditPaths: [path.dirname(request.inputPaths.judgeSummaryPath)],
    model: execution.model,
    agent: execution.agent,
    variant: execution.variant,
  })

  let summary: SoftJudgeSummary | undefined
  if (await pathExists(request.inputPaths.judgeSummaryPath)) {
    summary = await readJsonFile<SoftJudgeSummary>(request.inputPaths.judgeSummaryPath)
  }

  return {
    prompt,
    task,
    summaryPath: request.inputPaths.judgeSummaryPath,
    reportPath: request.inputPaths.judgeReportPath,
    hardCheckIndexPath: request.hardCheckArtifacts.length
      ? path.join(path.dirname(request.inputPaths.judgeSummaryPath), "hard-checks", "hard_checks_index.json")
      : undefined,
    hardCheckArtifacts: request.hardCheckArtifacts,
    summary,
  }
}
