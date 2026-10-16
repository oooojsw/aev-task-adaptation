import { expect, test } from "bun:test"
import { compileTask, interpretationPrompt } from "./catalogue"
import { catalogue, decision } from "./intake-fixture"

for (const kind of ["skill", "report", "software", "strategy"] as const) test(`compiles ${kind} through the same task plan definition`, () => {
  const input = catalogue()
  input.request = `User explicitly requests a ${kind}`
  const result = compileTask(input, decision(kind))
  expect(result.status).toBe("ready")
  if (result.status !== "ready") throw new Error("Expected ready fixture")
  expect(result.plan.objective).toBe(input.request)
  expect(result.plan.deliverable.kind).toBe(kind)
  expect(result.plan.stop).toEqual(input.stop)
  expect(result.plan.windows.filter(scope => scope.role !== "checker").every(scope => !scope.reads.includes("rubric"))).toBe(true)
  expect(result.plan.selection.rule).toBe(kind === "software" || kind === "strategy" ? "best_pass" : "first_pass")
})

test("same report type composes a different execution and evidence protocol when recomputation is requested", () => {
  const input = catalogue()
  const choice = decision()
  choice.profiles.push("recompute")
  const result = compileTask(input, choice)
  expect(result.status).toBe("ready")
  if (result.status !== "ready") throw new Error("Expected ready fixture")
  expect(result.plan.acceptance.execution).toBe("script")
  expect(result.plan.acceptance.checks.map(check => check.id)).toEqual(["support", "recomputed"])
  expect(result.plan.capabilities).toContain("program")
})

test("missing capabilities are explicit and never become a weaker ready plan", () => {
  const input = catalogue()
  input.capabilities.find(item => item.id === "program")!.available = false
  expect(compileTask(input, decision("software"))).toMatchObject({ status: "missing_capabilities", missing: ["program"] })
  const choice = decision()
  choice.needs = ["uninstalled-web-search"]
  expect(compileTask(input, choice)).toMatchObject({ status: "missing_capabilities", missing: ["uninstalled-web-search"] })
})

test("model interpretation cannot grant private resources, invent tests, or change budgets", () => {
  const input = catalogue()
  const choice = decision()
  choice.workers[0].resources.push("rubric")
  expect(() => compileTask(input, choice)).toThrow("window")
  expect(() => compileTask(input, { ...decision(), profiles: ["invented"] })).toThrow("Unsupported task profile")
  expect(() => compileTask(input, { ...decision(), stop: { rounds: 9000 } } as never)).toThrow("Invalid task interpretation")
  expect(() => compileTask(input, { ...decision("software"), profiles: ["report"] })).toThrow("Unsupported task profile")
})

test("conflicting metrics, duplicate checks, and worker privilege escalation stop compilation", () => {
  const input = catalogue()
  input.profiles.push({ ...structuredClone(input.profiles[3]), id: "other-metric", selection: { rule: "best_pass", metric: "memory_bytes", direction: "min" } })
  expect(() => compileTask(input, { ...decision("software"), profiles: ["software", "other-metric"] })).toThrow("metrics")
  input.profiles[1].acceptance.checks[0].id = "support"
  input.profiles[1].rejection[0].check = "support"
  expect(() => compileTask(input, { ...decision(), profiles: ["report", "recompute"] })).toThrow("Duplicate check")
  const choice = decision()
  choice.needs = ["program"]
  choice.workers[0].actions = ["read", "execute"]
  expect(() => compileTask(catalogue(), choice)).toThrow("Unsupported analysis worker action")
})

test("intake prompt contains only nonprivate material metadata and no checker internals", () => {
  const input = catalogue()
  const prompt = interpretationPrompt(input, "decision.json")
  expect(prompt).toContain(input.request)
  expect(prompt).toContain("source.txt")
  expect(prompt).not.toContain("private.txt")
  expect(prompt).not.toContain('"rubric"')
  expect(prompt).not.toContain('"acceptance"')
})
