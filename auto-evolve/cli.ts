import process from "node:process"
import { ensureLayout } from "./orchestrator/fs"
import { runBootstrap } from "./orchestrator/bootstrap"
import { runCase } from "./orchestrator/case-runner"
import { runRound } from "./orchestrator/round-runner"
import { runBaseline } from "./orchestrator/baseline-runner"
import { loadConfig, validateAllCases } from "./orchestrator/schema"
import { ensureExperimentMonitor } from "./orchestrator/monitor"

function printHelp() {
  console.log(`auto-evolve commands:

  init
    Ensure the auto-evolve workspace, templates, and knowledge files exist.

  validate
    Validate auto-evolve/config.json and every dataset case.

  bootstrap [--force]
    Ask OpenCode to generate or refresh the Markdown knowledge pack from labeled cases.
    Optional: --method <method-id>

  run-case --case <case-id>
    Solve one case with the current knowledge pack, then refine the knowledge pack and retry on failure.
    Optional: --method <method-id> --mode <learn|eval> --split <train|test|all>

  run-round
    Traverse cases in order, letting the knowledge pack evolve across the round.
    Optional: --method <method-id> --limit <number> --split <train|test|all> --mode <learn|eval>

  run-baseline
    Produce a unified baseline scorecard for the current system, including train/test rounds and knowledge snapshots.
    Optional: --method <method-id> --train-limit <number> --test-limit <number> --skip-bootstrap --force-bootstrap
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

  console.log(`Config: OK (${config.configPath})`)
  console.log(`Cases discovered: ${report.caseCount}`)

  if (!report.errors.length) {
    console.log("Validation: OK")
    return
  }

  console.error("Validation errors:")
  for (const error of report.errors) console.error(`- ${error}`)
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
    case "run-case":
      await commandRunCase(args)
      return
    case "run-round":
      await commandRunRound(args)
      return
    case "run-baseline":
      await commandRunBaseline(args)
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
