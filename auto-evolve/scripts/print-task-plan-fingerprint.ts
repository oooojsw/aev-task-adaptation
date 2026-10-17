import path from "node:path"
import { readFile } from "node:fs/promises"
import { fingerprint } from "../orchestrator/protocol-plugins/identity"
import { validatePlan } from "../orchestrator/task-adaptation/plan"

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !path.isAbsolute(argv[0])) {
    throw new Error("Usage: bun run auto-evolve/scripts/print-task-plan-fingerprint.ts <absolute-task-plan.json>")
  }
  const input = JSON.parse((await readFile(argv[0], "utf8")).replace(/^\uFEFF/, ""))
  const plan = validatePlan(input)
  console.log(fingerprint(plan))
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message : "Invalid Plan")
  process.exitCode = 1
})