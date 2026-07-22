import crypto from "node:crypto"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { appendJsonlLocked, readJsonlFile } from "../jsonl"
import { ensureDirectory, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "../fs"
import type {
  ExperimentConfigFingerprint,
  ExperimentCostEvent,
  ExperimentDatasetSplits,
  ExperimentManifest,
  ExperimentRunSummary,
  ExperimentSkillLineage,
  ExperimentStageEvent,
  ExperimentTaskResult,
  ExperimentValidationEvent,
} from "./contract"

export const EXPERIMENT_LEDGER_DIR = "experiment-ledger"

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function nowIso() {
  return new Date().toISOString()
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value)
}

export function hashObject(value: unknown) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex")
}

export async function hashFileIfReadable(target: string | undefined) {
  if (!target) return undefined
  try {
    return crypto.createHash("sha256").update(await readFile(target)).digest("hex")
  } catch {
    return undefined
  }
}

export function ledgerRoot(runRoot: string) {
  return path.join(runRoot, EXPERIMENT_LEDGER_DIR)
}

export async function ensureExperimentLedger(runRoot: string) {
  const root = ledgerRoot(runRoot)
  await ensureDirectory(root)
  return {
    root,
    manifestPath: path.join(root, "experiment-manifest.json"),
    configFingerprintPath: path.join(root, "config-fingerprint.json"),
    datasetSplitsPath: path.join(root, "dataset-splits.json"),
    runSummaryPath: path.join(root, "run-summary.json"),
    taskResultsPath: path.join(root, "task-results.jsonl"),
    stageEventsPath: path.join(root, "stage-events.jsonl"),
    costLedgerPath: path.join(root, "cost-ledger.jsonl"),
    skillLineagePath: path.join(root, "skill-lineage.jsonl"),
    validationLedgerPath: path.join(root, "validation-ledger.jsonl"),
    comparisonReportPath: path.join(root, "comparison-report.json"),
    paperTablePath: path.join(root, "paper-table-ready.csv"),
  }
}

export async function writeExperimentManifest(runRoot: string, manifest: ExperimentManifest) {
  const paths = await ensureExperimentLedger(runRoot)
  await writeJsonFile(paths.manifestPath, { ...manifest, updatedAt: manifest.updatedAt || nowIso() })
}

export async function readExperimentManifest(runRoot: string) {
  const paths = await ensureExperimentLedger(runRoot)
  if (!(await pathExists(paths.manifestPath))) return undefined
  return readJsonFile<ExperimentManifest>(paths.manifestPath)
}

export async function writeConfigFingerprint(runRoot: string, config: ExperimentConfigFingerprint) {
  const paths = await ensureExperimentLedger(runRoot)
  await writeJsonFile(paths.configFingerprintPath, { ...config, updatedAt: config.updatedAt || nowIso() })
}

export async function writeDatasetSplits(runRoot: string, splits: ExperimentDatasetSplits) {
  const paths = await ensureExperimentLedger(runRoot)
  await writeJsonFile(paths.datasetSplitsPath, { ...splits, updatedAt: splits.updatedAt || nowIso() })
}

export async function writeTaskResultsSnapshot(runRoot: string, rows: ExperimentTaskResult[]) {
  const paths = await ensureExperimentLedger(runRoot)
  const payload = rows.map((row) => JSON.stringify(row)).join("\n")
  await writeTextFile(paths.taskResultsPath, payload ? `${payload}\n` : "")
}

export async function appendTaskResult(runRoot: string, row: ExperimentTaskResult) {
  const paths = await ensureExperimentLedger(runRoot)
  await appendJsonlLocked(paths.taskResultsPath, row)
}

export async function appendStageEvent(runRoot: string, event: ExperimentStageEvent) {
  const paths = await ensureExperimentLedger(runRoot)
  await appendJsonlLocked(paths.stageEventsPath, event)
}

