#!/usr/bin/env bun
// Finish the OfficeQA-Pro 50-train run with a strict final status policy:
// - verified=true/status mismatch becomes verified_success.
// - round_limit_reached is classified as failed and is not rerun.
// - queued entries with no useful live campaign start fresh.
// - recovery/stale running entries are resumed.
// - completion status is normalized to only verified_success or failed.

import path from "node:path"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { runLongTaskCampaign, resumeLongTaskCampaign } from "../orchestrator/long-task-campaign/runner"

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const autoRoot = path.join(repoRoot, "auto-evolve")
const taskPackRoot = path.join(autoRoot, "task-packs", "real-long-tasks", "officeqa-pro-learnbench")
const campaignRoot = path.join(autoRoot, "runtime-state", "long-task-campaigns")
const runRoot = path.join(autoRoot, "runtime-state", "officeqa-pro-50train-runs", "2026-06-09T18-28-09")
const stateFile = path.join(runRoot, "orchestrator-state.json")
const logFile = path.join(runRoot, "finish-50train-three-concurrency.status.json")

const concurrency = Math.max(1, Number.parseInt(process.env.OFFICEQA_FINISH_CONCURRENCY ?? "3", 10))
const maxRounds = Math.max(1, Number.parseInt(process.env.OFFICEQA_FINISH_MAX_ROUNDS ?? "7", 10))

type TrainResult = Record<string, any> & { id: string; status?: string; verified?: boolean; campaignDir?: string }
type WorkItem = { id: string; action: "start" | "resume"; campaignDir?: string; reason: string }

async function readJson<T = any>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function loadState(): Promise<any> {
  return readJson(stateFile)
}

async function saveState(state: any) {
  await writeJson(stateFile, state)
}

function asRows(state: any): TrainResult[] {
  if (Array.isArray(state.trainResults)) return state.trainResults
  return Object.entries(state.trainResults ?? {}).map(([id, value]) => ({ id, ...(value as any) }))
}

function putRow(state: any, row: TrainResult) {
  if (Array.isArray(state.trainResults)) {
    const index = state.trainResults.findIndex((item: any) => item.id === row.id)
    if (index >= 0) state.trainResults[index] = row
    else state.trainResults.push(row)
    return
  }
  state.trainResults ??= {}
  state.trainResults[row.id] = row
}

async function findCampaignDir(uid: string): Promise<string | undefined> {
  if (!existsSync(campaignRoot)) return undefined
  const needle = `officeqa-pro-campaign-${uid.toLowerCase()}`
  const dirs = (await readdir(campaignRoot, { withFileTypes: true }))
    .filter((item) => item.isDirectory() && item.name.toLowerCase().includes(needle))
    .map((item) => path.join(campaignRoot, item.name))
  dirs.sort((a, b) => {
    const an = path.basename(a)
    const bn = path.basename(b)
    return an.localeCompare(bn)
  })
  return dirs.at(-1)
}

async function setMaxRounds(uid: string, n: number) {
  const specPath = path.join(taskPackRoot, "tasks", uid, "campaign.json")
  const spec = await readJson(specPath)
  spec.maxRounds = n
  await writeJson(specPath, spec)
}

async function readCampaignState(campaignDir: string): Promise<any | undefined> {
  const file = path.join(campaignDir, "campaign.json")
  if (!existsSync(file)) return undefined
  return readJson(file)
}

function isRecentIso(value: unknown, maxAgeMs: number): boolean {
  if (typeof value !== "string") return false
  const time = Date.parse(value)
  return Number.isFinite(time) && Date.now() - time <= maxAgeMs
}

function pidLooksAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isLiveRunningCampaign(campaignState: any): boolean {
  return campaignState?.status === "running" && pidLooksAlive(campaignState.ownerPID) && isRecentIso(campaignState.heartbeatAt, 30 * 60 * 1000)
}

function isRoundLimitFailure(row: TrainResult, campaignState: any): boolean {
  return (
    row.status === "round_limit_reached" ||
    row.failureReason === "round_limit_reached" ||
    row.rawCampaignStatus === "round_limit_reached" ||
    campaignState?.status === "round_limit_reached"
  )
}

async function markCampaignRecoverable(campaignDir: string) {
  const file = path.join(campaignDir, "campaign.json")
  const state = await readJson(file)
  state.status = "recovery_pending"
  state.maxRounds = maxRounds
  delete state.ownerPID
  delete state.ownerCommandHint
  delete state.heartbeatAt
  state.updatedAt = new Date().toISOString()
  state.lastSummary = "Manual 50-train finalization: recover stale/system-fault campaign."
  await writeJson(file, state)
}

async function appendStatus(entry: unknown) {
  const current = existsSync(logFile) ? await readJson<any[]>(logFile) : []
  current.push({ at: new Date().toISOString(), ...entry as any })
  await writeJson(logFile, current)
}

function normalizeFinalStatus(rawStatus: string | undefined): "verified_success" | "failed" {
  return rawStatus === "verified_success" ? "verified_success" : "failed"
}

