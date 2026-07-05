import path from "node:path"
import { runBlankEvalPlan } from "../orchestrator/blank-eval/plan-runner"

function readArg(name: string) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`)
  return value
}

function splitList(input: string | undefined) {
  return (input ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function resolvePath(input: string | undefined, fallback?: string) {
  const value = input ?? fallback
  if (!value) return undefined
  return path.resolve(value)
}

async function main() {
  const cwd = process.cwd()
  const skillRoot = resolvePath(readArg("--skill-root"))
  if (!skillRoot) throw new Error("Missing --skill-root")

  const taskPackRoot = resolvePath(
    readArg("--task-pack-root"),
    path.join(cwd, "auto-evolve", "task-packs", "real-long-tasks", "spreadsheetbench-learnbench"),
  )
  const outRoot = resolvePath(
    readArg("--out-root"),
    path.join(cwd, "auto-evolve", "runtime-state", "blank-eval-plan-real-smokes"),
  )
  const caseIDs = splitList(readArg("--case-ids"))
  if (!caseIDs.length) throw new Error("Missing --case-ids")

  const modeArg = readArg("--mode")
  const mode = modeArg === "single" || modeArg === "sequence" || modeArg === "parallel" ? modeArg : "parallel"
  const concurrency = Math.max(1, Math.floor(Number(readArg("--concurrency") ?? "1")))
  const successArg = readArg("--success")
  const successCriterion =
    successArg === "allow_partial" || successArg === "min_pass_rate" || successArg === "all_pass"
      ? successArg
      : "all_pass"

  const result = await runBlankEvalPlan({
    cwd,
    runRoot: outRoot,
    title: readArg("--title") ?? "real blank eval plan smoke",
    mode,
    concurrency,
    successCriterion,
    skillRoots: [skillRoot],
    runtimeScope: readArg("--runtime-scope") ?? "real-blank-eval-plan-smoke",
    concurrencyScope: readArg("--concurrency-scope") ?? "real-blank-eval-plan-smoke",
    cases: caseIDs.map((id) => ({
      id,
      title: `real blank eval smoke ${id}`,
      specPath: path.join(taskPackRoot!, "tasks", id, "spec.json"),
      mode: "train-backtest",
    })),
  })

  console.log(JSON.stringify(result, null, 2))
  if (!result.passed) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
