#!/usr/bin/env bun
// resume-50train-remaining.ts
// 续跑 officeqa-pro 50 训练集中剩下未 verified 的 case
// 跳过 running 状态（让原 campaign 自己跑）
// 只跑 round_limit_reached + queued + failed
// 3 并发 / 7 轮

import path from "node:path"
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resumeLongTaskCampaign } from "../orchestrator/long-task-campaign/runner"

const cwd = path.resolve(import.meta.dir, "..", "..")
const taskPackRoot = path.join(cwd, "auto-evolve", "task-packs", "real-long-tasks", "officeqa-pro-learnbench")
const campaignRoot = path.join(cwd, "auto-evolve", "runtime-state", "long-task-campaigns")
const stateFile = path.join(cwd, "auto-evolve", "runtime-state", "officeqa-pro-50train-runs", "2026-06-09T18-28-09", "orchestrator-state.json")

const concurrency = Math.max(1, Number.parseInt(process.env.OFFICEQA_PRO_RESUME_CONCURRENCY ?? "3", 10))
const extraRounds = Math.max(1, Number.parseInt(process.env.OFFICEQA_PRO_RESUME_ROUNDS ?? "7", 10))

async function readJson<T = any>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function findCampaignDir(uid: string): Promise<string | undefined> {
  const needle = `officeqa-pro-campaign-${uid.toLowerCase()}`
  const dirs = (await readdir(campaignRoot, { withFileTypes: true }))
    .filter((item) => item.isDirectory() && item.name.toLowerCase().includes(needle))
    .map((item) => path.join(campaignRoot, item.name))
  dirs.sort()
  return dirs.at(-1)
}

async function resetSpec(uid: string, newMaxRounds: number) {
  const specPath = path.join(taskPackRoot, "tasks", uid, "campaign.json")
  const raw = await readFile(specPath, "utf8")
  const spec = JSON.parse(raw)
  spec.maxRounds = newMaxRounds
  await writeFile(specPath, JSON.stringify(spec, null, 2) + "\n", "utf8")
}

async function resetRuntimeState(campaignDir: string, newMaxRounds: number) {
  const statePath = path.join(campaignDir, "campaign.json")
  const raw = await readFile(statePath, "utf8")
  const state = JSON.parse(raw)
  state.status = "recovery_pending"
  state.maxRounds = newMaxRounds
  state.ownerPID = undefined
  state.ownerCommandHint = undefined
  state.heartbeatAt = undefined
  state.updatedAt = new Date().toISOString()
  state.lastSummary = "Manual resume from breakpoint for 50-train completion."
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8")
}

async function main() {
  const state = await readJson<any>(stateFile)
  const r = state.trainResults ?? {}
  const resultsByID: Record<string, any> = {}
  if (Array.isArray(r)) {
    for (const x of r) resultsByID[x.id] = x
  } else {
    Object.assign(resultsByID, r)
  }

  // 只跑 round_limit_reached + queued + failed，跳过 running
  const targets = Object.entries(resultsByID)
    .filter(([_, v]) => {
      const s = v?.status
      return s === "round_limit_reached" || s === "queued" || s === "failed" || s === "recovery_pending"
    })
    .map(([id, v]) => ({ id, status: v.status, campaignDir: v.campaignDir }))

  console.log(`[resume-50train] found ${targets.length} to resume (skipping running)`, targets.map(t=>`${t.id}:${t.status}`).join(','))

  const batchSize = concurrency
  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize)
    console.log(`\n[resume-50train] batch ${i / batchSize + 1}: ${batch.map((b) => b.id).join(",")}`)
    await Promise.all(batch.map(async (t) => {
      try {
        let campaignDir = t.campaignDir
        if (!campaignDir || !existsSync(campaignDir)) {
          campaignDir = await findCampaignDir(t.id) ?? ""
        }
        if (!campaignDir || !existsSync(campaignDir)) {
          console.log(`  [${t.id}] no campaign dir found, skip`)
          return
        }
        await resetSpec(t.id, extraRounds)
        await resetRuntimeState(campaignDir, extraRounds)
        const specPath = path.join(taskPackRoot, "tasks", t.id, "campaign.json")
        const campaignID = path.basename(campaignDir)
        console.log(`  [${t.id}] resuming campaign=${campaignID} maxRounds=${extraRounds}`)
        const result = await resumeLongTaskCampaign({ cwd, campaignID, specPath })
        console.log(`  [${t.id}] done status=${result.status} rounds=${result.roundsCompleted}`)
        const newStatus = result.status === "verified_success" ? "verified_success" : result.status
        const idx = state.trainResults.findIndex((x: any) => x.id === t.id)
        if (idx >= 0) {
          state.trainResults[idx].status = newStatus
          state.trainResults[idx].campaignDir = result.campaignDir
        }
        await writeJson(stateFile, state)
      } catch (e: any) {
        console.log(`  [${t.id}] ERROR: ${e?.message ?? e}`)
      }
    }))
  }
  console.log(`\n[resume-50train] all batches done`)
}

await main()
