import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { resumeLongTaskCampaign } from "../orchestrator/long-task-campaign/runner"

const cwd = path.resolve(import.meta.dir, "..", "..")
const root = path.join(cwd, "auto-evolve", "task-packs", "real-long-tasks", "officeqa-pro-learnbench")
const concurrency = 2
const targets = [
  { id: "UID0120", campaignID: "20260605-132217518-b8fb73ce-officeqa-pro-campaign-uid0120" },
  { id: "UID0223", campaignID: "20260605-132217482-e2e63863-officeqa-pro-campaign-uid0223" },
]
const outFile = path.join(
  cwd,
  "runtime-state",
  "officeqa-pro-runs",
  `${new Date().toISOString().replace(/[:.]/g, "-")}-uid0120-uid0223-resume-rounds20-result.json`,
)

type One = {
  id: string
  status: string
  roundsCompleted: number
  campaignDir: string
  finalSummary?: string
}

async function resumeOne(t: { id: string; campaignID: string }): Promise<One> {
  const specPath = path.join(root, "tasks", t.id, "campaign.json")
  const res = await resumeLongTaskCampaign({ cwd, campaignID: t.campaignID, specPath })
  return {
    id: t.id,
    status: res.status,
    roundsCompleted: res.roundsCompleted,
    campaignDir: res.campaignDir,
    finalSummary: res.finalSummary,
  }
}

async function main() {
  await mkdir(path.dirname(outFile), { recursive: true })
  console.log(`[start] resume test set: ${targets.map((t) => t.id).join(", ")} | maxRounds=20 | concurrency=${concurrency}`)
  const results: One[] = []
  const queue = [...targets]
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
      const t = queue.shift()
      if (!t) break
      try {
        upsert({ id: t.id, status: "resuming", roundsCompleted: 0, campaignDir: "", finalSummary: "Resume started." })
        await persist()
        const one = await resumeOne(t)
        upsert(one)
        console.log(`[done] ${t.id} ${one.status} rounds=${one.roundsCompleted}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const failed = { id: t.id, status: "failed", roundsCompleted: 0, campaignDir: "", finalSummary: msg }
        upsert(failed)
        console.log(`[fail] ${t.id} ${msg}`)
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
