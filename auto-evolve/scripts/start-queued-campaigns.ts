#!/usr/bin/env bun
// start-queued-campaigns.ts
// 为 queued 状态但没有 campaign 目录的 UID 启动新 campaign
// 3 并发 / 7 轮

import path from "node:path"
import { spawn } from "node:child_process"
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"

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

async function setMaxRounds(uid: string, n: number) {
  const specPath = path.join(taskPackRoot, "tasks", uid, "campaign.json")
  if (!existsSync(specPath)) return false
  const raw = await readFile(specPath, "utf8")
  const spec = JSON.parse(raw)
  spec.maxRounds = n
  await writeFile(specPath, JSON.stringify(spec, null, 2) + "\n", "utf8")
  return true
}

async function startOne(uid: string): Promise<{ok: boolean, msg: string}> {
  const specPath = path.join(taskPackRoot, "tasks", uid, "campaign.json")
  if (!existsSync(specPath)) return {ok:false, msg:"no spec"}
  await setMaxRounds(uid, extraRounds)
  return new Promise((resolve) => {
    const proc = spawn("bun", [
      "run", "cli.ts", "run-long-task-campaign",
      "--spec", specPath,
    ], { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let out = "", err = ""
    proc.stdout.on("data", d => out += d.toString())
    proc.stderr.on("data", d => err += d.toString())
    proc.on("close", (code) => {
      const m = (out + "\n" + err).split("\n").filter(l => l.includes(uid) || l.includes("status")).slice(-5).join(" | ")
      resolve({ok: code === 0, msg: `exit=${code} ${m}`})
    })
  })
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

  const queued = Object.entries(resultsByID)
    .filter(([_, v]) => v?.status === "queued")
    .map(([id]) => id)

  console.log(`[start-queued] found ${queued.length} queued: ${queued.join(",")}`)

  const startable: string[] = []
  for (const uid of queued) {
    const dir = await findCampaignDir(uid)
    if (!dir) {
      startable.push(uid)
    } else {
      console.log(`  [${uid}] already has campaign dir, skip`)
    }
  }

  console.log(`[start-queued] will start ${startable.length}: ${startable.join(",")}`)

  // 3 并发启动
  const batchSize = concurrency
  for (let i = 0; i < startable.length; i += batchSize) {
    const batch = startable.slice(i, i + batchSize)
    console.log(`\n[start-queued] batch ${i / batchSize + 1}: ${batch.join(",")}`)
    await Promise.all(batch.map(async (uid) => {
      console.log(`  [${uid}] starting...`)
      const r = await startOne(uid)
      console.log(`  [${uid}] ${r.ok ? "OK" : "FAIL"}: ${r.msg}`)
    }))
  }
  console.log(`\n[start-queued] done`)
}

await main()
