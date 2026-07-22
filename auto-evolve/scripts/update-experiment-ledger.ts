import path from "node:path"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"
import {
  hashObject,
  makeExperimentID,
  summarizeExperimentLedger,
  writeCostEventsSnapshot,
  writeConfigFingerprint,
  writeDatasetSplits,
  writeExperimentManifest,
  writeTaskResultsSnapshot,
  writeValidationEventsSnapshot,
} from "../orchestrator/experiment-ledger/writer"
import type { ExperimentCostEvent, ExperimentTaskResult, ExperimentValidationEvent } from "../orchestrator/experiment-ledger/contract"
import { pathExists } from "../orchestrator/fs"

const execFileAsync = promisify(execFile)

function getArg(name: string) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  return process.argv[index + 1]
}

function hasFlag(name: string) {
  return process.argv.includes(name)
}

function nowIso() {
  return new Date().toISOString()
}

async function gitCommit(cwd: string) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })
    return stdout.trim()
  } catch {
    return undefined
  }
}

async function readJsonLoose<T>(target: string): Promise<T> {
  const raw = await readFile(target, "utf8")
  return JSON.parse(raw.replace(/^\uFEFF/, "")) as T
}

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function inferDataset(config: any, directSummary: any) {
  if (directSummary?.dataset?.dataset) return directSummary.dataset.dataset
  const taskPack = String(config?.taskPackRoot ?? "")
  return path.basename(taskPack) || undefined
}

function formalMergePath(input: unknown) {
  if (input === "long_task" || input === "merge-as-long-task") return "merge-as-long-task"
  if (input === "skillopt" || input === "merge-as-opt" || input === "opt") return "merge-as-opt"
  if (input === "both_smoke" || input === "merge-both-smoke") return "merge-both-smoke"
  return "merge-as-old"
}

function taskResultFromBenchmark(input: {
  experimentID: string
  runID: string
  row: any
  split: "train" | "test" | "baseline"
  config: any
  updatedAt: string
}): ExperimentTaskResult {
  const status = String(input.row.status ?? (input.row.passed ? "passed" : "failed"))
  const passed = Boolean(input.row.passed ?? input.row.verified ?? status === "verified_success")
  return {
    schema: "auto-evolve/task-result/v1",
    experimentID: input.experimentID,
    runID: input.runID,
    taskID: String(input.row.id ?? input.row.caseID ?? input.row.taskID),
    split: input.split,
    stage: input.split === "train" ? "training" : input.split,
    status,
    passed,
    score: typeof input.row.score === "number" ? input.row.score : passed ? 1 : 0,
    modelID: input.config?.defaultModel ?? input.config?.modelRequested ?? input.config?.directChat?.modelIDs?.join(","),
    provider: undefined,
    skillMode: input.split === "baseline" ? "none" : input.config?.runMerge ? "trained" : "unknown",
    contextMode: input.config?.directChat?.skillInputMode ?? "unknown",
    materialMode: input.config?.directChat?.officeqaMaterialMode ?? "task-pack-files",
    campaignDir: input.row.campaignDir,
    updatedAt: input.row.updatedAt ?? input.updatedAt,
  }
}

function taskResultFromDirectChat(input: {
  experimentID: string
  runID: string
  row: any
  updatedAt: string
}): ExperimentTaskResult {
  const usage = input.row.usage ?? {}
  return {
    schema: "auto-evolve/task-result/v1",
    experimentID: input.experimentID,
    runID: input.runID,
    taskID: String(input.row.caseID),
    split: input.row.skillMode === "no-skill" ? "baseline" : "test",
    stage: "direct_chat",
    status: input.row.passed ? "passed" : "failed",
    passed: Boolean(input.row.passed),
    score: typeof input.row.score === "number" ? input.row.score : input.row.passed ? 1 : 0,
    modelID: input.row.modelID,
    provider: input.row.provider,
    resolvedModel: input.row.resolvedModel,
    skillMode: input.row.skillMode ?? "unknown",
    skillHash: input.row.skillHash,
    contextMode: input.row.skillTier ?? "unknown",
    materialMode: "direct-chat-bundle",
    attempts: input.row.attempts,
    failureCategory: input.row.errorCategory,
    error: input.row.error,
    validatorResultPath: input.row.validatorResultPath,
    rawResponsePath: input.row.rawResponsePath,
    durationMs: input.row.latencyMs,
    promptTokens: usage.inputTokens,
    completionTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    tokenSource: usage.totalTokens || usage.inputTokens || usage.outputTokens ? "provider" : "unknown",
    updatedAt: input.updatedAt,
  }
}

