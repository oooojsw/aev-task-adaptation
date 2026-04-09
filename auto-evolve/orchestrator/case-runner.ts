import path from "node:path"
import {
  buildRefineRoutingBlock,
  classifyRefineRouting,
  selectRegressionCases,
  type RefineRouting,
} from "./acceptance"
import { evaluateResult, type EvaluationResult } from "./evaluator"
import { ensureDirectory, readTextFile, runDirectory, writeJsonFile, writeTextFile, autoEvolvePath } from "./fs"
import { loadDatasetSplit, type DatasetSplitName } from "./dataset-split"
import {
  diffKnowledgePack,
  knowledgePackPaths,
  type KnowledgePackPaths,
  type KnowledgePackSnapshot,
  readKnowledgePack,
  restoreKnowledgePack,
  writeKnowledgePackSnapshot,
} from "./knowledge-pack"
import { executeMethodFlow } from "./method-runtime"
import { methodPaths, readMethodFlow, type MethodFlow } from "./methods"
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

interface CaseRuntimeContext {
  cwd: string
  config: Awaited<ReturnType<typeof loadConfig>>
  methodID: string
  methodFlow: MethodFlow
  loaded: LoadedCase
  expectedPath: string
  expectedText: string
  knowledgePack: KnowledgePackPaths
  baselinePath: string
  scriptsDir: string
  datasetSplit: Awaited<ReturnType<typeof loadDatasetSplit>>
  allCases: LoadedCase[]
  mode: "learn" | "eval"
  runDir: string
  attempt: number
  currentAttemptDir: string
  solveDir: string
  refineDir: string
  refineInputDir: string
  acceptanceDir: string
  attempts: AttemptSummary[]
  attemptSummary: AttemptSummary
  finalEvaluation?: EvaluationResult
  stopReason?: string
  solveStage?: SolveStageResult
  solveTask?: OpencodeTaskRun
  evaluation?: EvaluationResult
  actualOutputPath?: string
  evaluationPath?: string
  actionTracePath?: string
  routing?: RefineRouting
  regressionCases?: LoadedCase[]
  baselineRegression?: Awaited<ReturnType<typeof runRegressionSuite>>
  knowledgePackBeforeRefine?: KnowledgePackSnapshot
  refineTask?: OpencodeTaskRun
  knowledgePackAfterRefine?: KnowledgePackSnapshot
  knowledgePackChangedByRefine?: boolean
  knowledgePackChangedFilesByRefine?: string[]
  currentCaseVerification?: SolveStageResult
  afterRegression?: Awaited<ReturnType<typeof runRegressionSuite>>
}

function createAttemptContext(input: {
  cwd: string
  config: Awaited<ReturnType<typeof loadConfig>>
  methodID: string
  methodFlow: MethodFlow
  loaded: LoadedCase
  expectedPath: string
  expectedText: string
  knowledgePack: KnowledgePackPaths
  baselinePath: string
  scriptsDir: string
  datasetSplit: Awaited<ReturnType<typeof loadDatasetSplit>>
  allCases: LoadedCase[]
  mode: "learn" | "eval"
  runDir: string
  attempt: number
  attempts: AttemptSummary[]
  finalEvaluation?: EvaluationResult
  stopReason?: string
}) {
  const currentAttemptDir = attemptDir(input.runDir, input.attempt)
  const solveDir = path.join(currentAttemptDir, "solve")
  const refineDir = path.join(currentAttemptDir, "refine")
  const refineInputDir = path.join(currentAttemptDir, "refine-input")
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
    currentAttemptDir,
    solveDir,
    refineDir,
    refineInputDir,
    acceptanceDir,
    attemptSummary,
  } satisfies CaseRuntimeContext
}

