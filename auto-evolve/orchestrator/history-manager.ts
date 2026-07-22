import path from "node:path"
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, stat } from "node:fs/promises"
import { pathExists, readJsonFile, writeJsonFile } from "./fs"
import type {
  LongTaskCampaignHistoryPolicy,
  LongTaskCampaignReuseState,
  LongTaskCampaignRunLineage,
  LongTaskCampaignState,
} from "./long-task-campaign/contract"

export type BenchmarkHistoryTaskStatus =
  | "queued"
  | "running"
  | "recovery_pending"
  | "verified_success"
  | "terminal"
  | "superseded"
  | "tainted"

export type BenchmarkHistoryAttempt = {
  attemptID: string
  campaignID: string
  campaignDir: string
  generationID: string
  status: BenchmarkHistoryTaskStatus
  createdAt: string
  updatedAt: string
  reason?: string
  taintReason?: string
}

export type BenchmarkHistoryTaskEntry = {
  id: string
  status: BenchmarkHistoryTaskStatus
  activeAttemptID?: string
  activeCampaignID?: string
  activeCampaignDir?: string
  allowResume: boolean
  updatedAt: string
  attempts: BenchmarkHistoryAttempt[]
}

export type BenchmarkHistoryManifest = {
  schema: "auto-evolve/benchmark-history/v1"
  runID: string
  currentGenerationID: string
  historyPolicy: LongTaskCampaignHistoryPolicy
  createdAt: string
  updatedAt: string
  fingerprint: {
    taskPackRoot: string
    trainSplitHash?: string
    testSplitHash?: string
    modelRequested?: string
    modelResolved?: string
    validatorProfileHash?: string
  }
  tasks: Record<string, BenchmarkHistoryTaskEntry>
}

export type BenchmarkHistoryContext = {
  outDir: string
  runID: string
  generationID: string
  historyPolicy: LongTaskCampaignHistoryPolicy
  taskPackRoot: string
  trainSplitHash?: string
  testSplitHash?: string
  modelRequested?: string
  modelResolved?: string
  validatorProfileHash?: string
}

const DEFAULT_MAX_BENCHMARK_HISTORY_BYTES = 20 * 1024 * 1024

function maxBenchmarkHistoryBytes() {
  const raw = Number.parseInt(process.env.AUTO_EVOLVE_MAX_TASK_LEDGER_BYTES ?? "", 10)
  if (Number.isFinite(raw) && raw > 0) return raw
  return DEFAULT_MAX_BENCHMARK_HISTORY_BYTES
}

function compactTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function countStatus(tasks: Record<string, BenchmarkHistoryTaskEntry>) {
  const dist: Record<string, number> = {}
  for (const task of Object.values(tasks)) {
    dist[task.status] = (dist[task.status] ?? 0) + 1
  }
  return dist
}

export function benchmarkHistoryPath(outDir: string) {
  return path.join(outDir, "task-ledger.json")
}

export function nowISO() {
  return new Date().toISOString()
}

export async function hashFileIfExists(file: string | undefined) {
  if (!file || !(await pathExists(file))) return undefined
  const data = await readFile(file)
  return createHash("sha256").update(data).digest("hex")
}

export function normalizeHistoryPolicy(
  input: string | undefined,
  fallback: LongTaskCampaignHistoryPolicy = "resume-current-generation",
): LongTaskCampaignHistoryPolicy {
  const raw = (input || fallback).trim().toLowerCase()
  if (
    raw === "resume-current-generation" ||
    raw === "fresh-non-verified" ||
    raw === "fresh-all" ||
    raw === "resume-explicit-only" ||
    raw === "audit-only"
  ) {
    return raw
  }
  throw new Error(
    `Invalid history policy: ${input}. Use resume-current-generation, fresh-non-verified, fresh-all, resume-explicit-only, or audit-only.`,
  )
}

export async function readBenchmarkHistory(outDir: string) {
  const target = benchmarkHistoryPath(outDir)
  if (!(await pathExists(target))) return undefined
  const info = await stat(target)
  const maxBytes = maxBenchmarkHistoryBytes()
  if (info.size > maxBytes) {
    throw new Error(
      `Benchmark task ledger is too large (${info.size} bytes > ${maxBytes} bytes): ${target}. ` +
        "Run benchmark history preflight/quarantine before resuming.",
    )
  }
  return readJsonFile<BenchmarkHistoryManifest>(target)
}

