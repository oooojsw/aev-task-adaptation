import path from "node:path"
import { selectCasesBySplit, type DatasetSplit, type DatasetSplitName } from "./dataset-split"
import {
  experienceWorkspacePaths,
  experienceWorkspacePathsFromRoot,
  readExperienceWorkspace,
  resolveExperienceWorkspaceLayout,
  restoreExperienceWorkspace,
  validateExperienceWorkspaceLayout,
  writeExperienceWorkspaceSnapshot,
} from "./experience-workspace"
import { autoEvolvePath, ensureDirectory, runDirectory, writeJsonFile, writeTextFile } from "./fs"
import { resolveExecutionStrategy } from "./execution-strategies"
import { resolveLocalLearningRecipe, type LocalLearningRecipe } from "./local-learning-recipes"
import { resolvePacketizationPolicy } from "./packetization-policies"
import { loadAllCases, loadConfig, type RuntimePathOverrides } from "./schema"
import { runCase } from "./case-runner"
import type { LoadedAutoEvolveConfig } from "./case-runtime"
import type { RunCaseResult } from "./case-runtime"
import { buildBatchLearningPacket } from "./batch-packetization"
import { runBatchKnowledgeMaintainer } from "./batch-maintainer"
import { writeTaskArtifacts } from "./task-artifacts"
import {
  resolveBatchPostJudgeStrategy,
  type BatchEvaluationCaseSummary,
  type BatchPostJudgeSummary,
  type BatchRegressionSummary,
} from "./batch-post-judge"
import { templateLibraryPaths } from "./experience-workspace"

export interface RoundCaseSummary {
  caseID: string
  runDir: string
  passed: boolean
  attempts: number
  summary: string
  acceptedRefines: number
  rejectedRefines: number
}

export interface RoundBatchSummary {
  batchIndex: number
  batchDir: string
  caseIDs: string[]
  maintenanceTriggered: boolean
  maintenanceAccepted: boolean
  maintenanceRejected: boolean
  maintenanceCandidateCaseIDs: string[]
  targetPassCountBefore: number
  targetPassCountAfter: number
  regressionPassCountBefore: number | null
  regressionPassCountAfter: number | null
  changedFiles: string[]
}

