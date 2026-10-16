import z from "zod"
import { Tool } from "./tool"

export const AevLocalSearchTool = Tool.define("aev_local_search", {
  description: "Literal, case-sensitive search within this role's declared local UTF-8 resources only. Use resource IDs from the role window; this tool cannot search the web or other paths. Results are source evidence, not acceptance verdicts.",
  parameters: z.object({ query: z.string().min(1), resources: z.array(z.string()).optional() }).strict(),
  async execute(input, ctx) {
    await ctx.ask({ permission: "aev_local_search", patterns: ["declared_local_text"], always: ["declared_local_text"], metadata: {} })
    const { searchFromEnvironment } = await import("../../../../auto-evolve/orchestrator/task-adaptation/local-search")
    const result = await searchFromEnvironment(input, process.env, ctx.abort)
    return { title: "Declared local source search", output: JSON.stringify(result),
      metadata: { truncated: result.truncated, receipt: result.receipt } }
  },
})
