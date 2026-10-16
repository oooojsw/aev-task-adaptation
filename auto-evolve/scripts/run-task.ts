import path from "node:path"
import { readFile } from "node:fs/promises"
import { runTask } from "../orchestrator/task-adaptation/run-task"
import type { TaskRunPreparation } from "../orchestrator/task-adaptation/prepare-task-run"

export async function main(argv = process.argv.slice(2), run = runTask) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log("Usage: bun run auto-evolve/scripts/run-task.ts --input <absolute-config.json>")
    console.log("Prepare, launch or resume the original Campaign, then export its selected verified deliverable.")
    return
  }
  if (argv.length !== 2 || argv[0] !== "--input" || !path.isAbsolute(argv[1])) throw new Error("Expected --input <absolute-config.json>")
  const input = JSON.parse((await readFile(argv[1], "utf8")).replace(/^\uFEFF/, "")) as TaskRunPreparation
  console.log(JSON.stringify(await run(input), null, 2))
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message : "Task failed; inspect saved evidence")
  process.exitCode = 1
})
