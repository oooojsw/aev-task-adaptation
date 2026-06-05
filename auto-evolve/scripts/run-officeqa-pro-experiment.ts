import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { runLongTaskCampaign } from "../orchestrator/long-task-campaign/runner"

const cwd = path.resolve(import.meta.dir, "..", "..")
const root = path.join(cwd, "auto-evolve", "task-packs", "real-long-tasks", "officeqa-pro-learnbench")
const concurrency = Number.parseInt(process.env.OFFICEQA_PRO_CONCURRENCY ?? "5", 10)
const limit = Number.parseInt(process.env.OFFICEQA_PRO_RUN_LIMIT ?? "5", 10)
const splitFile = process.env.OFFICEQA_PRO_SPLIT_FILE
  ? path.resolve(process.env.OFFICEQA_PRO_SPLIT_FILE)
  : path.join(root, "splits", "first-five.json")
const outFile = process.env.OFFICEQA_PRO_RESULT_FILE
  ? path.resolve(process.env.OFFICEQA_PRO_RESULT_FILE)
  : path.join(
      cwd,
      "runtime-state",
      "officeqa-pro-runs",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-result.json`,
    )

type One = {
  id: string
  status: string
  roundsCompleted: number
  campaignDir: string
  finalSummary?: string
}

async function runOne(id: string): Promise<One> {
  const specPath = path.join(root, "tasks", id, "campaign.json")
  const res = await runLongTaskCampaign({ cwd, specPath })
  return {
    id,
    status: res.status,
    roundsCompleted: res.roundsCompleted,
    campaignDir: res.campaignDir,
    finalSummary: res.finalSummary,
  }
}

async function main() {
  await mkdir(path.dirname(outFile), { recursive: true })
  const ids = JSON.parse(await readFile(splitFile, "utf8")) as string[]
  const selected = ids.slice(0, Math.max(1, Math.min(limit, ids.length)))
  const previous = existsSync(outFile) ? (JSON.parse(await readFile(outFile, "utf8")) as One[]) : []
  const results: One[] = [...previous]
  const completed = new Set(
    previous
      .filter((item) => item.status === "verified_success" || item.status === "exhausted_failure")
      .map((item) => item.id),
  )
  const queued = new Set<string>()
  const queue = selected.filter((id) => {
    if (completed.has(id) || queued.has(id)) return false
    queued.add(id)
    return true
  })
  const workers: Promise<void>[] = []
  let persistQueue: Promise<void> = Promise.resolve()

  function persist() {
    const snapshot = JSON.stringify(results, null, 2)
    persistQueue = persistQueue.then(() => writeFile(outFile, snapshot, "utf8"))
    return persistQueue
  }

  function upsert(one: One) {
    const existing = results.findIndex((item) => item.id === one.id)
    if (existing >= 0) results.splice(existing, 1, one)
    else results.push(one)
  }

  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift()
      if (!id) break
      try {
        upsert({ id, status: "running", roundsCompleted: 0, campaignDir: "", finalSummary: "Campaign started." })
        await persist()
        const one = await runOne(id)
        upsert(one)
        console.log(`[done] ${id} ${one.status} rounds=${one.roundsCompleted}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const failed = { id, status: "failed", roundsCompleted: 0, campaignDir: "", finalSummary: msg }
        upsert(failed)
        console.log(`[fail] ${id} ${msg}`)
      }
      await persist()
    }
  }

  for (let i = 0; i < Math.max(1, concurrency); i += 1) workers.push(worker())
  await Promise.all(workers)
  await persistQueue
  const ok = results.filter((r) => r.status === "verified_success").length
  console.log(JSON.stringify({ total: results.length, verified_success: ok, outFile }, null, 2))
}

await main()
