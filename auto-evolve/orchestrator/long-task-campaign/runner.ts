import path from "node:path"
import { cp, lstat, rm } from "node:fs/promises"
import {
  ensureDirectory,
  pathExists,
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
import { loadLongTaskSpec } from "../long-task/spec"
import type { LongTaskBudgets, LongTaskRunStatus, LongTaskSpec } from "../long-task/contract"
import {
  DEFAULT_LONG_TASK_CAMPAIGN_CARRYOVER,
  type LongTaskCampaignRoundRecord,
  type LongTaskCampaignSeedTarget,
  type LongTaskCampaignSpec,
  type LongTaskCampaignState,
} from "./contract"
import {
  appendLinesToAggregate,
  appendLongTaskCampaignHistory,
  createLongTaskCampaignID,
  initializeLongTaskCampaign,
  longTaskCampaignPaths,
  longTaskCampaignRoundPaths,
  writeLongTaskCampaignLessons,
  writeLongTaskCampaignState,
} from "./repository"
import { loadLongTaskCampaignSpec } from "./spec"

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
  campaignSpec: LongTaskCampaignSpec
  roundNumber: number
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
  runResult: Awaited<ReturnType<typeof runLongTask>>
  seedTargets: LongTaskCampaignSeedTarget[]
}) {
  const runDir = input.runResult.runDir
  const failurePacketsPath = path.join(runDir, "failure_packets.jsonl")
  const retryLessonsPath = path.join(runDir, "retry_lessons.jsonl")
  const learningUnitsPath = path.join(runDir, "learning_units.jsonl")

  const failurePackets = await readJsonLinesIfExists<Record<string, unknown>>(failurePacketsPath)
  const retryLessons = await readJsonLinesIfExists<Record<string, unknown>>(retryLessonsPath)
  const learningUnits = await readJsonLinesIfExists<Record<string, unknown>>(learningUnitsPath)

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
  }
}

function buildGeneratedRoundSpec(input: {
  baseSpec: LongTaskSpec
  campaignSpec: LongTaskCampaignSpec
  roundNumber: number
  carryoverContextPaths: string[]
}): LongTaskSpec {
  return {
    ...input.baseSpec,
    title: `${input.campaignSpec.title}-${roundID(input.roundNumber)}`,
    initialExpertContextPaths: uniqueStrings([
      ...input.carryoverContextPaths,
      ...(input.baseSpec.initialExpertContextPaths ?? []),
    ]),
    budgets: applyBudgetOverrides(input.baseSpec.budgets, input.campaignSpec.roundBudgetOverrides),
    notes: [
      input.baseSpec.notes,
      `campaign_mode=${input.campaignSpec.mode}`,
      `campaign_round=${input.roundNumber}/${input.campaignSpec.maxRounds}`,
      "This round is generated by the long-task campaign controller. Every round must leave durable learning artifacts.",
    ]
      .filter(Boolean)
      .join(" "),
  }
}

async function prepareCampaignRoundState(input: {
  baseSpec: LongTaskSpec
  campaignSpec: LongTaskCampaignSpec
}) {
  await clearNonSeedEditablePaths(input.baseSpec, input.campaignSpec.seedTargets)
}

async function collectCarryoverContext(input: {
  baseSpec: LongTaskSpec
  campaignSpec: LongTaskCampaignSpec
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  history: LongTaskCampaignRoundRecord[]
}) {
  const carryover = {
    ...DEFAULT_LONG_TASK_CAMPAIGN_CARRYOVER,
    ...(input.campaignSpec.carryover ?? {}),
  }
  const paths: string[] = []

  const latestRound = input.history[input.history.length - 1]
  if (latestRound) {
    paths.push(...latestRound.snapshotPaths.map((item) => item.snapshotPath))
  }

  if (carryover.includeFailurePackets && (await pathExists(input.campaignPaths.aggregatedFailurePacketsPath))) {
    paths.push(input.campaignPaths.aggregatedFailurePacketsPath)
  }
  if (carryover.includeRetryLessons && (await pathExists(input.campaignPaths.aggregatedRetryLessonsPath))) {
    paths.push(input.campaignPaths.aggregatedRetryLessonsPath)
  }
  if (carryover.includeLearningUnits && (await pathExists(input.campaignPaths.aggregatedLearningUnitsPath))) {
    paths.push(input.campaignPaths.aggregatedLearningUnitsPath)
  }
  if (await pathExists(input.campaignPaths.campaignLessonsPath)) {
    paths.push(input.campaignPaths.campaignLessonsPath)
  }
  if (carryover.includeRoundSummaries) {
    const recent = input.history.slice(-carryover.recentRoundSummaryCount)
    paths.push(...recent.map((item) => item.roundSummaryPath))
  }

  return uniqueStrings(paths)
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

  const history: LongTaskCampaignRoundRecord[] = []

  for (let roundNumber = 1; roundNumber <= campaignSpec.maxRounds; roundNumber += 1) {
    const roundPaths = longTaskCampaignRoundPaths(campaignPaths, roundNumber)
    await ensureDirectory(roundPaths.root)
    await ensureDirectory(roundPaths.harvestedRoot)
    await ensureDirectory(roundPaths.snapshotsRoot)

    await prepareCampaignRoundState({
      baseSpec,
      campaignSpec,
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
      campaignSpec,
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

    if (campaignSpec.lessonsMirror) {
      await syncLessonsMirror({
        lessonsContent: campaignLessons,
        workspaceTargetPath: campaignSpec.lessonsMirror.workspaceTargetPath,
        lessonsRelativePath: campaignSpec.lessonsMirror.relativePath,
        addManifestPointer: campaignSpec.lessonsMirror.addManifestPointer ?? true,
        roundRecord: harvested.roundRecord,
      })
    }

    const nextStatus =
      runResult.status === "verified_success"
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
      lastSummary: harvested.roundRecord.summary,
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