export async function writeBenchmarkHistory(outDir: string, manifest: BenchmarkHistoryManifest) {
  manifest.updatedAt = nowISO()
  await writeJsonFile(benchmarkHistoryPath(outDir), manifest)
}

export type BenchmarkHistoryPreflightReport = {
  schema: "auto-evolve/benchmark-history-preflight/v1"
  checkedAt: string
  outDir: string
  ledgerPath: string
  action:
    | "missing"
    | "ok"
    | "quarantined_size"
    | "quarantined_invalid_json"
    | "quarantined_invalid_schema"
    | "quarantined_task_mismatch"
    | "quarantined_backslash_explosion"
  sizeBytes?: number
  maxBytes: number
  expectedTaskCount: number
  actualTaskCount?: number
  missingTaskIDs?: string[]
  extraTaskIDs?: string[]
  statusDistribution?: Record<string, number>
  quarantinePath?: string
  reason?: string
}

async function quarantineBenchmarkHistoryLedger(outDir: string, reason: string) {
  const source = benchmarkHistoryPath(outDir)
  const quarantineDir = path.join(outDir, "history-quarantine")
  await mkdir(quarantineDir, { recursive: true })
  const target = path.join(quarantineDir, `task-ledger.${compactTimestamp()}.${reason}.json`)
  await rename(source, target)
  return target
}

async function writeBenchmarkHistoryPreflightReport(outDir: string, report: BenchmarkHistoryPreflightReport) {
  const dir = path.join(outDir, "history-health")
  await mkdir(dir, { recursive: true })
  await writeJsonFile(path.join(dir, `${compactTimestamp()}-task-ledger-preflight.json`), report)
}

