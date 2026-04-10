import path from "node:path"
import { evaluateResult } from "../evaluator"
import {
  readExperienceWorkspace,
  resolveExperienceWorkspaceLayout,
  restoreExperienceWorkspace,
  writeExperienceWorkspaceSnapshot,
} from "../experience-workspace"
import { resolveModelSelection } from "../model-selection"
import { runOpencodeTask } from "../opencode"
import { buildSolvePrompt } from "../prompts"
import { writeJsonFile } from "../fs"
import { writeTaskArtifacts } from "../task-artifacts"
import { markSolvePhaseViolation, type CaseRuntimeContext, type SolveStageResult } from "../case-runtime"
import type { MethodStrategyDecision } from "../method-strategies"

export async function executeSolveStage(input: {
  context: CaseRuntimeContext
  stageDir: string
  title: string
  phase: "solve" | "verify" | "regression"
}): Promise<SolveStageResult> {
  const { context } = input
  const materialPaths = context.loaded.spec.materials.map((item) => path.join(context.loaded.caseDir, item.path))
  const workspaceBeforeSolve = await readExperienceWorkspace(context.workspace)
  const execution = resolveModelSelection(context.config, input.phase, context.loaded.spec.execution)

  const solveTask = await runOpencodeTask({
    cwd: context.cwd,
    config: context.config,
    title: input.title,
    prompt: await buildSolvePrompt({
      cwd: context.cwd,
      config: context.config,
      methodID: context.methodID,
      caseSpec: context.loaded.spec,
      caseDir: context.loaded.caseDir,
      workspace: context.workspace,
      baselinePath: context.baselinePath,
      scriptsDir: context.scriptsDir,
    }),
    referencePaths: [context.workspace.root, context.workspace.entryPath, context.baselinePath, context.scriptsDir, ...materialPaths],
    permissionReadPaths: [context.workspace.root, context.workspace.entryPath, context.baselinePath, context.scriptsDir, ...materialPaths],
    permissionEditPaths: [],
    model: execution.model,
    agent: execution.agent,
    variant: execution.variant,
  })

  const workspaceAfterSolve = await readExperienceWorkspace(context.workspace)
  const knowledgePackChangedFilesDuringSolve = Object.keys({
    ...workspaceBeforeSolve,
    ...workspaceAfterSolve,
  })
    .filter((relative) => (workspaceBeforeSolve[relative] ?? "") !== (workspaceAfterSolve[relative] ?? ""))
    .sort((left, right) => left.localeCompare(right))
  const knowledgePackChangedDuringSolve = knowledgePackChangedFilesDuringSolve.length > 0
  if (knowledgePackChangedDuringSolve) {
    await restoreExperienceWorkspace(context.workspace, workspaceBeforeSolve)
  }

  const evaluation = evaluateResult({
    mode: context.loaded.spec.expected.mode,
    actualText: solveTask.result.responseText,
    expectedText: context.expectedText,
    toolFailures: solveTask.result.toolFailures,
    exitCode: solveTask.result.exitCode,
  })
  if (knowledgePackChangedDuringSolve) {
    markSolvePhaseViolation(evaluation)
  }

  const artifactPaths = await writeTaskArtifacts(input.stageDir, solveTask, {
    phase: input.phase,
    caseID: context.loaded.spec.id,
    attempt: context.attempt,
    methodID: context.methodID,
    evaluation,
  })
  await writeJsonFile(path.join(input.stageDir, "evaluation.json"), evaluation)

  context.workspace = await resolveExperienceWorkspaceLayout(context.workspacePaths)

  return {
    task: solveTask,
    evaluation,
    sessionExecutionReportPath: artifactPaths.sessionExecutionReportPath,
    knowledgePackChangedDuringSolve,
    knowledgePackChangedFilesDuringSolve,
  }
}

export async function solveCasePrimitive(context: CaseRuntimeContext) {
  const workspaceBeforeSolve = await readExperienceWorkspace(context.workspace)
  await writeExperienceWorkspaceSnapshot(path.join(context.currentAttemptDir, "experience_workspace.before_solve"), workspaceBeforeSolve)

  const solveStage = await executeSolveStage({
    context,
    stageDir: context.solveDir,
    title: `auto-evolve solve ${context.loaded.spec.id} attempt ${context.attempt}`,
    phase: "solve",
  })

  context.solveStage = solveStage
  context.solveTask = solveStage.task
  context.evaluation = solveStage.evaluation
  context.finalEvaluation = solveStage.evaluation

  await writeExperienceWorkspaceSnapshot(
    path.join(context.currentAttemptDir, "experience_workspace.after_solve"),
    await readExperienceWorkspace(context.workspace),
  )

  context.attemptSummary.solveSessionID = solveStage.task.result.sessionID
  context.attemptSummary.solveSessionExecutionReportPath = solveStage.sessionExecutionReportPath
  context.attemptSummary.solveExitCode = solveStage.task.result.exitCode
  context.attemptSummary.passed = solveStage.evaluation.passed
  context.attemptSummary.knowledgePackChangedDuringSolve = solveStage.knowledgePackChangedDuringSolve
  context.attemptSummary.knowledgePackChangedFilesDuringSolve = solveStage.knowledgePackChangedFilesDuringSolve
}

export async function finishIfPassedPrimitive(
  context: CaseRuntimeContext,
): Promise<Exclude<MethodStrategyDecision, "continue"> | null> {
  if (!context.evaluation?.passed) return null
  context.stopReason = "case passed"
  return "finish_run"
}

export async function finishIfEvalModePrimitive(
  context: CaseRuntimeContext,
): Promise<Exclude<MethodStrategyDecision, "continue"> | null> {
  if (context.mode !== "eval") return null
  context.stopReason = "evaluation mode stops after solve"
  return "finish_run"
}

export async function finishIfMaxRetriesReachedPrimitive(
  context: CaseRuntimeContext,
): Promise<Exclude<MethodStrategyDecision, "continue"> | null> {
  if (context.attempt < context.config.maxRetriesPerCase) return null
  context.stopReason = "max retries reached"
  return "finish_run"
}
