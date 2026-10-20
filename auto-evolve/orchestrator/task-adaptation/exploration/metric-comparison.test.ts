import { expect, test } from "bun:test"
import { metricComparison } from "./metric-comparison"

const fixed = { plan: "plan", protocol: "protocol", phase: "merge", task: "task", materials: [], privateInputs: [], selection: { metric: "pass_rate" } }
test("metric comparison fixes indirect scoring dependencies but not candidate, answer or run", () => {
  const product = { schema: "aev.consolidation-eval.v1", dependencies_sha256: "a".repeat(64),
    candidate_sha256: "b".repeat(64), runID: "one", passed: 40 }
  const first = metricComparison({ ...fixed, executor: "consolidation-direct-chat", product })
  expect(metricComparison({ ...fixed, executor: "consolidation-direct-chat",
    product: { ...product, candidate_sha256: "c".repeat(64), runID: "two", passed: 42 } })).toBe(first)
  expect(metricComparison({ ...fixed, executor: "consolidation-direct-chat",
    product: { ...product, dependencies_sha256: "d".repeat(64) } })).not.toBe(first)
  expect(() => metricComparison({ ...fixed, executor: "consolidation-direct-chat", product: {} })).toThrow("dependency identity")
})
test("other protocols compare frozen settings and material identities without requiring consolidation", () => {
  const first = metricComparison({ ...fixed, executor: "script-json-executor", product: { result: 1 } })
  expect(metricComparison({ ...fixed, executor: "script-json-executor", product: { result: 20 } })).toBe(first)
  expect(metricComparison({ ...fixed, protocol: "changed-settings" })).not.toBe(first)
  expect(metricComparison({ ...fixed, materials: [{ sha256: "changed" }] })).not.toBe(first)
})