async function loadDirectChatResults(outDir: string) {
  const resultsRoot = path.join(outDir, "results")
  if (!(await pathExists(resultsRoot))) return []
  const rows: any[] = []
  async function walk(dir: string) {
    const { readdir } = await import("node:fs/promises")
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(target)
      else if (entry.name === "result.json") {
        try {
          rows.push(await readJsonLoose<any>(target))
        } catch {
          // Ignore corrupt partial per-case result; raw evidence remains in place.
        }
      }
    }
  }
  await walk(resultsRoot)
  return rows
}

async function updateBenchmarkLedger(outDir: string) {
  const statePath = path.join(outDir, "orchestrator-state.json")
  const state = await readJsonLoose<any>(statePath)
  const config = state.config ?? {}
  const mergeLineagePath = path.join(outDir, "merge-lineage.json")
  const mergeLineage = (await pathExists(mergeLineagePath)) ? await readJsonLoose<any>(mergeLineagePath) : undefined
  const mergeState = state.merge ?? {}
  const internalMergeMode = mergeLineage?.internalMode ?? mergeState.executionMode ?? config.mergeExecutionMode ?? "legacy_script"
  const mergePath = mergeLineage?.mergePath ?? mergeState.pathName ?? formalMergePath(internalMergeMode)
  const runID = state.runID ?? path.basename(outDir)
  const experimentID = makeExperimentID(outDir, "benchmark")
  const updatedAt = nowIso()
  const trainIDs = Array.isArray(state.trainIDs) ? state.trainIDs.map(String) : []
  const testIDs = Array.isArray(state.testIDs) ? state.testIDs.map(String) : []
  const rows = [
    ...(Array.isArray(state.trainResults) ? state.trainResults : []).map((row: any) =>
      taskResultFromBenchmark({ experimentID, runID, row, split: "train", config, updatedAt }),
    ),
  ]

  await writeExperimentManifest(outDir, {
    schema: "auto-evolve/experiment-manifest/v1",
    experimentID,
    runID,
    runRoot: normalizeSlash(outDir),
    createdAt: state.createdAt ?? updatedAt,
    updatedAt,
    source: "benchmark",
    dataset: inferDataset(config, undefined),
    taskPackRoot: config.taskPackRoot,
    trainSplit: config.trainSplit,
    testSplit: config.testSplit,
    splitHash: hashObject({ trainIDs, testIDs }),
    gitCommit: await gitCommit(process.cwd()),
    cwd: process.cwd(),
    platform: process.platform,
    configSummary: {
      mode: config.mode,
      evalRunner: config.evalRunner,
      mergePath,
      mergeExecutionMode: internalMergeMode,
      mergeStrategy: config.mergeStrategy,
      stopAfter: config.stopAfter,
    },
  })
  await writeConfigFingerprint(outDir, {
    schema: "auto-evolve/config-fingerprint/v1",
    experimentID,
    updatedAt,
    models: {
      defaultModel: config.defaultModel,
      directChatModelIDs: config.directChat?.modelIDs,
    },
    dataset: {
      taskPackRoot: config.taskPackRoot,
      trainSplit: config.trainSplit,
      testSplit: config.testSplit,
      trainLimit: config.trainLimit,
      testLimit: config.testLimit,
    },
    execution: {
      concurrency: config.concurrency,
      stageConcurrency: config.stageConcurrency,
      campaignRounds: config.campaignRounds,
      mergePath,
      mergeExecutionMode: internalMergeMode,
      mergeStrategy: config.mergeStrategy,
    },
    validation: {
      mergeAcceptanceProfile: config.mergeAcceptanceProfile,
      mergeAcceptanceStages: config.mergeAcceptanceStages,
      mergeAcceptanceSuccessCriterion: config.mergeAcceptanceSuccessCriterion,
      mergeAsLongTask: config.mergeAsLongTask,
    },
    directChat: config.directChat,
    rawConfigHash: hashObject(config),
  })
  await writeDatasetSplits(outDir, {
    schema: "auto-evolve/dataset-splits/v1",
    experimentID,
    updatedAt,
    dataset: inferDataset(config, undefined),
    trainIDs,
    testIDs,
    trainSplitPath: config.trainSplit,
    testSplitPath: config.testSplit,
    splitSource: "benchmark-config",
    splitHash: hashObject({ trainIDs, testIDs }),
  })
  await writeTaskResultsSnapshot(outDir, rows)
  await writeCostEventsSnapshot(outDir, [])
  await writeValidationEventsSnapshot(outDir, rows.map((row): ExperimentValidationEvent => ({
    schema: "auto-evolve/validation-event/v1",
    experimentID,
    runID,
    validatorID: "benchmark-final-status",
    validatorType: "product",
    stage: row.stage,
    target: "task-output",
    passed: row.passed,
    blocking: true,
    failureCategory: row.failureCategory,
    taskID: row.taskID,
    campaignID: row.campaignID,
    resultPath: row.validatorResultPath,
    summary: row.status,
    createdAt: updatedAt,
  })))
  const trainPassed = rows.filter((row) => row.split === "train" && row.passed).length
  const testPassed = state.test?.passed
  const testTotal = state.test?.total
  const baselinePassed = state.baseline?.passed
  const baselineTotal = state.baseline?.total
  return summarizeExperimentLedger(outDir, {
    experimentID,
    runID,
    source: "benchmark",
    status: state.phase,
    trainPassed,
    trainTotal: trainIDs.length || rows.filter((row) => row.split === "train").length,
    testPassed,
    testTotal,
    baselinePassed,
    baselineTotal,
    merge: {
      mergePath,
      internalMode: internalMergeMode,
      strategy: mergeLineage?.strategy ?? mergeState.strategy ?? config.mergeStrategy,
      mergedSkillDir: mergeLineage?.mergedSkillDir ?? mergeState.mergedSkillDir,
      inputSkillCount: mergeLineage?.inputSkillCount ?? mergeState.inputSkillCount,
      sourceTrainVerified: mergeLineage?.sourceTrainVerified ?? mergeState.sourceTrainVerified,
      sourceTrainTotal: mergeLineage?.sourceTrainTotal ?? mergeState.sourceTrainTotal,
      acceptanceProfile: mergeLineage?.acceptanceProfile ?? config.mergeAcceptanceProfile,
    },
  })
}

