import path from "node:path"
import { readFile } from "node:fs/promises"
import { prepareTaskRun, type TaskRunPreparation } from "../orchestrator/task-adaptation/prepare-task-run"

export async function main(argv = process.argv.slice(2), prepare = prepareTaskRun) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log("Usage: bun run auto-evolve/scripts/prepare-task-run.ts --input <absolute-config.json>")
    console.log("Interprets the task and prepares scoped project/protocol/spec files. Does not launch Campaign or deployment.")
    return
  }
  if (argv.length !== 2 || argv[0] !== "--input" || !path.isAbsolute(argv[1])) throw new Error("Expected --input <absolute-config.json>")
  const input = JSON.parse((await readFile(argv[1], "utf8")).replace(/^\uFEFF/, "")) as TaskRunPreparation
  const result = await prepare(input)
  console.log(JSON.stringify(result.status === "ready" ? { status: result.status, reused: result.reused, specPath: result.specPath }
    : { status: result.status, missing: result.missing }, null, 2))
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message : "Task preparation failed; inspect saved evidence")
  process.exitCode = 1
})
