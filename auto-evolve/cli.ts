import process from "node:process"
import path from "node:path"
import { readdir, stat } from "node:fs/promises"
import { ensureLayout } from "./orchestrator/fs"
import { runBootstrap } from "./orchestrator/bootstrap"
import { runCase } from "./orchestrator/case-runner"
import { runRound } from "./orchestrator/round-runner"
import { runBaseline } from "./orchestrator/baseline-runner"
import { loadConfig, validateAllCases } from "./orchestrator/schema"
import { ensureExperimentMonitor } from "./orchestrator/monitor"
import { runPropagation } from "./orchestrator/propagation/run"
import { validateReversePropagationControlPlane } from "./orchestrator/reverse-propagation-control/validate"
import { longTaskPaths, longTaskRunPaths } from "./orchestrator/long-task/repository"
import { validateLongTaskLayout, validateLongTaskRun } from "./orchestrator/long-task/validate"
import { runLongTask, resumeLongTask } from "./orchestrator/long-task/runner"
import { runLongTaskCampaign, resumeLongTaskCampaign } from "./orchestrator/long-task-campaign/runner"
import { runBlankEval } from "./orchestrator/blank-eval/runner"
import type { BlankEvalMode } from "./orchestrator/blank-eval/contract"
import { runSkillsBenchTask, type SkillsBenchMode } from "./orchestrator/skillsbench-adapter"
import { resetExperienceWorkspace, restoreLatestArchivedExperienceWorkspace } from "./orchestrator/experience-archive"
import { cleanupAllRuntimeProcesses } from "./orchestrator/runtime-process-registry"

let shuttingDown = false

