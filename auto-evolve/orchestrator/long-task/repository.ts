import path from "node:path"
import { randomUUID } from "node:crypto"
import process from "node:process"
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
  LongTaskCandidatePackage,
  LongTaskFailurePacket,
  LongTaskLearningUnit,
  LongTaskOperationalContextItem,
  LongTaskProgressState,
  LongTaskRetryLesson,
  LongTaskRetryInputBundle,
  LongTaskRetryJournalEntry,
  LongTaskRunStatus,
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
  finalizationStatePath: string
  claimsPath: string
  validatorResultsPath: string
  failurePacketsPath: string
  scratchUnitsPath: string
  scratchIndexPath: string
  scratchSummaryPath: string
  learningUnitsPath: string
  retryLessonsPath: string
  retryJournalPath: string
  operationalContextPath: string
  operationalContextSummaryPath: string
  summaryJsonPath: string
  summaryMdPath: string
  bundlesRoot: string
  unitsRoot: string
  planRoot: string
  replanRoot: string
}

export interface LongTaskFinalizationState {
  runID: string
  status: LongTaskRunStatus
  completedAt: string
  summaryPath: string
  archiveRecordID: string
  shadowMemoryRecordID: string
  acceptanceRecordID: string
  acceptanceRecordPath: string
  candidateID: string
  candidatePath: string
  maintenanceRequestID: string
  maintenanceRequestPath: string
}

function nowISO() {
  return new Date().toISOString()
}

function detectOwnerCommandHint() {
  const argv = process.argv.map((item) => item.toLowerCase())
  if (argv.some((item) => item.includes("run-long-task-campaign"))) return "run-long-task-campaign"
  if (argv.some((item) => item.includes("run-long-task"))) return "run-long-task"
  return undefined
}

function slugify(input: string) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "long-task"
  )
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

function stripRecordTimestamps<T extends { createdAt?: string; updatedAt?: string }>(value: T) {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = value
  return rest
}

function sameLogicalRecord<T extends { createdAt?: string; updatedAt?: string }>(left: T, right: T) {
  return JSON.stringify(stripRecordTimestamps(left)) === JSON.stringify(stripRecordTimestamps(right))
}

async function findJsonlRecordByID<T extends { id: string }>(target: string, id: string): Promise<T | undefined> {
  return (await readJsonl<T>(target)).find((item) => item.id === id)
}

function short(text: string, limit = 200) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return normalized.slice(0, limit - 3) + "..."
}

function dedupeByID<T extends { id: string }>(items: T[]) {
  const seen = new Set<string>()
  const ordered: T[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    ordered.push(item)
  }
  return ordered
}

function uniqueStrings(items: string[]) {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)))
}

export function longTaskPaths(cwd: string): LongTaskPaths {
  const root = autoEvolvePath(cwd, "runtime-state", "long-task")
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
  await ensureJsonlFile(path.join(paths.candidatesRoot, "index.jsonl"))
}

