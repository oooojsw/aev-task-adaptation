import z from "zod"
import { Tool } from "./tool"

export const AevRecomputeTool = Tool.define("aev_recompute", {
  description: "Compute finite arithmetic without shell, file access or code evaluation. Expression: number or {op,args:[expressions]}; ops add/sub/mul/div/pow/sqrt/min/max/sum/mean. sub/div/pow take two args; sqrt one. Limits: 256 nodes, depth 16, 128 args. IEEE-754 results are not exact decimal arithmetic. Input numbers come from you, not verified source extraction. A calculation receipt is not formal acceptance.",
  parameters: z.object({ expression: z.unknown() }).strict(),
  async execute(input, ctx) {
    await ctx.ask({ permission: "aev_recompute", patterns: ["bounded_arithmetic"], always: ["bounded_arithmetic"], metadata: {} })
    const { recomputeFromEnvironment } = await import("../../../../auto-evolve/orchestrator/task-adaptation/recompute")
    const result = await recomputeFromEnvironment(input.expression, process.env, ctx.abort)
    return { title: "Bounded arithmetic recomputation", output: JSON.stringify(result), metadata: { receipt: result.receipt } }
  },
})
