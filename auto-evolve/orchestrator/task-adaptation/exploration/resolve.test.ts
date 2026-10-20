import { expect, test } from "bun:test"
import { resolveExploration } from "./resolve"
import { BUILTIN_EXPLORATION_TEMPLATES, type HostExplorationTemplate } from "./templates"
import { validatePlan, type Plan } from "../plan"
import { canonical } from "../../protocol-plugins/identity"

function basePlanFixture(): Plan {
  return {
    schema: "aev.task-plan.v1",
    id: "test-report-plan",
    objective: "Produce verified report",
    deliverable: { kind: "report", entries: ["candidate"] },
    resources: [
      { id: "candidate", path: "candidate.txt", mutable: true, audience: "public" },
      { id: "source", path: "source.txt", mutable: false, audience: "public" },
      { id: "rubric", path: "rubric.txt", mutable: false, audience: "private" },
    ],
    capabilities: ["files"],
    windows: [
      { role: "planner", stage: "explore", reads: ["source"], writes: [], inline: [], actions: ["read"] },
      { role: "worker", stage: "explore", reads: ["source"], writes: [], inline: [], actions: ["read"] },
      { role: "lead", stage: "revise", reads: ["source"], writes: ["candidate"], inline: [], actions: ["read", "edit"] },
      { role: "checker", stage: "accept", reads: ["candidate", "rubric"], writes: [], inline: [], actions: ["read"] },
    ],
    workers: [{ id: "sources", purpose: "Read source evidence", resources: ["source"], actions: ["read"] }],
    acceptance: {
      execution: "none",
      checks: [
        {
          id: "quality",
          target: "candidate",
          mechanism: "script",
          purpose: "Verify actual result",
          required: true,
          resources: ["candidate", "rubric"],
          feedback: "status_only",
        },
      ],
    },
    rejection: [{ check: "quality", actions: ["repair"] }],
    selection: { rule: "first_pass" },
    stop: { rounds: 4, calls: 500, tokens: 20000000, stagnant: 4 },
  }
}

test("resolveExploration: undefined or off returns disabled without policy", () => {
  const plan = basePlanFixture()
  const r1 = resolveExploration(plan, undefined)
  expect(r1.enabled).toBe(false)
  expect(r1.policy).toBeUndefined()

  const r2 = resolveExploration(plan, { mode: "off" })
  expect(r2.enabled).toBe(false)
  expect(r2.policy).toBeUndefined()

  // off with extra properties must throw
  expect(() => resolveExploration(plan, { mode: "off", after: 2 } as any)).toThrow(
    "Exploration off mode cannot include extra options",
  )
})

test("resolveExploration: auto mode resolves builtin report template into valid V1 policy", () => {
  const plan = basePlanFixture()
  const res = resolveExploration(plan, { mode: "auto" }, BUILTIN_EXPLORATION_TEMPLATES, {
    checker: { id: "script-json-checker" },
  })

  expect(res.enabled).toBe(true)
  expect(res.template?.id).toBe("report-default-exploration")
  expect(res.policy).toBeDefined()
  expect(res.policy?.schema).toBe("aev.exploration-policy.v1")
  expect(res.policy?.trigger).toEqual({ kind: "attempts", observations: 2 })

  // Validate complete plan with generated exploration policy
  const fullPlan: Plan = { ...plan, exploration: res.policy }
  const validated = validatePlan(fullPlan)
  expect(validated.exploration?.schema).toBe("aev.exploration-policy.v1")

  // Canonical base plan remains unchanged except exploration field
  const { exploration: _, ...planWithoutExploration } = fullPlan
  expect(canonical(planWithoutExploration)).toBe(canonical(plan))
})

test("resolveExploration: observations mode with valid after generates explicit observations count", () => {
  const plan = basePlanFixture()
  const res = resolveExploration(plan, { mode: "observations", after: 3 }, BUILTIN_EXPLORATION_TEMPLATES, {
    checker: { id: "script-json-checker" },
  })

  expect(res.enabled).toBe(true)
  expect(res.policy?.trigger).toEqual({ kind: "attempts", observations: 3 })

  // Invalid after values throw
  expect(() => resolveExploration(plan, { mode: "observations", after: 0 })).toThrow("positive integer")
  expect(() => resolveExploration(plan, { mode: "observations", after: -1 })).toThrow("positive integer")
  expect(() => resolveExploration(plan, { mode: "observations", after: 1.5 })).toThrow("positive integer")
})

test("resolveExploration: zero template match returns disabled in auto and throws in explicit request", () => {
  const plan = basePlanFixture()
  // No matching template (empty templates list)
  const rAuto = resolveExploration(plan, { mode: "auto" }, [])
  expect(rAuto.enabled).toBe(false)
  expect(rAuto.reason).toContain("No matching approved exploration template")

  expect(() => resolveExploration(plan, { mode: "observations", after: 2 }, [])).toThrow(
    "No matching approved exploration template for explicit exploration request",
  )
})

test("resolveExploration: ambiguous templates throws error", () => {
  const plan = basePlanFixture()
  const duplicateTemplates: HostExplorationTemplate[] = [
    BUILTIN_EXPLORATION_TEMPLATES[0],
    {
      ...BUILTIN_EXPLORATION_TEMPLATES[0],
      id: "report-duplicate-exploration",
    },
  ]

  expect(() =>
    resolveExploration(plan, { mode: "auto" }, duplicateTemplates, {
      checker: { id: "script-json-checker" },
    }),
  ).toThrow("Ambiguous exploration templates")
})

test("resolveExploration: unsupported V2 modes are rejected", () => {
  const plan = basePlanFixture()
  expect(() => resolveExploration(plan, { mode: "window", afterRound: 3 } as any)).toThrow(
    "Unsupported exploration request mode: window",
  )
  expect(() => resolveExploration(plan, { mode: "metric" } as any)).toThrow(
    "Unsupported exploration request mode: metric",
  )
})

test("resolveExploration: budget and allowance conflicts throw", () => {
  const plan = basePlanFixture()
  plan.stop.rounds = 1 // Less than template allowance.rounds (2)
  expect(() =>
    resolveExploration(plan, { mode: "auto" }, BUILTIN_EXPLORATION_TEMPLATES, {
      checker: { id: "script-json-checker" },
    }),
  ).toThrow("Exploration allowance rounds exceed task stop rounds")
})
