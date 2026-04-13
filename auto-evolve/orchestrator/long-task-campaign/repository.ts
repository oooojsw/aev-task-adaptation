import path from "node:path"
import { appendFile } from "node:fs/promises"
import { autoEvolvePath, ensureDirectory, readJsonFile, writeJsonFile, writeTextFile } from "../fs"
import type { LongTaskCampaignRoundRecord, LongTaskCampaignState } from "./contract"

export interface LongTaskCampaignPaths {
  root: string
  campaignStatePath: string
  historyPath: string
  aggregatedFailurePacketsPath: string
  aggregatedRetryLessonsPath: string
  aggregatedLearningUnitsPath: string
  campaignLessonsPath: string
  roundsRoot: string
}

export interface LongTaskCampaignRoundPaths {
  root: string
  generatedSpecPath: string
  roundSummaryPath: string
  harvestedRoot: string
  snapshotsRoot: string
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
    campaignLessonsPath: path.join(root, "campaign-failure-lessons.md"),
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
    harvestedRoot: path.join(root, "harvested"),
    snapshotsRoot: path.join(root, "snapshots"),
  }
}

export async function initializeLongTaskCampaign(paths: LongTaskCampaignPaths, state: LongTaskCampaignState) {
  await ensureDirectory(paths.root)
  await ensureDirectory(paths.roundsRoot)
  await writeJsonFile(paths.campaignStatePath, state)
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