export function longTaskRunPaths(paths: LongTaskPaths, runID: string): LongTaskRunPaths {
  const root = path.join(paths.runsRoot, runID)
  return {
    root,
    preexistingRoot: path.join(root, "preexisting"),
    taskPath: path.join(root, "task.json"),
    workGraphPath: path.join(root, "work_graph.json"),
    progressStatePath: path.join(root, "progress_state.json"),
    finalizationStatePath: path.join(root, "finalization.json"),
    claimsPath: path.join(root, "claims.jsonl"),
    validatorResultsPath: path.join(root, "validator_results.jsonl"),
    failurePacketsPath: path.join(root, "failure_packets.jsonl"),
    scratchUnitsPath: path.join(root, "scratch_units.jsonl"),
    scratchIndexPath: path.join(root, "scratch_index.json"),
    scratchSummaryPath: path.join(root, "scratch_summary.md"),
    learningUnitsPath: path.join(root, "learning_units.jsonl"),
    retryLessonsPath: path.join(root, "retry_lessons.jsonl"),
    retryJournalPath: path.join(root, "retry_journal.jsonl"),
    operationalContextPath: path.join(root, "operational_context.json"),
    operationalContextSummaryPath: path.join(root, "operational_context.md"),
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

export function resolveLongTaskEditablePaths(spec: LongTaskSpec) {
  const values = [...(spec.editablePaths ?? []), ...(spec.targetPaths ?? []).map((item) => item.path)]
  const unique = Array.from(new Set(values)).sort((left, right) => left.length - right.length)
  const filtered: string[] = []
  for (const candidate of unique) {
    const normalizedCandidate = path.resolve(candidate)
    const covered = filtered.some((existing) => {
      const normalizedExisting = path.resolve(existing)
      return normalizedCandidate === normalizedExisting || normalizedCandidate.startsWith(normalizedExisting + path.sep)
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

  const editablePaths = resolveLongTaskEditablePaths(spec)

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
  await ensureJsonlFile(run.retryLessonsPath)
  await ensureJsonlFile(run.retryJournalPath)
  await writeJsonFile(run.operationalContextPath, [])
  await writeTextFile(
    run.operationalContextSummaryPath,
    "# Run-Global Operational Context\n\n- no promoted context yet\n",
  )
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

export function resolveLongTaskFormalPackageRoots(spec: LongTaskSpec) {
  const inferred = (spec.targetPaths ?? [])
    .filter((item) => item.role === "experience-workspace")
    .map((item) => item.path)
  const editableHints = (spec.editablePaths ?? []).filter((item) =>
    path.basename(item).toLowerCase().includes("expert-workspace"),
  )
  return uniqueStrings([...(spec.formalPackageRoots ?? []), ...inferred, ...editableHints])
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
  const heartbeatAt = nowISO()
  await writeJsonFile(run.progressStatePath, {
    ...progress,
    ownerPID: progress.ownerPID ?? process.pid,
    ownerCommandHint: progress.ownerCommandHint ?? detectOwnerCommandHint(),
    heartbeatAt,
    updatedAt: heartbeatAt,
  })
}

export async function readLongTaskFinalizationState(run: LongTaskRunPaths) {
  if (!(await pathExists(run.finalizationStatePath))) return undefined
  return readJsonFile<LongTaskFinalizationState>(run.finalizationStatePath)
}

export async function writeLongTaskFinalizationState(run: LongTaskRunPaths, state: LongTaskFinalizationState) {
  await writeJsonFile(run.finalizationStatePath, state)
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

export async function appendRetryLesson(run: LongTaskRunPaths, lesson: LongTaskRetryLesson) {
  await appendJsonl(run.retryLessonsPath, lesson)
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

export async function readRetryLessons(run: LongTaskRunPaths) {
  return readJsonl<LongTaskRetryLesson>(run.retryLessonsPath)
}

export async function readOperationalContext(run: LongTaskRunPaths) {
  if (!(await pathExists(run.operationalContextPath))) return [] as LongTaskOperationalContextItem[]
  return readJsonFile<LongTaskOperationalContextItem[]>(run.operationalContextPath)
}

function operationalContextSignature(item: Pick<LongTaskOperationalContextItem, "kind" | "statement">) {
  return `${item.kind}::${item.statement.trim().toLowerCase()}`
}

function mergeOperationalContextItem(
  existing: LongTaskOperationalContextItem,
  incoming: LongTaskOperationalContextItem,
): LongTaskOperationalContextItem {
  return {
    ...existing,
    updatedAt: incoming.updatedAt,
    sourceUnitID: incoming.sourceUnitID ?? existing.sourceUnitID,
    sourceAttempt: incoming.sourceAttempt ?? existing.sourceAttempt,
    status: existing.status === "confirmed" || incoming.status === "confirmed" ? "confirmed" : "candidate",
    rationale: incoming.rationale ?? existing.rationale,
    refs: uniqueStrings([...existing.refs, ...incoming.refs]),
    tags: uniqueStrings([...existing.tags, ...incoming.tags]),
  }
}

function sortOperationalContextItems(items: LongTaskOperationalContextItem[]) {
  return [...items].sort((left, right) => {
    if (left.status !== right.status) return left.status === "confirmed" ? -1 : 1
    if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1
    return left.statement.localeCompare(right.statement)
  })
}

export async function writeOperationalContext(run: LongTaskRunPaths, items: LongTaskOperationalContextItem[]) {
  const sorted = sortOperationalContextItems(items)
  await writeJsonFile(run.operationalContextPath, sorted)
  const sections: Array<{
    title: string
    kind: LongTaskOperationalContextItem["kind"]
  }> = [
    { title: "Confirmed Facts", kind: "confirmed_fact" },
    { title: "Validated Methods", kind: "validated_method" },
    { title: "Blocking Issues", kind: "blocking_issue" },
    { title: "Failed Paths", kind: "failed_path" },
    { title: "Tool Entrypoints", kind: "tool_entrypoint" },
    { title: "Package Gaps", kind: "package_gap" },
  ]
  const lines = [
    "# Run-Global Operational Context",
    "",
    `- total_items: ${sorted.length}`,
    `- updated_at: ${nowISO()}`,
    "",
  ]
  if (!sorted.length) {
    lines.push("- no promoted context yet", "")
  } else {
    for (const section of sections) {
      const matches = sorted.filter((item) => item.kind === section.kind)
      if (!matches.length) continue
      lines.push(`## ${section.title}`, "")
      for (const item of matches) {
        const marker = item.status === "confirmed" ? "[confirmed]" : "[candidate]"
        lines.push(`- ${marker} ${item.statement}`)
        if (item.rationale) lines.push(`  rationale: ${short(item.rationale, 180)}`)
        if (item.tags.length) lines.push(`  tags: ${item.tags.join(", ")}`)
      }
      lines.push("")
    }
  }
  await writeTextFile(run.operationalContextSummaryPath, lines.join("\n").trimEnd() + "\n")
  return sorted
}

export async function upsertOperationalContext(run: LongTaskRunPaths, items: LongTaskOperationalContextItem[]) {
  if (!items.length) return readOperationalContext(run)
  const existing = await readOperationalContext(run)
  const merged = new Map<string, LongTaskOperationalContextItem>()
  for (const item of existing) merged.set(operationalContextSignature(item), item)
  for (const item of items) {
    const signature = operationalContextSignature(item)
    const current = merged.get(signature)
    merged.set(signature, current ? mergeOperationalContextItem(current, item) : item)
  }
  return writeOperationalContext(run, Array.from(merged.values()))
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
  maxRetryLessons?: number
  maxShadowMemory?: number
  maxOperationalContext?: number
}) {
  const graph = await readLongTaskWorkGraph(input.run)
  const progress = await readLongTaskProgressState(input.run)
  const unit = graph.units.find((item) => item.id === input.unitID)
  if (!unit) {
    throw new Error(`Long-task work unit not found: ${input.unitID}`)
  }

  const [claims, failures, scratch, learning, retryLessons, shadow, operationalContext] = await Promise.all([
    readVerificationClaims(input.run),
    readFailurePackets(input.run),
    readScratchUnits(input.run),
    readLearningUnits(input.run),
    readRetryLessons(input.run),
    readJsonl<LongTaskShadowMemoryRecord>(path.join(input.paths.shadowMemoryRoot, "index.jsonl")),
    readOperationalContext(input.run),
  ])

  const relatedUnitIDs = new Set([unit.id, ...unit.dependsOn])
  const sameUnitRecentClaims = claims.filter((item) => item.unitID === unit.id).slice(-(input.maxClaims ?? 3))
  const dependencyClaims = claims
    .filter((item) => item.unitID !== unit.id && unit.dependsOn.includes(item.unitID))
    .slice(-(input.maxClaims ?? 4))
  const sameUnitFailures = failures.filter((item) => item.unitID === unit.id)
  const relatedFailures = failures.filter((item) => item.unitID !== unit.id && relatedUnitIDs.has(item.unitID))
  const globalRecentFailures = failures.slice(-(input.maxFailurePackets ?? 4))
  const sameUnitRetryLessons = retryLessons
    .filter((item) => item.unitID === unit.id)
    .slice(-(input.maxRetryLessons ?? 4))
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
    recentFailurePackets: dedupeByID(
      sameUnitFailures
        .concat(relatedFailures)
        .concat(globalRecentFailures)
        .slice(-Math.max(input.maxFailurePackets ?? 4, 6)),
    ).slice(-(input.maxFailurePackets ?? 4)),
    sameUnitRecentClaims,
    dependencyClaims,
    sameUnitLastFailure: sameUnitFailures.at(-1) ?? failures.at(-1),
    sameUnitRetryLessons,
    relevantScratchUnits: scratch
      .filter((item) => relatedUnitIDs.has(item.unitID) || item.relatedUnitIDs.some((id) => relatedUnitIDs.has(id)))
      .slice(-(input.maxScratchUnits ?? 10)),
    relevantLearningUnits: learning
      .filter(
        (item) =>
          !item.unitID ||
          relatedUnitIDs.has(item.unitID) ||
          item.scope === "pattern" ||
          item.scope === "global_candidate",
      )
      .slice(-(input.maxLearningUnits ?? 8)),
    relevantShadowMemory,
    runGlobalOperationalContext: sortOperationalContextItems(operationalContext).slice(
      0,
      input.maxOperationalContext ?? 12,
    ),
    formalPackageRoots: resolveLongTaskFormalPackageRoots(input.spec),
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
  const [spec, graph, progress, failures, learning, retryLessons, operationalContext, validatorResults] = await Promise.all([
    readLongTaskSpec(run),
    readLongTaskWorkGraph(run),
    readLongTaskProgressState(run),
    readFailurePackets(run),
    readLearningUnits(run),
    readRetryLessons(run),
    readOperationalContext(run),
    readValidatorResults(run),
  ])

  const verifiedUnits = graph.units.filter((item) => item.status === "verified").length
  const failedUnits = graph.units.filter((item) => item.status === "failed").length
  const blockedUnits = graph.units.filter((item) => item.status === "blocked").length
  const completionValidatorIDs =
    graph.completionValidatorIDs.length > 0
      ? graph.completionValidatorIDs
      : spec.disableCompletionValidators
        ? []
        : spec.validators.filter((item) => item.required !== false).map((item) => item.id)
  const completionValidatorIDSet = new Set(completionValidatorIDs)
  const completionResults = validatorResults.filter(
    (item) => item.unitID === "__completion__" && completionValidatorIDSet.has(item.validatorID),
  )
  const completionExecutedValidatorIDs = new Set(completionResults.map((item) => item.validatorID))
  const completionPassed = completionResults.filter((item) => item.passed).length
  const completionFailed = completionResults.filter((item) => !item.passed).length
  const unitsConverged = graph.units.length > 0 && graph.units.every((item) => item.status === "verified")
  const completionGateMode = completionValidatorIDs.length > 0 ? "required" : "deferred_or_disabled"
  const completionGatePassed =
    completionGateMode === "deferred_or_disabled"
      ? true
      : completionExecutedValidatorIDs.size >= completionValidatorIDs.length &&
        completionFailed === 0 &&
        completionPassed >= completionValidatorIDs.length
  const normalizedStatus = progress.status === "verified_success" ? "graph_completed" : progress.status
  const roundClosure =
    normalizedStatus === "graph_completed"
      ? completionGatePassed
        ? "closed_success"
        : "closed_repairable"
      : normalizedStatus === "blocked_failure" || normalizedStatus === "stagnation_failure"
        ? "closed_blocked"
        : normalizedStatus === "exhausted_failure"
          ? "closed_infra_failure"
          : "closed_blocked"
  const gateFailureKind =
    normalizedStatus === "graph_completed" && !completionGatePassed
      ? "completion_gate_failed"
      : normalizedStatus === "exhausted_failure"
        ? "infrastructure_failure"
        : normalizedStatus === "blocked_failure" || normalizedStatus === "stagnation_failure"
          ? "execution_blocked"
          : undefined
  const gateFailureSummary =
    gateFailureKind === "completion_gate_failed"
      ? `Execution graph completed, but the required completion gate did not pass (executed=${completionExecutedValidatorIDs.size}/${completionValidatorIDs.length}, failed=${completionFailed}).`
      : gateFailureKind === "infrastructure_failure"
        ? "Execution stopped after exhausting retries or budgets before a clean round closure."
        : gateFailureKind === "execution_blocked"
          ? "Execution stopped before closure because the run became blocked or stagnated."
          : undefined

  return {
    runID: progress.runID,
    title: spec.title,
    goal: spec.goal,
    status: normalizedStatus,
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
    retryLessonCount: retryLessons.length,
    operationalContextCount: operationalContext.length,
    verificationSignal: {
      unitsConverged,
      completionGateMode,
      completionValidatorsRequired: completionValidatorIDs.length,
      completionValidatorsExecuted: completionExecutedValidatorIDs.size,
      completionValidatorsPassed: completionPassed,
      completionValidatorsFailed: completionFailed,
      completionGatePassed,
    },
    roundClosure,
    gateFailureKind,
    gateFailureSummary,
    summary:
      progress.finalSummary ??
      `Long-task ended with status ${normalizedStatus}; verified ${verifiedUnits}/${graph.units.length} work units.`,
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
    `- retry lessons: ${summary.retryLessonCount}`,
    `- run-global context items: ${summary.operationalContextCount}`,
    `- units converged: ${summary.verificationSignal.unitsConverged}`,
    `- completion gate mode: ${summary.verificationSignal.completionGateMode}`,
    `- completion validators required: ${summary.verificationSignal.completionValidatorsRequired}`,
    `- completion validators executed: ${summary.verificationSignal.completionValidatorsExecuted}`,
    `- completion validators passed: ${summary.verificationSignal.completionValidatorsPassed}`,
    `- completion validators failed: ${summary.verificationSignal.completionValidatorsFailed}`,
    `- completion gate passed: ${summary.verificationSignal.completionGatePassed}`,
    `- round closure: ${summary.roundClosure}`,
    `- gate failure kind: ${summary.gateFailureKind ?? "none"}`,
    `- gate failure summary: ${summary.gateFailureSummary ?? "none"}`,
    "",
    "## Summary",
    "",
    summary.summary,
    "",
  ]
  await writeTextFile(run.summaryMdPath, lines.join("\n"))
}

export async function appendArchiveRecord(paths: LongTaskPaths, record: LongTaskArchiveRecord) {
  const indexPath = path.join(paths.archiveRoot, "index.jsonl")
  const existing = await findJsonlRecordByID<LongTaskArchiveRecord>(indexPath, record.id)
  if (existing) return existing
  await appendJsonl(indexPath, record)
  return record
}

export async function appendShadowMemoryRecord(paths: LongTaskPaths, record: LongTaskShadowMemoryRecord) {
  const indexPath = path.join(paths.shadowMemoryRoot, "index.jsonl")
  const existing = await findJsonlRecordByID<LongTaskShadowMemoryRecord>(indexPath, record.id)
  if (existing) return existing
  await appendJsonl(indexPath, record)
  return record
}

function candidateDir(paths: LongTaskPaths, candidateID: string) {
  return path.join(paths.candidatesRoot, candidateID)
}

function candidateMetadataPath(paths: LongTaskPaths, candidateID: string) {
  return path.join(candidateDir(paths, candidateID), "candidate.json")
}

export async function writeLongTaskCandidatePackage(
  paths: LongTaskPaths,
  input: Omit<LongTaskCandidatePackage, "createdAt" | "updatedAt"> & {
    createdAt?: string
    updatedAt?: string
  },
) {
  await ensureLongTaskLayout(paths)
  const target = candidateMetadataPath(paths, input.id)
  const indexPath = path.join(paths.candidatesRoot, "index.jsonl")
  const existing =
    (await readJsonFile<LongTaskCandidatePackage>(target).catch(() => undefined)) ??
    (await findJsonlRecordByID<LongTaskCandidatePackage>(indexPath, input.id))
  const draft: LongTaskCandidatePackage = {
    ...input,
    id: existing?.id ?? input.id,
    createdAt: existing?.createdAt ?? input.createdAt ?? nowISO(),
    updatedAt: input.updatedAt ?? nowISO(),
  }
  const candidate: LongTaskCandidatePackage =
    existing && sameLogicalRecord(existing, draft) ? { ...draft, updatedAt: existing.updatedAt } : draft
  await ensureDirectory(candidateDir(paths, candidate.id))
  await writeJsonFile(target, candidate)
  const existingIndexed = await findJsonlRecordByID<LongTaskCandidatePackage>(indexPath, candidate.id)
  if (!existingIndexed || !sameLogicalRecord(existingIndexed, candidate)) {
    await appendJsonl(indexPath, candidate)
  }
  return {
    candidate,
    path: target,
  }
}

export async function readShadowMemoryRecords(paths: LongTaskPaths) {
  return readJsonl<LongTaskShadowMemoryRecord>(path.join(paths.shadowMemoryRoot, "index.jsonl"))
}

export function defaultArchiveRecord(input: {
  run: LongTaskRunPaths
  summary: LongTaskRunSummary
}): LongTaskArchiveRecord {
  return {
    id: `archive-${input.summary.runID}`,
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
    id: `shadow-${input.summary.runID}`,
    runID: input.summary.runID,
    createdAt: nowISO(),
    namespace: scope.namespace,
    tags: scope.tags,
    retrievalMode: scope.retrievalMode,
    status: input.summary.status === "graph_completed" ? "candidate" : "hold",
    summary: input.summary.summary,
    evidenceRef: input.run.summaryJsonPath,
  }
}

export function createInitialLongTaskProgressState(runID: string): LongTaskProgressState {
  const createdAt = nowISO()
  return {
    runID,
    createdAt,
    updatedAt: createdAt,
    ownerPID: process.pid,
    ownerCommandHint: detectOwnerCommandHint(),
    heartbeatAt: createdAt,
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