function installShutdownCleanup() {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]
  for (const signal of signals) {
    process.once(signal, () => {
      if (shuttingDown) return
      shuttingDown = true
      const code = signal === "SIGINT" ? 130 : 143
      const timer = setTimeout(() => {
        console.error(`Forced exit after ${signal}; runtime child cleanup did not finish in time.`)
        process.exit(code)
      }, 10_000)
      void cleanupAllRuntimeProcesses()
        .then((result) => {
          if (result.trackedCount > 0) {
            console.error(
              `Caught ${signal}; cleaned runtime children: tracked=${result.trackedCount}, killed=${result.killedCount}, remaining=${result.remainingCount}.`,
            )
          }
        })
        .catch((error) => {
          console.error(`Caught ${signal}; runtime child cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => {
          clearTimeout(timer)
          process.exit(code)
        })
    })
  }
}

installShutdownCleanup()

async function hasDir(dir: string) {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

async function resolveWorkspaceCwd() {
  const cwd = process.cwd()
  if (path.basename(cwd).toLowerCase() === "auto-evolve" && (await hasDir(path.join(cwd, "orchestrator")))) {
    return path.dirname(cwd)
  }
  if (await hasDir(path.join(cwd, "auto-evolve"))) return cwd
  const parent = path.dirname(cwd)
  if (await hasDir(path.join(parent, "auto-evolve"))) return parent
  return cwd
}

function printHelp() {
  console.log(`auto-evolve commands:

  init
    Ensure the auto-evolve workspace, templates, and knowledge files exist.

  validate
    Validate auto-evolve/config.json and every dataset case.

  bootstrap [--force]
    Ask OpenCode to generate or refresh the Markdown experience workspace from labeled cases.
    Optional: --method <method-id>

  reset-experience
    Archive the current tracked expert experience into history + latest, then reset the live workspace to the minimal legal seed.
    Optional: --note <text>

  restore-experience
    Restore the live expert experience workspace from the latest archive snapshot.

  run-long-task --spec <path>
    Run a validator-driven long-running task. The system bootstraps its own work graph from the task spec and validators.

  run-blank-eval --spec <path> --skill-root <path[,path]>
    Run one hermetic blank-agent evaluation: material + guidance + formal skill in, task output + validators out.
    Optional: --run-root <path> --mode <train-backtest|test|deployment|smoke> --source-id <id> --no-reset

  run-long-task-campaign --spec <path>
    Run a multi-round long-task campaign. Each round harvests failure evidence and learning into carryover context for the next round.
    Optional: --force-new skips matching live/recoverable campaign auto-resume and starts a fresh campaign.

  resume-long-task-campaign --campaign <campaign-id> --spec <path>
    Resume an existing long-task campaign from the same campaign ID and continue at the correct round boundary.

  resume-long-task --run <run-id>
    Resume an unfinished long-running task from its existing run directory.

  run-case --case <case-id>
    Solve one case with the current experience workspace, then invoke the knowledge maintainer and retry on failure.
    Optional: --method <method-id> --mode <learn|eval> --split <train|test|all>

  run-round
    Traverse cases in order, letting the experience workspace evolve across the round.
    Optional: --method <method-id> --limit <number> --split <train|test|all> --mode <learn|eval>

  run-baseline
    Produce a unified baseline scorecard for the current system, including train/test rounds and knowledge snapshots.
    Optional: --method <method-id> --train-limit <number> --test-limit <number> --skip-bootstrap --force-bootstrap

  run-skillsbench --root <skillsbench-root> --task <task-id> --mode <short|long|campaign>
    Run a real SkillsBench task through the auto-evolve adapter and official Docker verifier.
    Optional: --attempts <number> --timeout-ms <number> --rounds <number> --skip-docker-build

  run-propagation
    Run an initial third-layer propagation campaign on an experimental branch without touching the canonical experience workspace.
    Optional: --method <propagation-method-id|second-layer-method-id> --maintenance-method <method-id> --source-ref <canonical|branch:name|commit:id|optimization:id> --branch <name> --train-limit <number> --test-limit <number>
`)
}

function getFlag(args: string[], name: string) {
  return args.includes(name)
}

function getOption(args: string[], name: string) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  return args[index + 1]
}

function getListOption(args: string[], name: string) {
  const value = getOption(args, name)
  if (!value) return []
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

async function commandInit() {
  const result = await ensureLayout(process.cwd())
  console.log(`auto-evolve initialized at ${result.autoEvolveRoot}`)
  if (result.created.length) {
    console.log("Created:")
    for (const item of result.created) console.log(`- ${item}`)
  } else {
    console.log("No new files were needed.")
  }
}

async function commandValidate() {
  await ensureLayout(process.cwd())
  const config = await loadConfig(process.cwd())
  const report = await validateAllCases(process.cwd(), config)
  const controlPlaneReport = await validateReversePropagationControlPlane(process.cwd(), config)
  const longTaskRoot = longTaskPaths(process.cwd())
  const longTaskReport = await validateLongTaskLayout(longTaskRoot)
  const longTaskRunErrors: string[] = []

  if (!longTaskReport.errors.length) {
    const runDirs = (await readdir(longTaskRoot.runsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)

    for (const runID of runDirs) {
      const runReport = await validateLongTaskRun(longTaskRunPaths(longTaskRoot, runID))
      for (const error of runReport.errors) {
        longTaskRunErrors.push(`[long-task run ${runID}] ${error}`)
      }
    }

    console.log(`Long-task runs validated: ${runDirs.length}`)
  }

  console.log(`Config: OK (${config.configPath})`)
  console.log(`Cases discovered: ${report.caseCount}`)
  console.log(
    `Reverse-propagation control plane: ${controlPlaneReport.componentCount} components, ${controlPlaneReport.recipeCount} recipes, ${controlPlaneReport.stateChannelCount} state channels`,
  )
  console.log("Long-task module layout: checked")

  const allErrors = [...report.errors, ...controlPlaneReport.errors, ...longTaskReport.errors, ...longTaskRunErrors]

  if (!allErrors.length) {
    console.log("Validation: OK")
    return
  }

  console.error("Validation errors:")
  for (const error of allErrors) console.error(`- ${error}`)
  process.exitCode = 1
}

async function commandBootstrap(args: string[]) {
  await ensureLayout(process.cwd())
  const config = await loadConfig(process.cwd())
  await ensureExperimentMonitor(process.cwd(), config).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Monitor warning: ${message}`)
  })
  const result = await runBootstrap(process.cwd(), {
    force: getFlag(args, "--force"),
    methodID: getOption(args, "--method"),
  })
  console.log(result.message)
  if (result.runDir) {
    console.log(`Run: ${result.runDir}`)
  }
}

async function commandResetExperience(args: string[]) {
  await ensureLayout(process.cwd())
  const config = await loadConfig(process.cwd())
  const result = await resetExperienceWorkspace(process.cwd(), config, {
    note: getOption(args, "--note"),
  })
  console.log(`Archived experience: ${result.archived.archive.latestRoot}`)
  console.log(`Archived files: ${result.archived.metadata.fileCount}`)
  console.log(`Workspace reset at: ${result.resetAt}`)
  console.log(`Workspace root: ${result.workspaceRoot}`)
  console.log(`Seeded files: ${result.seededFiles.join(", ")}`)
}

async function commandRestoreExperience() {
  await ensureLayout(process.cwd())
  const config = await loadConfig(process.cwd())
  const result = await restoreLatestArchivedExperienceWorkspace(process.cwd(), config)
  console.log(`Restored from archive: ${result.archive.latestRoot}`)
  console.log(`Workspace root: ${result.workspaceRoot}`)
  console.log(`Restored files: ${result.restoredFiles.join(", ")}`)
}

async function commandRunCase(args: string[]) {
  await ensureLayout(process.cwd())
  const config = await loadConfig(process.cwd())
  await ensureExperimentMonitor(process.cwd(), config).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Monitor warning: ${message}`)
  })
  const caseID = getOption(args, "--case")
  if (!caseID) {
    console.error("Missing required option: --case <case-id>")
    process.exit(1)
  }

  const methodID = getOption(args, "--method")
  const mode = getOption(args, "--mode")
  const split = getOption(args, "--split")
  if (mode && mode !== "learn" && mode !== "eval") {
    console.error("Invalid --mode value. Use learn or eval.")
    process.exit(1)
  }
  if (split && split !== "train" && split !== "test" && split !== "all") {
    console.error("Invalid --split value. Use train, test, or all.")
    process.exit(1)
  }

  const result = await runCase(process.cwd(), caseID, {
    methodID,
    mode: mode as "learn" | "eval" | undefined,
    split: split as "train" | "test" | "all" | undefined,
  })
  console.log(`Run: ${result.runDir}`)
  console.log(`Case: ${result.caseID}`)
  console.log(`Method: ${result.methodID}`)
  console.log(`Mode: ${result.mode}`)
  console.log(`Split: ${result.split}`)
  console.log(`Passed: ${result.evaluation.passed}`)
  console.log(`Attempts: ${result.attempts.length}`)
  console.log(`Summary: ${result.evaluation.summary}`)
  if (result.evaluation.mismatches.length) {
    console.log("Mismatches:")
    for (const mismatch of result.evaluation.mismatches) console.log(`- ${mismatch}`)
  }
}

async function commandRunRound(args: string[]) {
  await ensureLayout(process.cwd())
  const config = await loadConfig(process.cwd())
  await ensureExperimentMonitor(process.cwd(), config).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Monitor warning: ${message}`)
  })
  const limitValue = getOption(args, "--limit")
  const parsedLimit = limitValue ? Number.parseInt(limitValue, 10) : undefined
  const split = getOption(args, "--split")
  const mode = getOption(args, "--mode")
  if (limitValue && (!Number.isFinite(parsedLimit) || parsedLimit <= 0)) {
    console.error("Invalid --limit value. Use a positive integer.")
    process.exit(1)
  }
  if (split && split !== "train" && split !== "test" && split !== "all") {
    console.error("Invalid --split value. Use train, test, or all.")
    process.exit(1)
  }
  if (mode && mode !== "learn" && mode !== "eval") {
    console.error("Invalid --mode value. Use learn or eval.")
    process.exit(1)
  }

  const result = await runRound(process.cwd(), {
    methodID: getOption(args, "--method"),
    caseLimit: parsedLimit,
    split: split as "train" | "test" | "all" | undefined,
    mode: mode as "learn" | "eval" | undefined,
  })
  console.log(`Round: ${result.roundDir}`)
  console.log(`Method: ${result.methodID}`)
  console.log(`Split: ${result.split}`)
  console.log(`Mode: ${result.mode}`)
  console.log(`Case limit: ${result.caseLimit}`)
  console.log(`Total: ${result.totalCases}`)
  console.log(`Passed: ${result.passedCases}`)
  console.log(`Failed: ${result.failedCases}`)
  for (const item of result.cases) {
    console.log(`- ${item.caseID}: ${item.passed ? "passed" : "failed"} in ${item.attempts} attempt(s)`)
  }
}

