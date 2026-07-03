import path from "node:path"
import { randomUUID } from "node:crypto"
import { mkdir, rm, stat } from "node:fs/promises"
import { stopAutoEvolveRun } from "../orchestrator/stop-manager"
import { readJsonFile, writeJsonFile } from "../orchestrator/fs"

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const root = path.join(repoRoot, "auto-evolve", ".tmp-stop-manager-tests", randomUUID())

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

async function exists(file: string) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

async function main() {
  const outDir = path.join(root, "benchmark-run")
  const campaignDir = path.join(root, "long-task-campaigns", "20260630-smoke-campaign-task-a")
  await mkdir(path.join(outDir, "benchmark-leases"), { recursive: true })
  await mkdir(campaignDir, { recursive: true })

  await writeJsonFile(path.join(outDir, "orchestrator-state.json"), {
    runID: "benchmark-run",
    phase: "training",
    updatedAt: new Date().toISOString(),
    config: { outDir, taskPackRoot: path.join(root, "task-pack") },
    trainIDs: ["task-a", "task-b", "task-c"],
    testIDs: [],
    trainResults: [
      { id: "task-a", status: "running", campaignDir },
      { id: "task-b", status: "verified_success", campaignDir: path.join(root, "verified-campaign") },
      { id: "task-c", status: "queued" },
    ],
  })
  await writeJsonFile(path.join(outDir, "task-ledger.json"), {
    schema: "auto-evolve/benchmark-history/v1",
    runID: "benchmark-run",
    currentGenerationID: "generation-001",
    historyPolicy: "resume-current-generation",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    fingerprint: { taskPackRoot: path.join(root, "task-pack") },
    tasks: {
      "task-a": {
        id: "task-a",
        status: "running",
        activeAttemptID: "attempt-001",
        activeCampaignID: path.basename(campaignDir),
        activeCampaignDir: campaignDir,
        allowResume: true,
        updatedAt: new Date().toISOString(),
        attempts: [
          {
            attemptID: "attempt-001",
            campaignID: path.basename(campaignDir),
            campaignDir,
            generationID: "generation-001",
            status: "running",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
      "task-b": {
        id: "task-b",
        status: "verified_success",
        allowResume: false,
        updatedAt: new Date().toISOString(),
        attempts: [],
      },
      "task-c": {
        id: "task-c",
        status: "queued",
        allowResume: true,
        updatedAt: new Date().toISOString(),
        attempts: [],
      },
    },
  })
  await writeJsonFile(path.join(campaignDir, "campaign.json"), {
    id: path.basename(campaignDir),
    title: "smoke",
    mode: "graph_iterative",
    baseSpecPath: path.join(root, "task-pack", "tasks", "task-a", "campaign.json"),
    maxRounds: 7,
    currentRound: 2,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownerPID: 999999,
    ownerCreationTick: "fake",
    ownerCommandHint: "run-long-task-campaign smoke",
  })
  await writeJsonFile(path.join(outDir, "benchmark-leases", "task-a.json"), {
    schema: "auto-evolve/benchmark-task-lease/v1",
    taskID: "task-a",
    leaseID: "lease-smoke",
    ownerPID: 999999,
    mode: "start_new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  const result = await stopAutoEvolveRun({
    cwd: repoRoot,
    outDir,
    mode: "pause",
    reason: "smoke test",
  })

  const state = await readJsonFile<any>(path.join(outDir, "orchestrator-state.json"), { validatePaths: false })
  assert(state.trainResults.find((row: any) => row.id === "task-a")?.status === "recovery_pending", "running row becomes recovery_pending")
  assert(state.trainResults.find((row: any) => row.id === "task-b")?.status === "verified_success", "verified row remains verified")
  assert(state.trainResults.find((row: any) => row.id === "task-c")?.status === "queued", "queued row remains queued")
  assert(state.stop?.status === "paused_by_user", "state stop metadata is written")

  const ledger = await readJsonFile<any>(path.join(outDir, "task-ledger.json"), { validatePaths: false })
  assert(ledger.tasks["task-a"].status === "recovery_pending", "ledger task becomes recovery_pending")
  assert(ledger.tasks["task-a"].allowResume === true, "ledger remains resumable")
  assert(ledger.tasks["task-a"].attempts[0].status === "recovery_pending", "ledger attempt becomes recovery_pending")

  const campaign = await readJsonFile<any>(path.join(campaignDir, "campaign.json"), { validatePaths: false })
  assert(campaign.status === "recovery_pending", "campaign becomes recovery_pending")
  assert(typeof campaign.ownerPID !== "number", "campaign owner PID is cleared")
  assert(campaign.recovery?.action === "restart_round", "campaign recovery action is written")

  assert(!(await exists(path.join(outDir, "benchmark-leases", "task-a.json"))), "benchmark lease is released")
  assert(await exists(path.join(outDir, "artifact-manifest.stop.json")), "artifact manifest is written")
  assert(result.resumable === true, "stop result is resumable")
  assert(result.reportPath && (await exists(result.reportPath)), "stop report json is written")
  assert(result.markdownPath && (await exists(result.markdownPath)), "stop report markdown is written")
  assert(result.transactionDir && (await exists(path.join(result.transactionDir, "transaction.json"))), "stop transaction is written")

  await rm(root, { recursive: true, force: true })
  console.log("smoke-stop-manager passed")
}

main().catch(async (error) => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
