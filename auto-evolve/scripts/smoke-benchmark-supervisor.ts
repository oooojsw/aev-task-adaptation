import path from "node:path"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { readCampaignHealth } from "../orchestrator/run-health"

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

async function assertSourceGuards() {
  const source = await readFile(path.join(import.meta.dir, "run-benchmark-orchestrator.ts"), "utf8")
  assert(!source.includes("async function shouldResumeCampaign"), "old boolean shouldResumeCampaign must not exist")
  assert(source.includes("classifyCampaignForScheduling"), "scheduler classifier is missing")
  assert(source.includes("watchSeed: WatchPick[]"), "queueTrain must accept watchSeed")
  assert(source.includes("watch.size === 0"), "queueTrain exit condition must include watch.size")
  assert(source.includes('status: "watch_live"'), "runOneCampaign must have watch_live defensive return")
}

async function assertNoOwnerRunningIsStale() {
  const root = path.join(import.meta.dir, "..", ".tmp-smoke", "benchmark-supervisor")
  const campaignDir = path.join(root, "20260626-smoke-spreadsheetbench-campaign-demo")
  await rm(root, { recursive: true, force: true })
  await mkdir(campaignDir, { recursive: true })
  const now = new Date().toISOString()
  await writeFile(
    path.join(campaignDir, "campaign.json"),
    JSON.stringify(
      {
        id: path.basename(campaignDir),
        title: "smoke",
        status: "running",
        currentRound: 1,
        maxRounds: 7,
        heartbeatAt: now,
        updatedAt: now,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  )
  const health = await readCampaignHealth(campaignDir, Date.now())
  assert(health?.health === "stale_running", `expected no-owner running to be stale_running, got ${health?.health}`)
  assert(health?.suggestedAction === "resume", `expected resume action, got ${health?.suggestedAction}`)
  await rm(root, { recursive: true, force: true })
}

await assertSourceGuards()
await assertNoOwnerRunningIsStale()
console.log("smoke-benchmark-supervisor ok")
