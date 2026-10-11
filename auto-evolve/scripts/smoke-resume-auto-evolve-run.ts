import path from "node:path"
import { mkdir, rm, writeFile } from "node:fs/promises"

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const autoRoot = path.join(repoRoot, "auto-evolve")
const fixtureRoot = path.join(autoRoot, "runtime-state", "tmp-smoke-resume-auto-evolve-run")
const taskPackRoot = path.join(fixtureRoot, "task-pack")
const trainSplit = path.join(taskPackRoot, "splits", "train.json")

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
  await writeJson(trainSplit, ["a", "b", "c"])
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
      mergeExecutionMode: "skillopt",
      mergeAsSkillOpt: {
        enabled: true,
        projectRoot: "C:/smoke/SkillOpt",
        configPath: "configs/smoke.yaml",
        pythonCommand: "python",
        bridgeScript: "scripts/skillopt-merge-bridge.py",
        batchSize: 5,
        workers: 2,
        timeoutMs: 123456,
        initialSkillPath: "C:/smoke/initial-skill",
        optimizerBackend: "smoke-backend",
        optimizerModel: "smoke-model",
        optimizerBaseUrl: "http://127.0.0.1:9999/v1",
        optimizerApiKeyEnv: "SMOKE_API_KEY",
        reasoningEffort: "medium",
      },
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
    {
      cwd: repoRoot,
      env: { ...process.env, AUTO_EVOLVE_BUN_EXE: process.execPath },
      stdout: "pipe",
      stderr: "pipe",
    },
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
  assert(result.bunExe === process.execPath, "explicit AUTO_EVOLVE_BUN_EXE was not preserved")
  assert(result.benchmarkArgs?.includes("--out"), "benchmark args missing --out")
  assert(result.benchmarkArgs?.includes(fixtureRoot), "benchmark args do not preserve fixture out")
  assert(result.benchmarkArgs?.includes("--merge-execution-mode"), "merge backend was not preserved")
  assert(result.benchmarkArgs?.includes("skillopt"), "merge-as-opt mode was not preserved")
  assert(result.benchmarkArgs?.includes("smoke-model"), "SkillOpt optimizer model was not preserved")
  assert(result.benchmarkArgs?.includes("SMOKE_API_KEY"), "SkillOpt API key env name was not preserved")
  assert(!result.benchmarkArgs?.includes("actual-secret-value"), "SkillOpt API key value leaked into resume args")
  assert(!result.stopArchive, "dry-run must not archive STOP_REQUESTED")
  console.log(JSON.stringify({ passed: true, selected: result.selected, launcher: result.launcher.launcherPath }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
