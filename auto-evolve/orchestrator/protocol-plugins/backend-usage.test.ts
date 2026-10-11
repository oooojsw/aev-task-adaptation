import { expect, test } from "bun:test"
import { backendUsage } from "./backend-usage"

test("backend usage sums only complete reported steps and retains raw cost units", () => {
  const result = backendUsage([
    { type: "step_finish", part: { tokens: { input: 10, output: 2, cache: { read: 4 } }, cost: 0.5 } },
    { type: "step_finish", part: { tokens: { input: 20, output: 3 }, cost: 0 } },
  ])
  expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 5 })
  expect(result.steps[0]).toMatchObject({ cacheReadTokens: 4, reasoningTokens: null, rawCost: 0.5 })
  expect(result.steps[1].rawCost).toBe(0)
})

test("missing invalid and overflow usage stays unknown rather than free", () => {
  expect(backendUsage([]).usage).toEqual({})
  const result = backendUsage([
    { type: "step_finish", part: { tokens: { input: 10, output: 1 } } },
    { type: "step_finish", part: { tokens: { input: -1, output: 2 } } },
  ])
  expect(result.usage).toEqual({ outputTokens: 3 })
  expect(result.inputTokens).toBeNull()
  expect(result.steps[1].inputTokens).toBeNull()
  expect(backendUsage([{ type: "step_finish", part: { tokens: { input: Number.MAX_SAFE_INTEGER, output: NaN } } },
    { type: "step_finish", part: { tokens: { input: 1, output: 0 } } }]).usage).toEqual({})
})
