import path from "node:path"
import { readFile } from "node:fs/promises"
import { inspectRequestUsage, type RequestBudget } from "../orchestrator/task-adaptation/request-budget"
import { resolveResource } from "../orchestrator/task-adaptation/binding"

export async function main(argv = process.argv.slice(2), report = inspectRequestUsage) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log("Usage: bun run auto-evolve/scripts/report-task-usage.ts --budget <absolute-budget-config.json>")
    console.log("Config: {root, scope, calls, tokens}; use the original frozen wallet identity. No model requests.")
    return
  }
  if (argv.length !== 2 || argv[0] !== "--budget" || !path.isAbsolute(argv[1])) {
    throw new Error("Expected --budget <absolute-budget-config.json>")
  }
  const config = JSON.parse((await readFile(argv[1], "utf8")).replace(/^\uFEFF/, "")) as RequestBudget
  if (!config || typeof config !== "object" || Array.isArray(config) ||
    Object.keys(config).sort().join(",") !== "calls,root,scope,tokens" ||
    typeof config.root !== "string" || !path.isAbsolute(config.root) ||
    typeof config.scope !== "string" || !config.scope.trim() ||
    !Number.isSafeInteger(config.calls) || config.calls < 1 ||
    !Number.isSafeInteger(config.tokens) || config.tokens < 1) throw new Error("Original request budget identity required")
  // 查账不能因路径写错而创建一本零消耗的新账。
  await resolveResource(config.root, "budget.json")
  console.log(JSON.stringify(await report(config), null, 2))
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message : "Usage inspection failed")
  process.exitCode = 1
})
