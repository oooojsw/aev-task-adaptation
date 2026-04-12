import path from "node:path"
import { loadDatasetSplit, type DatasetSplitName } from "./dataset-split"
import {
  experienceWorkspacePaths,
  listExperienceWorkspaceFiles,
  readExperienceWorkspace,
  resolveExperienceWorkspaceLayout,
  templateLibraryPaths,
  writeExperienceWorkspaceSnapshot,
} from "./experience-workspace"
import { autoEvolvePath, ensureDirectory, readTextFile, runDirectory, writeJsonFile } from "./fs"
import { writeShortTaskShadowMemoryCandidate } from "./maintenance-gateway/short-task"
import { resolveLocalLearningRecipe } from "./local-learning-recipes"
import { resolveMethodStrategy } from "./method-strategies"
import { buildCaseMethodOps } from "./primitive-ops/build-case-method-ops"
import { loadAllCases, loadCaseByID, loadConfig, type RuntimePathOverrides } from "./schema"
import { buildAttemptTaskIndex } from "./task-index"
import {
  type CaseExecutionProfile,
  createAttemptContext,
  makeRunID,
  type LoadedAutoEvolveConfig,
  type RunCaseResult,
} from "./case-runtime"

export async function runCase(
  cwd: string,
  caseID: string,
  options?: {
    methodID?: string
    mode?: "learn" | "eval"
    split?: DatasetSplitName
    runtimePaths?: RuntimePathOverrides
    executionProfile?: CaseExecutionProfile
  },
): Promise<RunCaseResult> {
  const config = (await loadConfig(cwd, options?.runtimePaths)) as LoadedAutoEvolveConfig
  const loaded = await loadCaseByID(cwd, config, caseID)
  const expectedPath = path.join(loaded.caseDir, loaded.spec.expected.path)
  const expectedText = await readTextFile(expectedPath)
  const workspacePaths = experienceWorkspacePaths(cwd, config)
  const templateLibrary = await templateLibraryPaths(cwd, config)
  const baselinePath = autoEvolvePath(cwd, config.baselineFile)
  const scriptsDir = autoEvolvePath(cwd, config.scriptsDir)
  const datasetSplit = await loadDatasetSplit(cwd, config)
  const allCases = await loadAllCases(cwd, config)
  const methodID = options?.methodID ?? config.defaultMethod
  const recipe = resolveLocalLearningRecipe(methodID)
  const strategy = resolveMethodStrategy(cwd, config, recipe.caseMethodID)
  const mode = options?.mode ?? "learn"
  const split = options?.split ?? "all"

  const runID = makeRunID(caseID)
  const runDir = runDirectory(cwd, config, runID)
  await ensureDirectory(runDir)

  let finalEvaluation
  let stopReason: string | undefined
  const attempts = []

  await writeExperienceWorkspaceSnapshot(path.join(runDir, "experience_workspace.initial"), await readExperienceWorkspace(workspacePaths))

  for (let attempt = 1; attempt <= config.maxRetriesPerCase; attempt++) {
    const workspace = await resolveExperienceWorkspaceLayout(workspacePaths)
    const context = createAttemptContext({
      cwd,
      config,
      methodID,
      strategy,
      loaded,
      expectedPath,
      expectedText,
      workspacePaths,
      workspace,
      templateLibrary,
      baselinePath,
      scriptsDir,
      datasetSplit,
      allCases,
      mode,
      split,
      executionProfile: options?.executionProfile ?? "full",
      runDir,
      attempt,
      attempts,
    })

    const ops = await buildCaseMethodOps(context)
    const strategyResult = await strategy.runAttempt(ops, context)
    finalEvaluation = context.finalEvaluation
    stopReason = context.stopReason

    await writeJsonFile(path.join(context.currentAttemptDir, "method_runtime.json"), {
      methodID,
      strategyDocPath: strategy.strategyDocPath,
      trace: strategyResult.trace,
      decision: strategyResult.decision,
    })
    await writeJsonFile(
      path.join(context.currentAttemptDir, "task_index.json"),
      buildAttemptTaskIndex(context.attemptSummary, context.runDir),
    )

    if (strategyResult.decision === "finish_run") {
      break
    }

    if (strategyResult.decision === "next_attempt") {
      continue
    }

    throw new Error(`Method strategy ${methodID} returned an unknown decision for case ${caseID} attempt ${attempt}.`)
  }

  if (!finalEvaluation) {
    throw new Error(`Case ${caseID} did not produce any evaluation result.`)
  }

  const finalWorkspace = await resolveExperienceWorkspaceLayout(workspacePaths)

  await writeJsonFile(path.join(runDir, "run.json"), {
    runID,
    caseID,
    methodID,
    mode,
    split,
    executionProfile: options?.executionProfile ?? "full",
    attempts,
    finalPassed: finalEvaluation.passed,
    stopReason: stopReason ?? null,
    maxRetriesPerCase: config.maxRetriesPerCase,
    expectedPath,
    experienceWorkspaceRoot: finalWorkspace.root,
    experienceWorkspaceEntryPath: finalWorkspace.entryPath,
    experienceWorkspaceEntryRelativePath: finalWorkspace.entryRelativePath,
    experienceWorkspaceFiles: await listExperienceWorkspaceFiles(finalWorkspace),
    experienceWorkspaceDocumentFiles: finalWorkspace.documents.map((item) => item.relativePath),
    experienceWorkspaceAssetFiles: finalWorkspace.assets.map((item) => ({
      relativePath: item.relativePath,
      kind: item.kind,
    })),
    experienceWorkspaceRuntimeSidecarFiles: finalWorkspace.runtimeSidecarFiles,
    templateLibraryRoot: templateLibrary.root,
    templateLibraryFiles: templateLibrary.files,
  })

  await writeShortTaskShadowMemoryCandidate({
    runDir,
    caseID,
    passed: finalEvaluation.passed,
    summary:
      stopReason ??
      (finalEvaluation.passed
        ? "Short-task run completed and the accepted transaction updated canonical experience."
        : finalEvaluation.summary),
    evidenceRefs: attempts
      .flatMap((attempt) => [
        attempt.solveSessionExecutionReportPath,
        attempt.judgeSessionExecutionReportPath,
        attempt.refineSessionExecutionReportPath,
        attempt.currentCaseVerificationReportPath,
        attempt.failurePacketPath,
      ])
      .filter((item): item is string => Boolean(item))
      .slice(0, 24),
    outputPath: path.join(runDir, "shadow_memory_candidate.json"),
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
