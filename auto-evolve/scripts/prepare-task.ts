import path from "node:path"
import { readFile } from "node:fs/promises"
import { prepareTask, type IntakeInput } from "../orchestrator/task-adaptation/intake"

export async function main(argv = process.argv.slice(2), prepare = prepareTask) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log("Usage: bun run auto-evolve/scripts/prepare-task.ts --input <absolute-intake-config.json>")
    console.log("Interprets one task using the configured frozen host. Creates a plan only; does not start training or deployment.")
    return
  }
  if (argv.length !== 2 || argv[0] !== "--input" || !path.isAbsolute(argv[1])) throw new Error("Expected --input <absolute-intake-config.json>; use --help")
  const input = JSON.parse((await readFile(argv[1], "utf8")).replace(/^\uFEFF/, "")) as IntakeInput
  const result = await prepare(input)
  // 控制台只报入口状态，不倾倒私有检查配置或整份方案。
  console.log(JSON.stringify({ status: result.status, reused: result.reused, dir: result.dir,
    ...(result.status === "ready" ? { planPath: result.planPath } : { missing: result.missing }) }, null, 2))
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message : "Task intake failed; inspect saved evidence")
  process.exitCode = 1
})
