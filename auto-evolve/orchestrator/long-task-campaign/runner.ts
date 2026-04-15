import path from "node:path"
import { randomUUID } from "node:crypto"
import { cp, lstat, readdir, rm } from "node:fs/promises"
import {
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
import {
  readOperationalContext,
  resolveExistingLongTaskRun,
} from "../long-task/repository"
import { loadLongTaskSpec } from "../long-task/spec"
import type {
  LongTaskBudgets,
  LongTaskOperationalContextItem,
  LongTaskRunStatus,
  LongTaskSpec,
  LongTaskValidatorResult,
  LongTaskWorkUnit,
} from "../long-task/contract"
import {
  DEFAULT_LONG_TASK_CAMPAIGN_CARRYOVER,
  type LongTaskCampaignExplorationNode,
  type LongTaskCampaignOperationalMemoryRecord,
  type LongTaskCampaignReviewSuggestion,
  type LongTaskCampaignRoundRecord,
  type LongTaskCampaignSeedTarget,
  type LongTaskCampaignSpec,
  type LongTaskCampaignState,
  type LongTaskCampaignRunTrace,
  type LongTaskCampaignRunTraceAttemptRecord,
  type LongTaskCampaignRunTraceCommandRecord,
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
  writeLongTaskCampaignLessons,
  writeLongTaskCampaignExplorationTree,
  writeLongTaskCampaignOperationalMemory,
  writeLongTaskCampaignReviewerSuggestion,
  writeLongTaskCampaignSeedContext,
  writeLongTaskCampaignState,
  writeLongTaskCampaignWorkerSuggestion,
} from "./repository"
import { loadLongTaskCampaignSpec } from "./spec"
import { buildCampaignLeadPrompt, buildCampaignReviewerPrompt, buildCampaignWorkerPrompt } from "./prompts"
import { loadConfig } from "../schema"
import { resolveModelSelection } from "../model-selection"
import { runOpencodeTask } from "../opencode"
import { writeTaskArtifacts } from "../task-artifacts"
import type { ExecutionSpec, ModelPhase } from "../schema"

function nowISO() {
  return new Date().toISOString()
}

function short(text: string, limit = 220) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit - 3)}...`
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
    status:
      existing.status === "confirmed" || incoming.status === "confirmed" ? "confirmed" : "candidate",
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
  return input.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
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
    !normalized.endsWith("campaign-failure-lessons.md") &&
    !normalized.endsWith("campaign-seed-context.md") &&
    !normalized.endsWith("campaign-operational-memory.json")
  )
}

function collectStaticBaseContextPaths(baseSpec: LongTaskSpec) {
  return uniqueStrings((baseSpec.initialExpertContextPaths ?? []).filter(isStaticBaseContextPath))
}

function defaultCampaignWorkerRoles(): LongTaskCampaignWorkerRole[] {
  return [
    "success_synthesizer",
    "failure_synthesizer",
    "forbidden_path_synthesizer",
    "exploration_tree_synthesizer",
  ]
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
    if (event.type !== "tool_use" || typeof event.part !== "object" || !event.part || Array.isArray(event.part)) continue
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
            strength:
              item.strength === 2 || item.strength === 3
                ? item.strength
                : 1,
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
              ? item.doNotRepeat.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
              : [],
            nextAttemptStrategy: Array.isArray(item.nextAttemptStrategy)
              ? item.nextAttemptStrategy.filter(
                  (value): value is string => typeof value === "string" && value.trim().length > 0,
                )
              : [],
            evidenceRefs: Array.isArray(item.evidenceRefs)
              ? item.evidenceRefs.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
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
    keyFailurePaths: failures
      .map((item) => short(String(item.mismatchSummary ?? ""), 220))
      .slice(-12),
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
  return spec.validators.filter((validator) => validator.required !== false && validator.placement === "completion_only")
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
    await writeTextFile(
      changeLogPath,
      `<!-- auto-evolve-role: change_log -->\n# Change Log\n\n${line}\n`,
    )
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
        parts.push(`  causes: ${suspectedCauses.slice(0, 3).map((value) => short(value, 120)).join(" | ")}`)
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
        ? item.nextAttemptStrategy.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
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
  }
}

