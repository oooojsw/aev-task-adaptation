import path from "node:path"
import process from "node:process"
import { randomUUID } from "node:crypto"
import { cp, lstat, readdir, rm } from "node:fs/promises"
import {
  autoEvolvePath,
  ensureDirectory,
  pathExists,
  readJsonFile,
  readTextFile,
  writeJsonFile,
  writeTextFile,
} from "../fs"
import {
  experienceWorkspacePathsFromRoot,
  readExperienceWorkspace,
  writeExperienceWorkspaceSnapshot,
} from "../experience-workspace"
import { runLongTask } from "../long-task/runner"
import { runLongTaskValidator } from "../long-task/validators"
import { readOperationalContext, resolveExistingLongTaskRun } from "../long-task/repository"
import { loadLongTaskSpec } from "../long-task/spec"
import type {
  LongTaskBudgets,
  LongTaskOperationalContextItem,
  LongTaskProgressState,
  LongTaskRunStatus,
  LongTaskSpec,
  LongTaskValidatorResult,
  LongTaskWorkUnit,
} from "../long-task/contract"
import {
  DEFAULT_LONG_TASK_CAMPAIGN_CARRYOVER,
  type LongTaskCampaignConfidence,
  type LongTaskCampaignExplorationTreeDocument,
  type LongTaskCampaignExplorationNode,
  type LongTaskCampaignOperationalMemoryRecord,
  type LongTaskCampaignReviewSuggestion,
  type LongTaskCampaignRoundRecord,
  type LongTaskCampaignRoutingControl,
  type LongTaskCampaignRunTraceDigest,
  type LongTaskCampaignSeedTarget,
  type LongTaskCampaignSpec,
  type LongTaskCampaignState,
  type LongTaskCampaignRunTrace,
  type LongTaskCampaignRunTraceAttemptRecord,
  type LongTaskCampaignRunTraceCommandRecord,
  type LongTaskCampaignWorkingMemoryDocument,
  type LongTaskCampaignWorkingMemoryKind,
  type LongTaskCampaignWorkerRole,
  type LongTaskCampaignWorkerSuggestion,
} from "./contract"
import {
  appendLinesToAggregate,
  appendLongTaskCampaignHistory,
  createLongTaskCampaignID,
  initializeLongTaskCampaign,
  longTaskCampaignPaths,
  longTaskCampaignRoundPaths,
  readLongTaskCampaignExplorationTree,
  readLongTaskCampaignOperationalMemory,
  readLongTaskCampaignState,
  readLongTaskCampaignRoutingControl,
  readLongTaskCampaignWorkingMemory,
  writeLongTaskCampaignLessons,
  writeLongTaskCampaignExplorationTree,
  writeLongTaskCampaignOperationalMemory,
  writeLongTaskCampaignRoutingControl,
  writeLongTaskCampaignReviewerSuggestion,
  writeLongTaskCampaignSeedContext,
  writeLongTaskCampaignState,
  writeLongTaskCampaignWorkingMemory,
  writeLongTaskCampaignWorkerSuggestion,
} from "./repository"
import { loadLongTaskCampaignSpec } from "./spec"
import { buildCampaignLeadPrompt, buildCampaignReviewerPrompt, buildCampaignWorkerPrompt } from "./prompts"
import { loadConfig } from "../schema"
import { resolveModelSelection } from "../model-selection"
import { runOpencodeTask } from "../opencode"
import type { OpencodeTaskInput } from "../opencode"
import { writeTaskArtifacts } from "../task-artifacts"
import type { ExecutionSpec, ModelPhase } from "../schema"
import { campaignRoundRuntimeScope, cleanupRuntimeProcessScope } from "../runtime-process-registry"

function nowISO() {
  return new Date().toISOString()
}

function short(text: string, limit = 220) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit - 3)}...`
}

function onceActivationCallback(callback?: OpencodeTaskInput["onSpawn"]) {
  if (!callback) return undefined
  let activated = false
  return async () => {
    if (activated) return
    activated = true
    await callback()
  }
}

const STALE_BOOTSTRAP_GRACE_MS = 5 * 60 * 1000

async function isPidAlive(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readProcessCommandLine(pid: number) {
  if (process.platform !== "win32") return undefined
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$proc = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    "if ($null -eq $proc) { exit 2 }",
    "Write-Output ($proc.CommandLine ?? '')",
  ].join("; ")
  const child = Bun.spawn(["powershell", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (exitCode !== 0) return undefined
  return stdout.trim()
}

async function isPidOwnedByHint(pid: number, commandHint?: string) {
  if (!(await isPidAlive(pid))) return false
  if (typeof commandHint !== "string" || commandHint.trim().length === 0) return true
  if (process.platform !== "win32") return true
  const commandLine = await readProcessCommandLine(pid)
  if (!commandLine) return false
  return commandLine.toLowerCase().includes(commandHint.trim().toLowerCase())
}

function isLiveCampaignStatus(status: LongTaskCampaignState["status"]) {
  return status === "bootstrapping" || status === "running"
}

function isLiveRunStatus(status: LongTaskProgressState["status"]) {
  return status === "planning" || status === "bootstrapping" || status === "running" || status === "waiting_for_retry"
}

function parseTimestampMs(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function isBootstrappingWithoutOwnerStale(input: {
  status: string
  ownerPID: unknown
  heartbeatAt?: unknown
  updatedAt?: unknown
  createdAt?: unknown
  nowMs: number
}) {
  if (input.status !== "bootstrapping") return false
  if (typeof input.ownerPID === "number" && Number.isFinite(input.ownerPID) && input.ownerPID > 0) return false
  const referenceMs =
    parseTimestampMs(input.heartbeatAt) ?? parseTimestampMs(input.updatedAt) ?? parseTimestampMs(input.createdAt)
  if (typeof referenceMs !== "number") return true
  return input.nowMs - referenceMs > STALE_BOOTSTRAP_GRACE_MS
}

async function healStaleRuntimeStates(cwd: string) {
  const now = nowISO()
  const nowMs = Date.now()
  const campaignsRoot = autoEvolvePath(cwd, "runtime-state", "long-task-campaigns")
  if (await pathExists(campaignsRoot)) {
    const campaignEntries = await readdir(campaignsRoot, { withFileTypes: true })
    for (const entry of campaignEntries) {
      if (!entry.isDirectory()) continue
      const campaignStatePath = path.join(campaignsRoot, entry.name, "campaign.json")
      if (!(await pathExists(campaignStatePath))) continue
      let state: LongTaskCampaignState
      try {
        state = await readJsonFile<LongTaskCampaignState>(campaignStatePath)
      } catch {
        continue
      }
      if (!isLiveCampaignStatus(state.status)) continue
      if (typeof state.ownerPID !== "number") {
        if (
          !isBootstrappingWithoutOwnerStale({
            status: state.status,
            ownerPID: state.ownerPID,
            heartbeatAt: state.heartbeatAt,
            updatedAt: state.updatedAt,
            createdAt: state.createdAt,
            nowMs,
          })
        ) {
          continue
        }
      } else {
        if (state.ownerPID === process.pid) continue
        if (await isPidOwnedByHint(state.ownerPID, state.ownerCommandHint)) continue
      }

      await writeJsonFile(campaignStatePath, {
        ...state,
        status: "failed",
        ownerPID: process.pid,
        heartbeatAt: now,
        updatedAt: now,
        lastSummary:
          state.lastSummary ??
          (typeof state.ownerPID === "number"
            ? `Campaign owner process ${state.ownerPID} is no longer alive. Marked stale campaign as failed.`
            : "Campaign stalled in bootstrapping without ownerPID. Marked stale campaign as failed."),
      } satisfies LongTaskCampaignState)
    }
  }

  const runsRoot = autoEvolvePath(cwd, "runtime-state", "long-task", "runs")
  if (await pathExists(runsRoot)) {
    const runEntries = await readdir(runsRoot, { withFileTypes: true })
    for (const entry of runEntries) {
      if (!entry.isDirectory()) continue
      const progressPath = path.join(runsRoot, entry.name, "progress_state.json")
      if (!(await pathExists(progressPath))) continue
      let progress: LongTaskProgressState
      try {
        progress = await readJsonFile<LongTaskProgressState>(progressPath)
      } catch {
        continue
      }
      if (!isLiveRunStatus(progress.status)) continue
      if (typeof progress.ownerPID !== "number") {
        if (
          !isBootstrappingWithoutOwnerStale({
            status: progress.status,
            ownerPID: progress.ownerPID,
            heartbeatAt: progress.heartbeatAt,
            updatedAt: progress.updatedAt,
            createdAt: progress.createdAt,
            nowMs,
          })
        ) {
          continue
        }
      } else {
        if (progress.ownerPID === process.pid) continue
        if (await isPidOwnedByHint(progress.ownerPID, progress.ownerCommandHint)) continue
      }

      await writeJsonFile(progressPath, {
        ...progress,
        status: "blocked_failure",
        ownerPID: process.pid,
        heartbeatAt: now,
        updatedAt: now,
        finalSummary:
          progress.finalSummary ??
          (typeof progress.ownerPID === "number"
            ? `Run owner process ${progress.ownerPID} is no longer alive. Marked stale run as blocked_failure.`
            : "Run stalled in bootstrapping without ownerPID. Marked stale run as blocked_failure."),
      } satisfies LongTaskProgressState)
    }
  }
}

async function findExistingLiveCampaign(input: { cwd: string; title: string; baseSpecPath: string }) {
  const campaignsRoot = autoEvolvePath(input.cwd, "runtime-state", "long-task-campaigns")
  if (!(await pathExists(campaignsRoot))) return undefined
  const normalizedTitle = input.title.trim()
  const normalizedBaseSpecPath = path.resolve(input.baseSpecPath)
  const entries = await readdir(campaignsRoot, { withFileTypes: true })
  const candidates: Array<{
    campaignID: string
    campaignPaths: ReturnType<typeof longTaskCampaignPaths>
    state: LongTaskCampaignState
    freshnessMs: number
  }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const campaignID = entry.name
    const campaignPaths = longTaskCampaignPaths(input.cwd, campaignID)
    if (!(await pathExists(campaignPaths.campaignStatePath))) continue
    let state: LongTaskCampaignState
    try {
      state = await readLongTaskCampaignState(campaignPaths)
    } catch {
      continue
    }
    if (!isLiveCampaignStatus(state.status)) continue
    const stateTitle = typeof state.title === "string" ? state.title.trim() : ""
    const stateBaseSpecPath = typeof state.baseSpecPath === "string" ? path.resolve(state.baseSpecPath) : ""
    const sameTarget = stateTitle === normalizedTitle || stateBaseSpecPath === normalizedBaseSpecPath
    if (!sameTarget) continue
    if (typeof state.ownerPID === "number" && Number.isFinite(state.ownerPID) && state.ownerPID > 0) {
      if (state.ownerPID === process.pid) continue
      if (!(await isPidOwnedByHint(state.ownerPID, state.ownerCommandHint))) continue
    }
    candidates.push({
      campaignID,
      campaignPaths,
      state,
      freshnessMs:
        parseTimestampMs(state.heartbeatAt) ??
        parseTimestampMs(state.updatedAt) ??
        parseTimestampMs(state.createdAt) ??
        0,
    })
  }
  if (!candidates.length) return undefined
  candidates.sort((left, right) => right.freshnessMs - left.freshnessMs)
  return candidates[0]
}

async function updateCampaignStatus(
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>,
  status: LongTaskCampaignState["status"],
  patch: Partial<LongTaskCampaignState> = {},
) {
  const current = await readLongTaskCampaignState(campaignPaths)
  if (current.status === status && Object.keys(patch).length === 0) return
  if (
    current.status === "verified_success" ||
    current.status === "round_limit_reached" ||
    current.status === "failed"
  ) {
    return
  }
  await writeLongTaskCampaignState(campaignPaths, {
    ...current,
    ...patch,
    status,
    updatedAt: nowISO(),
  })
}

function uniqueStrings(items: string[]) {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)))
}

function normalizeLineContent(raw: string) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function parseJsonLines<T = Record<string, unknown>>(raw: string) {
  const entries: T[] = []
  for (const line of normalizeLineContent(raw)) {
    try {
      entries.push(JSON.parse(line) as T)
    } catch {
      continue
    }
  }
  return entries
}

async function readJsonLinesIfExists<T = Record<string, unknown>>(target: string) {
  if (!(await pathExists(target))) return [] as T[]
  return parseJsonLines<T>(await readTextFile(target))
}

function roundID(roundNumber: number) {
  return `round-${String(roundNumber).padStart(3, "0")}`
}

function campaignOperationalSignature(item: Pick<LongTaskOperationalContextItem, "kind" | "statement">) {
  return `${item.kind}::${item.statement.trim().toLowerCase()}`
}

function mergeCampaignOperationalMemory(
  existing: LongTaskCampaignOperationalMemoryRecord,
  incoming: LongTaskOperationalContextItem,
  roundNumber: number,
  runID: string,
): LongTaskCampaignOperationalMemoryRecord {
  return {
    ...existing,
    updatedAt: nowISO(),
    lastRound: roundNumber,
    occurrenceCount: existing.sourceRunIDs.includes(runID) ? existing.occurrenceCount : existing.occurrenceCount + 1,
    sourceRunIDs: uniqueStrings([...existing.sourceRunIDs, runID]),
    status: existing.status === "confirmed" || incoming.status === "confirmed" ? "confirmed" : "candidate",
    rationale: incoming.rationale ?? existing.rationale,
    refs: uniqueStrings([...existing.refs, ...incoming.refs]),
    tags: uniqueStrings([...existing.tags, ...incoming.tags]),
  }
}

function sortCampaignOperationalMemory(records: LongTaskCampaignOperationalMemoryRecord[]) {
  return [...records].sort((left, right) => {
    if (left.status !== right.status) return left.status === "confirmed" ? -1 : 1
    if (left.occurrenceCount !== right.occurrenceCount) return right.occurrenceCount - left.occurrenceCount
    if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1
    return left.statement.localeCompare(right.statement)
  })
}

function promoteCampaignOperationalMemory(input: {
  existing: LongTaskCampaignOperationalMemoryRecord[]
  incoming: LongTaskOperationalContextItem[]
  roundNumber: number
  runID: string
}): LongTaskCampaignOperationalMemoryRecord[] {
  const merged = new Map<string, LongTaskCampaignOperationalMemoryRecord>()
  for (const item of input.existing) merged.set(campaignOperationalSignature(item), item)
  for (const item of input.incoming) {
    const signature = campaignOperationalSignature(item)
    const current = merged.get(signature)
    if (current) {
      merged.set(signature, mergeCampaignOperationalMemory(current, item, input.roundNumber, input.runID))
      continue
    }
    merged.set(signature, {
      ...item,
      updatedAt: nowISO(),
      roundNumber: input.roundNumber,
      lastRound: input.roundNumber,
      occurrenceCount: 1,
      sourceRunIDs: [input.runID],
    })
  }
  return sortCampaignOperationalMemory(Array.from(merged.values()))
}

function buildCampaignSeedContextMarkdown(input: {
  title: string
  latestRound: number
  operationalMemory: LongTaskCampaignOperationalMemoryRecord[]
  records: LongTaskCampaignRoundRecord[]
}) {
  const latestRecord = input.records[input.records.length - 1]
  const sections: Array<[string, LongTaskCampaignOperationalMemoryRecord["kind"]]> = [
    ["Confirmed Facts", "confirmed_fact"],
    ["Validated Methods", "validated_method"],
    ["Known Blockers", "blocking_issue"],
    ["Failed Paths", "failed_path"],
    ["Tool Entrypoints", "tool_entrypoint"],
    ["Package Gaps", "package_gap"],
  ]
  const lines = [
    "# Campaign Seed Context",
    "",
    "- Purpose: provide promoted cross-run memory to the next generated round.",
    `- title: ${input.title}`,
    `- updated_through: ${roundID(input.latestRound)}`,
    `- latest_status: ${latestRecord?.finalStatus ?? "unknown"}`,
    `- latest_summary: ${latestRecord?.summary ?? "none"}`,
    "",
  ]

  if (!input.operationalMemory.length) {
    lines.push("- no promoted cross-run memory yet", "")
    return lines.join("\n")
  }

  for (const [title, kind] of sections) {
    const matches = input.operationalMemory.filter((item) => item.kind === kind).slice(0, 8)
    if (!matches.length) continue
    lines.push(`## ${title}`, "")
    for (const item of matches) {
      lines.push(`- ${item.statement}`)
      lines.push(`  stability: occurrences=${item.occurrenceCount}, status=${item.status}`)
      if (item.rationale) lines.push(`  rationale: ${short(item.rationale, 180)}`)
    }
    lines.push("")
  }

  return lines.join("\n").trimEnd() + "\n"
}