async function commandRunBaseline(args: string[]) {
  await ensureLayout(process.cwd())
  const config = await loadConfig(process.cwd())
  await ensureExperimentMonitor(process.cwd(), config).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Monitor warning: ${message}`)
  })
  const trainLimitValue = getOption(args, "--train-limit")
  const testLimitValue = getOption(args, "--test-limit")
  const parsedTrainLimit = trainLimitValue ? Number.parseInt(trainLimitValue, 10) : undefined
  const parsedTestLimit = testLimitValue ? Number.parseInt(testLimitValue, 10) : undefined
  if (trainLimitValue && (!Number.isFinite(parsedTrainLimit) || parsedTrainLimit <= 0)) {
    console.error("Invalid --train-limit value. Use a positive integer.")
    process.exit(1)
  }
  if (testLimitValue && (!Number.isFinite(parsedTestLimit) || parsedTestLimit <= 0)) {
    console.error("Invalid --test-limit value. Use a positive integer.")
    process.exit(1)
  }

  const result = await runBaseline(process.cwd(), {
    methodID: getOption(args, "--method"),
    trainLimit: parsedTrainLimit,
    testLimit: parsedTestLimit,
    skipBootstrap: getFlag(args, "--skip-bootstrap"),
    forceBootstrap: getFlag(args, "--force-bootstrap"),
  })
  console.log(`Baseline: ${result.baselineDir}`)
  console.log(`Method: ${result.methodID}`)
  console.log(`Bootstrap used: ${result.bootstrapUsed}`)
  if (result.bootstrapRunDir) {
    console.log(`Bootstrap run: ${result.bootstrapRunDir}`)
  }
  console.log(
    `Train: ${result.trainRound.passedCases}/${result.trainRound.totalCases} passed, accepted refines ${result.trainRound.acceptedRefines}, rejected refines ${result.trainRound.rejectedRefines}`,
  )
  console.log(
    `Test: ${result.testRound.passedCases}/${result.testRound.totalCases} passed, accepted refines ${result.testRound.acceptedRefines}, rejected refines ${result.testRound.rejectedRefines}`,
  )
}

async function commandRunSkillsBench(args: string[]) {
  await ensureLayout(process.cwd())
  const root = getOption(args, "--root")
  const taskID = getOption(args, "--task")
  const mode = getOption(args, "--mode")
  const attemptsValue = getOption(args, "--attempts")
  const timeoutValue = getOption(args, "--timeout-ms")
  const roundsValue = getOption(args, "--rounds")
  const attempts = attemptsValue ? Number.parseInt(attemptsValue, 10) : undefined
  const timeoutMs = timeoutValue ? Number.parseInt(timeoutValue, 10) : undefined
  const rounds = roundsValue ? Number.parseInt(roundsValue, 10) : undefined

  if (!root) {
    console.error("Missing required option: --root <skillsbench-root>")
    process.exit(1)
  }
  if (!taskID) {
    console.error("Missing required option: --task <task-id>")
    process.exit(1)
  }
  if (mode !== "short" && mode !== "long" && mode !== "campaign") {
    console.error("Invalid --mode value. Use short, long, or campaign.")
    process.exit(1)
  }
  if (attemptsValue && (!Number.isFinite(attempts) || attempts <= 0)) {
    console.error("Invalid --attempts value. Use a positive integer.")
    process.exit(1)
  }
  if (timeoutValue && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    console.error("Invalid --timeout-ms value. Use a positive integer.")
    process.exit(1)
  }
  if (roundsValue && (!Number.isFinite(rounds) || rounds <= 0)) {
    console.error("Invalid --rounds value. Use a positive integer.")
    process.exit(1)
  }

  // Ensure cwd is repo root (parent of auto-evolve/), not the auto-evolve/ subdirectory itself.
  const cwd = path.basename(process.cwd()) === "auto-evolve" ? path.dirname(process.cwd()) : process.cwd()


  // Resolve task root: check for SkillLearnBench-style nested layout first.
  // SkillLearnBench places instances under <root>/tasks/<family>/<instance>/
  // while the plain skillsbench layout uses <root>/tasks/<task>/ directly.
  let taskRoot: string | undefined
  const directTaskRoot = path.resolve(root, "tasks", taskID)
  if (await stat(path.join(directTaskRoot, "instruction.md")).then(() => true).catch(() => false)) {
    taskRoot = directTaskRoot
  } else {
    // Try SkillLearnBench layout: look for <family>/<family>-1 subdirectory
    const entries = await readdir(directTaskRoot, { withFileTypes: true }).catch(() => [])
    const instances = entries
      .filter((e) => e.isDirectory() && e.name.startsWith(`${taskID}-`))
      .sort()
    if (instances.length > 0) {
      taskRoot = path.join(directTaskRoot, instances[0].name)
    }
  }

  const result = await runSkillsBenchTask({
    cwd,
    taskRoot,
    root,
    taskID,
    mode: mode as SkillsBenchMode,
    attempts,
    timeoutMs,
    rounds,
    skipDockerBuild: getFlag(args, "--skip-docker-build"),
  })
  console.log(`SkillsBench task: ${result.taskID}`)
  console.log(`Mode: ${result.mode}`)
  console.log(`Passed: ${result.passed}`)
  console.log(`Run root: ${result.runRoot}`)
  console.log(`Workspace: ${result.workDir}`)
  if ("runDir" in result) console.log(`Long-task run: ${result.runDir}`)
  if ("summaryPath" in result) console.log(`Summary: ${result.summaryPath}`)
}

async function commandRunMultiInstance(args: string[]) {
  await ensureLayout(process.cwd())
  const benchOpt = (getOption(args, "--bench") ?? "skillsbench").toLowerCase()
  const skillsbenchRoot = getOption(args, "--root")
  const taskID = getOption(args, "--task")
  const instanceList = getOption(args, "--instances")
  const testInstanceList = getOption(args, "--test-instances")
  const autoSplit = getOption(args, "--auto-split")
  const labelOpt = getOption(args, "--label")
  const roundsValue = getOption(args, "--rounds")
  const fanoutLimitValue = getOption(args, "--fanout-limit")
  const skipMerge = getFlag(args, "--skip-merge")
  const skipValidate = getFlag(args, "--skip-validate")
  const validateRoundsValue = getOption(args, "--validate-rounds")
  const validateLimitValue = getOption(args, "--validate-limit")
  const repairAttemptsValue = getOption(args, "--repair-attempts")
  const validateRounds = validateRoundsValue ? Number.parseInt(validateRoundsValue, 10) : 2
  const validateLimit = validateLimitValue ? Number.parseInt(validateLimitValue, 10) : undefined
  const repairAttempts = repairAttemptsValue ? Number.parseInt(repairAttemptsValue, 10) : 3
  const rounds = roundsValue ? Number.parseInt(roundsValue, 10) : 5
  const fanoutLimit = fanoutLimitValue ? Number.parseInt(fanoutLimitValue, 10) : undefined

  if (benchOpt !== "skillsbench" && benchOpt !== "skilllearnbench") {
    console.error("Invalid --bench value. Use skillsbench or skilllearnbench.")
    process.exit(1)
  }
  if (!skillsbenchRoot) {
    console.error("Missing required option: --root <bench-root>")
    process.exit(1)
  }
  if (!taskID) {
    console.error("Missing required option: --task <task-name>")
    process.exit(1)
  }
  if (!Number.isFinite(rounds) || rounds <= 0) {
    console.error("Invalid --rounds value. Use a positive integer.")
    process.exit(1)
  }

  const cwd = path.basename(process.cwd()) === "auto-evolve" ? path.dirname(process.cwd()) : process.cwd()

  const { loadPipeline, freezePipeline } = await import("./orchestrator/protocol-plugins/pipeline-config")
  const protocolFile = getOption(args, "--protocol-run-config")
  const pipeline = protocolFile ? await loadPipeline(path.resolve(cwd, protocolFile)) : undefined
  if (pipeline && repairAttempts > 0 && !pipeline.repairAuthor) throw new Error("Protocol repair author required, or set --repair-attempts 0")

  // Discover the available instance task roots for this bench+task.
  // Layout differences:
  //   - skillsbench:      <root>/tasks/<task>/                (1 instance)
  //   - skilllearnbench:  <root>/tasks/<task>/<task>-<N>/     (N instances)
  const taskFamilyDir = path.join(skillsbenchRoot, "tasks", taskID)
  const discovered = await discoverBenchInstances(taskFamilyDir, benchOpt as "skillsbench" | "skilllearnbench", taskID)
  if (discovered.length === 0) {
    console.error(`No instance directories found under ${taskFamilyDir}`)
    process.exit(1)
  }

  // Resolve --instances and --test-instances. Both accept "all" to mean
  // every discovered instance, or a comma-separated list of ids.
  let trainIDs: string[] = []
  let testIDs: string[] = []
  if (autoSplit) {
    const ratio = Number.parseFloat(autoSplit)
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
      console.error("Invalid --auto-split value. Use a fraction in (0, 1), e.g. 0.3 for 30% test.")
      process.exit(1)
    }
    // Stable deterministic split: sort discovered ids, pick the last
    // ceil(ratio * N) as test, the rest as train.
    const sorted = [...discovered].sort((a, b) => a.id.localeCompare(b.id))
    const testCount = Math.max(1, Math.ceil(sorted.length * ratio))
    testIDs = sorted.slice(-testCount).map((d) => d.id)
    trainIDs = sorted.slice(0, sorted.length - testCount).map((d) => d.id)
    if (trainIDs.length === 0) {
      console.error(
        `--auto-split=${ratio} would leave no training instances (only ${sorted.length} discovered).`,
      )
      process.exit(1)
    }
  } else {
    if (!instanceList) {
      console.error("Missing required option: --instances <ids|all> (or use --auto-split <ratio>)")
      process.exit(1)
    }
    trainIDs = resolveInstanceList(instanceList, discovered)
    if (testInstanceList) {
      testIDs = resolveInstanceList(testInstanceList, discovered)
    }
  }
  if (trainIDs.length === 0) {
    console.error("Train instance set is empty.")
    process.exit(1)
  }
  // Sanity: no instance can be both train and test.
  const overlap = trainIDs.filter((id) => testIDs.includes(id))
  if (overlap.length > 0) {
    console.error(`Instances cannot be both train and test: ${overlap.join(", ")}`)
    process.exit(1)
  }

  const allIDs = [...trainIDs, ...testIDs]
  const idToRoot = new Map(discovered.map((d) => [d.id, d.taskRoot]))
  const instanceSpecs = allIDs.map((id) => {
    const root = idToRoot.get(id)
    if (!root) {
      console.error(`Instance ${id} not found in ${taskFamilyDir}`)
      process.exit(1)
    }
    return {
      id,
      sourceTaskRoot: root!,
      engine: "skillsbench" as const,
      skillsbenchRoot,
      taskID: id,
      role: testIDs.includes(id) ? ("test" as const) : ("train" as const),
    }
  })

  const label = labelOpt ?? `${taskID}-multi`
  const { coordinatorRunID, createCoordinatorRun, runCoordinatorPhase1Fanout } = await import(
    "./orchestrator/multi-instance/coordinator"
  )
  const runID = coordinatorRunID(label)
  const runRoot = path.join(cwd, "auto-evolve", "runtime-state", "multi-instance-runs", runID)

  await freezePipeline(runRoot, pipeline)

  const state = await createCoordinatorRun({
    cwd,
    runRoot,
    label,
    rounds,
    instances: instanceSpecs,
    fanoutLimit,
  })
  console.log(`MultiInstance run: ${state.id}`)
  console.log(`Run root: ${runRoot}`)
  console.log(`Bench: ${benchOpt} | task: ${taskID}`)
  console.log(`Train (${trainIDs.length}): ${trainIDs.join(", ")}`)
  console.log(`Test  (${testIDs.length}): ${testIDs.join(", ") || "(none)"}`)
  console.log(`rounds=${rounds}${fanoutLimit ? `, fanoutLimit=${fanoutLimit}` : ""}`)
  console.log(`Phase 1 (fanout) starting…`)

  const summary = await runCoordinatorPhase1Fanout({ cwd, state })
  console.log(`Phase 1 complete:`)
  console.log(`  passed   : ${summary.passed}`)
  console.log(`  exhausted: ${summary.exhausted}`)
  console.log(`  failed   : ${summary.failed}`)
  console.log(`  skipped  : ${summary.skipped}`)
  console.log(`  duration : ${(summary.durationMs / 1000).toFixed(1)}s`)

  if (skipMerge) {
    console.log("--skip-merge set; stopping after Phase 1.")
    return
  }

  if (summary.passed !== trainIDs.length) {
    const missing = state.instances
      .filter((i) => i.role !== "test" && i.status !== "passed")
      .map((i) => `${i.id}:${i.status}`)
    const { appendCoordinatorLog, saveCoordinatorState } = await import("./orchestrator/multi-instance/repository")
    state.phase = "aborted"
    await appendCoordinatorLog(
      state,
      "warn",
      `Phase 1 gate blocked merge: ${summary.passed}/${trainIDs.length} train instances passed. Not passed: ${missing.join(", ")}`,
    )
    await saveCoordinatorState(state)
    console.log("Phase 1 gate blocked merge: not all training instances passed.")
    console.log(`  train passed: ${summary.passed}/${trainIDs.length}`)
    console.log(`  not passed  : ${missing.join(", ") || "none"}`)
    return
  }

  const { runCoordinatorPhase2Merge } = await import("./orchestrator/multi-instance/merger")
  console.log("Phase 2 (merge) starting…")
  const mergeOut = await runCoordinatorPhase2Merge({ cwd, state, protocolAuthor: pipeline?.mergeAuthor })
  console.log("Phase 2 complete:")
  console.log(`  merged skill: ${mergeOut.mergedSkillDir}`)
  console.log(`  contributed : ${mergeOut.contributingInstances.join(", ") || "(none)"}`)

  if (skipValidate) {
    console.log("--skip-validate set; stopping after Phase 2.")
    return
  }
  if (mergeOut.contributingInstances.length === 0) {
    console.log("No contributing instances; skipping Phase 3.")
    return
  }

  const { runCoordinatorPhase3Validate } = await import("./orchestrator/multi-instance/validator")
  console.log("Phase 3 train replay starting...")
  const trainOut = await runCoordinatorPhase3Validate({
    cwd,
    state,
    rounds: validateRounds,
    validateLimit,
    filter: (instance) => instance.role !== "test" && instance.status === "passed",
    repair:
      repairAttempts > 0
        ? {
            enabled: true,
            mode: "append_only",
            maxAttemptsPerCase: repairAttempts,
            protocolAuthor: pipeline?.repairAuthor,
          }
        : undefined,
  })
  console.log("Phase 3 train replay complete:")
  console.log(`  train replay: ${trainOut.passed}/${trainOut.total} passed`)
  console.log(`  failures    : ${trainOut.failed}`)
  console.log(`  regressions : ${trainOut.regressions.length} (${trainOut.regressions.join(", ") || "none"})`)
  console.log(`  repair      : attempts=${trainOut.repairAttempts ?? 0}, fixed=${trainOut.repairFixed ?? 0}`)
  console.log(`  duration    : ${(trainOut.durationMs / 1000).toFixed(1)}s`)

  if (trainOut.passed !== trainOut.total) {
    const { appendCoordinatorLog, saveCoordinatorState } = await import("./orchestrator/multi-instance/repository")
    state.phase = "aborted"
    await appendCoordinatorLog(
      state,
      "warn",
      `Phase 3 gate blocked test validation: train replay passed ${trainOut.passed}/${trainOut.total}.`,
    )
    await saveCoordinatorState(state)
    console.log("Phase 3 gate blocked test validation: train replay did not fully pass.")
    return
  }

  if (testIDs.length === 0) {
    console.log("No held-out test instances; stopping after train replay.")
    return
  }

  console.log("Phase 3 held-out test starting...")
  const testOut = await runCoordinatorPhase3Validate({
    cwd,
    state,
    rounds: validateRounds,
    validateLimit,
    filter: (instance) => instance.role === "test",
  })
  console.log("Phase 3 held-out test complete:")
  console.log(`  test passed: ${testOut.passed}/${testOut.total}`)
  console.log(`  failures   : ${testOut.failed}`)
  console.log(`  duration   : ${(testOut.durationMs / 1000).toFixed(1)}s`)
}

interface DiscoveredInstance {
  id: string
  taskRoot: string
}

async function discoverBenchInstances(
  taskFamilyDir: string,
  bench: "skillsbench" | "skilllearnbench",
  taskID: string,
): Promise<DiscoveredInstance[]> {
  const fs = await import("node:fs/promises")
  if (bench === "skillsbench") {
    // The family dir IS the only instance.
    return [{ id: taskID, taskRoot: taskFamilyDir }]
  }
  // SkillLearnBench: instances are subdirectories named "<task>-<n>".
  // Supports two layouts:
  //   Nested: <root>/tasks/<task>/<task>-<n>/
  //   Flat:   <root>/tasks/<task>-<n>/
  let entries = await fs.readdir(taskFamilyDir, { withFileTypes: true }).catch(() => [])
  let baseDir = taskFamilyDir
  if (entries.length === 0) {
    // Fallback: flat layout – look in parent tasks/ directory
    const tasksDir = path.dirname(taskFamilyDir)
    entries = await fs.readdir(tasksDir, { withFileTypes: true }).catch(() => [])
    baseDir = tasksDir
  }
  const out: DiscoveredInstance[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith(`${taskID}-`)) continue
    out.push({ id: entry.name, taskRoot: path.join(baseDir, entry.name) })
  }
  return out
}

function resolveInstanceList(raw: string, discovered: DiscoveredInstance[]): string[] {
  const trimmed = raw.trim()
  if (trimmed.toLowerCase() === "all") return discovered.map((d) => d.id)
  const ids = trimmed.split(",").map((s) => s.trim()).filter(Boolean)
  for (const id of ids) {
    if (!discovered.some((d) => d.id === id)) {
      console.error(`Instance not found in discovered list: ${id}`)
      process.exit(1)
    }
  }
  return ids
}

async function commandRunPropagation(args: string[]) {
  await ensureLayout(process.cwd())
  const config = await loadConfig(process.cwd())
  await ensureExperimentMonitor(process.cwd(), config).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Monitor warning: ${message}`)
  })

  const trainLimitValue = getOption(args, "--train-limit")
  const testLimitValue = getOption(args, "--test-limit")
  const parsedTrainLimit = trainLimitValue ? Number.parseInt(trainLimitValue, 10) : undefined
  const parsedTestLimit = testLimitValue ? Number.parseInt(testLimitValue, 10) : undefined
  if (trainLimitValue && (!Number.isFinite(parsedTrainLimit) || parsedTrainLimit <= 0)) {
    console.error("Invalid --train-limit value. Use a positive integer.")
    process.exit(1)
  }
  if (testLimitValue && (!Number.isFinite(parsedTestLimit) || parsedTestLimit <= 0)) {
    console.error("Invalid --test-limit value. Use a positive integer.")
    process.exit(1)
  }

  const result = await runPropagation(process.cwd(), {
    methodID: getOption(args, "--method"),
    maintenanceMethodID: getOption(args, "--maintenance-method"),
    sourceRef: getOption(args, "--source-ref"),
    branchName: getOption(args, "--branch"),
    trainLimit: parsedTrainLimit,
    testLimit: parsedTestLimit,
  })
  console.log(`Campaign: ${result.campaignDir}`)
  console.log(`Propagation method: ${result.propagationMethodID}`)
  console.log(`Maintenance method: ${result.maintenanceMethodID}`)
  console.log(`Source commit: ${result.sourceCommitID}`)
  console.log(`Branch: ${result.branchName}`)
  console.log(`Candidate commit: ${result.candidateCommitID}`)
  console.log(`Branch head: ${result.branchHeadCommitID}`)
  console.log(`Baseline: ${result.baselineDir}`)
}

