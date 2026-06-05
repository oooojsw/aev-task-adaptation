import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { runLongTaskCampaign } from "../orchestrator/long-task-campaign/runner"

const cwd = path.resolve(import.meta.dir, "..", "..")
const root = path.join(cwd, "auto-evolve", "task-packs", "real-long-tasks", "spreadsheetbench-learnbench")
const split = process.env.SPREADSHEETBENCH_SPLIT ?? "train"
const concurrency = Number.parseInt(process.env.SPREADSHEETBENCH_CONCURRENCY ?? "5", 10)
const limit = Number.parseInt(process.env.SPREADSHEETBENCH_RUN_LIMIT ?? "20", 10)
const splitFile =
  split === "test" ? path.join(root, "splits", "test-selected.json") : path.join(root, "splits", "train-selected.json")
const outFile = path.join(
  cwd,
  "runtime-state",
  "spreadsheetbench-runs",
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${split}-result.json`,
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
  const results: One[] = []
  const queue = [...selected]
  const workers: Promise<void>[] = []
  let persistQueue: Promise<void> = Promise.resolve()

  function persist() {
    const snapshot = JSON.stringify(results, null, 2)
    persistQueue = persistQueue.then(() => writeFile(outFile, snapshot, "utf8"))
    return persistQueue
  }

  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift()
      if (!id) break
      try {
        const one = await runOne(id)
        results.push(one)
        console.log(`[done] ${id} ${one.status} rounds=${one.roundsCompleted}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({
          id,
          status: "failed",
          roundsCompleted: 0,
          campaignDir: "",
          finalSummary: msg,
        })
        console.log(`[fail] ${id} ${msg}`)
      }
      await persist()
    }
  }

  for (let i = 0; i < Math.max(1, concurrency); i += 1) {
    workers.push(worker())
  }
  await Promise.all(workers)
  await persistQueue
  const ok = results.filter((r) => r.status === "verified_success").length
  console.log(JSON.stringify({ total: results.length, verified_success: ok, outFile }, null, 2))
}

await main()