export async function preflightBenchmarkHistory(input: {
  outDir: string
  expectedTaskIDs: string[]
  writeReport?: boolean
}) {
  const ledgerPath = benchmarkHistoryPath(input.outDir)
  const expected = new Set(input.expectedTaskIDs)
  const maxBytes = maxBenchmarkHistoryBytes()
  const base = {
    schema: "auto-evolve/benchmark-history-preflight/v1" as const,
    checkedAt: nowISO(),
    outDir: input.outDir,
    ledgerPath,
    maxBytes,
    expectedTaskCount: input.expectedTaskIDs.length,
  }

  if (!(await pathExists(ledgerPath))) {
    const report: BenchmarkHistoryPreflightReport = { ...base, action: "missing" }
    if (input.writeReport !== false) await writeBenchmarkHistoryPreflightReport(input.outDir, report)
    return report
  }

  const info = await stat(ledgerPath)
  if (info.size > maxBytes) {
    const quarantinePath = await quarantineBenchmarkHistoryLedger(input.outDir, "oversize")
    const report: BenchmarkHistoryPreflightReport = {
      ...base,
      action: "quarantined_size",
      sizeBytes: info.size,
      quarantinePath,
      reason: `task-ledger.json exceeded ${maxBytes} bytes`,
    }
    if (input.writeReport !== false) await writeBenchmarkHistoryPreflightReport(input.outDir, report)
    return report
  }

  let raw = ""
  try {
    raw = await readFile(ledgerPath, "utf8")
  } catch (error) {
    const quarantinePath = await quarantineBenchmarkHistoryLedger(input.outDir, "unreadable")
    const report: BenchmarkHistoryPreflightReport = {
      ...base,
      action: "quarantined_invalid_json",
      sizeBytes: info.size,
      quarantinePath,
      reason: error instanceof Error ? error.message : String(error),
    }
    if (input.writeReport !== false) await writeBenchmarkHistoryPreflightReport(input.outDir, report)
    return report
  }

  if (/\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\/.test(raw.slice(0, Math.min(raw.length, 64 * 1024)))) {
    const quarantinePath = await quarantineBenchmarkHistoryLedger(input.outDir, "backslash-explosion")
    const report: BenchmarkHistoryPreflightReport = {
      ...base,
      action: "quarantined_backslash_explosion",
      sizeBytes: info.size,
      quarantinePath,
      reason: "detected an abnormal repeated-backslash run near the start of task-ledger.json",
    }
    if (input.writeReport !== false) await writeBenchmarkHistoryPreflightReport(input.outDir, report)
    return report
  }

  let manifest: BenchmarkHistoryManifest
  try {
    manifest = JSON.parse(raw.replace(/^\uFEFF/, "")) as BenchmarkHistoryManifest
  } catch (error) {
    const quarantinePath = await quarantineBenchmarkHistoryLedger(input.outDir, "invalid-json")
    const report: BenchmarkHistoryPreflightReport = {
      ...base,
      action: "quarantined_invalid_json",
      sizeBytes: info.size,
      quarantinePath,
      reason: error instanceof Error ? error.message : String(error),
    }
    if (input.writeReport !== false) await writeBenchmarkHistoryPreflightReport(input.outDir, report)
    return report
  }

  if (manifest.schema !== "auto-evolve/benchmark-history/v1" || !manifest.tasks || typeof manifest.tasks !== "object") {
    const quarantinePath = await quarantineBenchmarkHistoryLedger(input.outDir, "invalid-schema")
    const report: BenchmarkHistoryPreflightReport = {
      ...base,
      action: "quarantined_invalid_schema",
      sizeBytes: info.size,
      quarantinePath,
      reason: "task-ledger.json does not match auto-evolve/benchmark-history/v1",
    }
    if (input.writeReport !== false) await writeBenchmarkHistoryPreflightReport(input.outDir, report)
    return report
  }

  const actualIDs = new Set(Object.keys(manifest.tasks))
  const missingTaskIDs = input.expectedTaskIDs.filter((id) => !actualIDs.has(id))
  const extraTaskIDs = [...actualIDs].filter((id) => !expected.has(id))
  if (missingTaskIDs.length > 0 || extraTaskIDs.length > 0) {
    const quarantinePath = await quarantineBenchmarkHistoryLedger(input.outDir, "task-mismatch")
    const report: BenchmarkHistoryPreflightReport = {
      ...base,
      action: "quarantined_task_mismatch",
      sizeBytes: info.size,
      actualTaskCount: actualIDs.size,
      missingTaskIDs,
      extraTaskIDs,
      statusDistribution: countStatus(manifest.tasks),
      quarantinePath,
      reason: "task-ledger.json task IDs do not match the current benchmark train IDs",
    }
    if (input.writeReport !== false) await writeBenchmarkHistoryPreflightReport(input.outDir, report)
    return report
  }

  const report: BenchmarkHistoryPreflightReport = {
    ...base,
    action: "ok",
    sizeBytes: info.size,
    actualTaskCount: actualIDs.size,
    statusDistribution: countStatus(manifest.tasks),
  }
  if (input.writeReport !== false) await writeBenchmarkHistoryPreflightReport(input.outDir, report)
  return report
}

export function nextGenerationID(previous?: string) {
  const match = previous?.match(/^generation-(\d+)$/)
  const next = match ? Number.parseInt(match[1]!, 10) + 1 : 1
  return `generation-${String(next).padStart(3, "0")}`
}

export function nextAttemptID(entry?: BenchmarkHistoryTaskEntry) {
  const next = (entry?.attempts.length ?? 0) + 1
  return `attempt-${String(next).padStart(3, "0")}`
}

