import { expect, test } from "bun:test"
import { resolveExploration } from "./resolve"
import {
  BUILTIN_EXPLORATION_TEMPLATES,
  FIXTURE_REPORT_EXPLORATION_TEMPLATE,
  type HostExplorationTemplate,
} from "./templates"
import { catalogue, decision } from "../intake-fixture"
import { compileTask } from "../catalogue"

function fixturePlan() {
  const cfg = catalogue()
  const choice = decision("report")
  cfg.request = "Produce verified report"
  cfg.stop = { rounds: 4, calls: 500, tokens: 20000000, stagnant: 4 }
  cfg.resources = [
    { id: "candidate", path: "candidate.txt", mutable: true, audience: "public" },
    { id: "source", path: "source.txt", mutable: false, audience: "public" },
    { id: "rubric", path: "rubric.txt", mutable: false, audience: "private" },
  ]
  cfg.entries = ["candidate"]
  cfg.profiles = [
    {
      id: "report",
      description: "Report profile",
      kinds: ["report"],
      requires: ["files"],
      acceptance: {
        execution: "none",
        checks: [
          {
            id: "quality",
            target: "candidate",
            mechanism: "script",
            purpose: "Verify report",
            required: true,
            resources: ["candidate", "rubric"],
            feedback: "status_only",
          },
        ],
      },
      rejection: [{ check: "quality", actions: ["repair"] }],
      selection: { rule: "first_pass" },
    },
  ]
  choice.profiles = ["report"]
  choice.workers = [
    { id: "sources", purpose: "Read source evidence", resources: ["source"], actions: ["read"] },
  ]

  const compiled = compileTask(cfg, choice)
  if (compiled.status !== "ready") throw new Error("Fixture plan compilation failed")
  return compiled
}

test("resolveExploration: undefined or off returns disabled without policy", () => {
  const { plan, profiles } = fixturePlan()
  const emptyRes = resolveExploration(plan, undefined, [FIXTURE_REPORT_EXPLORATION_TEMPLATE], undefined, profiles)
  expect(emptyRes.enabled).toBe(false)
  expect(emptyRes.policy).toBeUndefined()

  const offRes = resolveExploration(plan, { mode: "off" }, [FIXTURE_REPORT_EXPLORATION_TEMPLATE], undefined, profiles)
  expect(offRes.enabled).toBe(false)
  expect(offRes.policy).toBeUndefined()

  expect(() =>
    resolveExploration(plan, { mode: "off", extra: 1 } as any, [FIXTURE_REPORT_EXPLORATION_TEMPLATE], undefined, profiles),
  ).toThrow("Exploration off mode cannot include extra options")
})

test("resolveExploration: auto mode without approved templates returns enabled:false", () => {
  const { plan, profiles } = fixturePlan()
  const support = { checker: { id: "script-json-checker" } }
  // 默认生产模板列表为空
  const res = resolveExploration(plan, { mode: "auto" }, BUILTIN_EXPLORATION_TEMPLATES, support, profiles)
  expect(res.enabled).toBe(false)
  expect(res.policy).toBeUndefined()
  expect(res.reason).toContain("No matching approved exploration template")
})

test("resolveExploration: auto mode resolves injected fixture template into valid V1 policy", () => {
  const { plan, profiles } = fixturePlan()
  const support = { checker: { id: "script-json-checker" } }
  const res = resolveExploration(plan, { mode: "auto" }, [FIXTURE_REPORT_EXPLORATION_TEMPLATE], support, profiles)
  expect(res.enabled).toBe(true)
  expect(res.template?.id).toBe("report-default-exploration")
  expect(res.policy?.schema).toBe("aev.exploration-policy.v1")
  expect(res.policy?.trigger).toEqual({ kind: "attempts", observations: 2 })
})

test("resolveExploration: observations mode with valid after generates explicit observations count", () => {
  const { plan, profiles } = fixturePlan()
  const support = { checker: { id: "script-json-checker" } }
  const res = resolveExploration(
    plan,
    { mode: "observations", after: 3 },
    [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
    support,
    profiles,
  )
  expect(res.enabled).toBe(true)
  expect(res.policy?.trigger).toEqual({ kind: "attempts", observations: 3 })
})

test("resolveExploration: zero template match returns disabled in auto and throws in explicit request", () => {
  const { plan, profiles } = fixturePlan()
  // Host checker 不匹配
  const badSupport = { checker: { id: "different-checker" } }
  const autoRes = resolveExploration(
    plan,
    { mode: "auto" },
    [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
    badSupport,
    profiles,
  )
  expect(autoRes.enabled).toBe(false)
  expect(autoRes.reason).toContain("No matching approved exploration template")

  expect(() =>
    resolveExploration(
      plan,
      { mode: "observations", after: 2 },
      [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
      badSupport,
      profiles,
    ),
  ).toThrow("No matching approved exploration template for explicit exploration request")
})

test("resolveExploration: ambiguous templates returns disabled in auto and throws in explicit request", () => {
  const { plan, profiles } = fixturePlan()
  const support = { checker: { id: "script-json-checker" } }
  const t1 = FIXTURE_REPORT_EXPLORATION_TEMPLATE
  const t2: HostExplorationTemplate = {
    ...FIXTURE_REPORT_EXPLORATION_TEMPLATE,
    id: "report-alt-exploration",
  }
  const autoRes = resolveExploration(plan, { mode: "auto" }, [t1, t2], support, profiles)
  expect(autoRes.enabled).toBe(false)
  expect(autoRes.reason).toContain("Ambiguous exploration templates matched")

  expect(() =>
    resolveExploration(plan, { mode: "observations", after: 2 }, [t1, t2], support, profiles),
  ).toThrow("Ambiguous exploration templates matched for explicit exploration request")
})

test("resolveExploration: unsupported V2 modes are rejected", () => {
  const { plan, profiles } = fixturePlan()
  expect(() =>
    resolveExploration(plan, { mode: "free_rounds" as any }, [FIXTURE_REPORT_EXPLORATION_TEMPLATE], undefined, profiles),
  ).toThrow("Unsupported exploration request mode")
  expect(() =>
    resolveExploration(plan, { mode: "metric_stagnation" as any }, [FIXTURE_REPORT_EXPLORATION_TEMPLATE], undefined, profiles),
  ).toThrow("Unsupported exploration request mode")
})

test("resolveExploration: budget and allowance conflicts fail match", () => {
  const { plan, profiles } = fixturePlan()
  const support = { checker: { id: "script-json-checker" } }
  const tightPlan = { ...plan, stop: { ...plan.stop, rounds: 1 } }
  const res = resolveExploration(
    tightPlan,
    { mode: "auto" },
    [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
    support,
    profiles,
  )
  expect(res.enabled).toBe(false)
})