function compactRefs(refs: string[]) {
  const unique = uniqueStrings(refs)
  if (unique.length <= 2) return unique
  return [unique[0], unique[unique.length - 1]]
}

function normalizeCompactStatement(raw: string) {
  return raw
    .replace(/\s+/g, " ")
    .replace(/[.;:]+$/g, "")
    .trim()
}

function mapOperationalKindToWorkingKind(
  kind: LongTaskCampaignOperationalMemoryRecord["kind"],
): LongTaskCampaignWorkingMemoryKind | undefined {
  switch (kind) {
    case "confirmed_fact":
      return "stable_fact"
    case "validated_method":
    case "tool_entrypoint":
      return "validated_method"
    case "blocking_issue":
      return "real_blocker"
    case "failed_path":
      return "forbidden_path"
    case "package_gap":
      return "package_gap"
    default:
      return undefined
  }
}

function confidenceRank(value: LongTaskCampaignConfidence) {
  switch (value) {
    case "high":
      return 3
    case "medium":
      return 2
    default:
      return 1
  }
}

function deriveWorkingConfidence(record: LongTaskCampaignOperationalMemoryRecord): LongTaskCampaignConfidence {
  if (record.status === "confirmed" && record.occurrenceCount >= 2) return "high"
  if (record.status === "confirmed" || record.occurrenceCount >= 2) return "medium"
  return "low"
}

function isMetaProcessOnlyStatement(statement: string) {
  const lower = statement.toLowerCase()
  const patterns = [
    "do not claim success",
    "say so explicitly",
    "read carefully",
    "before returning",
    "must explicitly acknowledge",
    "ground every",
    "do not leak hidden validator",
  ]
  return patterns.some((pattern) => lower.includes(pattern))
}

function shouldPromoteOperationalRecord(
  record: LongTaskCampaignOperationalMemoryRecord,
  kind: LongTaskCampaignWorkingMemoryKind,
  statement: string,
) {
  if (!statement) return false
  if (isMetaProcessOnlyStatement(statement)) return false
  if (kind === "forbidden_path") return record.status === "confirmed" || record.occurrenceCount >= 2
  if (kind === "stable_fact") return record.status === "confirmed" || record.occurrenceCount >= 2
  if (kind === "validated_method") return record.status === "confirmed" || record.occurrenceCount >= 2
  if (kind === "real_blocker") return record.status === "confirmed" || record.occurrenceCount >= 2
  if (kind === "package_gap") return record.status === "confirmed" || record.occurrenceCount >= 2
  return false
}

function buildWorkingMemoryDocument(input: {
  operationalMemory: LongTaskCampaignOperationalMemoryRecord[]
  updatedThroughRound: number
}): LongTaskCampaignWorkingMemoryDocument {
  const merged = new Map<string, LongTaskCampaignWorkingMemoryDocument["items"][number]>()
  for (const record of input.operationalMemory) {
    const mappedKind = mapOperationalKindToWorkingKind(record.kind)
    if (!mappedKind) continue
    const statement = normalizeCompactStatement(record.statement)
    if (!shouldPromoteOperationalRecord(record, mappedKind, statement)) continue
    const key = `${mappedKind}::${statement.toLowerCase()}`
    const current = merged.get(key)
    const nextRefs = compactRefs(record.refs)
    if (current) {
      merged.set(key, {
        ...current,
        confidence:
          confidenceRank(current.confidence) >= confidenceRank(deriveWorkingConfidence(record))
            ? current.confidence
            : deriveWorkingConfidence(record),
        evidenceCount: Math.max(current.evidenceCount, record.occurrenceCount),
        lastSeenRound: Math.max(current.lastSeenRound, record.lastRound),
        refs: compactRefs([...current.refs, ...nextRefs]),
      })
      continue
    }
    merged.set(key, {
      key,
      kind: mappedKind,
      statement,
      confidence: deriveWorkingConfidence(record),
      evidenceCount: record.occurrenceCount,
      firstSeenRound: record.roundNumber,
      lastSeenRound: record.lastRound,
      refs: nextRefs,
    })
  }

  const items = Array.from(merged.values()).sort((left, right) => {
    if (confidenceRank(left.confidence) !== confidenceRank(right.confidence)) {
      return confidenceRank(right.confidence) - confidenceRank(left.confidence)
    }
    if (left.evidenceCount !== right.evidenceCount) return right.evidenceCount - left.evidenceCount
    if (left.lastSeenRound !== right.lastSeenRound) return right.lastSeenRound - left.lastSeenRound
    return left.statement.localeCompare(right.statement)
  })

  return {
    updatedAt: nowISO(),
    updatedThroughRound: input.updatedThroughRound,
    items,
  }
}

function emptyExplorationTreeDocument(roundNumber = 0): LongTaskCampaignExplorationTreeDocument {
  return {
    updatedAt: nowISO(),
    updatedThroughRound: roundNumber,
    currentPhase: "bootstrap",
    frontierRegions: [],
    requiredNextRegions: [],
    forbiddenRepeatRegions: [],
    nodes: [],
  }
}