function buildGeneratedRoundSpec(input: {
  baseSpec: LongTaskSpec
  campaignSpec: LongTaskCampaignSpec
  roundNumber: number
  carryoverContextPaths: string[]
  pendingPackageRoot: string
  explorationTreePath: string
}): LongTaskSpec {
  const staticBaseContext = collectStaticBaseContextPaths(input.baseSpec)
  return {
    ...input.baseSpec,
    title: `${input.campaignSpec.title}-${roundID(input.roundNumber)}`,
    disableCompletionValidators: true,
    initialExpertContextPaths: uniqueStrings([
      input.pendingPackageRoot,
      input.explorationTreePath,
      ...input.carryoverContextPaths,
      ...staticBaseContext,
    ]),
    initialGraph: input.baseSpec.initialGraph
      ? {
          ...input.baseSpec.initialGraph,
          completion_validator_ids: [],
        }
      : undefined,
    campaignPendingPackageRoot: input.pendingPackageRoot,
    campaignExplorationTreePath: input.explorationTreePath,
    budgets: applyBudgetOverrides(input.baseSpec.budgets, input.campaignSpec.roundBudgetOverrides),
    notes: [
      input.baseSpec.notes,
      `campaign_mode=${input.campaignSpec.mode}`,
      `campaign_round=${input.roundNumber}/${input.campaignSpec.maxRounds}`,
      "This round is generated by the long-task campaign controller. Every round must leave durable learning artifacts and promote stable operational context for later rounds.",
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
      typeof input.parsed?.ready_for_final_acceptance === "boolean"
        ? input.parsed.ready_for_final_acceptance
        : false,
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
  const paths: string[] = []

  if (await pathExists(input.campaignPaths.pendingCurrentRoot)) {
    paths.push(input.campaignPaths.pendingCurrentRoot)
  }
  if (await pathExists(input.campaignPaths.explorationTreePath)) {
    paths.push(input.campaignPaths.explorationTreePath)
  }

  return uniqueStrings(paths)
}

async function readLatestReviewerSuggestionPath(campaignPaths: ReturnType<typeof longTaskCampaignPaths>) {
  if (!(await pathExists(campaignPaths.campaignReviewSuggestionsPath))) return undefined
  const raw = (await readTextFile(campaignPaths.campaignReviewSuggestionsPath)).trim()
  if (!raw) return undefined
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
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

async function runCampaignWorkers(input: {
  cwd: string
  campaignID: string
  campaignSpec: LongTaskCampaignSpec
  baseSpec: LongTaskSpec
  roundNumber: number
  runTracePath: string
  pendingPackageRoot: string
  explorationTreePath: string
  reviewerSuggestionPath?: string
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
}) {
  const workerRoles = defaultCampaignWorkerRoles()
  const suggestions = await Promise.all(
    workerRoles.map(async (role) => {
      const stageDir = path.join(input.roundPaths.workersRoot, role)
      const prompt = buildCampaignWorkerPrompt({
        title: input.campaignSpec.title,
      roundNumber: input.roundNumber,
      role,
      runTracePath: input.runTracePath,
      pendingPackageRoot: input.pendingPackageRoot,
      explorationTreePath: input.explorationTreePath,
      reviewerSuggestionPath: input.reviewerSuggestionPath,
      campaignMemoryPaths: [
        input.campaignPaths.campaignOperationalMemoryPath,
        input.campaignPaths.campaignSeedContextPath,
        input.campaignPaths.campaignLessonsPath,
      ].filter((item) => item),
    })
      const result = await runCampaignSuggestionTask({
        cwd: input.cwd,
        baseSpec: input.baseSpec,
        title: `Campaign Worker ${role} ${roundID(input.roundNumber)}`,
        prompt,
        selectionPhase: "planning",
        execution: input.baseSpec.planning ?? input.baseSpec.execution,
        referencePaths: [
          input.runTracePath,
          input.pendingPackageRoot,
        input.explorationTreePath,
        input.campaignPaths.campaignOperationalMemoryPath,
        input.campaignPaths.campaignSeedContextPath,
        input.campaignPaths.campaignLessonsPath,
        ...(input.reviewerSuggestionPath ? [input.reviewerSuggestionPath] : []),
      ],
      permissionReadPaths: [
        input.runTracePath,
        input.pendingPackageRoot,
        input.explorationTreePath,
        input.campaignPaths.campaignOperationalMemoryPath,
        input.campaignPaths.campaignSeedContextPath,
        input.campaignPaths.campaignLessonsPath,
        ...(input.reviewerSuggestionPath ? [input.reviewerSuggestionPath] : []),
      ],
        stageDir,
        phase: "campaign_worker",
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
  previousPendingPackageRoot: string
  nextPendingPackageRoot: string
  previousExplorationTreePath: string
  nextExplorationTreePath: string
  workerSuggestions: LongTaskCampaignWorkerSuggestion[]
  reviewerSuggestionPath?: string
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
}) {
  const workerSuggestionPaths = input.workerSuggestions
    .map((item) => item.responsePath)
    .filter((item): item is string => Boolean(item))
  const stageDir = path.join(input.roundPaths.root, "campaign-lead")
  const prompt = buildCampaignLeadPrompt({
    title: input.campaignSpec.title,
    roundNumber: input.roundNumber,
    runTracePath: input.runTracePath,
    previousPendingPackageRoot: input.previousPendingPackageRoot,
    nextPendingPackageRoot: input.nextPendingPackageRoot,
    previousExplorationTreePath: input.previousExplorationTreePath,
    nextExplorationTreePath: input.nextExplorationTreePath,
    workerSuggestionPaths,
    reviewerSuggestionPath: input.reviewerSuggestionPath,
    campaignMemoryPaths: [
      input.campaignPaths.campaignOperationalMemoryPath,
      input.campaignPaths.campaignSeedContextPath,
      input.campaignPaths.campaignLessonsPath,
    ],
  })
  return runCampaignSuggestionTask({
    cwd: input.cwd,
    baseSpec: input.baseSpec,
    title: `Campaign Lead ${roundID(input.roundNumber)}`,
    prompt,
    selectionPhase: "solve",
    execution: input.baseSpec.execution,
    referencePaths: [
      input.runTracePath,
      input.previousPendingPackageRoot,
      input.previousExplorationTreePath,
      ...workerSuggestionPaths,
      input.campaignPaths.campaignOperationalMemoryPath,
      input.campaignPaths.campaignSeedContextPath,
      input.campaignPaths.campaignLessonsPath,
      ...(input.reviewerSuggestionPath ? [input.reviewerSuggestionPath] : []),
    ],
    permissionReadPaths: [
      input.runTracePath,
      input.previousPendingPackageRoot,
      input.previousExplorationTreePath,
      ...workerSuggestionPaths,
      input.campaignPaths.campaignOperationalMemoryPath,
      input.campaignPaths.campaignSeedContextPath,
      input.campaignPaths.campaignLessonsPath,
      ...(input.reviewerSuggestionPath ? [input.reviewerSuggestionPath] : []),
    ],
    permissionEditPaths: [
      input.nextPendingPackageRoot,
      input.nextExplorationTreePath,
    ],
    stageDir,
    phase: "campaign_lead",
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
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
}) {
  const stageDir = input.roundPaths.reviewerRoot
  const prompt = buildCampaignReviewerPrompt({
    title: input.campaignSpec.title,
    roundNumber: input.roundNumber,
    pendingPackageRoot: input.pendingPackageRoot,
    runTracePath: input.runTracePath,
    explorationTreePath: input.explorationTreePath,
  })
  const result = await runCampaignSuggestionTask({
    cwd: input.cwd,
    baseSpec: input.baseSpec,
    title: `Campaign Reviewer ${roundID(input.roundNumber)}`,
    prompt,
    selectionPhase: "validation",
    execution: input.baseSpec.validation ?? input.baseSpec.execution,
    referencePaths: [input.pendingPackageRoot, input.runTracePath, input.explorationTreePath],
    permissionReadPaths: [input.pendingPackageRoot, input.runTracePath, input.explorationTreePath],
    stageDir,
    phase: "campaign_review",
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
    await copyExperienceWorkspaceRoot(input.roundPaths.pendingPackageSnapshotRoot, input.campaignPaths.pendingCurrentRoot)
  }
  const explorationTree = (await pathExists(input.roundPaths.explorationTreeDraftPath))
    ? await readJsonFile<LongTaskCampaignExplorationNode[]>(input.roundPaths.explorationTreeDraftPath)
    : []
  await writeLongTaskCampaignExplorationTree(input.campaignPaths, explorationTree)
}

export async function runLongTaskCampaign(input: { cwd: string; specPath: string }) {
  const { spec: campaignSpec } = await loadLongTaskCampaignSpec(input.specPath)
  const { spec: baseSpec } = await loadLongTaskSpec(campaignSpec.baseSpecPath)
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
    status: "running",
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

  for (let roundNumber = 1; roundNumber <= campaignSpec.maxRounds; roundNumber += 1) {
    const roundPaths = longTaskCampaignRoundPaths(campaignPaths, roundNumber)
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

    const carryoverContextPaths = await collectCarryoverContext({
      baseSpec,
      campaignSpec,
      campaignPaths,
      history,
    })
    const generatedSpec = buildGeneratedRoundSpec({
      baseSpec,
      campaignSpec,
      roundNumber,
      carryoverContextPaths,
      pendingPackageRoot: campaignPaths.pendingCurrentRoot,
      explorationTreePath: campaignPaths.explorationTreePath,
    })
    await writeJsonFile(roundPaths.generatedSpecPath, generatedSpec)

    await writeLongTaskCampaignState(campaignPaths, {
      ...initialState,
      currentRound: roundNumber,
      status: "running",
      updatedAt: nowISO(),
      lastSummary: history[history.length - 1]?.summary,
      lastRunID: history[history.length - 1]?.sourceRunID,
      lastRoundSummaryPath: history[history.length - 1]?.roundSummaryPath,
    })

    const runResult = await runLongTask({
      cwd: input.cwd,
      specPath: roundPaths.generatedSpecPath,
    })

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

    const allFailures = await readJsonLinesIfExists<Record<string, unknown>>(campaignPaths.aggregatedFailurePacketsPath)
    const allRetryLessons = await readJsonLinesIfExists<Record<string, unknown>>(campaignPaths.aggregatedRetryLessonsPath)
    const allLearningUnits = await readJsonLinesIfExists<Record<string, unknown>>(campaignPaths.aggregatedLearningUnitsPath)
    const campaignLessons = buildCampaignLessonsMarkdown({
      title: campaignSpec.title,
      latestRound: roundNumber,
      records: history,
      failures: allFailures,
      retryLessons: allRetryLessons,
      learningUnits: allLearningUnits,
    })
    await writeLongTaskCampaignLessons(campaignPaths, campaignLessons)
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
          pendingPackageRoot: campaignPaths.pendingCurrentRoot,
          explorationTreePath: campaignPaths.explorationTreePath,
          reviewerSuggestionPath: latestReviewerSuggestionPath,
          campaignPaths,
          roundPaths,
        })
      : []

    await runCampaignLead({
      cwd: input.cwd,
      campaignSpec,
      baseSpec,
      roundNumber,
      runTracePath: roundPaths.runTraceJsonPath,
      previousPendingPackageRoot: campaignPaths.pendingCurrentRoot,
      nextPendingPackageRoot: roundPaths.pendingPackageSnapshotRoot,
      previousExplorationTreePath: campaignPaths.explorationTreePath,
      nextExplorationTreePath: roundPaths.explorationTreeDraftPath,
      workerSuggestions,
      reviewerSuggestionPath: latestReviewerSuggestionPath,
      campaignPaths,
      roundPaths,
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
          runTracePath: roundPaths.runTraceJsonPath,
          explorationTreePath: campaignPaths.explorationTreePath,
          roundPaths,
        })
      : undefined
    if (reviewerSuggestion) {
      await writeLongTaskCampaignReviewerSuggestion(campaignPaths, reviewerSuggestion)
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
