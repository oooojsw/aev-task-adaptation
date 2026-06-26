import path from "node:path"
import { mkdir } from "node:fs/promises"
import { autoEvolvePath, readJsonFile, writeJsonFile } from "../orchestrator/fs"
import {
  buildHistoryContext,
  initializeBenchmarkHistory,
  isCampaignAuthorizedForContext,
  lineageForAttempt,
  nextAttemptID,
  readBenchmarkHistory,
} from "../orchestrator/history-manager"

const cwd = path.resolve(import.meta.dir, "..", "..")
const root = autoEvolvePath(cwd, ".tmp-history-manager-smoke", String(Date.now()))
await mkdir(root, { recursive: true })

const taskPackRoot = path.join(root, "task-pack")
const outDir = path.join(root, "run")
const oldCampaign = {
  id: "old-campaign",
  title: "smoke-campaign-T001",
  mode: "graph_iterative",
  baseSpecPath: path.join(taskPackRoot, "tasks", "T001", "spec.json"),
  maxRounds: 7,
  currentRound: 1,
  status: "recovery_pending",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const first = await initializeBenchmarkHistory({
  outDir,
  runID: "history-smoke",
  taskIDs: ["T001", "T002"],
  historyPolicy: "resume-current-generation",
  taskPackRoot,
})
const firstContext = buildHistoryContext({ outDir, manifest: first, taskPackRoot })
const firstAttempt = nextAttemptID(first.tasks.T001)
const scopedCampaign = {
  ...oldCampaign,
  id: "new-campaign",
  runLineage: lineageForAttempt({ context: firstContext, taskID: "T001", attemptID: firstAttempt, specHash: "spec-v1" }),
  reuse: { allowed: true, scope: "current-generation-only", tainted: false, superseded: false },
}

if (isCampaignAuthorizedForContext(oldCampaign as any, firstContext, "T001")) {
  throw new Error("Legacy campaign without lineage should not be authorized.")
}
if (!isCampaignAuthorizedForContext(scopedCampaign as any, firstContext, "T001")) {
  throw new Error("Scoped campaign should be authorized for its own generation.")
}
if (!isCampaignAuthorizedForContext(scopedCampaign as any, firstContext, "T001", "spec-v1")) {
  throw new Error("Scoped campaign should be authorized for its exact spec hash.")
}
if (isCampaignAuthorizedForContext(scopedCampaign as any, firstContext, "T001", "spec-v2")) {
  throw new Error("Scoped campaign should not be authorized for a different spec hash.")
}

await writeJsonFile(path.join(outDir, "orchestrator-state.json"), {
  trainResults: [{ id: "T001", status: "verified_success", campaignDir: path.join(root, "verified-campaign") }],
})
const second = await initializeBenchmarkHistory({
  outDir,
  runID: "history-smoke",
  taskIDs: ["T001", "T002"],
  historyPolicy: "fresh-non-verified",
  taskPackRoot,
  trustedVerified: [{ id: "T001", campaignDir: path.join(root, "verified-campaign") }],
})
const secondContext = buildHistoryContext({ outDir, manifest: second, taskPackRoot })
if (second.currentGenerationID === first.currentGenerationID) {
  throw new Error("fresh-non-verified should create a new generation.")
}
if (second.tasks.T001?.status !== "verified_success") {
  throw new Error("fresh-non-verified should keep trusted verified rows.")
}
if (second.tasks.T002?.status !== "queued") {
  throw new Error("fresh-non-verified should queue non-verified rows.")
}
if (isCampaignAuthorizedForContext(scopedCampaign as any, secondContext, "T001")) {
  throw new Error("Previous generation campaign should not be authorized in the fresh generation.")
}

const reloaded = await readBenchmarkHistory(outDir)
if (reloaded?.schema !== "auto-evolve/benchmark-history/v1") {
  throw new Error("Ledger did not persist with the expected schema.")
}

console.log(`history-manager smoke passed: ${root}`)