export async function appendCostEvent(runRoot: string, event: ExperimentCostEvent) {
  const paths = await ensureExperimentLedger(runRoot)
  await appendJsonlLocked(paths.costLedgerPath, event)
}

export async function writeCostEventsSnapshot(runRoot: string, rows: ExperimentCostEvent[]) {
  const paths = await ensureExperimentLedger(runRoot)
  const payload = rows.map((row) => JSON.stringify(row)).join("\n")
  await writeTextFile(paths.costLedgerPath, payload ? `${payload}\n` : "")
}

export async function appendSkillLineage(runRoot: string, event: ExperimentSkillLineage) {
  const paths = await ensureExperimentLedger(runRoot)
  await appendJsonlLocked(paths.skillLineagePath, event)
}

export async function appendValidationEvent(runRoot: string, event: ExperimentValidationEvent) {
  const paths = await ensureExperimentLedger(runRoot)
  await appendJsonlLocked(paths.validationLedgerPath, event)
}

export async function writeValidationEventsSnapshot(runRoot: string, rows: ExperimentValidationEvent[]) {
  const paths = await ensureExperimentLedger(runRoot)
  const payload = rows.map((row) => JSON.stringify(row)).join("\n")
  await writeTextFile(paths.validationLedgerPath, payload ? `${payload}\n` : "")
}

async function readRows<T>(target: string): Promise<T[]> {
  if (!(await pathExists(target))) return []
  return readJsonlFile<T>(target)
}

function sumNumber(rows: Array<Record<string, unknown>>, key: string) {
  return rows.reduce((total, row) => total + (typeof row[key] === "number" ? Number(row[key]) : 0), 0)
}

function ratio(passed: number | undefined, total: number | undefined) {
  if (!total) return undefined
  return (passed ?? 0) / total
}

function maybeCount(value: number | undefined) {
  return value === undefined ? undefined : value
}