function coerceExplorationTreeDocument(
  raw: unknown,
  fallback: LongTaskCampaignExplorationTreeDocument,
): LongTaskCampaignExplorationTreeDocument {
  if (Array.isArray(raw)) {
    return {
      ...fallback,
      nodes: raw
        .filter(
          (item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item),
        )
        .map((item, index) => ({
          nodeID:
            typeof item.nodeID === "string" && item.nodeID.trim().length > 0
              ? item.nodeID
              : `node-${String(index + 1).padStart(3, "0")}`,
          region:
            typeof item.region === "string" && item.region.trim().length > 0
              ? item.region
              : typeof item.hypothesis === "string" && item.hypothesis.trim().length > 0
                ? item.hypothesis
                : `region-${index + 1}`,
          parentID: typeof item.parentID === "string" && item.parentID.trim().length > 0 ? item.parentID : undefined,
          summary:
            typeof item.summary === "string" && item.summary.trim().length > 0
              ? item.summary
              : typeof item.hypothesis === "string" && item.hypothesis.trim().length > 0
                ? item.hypothesis
                : "No summary recorded.",
          status:
            item.status === "unexplored" ||
            item.status === "in_progress" ||
            item.status === "weak_fail" ||
            item.status === "strong_fail" ||
            item.status === "promising" ||
            item.status === "validated_success" ||
            item.status === "deprecated"
              ? item.status
              : "unexplored",
          confidence: typeof item.confidence === "number" ? item.confidence : 0.5,
          evidenceRefs: Array.isArray(item.evidenceRefs)
            ? item.evidenceRefs.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            : [],
          lastUpdatedRound:
            typeof item.lastUpdatedRound === "number" ? item.lastUpdatedRound : fallback.updatedThroughRound,
          prerequisites: Array.isArray(item.prerequisites)
            ? item.prerequisites.filter(
                (value): value is string => typeof value === "string" && value.trim().length > 0,
              )
            : [],
          attemptCount: typeof item.attemptCount === "number" ? item.attemptCount : 0,
          successCount: typeof item.successCount === "number" ? item.successCount : 0,
          failCount: typeof item.failCount === "number" ? item.failCount : 0,
          notes: Array.isArray(item.notes)
            ? item.notes.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            : [],
        })),
    }
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fallback
  const value = raw as Record<string, unknown>
  return {
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
    updatedThroughRound:
      typeof value.updatedThroughRound === "number" ? value.updatedThroughRound : fallback.updatedThroughRound,
    currentPhase: typeof value.currentPhase === "string" ? value.currentPhase : fallback.currentPhase,
    frontierRegions: Array.isArray(value.frontierRegions)
      ? value.frontierRegions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.frontierRegions,
    requiredNextRegions: Array.isArray(value.requiredNextRegions)
      ? value.requiredNextRegions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.requiredNextRegions,
    forbiddenRepeatRegions: Array.isArray(value.forbiddenRepeatRegions)
      ? value.forbiddenRepeatRegions.filter(
          (item): item is string => typeof item === "string" && item.trim().length > 0,
        )
      : fallback.forbiddenRepeatRegions,
    nodes: coerceExplorationTreeDocument(Array.isArray(value.nodes) ? value.nodes : [], fallback).nodes,
  }
}

function buildRunTraceDigest(trace: LongTaskCampaignRunTrace): LongTaskCampaignRunTraceDigest {
  return {
    campaignID: trace.campaignID,
    roundNumber: trace.roundNumber,
    runID: trace.runID,
    createdAt: trace.createdAt,
    finalStatus: trace.finalStatus,
    summary: trace.summary,
    exploredRegions: uniqueStrings(trace.exploredRegions),
    keySuccessPaths: uniqueStrings(trace.keySuccessPaths),
    keyFailurePaths: uniqueStrings(trace.keyFailurePaths),
    blockers: uniqueStrings(trace.blockers),
    pendingPackageImpact: uniqueStrings(trace.pendingPackageImpact),
    validatedMethods: uniqueStrings(
      trace.attempts.flatMap((attempt) =>
        attempt.operationalContext
          .filter((item) => item.kind === "validated_method" || item.kind === "tool_entrypoint")
          .map((item) => item.statement),
      ),
    ),
    forbiddenPaths: uniqueStrings(
      trace.attempts.flatMap((attempt) =>
        attempt.operationalContext.filter((item) => item.kind === "failed_path").map((item) => item.statement),
      ),
    ),
    packageGaps: uniqueStrings(
      trace.attempts.flatMap((attempt) =>
        attempt.operationalContext.filter((item) => item.kind === "package_gap").map((item) => item.statement),
      ),
    ),
    commandOutcomes: trace.attempts.map((attempt) => ({
      unitID: attempt.unitID,
      attempt: attempt.attempt,
      successCommands: uniqueStrings(
        attempt.commandRecords
          .filter((item) => item.status === "success")
          .map((item) => item.command ?? item.title ?? item.tool),
      ),
      failedCommands: uniqueStrings(
        attempt.commandRecords
          .filter((item) => item.status === "failure")
          .map((item) => item.command ?? item.title ?? item.tool),
      ),
    })),
    refs: compactRefs(
      trace.attempts.flatMap((attempt) =>
        compactRefs([
          ...(attempt.responsePath ? [attempt.responsePath] : []),
          ...(attempt.failurePacketRefs ?? []),
          ...(attempt.claimRefs ?? []),
        ]),
      ),
    ),
  }
}

function evolveExplorationTreeDocument(input: {
  previous: LongTaskCampaignExplorationTreeDocument
  digest: LongTaskCampaignRunTraceDigest
  roundNumber: number
}): LongTaskCampaignExplorationTreeDocument {
  const nodes = new Map<string, LongTaskCampaignExplorationNode>()
  for (const node of input.previous.nodes) nodes.set(node.region, node)

  const failedRegions = new Set(
    input.digest.commandOutcomes.filter((item) => item.failedCommands.length > 0).map((item) => item.unitID),
  )
  const succeededRegions = new Set(
    input.digest.commandOutcomes.filter((item) => item.successCommands.length > 0).map((item) => item.unitID),
  )

  for (const region of uniqueStrings([
    ...input.digest.exploredRegions,
    ...input.digest.commandOutcomes.map((item) => item.unitID),
  ])) {
    const current = nodes.get(region)
    const fail = failedRegions.has(region)
    const success = succeededRegions.has(region)
    nodes.set(region, {
      nodeID: current?.nodeID ?? `region-${region.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      region,
      parentID: current?.parentID,
      summary:
        current?.summary ??
        (success && !fail
          ? `Region ${region} produced successful command outcomes.`
          : fail
            ? `Region ${region} produced failing command outcomes.`
            : `Region ${region} was explored.`),
      status: success && !fail ? "validated_success" : fail ? "strong_fail" : (current?.status ?? "promising"),
      confidence: Math.max(current?.confidence ?? 0.5, success && !fail ? 0.8 : fail ? 0.7 : 0.6),
      evidenceRefs: compactRefs([...(current?.evidenceRefs ?? []), ...input.digest.refs]),
      lastUpdatedRound: input.roundNumber,
      prerequisites: current?.prerequisites ?? [],
      attemptCount: (current?.attemptCount ?? 0) + 1,
      successCount: (current?.successCount ?? 0) + (success ? 1 : 0),
      failCount: (current?.failCount ?? 0) + (fail ? 1 : 0),
      notes: current?.notes ?? [],
    })
  }

  const nodeList = Array.from(nodes.values()).sort((left, right) => left.region.localeCompare(right.region))
  return {
    updatedAt: nowISO(),
    updatedThroughRound: input.roundNumber,
    currentPhase: input.previous.currentPhase === "bootstrap" ? "iterating" : input.previous.currentPhase,
    frontierRegions: nodeList
      .filter((node) => node.status === "promising" || node.status === "unexplored")
      .map((node) => node.region),
    requiredNextRegions: input.previous.requiredNextRegions,
    forbiddenRepeatRegions: nodeList
      .filter((node) => (node.successCount ?? 0) >= 2 || node.status === "deprecated")
      .map((node) => node.region),
    nodes: nodeList,
  }
}

function coerceRoutingControl(raw: unknown, fallback: LongTaskCampaignRoutingControl): LongTaskCampaignRoutingControl {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fallback
  const value = raw as Record<string, unknown>
  return {
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
    updatedThroughRound:
      typeof value.updatedThroughRound === "number" ? value.updatedThroughRound : fallback.updatedThroughRound,
    currentPhase: typeof value.currentPhase === "string" ? value.currentPhase : fallback.currentPhase,
    requiredNextRegions: Array.isArray(value.requiredNextRegions)
      ? value.requiredNextRegions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.requiredNextRegions,
    forbiddenUnits: Array.isArray(value.forbiddenUnits)
      ? value.forbiddenUnits.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.forbiddenUnits,
    forbiddenRegions: Array.isArray(value.forbiddenRegions)
      ? value.forbiddenRegions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.forbiddenRegions,
    prerequisites: Array.isArray(value.prerequisites)
      ? value.prerequisites.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.prerequisites,
    blockedBy: Array.isArray(value.blockedBy)
      ? value.blockedBy.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.blockedBy,
    readyForFinalAcceptance:
      typeof value.readyForFinalAcceptance === "boolean"
        ? value.readyForFinalAcceptance
        : fallback.readyForFinalAcceptance,
    summary: typeof value.summary === "string" ? value.summary : fallback.summary,
    evidenceRefs: Array.isArray(value.evidenceRefs)
      ? compactRefs(
          value.evidenceRefs.filter((item): item is string => typeof item === "string" && item.trim().length > 0),
        )
      : fallback.evidenceRefs,
    notes: Array.isArray(value.notes)
      ? value.notes.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.notes,
  }
}

function buildRoutingControl(input: {
  previous: LongTaskCampaignRoutingControl
  tree: LongTaskCampaignExplorationTreeDocument
  digest: LongTaskCampaignRunTraceDigest
  reviewerSuggestion?: LongTaskCampaignReviewSuggestion
  roundNumber: number
}): LongTaskCampaignRoutingControl {
  const repeatedSuccessfulUnits = input.tree.nodes
    .filter((node) => (node.successCount ?? 0) >= 2 && node.region.trim().length > 0)
    .map((node) => node.region)

  return {
    updatedAt: nowISO(),
    updatedThroughRound: input.roundNumber,
    currentPhase:
      input.reviewerSuggestion?.readyForFinalAcceptance === true
        ? "final_acceptance"
        : input.previous.currentPhase === "bootstrap"
          ? "iterating"
          : input.previous.currentPhase,
    requiredNextRegions: uniqueStrings([
      ...input.tree.requiredNextRegions,
      ...(input.reviewerSuggestion?.nextAttentionAreas ?? []),
    ]),
    forbiddenUnits: uniqueStrings([...input.previous.forbiddenUnits, ...repeatedSuccessfulUnits]),
    forbiddenRegions: uniqueStrings([...input.previous.forbiddenRegions, ...input.tree.forbiddenRepeatRegions]),
    prerequisites: uniqueStrings(input.previous.prerequisites),
    blockedBy: uniqueStrings(input.digest.blockers.slice(0, 8)),
    readyForFinalAcceptance: input.reviewerSuggestion?.readyForFinalAcceptance === true,
    summary: input.reviewerSuggestion?.summary ?? input.digest.summary,
    evidenceRefs: compactRefs(input.digest.refs),
    notes: uniqueStrings([...(input.previous.notes ?? []), ...input.digest.pendingPackageImpact.slice(0, 4)]),
  }
}

function extractJsonObject(raw: string) {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const attempts = [trimmed]
  const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)```/i)
  if (fencedMatch?.[1]) attempts.push(fencedMatch[1].trim())
  const firstObjectMatch = trimmed.match(/\{[\s\S]*\}/)
  if (firstObjectMatch?.[0]) attempts.push(firstObjectMatch[0].trim())

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as Record<string, unknown>
    } catch {
      continue
    }
  }
  return undefined
}

function normalizeStringArray(input: unknown) {
  if (!Array.isArray(input)) return []
  return input
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
}

function primaryExperienceWorkspaceSeedTarget(seedTargets: LongTaskCampaignSeedTarget[]) {
  return seedTargets.find((item) => (item.kind ?? "experience_workspace") === "experience_workspace")
}

function experienceSnapshotFromRoot(root: string) {
  return experienceWorkspacePathsFromRoot(root, "manifest.md")
}

async function resetPath(target: string) {
  await rm(target, { recursive: true, force: true })
}

async function copyExperienceWorkspaceRoot(sourceRoot: string, targetRoot: string) {
  const snapshot = await readExperienceWorkspace(experienceSnapshotFromRoot(sourceRoot))
  await resetPath(targetRoot)
  await writeExperienceWorkspaceSnapshot(targetRoot, snapshot)
}

async function copyPathIntoTarget(sourcePath: string, targetPath: string) {
  await resetPath(targetPath)
  if (!(await pathExists(sourcePath))) {
    await ensureDirectory(targetPath)
    return
  }
  const stats = await lstat(sourcePath)
  if (stats.isDirectory()) {
    await cp(sourcePath, targetPath, { recursive: true, force: true })
    return
  }
  await ensureParentDirForPath(targetPath)
  await cp(sourcePath, targetPath, { force: true })
}

async function seedCampaignCurrentPendingPackage(input: {
  currentRoot: string
  seedTarget: LongTaskCampaignSeedTarget | undefined
}) {
  if (!input.seedTarget) return
  if (await pathExists(path.join(input.currentRoot, "manifest.md"))) return
  if ((input.seedTarget.kind ?? "experience_workspace") === "experience_workspace") {
    await copyExperienceWorkspaceRoot(input.seedTarget.seedPath, input.currentRoot)
    return
  }
  await copyPathIntoTarget(input.seedTarget.seedPath, input.currentRoot)
}

function normalizeContextPathForFilter(inputPath: string) {
  return inputPath.replace(/\\/g, "/").toLowerCase()
}

function isStaticBaseContextPath(inputPath: string) {
  const normalized = normalizeContextPathForFilter(inputPath)
  return (
    !normalized.includes("/seed-expert-workspace/") &&
    !normalized.includes("/seed-campaign-evidence/") &&
    !normalized.includes("/runtime-state/long-task-campaigns/") &&
    !normalized.endsWith("aggregated-failure-packets.jsonl") &&
    !normalized.endsWith("aggregated-retry-lessons.jsonl") &&
    !normalized.endsWith("aggregated-learning-units.jsonl") &&
    !normalized.endsWith("carryover-failure-packets.md") &&
    !normalized.endsWith("carryover-retry-lessons.md") &&
    !normalized.endsWith("carryover-learning-units.md") &&
    !normalized.endsWith("campaign-failure-lessons.md") &&
    !normalized.endsWith("campaign-seed-context.md") &&
    !normalized.endsWith("campaign-operational-memory.json")
  )
}

function collectStaticBaseContextPaths(baseSpec: LongTaskSpec) {
  return uniqueStrings((baseSpec.initialExpertContextPaths ?? []).filter(isStaticBaseContextPath))
}

function defaultCampaignWorkerRoles(): LongTaskCampaignWorkerRole[] {
  return ["success_synthesizer", "failure_synthesizer", "forbidden_path_synthesizer", "exploration_tree_synthesizer"]
}

async function readEventsIfExists(target: string) {
  if (!(await pathExists(target))) return [] as Array<Record<string, unknown>>
  return readJsonFile<Array<Record<string, unknown>>>(target)
}

function extractCommandRecordsFromEvents(input: {
  events: Array<Record<string, unknown>>
  eventsPath: string
  sessionExecutionReportPath?: string
}): LongTaskCampaignRunTraceCommandRecord[] {
  const records: LongTaskCampaignRunTraceCommandRecord[] = []
  for (const event of input.events) {
    if (event.type !== "tool_use" || typeof event.part !== "object" || !event.part || Array.isArray(event.part))
      continue
    const part = event.part as Record<string, unknown>
    const tool = typeof part.tool === "string" ? part.tool : "unknown"
    const state =
      typeof part.state === "object" && part.state && !Array.isArray(part.state)
        ? (part.state as Record<string, unknown>)
        : undefined
    const metadata =
      typeof state?.metadata === "object" && state.metadata && !Array.isArray(state.metadata)
        ? (state.metadata as Record<string, unknown>)
        : undefined
    const inputState =
      typeof state?.input === "object" && state.input && !Array.isArray(state.input)
        ? (state.input as Record<string, unknown>)
        : undefined
    const exit = typeof metadata?.exit === "number" ? metadata.exit : undefined
    const status = state?.status === "error" || (typeof exit === "number" && exit !== 0) ? "failure" : "success"
    const command =
      typeof inputState?.command === "string"
        ? inputState.command
        : typeof inputState?.script === "string"
          ? inputState.script
          : undefined
    records.push({
      id: randomUUID().slice(0, 8),
      tool,
      status,
      title: typeof state?.title === "string" ? state.title : undefined,
      command,
      error: typeof state?.error === "string" ? state.error : undefined,
      outputPreview: typeof state?.output === "string" ? short(state.output, 200) : undefined,
      timestamp: typeof event.timestamp === "number" ? event.timestamp : undefined,
      refs: uniqueStrings(
        [input.eventsPath, input.sessionExecutionReportPath].filter((item): item is string => Boolean(item)),
      ),
    })
  }
  return records
}

async function buildCampaignRunTrace(input: {
  campaignID: string
  roundNumber: number
  run: ReturnType<typeof longTaskRunPaths>
  spec: LongTaskSpec
  finalStatus: LongTaskRunStatus
  summary: string
}): Promise<LongTaskCampaignRunTrace> {
  const [graph, claims, failures, scratchUnits, learningUnits, retryLessons, operationalContext] = await Promise.all([
    readJsonFile<LongTaskWorkGraph>(input.run.workGraphPath),
    readJsonLinesIfExists<Record<string, unknown>>(input.run.claimsPath),
    readJsonLinesIfExists<Record<string, unknown>>(input.run.failurePacketsPath),
    readJsonLinesIfExists<Record<string, unknown>>(input.run.scratchUnitsPath),
    readJsonLinesIfExists<Record<string, unknown>>(input.run.learningUnitsPath),
    readJsonLinesIfExists<Record<string, unknown>>(input.run.retryLessonsPath),
    readOperationalContext(input.run),
  ])

  const attempts: LongTaskCampaignRunTraceAttemptRecord[] = []
  for (const unit of graph.units) {
    const unitRoot = path.join(input.run.unitsRoot, unit.id)
    if (!(await pathExists(unitRoot))) continue
    const attemptEntries = await readdir(unitRoot, { withFileTypes: true })
    for (const entry of attemptEntries) {
      if (!entry.isDirectory()) continue
      const attemptMatch = entry.name.match(/^attempt-(\d+)$/)
      if (!attemptMatch) continue
      const attemptNumber = Number(attemptMatch[1])
      const attemptRoot = path.join(unitRoot, entry.name)
      const executeDir = path.join(attemptRoot, "execute")
      const retryInputBundlePath = path.join(attemptRoot, "retry_input_bundle.json")
      const eventsPath = path.join(executeDir, "events.json")
      const sessionExecutionReportPath = path.join(executeDir, "session_execution_report.md")
      const responsePath = path.join(executeDir, "response.txt")
      const toolFailuresPath = path.join(executeDir, "tool_failures.json")
      const runJsonPath = path.join(executeDir, "run.json")
      const events = await readEventsIfExists(eventsPath)
      const runJson = (await pathExists(runJsonPath))
        ? await readJsonFile<Record<string, unknown>>(runJsonPath)
        : undefined
      const claim = claims.find((item) => item.unitID === unit.id && item.attempt === attemptNumber)
      const failure = failures.find((item) => item.unitID === unit.id && item.attempt === attemptNumber)
      const scratchStatements = scratchUnits
        .filter((item) => item.unitID === unit.id && item.attempt === attemptNumber)
        .map((item) => extractStringField(item, "statement"))
        .filter((item): item is string => Boolean(item))
      const learningStatements = learningUnits
        .filter((item) => item.unitID === unit.id && item.attempt === attemptNumber)
        .map((item) => extractStringField(item, "statement"))
        .filter((item): item is string => Boolean(item))
      const retrySignals = retryLessons
        .filter((item) => item.unitID === unit.id && item.attempt === attemptNumber)
        .flatMap((item) =>
          [
            extractStringField(item, "whatFailed"),
            ...(Array.isArray(item.nextAttemptStrategy)
              ? item.nextAttemptStrategy.filter((value): value is string => typeof value === "string")
              : []),
          ].filter((value): value is string => Boolean(value)),
        )
      attempts.push({
        unitID: unit.id,
        unitTitle: unit.title,
        attempt: attemptNumber,
        executeDir,
        retryInputBundlePath: (await pathExists(retryInputBundlePath)) ? retryInputBundlePath : undefined,
        responsePath: (await pathExists(responsePath)) ? responsePath : undefined,
        sessionExecutionReportPath: (await pathExists(sessionExecutionReportPath))
          ? sessionExecutionReportPath
          : undefined,
        eventsPath: (await pathExists(eventsPath)) ? eventsPath : undefined,
        toolFailuresPath: (await pathExists(toolFailuresPath)) ? toolFailuresPath : undefined,
        claimID: typeof claim?.id === "string" ? claim.id : undefined,
        claimRefs: Array.isArray(claim?.evidenceRefs)
          ? claim.evidenceRefs.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : [],
        failurePacketID: typeof failure?.id === "string" ? failure.id : undefined,
        failurePacketRefs: Array.isArray(failure?.evidenceRefs)
          ? failure.evidenceRefs.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : [],
        exitCode: typeof runJson?.exitCode === "number" ? runJson.exitCode : undefined,
        claimStatement: typeof claim?.statement === "string" ? claim.statement : undefined,
        claimedSuccess: typeof claim?.claimedSuccess === "boolean" ? claim.claimedSuccess : undefined,
        failureSummary: typeof failure?.mismatchSummary === "string" ? failure.mismatchSummary : undefined,
        scratchUnits: scratchUnits
          .filter((item) => item.unitID === unit.id && item.attempt === attemptNumber)
          .map((item) => ({
            id: typeof item.id === "string" ? item.id : `scratch-${unit.id}-${attemptNumber}`,
            kind: typeof item.kind === "string" ? item.kind : "obs",
            statement: typeof item.statement === "string" ? item.statement : "Unstructured scratch note.",
            refs: Array.isArray(item.refs)
              ? item.refs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
              : [],
          })),
        learningUnits: learningUnits
          .filter((item) => item.unitID === unit.id)
          .map((item) => ({
            id: typeof item.id === "string" ? item.id : `learning-${unit.id}`,
            kind: typeof item.kind === "string" ? item.kind : "obs",
            scope: typeof item.scope === "string" ? item.scope : "local",
            strength: item.strength === 2 || item.strength === 3 ? item.strength : 1,
            statement: typeof item.statement === "string" ? item.statement : "Unstructured learning unit.",
            refs: Array.isArray(item.refs)
              ? item.refs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
              : [],
          })),
        retryLessons: retryLessons
          .filter((item) => item.unitID === unit.id && item.attempt === attemptNumber)
          .map((item) => ({
            id: typeof item.id === "string" ? item.id : `retry-${unit.id}-${attemptNumber}`,
            failureType: typeof item.failureType === "string" ? item.failureType : "validator_failed",
            failureSignature: typeof item.failureSignature === "string" ? item.failureSignature : "unknown",
            whatFailed: typeof item.whatFailed === "string" ? item.whatFailed : "Unknown retry lesson.",
            whyFailed: Array.isArray(item.whyFailed)
              ? item.whyFailed.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
              : [],
            doNotRepeat: Array.isArray(item.doNotRepeat)
              ? item.doNotRepeat.filter(
                  (value): value is string => typeof value === "string" && value.trim().length > 0,
                )
              : [],
            nextAttemptStrategy: Array.isArray(item.nextAttemptStrategy)
              ? item.nextAttemptStrategy.filter(
                  (value): value is string => typeof value === "string" && value.trim().length > 0,
                )
              : [],
            evidenceRefs: Array.isArray(item.evidenceRefs)
              ? item.evidenceRefs.filter(
                  (value): value is string => typeof value === "string" && value.trim().length > 0,
                )
              : [],
          })),
        operationalContext: operationalContext
          .filter((item) => item.sourceUnitID === unit.id && item.sourceAttempt === attemptNumber)
          .map((item) => ({
            id: item.id,
            kind: item.kind,
            status: item.status,
            statement: item.statement,
            rationale: item.rationale,
            refs: item.refs,
            tags: item.tags,
          })),
        attemptFindings: uniqueStrings([
          ...(typeof claim?.statement === "string" ? [claim.statement] : []),
          ...(typeof failure?.mismatchSummary === "string" ? [failure.mismatchSummary] : []),
          ...scratchStatements,
          ...learningStatements,
          ...retrySignals,
        ]).slice(0, 20),
        commandRecords: extractCommandRecordsFromEvents({
          events,
          eventsPath,
          sessionExecutionReportPath: (await pathExists(sessionExecutionReportPath))
            ? sessionExecutionReportPath
            : undefined,
        }),
      })
    }
  }

  return {
    campaignID: input.campaignID,
    roundNumber: input.roundNumber,
    runID: path.basename(input.run.root),
    createdAt: nowISO(),
    finalStatus: input.finalStatus,
    summary: input.summary,
    materials: input.spec.materials.map((item) => item.path),
    capabilityPaths: uniqueStrings((input.spec.capabilities ?? []).flatMap((item) => item.referencePaths ?? [])),
    exploredRegions: graph.units.map((unit) => `${unit.id}: ${short(unit.goal, 140)}`),
    keySuccessPaths: claims
      .filter((item) => item.claimedSuccess === true)
      .map((item) => short(String(item.statement ?? ""), 220))
      .slice(-12),
    keyFailurePaths: failures.map((item) => short(String(item.mismatchSummary ?? ""), 220)).slice(-12),
    blockers: uniqueStrings(
      operationalContext
        .filter((item) => item.kind === "blocking_issue" || item.kind === "failed_path")
        .map((item) => item.statement),
    ).slice(0, 24),
    pendingPackageImpact: uniqueStrings(
      learningUnits
        .map((item) => (typeof item.statement === "string" ? item.statement : ""))
        .filter((item) => item.trim().length > 0),
    ).slice(0, 24),
    attempts: attempts.sort((left, right) =>
      left.unitID === right.unitID ? left.attempt - right.attempt : left.unitID.localeCompare(right.unitID),
    ),
  }
}

function buildCampaignRunTraceMarkdown(trace: LongTaskCampaignRunTrace) {
  const lines = [
    `# Run Trace ${trace.runID}`,
    "",
    `- round: ${trace.roundNumber}`,
    `- status: ${trace.finalStatus}`,
    `- summary: ${trace.summary}`,
    `- attempts: ${trace.attempts.length}`,
    "",
    "## Key Success Paths",
    "",
    ...(trace.keySuccessPaths.length ? trace.keySuccessPaths.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Key Failure Paths",
    "",
    ...(trace.keyFailurePaths.length ? trace.keyFailurePaths.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Blockers",
    "",
    ...(trace.blockers.length ? trace.blockers.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Attempt Timeline",
    "",
  ]

  if (!trace.attempts.length) {
    lines.push("- no attempts recorded", "")
    return lines.join("\n")
  }

  for (const attempt of trace.attempts) {
    lines.push(`### ${attempt.unitID} / attempt ${attempt.attempt}`, "")
    lines.push(`- title: ${attempt.unitTitle}`)
    if (typeof attempt.exitCode === "number") lines.push(`- exit_code: ${attempt.exitCode}`)
    if (attempt.claimStatement) lines.push(`- claim: ${attempt.claimStatement}`)
    if (attempt.failureSummary) lines.push(`- failure: ${attempt.failureSummary}`)
    lines.push(`- execute_dir: ${attempt.executeDir}`)
    lines.push("- command_outcomes:")
    if (!attempt.commandRecords.length) {
      lines.push("  - none")
    } else {
      for (const record of attempt.commandRecords) {
        const head = record.command ?? record.title ?? record.tool
        lines.push(`  - [${record.status}] ${record.tool}: ${short(head, 180)}`)
        if (record.error) lines.push(`    error: ${short(record.error, 180)}`)
      }
    }
    lines.push("")
  }

  return lines.join("\n")
}

function applyBudgetOverrides(base: LongTaskBudgets, overrides?: Partial<LongTaskBudgets>): LongTaskBudgets {
  return {
    ...base,
    ...overrides,
  }
}

async function ensureParentDirForPath(target: string) {
  await ensureDirectory(path.dirname(target))
}

async function resetGenericPath(target: string) {
  if (await pathExists(target)) {
    await rm(target, { recursive: true, force: true })
  }
  if (!path.extname(path.basename(target))) {
    await ensureDirectory(target)
  } else {
    await ensureParentDirForPath(target)
  }
}

async function snapshotSeedTarget(seed: LongTaskCampaignSeedTarget, snapshotPath: string) {
  if (seed.kind === "path_copy") {
    if (!(await pathExists(seed.targetPath))) {
      await resetGenericPath(snapshotPath)
      return
    }
    await rm(snapshotPath, { recursive: true, force: true })
    const stats = await lstat(seed.targetPath)
    if (stats.isDirectory()) {
      await cp(seed.targetPath, snapshotPath, { recursive: true, force: true })
      return
    }
    await ensureParentDirForPath(snapshotPath)
    await cp(seed.targetPath, snapshotPath, { force: true })
    return
  }

  const livePaths = experienceWorkspacePathsFromRoot(seed.targetPath, "manifest.md")
  const snapshot = await readExperienceWorkspace(livePaths)
  await writeExperienceWorkspaceSnapshot(snapshotPath, snapshot)
}

async function clearNonSeedEditablePaths(baseSpec: LongTaskSpec, seedTargets: LongTaskCampaignSeedTarget[]) {
  const protectedTargets = new Set(seedTargets.map((item) => path.resolve(item.targetPath)))
  for (const editablePath of baseSpec.editablePaths ?? []) {
    const resolved = path.resolve(editablePath)
    if (protectedTargets.has(resolved)) continue
    await resetGenericPath(resolved)
  }
}

function candidateManifestPaths(workspaceRoot: string) {
  return {
    manifestPath: path.join(workspaceRoot, "manifest.md"),
    changeLogPath: path.join(workspaceRoot, "change_log.md"),
    lessonsPath: path.join(workspaceRoot, "lessons", "failure_lessons.md"),
  }
}

function completionOnlyValidatorContracts(spec: LongTaskSpec) {
  return spec.validators.filter(
    (validator) => validator.required !== false && validator.placement === "completion_only",
  )
}

function shouldRunCampaignWorkers(roundNumber: number) {
  return roundNumber > 1
}

function shouldRunCampaignReviewer(roundNumber: number) {
  return roundNumber > 1
}

function buildCampaignFinalAcceptanceSpec(baseSpec: LongTaskSpec, pendingPackageRoot: string): LongTaskSpec {
  return {
    ...baseSpec,
    disableCompletionValidators: false,
    initialExpertContextPaths: [pendingPackageRoot],
    formalPackageRoots: [pendingPackageRoot],
    targetPaths: [
      {
        path: pendingPackageRoot,
        label: "pending expert package",
        role: "experience-workspace",
      },
    ],
    editablePaths: [],
    initialGraph: undefined,
  }
}

function syntheticCampaignFinalAcceptanceUnit(spec: LongTaskSpec, pendingPackageRoot: string): LongTaskWorkUnit {
  return {
    id: "campaign-final-acceptance",
    title: "Campaign Final Acceptance",
    goal: spec.goal,
    inputs: [pendingPackageRoot, ...spec.materials.map((item) => item.path)],
    dependsOn: [],
    expectedArtifacts: [pendingPackageRoot],
    claim: "The current pending expert package is ready for final blank-agent acceptance.",
    checkPlan: "Run all required completion validators against the current pending expert package.",
    validatorIDs: completionOnlyValidatorContracts(spec).map((validator) => validator.id),
    retryBudget: 1,
    status: "active",
    attemptCount: 1,
  }
}

async function ensureManifestPointsToLessons(workspaceRoot: string, lessonsRelativePath: string) {
  const { manifestPath } = candidateManifestPaths(workspaceRoot)
  if (!(await pathExists(manifestPath))) return
  const content = await readTextFile(manifestPath)
  if (content.includes(lessonsRelativePath)) return
  const marker = [
    "",
    "## Cross-Round Failure Lessons",
    "",
    `- Before execution, read \`${lessonsRelativePath}\` and apply the resolved failure-path guidance there.`,
  ].join("\n")
  await writeTextFile(manifestPath, `${content.trimEnd()}\n${marker}\n`)
}

async function appendCampaignChangeLog(workspaceRoot: string, roundRecord: LongTaskCampaignRoundRecord) {
  const { changeLogPath } = candidateManifestPaths(workspaceRoot)
  const line = `- ${roundRecord.roundID}: ${roundRecord.finalStatus} - ${roundRecord.summary}`
  if (!(await pathExists(changeLogPath))) {
    await writeTextFile(changeLogPath, `<!-- auto-evolve-role: change_log -->\n# Change Log\n\n${line}\n`)
    return
  }
  const content = await readTextFile(changeLogPath)
  if (content.includes(line)) return
  await writeTextFile(changeLogPath, `${content.trimEnd()}\n${line}\n`)
}

function extractStringField(raw: Record<string, unknown>, key: string) {
  return typeof raw[key] === "string" && raw[key].trim().length > 0 ? raw[key].trim() : undefined
}

function summarizeFailures(failures: Record<string, unknown>[]) {
  return failures
    .map((item) => {
      const mismatchSummary = extractStringField(item, "mismatchSummary") ?? "Unknown failure"
      const nextPriorityFix = extractStringField(item, "nextPriorityFix")
      const suspectedCauses = Array.isArray(item.suspectedCauses)
        ? item.suspectedCauses.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : []
      const parts = [`- ${short(mismatchSummary, 240)}`]
      if (suspectedCauses.length) {
        parts.push(
          `  causes: ${suspectedCauses
            .slice(0, 3)
            .map((value) => short(value, 120))
            .join(" | ")}`,
        )
      }
      if (nextPriorityFix) {
        parts.push(`  next_fix: ${short(nextPriorityFix, 180)}`)
      }
      return parts.join("\n")
    })
    .slice(0, 12)
}

function summarizeRetryLessons(lessons: Record<string, unknown>[]) {
  return lessons
    .map((item) => {
      const whatFailed = extractStringField(item, "whatFailed") ?? "Unknown retry lesson"
      const nextAttemptStrategy = Array.isArray(item.nextAttemptStrategy)
        ? item.nextAttemptStrategy.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          )
        : []
      return `- ${short(whatFailed, 220)}${nextAttemptStrategy.length ? ` -> ${short(nextAttemptStrategy[0], 180)}` : ""}`
    })
    .slice(0, 12)
}

function summarizeLearningUnits(units: Record<string, unknown>[]) {
  return units
    .map((item) => extractStringField(item, "statement"))
    .filter((item): item is string => Boolean(item))
    .map((item) => `- ${short(item, 220)}`)
    .slice(0, 12)
}

function buildRoundSummaryMarkdown(input: {
  roundNumber: number
  mode: string
  finalStatus: LongTaskRunStatus
  summary: string
  failures: Record<string, unknown>[]
  retryLessons: Record<string, unknown>[]
  learningUnits: Record<string, unknown>[]
}) {
  const failureLines = summarizeFailures(input.failures)
  const retryLines = summarizeRetryLessons(input.retryLessons)
  const learningLines = summarizeLearningUnits(input.learningUnits)

  return [
    `# ${roundID(input.roundNumber)} Summary`,
    "",
    `- mode: ${input.mode}`,
    `- status: ${input.finalStatus}`,
    `- summary: ${input.summary}`,
    `- failure_packets: ${input.failures.length}`,
    `- retry_lessons: ${input.retryLessons.length}`,
    `- learning_units: ${input.learningUnits.length}`,
    "",
    "## Key Failure Paths",
    "",
    ...(failureLines.length ? failureLines : ["- none"]),
    "",
    "## Retry Strategy Carryover",
    "",
    ...(retryLines.length ? retryLines : ["- none"]),
    "",
    "## New Learning Units",
    "",
    ...(learningLines.length ? learningLines : ["- none"]),
    "",
  ].join("\n")
}

function buildCampaignLessonsMarkdown(input: {
  title: string
  latestRound: number
  records: LongTaskCampaignRoundRecord[]
  failures: Record<string, unknown>[]
  retryLessons: Record<string, unknown>[]
  learningUnits: Record<string, unknown>[]
}) {
  const latestRecord = input.records[input.records.length - 1]
  const failureLines = summarizeFailures(input.failures)
  const retryLines = summarizeRetryLessons(input.retryLessons)
  const learningLines = summarizeLearningUnits(input.learningUnits)

  return [
    "<!-- auto-evolve-role: failure_lessons -->",
    "# Cross-Round Failure Lessons",
    "",
    `Status: updated through ${roundID(input.latestRound)}`,
    "",
    "## Purpose",
    "",
    "- This file accumulates failed paths across campaign rounds.",
    "- A deployment-time blank agent should read this file before following the execution checklist.",
    "- Only stable, task-relevant lessons from actual failed paths should remain here.",
    "",
    "## Latest Campaign State",
    "",
    `- title: ${input.title}`,
    `- rounds_completed: ${input.records.length}`,
    `- latest_status: ${latestRecord?.finalStatus ?? "unknown"}`,
    `- latest_summary: ${latestRecord?.summary ?? "none"}`,
    "",
    "## Stable Failed-Path Lessons",
    "",
    ...(failureLines.length ? failureLines : ["- none yet"]),
    "",
    "## Retry Guidance That Emerged From Failures",
    "",
    ...(retryLines.length ? retryLines : ["- none yet"]),
    "",
    "## Generalized Learning That Survived Across Rounds",
    "",
    ...(learningLines.length ? learningLines : ["- none yet"]),
    "",
    "## Round Chronology",
    "",
    ...input.records.map(
      (record) =>
        `- ${record.roundID}: ${record.finalStatus} | ${record.summary} | failures=${record.failurePacketCount} retry_lessons=${record.retryLessonCount} learning_units=${record.learningUnitCount}`,
    ),
    "",
  ].join("\n")
}

function buildFailurePacketsCarryoverMarkdown(input: {
  title: string
  latestRound: number
  records: LongTaskCampaignRoundRecord[]
  failures: Record<string, unknown>[]
}) {
  const latestRecord = input.records[input.records.length - 1]
  const failureLines = summarizeFailures(input.failures)

  return [
    "<!-- auto-evolve-role: carryover_failure_packets -->",
    "# Carryover Failure Packets",
    "",
    `Status: updated through ${roundID(input.latestRound)}`,
    "",
    "## Purpose",
    "",
    "- Use this file only for stable failed-path lessons that should shape the next round plan.",
    "- This carryover excludes retry guidance and generalized learning.",
    "",
    "## Latest Campaign State",
    "",
    `- title: ${input.title}`,
    `- rounds_completed: ${input.records.length}`,
    `- latest_status: ${latestRecord?.finalStatus ?? "unknown"}`,
    `- latest_summary: ${latestRecord?.summary ?? "none"}`,
    "",
    "## Stable Failed-Path Lessons",
    "",
    ...(failureLines.length ? failureLines : ["- none yet"]),
    "",
  ].join("\n")
}

function buildRetryLessonsCarryoverMarkdown(input: {
  title: string
  latestRound: number
  records: LongTaskCampaignRoundRecord[]
  retryLessons: Record<string, unknown>[]
}) {
  const latestRecord = input.records[input.records.length - 1]
  const retryLines = summarizeRetryLessons(input.retryLessons)

  return [
    "<!-- auto-evolve-role: carryover_retry_lessons -->",
    "# Carryover Retry Lessons",
    "",
    `Status: updated through ${roundID(input.latestRound)}`,
    "",
    "## Purpose",
    "",
    "- Use this file only for retry strategy guidance distilled from prior failed attempts.",
    "- This carryover excludes failed-path catalogs and generalized learning.",
    "",
    "## Latest Campaign State",
    "",
    `- title: ${input.title}`,
    `- rounds_completed: ${input.records.length}`,
    `- latest_status: ${latestRecord?.finalStatus ?? "unknown"}`,
    `- latest_summary: ${latestRecord?.summary ?? "none"}`,
    "",
    "## Retry Guidance",
    "",
    ...(retryLines.length ? retryLines : ["- none yet"]),
    "",
  ].join("\n")
}

function buildLearningUnitsCarryoverMarkdown(input: {
  title: string
  latestRound: number
  records: LongTaskCampaignRoundRecord[]
  learningUnits: Record<string, unknown>[]
}) {
  const latestRecord = input.records[input.records.length - 1]
  const learningLines = summarizeLearningUnits(input.learningUnits)

  return [
    "<!-- auto-evolve-role: carryover_learning_units -->",
    "# Carryover Learning Units",
    "",
    `Status: updated through ${roundID(input.latestRound)}`,
    "",
    "## Purpose",
    "",
    "- Use this file only for generalized learning that survived across prior rounds.",
    "- This carryover excludes failed-path catalogs and retry-specific guidance.",
    "",
    "## Latest Campaign State",
    "",
    `- title: ${input.title}`,
    `- rounds_completed: ${input.records.length}`,
    `- latest_status: ${latestRecord?.finalStatus ?? "unknown"}`,
    `- latest_summary: ${latestRecord?.summary ?? "none"}`,
    "",
    "## Generalized Learning",
    "",
    ...(learningLines.length ? learningLines : ["- none yet"]),
    "",
  ].join("\n")
}

async function syncLessonsMirror(input: {
  lessonsContent: string
  workspaceTargetPath: string
  lessonsRelativePath: string
  addManifestPointer: boolean
  roundRecord: LongTaskCampaignRoundRecord
}) {
  const lessonPath = path.join(input.workspaceTargetPath, ...input.lessonsRelativePath.split("/"))
  await writeTextFile(lessonPath, input.lessonsContent)
  if (input.addManifestPointer) {
    await ensureManifestPointsToLessons(input.workspaceTargetPath, input.lessonsRelativePath)
  }
  await appendCampaignChangeLog(input.workspaceTargetPath, input.roundRecord)
}

async function harvestRound(input: {
  cwd: string
  campaignID: string
  campaignSpec: LongTaskCampaignSpec
  baseSpec: LongTaskSpec
  roundNumber: number
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
  runResult: Awaited<ReturnType<typeof runLongTask>>
  seedTargets: LongTaskCampaignSeedTarget[]
}) {
  const runDir = input.runResult.runDir
  const failurePacketsPath = path.join(runDir, "failure_packets.jsonl")
  const retryLessonsPath = path.join(runDir, "retry_lessons.jsonl")
  const learningUnitsPath = path.join(runDir, "learning_units.jsonl")
  const runPaths = resolveExistingLongTaskRun(input.cwd, input.runResult.runID).run

  const failurePackets = await readJsonLinesIfExists<Record<string, unknown>>(failurePacketsPath)
  const retryLessons = await readJsonLinesIfExists<Record<string, unknown>>(retryLessonsPath)
  const learningUnits = await readJsonLinesIfExists<Record<string, unknown>>(learningUnitsPath)
  const operationalContext = await readOperationalContext(runPaths)
  const runTrace = await buildCampaignRunTrace({
    campaignID: input.campaignID,
    roundNumber: input.roundNumber,
    run: runPaths,
    spec: input.baseSpec,
    finalStatus: input.runResult.status,
    summary: input.runResult.summary.summary,
  })
  const runTraceDigest = buildRunTraceDigest(runTrace)

  const roundSummary = buildRoundSummaryMarkdown({
    roundNumber: input.roundNumber,
    mode: input.campaignSpec.mode,
    finalStatus: input.runResult.status,
    summary: input.runResult.summary.summary,
    failures: failurePackets,
    retryLessons,
    learningUnits,
  })

  await writeTextFile(input.roundPaths.roundSummaryPath, roundSummary)
  await writeJsonFile(input.roundPaths.runTraceJsonPath, runTrace)
  await writeJsonFile(input.roundPaths.runTraceDigestPath, runTraceDigest)
  await writeTextFile(input.roundPaths.runTraceMarkdownPath, buildCampaignRunTraceMarkdown(runTrace))

  const snapshotPaths: LongTaskCampaignRoundRecord["snapshotPaths"] = []
  for (const seed of input.seedTargets) {
    const snapshotPath = path.join(
      input.roundPaths.snapshotsRoot,
      path.basename(seed.targetPath) || `target-${snapshotPaths.length + 1}`,
    )
    await snapshotSeedTarget(seed, snapshotPath)
    snapshotPaths.push({
      targetPath: seed.targetPath,
      snapshotPath,
      kind: seed.kind ?? "experience_workspace",
    })
  }

  return {
    roundRecord: {
      roundNumber: input.roundNumber,
      roundID: roundID(input.roundNumber),
      roundSpecPath: input.roundPaths.generatedSpecPath,
      runTracePath: input.roundPaths.runTraceJsonPath,
      sourceRunID: input.runResult.runID,
      sourceRunDir: input.runResult.runDir,
      finalStatus: input.runResult.status,
      summary: input.runResult.summary.summary,
      failurePacketCount: failurePackets.length,
      retryLessonCount: retryLessons.length,
      learningUnitCount: learningUnits.length,
      roundSummaryPath: input.roundPaths.roundSummaryPath,
      snapshotPaths,
      createdAt: nowISO(),
    } satisfies LongTaskCampaignRoundRecord,
    failurePackets,
    retryLessons,
    learningUnits,
    operationalContext,
    runTrace,
    runTraceDigest,
  }
}

function buildGeneratedRoundSpec(input: {
  baseSpec: LongTaskSpec
  campaignSpec: LongTaskCampaignSpec
  roundNumber: number
  pendingPackageRoot: string
  explorationTreePath: string
  workingMemoryPath: string
  routingControlPath: string
}): LongTaskSpec {
  const staticBaseContext = collectStaticBaseContextPaths(input.baseSpec)
  return {
    ...input.baseSpec,
    title: `${input.campaignSpec.title}-${roundID(input.roundNumber)}`,
    disableCompletionValidators: true,
    initialExpertContextPaths: uniqueStrings([
      input.pendingPackageRoot,
      input.explorationTreePath,
      input.routingControlPath,
      ...staticBaseContext,
    ]),
    initialGraph:
      input.roundNumber === 1 && input.baseSpec.initialGraph
        ? {
            ...input.baseSpec.initialGraph,
            completion_validator_ids: [],
          }
        : undefined,
    campaignPendingPackageRoot: input.pendingPackageRoot,
    campaignExplorationTreePath: input.explorationTreePath,
    campaignWorkingMemoryPath: input.workingMemoryPath,
    campaignRoutingControlPath: input.routingControlPath,
    budgets: applyBudgetOverrides(input.baseSpec.budgets, input.campaignSpec.roundBudgetOverrides),
    notes: [
      input.baseSpec.notes,
      `campaign_mode=${input.campaignSpec.mode}`,
      `campaign_round=${input.roundNumber}/${input.campaignSpec.maxRounds}`,
      "This round is generated by the long-task campaign controller. Every round must leave durable learning artifacts and promote stable operational context for later rounds.",
      "Planner must obey routing control and should rebuild the graph from current package/tree/routing after round 1.",
    ]
      .filter(Boolean)
      .join(" "),
  }
}

async function runCampaignSuggestionTask(input: {
  cwd: string
  baseSpec: LongTaskSpec
  title: string
  prompt: string
  selectionPhase: ModelPhase
  execution?: ExecutionSpec
  referencePaths: string[]
  attachedFiles?: string[]
  permissionReadPaths: string[]
  permissionEditPaths?: string[]
  stageDir: string
  phase: string
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
}) {
  const config = await loadConfig(input.cwd)
  const selection = resolveModelSelection(config, input.selectionPhase, input.execution)
  const task = await runOpencodeTask({
    cwd: input.cwd,
    config,
    title: input.title,
    prompt: input.prompt,
    referencePaths: uniqueStrings(input.referencePaths),
    attachedFiles: uniqueStrings(input.attachedFiles ?? []),
    permissionReadPaths: uniqueStrings(input.permissionReadPaths),
    permissionEditPaths: uniqueStrings(input.permissionEditPaths ?? []),
    model: selection.model,
    agent: selection.agent,
    variant: selection.variant,
    runtimeScope: input.runtimeScope,
    onSpawn: input.onActivation,
  })
  const artifactPaths = await writeTaskArtifacts(input.stageDir, task, {
    phase: input.phase,
  })
  return {
    task,
    artifactPaths,
    parsed: extractJsonObject(task.result.responseText),
  }
}

function normalizeWorkerSuggestion(input: {
  roundNumber: number
  role: LongTaskCampaignWorkerRole
  parsed: Record<string, unknown> | undefined
  responsePath: string
}): LongTaskCampaignWorkerSuggestion {
  return {
    id: `worker-${randomUUID().slice(0, 8)}`,
    roundNumber: input.roundNumber,
    role: input.role,
    createdAt: nowISO(),
    summary:
      typeof input.parsed?.summary === "string" && input.parsed.summary.trim().length > 0
        ? input.parsed.summary.trim()
        : `${input.role} produced no structured summary.`,
    findings: normalizeStringArray(input.parsed?.findings),
    packageAdvice: normalizeStringArray(input.parsed?.package_advice),
    explorationAdvice: normalizeStringArray(input.parsed?.exploration_advice),
    refs: uniqueStrings([input.responsePath, ...normalizeStringArray(input.parsed?.refs)]),
    responsePath: input.responsePath,
  }
}

function normalizeReviewerSuggestion(input: {
  roundNumber: number
  parsed: Record<string, unknown> | undefined
  responsePath: string
}): LongTaskCampaignReviewSuggestion {
  return {
    id: `review-${randomUUID().slice(0, 8)}`,
    roundNumber: input.roundNumber,
    createdAt: nowISO(),
    readyForFinalAcceptance:
      typeof input.parsed?.ready_for_final_acceptance === "boolean" ? input.parsed.ready_for_final_acceptance : false,
    summary:
      typeof input.parsed?.summary === "string" && input.parsed.summary.trim().length > 0
        ? input.parsed.summary.trim()
        : "Reviewer produced no structured summary.",
    reasons: normalizeStringArray(input.parsed?.reasons),
    nextAttentionAreas: normalizeStringArray(input.parsed?.next_attention_areas),
    refs: uniqueStrings([input.responsePath, ...normalizeStringArray(input.parsed?.refs)]),
    responsePath: input.responsePath,
  }
}

async function prepareCampaignRoundState(input: {
  baseSpec: LongTaskSpec
  campaignSpec: LongTaskCampaignSpec
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
}) {
  await clearNonSeedEditablePaths(input.baseSpec, input.campaignSpec.seedTargets)
  const primarySeed = primaryExperienceWorkspaceSeedTarget(input.campaignSpec.seedTargets)
  for (const seedTarget of input.campaignSpec.seedTargets) {
    if (seedTarget.resetOnStart === false) continue
    if (
      primarySeed &&
      seedTarget.targetPath === primarySeed.targetPath &&
      (seedTarget.kind ?? "experience_workspace") === "experience_workspace" &&
      (await pathExists(path.join(input.campaignPaths.pendingCurrentRoot, "manifest.md")))
    ) {
      await copyExperienceWorkspaceRoot(input.campaignPaths.pendingCurrentRoot, seedTarget.targetPath)
      continue
    }
    if ((seedTarget.kind ?? "experience_workspace") === "experience_workspace") {
      await copyExperienceWorkspaceRoot(seedTarget.seedPath, seedTarget.targetPath)
      continue
    }
    await copyPathIntoTarget(seedTarget.seedPath, seedTarget.targetPath)
  }
}

async function collectCarryoverContext(input: {
  baseSpec: LongTaskSpec
  campaignSpec: LongTaskCampaignSpec
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  history: LongTaskCampaignRoundRecord[]
}) {
  const carryover = input.campaignSpec.carryover ?? DEFAULT_LONG_TASK_CAMPAIGN_CARRYOVER
  const candidates: string[] = []

  if (carryover.includeCampaignOperationalMemory) {
    candidates.push(input.campaignPaths.campaignOperationalMemoryPath)
  }

  if (carryover.includeCampaignSeedContext) {
    candidates.push(input.campaignPaths.campaignSeedContextPath)
  }

  if (carryover.includeFailurePackets) {
    candidates.push(input.campaignPaths.carryoverFailurePacketsPath)
    candidates.push(input.campaignPaths.aggregatedFailurePacketsPath)
  }

  if (carryover.includeRetryLessons) {
    candidates.push(input.campaignPaths.carryoverRetryLessonsPath)
    candidates.push(input.campaignPaths.aggregatedRetryLessonsPath)
  }

  if (carryover.includeLearningUnits) {
    candidates.push(input.campaignPaths.carryoverLearningUnitsPath)
    candidates.push(input.campaignPaths.aggregatedLearningUnitsPath)
  }

  if (carryover.includeRoundSummaries) {
    for (const record of input.history.slice(-carryover.recentRoundSummaryCount)) {
      candidates.push(record.roundSummaryPath)
    }
  }

  const resolved: string[] = []
  for (const candidate of uniqueStrings(candidates)) {
    if (await pathExists(candidate)) {
      resolved.push(candidate)
    }
  }

  return resolved
}

async function readLatestReviewerSuggestionPath(campaignPaths: ReturnType<typeof longTaskCampaignPaths>) {
  if (!(await pathExists(campaignPaths.campaignReviewSuggestionsPath))) return undefined
  const raw = (await readTextFile(campaignPaths.campaignReviewSuggestionsPath)).trim()
  if (!raw) return undefined
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) return undefined
  try {
    const last = JSON.parse(lines[lines.length - 1]) as LongTaskCampaignReviewSuggestion
    return last.responsePath
  } catch {
    return undefined
  }
}

async function seedRoundPendingPackageFromCurrent(input: {
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
}) {
  if (!(await pathExists(path.join(input.campaignPaths.pendingCurrentRoot, "manifest.md")))) {
    await ensureDirectory(input.roundPaths.pendingPackageSnapshotRoot)
    return
  }
  await copyExperienceWorkspaceRoot(input.campaignPaths.pendingCurrentRoot, input.roundPaths.pendingPackageSnapshotRoot)
}

async function seedRoundExplorationTreeFromCurrent(input: {
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
}) {
  const currentTree = await readLongTaskCampaignExplorationTree(input.campaignPaths)
  await writeJsonFile(input.roundPaths.explorationTreeDraftPath, currentTree)
}

async function seedRoundRoutingControlFromCurrent(input: {
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
}) {
  const currentRoutingControl = await readLongTaskCampaignRoutingControl(input.campaignPaths)
  await writeJsonFile(input.roundPaths.routingControlDraftPath, currentRoutingControl)
}

async function runCampaignWorkers(input: {
  cwd: string
  campaignID: string
  campaignSpec: LongTaskCampaignSpec
  baseSpec: LongTaskSpec
  roundNumber: number
  runTracePath: string
  runTraceDigestPath: string
  pendingPackageRoot: string
  explorationTreePath: string
  workingMemoryPath: string
  routingControlPath: string
  reviewerSuggestionPath?: string
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
}) {
  const workerRoles = defaultCampaignWorkerRoles()
  const suggestions = await Promise.all(
    workerRoles.map(async (role) => {
      const stageDir = path.join(input.roundPaths.workersRoot, role)
      const prompt = buildCampaignWorkerPrompt({
        title: input.campaignSpec.title,
        roundNumber: input.roundNumber,
        role,
        runTracePath: input.runTraceDigestPath,
        pendingPackageRoot: input.pendingPackageRoot,
        explorationTreePath: input.explorationTreePath,
        workingMemoryPath: input.workingMemoryPath,
        routingControlPath: input.routingControlPath,
        reviewerSuggestionPath: input.reviewerSuggestionPath,
      })
      const result = await runCampaignSuggestionTask({
        cwd: input.cwd,
        baseSpec: input.baseSpec,
        title: `Campaign Worker ${role} ${roundID(input.roundNumber)}`,
        prompt,
        selectionPhase: "planning",
        execution: input.baseSpec.planning ?? input.baseSpec.execution,
        referencePaths: [
          input.runTraceDigestPath,
          input.pendingPackageRoot,
          input.explorationTreePath,
          input.workingMemoryPath,
          input.routingControlPath,
          ...(input.reviewerSuggestionPath ? [input.reviewerSuggestionPath] : []),
        ],
        permissionReadPaths: [
          input.runTraceDigestPath,
          input.pendingPackageRoot,
          input.explorationTreePath,
          input.workingMemoryPath,
          input.routingControlPath,
          ...(input.reviewerSuggestionPath ? [input.reviewerSuggestionPath] : []),
        ],
        stageDir,
        phase: "campaign_worker",
        runtimeScope: input.runtimeScope,
        onActivation: input.onActivation,
      })
      const suggestion = normalizeWorkerSuggestion({
        roundNumber: input.roundNumber,
        role,
        parsed: result.parsed,
        responsePath: result.artifactPaths.responsePath,
      })
      await writeLongTaskCampaignWorkerSuggestion(path.join(stageDir, "suggestion.json"), suggestion)
      return suggestion
    }),
  )

  return suggestions
}

async function runCampaignLead(input: {
  cwd: string
  campaignSpec: LongTaskCampaignSpec
  baseSpec: LongTaskSpec
  roundNumber: number
  runTracePath: string
  runTraceDigestPath: string
  previousPendingPackageRoot: string
  nextPendingPackageRoot: string
  previousExplorationTreePath: string
  nextExplorationTreePath: string
  workingMemoryPath: string
  previousRoutingControlPath: string
  nextRoutingControlPath: string
  workerSuggestions: LongTaskCampaignWorkerSuggestion[]
  reviewerSuggestionPath?: string
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
}) {
  const workerSuggestionPaths = input.workerSuggestions
    .map((item) => item.responsePath)
    .filter((item): item is string => Boolean(item))
  const stageDir = path.join(input.roundPaths.root, "campaign-lead")
  const prompt = buildCampaignLeadPrompt({
    title: input.campaignSpec.title,
    roundNumber: input.roundNumber,
    runTracePath: input.runTraceDigestPath,
    previousPendingPackageRoot: input.previousPendingPackageRoot,
    nextPendingPackageRoot: input.nextPendingPackageRoot,
    previousExplorationTreePath: input.previousExplorationTreePath,
    nextExplorationTreePath: input.nextExplorationTreePath,
    workingMemoryPath: input.workingMemoryPath,
    previousRoutingControlPath: input.previousRoutingControlPath,
    nextRoutingControlPath: input.nextRoutingControlPath,
    workerSuggestionPaths,
    reviewerSuggestionPath: input.reviewerSuggestionPath,
  })
  return runCampaignSuggestionTask({
    cwd: input.cwd,
    baseSpec: input.baseSpec,
    title: `Campaign Lead ${roundID(input.roundNumber)}`,
    prompt,
    selectionPhase: "solve",
    execution: input.baseSpec.execution,
    referencePaths: [
      input.runTraceDigestPath,
      input.previousPendingPackageRoot,
      input.previousExplorationTreePath,
      input.workingMemoryPath,
      input.previousRoutingControlPath,
      ...workerSuggestionPaths,
      ...(input.reviewerSuggestionPath ? [input.reviewerSuggestionPath] : []),
    ],
    permissionReadPaths: [
      input.runTraceDigestPath,
      input.previousPendingPackageRoot,
      input.previousExplorationTreePath,
      input.workingMemoryPath,
      input.previousRoutingControlPath,
      ...workerSuggestionPaths,
      ...(input.reviewerSuggestionPath ? [input.reviewerSuggestionPath] : []),
    ],
    permissionEditPaths: [input.nextPendingPackageRoot, input.nextExplorationTreePath, input.nextRoutingControlPath],
    stageDir,
    phase: "campaign_lead",
    runtimeScope: input.runtimeScope,
    onActivation: input.onActivation,
  })
}

async function runCampaignReviewer(input: {
  cwd: string
  campaignSpec: LongTaskCampaignSpec
  baseSpec: LongTaskSpec
  roundNumber: number
  pendingPackageRoot: string
  runTracePath: string
  explorationTreePath: string
  workingMemoryPath: string
  routingControlPath: string
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
}) {
  const stageDir = input.roundPaths.reviewerRoot
  const prompt = buildCampaignReviewerPrompt({
    title: input.campaignSpec.title,
    roundNumber: input.roundNumber,
    pendingPackageRoot: input.pendingPackageRoot,
    runTracePath: input.runTracePath,
    explorationTreePath: input.explorationTreePath,
    workingMemoryPath: input.workingMemoryPath,
    routingControlPath: input.routingControlPath,
  })
  const result = await runCampaignSuggestionTask({
    cwd: input.cwd,
    baseSpec: input.baseSpec,
    title: `Campaign Reviewer ${roundID(input.roundNumber)}`,
    prompt,
    selectionPhase: "validation",
    execution: input.baseSpec.validation ?? input.baseSpec.execution,
    referencePaths: [
      input.pendingPackageRoot,
      input.runTracePath,
      input.explorationTreePath,
      input.workingMemoryPath,
      input.routingControlPath,
    ],
    permissionReadPaths: [
      input.pendingPackageRoot,
      input.runTracePath,
      input.explorationTreePath,
      input.workingMemoryPath,
      input.routingControlPath,
    ],
    stageDir,
    phase: "campaign_review",
    runtimeScope: input.runtimeScope,
    onActivation: input.onActivation,
  })
  const suggestion = normalizeReviewerSuggestion({
    roundNumber: input.roundNumber,
    parsed: result.parsed,
    responsePath: result.artifactPaths.responsePath,
  })
  await writeJsonFile(input.roundPaths.reviewerSuggestionPath, suggestion)
  return suggestion
}

async function runCampaignFinalAcceptance(input: {
  cwd: string
  campaignID: string
  campaignSpec: LongTaskCampaignSpec
  baseSpec: LongTaskSpec
  roundNumber: number
  sourceRunID: string
  pendingPackageRoot: string
  runTracePath: string
  reviewerSuggestionPath: string
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
}) {
  const validatorContracts = completionOnlyValidatorContracts(input.baseSpec)
  if (!validatorContracts.length) {
    const emptyResult = {
      campaignID: input.campaignID,
      roundNumber: input.roundNumber,
      runID: input.sourceRunID,
      passed: true,
      summary: "No completion-only validators were configured for campaign final acceptance.",
      validatorResults: [] as LongTaskValidatorResult[],
      createdAt: nowISO(),
    }
    await ensureDirectory(input.roundPaths.finalAcceptanceRoot)
    await writeJsonFile(input.roundPaths.finalAcceptanceResultPath, emptyResult)
    return emptyResult
  }

  await ensureDirectory(input.roundPaths.finalAcceptanceRoot)
  const acceptanceSpec = buildCampaignFinalAcceptanceSpec(input.baseSpec, input.pendingPackageRoot)
  const syntheticUnit = syntheticCampaignFinalAcceptanceUnit(input.baseSpec, input.pendingPackageRoot)
  const bundlePath = path.join(input.roundPaths.finalAcceptanceRoot, "final-acceptance-bundle.json")
  await writeJsonFile(bundlePath, {
    id: `campaign-final-${randomUUID().slice(0, 8)}`,
    campaignID: input.campaignID,
    roundNumber: input.roundNumber,
    sourceRunID: input.sourceRunID,
    pendingPackageRoot: input.pendingPackageRoot,
    runTracePath: input.runTracePath,
    reviewerSuggestionPath: input.reviewerSuggestionPath,
    createdAt: nowISO(),
  })

  const config = await loadConfig(input.cwd)
  const validatorResults: LongTaskValidatorResult[] = []
  for (const validator of validatorContracts) {
    const result = await runLongTaskValidator({
      cwd: input.cwd,
      config,
      contract: validator,
      spec: acceptanceSpec,
      unit: syntheticUnit,
      runID: input.sourceRunID,
      attempt: 1,
      validatorDir: path.join(input.roundPaths.finalAcceptanceRoot, validator.id),
      bundlePath,
      runtimeScope: input.runtimeScope,
      onActivation: input.onActivation,
      payload: {
        runID: input.sourceRunID,
        unitID: syntheticUnit.id,
        attempt: 1,
        goal: acceptanceSpec.goal,
        claim: syntheticUnit.claim,
        checkPlan: syntheticUnit.checkPlan,
        materials: acceptanceSpec.materials,
        targetPaths: acceptanceSpec.targetPaths ?? [],
        expectedArtifacts: syntheticUnit.expectedArtifacts,
        editablePaths: acceptanceSpec.editablePaths ?? [],
        bundlePath,
      },
    })
    validatorResults.push(result)
  }

  const passed = validatorResults.every((result) => result.passed)
  const summary = passed
    ? "Campaign final acceptance passed."
    : validatorResults
        .filter((result) => !result.passed)
        .map((result) => result.summary)
        .join(" | ") || "Campaign final acceptance failed."

  const finalAcceptance = {
    campaignID: input.campaignID,
    roundNumber: input.roundNumber,
    runID: input.sourceRunID,
    passed,
    summary,
    validatorResults,
    bundlePath,
    createdAt: nowISO(),
  }
  await writeJsonFile(input.roundPaths.finalAcceptanceResultPath, finalAcceptance)
  return finalAcceptance
}

async function promoteRoundPendingAndTreeToCurrent(input: {
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
}) {
  if (await pathExists(path.join(input.roundPaths.pendingPackageSnapshotRoot, "manifest.md"))) {
    await copyExperienceWorkspaceRoot(
      input.roundPaths.pendingPackageSnapshotRoot,
      input.campaignPaths.pendingCurrentRoot,
    )
  }
  const currentTree = await readLongTaskCampaignExplorationTree(input.campaignPaths)
  const currentRoutingControl = await readLongTaskCampaignRoutingControl(input.campaignPaths)
  const rawExplorationTree = (await pathExists(input.roundPaths.explorationTreeDraftPath))
    ? await readJsonFile<unknown>(input.roundPaths.explorationTreeDraftPath)
    : currentTree
  const explorationTree = coerceExplorationTreeDocument(rawExplorationTree, currentTree)
  await writeLongTaskCampaignExplorationTree(input.campaignPaths, explorationTree)
  const rawRoutingControl = (await pathExists(input.roundPaths.routingControlDraftPath))
    ? await readJsonFile<unknown>(input.roundPaths.routingControlDraftPath)
    : currentRoutingControl
  const routingControl = coerceRoutingControl(rawRoutingControl, currentRoutingControl)
  await writeLongTaskCampaignRoutingControl(input.campaignPaths, routingControl)
}

export async function runLongTaskCampaign(input: { cwd: string; specPath: string }) {
  await healStaleRuntimeStates(input.cwd)
  const { spec: campaignSpec } = await loadLongTaskCampaignSpec(input.specPath)
  const { spec: baseSpec } = await loadLongTaskSpec(campaignSpec.baseSpecPath)
  const existingLiveCampaign = await findExistingLiveCampaign({
    cwd: input.cwd,
    title: campaignSpec.title,
    baseSpecPath: campaignSpec.baseSpecPath,
  })
  if (existingLiveCampaign) {
    return {
      campaignID: existingLiveCampaign.campaignID,
      campaignDir: existingLiveCampaign.campaignPaths.root,
      status: existingLiveCampaign.state.status,
      roundsCompleted: existingLiveCampaign.state.currentRound,
      lastRunID: existingLiveCampaign.state.lastRunID,
      lessonsPath: existingLiveCampaign.campaignPaths.campaignLessonsPath,
      roundSummaryPath: existingLiveCampaign.state.lastRoundSummaryPath,
    }
  }
  const campaignID = createLongTaskCampaignID(campaignSpec.title)
  const campaignPaths = longTaskCampaignPaths(input.cwd, campaignID)

  const initialState: LongTaskCampaignState = {
    id: campaignID,
    title: campaignSpec.title,
    taskFamily: campaignSpec.taskFamily ?? baseSpec.taskFamily,
    mode: campaignSpec.mode,
    baseSpecPath: campaignSpec.baseSpecPath,
    maxRounds: campaignSpec.maxRounds,
    currentRound: 0,
    status: "bootstrapping",
    createdAt: nowISO(),
    updatedAt: nowISO(),
    notes: campaignSpec.notes,
  }

  await initializeLongTaskCampaign(campaignPaths, initialState)
  await seedCampaignCurrentPendingPackage({
    currentRoot: campaignPaths.pendingCurrentRoot,
    seedTarget: primaryExperienceWorkspaceSeedTarget(campaignSpec.seedTargets),
  })

  const history: LongTaskCampaignRoundRecord[] = []
  let lastRoundNumber = 0
  let lastRunID: string | undefined
  let lastRoundSummaryPath: string | undefined

  try {
    for (let roundNumber = 1; roundNumber <= campaignSpec.maxRounds; roundNumber += 1) {
      lastRoundNumber = roundNumber
      const roundRuntimeScope = campaignRoundRuntimeScope(campaignID, roundNumber)
      const roundPaths = longTaskCampaignRoundPaths(campaignPaths, roundNumber)
      const activateCampaignRound = onceActivationCallback(async () => {
        await updateCampaignStatus(campaignPaths, "running", {
          currentRound: roundNumber,
          lastSummary: history[history.length - 1]?.summary,
          lastRunID: history[history.length - 1]?.sourceRunID,
          lastRoundSummaryPath: history[history.length - 1]?.roundSummaryPath,
        })
      })
      try {
        await ensureDirectory(roundPaths.root)
        await ensureDirectory(roundPaths.harvestedRoot)
        await ensureDirectory(roundPaths.snapshotsRoot)
        await ensureDirectory(roundPaths.workersRoot)
        await ensureDirectory(roundPaths.reviewerRoot)
        await ensureDirectory(roundPaths.finalAcceptanceRoot)

        await prepareCampaignRoundState({
          baseSpec,
          campaignSpec,
          campaignPaths,
        })
        await seedRoundPendingPackageFromCurrent({
          campaignPaths,
          roundPaths,
        })
        await seedRoundExplorationTreeFromCurrent({
          campaignPaths,
          roundPaths,
        })
        await seedRoundRoutingControlFromCurrent({
          campaignPaths,
          roundPaths,
        })

        const generatedSpec = buildGeneratedRoundSpec({
          baseSpec,
          campaignSpec,
          roundNumber,
          pendingPackageRoot: campaignPaths.pendingCurrentRoot,
          explorationTreePath: campaignPaths.explorationTreePath,
          workingMemoryPath: campaignPaths.campaignWorkingMemoryPath,
          routingControlPath: campaignPaths.campaignRoutingControlPath,
        })
        await writeJsonFile(roundPaths.generatedSpecPath, generatedSpec)

        await writeLongTaskCampaignState(campaignPaths, {
          ...initialState,
          currentRound: roundNumber,
          status: "bootstrapping",
          updatedAt: nowISO(),
          lastSummary: history[history.length - 1]?.summary,
          lastRunID: history[history.length - 1]?.sourceRunID,
          lastRoundSummaryPath: history[history.length - 1]?.roundSummaryPath,
        })

        const runResult = await runLongTask({
          cwd: input.cwd,
          specPath: roundPaths.generatedSpecPath,
          runtimeScope: roundRuntimeScope,
          onRuntimeActivated: activateCampaignRound,
        })
        lastRunID = runResult.runID

        const harvested = await harvestRound({
          cwd: input.cwd,
          campaignID,
          campaignSpec,
          baseSpec,
          roundNumber,
          roundPaths,
          runResult,
          seedTargets: campaignSpec.seedTargets,
        })
        history.push(harvested.roundRecord)
        lastRoundSummaryPath = harvested.roundRecord.roundSummaryPath
        await appendLongTaskCampaignHistory(campaignPaths, harvested.roundRecord)

        await appendLinesToAggregate(
          campaignPaths.aggregatedFailurePacketsPath,
          harvested.failurePackets.map((item) => JSON.stringify(item)),
        )
        await appendLinesToAggregate(
          campaignPaths.aggregatedRetryLessonsPath,
          harvested.retryLessons.map((item) => JSON.stringify(item)),
        )
        await appendLinesToAggregate(
          campaignPaths.aggregatedLearningUnitsPath,
          harvested.learningUnits.map((item) => JSON.stringify(item)),
        )

        const existingOperationalMemory = await readLongTaskCampaignOperationalMemory(campaignPaths)
        const promotedOperationalMemory = promoteCampaignOperationalMemory({
          existing: existingOperationalMemory,
          incoming: harvested.operationalContext,
          roundNumber,
          runID: runResult.runID,
        })
        await writeLongTaskCampaignOperationalMemory(campaignPaths, promotedOperationalMemory)
        const workingMemory = buildWorkingMemoryDocument({
          operationalMemory: promotedOperationalMemory,
          updatedThroughRound: roundNumber,
        })
        await writeLongTaskCampaignWorkingMemory(campaignPaths, workingMemory)

        const currentExplorationTree = await readLongTaskCampaignExplorationTree(campaignPaths)
        const evolvedExplorationTree = evolveExplorationTreeDocument({
          previous: currentExplorationTree,
          digest: harvested.runTraceDigest,
          roundNumber,
        })
        await writeJsonFile(roundPaths.explorationTreeDraftPath, evolvedExplorationTree)

        const currentRoutingControl = await readLongTaskCampaignRoutingControl(campaignPaths)
        const evolvedRoutingControl = buildRoutingControl({
          previous: currentRoutingControl,
          tree: evolvedExplorationTree,
          digest: harvested.runTraceDigest,
          roundNumber,
        })
        await writeJsonFile(roundPaths.routingControlDraftPath, evolvedRoutingControl)

        const allFailures = await readJsonLinesIfExists<Record<string, unknown>>(
          campaignPaths.aggregatedFailurePacketsPath,
        )
        const allRetryLessons = await readJsonLinesIfExists<Record<string, unknown>>(
          campaignPaths.aggregatedRetryLessonsPath,
        )
        const allLearningUnits = await readJsonLinesIfExists<Record<string, unknown>>(
          campaignPaths.aggregatedLearningUnitsPath,
        )
        const campaignLessons = buildCampaignLessonsMarkdown({
          title: campaignSpec.title,
          latestRound: roundNumber,
          records: history,
          failures: allFailures,
          retryLessons: allRetryLessons,
          learningUnits: allLearningUnits,
        })
        await writeLongTaskCampaignLessons(campaignPaths, campaignLessons)
        await writeTextFile(
          campaignPaths.carryoverFailurePacketsPath,
          buildFailurePacketsCarryoverMarkdown({
            title: campaignSpec.title,
            latestRound: roundNumber,
            records: history,
            failures: allFailures,
          }),
        )
        await writeTextFile(
          campaignPaths.carryoverRetryLessonsPath,
          buildRetryLessonsCarryoverMarkdown({
            title: campaignSpec.title,
            latestRound: roundNumber,
            records: history,
            retryLessons: allRetryLessons,
          }),
        )
        await writeTextFile(
          campaignPaths.carryoverLearningUnitsPath,
          buildLearningUnitsCarryoverMarkdown({
            title: campaignSpec.title,
            latestRound: roundNumber,
            records: history,
            learningUnits: allLearningUnits,
          }),
        )
        await writeLongTaskCampaignSeedContext(
          campaignPaths,
          buildCampaignSeedContextMarkdown({
            title: campaignSpec.title,
            latestRound: roundNumber,
            operationalMemory: promotedOperationalMemory,
            records: history,
          }),
        )

        const latestReviewerSuggestionPath = await readLatestReviewerSuggestionPath(campaignPaths)
        const workerSuggestions = shouldRunCampaignWorkers(roundNumber)
          ? await runCampaignWorkers({
              cwd: input.cwd,
              campaignID,
              campaignSpec,
              baseSpec,
              roundNumber,
              runTracePath: roundPaths.runTraceJsonPath,
              runTraceDigestPath: roundPaths.runTraceDigestPath,
              pendingPackageRoot: campaignPaths.pendingCurrentRoot,
              explorationTreePath: campaignPaths.explorationTreePath,
              workingMemoryPath: campaignPaths.campaignWorkingMemoryPath,
              routingControlPath: campaignPaths.campaignRoutingControlPath,
              reviewerSuggestionPath: latestReviewerSuggestionPath,
              campaignPaths,
              roundPaths,
              runtimeScope: roundRuntimeScope,
              onActivation: activateCampaignRound,
            })
          : []

        await runCampaignLead({
          cwd: input.cwd,
          campaignSpec,
          baseSpec,
          roundNumber,
          runTracePath: roundPaths.runTraceJsonPath,
          runTraceDigestPath: roundPaths.runTraceDigestPath,
          previousPendingPackageRoot: campaignPaths.pendingCurrentRoot,
          nextPendingPackageRoot: roundPaths.pendingPackageSnapshotRoot,
          previousExplorationTreePath: campaignPaths.explorationTreePath,
          nextExplorationTreePath: roundPaths.explorationTreeDraftPath,
          workingMemoryPath: campaignPaths.campaignWorkingMemoryPath,
          previousRoutingControlPath: campaignPaths.campaignRoutingControlPath,
          nextRoutingControlPath: roundPaths.routingControlDraftPath,
          workerSuggestions,
          reviewerSuggestionPath: latestReviewerSuggestionPath,
          campaignPaths,
          roundPaths,
          runtimeScope: roundRuntimeScope,
          onActivation: activateCampaignRound,
        })

        await promoteRoundPendingAndTreeToCurrent({
          campaignPaths,
          roundPaths,
        })

        const reviewerSuggestion = shouldRunCampaignReviewer(roundNumber)
          ? await runCampaignReviewer({
              cwd: input.cwd,
              campaignSpec,
              baseSpec,
              roundNumber,
              pendingPackageRoot: campaignPaths.pendingCurrentRoot,
              runTracePath: roundPaths.runTraceDigestPath,
              explorationTreePath: campaignPaths.explorationTreePath,
              workingMemoryPath: campaignPaths.campaignWorkingMemoryPath,
              routingControlPath: campaignPaths.campaignRoutingControlPath,
              roundPaths,
              runtimeScope: roundRuntimeScope,
              onActivation: activateCampaignRound,
            })
          : undefined
        if (reviewerSuggestion) {
          await writeLongTaskCampaignReviewerSuggestion(campaignPaths, reviewerSuggestion)
          const currentRoutingControl = await readLongTaskCampaignRoutingControl(campaignPaths)
          await writeLongTaskCampaignRoutingControl(
            campaignPaths,
            buildRoutingControl({
              previous: currentRoutingControl,
              tree: await readLongTaskCampaignExplorationTree(campaignPaths),
              digest: harvested.runTraceDigest,
              reviewerSuggestion,
              roundNumber,
            }),
          )
        }

        const finalAcceptance =
          reviewerSuggestion?.readyForFinalAcceptance === true
            ? await runCampaignFinalAcceptance({
                cwd: input.cwd,
                campaignID,
                campaignSpec,
                baseSpec,
                roundNumber,
                sourceRunID: runResult.runID,
                pendingPackageRoot: campaignPaths.pendingCurrentRoot,
                runTracePath: roundPaths.runTraceJsonPath,
                reviewerSuggestionPath: roundPaths.reviewerSuggestionPath,
                roundPaths,
                runtimeScope: roundRuntimeScope,
                onActivation: activateCampaignRound,
              })
            : undefined

        const nextStatus =
          finalAcceptance?.passed === true
            ? "verified_success"
            : roundNumber >= campaignSpec.maxRounds
              ? "round_limit_reached"
              : "running"

        const state: LongTaskCampaignState = {
          ...initialState,
          currentRound: roundNumber,
          status: nextStatus,
          updatedAt: nowISO(),
          lastRunID: runResult.runID,
          lastSummary: finalAcceptance?.summary ?? harvested.roundRecord.summary,
          lastRoundSummaryPath: harvested.roundRecord.roundSummaryPath,
        }
        await writeLongTaskCampaignState(campaignPaths, state)

        if (nextStatus === "verified_success") {
          return {
            campaignID,
            campaignDir: campaignPaths.root,
            status: nextStatus,
            roundsCompleted: roundNumber,
            lastRunID: runResult.runID,
            lessonsPath: campaignPaths.campaignLessonsPath,
            roundSummaryPath: harvested.roundRecord.roundSummaryPath,
          }
        }
      } finally {
        await cleanupRuntimeProcessScope(roundRuntimeScope)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failureState: LongTaskCampaignState = {
      ...initialState,
      currentRound: lastRoundNumber,
      status: "failed",
      updatedAt: nowISO(),
      lastRunID,
      lastSummary: `Campaign aborted unexpectedly: ${short(message, 240)}`,
      lastRoundSummaryPath,
    }
    await writeLongTaskCampaignState(campaignPaths, failureState)
    return {
      campaignID,
      campaignDir: campaignPaths.root,
      status: failureState.status,
      roundsCompleted: history.length,
      lastRunID: failureState.lastRunID,
      lessonsPath: campaignPaths.campaignLessonsPath,
      roundSummaryPath: failureState.lastRoundSummaryPath,
    }
  }

  const finalState: LongTaskCampaignState = {
    ...initialState,
    currentRound: campaignSpec.maxRounds,
    status: "round_limit_reached",
    updatedAt: nowISO(),
    lastRunID: history[history.length - 1]?.sourceRunID,
    lastSummary: history[history.length - 1]?.summary,
    lastRoundSummaryPath: history[history.length - 1]?.roundSummaryPath,
  }
  await writeLongTaskCampaignState(campaignPaths, finalState)

  return {
    campaignID,
    campaignDir: campaignPaths.root,
    status: finalState.status,
    roundsCompleted: campaignSpec.maxRounds,
    lastRunID: finalState.lastRunID,
    lessonsPath: campaignPaths.campaignLessonsPath,
    roundSummaryPath: finalState.lastRoundSummaryPath,
  }
}
