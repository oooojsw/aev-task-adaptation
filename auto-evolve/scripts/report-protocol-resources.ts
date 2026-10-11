import { summarizeResources } from "../orchestrator/protocol-plugins/resource-summary"

const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== "--root") {
  throw new Error("Usage: bun auto-evolve/scripts/report-protocol-resources.ts --root <absolute-run-root>")
}
// 只读审计，绝不为补账恢复任务或发起请求。
console.log(JSON.stringify(await summarizeResources(args[1]), null, 2))
