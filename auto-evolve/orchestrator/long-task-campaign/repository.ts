import path from "node:path"
import process from "node:process"
import { appendFile, readFile } from "node:fs/promises"
import { autoEvolvePath, ensureDirectory, readJsonFile, writeJsonFile, writeTextFile } from "../fs"
import type {
  LongTaskCampaignDispatchTicketDocument,
  LongTaskCampaignExplorationTreeDocument,
  LongTaskCampaignRoutingControl,
  LongTaskCampaignWorkingMemoryDocument,
  LongTaskCampaignOperationalMemoryRecord,
  LongTaskCampaignRoundRecord,
  LongTaskCampaignReviewSuggestion,
  LongTaskCampaignState,
  LongTaskCampaignWorkerSuggestion,
} from "./contract"

export interface LongTaskCampaignPaths {
  root: string
  campaignStatePath: string
  historyPath: string
  acceptanceExperiencePath: string
  acceptanceExperienceJsonlPath: string
  dispatchTicketsPath: string
  aggregatedFailurePacketsPath: string
  aggregatedRetryLessonsPath: string
  aggregatedLearningUnitsPath: string
  carryoverFailurePacketsPath: string
  carryoverRetryLessonsPath: string
  carryoverLearningUnitsPath: string
  campaignOperationalMemoryPath: string
  campaignWorkingMemoryPath: string
  campaignRoutingControlPath: string
  campaignSeedContextPath: string
  campaignLessonsPath: string
  pendingPackageRoot: string
  pendingCurrentRoot: string
  explorationTreePath: string
  campaignReviewSuggestionsPath: string
  runTracesRoot: string
  roundsRoot: string
}

export interface LongTaskCampaignRoundPaths {
  root: string
  generatedSpecPath: string
  roundSummaryPath: string
  runTraceJsonPath: string
  runTraceDigestPath: string
  runTraceMarkdownPath: string
  harvestedRoot: string
  snapshotsRoot: string
  pendingPackageSnapshotRoot: string
  workersRoot: string
  reviewerRoot: string
  reviewerSuggestionPath: string
  finalAcceptanceRoot: string
  finalAcceptanceResultPath: string
  explorationTreeDraftPath: string
  routingControlDraftPath: string
}

