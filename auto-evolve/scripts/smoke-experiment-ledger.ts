import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { readJsonFile, pathExists } from "../orchestrator/fs"
import { updateExperimentLedger } from "./update-experiment-ledger"

async function writeJson(target: string, value: unknown) {
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function assertInsideAutoEvolveTemp(target: string) {
  const root = path.resolve(import.meta.dir, "..", ".tmp-smoke", "experiment-ledger")
  const resolved = path.resolve(target)
  const rel = path.relative(root, resolved)
  assert(!rel.startsWith("..") && !path.isAbsolute(rel), `refusing to delete outside smoke root: ${resolved}`)
}

async function main() {
  const smokeRoot = path.resolve(import.meta.dir, "..", ".tmp-smoke", "experiment-ledger")
  await assertInsideAutoEvolveTemp(path.join(smokeRoot, "placeholder"))
  await rm(smokeRoot, { recursive: true, force: true })

  const benchmarkRun = path.join(smokeRoot, "benchmark-run")
  await writeJson(path.join(benchmarkRun, "orchestrator-state.json"), {
    runID: "benchmark-run",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:01:00.000Z",
    phase: "training",
    trainIDs: ["case-a", "case-b"],
    testIDs: ["case-t"],
    config: {
      label: "ledger-smoke",
      taskPackRoot: "auto-evolve/task-packs/real-long-tasks/smoke",
      trainSplit: "splits/train.json",
      testSplit: "splits/test.json",
      concurrency: 2,
      campaignRounds: 7,
      mergeExecutionMode: "merge-as-old",
      directChat: { skillInputMode: "full" },
    },
    trainResults: [
      { id: "case-a", status: "verified_success", verified: true, updatedAt: "2026-07-07T00:01:00.000Z" },
      { id: "case-b", status: "failed", verified: false, updatedAt: "2026-07-07T00:01:00.000Z" },
    ],
  })
  await updateExperimentLedger(benchmarkRun)
  const benchmarkSummary = await readJsonFile<any>(path.join(benchmarkRun, "experiment-ledger", "run-summary.json"))
  assert.equal(benchmarkSummary.totals.trainTotal, 2)
  assert.equal(benchmarkSummary.totals.trainPassed, 1)
  assert.equal(benchmarkSummary.accuracy.train, 0.5)
  assert(await pathExists(path.join(benchmarkRun, "experiment-ledger", "paper-table-ready.csv")))
  const benchmarkValidationRows = (await readFile(path.join(benchmarkRun, "experiment-ledger", "validation-ledger.jsonl"), "utf8"))
    .trim()
    .split(/\r?\n/g)
    .map((line) => JSON.parse(line))
  assert.equal(benchmarkValidationRows.length, 2)
  assert.equal(benchmarkValidationRows[0].validatorID, "benchmark-final-status")

  const directRun = path.join(smokeRoot, "direct-chat-run")
  await writeJson(path.join(directRun, "config.snapshot.json"), {
    dataset: { dataset: "officeqa" },
    caseIDs: ["case-1", "case-2"],
    modelIDs: ["model-a"],
    runModeID: "full-no-skill",
    skillInputMode: "full",
    noSkillOnly: true,
    globalConcurrency: 1,
  })
  await writeJson(path.join(directRun, "summary.json"), {
    dataset: { dataset: "officeqa" },
    createdAt: "2026-07-07T00:00:00.000Z",
  })
  await writeJson(path.join(directRun, "results", "case-1", "model-a", "result.json"), {
    caseID: "case-1",
    passed: false,
    modelID: "model-a",
    provider: "smoke-provider",
    resolvedModel: "model-a",
    skillMode: "no-skill",
    latencyMs: 1234,
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  })
  await updateExperimentLedger(directRun)
  await updateExperimentLedger(directRun)
  const directSummary = await readJsonFile<any>(path.join(directRun, "experiment-ledger", "run-summary.json"))
  assert.equal(directSummary.totals.baselineTotal, 1)
  assert.equal(directSummary.totals.baselinePassed, 0)
  assert.equal(directSummary.cost.totalTokens, 12)
  assert.equal(directSummary.cost.calls, 1)
  const directValidationRows = (await readFile(path.join(directRun, "experiment-ledger", "validation-ledger.jsonl"), "utf8"))
    .trim()
    .split(/\r?\n/g)
    .map((line) => JSON.parse(line))
  assert.equal(directValidationRows.length, 1)
  assert.equal(directValidationRows[0].validatorID, "direct-chat-scorer")

  await rm(smokeRoot, { recursive: true, force: true })
  console.log("smoke-experiment-ledger passed")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
