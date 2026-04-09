import path from "node:path"
import {
  buildRefineRoutingBlock,
  classifyRefineRouting,
  selectRegressionCases,
} from "./acceptance"
import { evaluateResult, type EvaluationResult } from "./evaluator"
import { ensureDirectory, readTextFile, runDirectory, writeJsonFile, writeTextFile, autoEvolvePath } from "./fs"
import { loadDatasetSplit, type DatasetSplitName } from "./dataset-split"
import {
  diffKnowledgePack,
  knowledgePackPaths,
  readKnowledgePack,
  restoreKnowledgePack,
  writeKnowledgePackSnapshot,
} from "./knowledge-pack"
import { resolveModelSelection } from "./model-selection"
import { runOpencodeTask, type OpencodeTaskRun } from "./opencode"
import { buildRefinePrompt, buildSolvePrompt } from "./prompts"
import { loadAllCases, loadCaseByID, loadConfig, type LoadedCase, type ModelPhase } from "./schema"
import { buildActionTrace } from "./action-trace"

export interface AttemptSummary {
  attempt: number
  solveSessionID?: string
  solveExitCode: number
  passed: boolean
  knowledgePackChangedDuringSolve: boolean
  knowledgePackChangedFilesDuringSolve: string[]
  refineSessionID?: string
  refineExitCode?: number
  refineRoutingClass?: string
  refineAllowedFiles?: string[]
  knowledgePackChangedByRefine?: boolean
  knowledgePackChangedFilesByRefine?: string[]
  acceptancePassed?: boolean
  acceptanceRejected?: boolean
  acceptanceRejectionReasons?: string[]
  currentCaseVerificationPassed?: boolean
  regressionCaseIDs?: string[]
  regressionPassedBeforeRefine?: number
  regressionPassedAfterRefine?: number
}

export interface RunCaseResult {
  runDir: string
  caseID: string
  methodID: string
  mode: "learn" | "eval"
  split: DatasetSplitName
  evaluation: EvaluationResult
  attempts: AttemptSummary[]
}

