import path from "node:path"
import { randomUUID } from "node:crypto"
import { cp, lstat, rm } from "node:fs/promises"
import {
  autoEvolvePath,
  ensureDirectory,
  pathExists,
  readJsonFile,
  readTextFile,
  writeJsonFile,
  writeTextFile,
} from "../fs"
import type {
  LongTaskArchiveRecord,
  LongTaskFailurePacket,
  LongTaskLearningUnit,
  LongTaskProgressState,
  LongTaskRetryInputBundle,
  LongTaskRetryJournalEntry,
  LongTaskRunSummary,
  LongTaskScratchUnit,
  LongTaskShadowMemoryRecord,
  LongTaskSpec,
  LongTaskValidatorResult,
  LongTaskVerificationClaim,
  LongTaskWorkGraph,
  LongTaskWorkUnit,
} from "./contract"

export interface LongTaskPaths {
  root: string
  runsRoot: string
  archiveRoot: string
  shadowMemoryRoot: string
  candidatesRoot: string
}

export interface LongTaskRunPaths {
  root: string
  preexistingRoot: string
  taskPath: string
  workGraphPath: string
  progressStatePath: string
  claimsPath: string
  validatorResultsPath: string
  failurePacketsPath: string
  scratchUnitsPath: string
  scratchIndexPath: string
  scratchSummaryPath: string
  learningUnitsPath: string
  retryJournalPath: string
  summaryJsonPath: string
  summaryMdPath: string
  bundlesRoot: string
  unitsRoot: string
  planRoot: string
  replanRoot: string
}

function nowISO() {
  return new Date().toISOString()
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "long-task"
}