async function buildCaseRuntimeHandlers(context: CaseRuntimeContext) {
  return {
    solve_case: async () => {
      const knowledgePackBeforeSolve = await readKnowledgePack(context.knowledgePack)
      await writeKnowledgePackSnapshot(path.join(context.currentAttemptDir, "knowledge_pack.before_solve"), knowledgePackBeforeSolve)

      const solveStage = await executeSolveStage({
        cwd: context.cwd,
        config: context.config,
        methodID: context.methodID,
        loadedCase: context.loaded,
        expectedText: context.expectedText,
        knowledgePack: context.knowledgePack,
        baselinePath: context.baselinePath,
        scriptsDir: context.scriptsDir,
        stageDir: context.solveDir,
        title: `auto-evolve solve ${context.loaded.spec.id} attempt ${context.attempt}`,
        phase: "solve",
      })

      context.solveStage = solveStage
      context.solveTask = solveStage.task
      context.evaluation = solveStage.evaluation
      context.finalEvaluation = solveStage.evaluation

      await writeKnowledgePackSnapshot(
        path.join(context.currentAttemptDir, "knowledge_pack.after_solve"),
        await readKnowledgePack(context.knowledgePack),
      )

      context.attemptSummary.solveSessionID = solveStage.task.result.sessionID
      context.attemptSummary.solveExitCode = solveStage.task.result.exitCode
      context.attemptSummary.passed = solveStage.evaluation.passed
      context.attemptSummary.knowledgePackChangedDuringSolve = solveStage.knowledgePackChangedDuringSolve
      context.attemptSummary.knowledgePackChangedFilesDuringSolve = solveStage.knowledgePackChangedFilesDuringSolve
    },

    finish_if_passed: async () => {
      if (!context.evaluation?.passed) return
      context.stopReason = "case passed"
      return { decision: "finish_run" as const }
    },

    finish_if_eval_mode: async () => {
      if (context.mode !== "eval") return
      context.stopReason = "evaluation mode stops after solve"
      return { decision: "finish_run" as const }
    },

    finish_if_max_retries_reached: async () => {
      if (context.attempt < context.config.maxRetriesPerCase) return
      context.stopReason = "max retries reached"
      return { decision: "finish_run" as const }
    },

    prepare_refine_feedback: async () => {
      if (!context.solveTask || !context.evaluation) {
        throw new Error("prepare_refine_feedback requires a completed solve stage.")
      }

      await ensureDirectory(context.refineInputDir)
      await ensureDirectory(context.acceptanceDir)

      const actualOutputPath = path.join(context.refineInputDir, "actual_output.txt")
      const evaluationPath = path.join(context.refineInputDir, "evaluation.json")
      const actionTracePath = path.join(context.refineInputDir, "action_trace.md")
      const routing = classifyRefineRouting({
        mode: context.loaded.spec.expected.mode,
        actualText: context.solveTask.result.responseText,
        expectedText: context.expectedText,
        evaluation: context.evaluation,
      })

      context.actualOutputPath = actualOutputPath
      context.evaluationPath = evaluationPath
      context.actionTracePath = actionTracePath
      context.routing = routing
      context.attemptSummary.refineRoutingClass = routing.classification
      context.attemptSummary.refineAllowedFiles = routing.allowedFiles

      await writeJsonFile(path.join(context.acceptanceDir, "routing.json"), routing)
      await writeTextFile(actualOutputPath, (context.solveTask.result.responseText || "").trim() + "\n")
      await writeJsonFile(evaluationPath, context.evaluation)
      await writeTextFile(actionTracePath, buildActionTrace(context.solveTask.result.events))
    },

    run_regression_before_refine: async () => {
      const regressionCases = selectRegressionCases(
        context.allCases,
        context.datasetSplit,
        context.loaded.spec.id,
        context.config.regressionSampleSize,
      )
      context.regressionCases = regressionCases
      context.attemptSummary.regressionCaseIDs = regressionCases.map((item) => item.spec.id)

      const baselineRegression = await runRegressionSuite({
        cwd: context.cwd,
        config: context.config,
        methodID: context.methodID,
        knowledgePack: context.knowledgePack,
        baselinePath: context.baselinePath,
        scriptsDir: context.scriptsDir,
        cases: regressionCases,
        suiteDir: path.join(context.acceptanceDir, "regression-before-refine"),
        titlePrefix: `auto-evolve regression before refine ${context.loaded.spec.id} attempt ${context.attempt}`,
      })

      context.baselineRegression = baselineRegression
      context.attemptSummary.regressionPassedBeforeRefine = baselineRegression.passedCount
      await writeJsonFile(path.join(context.acceptanceDir, "regression-before-refine.summary.json"), baselineRegression)
    },

    refine_knowledge: async () => {
      if (!context.routing || !context.actualOutputPath || !context.evaluationPath || !context.actionTracePath) {
        throw new Error("refine_knowledge requires prepared feedback artifacts.")
      }

      const knowledgePackBeforeRefine = await readKnowledgePack(context.knowledgePack)
      context.knowledgePackBeforeRefine = knowledgePackBeforeRefine
      await writeKnowledgePackSnapshot(path.join(context.currentAttemptDir, "knowledge_pack.before_refine"), knowledgePackBeforeRefine)
      const refineExecution = resolveModelSelection(context.config, "refine", context.loaded.spec.execution)

      const refineTask = await runOpencodeTask({
        cwd: context.cwd,
        config: context.config,
        title: `auto-evolve refine ${context.loaded.spec.id} attempt ${context.attempt}`,
        prompt: await buildRefinePrompt({
          cwd: context.cwd,
          config: context.config,
          methodID: context.methodID,
          caseSpec: context.loaded.spec,
          caseDir: context.loaded.caseDir,
          knowledgePack: context.knowledgePack,
          baselinePath: context.baselinePath,
          scriptsDir: context.scriptsDir,
          expectedPath: context.expectedPath,
          actualPath: context.actualOutputPath,
          evaluationPath: context.evaluationPath,
          actionTracePath: context.actionTracePath,
          attempt: context.attempt,
          refineRoutingBlock: buildRefineRoutingBlock(context.routing),
        }),
        referencePaths: [
          context.knowledgePack.root,
          ...context.knowledgePack.files,
          context.baselinePath,
          context.scriptsDir,
          ...context.loaded.spec.materials.map((item) => path.join(context.loaded.caseDir, item.path)),
          context.expectedPath,
          context.actualOutputPath,
          context.evaluationPath,
          context.actionTracePath,
        ],
        permissionReadPaths: [
          context.knowledgePack.root,
          ...context.knowledgePack.files,
          context.baselinePath,
          context.scriptsDir,
          ...context.loaded.spec.materials.map((item) => path.join(context.loaded.caseDir, item.path)),
          context.expectedPath,
          context.actualOutputPath,
          context.evaluationPath,
          context.actionTracePath,
        ],
        permissionEditPaths: absoluteKnowledgeFiles(context.knowledgePack.root, context.routing.allowedFiles),
        model: refineExecution.model,
        agent: refineExecution.agent,
        variant: refineExecution.variant,
      })

      const knowledgePackAfterRefine = await readKnowledgePack(context.knowledgePack)
      const knowledgePackChangedFilesByRefine = diffKnowledgePack(context.knowledgePackBeforeRefine, knowledgePackAfterRefine)
      const knowledgePackChangedByRefine = knowledgePackChangedFilesByRefine.length > 0

      context.refineTask = refineTask
      context.knowledgePackAfterRefine = knowledgePackAfterRefine
      context.knowledgePackChangedByRefine = knowledgePackChangedByRefine
      context.knowledgePackChangedFilesByRefine = knowledgePackChangedFilesByRefine

      context.attemptSummary.refineSessionID = refineTask.result.sessionID
      context.attemptSummary.refineExitCode = refineTask.result.exitCode
      context.attemptSummary.knowledgePackChangedByRefine = knowledgePackChangedByRefine
      context.attemptSummary.knowledgePackChangedFilesByRefine = knowledgePackChangedFilesByRefine

      await writeTaskArtifacts(context.refineDir, refineTask)
      await writeJsonFile(path.join(context.refineDir, "refine_summary.json"), {
        knowledgePackChangedByRefine,
        knowledgePackChangedFilesByRefine,
        routing: context.routing,
        basedOnAttempt: context.attempt,
        evaluationPath: context.evaluationPath,
        actualOutputPath: context.actualOutputPath,
        actionTracePath: context.actionTracePath,
        expectedPath: context.expectedPath,
      })
      await writeKnowledgePackSnapshot(path.join(context.currentAttemptDir, "knowledge_pack.after_refine"), knowledgePackAfterRefine)
    },

    reject_if_refine_failed: async () => {
      if (context.refineTask?.result.exitCode === 0) return
      context.stopReason = "refine phase failed"
      return { decision: "finish_run" as const }
    },

    reject_if_no_knowledge_change: async () => {
      if (context.knowledgePackChangedByRefine) return
      context.stopReason = "refine phase produced no knowledge-pack update"
      return { decision: "finish_run" as const }
    },

    reject_if_out_of_policy_files: async () => {
      if (!context.routing || !context.knowledgePackChangedFilesByRefine || !context.knowledgePackBeforeRefine) {
        throw new Error("reject_if_out_of_policy_files requires refine results and routing.")
      }

      const outOfPolicyFiles = context.knowledgePackChangedFilesByRefine.filter((item) => !context.routing?.allowedFiles.includes(item))
      if (!outOfPolicyFiles.length) return

      await restoreKnowledgePack(context.knowledgePack, context.knowledgePackBeforeRefine)
      await writeKnowledgePackSnapshot(
        path.join(context.currentAttemptDir, "knowledge_pack.after_acceptance_rollback"),
        await readKnowledgePack(context.knowledgePack),
      )
      context.attemptSummary.acceptancePassed = false
      context.attemptSummary.acceptanceRejected = true
      context.attemptSummary.acceptanceRejectionReasons = [
        `Refine modified disallowed knowledge-pack files: ${outOfPolicyFiles.join(", ")}`,
      ]
      await writeJsonFile(path.join(context.acceptanceDir, "acceptance.json"), {
        accepted: false,
        reason: "out_of_policy_files",
        routing: context.routing,
        changedFiles: context.knowledgePackChangedFilesByRefine,
        outOfPolicyFiles,
      })
      return { decision: "next_attempt" as const }
    },

    verify_current_case: async () => {
      const currentCaseVerification = await executeSolveStage({
        cwd: context.cwd,
        config: context.config,
        methodID: context.methodID,
        loadedCase: context.loaded,
        expectedText: context.expectedText,
        knowledgePack: context.knowledgePack,
        baselinePath: context.baselinePath,
        scriptsDir: context.scriptsDir,
        stageDir: path.join(context.acceptanceDir, "current-case-verify"),
        title: `auto-evolve current case verify ${context.loaded.spec.id} attempt ${context.attempt}`,
        phase: "verify",
      })

      context.currentCaseVerification = currentCaseVerification
      context.attemptSummary.currentCaseVerificationPassed = currentCaseVerification.evaluation.passed
    },

    reject_if_current_case_not_fixed: async () => {
      if (!context.currentCaseVerification || !context.knowledgePackBeforeRefine || !context.routing) {
        throw new Error("reject_if_current_case_not_fixed requires current-case verification and refine baseline.")
      }
      if (context.currentCaseVerification.evaluation.passed) return

      await restoreKnowledgePack(context.knowledgePack, context.knowledgePackBeforeRefine)
      await writeKnowledgePackSnapshot(
        path.join(context.currentAttemptDir, "knowledge_pack.after_acceptance_rollback"),
        await readKnowledgePack(context.knowledgePack),
      )
      context.attemptSummary.acceptancePassed = false
      context.attemptSummary.acceptanceRejected = true
      context.attemptSummary.acceptanceRejectionReasons = [
        "The refined knowledge-pack still failed to solve the current case during verification.",
      ]
      await writeJsonFile(path.join(context.acceptanceDir, "acceptance.json"), {
        accepted: false,
        reason: "current_case_not_fixed",
        routing: context.routing,
        changedFiles: context.knowledgePackChangedFilesByRefine ?? [],
        currentCaseVerification: context.currentCaseVerification.evaluation,
      })
      return { decision: "next_attempt" as const }
    },

    run_regression_after_refine: async () => {
      const afterRegression = await runRegressionSuite({
        cwd: context.cwd,
        config: context.config,
        methodID: context.methodID,
        knowledgePack: context.knowledgePack,
        baselinePath: context.baselinePath,
        scriptsDir: context.scriptsDir,
        cases: context.regressionCases ?? [],
        suiteDir: path.join(context.acceptanceDir, "regression-after-refine"),
        titlePrefix: `auto-evolve regression after refine ${context.loaded.spec.id} attempt ${context.attempt}`,
      })

      context.afterRegression = afterRegression
      context.attemptSummary.regressionPassedAfterRefine = afterRegression.passedCount
      await writeJsonFile(path.join(context.acceptanceDir, "regression-after-refine.summary.json"), afterRegression)
    },

    accept_or_reject_change: async () => {
      if (
        !context.routing ||
        !context.currentCaseVerification ||
        !context.afterRegression ||
        !context.baselineRegression ||
        !context.knowledgePackBeforeRefine ||
        !context.knowledgePackChangedFilesByRefine
      ) {
        throw new Error("accept_or_reject_change requires refine verification and regression state.")
      }

      const regressionLosses = collectRegressionLosses(context.baselineRegression.cases, context.afterRegression.cases)
      if (
        context.afterRegression.passedCount < context.baselineRegression.passedCount ||
        regressionLosses.length > 0
      ) {
        await restoreKnowledgePack(context.knowledgePack, context.knowledgePackBeforeRefine)
        await writeKnowledgePackSnapshot(
          path.join(context.currentAttemptDir, "knowledge_pack.after_acceptance_rollback"),
          await readKnowledgePack(context.knowledgePack),
        )
        const rejectionReasons: string[] = []
        if (context.afterRegression.passedCount < context.baselineRegression.passedCount) {
          rejectionReasons.push(
            `Regression pass count dropped from ${context.baselineRegression.passedCount} to ${context.afterRegression.passedCount}.`,
          )
        }
        if (regressionLosses.length > 0) {
          rejectionReasons.push(`Previously passing regression cases failed after refine: ${regressionLosses.join(", ")}`)
        }
        context.attemptSummary.acceptancePassed = false
        context.attemptSummary.acceptanceRejected = true
        context.attemptSummary.acceptanceRejectionReasons = rejectionReasons
        await writeJsonFile(path.join(context.acceptanceDir, "acceptance.json"), {
          accepted: false,
          reason: "regression_loss",
          routing: context.routing,
          changedFiles: context.knowledgePackChangedFilesByRefine,
          currentCaseVerification: context.currentCaseVerification.evaluation,
          regressionBefore: context.baselineRegression,
          regressionAfter: context.afterRegression,
          regressionLosses,
        })
        return { decision: "next_attempt" as const }
      }

      context.attemptSummary.acceptancePassed = true
      await writeJsonFile(path.join(context.acceptanceDir, "acceptance.json"), {
        accepted: true,
        reason: "accepted",
        routing: context.routing,
        changedFiles: context.knowledgePackChangedFilesByRefine,
        currentCaseVerification: context.currentCaseVerification.evaluation,
        regressionBefore: context.baselineRegression,
        regressionAfter: context.afterRegression,
        regressionLosses: [],
      })
      await writeKnowledgePackSnapshot(
        path.join(context.currentAttemptDir, "knowledge_pack.after_acceptance"),
        await readKnowledgePack(context.knowledgePack),
      )

      context.finalEvaluation = context.currentCaseVerification.evaluation
    },

    finish_after_accept: async () => {
      if (!context.attemptSummary.acceptancePassed) return
      context.stopReason = "case passed after accepted refine"
      return { decision: "finish_run" as const }
    },
  }
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
  const methodFlow = await readMethodFlow(methodPaths(cwd, config, methodID))
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
    const context = createAttemptContext({
      cwd,
      config,
      methodID,
      methodFlow,
      loaded,
      expectedPath,
      expectedText,
      knowledgePack,
      baselinePath,
      scriptsDir,
      datasetSplit,
      allCases,
      mode,
      runDir,
      attempt,
      attempts,
      finalEvaluation,
      stopReason,
    })

    const handlers = await buildCaseRuntimeHandlers(context)
    const runtimeResult = await executeMethodFlow(context.methodFlow, context, handlers)
    finalEvaluation = context.finalEvaluation
    stopReason = context.stopReason

    await writeJsonFile(path.join(context.currentAttemptDir, "method_runtime.json"), {
      methodID,
      flowPath: context.methodFlow.flowPath,
      trace: runtimeResult.trace,
      decision: runtimeResult.decision,
    })

    if (runtimeResult.decision === "finish_run") {
      break
    }

    if (runtimeResult.decision === "next_attempt") {
      continue
    }

    throw new Error(
      `Method flow ${methodID} finished without an explicit decision for case ${caseID} attempt ${attempt}.`,
    )
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