function csvCell(value: unknown) {
  const text = value === undefined || value === null ? "" : String(value)
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export async function writeRunSummary(runRoot: string, summary: ExperimentRunSummary) {
  const paths = await ensureExperimentLedger(runRoot)
  await writeJsonFile(paths.runSummaryPath, summary)
  await writeJsonFile(paths.comparisonReportPath, {
    schema: "auto-evolve/comparison-report/v1",
    experimentID: summary.experimentID,
    runID: summary.runID,
    updatedAt: summary.updatedAt,
    accuracy: summary.accuracy,
    merge: summary.merge,
    comparability: summary.comparability,
    cost: summary.cost,
  })
  await writeTextFile(paths.paperTablePath, [
    [
      "experimentID",
      "runID",
      "source",
      "status",
      "mergePath",
      "internalMergeMode",
      "mergeStrategy",
      "trainPassed",
      "trainTotal",
      "trainAccuracy",
      "testPassed",
      "testTotal",
      "testAccuracy",
      "baselinePassed",
      "baselineTotal",
      "baselineAccuracy",
      "deltaVsBaseline",
      "totalTokens",
      "promptTokens",
      "completionTokens",
      "costRows",
      "comparable",
      "warnings",
    ].join(","),
    [
      summary.experimentID,
      summary.runID,
      summary.source,
      summary.status,
      summary.merge?.mergePath,
      summary.merge?.internalMode,
      summary.merge?.strategy,
      summary.totals.trainPassed,
      summary.totals.trainTotal,
      summary.accuracy?.train,
      summary.totals.testPassed,
      summary.totals.testTotal,
      summary.accuracy?.test,
      summary.totals.baselinePassed,
      summary.totals.baselineTotal,
      summary.accuracy?.baseline,
      summary.accuracy?.deltaVsBaseline,
      summary.cost?.totalTokens,
      summary.cost?.promptTokens,
      summary.cost?.completionTokens,
      summary.cost?.calls,
      summary.comparability?.comparable,
      summary.comparability?.warnings.join(" | "),
    ].map(csvCell).join(","),
  ].join("\n") + "\n")
}

export async function summarizeExperimentLedger(runRoot: string, input: {
  experimentID: string
  runID: string
  source: ExperimentRunSummary["source"]
  status?: string
  trainTotal?: number
  trainPassed?: number
  testTotal?: number
  testPassed?: number
  baselineTotal?: number
  baselinePassed?: number
  merge?: ExperimentRunSummary["merge"]
  warnings?: string[]
}) {
  const paths = await ensureExperimentLedger(runRoot)
  const taskRows = await readRows<ExperimentTaskResult>(paths.taskResultsPath)
  const costRows = await readRows<ExperimentCostEvent>(paths.costLedgerPath)
  const trainTotal = input.trainTotal ?? taskRows.filter((row) => row.split === "train").length
  const trainPassed = input.trainPassed ?? taskRows.filter((row) => row.split === "train" && row.passed).length
  const testTotal = input.testTotal ?? taskRows.filter((row) => row.split === "test").length
  const testPassed = input.testPassed ?? taskRows.filter((row) => row.split === "test" && row.passed).length
  const baselineTotal = input.baselineTotal ?? taskRows.filter((row) => row.split === "baseline").length
  const baselinePassed = input.baselinePassed ?? taskRows.filter((row) => row.split === "baseline" && row.passed).length
  const totals = {
    trainTotal: maybeCount(trainTotal),
    trainPassed: maybeCount(trainPassed),
    testTotal: maybeCount(testTotal),
    testPassed: maybeCount(testPassed),
    baselineTotal: maybeCount(baselineTotal),
    baselinePassed: maybeCount(baselinePassed),
    taskRows: taskRows.length,
  }
  const promptTokens = sumNumber(costRows as unknown as Array<Record<string, unknown>>, "promptTokens")
  const completionTokens = sumNumber(costRows as unknown as Array<Record<string, unknown>>, "completionTokens")
  const reasoningTokens = sumNumber(costRows as unknown as Array<Record<string, unknown>>, "reasoningTokens")
  const explicitTotalTokens = sumNumber(costRows as unknown as Array<Record<string, unknown>>, "totalTokens")
  const totalTokens = explicitTotalTokens || promptTokens + completionTokens + reasoningTokens
  const warnings = [...(input.warnings ?? [])]
  if (totals.testTotal && totals.baselineTotal && totals.testTotal !== totals.baselineTotal) {
    warnings.push("baseline/test totals differ; delta may not be directly comparable")
  }
  const summary: ExperimentRunSummary = {
    schema: "auto-evolve/run-summary/v1",
    experimentID: input.experimentID,
    runID: input.runID,
    updatedAt: nowIso(),
    status: input.status,
    source: input.source,
    totals,
    accuracy: {
      train: ratio(totals.trainPassed, totals.trainTotal),
      test: ratio(totals.testPassed, totals.testTotal),
      baseline: ratio(totals.baselinePassed, totals.baselineTotal),
      deltaVsBaseline:
        ratio(totals.testPassed, totals.testTotal) !== undefined && ratio(totals.baselinePassed, totals.baselineTotal) !== undefined
          ? ratio(totals.testPassed, totals.testTotal)! - ratio(totals.baselinePassed, totals.baselineTotal)!
          : undefined,
    },
    cost: {
      calls: costRows.length,
      promptTokens,
      completionTokens,
      reasoningTokens,
      totalTokens,
      estimatedRows: costRows.filter((row) => row.estimated).length,
    },
    merge: input.merge,
    comparability: {
      comparable: warnings.length === 0,
      warnings,
    },
  }
  await writeRunSummary(runRoot, summary)
  return summary
}

export function makeExperimentID(runRoot: string, source: string) {
  return `${source}-${path.basename(path.resolve(runRoot))}`
}

export function safeRelativePath(base: string, target: string | undefined) {
  if (!target) return undefined
  const resolvedBase = path.resolve(base)
  const resolvedTarget = path.resolve(target)
  const rel = path.relative(resolvedBase, resolvedTarget)
  return normalizeSlash(rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : resolvedTarget)
}
