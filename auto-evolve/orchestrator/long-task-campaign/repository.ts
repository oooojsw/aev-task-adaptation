import path from "node:path"
import { appendFile } from "node:fs/promises"
import { autoEvolvePath, ensureDirectory, readJsonFile, writeJsonFile, writeTextFile } from "../fs"
import type {
  LongTaskCampaignExplorationNode,
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
  aggregatedFailurePacketsPath: string
  aggregatedRetryLessonsPath: string
  aggregatedLearningUnitsPath: string
  campaignOperationalMemoryPath: string
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
    aggregatedFailurePacketsPath: path.join(root, "aggregated-failure-packets.jsonl"),
    aggregatedRetryLessonsPath: path.join(root, "aggregated-retry-lessons.jsonl"),
    aggregatedLearningUnitsPath: path.join(root, "aggregated-learning-units.jsonl"),
    campaignOperationalMemoryPath: path.join(root, "campaign-operational-memory.json"),
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

export function longTaskCampaignRoundPaths(paths: LongTaskCampaignPaths, roundNumber: number): LongTaskCampaignRoundPaths {
  const roundID = `round-${String(roundNumber).padStart(3, "0")}`
  const root = path.join(paths.roundsRoot, roundID)
  return {
    root,
    generatedSpecPath: path.join(root, "generated-spec.json"),
    roundSummaryPath: path.join(root, "round-summary.md"),
    runTraceJsonPath: path.join(root, "run-trace.json"),
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
  }
}

export async function initializeLongTaskCampaign(paths: LongTaskCampaignPaths, state: LongTaskCampaignState) {
  await ensureDirectory(paths.root)
  await ensureDirectory(paths.roundsRoot)
  await ensureDirectory(paths.pendingPackageRoot)
  await ensureDirectory(paths.runTracesRoot)
  await writeJsonFile(paths.campaignStatePath, state)
  await writeJsonFile(paths.campaignOperationalMemoryPath, [])
  await writeTextFile(paths.campaignSeedContextPath, "# Campaign Seed Context\n\n- no promoted cross-run memory yet\n")
  await writeJsonFile(paths.explorationTreePath, [])
  await writeTextFile(paths.campaignReviewSuggestionsPath, "")
}

export async function writeLongTaskCampaignState(paths: LongTaskCampaignPaths, state: LongTaskCampaignState) {
  await writeJsonFile(paths.campaignStatePath, state)
}

export async function readLongTaskCampaignState(paths: LongTaskCampaignPaths) {
  return readJsonFile<LongTaskCampaignState>(paths.campaignStatePath)
}

export async function appendLongTaskCampaignHistory(paths: LongTaskCampaignPaths, record: LongTaskCampaignRoundRecord) {
  await ensureDirectory(path.dirname(paths.historyPath))
  await appendFile(paths.historyPath, JSON.stringify(record) + "\n", "utf8")
}

export async function appendLinesToAggregate(target: string, lines: string[]) {
  if (!lines.length) return
  await ensureDirectory(path.dirname(target))
  await appendFile(target, lines.map((line) => line.trim()).filter(Boolean).join("\n") + "\n", "utf8")
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

export async function writeLongTaskCampaignSeedContext(paths: LongTaskCampaignPaths, content: string) {
  await writeTextFile(paths.campaignSeedContextPath, content)
}

export async function writeLongTaskCampaignExplorationTree(
  paths: LongTaskCampaignPaths,
  records: LongTaskCampaignExplorationNode[],
) {
  await writeJsonFile(paths.explorationTreePath, records)
}

export async function readLongTaskCampaignExplorationTree(paths: LongTaskCampaignPaths) {
  return readJsonFile<LongTaskCampaignExplorationNode[]>(paths.explorationTreePath)
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