export interface RunBatchRoundResult {
  roundDir: string
  methodID: string
  caseLimit: number
  split: DatasetSplitName
  mode: "learn" | "eval"
  totalCases: number
  passedCases: number
  failedCases: number
  acceptedRefines: number
  rejectedRefines: number
  cases: RoundCaseSummary[]
  batches: RoundBatchSummary[]
}

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function makeRoundID() {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`
  return `${stamp}-round`
}

function relativeToAutoEvolveRoot(cwd: string, target: string) {
  return normalizeSlash(path.relative(autoEvolvePath(cwd), target))
}

function rate(passed: number, total: number) {
  if (!total) return "0.0%"
  return `${((passed / total) * 100).toFixed(1)}%`
}

function defaultRoundCaseSummary(result: RunCaseResult): RoundCaseSummary {
  const acceptedRefines = result.attempts.filter((attempt) => attempt.acceptancePassed).length
  const rejectedRefines = result.attempts.filter((attempt) => attempt.acceptanceRejected).length

  return {
    caseID: result.caseID,
    runDir: result.runDir,
    passed: result.evaluation.passed,
    attempts: result.attempts.length,
    summary: result.evaluation.summary,
    acceptedRefines,
    rejectedRefines,
  }
}

function buildEvaluationSummary(result: RunCaseResult): BatchEvaluationCaseSummary {
  return {
    caseID: result.caseID,
    passed: result.evaluation.passed,
    summary: result.evaluation.summary,
    runDir: result.runDir,
  }
}

async function evaluateCases(input: {
  cwd: string
  methodID: string
  cases: Awaited<ReturnType<typeof loadAllCases>>
  split: DatasetSplitName
  workspaceRuntimePaths: RuntimePathOverrides
}): Promise<RunCaseResult[]> {
  return Promise.all(
    input.cases.map((item) =>
      runCase(input.cwd, item.spec.id, {
        methodID: input.methodID,
        mode: "eval",
        split: input.split,
        runtimePaths: input.workspaceRuntimePaths,
      }),
    ),
  )
}

function buildRegressionSummary(results: RunCaseResult[]): BatchRegressionSummary {
  const cases = results.map((result) => buildEvaluationSummary(result))
  return {
    cases,
    passedCount: cases.filter((item) => item.passed).length,
    failedCount: cases.filter((item) => !item.passed).length,
  }
}

async function writeBatchPostJudgeArtifacts(
  acceptanceDir: string,
  summary: BatchPostJudgeSummary,
) {
  const summaryPath = path.join(acceptanceDir, "post_judge_summary.json")
  const reportPath = path.join(acceptanceDir, "post_judge_report.md")

  await writeJsonFile(summaryPath, summary)
  await writeTextFile(
    reportPath,
    [
      "# Batch Post-Judge Report",
      "",
      `- strategy: ${summary.strategyID}`,
      `- decision: ${summary.decision}`,
      `- risk level: ${summary.riskLevel}`,
      `- target pass count before: ${summary.targetPassCountBefore}`,
      `- target pass count after: ${summary.targetPassCountAfter}`,
      `- target gains: ${summary.targetGains.length ? summary.targetGains.join(", ") : "(none)"}`,
      `- target losses: ${summary.targetLosses.length ? summary.targetLosses.join(", ") : "(none)"}`,
      `- remaining target failures: ${summary.remainingTargetFailures.length ? summary.remainingTargetFailures.join(", ") : "(none)"}`,
      `- regression pass count before: ${summary.regressionPassCountBefore ?? "(not run)"}`,
      `- regression pass count after: ${summary.regressionPassCountAfter ?? "(not run)"}`,
      `- regression losses: ${summary.regressionLosses.length ? summary.regressionLosses.join(", ") : "(none)"}`,
      "",
      "## Reasons",
      "",
      ...(summary.reasons.length ? summary.reasons.map((item) => `- ${item}`) : ["- (none)"]),
      "",
      "## Notes",
      "",
      ...(summary.notes.length ? summary.notes.map((item) => `- ${item}`) : ["- (none)"]),
      "",
    ].join("\n"),
  )

  return { summaryPath, reportPath }
}

async function runSingleBatch(input: {
  cwd: string
  config: LoadedAutoEvolveConfig
  recipe: LocalLearningRecipe
  methodID: string
  roundDir: string
  batchIndex: number
  cases: Awaited<ReturnType<typeof loadAllCases>>
  allCases: Awaited<ReturnType<typeof loadAllCases>>
  datasetSplit: DatasetSplit
  splitName: DatasetSplitName
  mode: "learn" | "eval"
  runtimePaths?: RuntimePathOverrides
}): Promise<{ caseResults: RoundCaseSummary[]; batchSummary: RoundBatchSummary; acceptedRefines: number; rejectedRefines: number }> {
  const batchDir = path.join(input.roundDir, `batch-${String(input.batchIndex).padStart(2, "0")}`)
  const baseWorkspacePaths = experienceWorkspacePaths(input.cwd, input.config)
  const templateLibrary = await templateLibraryPaths(input.cwd, input.config)
  const baselinePath = autoEvolvePath(input.cwd, input.config.baselineFile)
  const scriptsDir = autoEvolvePath(input.cwd, input.config.scriptsDir)
  const baseSnapshot = await readExperienceWorkspace(baseWorkspacePaths)

  await ensureDirectory(batchDir)
  await writeExperienceWorkspaceSnapshot(path.join(batchDir, "experience_workspace.before_batch"), baseSnapshot)

  const shardResults = await Promise.all(
    input.cases.map(async (item) => {
      const shardRoot = path.join(batchDir, "shards", item.spec.id)
      const shardWorkspaceRoot = path.join(shardRoot, "workspace")
      const shardRunsRoot = path.join(shardRoot, "runs")
      const shardWorkspacePaths = experienceWorkspacePathsFromRoot(
        shardWorkspaceRoot,
        input.config.experienceEntryFile,
      )
      await restoreExperienceWorkspace(shardWorkspacePaths, baseSnapshot)

      const result = await runCase(input.cwd, item.spec.id, {
        methodID: input.recipe.caseMethodID,
        mode: input.mode,
        split: input.splitName,
        executionProfile: input.mode === "learn" ? "light_shard" : "full",
        runtimePaths: {
          knowledgeDir: relativeToAutoEvolveRoot(input.cwd, shardWorkspaceRoot),
          runsDir: relativeToAutoEvolveRoot(input.cwd, shardRunsRoot),
        },
      })

      return { loaded: item, result, shardWorkspaceRoot, shardRunsRoot }
    }),
  )

  const packetArtifacts = await buildBatchLearningPacket({
    batchDir,
    methodID: input.methodID,
    maintenanceMethodID: input.recipe.maintenanceMethodID,
    packetizationPolicyID: input.recipe.packetizationPolicyID,
    batchIndex: input.batchIndex,
    split: input.splitName,
    mode: input.mode,
    shards: shardResults.map(({ loaded, result }) => ({ loaded, result })),
  })

  const beforeTargetSummaries = shardResults.map(({ result }) => buildEvaluationSummary(result))
  const maintenanceCandidateCaseIDs = packetArtifacts.packet.maintenanceCandidateCaseIDs

  if (input.mode === "eval" || !maintenanceCandidateCaseIDs.length) {
    const cases = shardResults.map(({ result }) => defaultRoundCaseSummary(result))
    const passedCases = cases.filter((item) => item.passed).length

    const batchSummary: RoundBatchSummary = {
      batchIndex: input.batchIndex,
      batchDir,
      caseIDs: input.cases.map((item) => item.spec.id),
      maintenanceTriggered: false,
      maintenanceAccepted: false,
      maintenanceRejected: false,
      maintenanceCandidateCaseIDs,
      targetPassCountBefore: passedCases,
      targetPassCountAfter: passedCases,
      regressionPassCountBefore: null,
      regressionPassCountAfter: null,
      changedFiles: [],
    }

    await writeJsonFile(path.join(batchDir, "batch.json"), batchSummary)
    return {
      caseResults: cases,
      batchSummary,
      acceptedRefines: 0,
      rejectedRefines: 0,
    }
  }

  const regressionCases = selectCasesBySplit(input.allCases, input.datasetSplit, "train")
    .filter((item) => !input.cases.some((current) => current.spec.id === item.spec.id))
    .slice(0, input.config.regressionSampleSize)

  const canonicalKnowledgeDir = input.runtimePaths?.knowledgeDir ?? input.config.knowledgeDir
  const regressionBeforeRunsRoot = path.join(batchDir, "acceptance", "regression-before-maintain", "runs")
  const regressionBeforeResults = await evaluateCases({
    cwd: input.cwd,
    methodID: input.recipe.caseMethodID,
    cases: regressionCases,
    split: input.splitName,
    workspaceRuntimePaths: {
      knowledgeDir: canonicalKnowledgeDir,
      runsDir: relativeToAutoEvolveRoot(input.cwd, regressionBeforeRunsRoot),
    },
  })
  const regressionBefore = buildRegressionSummary(regressionBeforeResults)

  let accepted = false
  let changedFiles: string[] = []
  let finalTargetResults = beforeTargetSummaries
  let finalRegressionAfter: BatchRegressionSummary | undefined
  let rejectedRounds = 0

  for (let round = 1; round <= input.config.maxMaintenanceRoundsPerAttempt; round++) {
    const roundDir = path.join(batchDir, "maintenance-rounds", `round-${String(round).padStart(2, "0")}`)
    const maintainDir = path.join(roundDir, "maintain")
    const acceptanceDir = path.join(roundDir, "acceptance")
    const beforeRoundSnapshot = await readExperienceWorkspace(baseWorkspacePaths)
    const workspace = await resolveExperienceWorkspaceLayout(baseWorkspacePaths)

    const maintainResult = await runBatchKnowledgeMaintainer({
      cwd: input.cwd,
      config: input.config,
      methodID: input.methodID,
      maintenanceMethodID: input.recipe.maintenanceMethodID,
      reversePropagationModuleID: input.recipe.reversePropagationModuleID,
      workspace,
      workspaceSnapshot: beforeRoundSnapshot,
      templateLibrary,
      baselinePath,
      scriptsDir,
      batchIndex: input.batchIndex,
      packet: packetArtifacts.packet,
      packetPath: packetArtifacts.packetPath,
      packetSummaryPath: packetArtifacts.summaryPath,
      sessionReports: packetArtifacts.sessionReports,
    })

    await writeTaskArtifacts(maintainDir, maintainResult.task, {
      phase: "maintain",
      taskKind: "maintain",
      maintenanceRound: round,
      methodID: input.methodID,
    })
    await writeExperienceWorkspaceSnapshot(
      path.join(maintainDir, "experience_workspace.before_maintain"),
      maintainResult.beforeSnapshot,
    )
    await writeExperienceWorkspaceSnapshot(
      path.join(maintainDir, "experience_workspace.after_maintain"),
      maintainResult.afterSnapshot,
    )
    await writeJsonFile(path.join(maintainDir, "maintain_summary.json"), maintainResult.summary)

    if (maintainResult.task.result.exitCode !== 0 || !maintainResult.changed) {
      await restoreExperienceWorkspace(baseWorkspacePaths, beforeRoundSnapshot)
      rejectedRounds += 1
      if (round === input.config.maxMaintenanceRoundsPerAttempt) {
        break
      }
      continue
    }

    const layoutAfterMaintain = await resolveExperienceWorkspaceLayout(baseWorkspacePaths)
    const workspaceValidation = validateExperienceWorkspaceLayout(layoutAfterMaintain)
    if (!workspaceValidation.valid) {
      await writeJsonFile(path.join(acceptanceDir, "acceptance.json"), {
        accepted: false,
        reason: "invalid_workspace_layout",
        workspaceValidationErrors: workspaceValidation.errors,
      })
      await restoreExperienceWorkspace(baseWorkspacePaths, beforeRoundSnapshot)
      rejectedRounds += 1
      if (round === input.config.maxMaintenanceRoundsPerAttempt) {
        break
      }
      continue
    }

    const targetAfterRunsRoot = path.join(acceptanceDir, "target-after-maintain", "runs")
    const targetAfterResults = await evaluateCases({
      cwd: input.cwd,
      methodID: input.recipe.caseMethodID,
      cases: input.cases,
      split: input.splitName,
      workspaceRuntimePaths: {
        knowledgeDir: canonicalKnowledgeDir,
        runsDir: relativeToAutoEvolveRoot(input.cwd, targetAfterRunsRoot),
      },
    })

    const regressionAfterRunsRoot = path.join(acceptanceDir, "regression-after-maintain", "runs")
    const regressionAfterResults = await evaluateCases({
      cwd: input.cwd,
      methodID: input.recipe.caseMethodID,
      cases: regressionCases,
      split: input.splitName,
      workspaceRuntimePaths: {
        knowledgeDir: canonicalKnowledgeDir,
        runsDir: relativeToAutoEvolveRoot(input.cwd, regressionAfterRunsRoot),
      },
    })

    const targetAfterSummaries = targetAfterResults.map((result) => buildEvaluationSummary(result))
    const regressionAfter = buildRegressionSummary(regressionAfterResults)
    const postJudge = resolveBatchPostJudgeStrategy(input.recipe.batchPostJudgeStrategyID).evaluate({
      packet: packetArtifacts.packet,
      afterTargets: targetAfterSummaries,
      regressionBefore,
      regressionAfter,
      changedFiles: maintainResult.changedFiles,
    })

    await writeBatchPostJudgeArtifacts(acceptanceDir, postJudge)
    await writeJsonFile(path.join(acceptanceDir, "acceptance.json"), {
      accepted: postJudge.decision === "accept",
      reason: postJudge.decision === "accept" ? "accepted" : "retry",
      changedFiles: maintainResult.changedFiles,
      postJudge,
      regressionBefore,
      regressionAfter,
    })

    if (postJudge.decision === "accept") {
      accepted = true
      changedFiles = maintainResult.changedFiles
      finalTargetResults = targetAfterSummaries
      finalRegressionAfter = regressionAfter
      break
    }

    await restoreExperienceWorkspace(baseWorkspacePaths, beforeRoundSnapshot)
    rejectedRounds += 1
  }

  const finalCaseResults = accepted
    ? shardResults.map(({ result }) => {
        const verified = finalTargetResults.find((item) => item.caseID === result.caseID)
        return {
          caseID: result.caseID,
          runDir: result.runDir,
          passed: verified?.passed ?? result.evaluation.passed,
          attempts: result.attempts.length,
          summary: verified?.summary ?? result.evaluation.summary,
          acceptedRefines: maintenanceCandidateCaseIDs.includes(result.caseID) ? 1 : 0,
          rejectedRefines: 0,
        } satisfies RoundCaseSummary
      })
    : shardResults.map(({ result }) => ({
        ...defaultRoundCaseSummary(result),
        rejectedRefines: maintenanceCandidateCaseIDs.includes(result.caseID) && rejectedRounds ? 1 : 0,
      }))

  const batchSummary: RoundBatchSummary = {
    batchIndex: input.batchIndex,
    batchDir,
    caseIDs: input.cases.map((item) => item.spec.id),
    maintenanceTriggered: maintenanceCandidateCaseIDs.length > 0,
    maintenanceAccepted: accepted,
    maintenanceRejected: !accepted,
    maintenanceCandidateCaseIDs,
    targetPassCountBefore: beforeTargetSummaries.filter((item) => item.passed).length,
    targetPassCountAfter: finalTargetResults.filter((item) => item.passed).length,
    regressionPassCountBefore: regressionBefore.passedCount,
    regressionPassCountAfter: finalRegressionAfter?.passedCount ?? regressionBefore.passedCount,
    changedFiles,
  }

  await writeJsonFile(path.join(batchDir, "batch.json"), batchSummary)
  await writeTextFile(
    path.join(batchDir, "batch-summary.md"),
    [
      "# Batch Summary",
      "",
      `- batch index: ${input.batchIndex}`,
      `- method: ${input.methodID}`,
      `- maintenance method: ${input.recipe.maintenanceMethodID}`,
      `- case ids: ${batchSummary.caseIDs.join(", ")}`,
      `- maintenance triggered: ${batchSummary.maintenanceTriggered}`,
      `- maintenance accepted: ${batchSummary.maintenanceAccepted}`,
      `- maintenance rejected: ${batchSummary.maintenanceRejected}`,
      `- maintenance candidates: ${batchSummary.maintenanceCandidateCaseIDs.length ? batchSummary.maintenanceCandidateCaseIDs.join(", ") : "(none)"}`,
      `- target pass count before: ${batchSummary.targetPassCountBefore}`,
      `- target pass count after: ${batchSummary.targetPassCountAfter}`,
      `- regression pass count before: ${batchSummary.regressionPassCountBefore ?? "(not run)"}`,
      `- regression pass count after: ${batchSummary.regressionPassCountAfter ?? "(not run)"}`,
      `- changed files: ${batchSummary.changedFiles.length ? batchSummary.changedFiles.join(", ") : "(none)"}`,
      "",
    ].join("\n"),
  )

  return {
    caseResults: finalCaseResults,
    batchSummary,
    acceptedRefines: accepted ? 1 : 0,
    rejectedRefines: accepted ? 0 : maintenanceCandidateCaseIDs.length ? 1 : 0,
  }
}

export async function runBatchRound(
  cwd: string,
  options?: {
    methodID?: string
    caseLimit?: number
    split?: DatasetSplitName
    mode?: "learn" | "eval"
    runtimePaths?: RuntimePathOverrides
  },
): Promise<RunBatchRoundResult> {
  const config = (await loadConfig(cwd, options?.runtimePaths)) as LoadedAutoEvolveConfig
  const methodID = options?.methodID ?? config.defaultMethod
  const recipe = resolveLocalLearningRecipe(methodID)
  const executionStrategy = resolveExecutionStrategy(recipe.executionStrategyID)
  const packetizationPolicy = resolvePacketizationPolicy(recipe.packetizationPolicyID)
  if (executionStrategy.kind !== "parallel_batch") {
    throw new Error(`Batch round requires a parallel-batch execution strategy, got: ${executionStrategy.id}`)
  }
  if (packetizationPolicy.kind !== "batch_aggregate") {
    throw new Error(`Batch round requires a batch-aggregate packetization policy, got: ${packetizationPolicy.id}`)
  }
  const splitName = options?.split ?? "train"
  const mode = options?.mode ?? (splitName === "test" ? "eval" : "learn")
  const caseLimit = Math.max(1, options?.caseLimit ?? config.roundCaseLimit)
  const allCases = await loadAllCases(cwd, config)
  const datasetSplit = await import("./dataset-split").then((m) => m.loadDatasetSplit(cwd, config))
  const cases = selectCasesBySplit(allCases, datasetSplit, splitName).slice(0, caseLimit)
  const roundDir = runDirectory(cwd, config, makeRoundID())
  await ensureDirectory(roundDir)

  const summaries: RoundCaseSummary[] = []
  const batches: RoundBatchSummary[] = []
  let acceptedRefines = 0
  let rejectedRefines = 0

  const batchSize = Math.max(1, executionStrategy.defaultBatchSize, packetizationPolicy.defaultBatchSize)

  for (let index = 0; index < cases.length; index += batchSize) {
    const batchCases = cases.slice(index, index + batchSize)
    const batchResult = await runSingleBatch({
      cwd,
      config,
      recipe,
      methodID,
      roundDir,
      batchIndex: batches.length + 1,
      cases: batchCases,
      allCases,
      datasetSplit,
      splitName,
      mode,
      runtimePaths: options?.runtimePaths,
    })

    summaries.push(...batchResult.caseResults)
    batches.push(batchResult.batchSummary)
    acceptedRefines += batchResult.acceptedRefines
    rejectedRefines += batchResult.rejectedRefines
  }

  const passedCases = summaries.filter((item) => item.passed).length
  const failedCases = summaries.length - passedCases

  await writeJsonFile(path.join(roundDir, "round.json"), {
    methodID,
    caseLimit,
    split: splitName,
    mode,
    totalCases: summaries.length,
    passedCases,
    failedCases,
    acceptedRefines,
    rejectedRefines,
    cases: summaries,
    batches,
  })

  await writeTextFile(
    path.join(roundDir, "round-summary.md"),
    [
      "# Round Summary",
      "",
      `- method: ${methodID}`,
      `- execution strategy: ${executionStrategy.id} (${executionStrategy.title})`,
      `- packetization policy: ${packetizationPolicy.id} (${packetizationPolicy.title})`,
      `- split: ${splitName}`,
      `- mode: ${mode}`,
      `- case limit: ${caseLimit}`,
      `- total cases: ${summaries.length}`,
      `- passed cases: ${passedCases}`,
      `- failed cases: ${failedCases}`,
      `- pass rate: ${rate(passedCases, summaries.length)}`,
      `- accepted batch maintenance transactions: ${acceptedRefines}`,
      `- rejected batch maintenance transactions: ${rejectedRefines}`,
      "",
      "## Batches",
      "",
      ...batches.map(
        (batch) =>
          `- batch ${batch.batchIndex}: cases [${batch.caseIDs.join(", ")}], maintenance ${batch.maintenanceAccepted ? "accepted" : batch.maintenanceTriggered ? "rejected" : "not triggered"}, target pass ${batch.targetPassCountBefore} -> ${batch.targetPassCountAfter}`,
      ),
      "",
      "## Cases",
      "",
      ...summaries.map(
        (item) =>
          `- ${item.caseID}: ${item.passed ? "passed" : "failed"} after ${item.attempts} attempt(s), accepted refines ${item.acceptedRefines}, rejected refines ${item.rejectedRefines} | ${item.runDir}`,
      ),
      "",
    ].join("\n"),
  )

  return {
    roundDir,
    methodID,
    caseLimit,
    split: splitName,
    mode,
    totalCases: summaries.length,
    passedCases,
    failedCases,
    acceptedRefines,
    rejectedRefines,
    cases: summaries,
    batches,
  }
}
