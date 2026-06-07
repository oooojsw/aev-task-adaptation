import path from "node:path"
import { mkdir, rm, utimes, writeFile } from "node:fs/promises"
import { readCampaignHealth } from "../orchestrator/run-health"

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const smokeRoot = path.join(repoRoot, "auto-evolve", "runtime-state", "tmp-smoke-run-health-takeover")

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function makeCampaign(input: { id: string; ageMs: number }) {
  const campaignDir = path.join(smokeRoot, input.id)
  await rm(campaignDir, { recursive: true, force: true })
  await mkdir(campaignDir, { recursive: true })
  const timestamp = new Date(Date.now() - input.ageMs)
  const statePath = path.join(campaignDir, "campaign.json")
  const artifactPath = path.join(campaignDir, "rounds", "round-001", "artifact.txt")
  await writeJson(statePath, {
    id: input.id,
    title: input.id,
    mode: "graph_iterative",
    baseSpecPath: path.join(smokeRoot, "spec.json"),
    maxRounds: 3,
    currentRound: 1,
    status: "running",
    ownerPID: process.pid,
    heartbeatAt: timestamp.toISOString(),
    updatedAt: timestamp.toISOString(),
    createdAt: timestamp.toISOString(),
  })
  await mkdir(path.dirname(artifactPath), { recursive: true })
  await writeFile(artifactPath, "smoke\n", "utf8")
  await utimes(artifactPath, timestamp, timestamp)
  await utimes(statePath, timestamp, timestamp)
  return campaignDir
}

await rm(smokeRoot, { recursive: true, force: true })
await mkdir(smokeRoot, { recursive: true })

const staleAgeMs = 50 * 60 * 1000
const freshAgeMs = 5 * 60 * 1000

const stuck = await readCampaignHealth(await makeCampaign({ id: "stuck-owner-alive", ageMs: staleAgeMs }))
if (!stuck) fail("Expected stuck campaign health.")
if (stuck.health !== "stuck_running") fail(`Expected stuck_running, got ${stuck.health}.`)
if (stuck.suggestedAction !== "takeover") fail(`Expected takeover action, got ${stuck.suggestedAction}.`)

const fresh = await readCampaignHealth(await makeCampaign({ id: "fresh-owner-alive", ageMs: freshAgeMs }))
if (!fresh) fail("Expected fresh campaign health.")
if (fresh.health !== "healthy_running") fail(`Expected healthy_running, got ${fresh.health}.`)
if (fresh.suggestedAction !== "watch") fail(`Expected watch action, got ${fresh.suggestedAction}.`)

console.log(
  JSON.stringify(
    {
      passed: true,
      cases: [
        { id: stuck.campaignID, health: stuck.health, action: stuck.suggestedAction },
        { id: fresh.campaignID, health: fresh.health, action: fresh.suggestedAction },
      ],
    },
    null,
    2,
  ),
)