function makeRunID(caseID: string) {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`
  return `${stamp}-${caseID}`
}

function attemptDir(runDir: string, attempt: number) {
  return path.join(runDir, `attempt-${String(attempt).padStart(2, "0")}`)
}

async function writeTaskArtifacts(stageDir: string, task: OpencodeTaskRun) {
  await ensureDirectory(stageDir)
  await writeTextFile(path.join(stageDir, "prompt.txt"), task.prompt + "\n")
  await writeTextFile(path.join(stageDir, "stdout.log"), task.result.stdout)
  await writeTextFile(path.join(stageDir, "stderr.log"), task.result.stderr)
  await writeTextFile(path.join(stageDir, "response.txt"), (task.result.responseText || "").trim() + "\n")
  await writeTextFile(path.join(stageDir, "action_trace.md"), buildActionTrace(task.result.events))
  await writeJsonFile(path.join(stageDir, "events.json"), task.result.events)
  await writeJsonFile(path.join(stageDir, "tool_failures.json"), task.result.toolFailures)
  await writeJsonFile(path.join(stageDir, "run.json"), {
    title: task.title,
    sessionID: task.result.sessionID,
    exitCode: task.result.exitCode,
    model: task.selectedModel ?? null,
    agent: task.selectedAgent ?? null,
    variant: task.selectedVariant ?? null,
    referencedPaths: task.referencedPaths,
    attachedFiles: task.attachedFiles,
    permissionReadPaths: task.permissionReadPaths,
    permissionEditPaths: task.permissionEditPaths,
  })
}

function markSolvePhaseViolation(evaluation: EvaluationResult) {
  evaluation.passed = false
  evaluation.summary = `${evaluation.summary} Solve phase violated the read-only knowledge-pack contract.`
  evaluation.mismatches.push("Solve phase modified one or more knowledge-pack files, which is not allowed.")
}

interface SolveStageResult {
  task: OpencodeTaskRun
  evaluation: EvaluationResult
  knowledgePackChangedDuringSolve: boolean
  knowledgePackChangedFilesDuringSolve: string[]
}

function absoluteKnowledgeFiles(knowledgePackRoot: string, relativeFiles: string[]) {
  return relativeFiles.map((item) => path.join(knowledgePackRoot, ...item.split("/")))
}

interface RegressionCaseSummary {
  caseID: string
  passed: boolean
  summary: string
  exitCode: number
  toolFailureCount: number
  solveSessionID?: string
}

async function executeSolveStage(input: {
  cwd: string
  config: Awaited<ReturnType<typeof loadConfig>>
  methodID: string
  loadedCase: LoadedCase
  expectedText: string
  knowledgePack: ReturnType<typeof knowledgePackPaths>
  baselinePath: string
  scriptsDir: string
  stageDir: string
  title: string
  phase: ModelPhase
}): Promise<SolveStageResult> {
  const materialPaths = input.loadedCase.spec.materials.map((item) => path.join(input.loadedCase.caseDir, item.path))
  const knowledgePackBeforeSolve = await readKnowledgePack(input.knowledgePack)
  const execution = resolveModelSelection(input.config, input.phase, input.loadedCase.spec.execution)

  const solveTask = await runOpencodeTask({
    cwd: input.cwd,
    config: input.config,
    title: input.title,
    prompt: await buildSolvePrompt({
      cwd: input.cwd,
      config: input.config,
      methodID: input.methodID,
      caseSpec: input.loadedCase.spec,
      caseDir: input.loadedCase.caseDir,
      knowledgePack: input.knowledgePack,
      baselinePath: input.baselinePath,
      scriptsDir: input.scriptsDir,
    }),
    referencePaths: [input.knowledgePack.root, ...input.knowledgePack.files, input.baselinePath, input.scriptsDir, ...materialPaths],
    permissionReadPaths: [
      input.knowledgePack.root,
      ...input.knowledgePack.files,
      input.baselinePath,
      input.scriptsDir,
      ...materialPaths,
    ],
    permissionEditPaths: [],
    model: execution.model,
    agent: execution.agent,
    variant: execution.variant,
  })

  const knowledgePackRawAfterSolve = await readKnowledgePack(input.knowledgePack)
  const knowledgePackChangedFilesDuringSolve = diffKnowledgePack(knowledgePackBeforeSolve, knowledgePackRawAfterSolve)
  const knowledgePackChangedDuringSolve = knowledgePackChangedFilesDuringSolve.length > 0
  if (knowledgePackChangedDuringSolve) {
    await restoreKnowledgePack(input.knowledgePack, knowledgePackBeforeSolve)
  }

  const evaluation = evaluateResult({
    mode: input.loadedCase.spec.expected.mode,
    actualText: solveTask.result.responseText,
    expectedText: input.expectedText,
    toolFailures: solveTask.result.toolFailures,
    exitCode: solveTask.result.exitCode,
  })
  if (knowledgePackChangedDuringSolve) {
    markSolvePhaseViolation(evaluation)
  }

  await writeTaskArtifacts(input.stageDir, solveTask)
  await writeJsonFile(path.join(input.stageDir, "evaluation.json"), evaluation)

  return {
    task: solveTask,
    evaluation,
    knowledgePackChangedDuringSolve,
    knowledgePackChangedFilesDuringSolve,
  }
}

async function runRegressionSuite(input: {
  cwd: string
  config: Awaited<ReturnType<typeof loadConfig>>
  methodID: string
  knowledgePack: ReturnType<typeof knowledgePackPaths>
  baselinePath: string
  scriptsDir: string
  cases: LoadedCase[]
  suiteDir: string
  titlePrefix: string
}) {
  const results: RegressionCaseSummary[] = []
  await ensureDirectory(input.suiteDir)

  for (const item of input.cases) {
    const expectedPath = path.join(item.caseDir, item.spec.expected.path)
    const expectedText = await readTextFile(expectedPath)
    const stageDir = path.join(input.suiteDir, item.spec.id)
    const stage = await executeSolveStage({
      cwd: input.cwd,
      config: input.config,
      methodID: input.methodID,
      loadedCase: item,
      expectedText,
      knowledgePack: input.knowledgePack,
      baselinePath: input.baselinePath,
      scriptsDir: input.scriptsDir,
      stageDir,
      title: `${input.titlePrefix} ${item.spec.id}`,
      phase: "regression",
    })

    results.push({
      caseID: item.spec.id,
      passed: stage.evaluation.passed,
      summary: stage.evaluation.summary,
      exitCode: stage.task.result.exitCode,
      toolFailureCount: stage.task.result.toolFailures.length,
      solveSessionID: stage.task.result.sessionID,
    })
  }

  return {
    cases: results,
    passedCount: results.filter((item) => item.passed).length,
    failedCount: results.filter((item) => !item.passed).length,
  }
}

function collectRegressionLosses(before: RegressionCaseSummary[], after: RegressionCaseSummary[]) {
  const afterMap = new Map(after.map((item) => [item.caseID, item]))
  return before
    .filter((item) => item.passed && !afterMap.get(item.caseID)?.passed)
    .map((item) => item.caseID)
    .sort((left, right) => left.localeCompare(right))
}

export async function runCase(
  cwd: string,
  caseID: string,
  options?: { methodID?: string; mode?: "learn" | "eval"; split?: DatasetSplitName },
): Promise<RunCaseResult> {
  const config = await loadConfig(cwd)
  const loaded = await loadCaseByID(cwd, config, caseID)
  const expectedPath = path.join(loaded.caseDir, loaded.spec.expected.path)
  const expectedText = await readTextFile(expectedPath)
  const knowledgePack = knowledgePackPaths(cwd, config)
  const baselinePath = autoEvolvePath(cwd, config.baselineFile)
  const scriptsDir = autoEvolvePath(cwd, config.scriptsDir)
  const datasetSplit = await loadDatasetSplit(cwd, config)
  const allCases = await loadAllCases(cwd, config)
  const methodID = options?.methodID ?? config.defaultMethod
  const mode = options?.mode ?? "learn"
  const split = options?.split ?? "all"

  const runID = makeRunID(caseID)
  const runDir = runDirectory(cwd, config, runID)
  await ensureDirectory(runDir)

  let finalEvaluation: EvaluationResult | undefined
  let stopReason: string | undefined
  const attempts: AttemptSummary[] = []

  await writeKnowledgePackSnapshot(path.join(runDir, "knowledge_pack.initial"), await readKnowledgePack(knowledgePack))

  for (let attempt = 1; attempt <= config.maxRetriesPerCase; attempt++) {
    const currentAttemptDir = attemptDir(runDir, attempt)
    const solveDir = path.join(currentAttemptDir, "solve")
    const refineDir = path.join(currentAttemptDir, "refine")
    const refineInputDir = path.join(currentAttemptDir, "refine-input")
    const acceptanceDir = path.join(currentAttemptDir, "acceptance")

    const knowledgePackBeforeSolve = await readKnowledgePack(knowledgePack)
    await writeKnowledgePackSnapshot(path.join(currentAttemptDir, "knowledge_pack.before_solve"), knowledgePackBeforeSolve)

    const solveStage = await executeSolveStage({
      cwd,
      config,
      methodID,
      loadedCase: loaded,
      expectedText,
      knowledgePack,
      baselinePath,
      scriptsDir,
      stageDir: solveDir,
      title: `auto-evolve solve ${caseID} attempt ${attempt}`,
      phase: "solve",
    })
    const solveTask = solveStage.task
    const evaluation = solveStage.evaluation
    await writeKnowledgePackSnapshot(path.join(currentAttemptDir, "knowledge_pack.after_solve"), await readKnowledgePack(knowledgePack))

    const attemptSummary: AttemptSummary = {
      attempt,
      solveSessionID: solveTask.result.sessionID,
      solveExitCode: solveTask.result.exitCode,
      passed: evaluation.passed,
      knowledgePackChangedDuringSolve: solveStage.knowledgePackChangedDuringSolve,
      knowledgePackChangedFilesDuringSolve: solveStage.knowledgePackChangedFilesDuringSolve,
    }
    attempts.push(attemptSummary)
    finalEvaluation = evaluation

    if (evaluation.passed) {
      stopReason = "case passed"
      break
    }

    if (mode === "eval") {
      stopReason = "evaluation mode stops after solve"
      break
    }

    if (attempt >= config.maxRetriesPerCase) {
      stopReason = "max retries reached"
      break
    }

    await ensureDirectory(refineInputDir)
    await ensureDirectory(acceptanceDir)
    const actualOutputPath = path.join(refineInputDir, "actual_output.txt")
    const evaluationPath = path.join(refineInputDir, "evaluation.json")
    const actionTracePath = path.join(refineInputDir, "action_trace.md")
    const routing = classifyRefineRouting({
      mode: loaded.spec.expected.mode,
      actualText: solveTask.result.responseText,
      expectedText,
      evaluation,
    })
    attemptSummary.refineRoutingClass = routing.classification
    attemptSummary.refineAllowedFiles = routing.allowedFiles
    await writeJsonFile(path.join(acceptanceDir, "routing.json"), routing)
    await writeTextFile(actualOutputPath, (solveTask.result.responseText || "").trim() + "\n")
    await writeJsonFile(evaluationPath, evaluation)
    await writeTextFile(actionTracePath, buildActionTrace(solveTask.result.events))

    const regressionCases = selectRegressionCases(allCases, datasetSplit, loaded.spec.id, config.regressionSampleSize)
    attemptSummary.regressionCaseIDs = regressionCases.map((item) => item.spec.id)
    const baselineRegression = await runRegressionSuite({
      cwd,
      config,
      methodID,
      knowledgePack,
      baselinePath,
      scriptsDir,
      cases: regressionCases,
      suiteDir: path.join(acceptanceDir, "regression-before-refine"),
      titlePrefix: `auto-evolve regression before refine ${caseID} attempt ${attempt}`,
    })
    attemptSummary.regressionPassedBeforeRefine = baselineRegression.passedCount
    await writeJsonFile(path.join(acceptanceDir, "regression-before-refine.summary.json"), baselineRegression)

    const knowledgePackBeforeRefine = await readKnowledgePack(knowledgePack)
    await writeKnowledgePackSnapshot(path.join(currentAttemptDir, "knowledge_pack.before_refine"), knowledgePackBeforeRefine)
    const refineExecution = resolveModelSelection(config, "refine", loaded.spec.execution)

    const refineTask = await runOpencodeTask({
      cwd,
      config,
      title: `auto-evolve refine ${caseID} attempt ${attempt}`,
      prompt: await buildRefinePrompt({
        cwd,
        config,
        methodID,
        caseSpec: loaded.spec,
        caseDir: loaded.caseDir,
        knowledgePack,
        baselinePath,
        scriptsDir,
        expectedPath,
        actualPath: actualOutputPath,
        evaluationPath,
        actionTracePath,
        attempt,
        refineRoutingBlock: buildRefineRoutingBlock(routing),
      }),
      referencePaths: [
        knowledgePack.root,
        ...knowledgePack.files,
        baselinePath,
        scriptsDir,
        ...loaded.spec.materials.map((item) => path.join(loaded.caseDir, item.path)),
        expectedPath,
        actualOutputPath,
        evaluationPath,
        actionTracePath,
      ],
      permissionReadPaths: [
        knowledgePack.root,
        ...knowledgePack.files,
        baselinePath,
        scriptsDir,
        ...loaded.spec.materials.map((item) => path.join(loaded.caseDir, item.path)),
        expectedPath,
        actualOutputPath,
        evaluationPath,
        actionTracePath,
      ],
      permissionEditPaths: absoluteKnowledgeFiles(knowledgePack.root, routing.allowedFiles),
      model: refineExecution.model,
      agent: refineExecution.agent,
      variant: refineExecution.variant,
    })

    const knowledgePackAfterRefine = await readKnowledgePack(knowledgePack)
    const knowledgePackChangedFilesByRefine = diffKnowledgePack(knowledgePackBeforeRefine, knowledgePackAfterRefine)
    const knowledgePackChangedByRefine = knowledgePackChangedFilesByRefine.length > 0
    attemptSummary.refineSessionID = refineTask.result.sessionID
    attemptSummary.refineExitCode = refineTask.result.exitCode
    attemptSummary.knowledgePackChangedByRefine = knowledgePackChangedByRefine
    attemptSummary.knowledgePackChangedFilesByRefine = knowledgePackChangedFilesByRefine

    await writeTaskArtifacts(refineDir, refineTask)
    await writeJsonFile(path.join(refineDir, "refine_summary.json"), {
      knowledgePackChangedByRefine,
      knowledgePackChangedFilesByRefine,
      routing,
      basedOnAttempt: attempt,
      evaluationPath,
      actualOutputPath,
      actionTracePath,
      expectedPath,
    })
    await writeKnowledgePackSnapshot(path.join(currentAttemptDir, "knowledge_pack.after_refine"), knowledgePackAfterRefine)

    if (refineTask.result.exitCode !== 0) {
      stopReason = "refine phase failed"
      break
    }

    if (!knowledgePackChangedByRefine) {
      stopReason = "refine phase produced no knowledge-pack update"
      break
    }

    const outOfPolicyFiles = knowledgePackChangedFilesByRefine.filter((item) => !routing.allowedFiles.includes(item))
    if (outOfPolicyFiles.length > 0) {
      await restoreKnowledgePack(knowledgePack, knowledgePackBeforeRefine)
      await writeKnowledgePackSnapshot(
        path.join(currentAttemptDir, "knowledge_pack.after_acceptance_rollback"),
        await readKnowledgePack(knowledgePack),
      )
      attemptSummary.acceptancePassed = false
      attemptSummary.acceptanceRejected = true
      attemptSummary.acceptanceRejectionReasons = [
        `Refine modified disallowed knowledge-pack files: ${outOfPolicyFiles.join(", ")}`,
      ]
      await writeJsonFile(path.join(acceptanceDir, "acceptance.json"), {
        accepted: false,
        reason: "out_of_policy_files",
        routing,
        changedFiles: knowledgePackChangedFilesByRefine,
        outOfPolicyFiles,
      })
      continue
    }

    const currentCaseVerification = await executeSolveStage({
      cwd,
      config,
      methodID,
      loadedCase: loaded,
      expectedText,
      knowledgePack,
      baselinePath,
      scriptsDir,
      stageDir: path.join(acceptanceDir, "current-case-verify"),
      title: `auto-evolve current case verify ${caseID} attempt ${attempt}`,
      phase: "verify",
    })
    attemptSummary.currentCaseVerificationPassed = currentCaseVerification.evaluation.passed

    if (!currentCaseVerification.evaluation.passed) {
      await restoreKnowledgePack(knowledgePack, knowledgePackBeforeRefine)
      await writeKnowledgePackSnapshot(
        path.join(currentAttemptDir, "knowledge_pack.after_acceptance_rollback"),
        await readKnowledgePack(knowledgePack),
      )
      attemptSummary.acceptancePassed = false
      attemptSummary.acceptanceRejected = true
      attemptSummary.acceptanceRejectionReasons = [
        "The refined knowledge-pack still failed to solve the current case during verification.",
      ]
      await writeJsonFile(path.join(acceptanceDir, "acceptance.json"), {
        accepted: false,
        reason: "current_case_not_fixed",
        routing,
        changedFiles: knowledgePackChangedFilesByRefine,
        currentCaseVerification: currentCaseVerification.evaluation,
      })
      continue
    }

    const afterRegression = await runRegressionSuite({
      cwd,
      config,
      methodID,
      knowledgePack,
      baselinePath,
      scriptsDir,
      cases: regressionCases,
      suiteDir: path.join(acceptanceDir, "regression-after-refine"),
      titlePrefix: `auto-evolve regression after refine ${caseID} attempt ${attempt}`,
    })
    attemptSummary.regressionPassedAfterRefine = afterRegression.passedCount
    await writeJsonFile(path.join(acceptanceDir, "regression-after-refine.summary.json"), afterRegression)

    const regressionLosses = collectRegressionLosses(baselineRegression.cases, afterRegression.cases)
    if (afterRegression.passedCount < baselineRegression.passedCount || regressionLosses.length > 0) {
      await restoreKnowledgePack(knowledgePack, knowledgePackBeforeRefine)
      await writeKnowledgePackSnapshot(
        path.join(currentAttemptDir, "knowledge_pack.after_acceptance_rollback"),
        await readKnowledgePack(knowledgePack),
      )
      const rejectionReasons: string[] = []
      if (afterRegression.passedCount < baselineRegression.passedCount) {
        rejectionReasons.push(
          `Regression pass count dropped from ${baselineRegression.passedCount} to ${afterRegression.passedCount}.`,
        )
      }
      if (regressionLosses.length > 0) {
        rejectionReasons.push(`Previously passing regression cases failed after refine: ${regressionLosses.join(", ")}`)
      }
      attemptSummary.acceptancePassed = false
      attemptSummary.acceptanceRejected = true
      attemptSummary.acceptanceRejectionReasons = rejectionReasons
      await writeJsonFile(path.join(acceptanceDir, "acceptance.json"), {
        accepted: false,
        reason: "regression_loss",
        routing,
        changedFiles: knowledgePackChangedFilesByRefine,
        currentCaseVerification: currentCaseVerification.evaluation,
        regressionBefore: baselineRegression,
        regressionAfter: afterRegression,
        regressionLosses,
      })
      continue
    }

    attemptSummary.acceptancePassed = true
    await writeJsonFile(path.join(acceptanceDir, "acceptance.json"), {
      accepted: true,
      reason: "accepted",
      routing,
      changedFiles: knowledgePackChangedFilesByRefine,
      currentCaseVerification: currentCaseVerification.evaluation,
      regressionBefore: baselineRegression,
      regressionAfter: afterRegression,
      regressionLosses: [],
    })
    await writeKnowledgePackSnapshot(path.join(currentAttemptDir, "knowledge_pack.after_acceptance"), await readKnowledgePack(knowledgePack))

    finalEvaluation = currentCaseVerification.evaluation
    stopReason = "case passed after accepted refine"
    break
  }

  if (!finalEvaluation) {
    throw new Error(`Case ${caseID} did not produce any evaluation result.`)
  }

  await writeJsonFile(path.join(runDir, "run.json"), {
    runID,
    caseID,
    methodID,
    mode,
    split,
    attempts,
    finalPassed: finalEvaluation.passed,
    stopReason: stopReason ?? null,
    maxRetriesPerCase: config.maxRetriesPerCase,
    expectedPath,
    knowledgePackRoot: knowledgePack.root,
    knowledgePackFiles: knowledgePack.files,
  })

  return {
    runDir,
    caseID,
    methodID,
    mode,
    split,
    evaluation: finalEvaluation,
    attempts,
  }
}
