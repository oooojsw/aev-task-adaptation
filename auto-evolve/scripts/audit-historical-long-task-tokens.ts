import path from "node:path"
import { readdir, readFile, stat, writeFile } from "node:fs/promises"

type JsonObject = Record<string, any>

type Usage = {
  sessions: Set<string>
  steps: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  rawCost: number
}

function parseArg(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function emptyUsage(): Usage {
  return {
    sessions: new Set(),
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    rawCost: 0,
  }
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function normalizedFsPath(value: unknown) {
  if (typeof value !== "string") return undefined
  // Some historical ledgers contain JSON-escaped backslashes after parsing.
  return path.normalize(value.replace(/\\\\/g, "\\"))
}

async function readJson(file: string): Promise<any> {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))
}

async function exists(file: string) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

async function collectNamedFiles(root: string, filename: string, out: string[] = []) {
  if (!(await exists(root))) return out
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      await collectNamedFiles(full, filename, out)
    } else if (entry.isFile() && entry.name === filename) {
      out.push(full)
    }
  }
  return out
}

function roleFor(file: string) {
  const normalized = file.replace(/\\/g, "/").toLowerCase()
  if (normalized.includes("blank-eval")) return "blank_agent"
  if (normalized.includes("campaign-lead")) return "lead"
  if (normalized.includes("/reviewer/")) return "reviewer"
  if (normalized.includes("/workers/")) return "worker"
  if (normalized.includes("/replan/") || normalized.includes("/plan/")) return "planner"
  if (normalized.includes("/validators/") || normalized.includes("validator")) return "validator"
  if (normalized.includes("/units/")) return "executor"
  return "other"
}

function addStep(target: Usage, event: JsonObject) {
  const part = event?.part
  const tokens = part?.tokens
  if (event?.type !== "step_finish" || !tokens || typeof tokens !== "object") return false
  const cache = tokens.cache && typeof tokens.cache === "object" ? tokens.cache : {}
  target.sessions.add(String(event.sessionID ?? part.sessionID ?? "unknown"))
  target.steps += 1
  target.inputTokens += number(tokens.input ?? tokens.promptTokens ?? tokens.prompt_tokens)
  target.outputTokens += number(tokens.output ?? tokens.completionTokens ?? tokens.completion_tokens)
  target.reasoningTokens += number(tokens.reasoning ?? tokens.reasoningTokens ?? tokens.reasoning_tokens)
  target.cacheReadTokens += number(cache.read ?? tokens.cacheRead ?? tokens.cacheReadTokens)
  target.cacheWriteTokens += number(cache.write ?? tokens.cacheWrite ?? tokens.cacheWriteTokens)
  target.totalTokens += number(tokens.total ?? tokens.totalTokens ?? tokens.total_tokens)
  target.rawCost += number(part.cost)
  return true
}

function plainUsage(usage: Usage) {
  const componentTotal =
    usage.inputTokens + usage.outputTokens + usage.reasoningTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  return {
    sessions: usage.sessions.size,
    steps: usage.steps,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens || componentTotal,
    componentTotal,
    rawCost: usage.rawCost,
  }
}

const benchmarkOutArg = parseArg("--benchmark-out")
if (!benchmarkOutArg) throw new Error("Usage: --benchmark-out <benchmark run directory> [--out <json path>]")

const benchmarkOut = path.resolve(benchmarkOutArg)
const autoEvolveRoot = path.resolve(import.meta.dir, "..")
const runtimeRoot = path.join(autoEvolveRoot, "runtime-state")
const ledger = await readJson(path.join(benchmarkOut, "task-ledger.json"))
const tasks = Object.values<JsonObject>(ledger.tasks ?? {})
const taskIDs = Object.keys(ledger.tasks ?? {})
const campaignDirs = new Set<string>()
const campaignIDs = new Set<string>()
const retainedCampaignDirs = new Set<string>()

for (const task of tasks) {
  for (const attempt of Array.isArray(task.attempts) ? task.attempts : []) {
    const campaignDir = normalizedFsPath(attempt.campaignDir)
    if (campaignDir) {
      campaignDirs.add(campaignDir)
      retainedCampaignDirs.add(campaignDir)
    }
    if (typeof attempt.campaignID === "string") campaignIDs.add(attempt.campaignID)
  }
  const activeDir = normalizedFsPath(task.activeCampaignDir)
  if (activeDir) {
    campaignDirs.add(activeDir)
    retainedCampaignDirs.add(activeDir)
  }
  if (typeof task.activeCampaignID === "string") campaignIDs.add(task.activeCampaignID)
}