async function commandRunLongTask(args: string[]) {
  const cwd = await resolveWorkspaceCwd()
  await ensureLayout(cwd)
  const config = await loadConfig(cwd)
  await ensureExperimentMonitor(cwd, config).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Monitor warning: ${message}`)
  })

  const specPath = getOption(args, "--spec")
  if (!specPath) {
    console.error("Missing required option: --spec <path-to-long-task-spec>")
    process.exit(1)
  }

  const result = await runLongTask({
    cwd,
    specPath,
  })
  console.log(`Long-task run: ${result.runID}`)
  console.log(`Run dir: ${result.runDir}`)
  console.log(`Status: ${result.status}`)
  console.log(`Summary: ${result.summaryPath}`)
}

async function commandRunBlankEval(args: string[]) {
  const cwd = await resolveWorkspaceCwd()
  await ensureLayout(cwd)
  const config = await loadConfig(cwd)
  await ensureExperimentMonitor(cwd, config).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Monitor warning: ${message}`)
  })

  const specPath = getOption(args, "--spec")
  if (!specPath) {
    console.error("Missing required option: --spec <path-to-long-task-spec>")
    process.exit(1)
  }
  const roots = getListOption(args, "--skill-root").map((item) => path.resolve(item))
  if (roots.length === 0) {
    console.error("Missing required option: --skill-root <path[,path]>")
    process.exit(1)
  }
  const mode = getOption(args, "--mode") ?? "deployment"
  if (mode !== "train-backtest" && mode !== "test" && mode !== "deployment" && mode !== "smoke") {
    console.error("Invalid --mode. Use train-backtest, test, deployment, or smoke.")
    process.exit(1)
  }

  const result = await runBlankEval({
    cwd,
    specPath,
    skillRoots: roots,
    runRoot: getOption(args, "--run-root"),
    sourceID: getOption(args, "--source-id"),
    mode: mode as BlankEvalMode,
    resetEditablePaths: !getFlag(args, "--no-reset"),
    promptInlinePaths: getListOption(args, "--prompt-inline").map((item) => path.resolve(item)),
  })
  console.log(`Blank eval: ${result.runID}`)
  console.log(`Run dir: ${result.runDir}`)
  console.log(`Passed: ${result.passed}`)
  console.log(`Summary: ${result.summary}`)
  console.log(`Result: ${result.resultPath}`)
}

