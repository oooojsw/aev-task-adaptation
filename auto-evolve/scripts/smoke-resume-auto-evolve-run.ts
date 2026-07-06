import path from "node:path"
import { mkdir, rm, writeFile } from "node:fs/promises"

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const autoRoot = path.join(repoRoot, "auto-evolve")
const fixtureRoot = path.join(autoRoot, "runtime-state", "tmp-smoke-resume-auto-evolve-run")
const taskPackRoot = path.join(autoRoot, "task-packs", "real-long-tasks", "spreadsheetbench-learnbench")
const trainSplit = path.join(taskPackRoot, "splits", "train-skillopt-official.json")

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), "utf8")
}

async function main() {
  await rm(fixtureRoot, { recursive: true, force: true })
  await mkdir(fixtureRoot, { recursive: true })
  await writeJson(path.join(fixtureRoot, "orchestrator-state.json"), {
    runID: "tmp-smoke-resume-auto-evolve-run",
    phase: "training",
    updatedAt: new Date().toISOString(),
    trainResults: [
      { id: "a", status: "verified_success", verified: true },
      { id: "b", status: "recovery_pending" },
      { id: "c", status: "queued" },
    ],
  })
  await writeJson(path.join(fixtureRoot, "run-manifest.json"), {
    schema: "auto-evolve/run-manifest/v1",
    runID: "tmp-smoke-resume-auto-evolve-run",
    runKind: "benchmark-long-task",
    rootDir: fixtureRoot,
    taskPackRoot,
    splitPath: trainSplit,
    resume: { mustUseSameOut: true },
  })
  await writeJson(path.join(fixtureRoot, "benchmark-plan.json"), {
    config: {
      label: "tmp-smoke-resume-auto-evolve-run",
      taskPackRoot,
      trainSplit,
      outDir: fixtureRoot,
      mode: "full-pipeline",
      stopAfter: "training",
      concurrency: 2,
      stageConcurrency: { training: 2, hierarchicalMerge: 1, trainReplay: 1, testBlank: 1, baseline: 1 },
      campaignRounds: 7,
      validateRounds: 1,
      repairAttempts: 0,
      historyPolicy: "fresh-non-verified",
      resumeMode: "safe-non-terminal",
      runMerge: false,
      runTrainReplay: false,
      runTest: false,
      runBaseline: false,
    },
  })
  await writeJson(path.join(fixtureRoot, "STOP_REQUESTED.json"), {
    schema: "auto-evolve/stop-request/v1",
    reason: "smoke fixture",
  })

  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      "auto-evolve/scripts/resume-auto-evolve-run.ts",
      "--dry-run",
      "--out",
      fixtureRoot,
    ],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  assert(code === 0, `resume dry-run failed: ${stderr}`)
  const result = JSON.parse(stdout)
  assert(result.dryRun === true, "expected dryRun=true")
  assert(result.selected?.runID === "tmp-smoke-resume-auto-evolve-run", "selected wrong run")
  assert(result.selected?.verified === 1, "verified count mismatch")
  assert(result.launcher?.launcherPath, "launcher path missing")
  assert(result.benchmarkArgs?.includes("--out"), "benchmark args missing --out")
  assert(result.benchmarkArgs?.includes(fixtureRoot), "benchmark args do not preserve fixture out")
  assert(!result.stopArchive, "dry-run must not archive STOP_REQUESTED")
  console.log(JSON.stringify({ passed: true, selected: result.selected, launcher: result.launcher.launcherPath }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
