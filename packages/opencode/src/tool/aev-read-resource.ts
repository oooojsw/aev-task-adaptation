import z from "zod"
import { Tool } from "./tool"

export const AevReadResourceTool = Tool.define("aev_read_resource", {
  description:
    "Read declared training case feedback chunks within this role's authorized scope. Provide resourceID and caseID. If content exceeds a single chunk, a nextCursor is returned to continue reading. Do not use for general file access.",
  parameters: z
    .object({
      resourceID: z.string().min(1),
      caseID: z.string().min(1),
      cursor: z.string().optional(),
      maxBytes: z.number().int().positive().optional(),
    })
    .strict(),
  async execute(input, ctx) {
    await ctx.ask({
      permission: "aev_read_resource",
      patterns: ["declared_resource_chunk"],
      always: ["declared_resource_chunk"],
      metadata: {},
    })
    const { readResourceFromEnvironment } = await import(
      "../../../../auto-evolve/orchestrator/task-adaptation/consolidation/scoped-reader"
    )
    const result = await readResourceFromEnvironment(input, process.env)
    return {
      title: `Declared resource chunk [${input.caseID}]`,
      output: JSON.stringify(result),
      metadata: {
        caseID: result.caseID,
        offset: result.offset,
        returnedBytes: result.returnedBytes,
        eof: result.eof,
        chunkSHA256: result.chunkSHA256,
      },
    }
  },
})