async function commandRunLongTaskCampaign(args: string[]) {
  const cwd = await resolveWorkspaceCwd()
  await ensureLayout(cwd)
  const config = await loadConfig(cwd)
  await ensureExperimentMonitor(cwd, config).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Monitor warning: ${message}`)
  })

  const specPath = getOption(args, "--spec")
  if (!specPath) {
    console.error("Missing required option: --spec <path-to-long-task-campaign-spec>")
    process.exit(1)
  }
  const forceNew = args.includes("--force-new")
  const historyPayload = process.env.AUTO_EVOLVE_HISTORY_SCOPE
    ? JSON.parse(process.env.AUTO_EVOLVE_HISTORY_SCOPE)
    : undefined

  const result = await runLongTaskCampaign({
    cwd,
    specPath,
    forceNew,
    historyContext: historyPayload?.context,
    taskID: historyPayload?.taskID,
    attemptID: historyPayload?.attemptID,
    specHash: historyPayload?.specHash,
  })
  console.log(`Long-task campaign: ${result.campaignID}`)
  console.log(`Campaign dir: ${result.campaignDir}`)
  console.log(`Status: ${result.status}`)
  console.log(`Rounds completed: ${result.roundsCompleted}`)
  if (result.lastRunID) {
    console.log(`Last run: ${result.lastRunID}`)
  }
  console.log(`Lessons: ${result.lessonsPath}`)
  if (result.roundSummaryPath) {
    console.log(`Last round summary: ${result.roundSummaryPath}`)
  }
}

async function commandResumeLongTask(args: string[]) {
  const cwd = await resolveWorkspaceCwd()
  await ensureLayout(cwd)
  const config = await loadConfig(cwd)
  await ensureExperimentMonitor(cwd, config).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Monitor warning: ${message}`)
  })

  const runID = getOption(args, "--run")
  if (!runID) {
    console.error("Missing required option: --run <long-task-run-id>")
    process.exit(1)
  }

  const result = await resumeLongTask({
    cwd,
    runID,
  })
  console.log(`Long-task run: ${result.runID}`)
  console.log(`Run dir: ${result.runDir}`)
  console.log(`Status: ${result.status}`)
  console.log(`Summary: ${result.summaryPath}`)
}