let inferredHistoricalCampaigns = 0
if (process.argv.includes("--include-matching-history")) {
  const campaignsRoot = path.join(runtimeRoot, "long-task-campaigns")
  if (await exists(campaignsRoot)) {
    for (const entry of await readdir(campaignsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (!taskIDs.some((taskID) => entry.name.endsWith(`-spreadsheetbench-campaign-${taskID}`))) continue
      const campaignDir = path.join(campaignsRoot, entry.name)
      if (!campaignDirs.has(campaignDir)) inferredHistoricalCampaigns += 1
      campaignDirs.add(campaignDir)
      try {
        const campaign = await readJson(path.join(campaignDir, "campaign.json"))
        if (typeof campaign?.id === "string") campaignIDs.add(campaign.id)
      } catch {
        // The directory is still scanned; unreadable campaign metadata only weakens the executor-run join.
      }
    }
  }
}

const eventFiles = new Set<string>()
const missingCampaignDirs: string[] = []
for (const campaignDir of campaignDirs) {
  if (!(await exists(campaignDir))) {
    missingCampaignDirs.push(campaignDir)
    continue
  }
  for (const file of await collectNamedFiles(campaignDir, "events.json")) eventFiles.add(file)
}

// Historical long-task executor sessions live outside campaign directories.
// task.json contains the owning campaign ID, so it is a stronger join key than task names.
const longTaskRoot = path.join(runtimeRoot, "long-task", "runs")
const matchedLongTaskRuns: string[] = []
if (await exists(longTaskRoot)) {
  for (const entry of await readdir(longTaskRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const runDir = path.join(longTaskRoot, entry.name)
    const taskJson = path.join(runDir, "task.json")
    if (!(await exists(taskJson))) continue
    const raw = await readFile(taskJson, "utf8")
    if (![...campaignIDs].some((campaignID) => raw.includes(campaignID))) continue
    matchedLongTaskRuns.push(runDir)
    for (const file of await collectNamedFiles(runDir, "events.json")) eventFiles.add(file)
  }
}

const totals = emptyUsage()
const byRole = new Map<string, Usage>()
const seenSteps = new Set<string>()
const unreadableFiles: Array<{ file: string; error: string }> = []
let filesWithUsage = 0
let filesWithoutUsage = 0

for (const file of eventFiles) {
  try {
    const events = await readJson(file)
    if (!Array.isArray(events)) {
      filesWithoutUsage += 1
      continue
    }
    const role = roleFor(file)
    const roleUsage = byRole.get(role) ?? emptyUsage()
    let found = false
    for (const event of events) {
      const part = event?.part
      if (event?.type !== "step_finish" || !part?.tokens) continue
      const stepKey = `${event.sessionID ?? part.sessionID ?? "unknown"}\u001f${part.id ?? part.messageID ?? event.timestamp}`
      if (seenSteps.has(stepKey)) continue
      seenSteps.add(stepKey)
      addStep(totals, event)
      addStep(roleUsage, event)
      found = true
    }
    if (found) filesWithUsage += 1
    else filesWithoutUsage += 1
    byRole.set(role, roleUsage)
  } catch (error) {
    unreadableFiles.push({ file, error: error instanceof Error ? error.message : String(error) })
  }
}

const mergeRoot = path.join(benchmarkOut, "merge-and-validate")
const mergeEventFiles = await collectNamedFiles(mergeRoot, "events.json")
const report = {
  schema: "auto-evolve-historical-long-task-token-audit/v1",
  createdAt: new Date().toISOString(),
  benchmarkOut: benchmarkOut.replace(/\\/g, "/"),
  scope: "task-ledger campaigns plus their referenced long-task executor runs",
  coverage: {
    ledgerTasks: tasks.length,
    campaignAttempts: campaignIDs.size,
    campaignDirectories: campaignDirs.size,
    retainedCampaignDirectories: retainedCampaignDirs.size,
    inferredHistoricalCampaigns,
    missingCampaignDirectories: missingCampaignDirs.length,
    matchedLongTaskRuns: matchedLongTaskRuns.length,
    eventFiles: eventFiles.size,
    filesWithUsage,
    filesWithoutUsage,
    unreadableFiles: unreadableFiles.length,
    uniqueStepFinishRecords: seenSteps.size,
    mergeEventFiles: mergeEventFiles.length,
  },
  totals: plainUsage(totals),
  byRole: Object.fromEntries([...byRole.entries()].map(([role, usage]) => [role, plainUsage(usage)])),
  limitations: [
    "This reconstructs provider-reported usage retained in events.json; sessions whose event files were deleted cannot be recovered.",
    mergeEventFiles.length === 0
      ? "The merge/replay directory has no events.json usage records, so merge/replay tokens are not included."
      : "Merge/replay events exist but are reported separately from task-ledger campaign training.",
    "rawCost may be zero when the provider reports tokens but OpenCode has no price metadata.",
  ],
  missingCampaignDirs,
  unreadableFiles,
}

const outFile = path.resolve(parseArg("--out") ?? path.join(benchmarkOut, "historical-long-task-token-audit.json"))
await writeFile(outFile, JSON.stringify(report, null, 2) + "\n", "utf8")
console.log(JSON.stringify({ outFile, coverage: report.coverage, totals: report.totals, byRole: report.byRole }, null, 2))