async function updateDirectChatLedger(outDir: string) {
  const summaryPath = path.join(outDir, "summary.json")
  const configPath = path.join(outDir, "config.snapshot.json")
  const summary = (await pathExists(summaryPath)) ? await readJsonLoose<any>(summaryPath) : {}
  const config = (await pathExists(configPath)) ? await readJsonLoose<any>(configPath) : {}
  const runID = path.basename(outDir)
  const experimentID = makeExperimentID(outDir, "direct-chat")
  const updatedAt = nowIso()
  const rows = (await loadDirectChatResults(outDir)).map((row) => taskResultFromDirectChat({ experimentID, runID, row, updatedAt }))
  const caseIDs = Array.isArray(config.caseIDs) ? config.caseIDs.map(String) : Array.from(new Set(rows.map((row) => row.taskID)))

  await writeExperimentManifest(outDir, {
    schema: "auto-evolve/experiment-manifest/v1",
    experimentID,
    runID,
    runRoot: normalizeSlash(outDir),
    createdAt: summary.createdAt ?? updatedAt,
    updatedAt,
    source: "direct-chat",
    dataset: config.dataset?.dataset ?? summary.dataset?.dataset,
    splitHash: hashObject(caseIDs),
    gitCommit: await gitCommit(process.cwd()),
    cwd: process.cwd(),
    platform: process.platform,
    configSummary: {
      runModeID: config.runModeID,
      modelIDs: config.modelIDs,
      skillInputMode: config.skillInputMode,
      includeNoSkillBaseline: config.includeNoSkillBaseline,
      noSkillOnly: config.noSkillOnly,
    },
  })
  await writeConfigFingerprint(outDir, {
    schema: "auto-evolve/config-fingerprint/v1",
    experimentID,
    updatedAt,
    models: {
      modelIDs: config.modelIDs,
      models: config.models,
    },
    dataset: {
      caseIDs,
      datasetBundlePath: config.datasetBundlePath,
    },
    execution: {
      globalConcurrency: config.globalConcurrency,
      resumeExisting: config.resumeExisting,
    },
    directChat: {
      runModeID: config.runModeID,
      runModeDescription: config.runModeDescription,
      skillInputMode: config.skillInputMode,
      includeNoSkillBaseline: config.includeNoSkillBaseline,
      noSkillOnly: config.noSkillOnly,
      ocrFallback: config.ocrFallback,
    },
    rawConfigHash: hashObject(config),
  })
  await writeDatasetSplits(outDir, {
    schema: "auto-evolve/dataset-splits/v1",
    experimentID,
    updatedAt,
    dataset: config.dataset?.dataset ?? summary.dataset?.dataset,
    trainIDs: [],
    testIDs: caseIDs,
    splitSource: "direct-chat-dataset-bundle",
    splitHash: hashObject(caseIDs),
  })
  await writeTaskResultsSnapshot(outDir, rows)
  const costRows: ExperimentCostEvent[] = []
  for (const row of rows) {
    if (row.promptTokens || row.completionTokens || row.totalTokens) {
      costRows.push({
        schema: "auto-evolve/cost-event/v1",
        experimentID,
        runID,
        stage: "direct_chat",
        role: "direct_chat",
        taskID: row.taskID,
        provider: row.provider,
        modelID: row.modelID,
        resolvedModel: row.resolvedModel,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens: row.totalTokens,
        estimated: false,
        durationMs: row.durationMs,
        success: row.passed,
        createdAt: updatedAt,
      })
    }
  }
  await writeCostEventsSnapshot(outDir, costRows)
  await writeValidationEventsSnapshot(outDir, rows.map((row): ExperimentValidationEvent => ({
    schema: "auto-evolve/validation-event/v1",
    experimentID,
    runID,
    validatorID: "direct-chat-scorer",
    validatorType: "product",
    stage: "direct_chat",
    target: "task-output",
    passed: row.passed,
    blocking: true,
    failureCategory: row.failureCategory,
    taskID: row.taskID,
    resultPath: row.validatorResultPath,
    summary: row.status,
    createdAt: updatedAt,
  })))
  const testRows = rows.filter((row) => row.split === "test")
  const baselineRows = rows.filter((row) => row.split === "baseline")
  return summarizeExperimentLedger(outDir, {
    experimentID,
    runID,
    source: "direct-chat",
    status: "completed",
    testPassed: testRows.filter((row) => row.passed).length,
    testTotal: testRows.length || undefined,
    baselinePassed: baselineRows.length ? baselineRows.filter((row) => row.passed).length : undefined,
    baselineTotal: baselineRows.length || undefined,
  })
}

export async function updateExperimentLedger(outDir: string) {
  const resolved = path.resolve(outDir)
  if (await pathExists(path.join(resolved, "orchestrator-state.json"))) return updateBenchmarkLedger(resolved)
  if (await pathExists(path.join(resolved, "summary.json")) || await pathExists(path.join(resolved, "config.snapshot.json"))) {
    return updateDirectChatLedger(resolved)
  }
  throw new Error(`Cannot infer experiment type for ${resolved}; missing orchestrator-state.json or direct-chat summary/config.`)
}

async function main() {
  const out = getArg("--out") || getArg("--out-dir")
  if (!out || hasFlag("--help")) {
    console.log("Usage: bun run auto-evolve/scripts/update-experiment-ledger.ts --out <benchmark-or-direct-chat-run-dir>")
    return
  }
  const summary = await updateExperimentLedger(out)
  console.log(JSON.stringify(summary, null, 2))
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}