export async function initializeBenchmarkHistory(input: {
  outDir: string
  runID: string
  taskIDs: string[]
  historyPolicy: LongTaskCampaignHistoryPolicy
  taskPackRoot: string
  trainSplitHash?: string
  testSplitHash?: string
  modelRequested?: string
  modelResolved?: string
  validatorProfileHash?: string
  trustedVerified?: Array<{ id: string; campaignDir: string }>
}) {
  const existing = await readBenchmarkHistory(input.outDir)
  const trustedVerified = new Map((input.trustedVerified ?? []).map((item) => [item.id, item.campaignDir]))
  const freshPolicy = input.historyPolicy === "fresh-all" || input.historyPolicy === "fresh-non-verified"
  const shouldStartFreshGeneration = freshPolicy && (!existing || existing.historyPolicy !== input.historyPolicy)
  const generationID = shouldStartFreshGeneration
    ? nextGenerationID(existing?.currentGenerationID)
    : existing?.currentGenerationID ?? nextGenerationID()
  const createdAt = existing?.createdAt ?? nowISO()
  const tasks: Record<string, BenchmarkHistoryTaskEntry> = {}
  for (const id of input.taskIDs) {
    const previous = existing?.tasks[id]
    const trustedCampaignDir = trustedVerified.get(id)
    const keepVerified =
      input.historyPolicy === "fresh-non-verified" &&
      ((previous?.status === "verified_success" && previous.activeCampaignID && previous.activeCampaignDir) ||
        !!trustedCampaignDir)
    if (keepVerified) {
      if (previous?.status === "verified_success") {
        tasks[id] = { ...previous, allowResume: false, updatedAt: nowISO() }
      } else if (trustedCampaignDir) {
        const campaignID = path.basename(trustedCampaignDir)
        const now = nowISO()
        tasks[id] = {
          id,
          status: "verified_success",
          activeAttemptID: "attempt-legacy-verified",
          activeCampaignID: campaignID,
          activeCampaignDir: trustedCampaignDir,
          allowResume: false,
          updatedAt: now,
          attempts: [
            {
              attemptID: "attempt-legacy-verified",
              campaignID,
              campaignDir: trustedCampaignDir,
              generationID,
              status: "verified_success",
              createdAt: now,
              updatedAt: now,
              reason: "Imported from existing orchestrator-state verified_success during fresh-non-verified migration.",
            },
          ],
        }
      }
      continue
    }
    if ((input.historyPolicy === "resume-current-generation" || !shouldStartFreshGeneration) && previous) {
      tasks[id] = previous
      continue
    }
    const supersededAttempts =
      previous?.attempts.map((attempt) => ({
        ...attempt,
        status: attempt.status === "verified_success" && keepVerified ? attempt.status : ("superseded" as const),
        updatedAt: nowISO(),
        reason:
          attempt.reason ||
          (input.historyPolicy === "fresh-all" || input.historyPolicy === "fresh-non-verified"
            ? `Superseded by ${input.historyPolicy} generation ${generationID}.`
            : attempt.reason),
      })) ?? []
    tasks[id] = {
      id,
      status: "queued",
      allowResume: input.historyPolicy === "resume-current-generation",
      updatedAt: nowISO(),
      attempts: supersededAttempts,
    }
  }
  const manifest: BenchmarkHistoryManifest = {
    schema: "auto-evolve/benchmark-history/v1",
    runID: input.runID,
    currentGenerationID: generationID,
    historyPolicy: input.historyPolicy,
    createdAt,
    updatedAt: nowISO(),
    fingerprint: {
      taskPackRoot: path.resolve(input.taskPackRoot),
      trainSplitHash: input.trainSplitHash,
      testSplitHash: input.testSplitHash,
      modelRequested: input.modelRequested,
      modelResolved: input.modelResolved,
      validatorProfileHash: input.validatorProfileHash,
    },
    tasks,
  }
  await writeBenchmarkHistory(input.outDir, manifest)
  return manifest
}

export function buildHistoryContext(input: {
  outDir: string
  manifest: BenchmarkHistoryManifest
  taskPackRoot: string
  trainSplitHash?: string
  testSplitHash?: string
  modelRequested?: string
  modelResolved?: string
  validatorProfileHash?: string
}): BenchmarkHistoryContext {
  return {
    outDir: input.outDir,
    runID: input.manifest.runID,
    generationID: input.manifest.currentGenerationID,
    historyPolicy: input.manifest.historyPolicy,
    taskPackRoot: path.resolve(input.taskPackRoot),
    trainSplitHash: input.trainSplitHash,
    testSplitHash: input.testSplitHash,
    modelRequested: input.modelRequested,
    modelResolved: input.modelResolved,
    validatorProfileHash: input.validatorProfileHash,
  }
}

export function lineageForAttempt(input: {
  context: BenchmarkHistoryContext
  taskID: string
  attemptID: string
  specHash?: string
}): LongTaskCampaignRunLineage {
  return {
    benchmarkRunID: input.context.runID,
    generationID: input.context.generationID,
    taskID: input.taskID,
    attemptID: input.attemptID,
    historyPolicy: input.context.historyPolicy,
    taskPackRoot: input.context.taskPackRoot,
    trainSplitHash: input.context.trainSplitHash,
    testSplitHash: input.context.testSplitHash,
    specHash: input.specHash,
    modelRequested: input.context.modelRequested,
    modelResolved: input.context.modelResolved,
    validatorProfileHash: input.context.validatorProfileHash,
  }
}