export function createLongTaskRunID(title: string) {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`
  return `${stamp}-${slugify(title)}`
}

async function ensureJsonlFile(target: string) {
  if (await pathExists(target)) return
  await writeTextFile(target, "")
}

async function appendJsonl<T>(target: string, value: T) {
  await ensureDirectory(path.dirname(target))
  const line = JSON.stringify(value) + "\n"
  const existing = (await pathExists(target)) ? await readTextFile(target) : ""
  await writeTextFile(target, existing + line)
}

async function readJsonl<T>(target: string): Promise<T[]> {
  if (!(await pathExists(target))) return []
  const raw = await readTextFile(target)
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

function short(text: string, limit = 200) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return normalized.slice(0, limit - 3) + "..."
}

export function longTaskPaths(cwd: string): LongTaskPaths {
  const root = autoEvolvePath(cwd, "long-task")
  return {
    root,
    runsRoot: path.join(root, "runs"),
    archiveRoot: path.join(root, "archive"),
    shadowMemoryRoot: path.join(root, "shadow-memory"),
    candidatesRoot: path.join(root, "candidates"),
  }
}

export async function ensureLongTaskLayout(paths: LongTaskPaths) {
  await ensureDirectory(paths.root)
  await ensureDirectory(paths.runsRoot)
  await ensureDirectory(paths.archiveRoot)
  await ensureDirectory(paths.shadowMemoryRoot)
  await ensureDirectory(paths.candidatesRoot)
  await ensureJsonlFile(path.join(paths.archiveRoot, "index.jsonl"))
  await ensureJsonlFile(path.join(paths.shadowMemoryRoot, "index.jsonl"))
}

export function longTaskRunPaths(paths: LongTaskPaths, runID: string): LongTaskRunPaths {
  const root = path.join(paths.runsRoot, runID)
  return {
    root,
    preexistingRoot: path.join(root, "preexisting"),
    taskPath: path.join(root, "task.json"),
    workGraphPath: path.join(root, "work_graph.json"),
    progressStatePath: path.join(root, "progress_state.json"),
    claimsPath: path.join(root, "claims.jsonl"),
    validatorResultsPath: path.join(root, "validator_results.jsonl"),
    failurePacketsPath: path.join(root, "failure_packets.jsonl"),
    scratchUnitsPath: path.join(root, "scratch_units.jsonl"),
    scratchIndexPath: path.join(root, "scratch_index.json"),
    scratchSummaryPath: path.join(root, "scratch_summary.md"),
    learningUnitsPath: path.join(root, "learning_units.jsonl"),
    retryJournalPath: path.join(root, "retry_journal.jsonl"),
    summaryJsonPath: path.join(root, "summary.json"),
    summaryMdPath: path.join(root, "summary.md"),
    bundlesRoot: path.join(root, "bundles"),
    unitsRoot: path.join(root, "units"),
    planRoot: path.join(root, "plan"),
    replanRoot: path.join(root, "replan"),
  }
}

export function longTaskUnitAttemptPaths(run: LongTaskRunPaths, unitID: string, attempt: number) {
  const attemptID = `attempt-${String(attempt).padStart(2, "0")}`
  const root = path.join(run.unitsRoot, unitID, attemptID)
  return {
    root,
    executeDir: path.join(root, "execute"),
    validatorsRoot: path.join(root, "validators"),
    inputBundlePath: path.join(root, "retry_input_bundle.json"),
  }
}

export function longTaskPlanPaths(run: LongTaskRunPaths) {
  return {
    root: run.planRoot,
    graphDraftPath: path.join(run.planRoot, "graph_draft.json"),
  }
}

export function longTaskReplanPaths(run: LongTaskRunPaths, revision: number) {
  const root = path.join(run.replanRoot, `revision-${String(revision).padStart(2, "0")}`)
  return {
    root,
    graphDraftPath: path.join(root, "graph_draft.json"),
  }
}

function uniqueLongTaskEditablePaths(spec: LongTaskSpec) {
  const values = [
    ...(spec.editablePaths ?? []),
    ...(spec.targetPaths ?? []).map((item) => item.path),
  ]
  const unique = Array.from(new Set(values)).sort((left, right) => left.length - right.length)
  const filtered: string[] = []
  for (const candidate of unique) {
    const normalizedCandidate = path.resolve(candidate)
    const covered = filtered.some((existing) => {
      const normalizedExisting = path.resolve(existing)
      return (
        normalizedCandidate === normalizedExisting ||
        normalizedCandidate.startsWith(normalizedExisting + path.sep)
      )
    })
    if (!covered) filtered.push(candidate)
  }
  return filtered
}

async function stageEditablePathsForFreshRun(run: LongTaskRunPaths, spec: LongTaskSpec) {
  await ensureDirectory(run.preexistingRoot)

  const entries: Array<{
    originalPath: string
    archivePath?: string
    kind?: "file" | "directory"
    existed: boolean
  }> = []

  const editablePaths = uniqueLongTaskEditablePaths(spec)

  for (const [index, editablePath] of editablePaths.entries()) {
    if (!(await pathExists(editablePath))) {
      entries.push({
        originalPath: editablePath,
        existed: false,
      })
      continue
    }

    const stats = await lstat(editablePath)
    const kind: "file" | "directory" = stats.isDirectory() ? "directory" : "file"
    const archiveName = `${String(index + 1).padStart(2, "0")}-${path.basename(editablePath) || `target-${index + 1}`}`
    const archivePath = path.join(run.preexistingRoot, archiveName)

    await cp(editablePath, archivePath, {
      recursive: kind === "directory",
      force: true,
    })

    if (kind === "directory") {
      await rm(editablePath, { recursive: true, force: true })
      await ensureDirectory(editablePath)
    } else {
      await rm(editablePath, { force: true })
    }

    entries.push({
      originalPath: editablePath,
      archivePath,
      kind,
      existed: true,
    })
  }

  await writeJsonFile(path.join(run.preexistingRoot, "manifest.json"), {
    createdAt: nowISO(),
    entries,
  })
}

export async function initializeLongTaskRun(input: {
  cwd: string
  spec: LongTaskSpec
  workGraph: LongTaskWorkGraph
  progressState: LongTaskProgressState
}) {
  const paths = longTaskPaths(input.cwd)
  await ensureLongTaskLayout(paths)

  const runID = input.progressState.runID || createLongTaskRunID(input.spec.title)
  const run = longTaskRunPaths(paths, runID)

  await ensureDirectory(run.root)
  await ensureDirectory(run.preexistingRoot)
  await ensureDirectory(run.bundlesRoot)
  await ensureDirectory(run.unitsRoot)
  await ensureDirectory(run.planRoot)
  await ensureDirectory(run.replanRoot)

  await stageEditablePathsForFreshRun(run, input.spec)

  await writeJsonFile(run.taskPath, input.spec)
  await writeJsonFile(run.workGraphPath, input.workGraph)
  await writeJsonFile(run.progressStatePath, input.progressState)
  await ensureJsonlFile(run.claimsPath)
  await ensureJsonlFile(run.validatorResultsPath)
  await ensureJsonlFile(run.failurePacketsPath)
  await ensureJsonlFile(run.scratchUnitsPath)
  await ensureJsonlFile(run.learningUnitsPath)
  await ensureJsonlFile(run.retryJournalPath)
  await writeJsonFile(run.scratchIndexPath, {
    updatedAt: nowISO(),
    totalScratchUnits: 0,
    byKind: {},
    byUnit: {},
  })
  await writeTextFile(run.scratchSummaryPath, "# Scratch Summary\n\n- no scratch units yet\n")
  await writeJsonFile(run.summaryJsonPath, {
    runID,
    title: input.spec.title,
    status: input.progressState.status,
    summary: "Long-task run initialized.",
  })
  await writeTextFile(run.summaryMdPath, "# Long-Task Summary\n\n- status: initialized\n")

  return {
    runID,
    paths,
    run,
  }
}

export function resolveExistingLongTaskRun(cwd: string, runID: string) {
  const paths = longTaskPaths(cwd)
  return {
    paths,
    run: longTaskRunPaths(paths, runID),
  }
}

export async function readLongTaskSpec(run: LongTaskRunPaths) {
  return readJsonFile<LongTaskSpec>(run.taskPath)
}

export async function readLongTaskWorkGraph(run: LongTaskRunPaths) {
  return readJsonFile<LongTaskWorkGraph>(run.workGraphPath)
}

export async function writeLongTaskWorkGraph(run: LongTaskRunPaths, graph: LongTaskWorkGraph) {
  await writeJsonFile(run.workGraphPath, {
    ...graph,
    updatedAt: nowISO(),
  })
}

export async function readLongTaskProgressState(run: LongTaskRunPaths) {
  return readJsonFile<LongTaskProgressState>(run.progressStatePath)
}

export async function writeLongTaskProgressState(run: LongTaskRunPaths, progress: LongTaskProgressState) {
  await writeJsonFile(run.progressStatePath, {
    ...progress,
    updatedAt: nowISO(),
  })
}

export async function appendVerificationClaim(run: LongTaskRunPaths, claim: LongTaskVerificationClaim) {
  await appendJsonl(run.claimsPath, claim)
}

export async function appendValidatorResult(run: LongTaskRunPaths, result: LongTaskValidatorResult) {
  await appendJsonl(run.validatorResultsPath, result)
}

export async function appendFailurePacket(run: LongTaskRunPaths, packet: LongTaskFailurePacket) {
  await appendJsonl(run.failurePacketsPath, packet)
}

export async function appendScratchUnit(run: LongTaskRunPaths, unit: LongTaskScratchUnit) {
  await appendJsonl(run.scratchUnitsPath, unit)
}

export async function appendLearningUnit(run: LongTaskRunPaths, unit: LongTaskLearningUnit) {
  await appendJsonl(run.learningUnitsPath, unit)
}

export async function appendRetryJournalEntry(run: LongTaskRunPaths, entry: LongTaskRetryJournalEntry) {
  await appendJsonl(run.retryJournalPath, entry)
}

export async function readVerificationClaims(run: LongTaskRunPaths) {
  return readJsonl<LongTaskVerificationClaim>(run.claimsPath)
}

export async function readValidatorResults(run: LongTaskRunPaths) {
  return readJsonl<LongTaskValidatorResult>(run.validatorResultsPath)
}

export async function readFailurePackets(run: LongTaskRunPaths) {
  return readJsonl<LongTaskFailurePacket>(run.failurePacketsPath)
}

export async function readScratchUnits(run: LongTaskRunPaths) {
  return readJsonl<LongTaskScratchUnit>(run.scratchUnitsPath)
}

export async function readLearningUnits(run: LongTaskRunPaths) {
  return readJsonl<LongTaskLearningUnit>(run.learningUnitsPath)
}

export async function writeRetryInputBundle(targetPath: string, bundle: LongTaskRetryInputBundle) {
  await writeJsonFile(targetPath, bundle)
  return targetPath
}

export async function buildRetryInputBundle(input: {
  paths: LongTaskPaths
  run: LongTaskRunPaths
  spec: LongTaskSpec
  unitID: string
  maxClaims?: number
  maxFailurePackets?: number
  maxScratchUnits?: number
  maxLearningUnits?: number
  maxShadowMemory?: number
}) {
  const graph = await readLongTaskWorkGraph(input.run)
  const progress = await readLongTaskProgressState(input.run)
  const unit = graph.units.find((item) => item.id === input.unitID)
  if (!unit) {
    throw new Error(`Long-task work unit not found: ${input.unitID}`)
  }

  const [claims, failures, scratch, learning, shadow] = await Promise.all([
    readVerificationClaims(input.run),
    readFailurePackets(input.run),
    readScratchUnits(input.run),
    readLearningUnits(input.run),
    readJsonl<LongTaskShadowMemoryRecord>(path.join(input.paths.shadowMemoryRoot, "index.jsonl")),
  ])

  const relatedUnitIDs = new Set([unit.id, ...unit.dependsOn])
  const scope = input.spec.shadowMemoryScope ?? {
    namespace: input.spec.taskFamily ?? "long-task",
    tags: input.spec.domainTags ?? [],
    retrievalMode: "isolated" as const,
  }
  const relevantShadowMemory =
    scope.retrievalMode === "manual"
      ? []
      : shadow
          .filter((record) => record.runID !== progress.runID)
          .filter((record) => {
            if (scope.retrievalMode === "isolated") {
              return record.namespace === scope.namespace
            }
            return record.namespace === scope.namespace || record.tags.some((tag) => scope.tags.includes(tag))
          })
          .slice(-(input.maxShadowMemory ?? 6))

  return {
    id: `retry-${randomUUID().slice(0, 8)}`,
    runID: progress.runID,
    unitID: unit.id,
    createdAt: nowISO(),
    progressState: progress,
    currentUnit: unit,
    recentClaims: claims.filter((item) => relatedUnitIDs.has(item.unitID)).slice(-(input.maxClaims ?? 3)),
    recentFailurePackets: failures
      .filter((item) => relatedUnitIDs.has(item.unitID))
      .slice(-(input.maxFailurePackets ?? 4)),
    relevantScratchUnits: scratch
      .filter((item) => relatedUnitIDs.has(item.unitID) || item.relatedUnitIDs.some((id) => relatedUnitIDs.has(id)))
      .slice(-(input.maxScratchUnits ?? 10)),
    relevantLearningUnits: learning
      .filter((item) => !item.unitID || relatedUnitIDs.has(item.unitID))
      .slice(-(input.maxLearningUnits ?? 8)),
    relevantShadowMemory,
  } satisfies LongTaskRetryInputBundle
}

export async function writeScratchDerivedViews(run: LongTaskRunPaths) {
  const scratch = await readScratchUnits(run)
  const byKind: Record<string, number> = {}
  const byUnit: Record<string, number> = {}

  for (const item of scratch) {
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1
    byUnit[item.unitID] = (byUnit[item.unitID] ?? 0) + 1
  }

  await writeJsonFile(run.scratchIndexPath, {
    updatedAt: nowISO(),
    totalScratchUnits: scratch.length,
    byKind,
    byUnit,
  })

  const latest = scratch.slice(-12)
  const lines = [
    "# Scratch Summary",
    "",
    `- total scratch units: ${scratch.length}`,
    `- updated at: ${nowISO()}`,
    "",
    "## Latest",
    "",
  ]

  if (!latest.length) {
    lines.push("- no scratch units yet")
  } else {
    for (const item of latest) {
      lines.push(`- [${item.unitID}] ${item.kind}: ${short(item.statement, 140)}`)
    }
  }

  await writeTextFile(run.scratchSummaryPath, lines.join("\n") + "\n")
}

export async function buildLongTaskRunSummary(run: LongTaskRunPaths): Promise<LongTaskRunSummary> {
  const [spec, graph, progress, failures, learning] = await Promise.all([
    readLongTaskSpec(run),
    readLongTaskWorkGraph(run),
    readLongTaskProgressState(run),
    readFailurePackets(run),
    readLearningUnits(run),
  ])

  const verifiedUnits = graph.units.filter((item) => item.status === "verified").length
  const failedUnits = graph.units.filter((item) => item.status === "failed").length
  const blockedUnits = graph.units.filter((item) => item.status === "blocked").length

  return {
    runID: progress.runID,
    title: spec.title,
    goal: spec.goal,
    status: progress.status,
    taskFamily: spec.taskFamily,
    domainTags: spec.domainTags ?? [],
    graphRevision: progress.graphRevision,
    totalUnits: graph.units.length,
    verifiedUnits,
    failedUnits,
    blockedUnits,
    totalUnitAttempts: progress.totalUnitAttempts,
    validatorCalls: progress.validatorCalls,
    failurePacketCount: failures.length,
    learningUnitCount: learning.length,
    summary:
      progress.finalSummary ??
      `Long-task ended with status ${progress.status}; verified ${verifiedUnits}/${graph.units.length} work units.`,
  }
}

export async function writeLongTaskRunSummary(run: LongTaskRunPaths, summary: LongTaskRunSummary) {
  await writeJsonFile(run.summaryJsonPath, summary)
  const lines = [
    "# Long-Task Summary",
    "",
    `- run: ${summary.runID}`,
    `- title: ${summary.title}`,
    `- status: ${summary.status}`,
    `- graph revision: ${summary.graphRevision}`,
    `- units: ${summary.verifiedUnits}/${summary.totalUnits} verified`,
    `- failed units: ${summary.failedUnits}`,
    `- blocked units: ${summary.blockedUnits}`,
    `- unit attempts: ${summary.totalUnitAttempts}`,
    `- validator calls: ${summary.validatorCalls}`,
    `- failure packets: ${summary.failurePacketCount}`,
    `- learning units: ${summary.learningUnitCount}`,
    "",
    "## Summary",
    "",
    summary.summary,
    "",
  ]
  await writeTextFile(run.summaryMdPath, lines.join("\n"))
}

export async function appendArchiveRecord(paths: LongTaskPaths, record: LongTaskArchiveRecord) {
  await appendJsonl(path.join(paths.archiveRoot, "index.jsonl"), record)
}

export async function appendShadowMemoryRecord(paths: LongTaskPaths, record: LongTaskShadowMemoryRecord) {
  await appendJsonl(path.join(paths.shadowMemoryRoot, "index.jsonl"), record)
}

export async function readShadowMemoryRecords(paths: LongTaskPaths) {
  return readJsonl<LongTaskShadowMemoryRecord>(path.join(paths.shadowMemoryRoot, "index.jsonl"))
}

export function defaultArchiveRecord(input: {
  run: LongTaskRunPaths
  summary: LongTaskRunSummary
}): LongTaskArchiveRecord {
  return {
    id: `archive-${randomUUID().slice(0, 8)}`,
    runID: input.summary.runID,
    createdAt: nowISO(),
    status: input.summary.status,
    taskFamily: input.summary.taskFamily,
    domainTags: input.summary.domainTags,
    title: input.summary.title,
    goal: input.summary.goal,
    summary: input.summary.summary,
    failurePacketCount: input.summary.failurePacketCount,
    learningUnitCount: input.summary.learningUnitCount,
    runRoot: input.run.root,
  }
}

export function defaultShadowMemoryRecord(input: {
  run: LongTaskRunPaths
  summary: LongTaskRunSummary
  spec: LongTaskSpec
}): LongTaskShadowMemoryRecord {
  const scope = input.spec.shadowMemoryScope ?? {
    namespace: input.spec.taskFamily ?? "long-task",
    tags: input.spec.domainTags ?? [],
    retrievalMode: "isolated" as const,
  }

  return {
    id: `shadow-${randomUUID().slice(0, 8)}`,
    runID: input.summary.runID,
    createdAt: nowISO(),
    namespace: scope.namespace,
    tags: scope.tags,
    retrievalMode: scope.retrievalMode,
    status: input.summary.status === "verified_success" ? "candidate" : "hold",
    summary: input.summary.summary,
    evidenceRef: input.run.summaryJsonPath,
  }
}

export function createInitialLongTaskProgressState(runID: string): LongTaskProgressState {
  return {
    runID,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    status: "planning",
    graphRevision: 0,
    completedUnitIDs: [],
    blockedUnitIDs: [],
    failedUnitIDs: [],
    nextPriorityUnitIDs: [],
    totalUnitAttempts: 0,
    validatorCalls: 0,
    graphReplanCount: 0,
    noProgressCycles: 0,
  }
}

export function buildLongTaskWorkUnit(
  input: Omit<LongTaskWorkUnit, "status" | "attemptCount"> & {
    status?: LongTaskWorkUnit["status"]
    attemptCount?: number
  },
) {
  return {
    ...input,
    status: input.status ?? "planned",
    attemptCount: input.attemptCount ?? 0,
  } satisfies LongTaskWorkUnit
}