async function commandResumeLongTaskCampaign(args: string[]) {
  const cwd = await resolveWorkspaceCwd()
  await ensureLayout(cwd)
  const config = await loadConfig(cwd)
  await ensureExperimentMonitor(cwd, config).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Monitor warning: ${message}`)
  })

  const campaignID = getOption(args, "--campaign")
  if (!campaignID) {
    console.error("Missing required option: --campaign <long-task-campaign-id>")
    process.exit(1)
  }

  const specPath = getOption(args, "--spec")
  if (!specPath) {
    console.error("Missing required option: --spec <path-to-long-task-campaign-spec>")
    process.exit(1)
  }
  const historyPayload = process.env.AUTO_EVOLVE_HISTORY_SCOPE
    ? JSON.parse(process.env.AUTO_EVOLVE_HISTORY_SCOPE)
    : undefined

  const result = await resumeLongTaskCampaign({
    cwd,
    campaignID,
    specPath,
    historyContext: historyPayload?.context,
    taskID: historyPayload?.taskID,
  })
  console.log(`Long-task campaign: ${result.campaignID}`)
  console.log(`Campaign dir: ${result.campaignDir}`)
  console.log(`Status: ${result.status}`)
  console.log(`Rounds completed: ${result.roundsCompleted}`)
  if (result.lastRunID) {
    console.log(`Last run: ${result.lastRunID}`)
  }
  console.log(`Lessons: ${result.lessonsPath}`)
  if (result.roundSummaryPath) {
    console.log(`Last round summary: ${result.roundSummaryPath}`)
  }
}

async function main() {
  const [, , command, ...args] = Bun.argv

  switch (command) {
    case "init":
      await commandInit()
      return
    case "validate":
      await commandValidate()
      return
    case "bootstrap":
      await commandBootstrap(args)
      return
    case "reset-experience":
      await commandResetExperience(args)
      return
    case "restore-experience":
      await commandRestoreExperience()
      return
    case "run-long-task":
      await commandRunLongTask(args)
      return
    case "run-blank-eval":
      await commandRunBlankEval(args)
      return
    case "run-long-task-campaign":
      await commandRunLongTaskCampaign(args)
      return
    case "resume-long-task-campaign":
      await commandResumeLongTaskCampaign(args)
      return
    case "resume-long-task":
      await commandResumeLongTask(args)
      return
    case "run-case":
      await commandRunCase(args)
      return
    case "run-round":
      await commandRunRound(args)
      return
    case "run-baseline":
      await commandRunBaseline(args)
      return
    case "run-skillsbench":
      await commandRunSkillsBench(args)
      return
    case "prepare-protocol-project": {
      const required = (flag: string) => {
        const value = getOption(args, flag)
        if (!value) throw new Error(`Missing required option: ${flag}`)
        return path.resolve(process.cwd(), value)
      }
      const manifestPath = required("--manifest")
      const selectionPath = required("--selection")
      const destination = required("--out")
      const goalFile = required("--training-goal-file")
      const { readFile } = await import("node:fs/promises")
      const { prepareProjectTasks } = await import("./orchestrator/protocol-plugins/project-tasks")
      const { selectedRuntime } = await import("./orchestrator/protocol-plugins/selected-runtime")
      const { loadPack } = await import("./orchestrator/protocol-plugins/project-pack")
      const project = await loadPack(manifestPath)
      const task = project.pack.tasks.find((item) => item.split === "train")
      if (!task) throw new Error("Project requires training tasks")
      const runtime = await selectedRuntime(destination + ".backends", process.cwd(), {
        schema: "aev.protocol-entry.v1", projectManifestPath: manifestPath, selectionPath, taskID: task.id, phase: "source" })
      const result = await prepareProjectTasks({ manifestPath, selectionPath, destination,
        trainingGoal: (await readFile(goalFile, "utf8")).replace(/^\uFEFF/, "") }, runtime)
      console.log(`Prepared ${result.tasks.length} tasks; no model execution. ${destination}`)
      return
    }
    case "run-multi-instance":
      await commandRunMultiInstance(args)
      return
    case "run-propagation":
      await commandRunPropagation(args)
      return
    case undefined:
      printHelp()
      return
    default:
      console.error(`Unknown command: ${command}`)
      printHelp()
      process.exit(1)
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
})