export function defaultReuseForPolicy(policy: LongTaskCampaignHistoryPolicy): LongTaskCampaignReuseState {
  if (policy === "audit-only") {
    return { allowed: false, scope: "audit-only", tainted: false, superseded: false, reason: "Audit-only run." }
  }
  if (policy === "resume-explicit-only") {
    return { allowed: true, scope: "explicit-only", tainted: false, superseded: false }
  }
  return { allowed: true, scope: "current-generation-only", tainted: false, superseded: false }
}

export function isCampaignAuthorizedForContext(
  state: Pick<LongTaskCampaignState, "runLineage" | "reuse">,
  context: BenchmarkHistoryContext,
  taskID?: string,
  expectedSpecHash?: string,
) {
  const lineage = state.runLineage
  if (!lineage) return false
  if (lineage.benchmarkRunID !== context.runID) return false
  if (lineage.generationID !== context.generationID) return false
  if (taskID && lineage.taskID !== taskID) return false
  if (expectedSpecHash && lineage.specHash !== expectedSpecHash) return false
  const reuse = state.reuse
  if (reuse?.tainted || reuse?.superseded) return false
  if (reuse && !reuse.allowed) return false
  return true
}

export async function registerCampaignAttempt(input: {
  outDir: string
  taskID: string
  attemptID: string
  campaignID: string
  campaignDir: string
}) {
  const manifest = await readBenchmarkHistory(input.outDir)
  if (!manifest) return
  const existing = manifest.tasks[input.taskID] ?? {
    id: input.taskID,
    status: "queued" as const,
    allowResume: true,
    updatedAt: nowISO(),
    attempts: [],
  }
  const previous = existing.attempts.filter((attempt) => attempt.attemptID !== input.attemptID)
  const now = nowISO()
  manifest.tasks[input.taskID] = {
    ...existing,
    status: "running",
    activeAttemptID: input.attemptID,
    activeCampaignID: input.campaignID,
    activeCampaignDir: input.campaignDir,
    allowResume: true,
    updatedAt: now,
    attempts: [
      ...previous,
      {
        attemptID: input.attemptID,
        campaignID: input.campaignID,
        campaignDir: input.campaignDir,
        generationID: manifest.currentGenerationID,
        status: "running",
        createdAt: now,
        updatedAt: now,
      },
    ],
  }
  await writeBenchmarkHistory(input.outDir, manifest)
}

export async function updateCampaignAttemptStatus(input: {
  outDir: string
  taskID: string
  campaignID?: string
  status: BenchmarkHistoryTaskStatus
  reason?: string
  taintReason?: string
}) {
  const manifest = await readBenchmarkHistory(input.outDir)
  if (!manifest) return
  const task = manifest.tasks[input.taskID]
  if (!task) return
  const now = nowISO()
  task.status = input.status
  task.updatedAt = now
  if (input.status === "verified_success" || input.status === "terminal") task.allowResume = false
  for (const attempt of task.attempts) {
    if (input.campaignID && attempt.campaignID !== input.campaignID) continue
    attempt.status = input.status
    attempt.updatedAt = now
    attempt.reason = input.reason ?? attempt.reason
    attempt.taintReason = input.taintReason ?? attempt.taintReason
  }
  await writeBenchmarkHistory(input.outDir, manifest)
}

export async function supersedeTaskAttempts(input: {
  outDir: string
  taskID: string
  reason: string
}) {
  const manifest = await readBenchmarkHistory(input.outDir)
  if (!manifest) return
  const task = manifest.tasks[input.taskID]
  if (!task) return
  const now = nowISO()
  task.status = "superseded"
  task.allowResume = false
  task.activeAttemptID = undefined
  task.activeCampaignID = undefined
  task.activeCampaignDir = undefined
  task.updatedAt = now
  for (const attempt of task.attempts) {
    if (attempt.status === "verified_success") continue
    attempt.status = "superseded"
    attempt.updatedAt = now
    attempt.reason = input.reason
  }
  await writeBenchmarkHistory(input.outDir, manifest)
}
