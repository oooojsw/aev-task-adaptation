import { describe, expect, test } from "bun:test"
import { planIdentity, roleWindow, validatePlan, type Plan } from "./plan"

function fixture(): Plan {
  return {
    schema: "aev.task-plan.v1", id: "report-1", objective: "Investigate latency with source-supported conclusions",
    deliverable: { kind: "report", entries: ["report"] },
    resources: [
      { id: "source", path: "materials/source.txt", audience: "public", mutable: false },
      { id: "report", path: "candidate/report.md", audience: "public", mutable: true },
      { id: "trace", path: "evidence/trace.json", audience: "training", mutable: false },
      { id: "rubric", path: "private/rubric.json", audience: "private", mutable: false },
    ],
    capabilities: ["file-read", "source-check"],
    windows: [
      { role: "lead", stage: "revise", reads: ["source", "report", "trace"], writes: ["report"], inline: [], actions: ["read", "edit"] },
      { role: "worker", stage: "explore", reads: ["source", "trace"], writes: [], inline: [], actions: ["read", "verify_source"] },
      { role: "checker", stage: "accept", reads: ["source", "report", "rubric"], writes: [], inline: [], actions: ["read"] },
      { role: "independent", stage: "accept", reads: ["source", "report"], writes: [], inline: [], actions: ["read"] },
    ],
    workers: [{ id: "sources", purpose: "Verify source support", resources: ["source"], actions: ["read", "verify_source"] }],
    acceptance: { execution: "none", checks: [{ id: "support", target: "candidate", mechanism: "judge", purpose: "Verify claims against sources", required: true, resources: ["source", "report", "rubric"], feedback: "status_only" }] },
    rejection: [{ check: "support", actions: ["verify_source", "research"] }],
    selection: { rule: "first_pass" }, stop: { rounds: 3, calls: 20, tokens: 100000, stagnant: 2 },
  }
}

describe("task plan and information windows", () => {
  test("freezes a report without mandatory skill content or execution", () => {
    const plan = validatePlan(fixture())
    expect(plan.deliverable.kind).toBe("report")
    expect(plan.acceptance.execution).toBe("none")
    expect(Object.isFrozen(plan.resources[0])).toBe(true)
    expect(roleWindow(plan, "lead", "revise").inline).toEqual([])
  })
  test("limits each worker to its declared subset", () => {
    expect(roleWindow(fixture(), "worker", "explore", "sources").reads.map(item => item.id)).toEqual(["source"])
    expect(() => roleWindow(fixture(), "worker", "explore", "invented")).toThrow()
    expect(() => roleWindow(fixture(), "worker", "explore")).toThrow()
    expect(() => roleWindow(fixture(), "lead", "explore")).toThrow()
  })
  test("private scoring resources cannot enter author or independent context", () => {
    for (const index of [0, 1, 3]) {
      const plan = fixture()
      plan.windows[index].reads.push("rubric")
      expect(() => validatePlan(plan)).toThrow("audience")
    }
    expect(roleWindow(fixture(), "checker", "accept").reads.map(item => item.id)).toContain("rubric")
  })
  test("independent executor cannot read training history", () => {
    const plan = fixture()
    plan.windows[3].reads.push("trace")
    expect(() => validatePlan(plan)).toThrow("audience")
  })
  test("read-only roles and immutable resources cannot be writable", () => {
    const plan = fixture()
    plan.windows[1].writes.push("report")
    expect(() => validatePlan(plan)).toThrow("write")
    plan.windows[1].writes = []
    plan.windows[0].writes.push("source")
    expect(() => validatePlan(plan)).toThrow("write")
  })
  test("inline does not silently grant read access", () => {
    const plan = fixture()
    plan.windows[0].inline.push("rubric")
    expect(() => validatePlan(plan)).toThrow("Inline")
  })
  test("rejects unknown keys, choices and dangling references", () => {
    expect(() => validatePlan({ ...fixture(), guessed: true })).toThrow()
    const plan = fixture()
    plan.deliverable.entries = ["missing"]
    expect(() => validatePlan(plan)).toThrow("Unknown resource")
    expect(() => validatePlan({ ...fixture(), schema: "future" })).toThrow()
  })
  test("rejects traversal, platform aliases and ancestor resource overlap", () => {
    for (const file of ["../private", "C:/private", "/private", "a\\b", "a//b", "a/./b", "candidate"] ) {
      const plan = fixture()
      plan.resources[0].path = file
      expect(() => validatePlan(plan)).toThrow()
    }
  })
  test("requires an actual mandatory check and failure route", () => {
    const plan = fixture()
    plan.acceptance.checks[0].required = false
    expect(() => validatePlan(plan)).toThrow("Required acceptance")
    plan.acceptance.checks[0].required = true
    plan.rejection = []
    expect(() => validatePlan(plan)).toThrow("route missing")
  })
  test("product checking requires execution", () => {
    const plan = fixture()
    plan.acceptance.checks[0].target = "product"
    expect(() => validatePlan(plan)).toThrow("requires execution")
    plan.acceptance.execution = "script"
    expect(validatePlan(plan).acceptance.execution).toBe("script")
  })
  test("workers cannot invent extra tools", () => {
    const plan = fixture()
    plan.workers[0].actions.push("execute")
    expect(() => validatePlan(plan)).toThrow("authorized window")
  })
  test("best-pass requires a metric and budgets cannot be unlimited", () => {
    const plan = fixture()
    plan.selection = { rule: "best_pass" }
    expect(() => validatePlan(plan)).toThrow()
    plan.selection = { rule: "best_pass", metric: "milliseconds", direction: "min" }
    expect(validatePlan(plan).selection.metric).toBe("milliseconds")
    plan.stop.calls = Infinity
    expect(() => validatePlan(plan)).toThrow()
  })
  test("semantic drift changes identity and object key order does not", () => {
    const plan = fixture()
    expect(planIdentity(plan)).toBe(planIdentity({ ...plan, id: plan.id }))
    plan.objective += " with recomputation"
    expect(planIdentity(plan)).not.toBe(planIdentity(fixture()))
  })
})
