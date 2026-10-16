import { expect, test } from "bun:test"
import type { LongTaskSpec } from "../long-task/contract"
import { chooseTaskVersion, type readTaskVersions } from "./selection"

function spec(rule: "first_pass" | "best_pass", direction = "min", rounds = 4, stagnant = 2) {
  return { taskAdaptationContext: { plan: { selection: { rule, metric: "elapsed_ns", direction },
    stop: { rounds, stagnant, calls: 100, tokens: 10000 } } } } as LongTaskSpec
}
function versions(values: number[]) {
  return values.map((metric, index) => ({ path: `version-${index + 1}`, record: { metric, round: index + 1 } })) as Awaited<ReturnType<typeof readTaskVersions>>
}
test("first-pass selection stops with first qualified version", () => {
  expect(chooseTaskVersion(spec("first_pass"), versions([8, 4]), 2, 4)).toEqual({
    selectedTaskVersionPath: "version-1", taskStopReason: "first_pass", stop: true, passed: true,
  })
})
test("metric direction selects only improvement and retains earliest ties", () => {
  expect(chooseTaskVersion(spec("best_pass"), versions([8, 4, 4, 9]), 4, 4).selectedTaskVersionPath).toBe("version-2")
  expect(chooseTaskVersion(spec("best_pass", "max"), versions([8, 4, 9, 9]), 4, 4).selectedTaskVersionPath).toBe("version-3")
})
test("effective round budget is the tighter frozen task or campaign limit", () => {
  expect(chooseTaskVersion(spec("best_pass", "min", 2), versions([8]), 2, 8).taskStopReason).toBe("round_budget")
  expect(chooseTaskVersion(spec("best_pass", "min", 8), versions([8]), 2, 2).taskStopReason).toBe("round_budget")
  expect(chooseTaskVersion(spec("best_pass", "min", 8), [], 2, 2).passed).toBe(false)
})
test("stagnation uses rounds since best improvement, not accepted count", () => {
  const input = spec("best_pass", "min", 8, 2)
  expect(chooseTaskVersion(input, versions([8]), 2, 8).stop).toBe(false)
  expect(chooseTaskVersion(input, versions([8]), 3, 8).taskStopReason).toBe("stagnant")
  expect(chooseTaskVersion(input, versions([8, 4]), 3, 8).stop).toBe(false)
})
