import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { resumeLongTaskCampaign } from "../orchestrator/long-task-campaign/runner"

const cwd = path.resolve(import.meta.dir, "..", "..")
const campaignRoot = path.join(cwd, "runtime-state", "long-task-campaigns")
const taskPackRoot = path.join(cwd, "task-packs", "real-long-tasks", "officeqa-pro-learnbench")

// 4 UIDs to resume
const targets = [
  { id: "UID0094", campaignDir: "20260607-055343175-5c6b5658-officeqa-pro-campaign-uid0094", campaignID: "20260607-055343175-5c6b5658-officeqa-pro-campaign-uid0094", maxRounds: 25 },
  { id: "UID0196", campaignDir: "20260607-072923044-f22e2845-officeqa-pro-campaign-uid0196", campaignID: "20260607-072923044-f22e2845-officeqa-pro-campaign-uid0196", maxRounds: 25 },
  { id: "UID0246", campaignDir: "20260607-055337923-657b08bc-officeqa-pro-campaign-uid0246", campaignID: "20260607-055337923-657b08bc-officeqa-pro-campaign-uid0246", maxRounds: 25 },
  { id: "UID0211", campaignDir: "20260607-055304869-fd2d09c9-officeqa-pro-campaign-uid0211", campaignID: "20260607-055304869-fd2d09c9-officeqa-pro-campaign-uid0211", maxRounds: 25 },
]

async function resetCampaignState(campaignDir: string, uid: string, newMaxRounds: number) {
  // 1. Reset task pack campaign.json (spec source)
  const specPath = path.join(taskPackRoot, "tasks", uid, "campaign.json")
  const specRaw = await readFile(specPath, "utf8")
  const spec = JSON.parse(specRaw)
  spec.maxRounds = newMaxRounds
  await writeFile(specPath, JSON.stringify(spec, null, 2) + "\n", "utf8")
  console.log(`  [spec] ${uid}/campaign.json maxRounds -> ${newMaxRounds}`)

  // 2. Reset runtime state campaign.json
  const statePath = path.join(campaignRoot, campaignDir, "campaign.json")
  const raw = await readFile(statePath, "utf8")
  const state = JSON.parse(raw)
  state.status = "recovery_pending"
  state.maxRounds = newMaxRounds
  state.ownerPID = undefined
  state.ownerCommandHint = undefined
  state.heartbeatAt = undefined
  state.updatedAt = new Date().toISOString()
  state.lastSummary = "Manual resume from round_limit_reached."
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8")
  console.log(`  [state] ${campaignDir} -> recovery_pending, maxRounds=${newMaxRounds}`)
}

async function main() {
  for (const t of targets) {
    try {
      console.log(`\n[${t.id}] Step 1: Reset state from round_limit_reached`)
      await resetCampaignState(t.campaignDir, t.id, t.maxRounds)

      const specPath = path.join(taskPackRoot, "tasks", t.id, "campaign.json")

      console.log(`[${t.id}] Step 2: Resume campaign`)
      const result = await resumeLongTaskCampaign({ cwd, campaignID: t.campaignID, specPath })
      console.log(`[${t.id}] Done: status=${result.status} rounds=${result.roundsCompleted}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[${t.id}] FAILED: ${msg}`)
    }
  }
  console.log("\nAll done.")
}

await main()