function detectOwnerCommandHint() {
  const argv = process.argv.map((item) => item.toLowerCase())
  if (argv.some((item) => item.includes("run-long-task-campaign"))) return "run-long-task-campaign"
  if (argv.some((item) => item.includes("run-long-task"))) return "run-long-task"
  return undefined
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

export function createLongTaskCampaignID(title: string) {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`
  return `${stamp}-${slugify(title) || "long-task-campaign"}`
}

export function longTaskCampaignPaths(cwd: string, campaignID: string): LongTaskCampaignPaths {
  const root = autoEvolvePath(cwd, "runtime-state", "long-task-campaigns", campaignID)
  return {
    root,
    campaignStatePath: path.join(root, "campaign.json"),
    historyPath: path.join(root, "history.jsonl"),
    acceptanceExperienceJsonlPath: path.join(root, "acceptance-experience.jsonl"),
    dispatchTicketsPath: path.join(root, "dispatch-tickets.json"),
    acceptanceExperiencePath: path.join(root, "acceptance-experience.md"),
    aggregatedFailurePacketsPath: path.join(root, "aggregated-failure-packets.jsonl"),
    aggregatedRetryLessonsPath: path.join(root, "aggregated-retry-lessons.jsonl"),
    aggregatedLearningUnitsPath: path.join(root, "aggregated-learning-units.jsonl"),
    carryoverFailurePacketsPath: path.join(root, "carryover-failure-packets.md"),
    carryoverRetryLessonsPath: path.join(root, "carryover-retry-lessons.md"),
    carryoverLearningUnitsPath: path.join(root, "carryover-learning-units.md"),
    campaignOperationalMemoryPath: path.join(root, "campaign-operational-memory.json"),
    campaignWorkingMemoryPath: path.join(root, "campaign-working-memory.json"),
    campaignRoutingControlPath: path.join(root, "routing-control.json"),
    campaignSeedContextPath: path.join(root, "campaign-seed-context.md"),
    campaignLessonsPath: path.join(root, "campaign-failure-lessons.md"),
    pendingPackageRoot: path.join(root, "pending-expert-package"),
    pendingCurrentRoot: path.join(root, "pending-expert-package", "current"),
    explorationTreePath: path.join(root, "exploration-tree.json"),
    campaignReviewSuggestionsPath: path.join(root, "review-suggestions.jsonl"),
    runTracesRoot: path.join(root, "run-traces"),
    roundsRoot: path.join(root, "rounds"),
  }
}

export function longTaskCampaignRoundPaths(
  paths: LongTaskCampaignPaths,
  roundNumber: number,
): LongTaskCampaignRoundPaths {
  const roundID = `round-${String(roundNumber).padStart(3, "0")}`
  const root = path.join(paths.roundsRoot, roundID)
  return {
    root,
    generatedSpecPath: path.join(root, "generated-spec.json"),
    roundSummaryPath: path.join(root, "round-summary.md"),
    runTraceJsonPath: path.join(root, "run-trace.json"),
    runTraceDigestPath: path.join(root, "run-trace-digest.json"),
    runTraceMarkdownPath: path.join(root, "run-trace.md"),
    harvestedRoot: path.join(root, "harvested"),
    snapshotsRoot: path.join(root, "snapshots"),
    pendingPackageSnapshotRoot: path.join(root, "pending-package"),
    workersRoot: path.join(root, "workers"),
    reviewerRoot: path.join(root, "reviewer"),
    reviewerSuggestionPath: path.join(root, "reviewer", "review-suggestion.json"),
    finalAcceptanceRoot: path.join(root, "final-acceptance"),
    finalAcceptanceResultPath: path.join(root, "final-acceptance", "result.json"),
    explorationTreeDraftPath: path.join(root, "exploration-tree.json"),
    routingControlDraftPath: path.join(root, "routing-control.json"),
  }
}

export async function initializeLongTaskCampaign(paths: LongTaskCampaignPaths, state: LongTaskCampaignState) {
  await ensureDirectory(paths.root)
  await ensureDirectory(paths.roundsRoot)
  await ensureDirectory(paths.pendingPackageRoot)
  await ensureDirectory(paths.runTracesRoot)
  await writeLongTaskCampaignState(paths, state)
  await writeTextFile(
    paths.acceptanceExperiencePath,
    "<!-- auto-evolve-role: acceptance_experience -->\n# Acceptance Experience\n\n- no acceptance records yet\n",
  )
  await writeTextFile(paths.acceptanceExperienceJsonlPath, "")
  await writeJsonFile(paths.campaignOperationalMemoryPath, [])
  await writeJsonFile(paths.campaignWorkingMemoryPath, {
    updatedAt: state.createdAt,
    updatedThroughRound: 0,
    items: [],
  } satisfies LongTaskCampaignWorkingMemoryDocument)
  await writeJsonFile(paths.campaignRoutingControlPath, {
    updatedAt: state.createdAt,
    updatedThroughRound: 0,
    currentPhase: "bootstrap",
    requiredNextRegions: [],
    forbiddenUnits: [],
    forbiddenRegions: [],
    prerequisites: [],
    blockedBy: [],
    readyForFinalAcceptance: false,
    summary: "Campaign has not completed the first round yet.",
    evidenceRefs: [],
    notes: [],
  } satisfies LongTaskCampaignRoutingControl)
  await writeTextFile(paths.campaignSeedContextPath, "# Campaign Seed Context\n\n- no promoted cross-run memory yet\n")
  await writeJsonFile(paths.explorationTreePath, {
    updatedAt: state.createdAt,
    updatedThroughRound: 0,
    currentPhase: "bootstrap",
    globalSummary: "No exploration progress yet.",
    branchSummaries: [
      { branch: "solution", summary: "No solution-path evidence yet.", focusRegions: [] },
      { branch: "anti_drift", summary: "No anti-drift evidence yet.", focusRegions: [] },
      { branch: "acceptance", summary: "No acceptance evidence yet.", focusRegions: [] },
    ],
    rolePositions: [
      { role: "planner", branch: "solution", focusRegions: [], note: "Read full tree, then plan from solution branch." },
      { role: "executor", branch: "solution", focusRegions: [], note: "Read full tree, execute with solution focus." },
      { role: "campaign_worker", branch: "solution", focusRegions: [], note: "Read full tree, then follow role-specific focus." },
      { role: "campaign_lead", branch: "acceptance", focusRegions: [], note: "Read full tree; only lead may rewrite the tree." },
      { role: "campaign_reviewer", branch: "acceptance", focusRegions: [], note: "Read full tree and verify readiness alignment." },
      { role: "blank_agent", branch: "anti_drift", focusRegions: [], note: "Read full tree and avoid anti-drift failures." },
    ],
    frontierRegions: [],
    requiredNextRegions: [],
    forbiddenRepeatRegions: [],
    nodes: [],
  } satisfies LongTaskCampaignExplorationTreeDocument)
  await writeJsonFile(paths.dispatchTicketsPath, {
    updatedAt: state.createdAt,
    updatedThroughRound: 0,
    tickets: [],
  } satisfies LongTaskCampaignDispatchTicketDocument)
  await writeTextFile(paths.campaignReviewSuggestionsPath, "")
}

export async function writeLongTaskCampaignState(paths: LongTaskCampaignPaths, state: LongTaskCampaignState) {
  const heartbeatAt = new Date().toISOString()
  await writeJsonFile(paths.campaignStatePath, {
    ...state,
    ownerPID: state.ownerPID ?? process.pid,
    ownerCommandHint: state.ownerCommandHint ?? detectOwnerCommandHint(),
    heartbeatAt,
    updatedAt: heartbeatAt,
  })
}

export async function readLongTaskCampaignState(paths: LongTaskCampaignPaths) {
  return readJsonFile<LongTaskCampaignState>(paths.campaignStatePath)
}

export async function appendLongTaskCampaignHistory(paths: LongTaskCampaignPaths, record: LongTaskCampaignRoundRecord) {
  await ensureDirectory(path.dirname(paths.historyPath))
  await appendFile(paths.historyPath, JSON.stringify(record) + "\n", "utf8")
}

export async function rewriteLongTaskCampaignHistoryRecord(
  paths: LongTaskCampaignPaths,
  roundNumber: number,
  updater: (record: LongTaskCampaignRoundRecord) => LongTaskCampaignRoundRecord,
) {
  await ensureDirectory(path.dirname(paths.historyPath))
  const raw = await readFile(paths.historyPath, "utf8").catch((error: unknown) => {
    const code =
      typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : undefined
    if (code === "ENOENT") return ""
    throw error
  })
  if (!raw.trim()) return false
  const records = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LongTaskCampaignRoundRecord)
  const index = records.findIndex((record) => record.roundNumber === roundNumber)
  if (index < 0) return false
  records[index] = updater(records[index])
  await writeTextFile(paths.historyPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n")
  return true
}

export async function appendLinesToAggregate(target: string, lines: string[]) {
  if (!lines.length) return
  await ensureDirectory(path.dirname(target))
  await appendFile(
    target,
    lines
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n") + "\n",
    "utf8",
  )
}

export async function writeLongTaskCampaignLessons(paths: LongTaskCampaignPaths, content: string) {
  await writeTextFile(paths.campaignLessonsPath, content)
}

export async function readLongTaskCampaignOperationalMemory(paths: LongTaskCampaignPaths) {
  return readJsonFile<LongTaskCampaignOperationalMemoryRecord[]>(paths.campaignOperationalMemoryPath)
}

export async function writeLongTaskCampaignOperationalMemory(
  paths: LongTaskCampaignPaths,
  records: LongTaskCampaignOperationalMemoryRecord[],
) {
  await writeJsonFile(paths.campaignOperationalMemoryPath, records)
}

export async function readLongTaskCampaignWorkingMemory(paths: LongTaskCampaignPaths) {
  return readJsonFile<LongTaskCampaignWorkingMemoryDocument>(paths.campaignWorkingMemoryPath)
}

export async function writeLongTaskCampaignWorkingMemory(
  paths: LongTaskCampaignPaths,
  document: LongTaskCampaignWorkingMemoryDocument,
) {
  await writeJsonFile(paths.campaignWorkingMemoryPath, document)
}

export async function readLongTaskCampaignRoutingControl(paths: LongTaskCampaignPaths) {
  return readJsonFile<LongTaskCampaignRoutingControl>(paths.campaignRoutingControlPath)
}

export async function writeLongTaskCampaignRoutingControl(
  paths: LongTaskCampaignPaths,
  control: LongTaskCampaignRoutingControl,
) {
  await writeJsonFile(paths.campaignRoutingControlPath, control)
}

export async function writeLongTaskCampaignSeedContext(paths: LongTaskCampaignPaths, content: string) {
  await writeTextFile(paths.campaignSeedContextPath, content)
}

export async function writeLongTaskCampaignExplorationTree(
  paths: LongTaskCampaignPaths,
  document: LongTaskCampaignExplorationTreeDocument,
) {
  await writeJsonFile(paths.explorationTreePath, document)
}

export async function readLongTaskCampaignExplorationTree(paths: LongTaskCampaignPaths) {
  return readJsonFile<LongTaskCampaignExplorationTreeDocument>(paths.explorationTreePath)
}

export async function writeLongTaskCampaignReviewerSuggestion(
  paths: LongTaskCampaignPaths,
  suggestion: LongTaskCampaignReviewSuggestion,
) {
  await appendFile(paths.campaignReviewSuggestionsPath, JSON.stringify(suggestion) + "\n", "utf8")
}

export async function writeLongTaskCampaignWorkerSuggestion(
  target: string,
  suggestion: LongTaskCampaignWorkerSuggestion,
) {
  await ensureDirectory(path.dirname(target))
  await writeJsonFile(target, suggestion)
}