async function buildWorkQueue(state: any): Promise<WorkItem[]> {
  const rows = asRows(state)
  const work: WorkItem[] = []

  for (const row of rows) {
    if (row.status === "verified_success") continue

    if (row.verified === true) {
      row.status = "verified_success"
      row.finalizedBy = "finish-50train-three-concurrency"
      row.finalizedAt = new Date().toISOString()
      putRow(state, row)
      continue
    }

    if (row.status === "round_limit_reached") {
      row.status = "failed"
      row.failureReason = "round_limit_reached"
      row.finalizedBy = "finish-50train-three-concurrency"
      row.finalizedAt = new Date().toISOString()
      putRow(state, row)
      continue
    }

    const campaignDir = row.campaignDir && existsSync(row.campaignDir) ? row.campaignDir : await findCampaignDir(row.id)
    const campaignState = campaignDir ? await readCampaignState(campaignDir) : undefined

    if (row.status === "queued") {
      if (campaignDir && campaignState && isLiveRunningCampaign(campaignState)) {
        row.status = "running"
        row.campaignDir = campaignDir
        row.note = "Live campaign already running; left in place to avoid duplicate UID execution."
        putRow(state, row)
        continue
      }
      work.push({ id: row.id, action: "start", reason: campaignDir ? `queued but restarting fresh from ${path.basename(campaignDir)}` : "queued without campaign" })
      continue
    }

    if (row.status === "failed" && isRoundLimitFailure(row, campaignState)) {
      row.status = "failed"
      row.failureReason = "round_limit_reached"
      row.finalizedBy = "finish-50train-three-concurrency"
      row.finalizedAt = new Date().toISOString()
      putRow(state, row)
      continue
    }

    if (row.status === "running" || row.status === "recovery_pending" || row.status === "failed") {
      if (campaignDir && campaignState) {
        if (isLiveRunningCampaign(campaignState)) {
          row.status = "running"
          row.campaignDir = campaignDir
          row.note = "Live campaign already running; left in place to avoid duplicate UID execution."
          putRow(state, row)
          continue
        }
        work.push({ id: row.id, action: "resume", campaignDir, reason: `recover ${row.status}/${campaignState.status ?? "unknown"}` })
      } else {
        work.push({ id: row.id, action: "start", reason: `${row.status} without campaign` })
      }
    }
  }

  await saveState(state)
  return work
}

async function runOne(item: WorkItem) {
  const specPath = path.join(taskPackRoot, "tasks", item.id, "campaign.json")
  await setMaxRounds(item.id, maxRounds)
  await appendStatus({ id: item.id, event: "start", action: item.action, reason: item.reason })

  let result: any
  if (item.action === "resume" && item.campaignDir) {
    await markCampaignRecoverable(item.campaignDir)
    result = await resumeLongTaskCampaign({ cwd: repoRoot, campaignID: path.basename(item.campaignDir), specPath })
  } else {
    result = await runLongTaskCampaign({ cwd: repoRoot, specPath, forceNew: true })
  }

  const state = await loadState()
  const rows = asRows(state)
  const row = rows.find((itemRow) => itemRow.id === item.id) ?? { id: item.id }
  row.status = normalizeFinalStatus(result.status)
  row.verified = result.status === "verified_success"
  row.rawCampaignStatus = result.status
  row.campaignDir = result.campaignDir
  row.roundsCompleted = result.roundsCompleted
  row.finalizedBy = "finish-50train-three-concurrency"
  row.finalizedAt = new Date().toISOString()
  if (row.status === "failed") row.failureReason = result.status ?? "unknown"
  putRow(state, row)
  await saveState(state)
  await appendStatus({ id: item.id, event: "done", action: item.action, status: result.status, normalizedStatus: row.status, roundsCompleted: result.roundsCompleted })
}

async function runQueue(items: WorkItem[]) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async (_, workerIndex) => {
    while (cursor < items.length) {
      const item = items[cursor++]
      try {
        await appendStatus({ event: "dequeue", workerIndex, id: item.id, action: item.action })
        await runOne(item)
      } catch (error: any) {
        const state = await loadState()
        const row = asRows(state).find((itemRow) => itemRow.id === item.id) ?? { id: item.id }
        row.status = "failed"
        row.verified = false
        row.failureReason = error?.message ?? String(error)
        row.finalizedBy = "finish-50train-three-concurrency"
        row.finalizedAt = new Date().toISOString()
        putRow(state, row)
        await saveState(state)
        await appendStatus({ id: item.id, event: "error", action: item.action, message: row.failureReason })
      }
    }
  })
  await Promise.all(workers)
}

async function main() {
  await appendStatus({ event: "script-start", concurrency, maxRounds })
  const state = await loadState()
  const work = await buildWorkQueue(state)
  await appendStatus({ event: "queue-built", count: work.length, work })
  console.log(`[finish-50train] work=${work.length} concurrency=${concurrency}`)
  for (const item of work) console.log(`[finish-50train] ${item.id} ${item.action} ${item.reason}`)
  await runQueue(work)
  const finalState = await loadState()
  const counts = asRows(finalState).reduce<Record<string, number>>((acc, row) => {
    acc[row.status ?? "unknown"] = (acc[row.status ?? "unknown"] ?? 0) + 1
    return acc
  }, {})
  await appendStatus({ event: "script-done", counts })
  console.log(`[finish-50train] done ${JSON.stringify(counts)}`)
}

await main()
