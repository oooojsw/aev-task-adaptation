import { expect, test } from "bun:test"
import { resolveExploration, type ExplorationSupport } from "./resolve"
import {
  BUILTIN_EXPLORATION_TEMPLATES,
  FIXTURE_REPORT_EXPLORATION_TEMPLATE,
  type HostExplorationTemplate,
} from "./templates"
import { catalogue, decision } from "../intake-fixture"
import { compileTask } from "../catalogue"
import { explorationIdentity, type ExplorationPolicy } from "./policy"
import { explorationIdentityAny } from "./policy-reader"
import type { ExplorationPolicyV2 } from "./policy-v2"
import type { ExplorationRequest, HostExplorationTemplateV2 } from "./templates"

function fixturePlan(totalRounds = 4) {
  const cfg = catalogue()
  const choice = decision("report")
  cfg.request = "Produce verified report"
  cfg.stop = { rounds: totalRounds, calls: 500, tokens: 20000000, stagnant: totalRounds }
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

const standardSupport: ExplorationSupport = {
  checkers: [{ name: "quality", id: "script-json-checker" }],
}

// ----------------------------------------------------
// 任务卡 A：Checker 精确匹配与 Profile 匹配用例 (A01 - A10)
// ----------------------------------------------------

test("A01: 正常单 Checker 匹配成功", () => {
  const { plan, profiles } = fixturePlan()
  const res = resolveExploration(
    plan,
    { mode: "auto" },
    [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
    standardSupport,
    profiles,
  )
  expect(res.enabled).toBe(true)
  expect(res.template?.id).toBe("report-default-exploration")
  expect(res.policy?.schema).toBe("aev.exploration-policy.v1")
  expect(res.policy?.trigger).toEqual({ kind: "attempts", observations: 2 })
})

test("A02: 只有 script mechanism 并不匹配（模板 checker.name 不在 Plan 中）", () => {
  const { plan, profiles } = fixturePlan()
  const templateWithOtherName: HostExplorationTemplate = {
    ...FIXTURE_REPORT_EXPLORATION_TEMPLATE,
    checker: { name: "other", id: "script-json-checker" },
  }
  const autoRes = resolveExploration(
    plan,
    { mode: "auto" },
    [templateWithOtherName],
    standardSupport,
    profiles,
  )
  expect(autoRes.enabled).toBe(false)
  expect(autoRes.reason).toContain("No matching approved exploration template")

  expect(() =>
    resolveExploration(
      plan,
      { mode: "observations", after: 2 },
      [templateWithOtherName],
      standardSupport,
      profiles,
    ),
  ).toThrow("No matching approved exploration template for explicit exploration request")
})

test("A03: 绑定不匹配（Host checker.id 与模板 checker.id 不一致）", () => {
  const { plan, profiles } = fixturePlan()
  const badSupport: ExplorationSupport = {
    checkers: [{ name: "quality", id: "different-checker" }],
  }
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

test("A04: 多 Checker 顺序变化不影响匹配", () => {
  const { plan, profiles } = fixturePlan()
  // 在 Plan 中增加第二个必需检查项 trace
  const multiPlan = {
    ...plan,
    acceptance: {
      ...plan.acceptance,
      checks: [
        ...plan.acceptance.checks,
        {
          id: "trace",
          target: "candidate" as const,
          mechanism: "script" as const,
          purpose: "Trace check",
          required: true,
          resources: ["candidate"],
          feedback: "status_only" as const,
        },
      ],
    },
  }
  // Host 提供了两个绑定，并将 quality 放在第 2 位
  const permutedSupport: ExplorationSupport = {
    checkers: [
      { name: "trace", id: "trace-checker" },
      { name: "quality", id: "script-json-checker" },
    ],
  }
  const res = resolveExploration(
    multiPlan,
    { mode: "auto" },
    [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
    permutedSupport,
    profiles,
  )
  expect(res.enabled).toBe(true)
  expect(res.template?.id).toBe("report-default-exploration")
})

test("A05: 缺第二个必需 Checker 时拒绝", () => {
  const { plan, profiles } = fixturePlan()
  const multiPlan = {
    ...plan,
    acceptance: {
      ...plan.acceptance,
      checks: [
        ...plan.acceptance.checks,
        {
          id: "trace",
          target: "candidate" as const,
          mechanism: "script" as const,
          purpose: "Trace check",
          required: true,
          resources: ["candidate"],
          feedback: "status_only" as const,
        },
      ],
    },
  }
  // Host 仅提供了 quality，缺少必需的 trace
  const autoRes = resolveExploration(
    multiPlan,
    { mode: "auto" },
    [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
    standardSupport,
    profiles,
  )
  expect(autoRes.enabled).toBe(false)
  expect(autoRes.reason).toContain("No matching approved exploration template")

  expect(() =>
    resolveExploration(
      multiPlan,
      { mode: "observations", after: 2 },
      [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
      standardSupport,
      profiles,
    ),
  ).toThrow("No matching approved exploration template for explicit exploration request")
})

test("A06: Profile 不是 kind（selected profile 不匹配模板 profiles）", () => {
  const { plan } = fixturePlan()
  // 传 ["reviewed-report"] 而不是 ["report"]
  const autoRes = resolveExploration(
    plan,
    { mode: "auto" },
    [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
    standardSupport,
    ["reviewed-report"],
  )
  expect(autoRes.enabled).toBe(false)
  expect(autoRes.reason).toContain("No matching approved exploration template")
})

test("A07: 组合 Profile 严格匹配集合，不匹配子集", () => {
  const { plan } = fixturePlan()
  // 传入多 Profile 组合 ["report", "recompute"]
  const autoRes = resolveExploration(
    plan,
    { mode: "auto" },
    [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
    standardSupport,
    ["report", "recompute"],
  )
  expect(autoRes.enabled).toBe(false)
  expect(autoRes.reason).toContain("No matching approved exploration template")
})

test("A08: 明确版本差异时拒绝（Host 缺少版本或版本不匹配）", () => {
  const { plan, profiles } = fixturePlan()
  const versionedTemplate: HostExplorationTemplate = {
    ...FIXTURE_REPORT_EXPLORATION_TEMPLATE,
    checker: { name: "quality", id: "script-json-checker", version: "2.0.0" },
  }
  // Host 提供了无 version 的绑定
  const autoRes1 = resolveExploration(
    plan,
    { mode: "auto" },
    [versionedTemplate],
    standardSupport,
    profiles,
  )
  expect(autoRes1.enabled).toBe(false)

  // Host 提供了不一致的版本 "1.0.0"
  const mismatchedSupport: ExplorationSupport = {
    checkers: [{ name: "quality", id: "script-json-checker", version: "1.0.0" }],
  }
  const autoRes2 = resolveExploration(
    plan,
    { mode: "auto" },
    [versionedTemplate],
    mismatchedSupport,
    profiles,
  )
  expect(autoRes2.enabled).toBe(false)
})

test("A09: 禁用保持旧行为（无请求或 mode=off 不要求 profiles / support）", () => {
  const { plan } = fixturePlan()
  const emptyRes = resolveExploration(plan, undefined, [FIXTURE_REPORT_EXPLORATION_TEMPLATE])
  expect(emptyRes.enabled).toBe(false)
  expect(emptyRes.policy).toBeUndefined()

  const offRes = resolveExploration(plan, { mode: "off" }, [FIXTURE_REPORT_EXPLORATION_TEMPLATE])
  expect(offRes.enabled).toBe(false)
  expect(offRes.policy).toBeUndefined()
})

test("A10: 不发布默认模板（BUILTIN_EXPLORATION_TEMPLATES 为空列表时 auto 禁用）", () => {
  const { plan, profiles } = fixturePlan()
  const res = resolveExploration(
    plan,
    { mode: "auto" },
    BUILTIN_EXPLORATION_TEMPLATES,
    standardSupport,
    profiles,
  )
  expect(res.enabled).toBe(false)
  expect(res.policy).toBeUndefined()
  expect(res.reason).toContain("No matching approved exploration template")
})

// ----------------------------------------------------
// 任务卡 B：探索轮次相容性用例 (B01 - B09)
// ----------------------------------------------------

test("B01: 恰好足够 T=4, N=2, M=2 允许 enabled:true", () => {
  const { plan, profiles } = fixturePlan(4) // T=4
  const res = resolveExploration(
    plan,
    { mode: "observations", after: 2 }, // N=2, fixture template minimumRounds=2
    [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
    standardSupport,
    profiles,
  )
  expect(res.enabled).toBe(true)
  expect(res.policy?.trigger).toEqual({ kind: "attempts", observations: 2 })
})

test("B02: 差一轮 T=3, N=2, M=2 (N+M=4 > 3) auto 禁用 / 显式拒绝", () => {
  const { plan, profiles } = fixturePlan(3) // T=3
  const autoRes = resolveExploration(
    plan,
    { mode: "auto" }, // auto 模式默认 observations=2
    [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
    standardSupport,
    profiles,
  )
  expect(autoRes.enabled).toBe(false)
  expect(autoRes.reason).toContain("Exploration observation window leaves fewer than minimum alternative rounds")

  expect(() =>
    resolveExploration(
      plan,
      { mode: "observations", after: 2 },
      [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
      standardSupport,
      profiles,
    ),
  ).toThrow("Exploration observation window leaves fewer than minimum alternative rounds")
})

test("B03: 历史担忧重现 T=7, N=7, M=2 (7+2=9 > 7) 明确拒绝", () => {
  const { plan, profiles } = fixturePlan(7) // T=7
  expect(() =>
    resolveExploration(
      plan,
      { mode: "observations", after: 7 }, // N=7
      [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
      standardSupport,
      profiles,
    ),
  ).toThrow("Exploration observation window leaves fewer than minimum alternative rounds")
})

test("B04: 合理分配 T=7, N=5, M=2 (5+2=7 <= 7) 允许", () => {
  const { plan, profiles } = fixturePlan(7)
  const res = resolveExploration(
    plan,
    { mode: "observations", after: 5 },
    [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
    standardSupport,
    profiles,
  )
  expect(res.enabled).toBe(true)
  expect(res.policy?.trigger).toEqual({ kind: "attempts", observations: 5 })
})

test("B05: 只差一轮 T=7, N=6, M=2 (6+2=8 > 7) 拒绝", () => {
  const { plan, profiles } = fixturePlan(7)
  expect(() =>
    resolveExploration(
      plan,
      { mode: "observations", after: 6 },
      [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
      standardSupport,
      profiles,
    ),
  ).toThrow("Exploration observation window leaves fewer than minimum alternative rounds")
})

test("B06: 最大与最低不同 T=7, N=5, M=2 (备用最多 4 轮) 允许", () => {
  const { plan, profiles } = fixturePlan(7)
  const templateWithMoreMaxRounds: HostExplorationTemplate = {
    ...FIXTURE_REPORT_EXPLORATION_TEMPLATE,
    policy: {
      ...FIXTURE_REPORT_EXPLORATION_TEMPLATE.policy,
      allowance: {
        ...FIXTURE_REPORT_EXPLORATION_TEMPLATE.policy.allowance,
        rounds: 4, // 备用最多 4 轮
        minimumRounds: 2, // 备用最低 2 轮
      },
    },
  }
  const res = resolveExploration(
    plan,
    { mode: "observations", after: 5 }, // 5 + 2 = 7 <= 7 (即使 5 + 4 = 9 > 7，仍然允许静态通过)
    [templateWithMoreMaxRounds],
    standardSupport,
    profiles,
  )
  expect(res.enabled).toBe(true)
})

test("B07: 足够配置 T=4, N=2, M=2 在准备阶段允许", () => {
  const { plan, profiles } = fixturePlan(4)
  const res = resolveExploration(
    plan,
    { mode: "auto" },
    [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
    standardSupport,
    profiles,
  )
  expect(res.enabled).toBe(true)
})

test("B08: 原始关闭模式在任意轮数保持不变", () => {
  const { plan, profiles } = fixturePlan(1)
  const offRes = resolveExploration(plan, { mode: "off" }, [FIXTURE_REPORT_EXPLORATION_TEMPLATE], standardSupport, profiles)
  expect(offRes.enabled).toBe(false)
  expect(offRes.policy).toBeUndefined()
})

test("B09: 整数边界极限组合拒绝非安全整数", () => {
  const { plan, profiles } = fixturePlan(Number.MAX_SAFE_INTEGER)
  expect(() =>
    resolveExploration(
      plan,
      { mode: "observations", after: Number.MAX_SAFE_INTEGER },
      [FIXTURE_REPORT_EXPLORATION_TEMPLATE],
      standardSupport,
      profiles,
    ),
  ).toThrow("Exploration observation window leaves fewer than minimum alternative rounds")
})

function v2(kind: "window" | "metric" = "window"): HostExplorationTemplateV2 {
  const { defaultObservations, ...policy } = structuredClone(FIXTURE_REPORT_EXPLORATION_TEMPLATE.policy)
  return {
    ...structuredClone(FIXTURE_REPORT_EXPLORATION_TEMPLATE),
    schema: "aev.exploration-template.v2",
    id: `approved-${kind}`,
    policy: {
      ...policy, schema: "aev.exploration-policy.v2",
      window: { minimumRounds: 2, maximumRounds: kind === "window" ? 2 : 5 },
      trigger: kind === "window" ? { kind } : {
        kind, name: "quality", direction: "max", minimumDelta: 0.1, minimumObservations: 3, patience: 2,
      },
      budget: { mode: "best_effort" },
    },
    overrides: kind === "window" ? { afterRound: { minimum: 1, maximum: 5 } } : {
      minimumRounds: { minimum: 1, maximum: 4 }, maximumRounds: { minimum: 4, maximum: 5 },
      patience: { minimum: 1, maximum: 4 },
    },
  }
}

test("V1 value and fingerprint remain identical; window never upgrades a V1 template", () => {
  const { plan, profiles } = fixturePlan(7)
  const template = FIXTURE_REPORT_EXPLORATION_TEMPLATE
  const { defaultObservations, ...policy } = template.policy
  const expected: ExplorationPolicy = { ...policy, schema: "aev.exploration-policy.v1", trigger: { kind: "attempts", observations: defaultObservations } }
  const result = resolveExploration(plan, { mode: "auto" }, [template], standardSupport, profiles)
  expect(result.policy).toEqual(expected)
  expect(explorationIdentityAny(result.policy, plan)).toBe(explorationIdentity(expected, plan))
  expect(() => resolveExploration(plan, { mode: "window", afterRound: 2 }, [template], standardSupport, profiles)).toThrow("No matching")
})

test("V2 window uses approved rounds, exact template ID, and best_effort without mutation", () => {
  const { plan, profiles } = fixturePlan(7)
  const template = v2()
  const before = structuredClone(template)
  const second = { ...v2(), id: "second" }
  expect(resolveExploration(plan, { mode: "auto" }, [template, second], standardSupport, profiles).reason).toContain("Ambiguous")
  const result = resolveExploration(plan, { mode: "window", afterRound: 5, template: template.id, budgetMode: "best_effort" },
    [template, second], standardSupport, profiles)
  expect(result.policy).toEqual({ ...template.policy, window: { minimumRounds: 5, maximumRounds: 5 } })
  expect(template).toEqual(before)
  expect(result.template).not.toBe(template)
  expect(resolveExploration(plan, { mode: "auto", template: template.id }, [template, second], standardSupport, profiles).policy).toEqual(template.policy)
  expect(() => resolveExploration(plan, { mode: "auto", template: "missing" }, [template], standardSupport, profiles)).toThrow("No matching")
  expect(() => resolveExploration(plan, { mode: "window", afterRound: 6 }, [template], standardSupport, profiles)).toThrow("approved template range")
  expect(() => resolveExploration(plan, { mode: "window", afterRound: 5 }, [template], standardSupport, profiles.slice(1))).toThrow("No trusted profiles")
})

test("V2 cannot enlarge window without approval or truncate a conflicting global limit", () => {
  const { plan, profiles } = fixturePlan(7)
  const template = v2()
  delete template.overrides
  expect(() => resolveExploration(plan, { mode: "window", afterRound: 3 }, [template], standardSupport, profiles)).toThrow("approved template range")
  template.overrides = { afterRound: { minimum: 1, maximum: 7 } }
  expect(() => resolveExploration(plan, { mode: "window", afterRound: 7 }, [template], standardSupport, profiles)).toThrow("exceeds plan stop rounds")
})

test("V2 metric inherits trusted metadata and matches formal best_pass metric/direction", () => {
  const { plan, profiles } = fixturePlan(7)
  const template = v2("metric")
  const scored = { ...plan, selection: { rule: "best_pass" as const, metric: "quality", direction: "max" as const } }
  const result = resolveExploration(scored, { mode: "metric", minimumRounds: 3, maximumRounds: 4, patience: 4 },
    [template], standardSupport, profiles)
  expect((result.policy as ExplorationPolicyV2).window).toEqual({ minimumRounds: 3, maximumRounds: 4 })
  if (template.policy.trigger.kind !== "metric") throw new Error("Expected metric fixture")
  expect(result.policy?.trigger).toEqual({ ...template.policy.trigger, patience: 4 })
  for (const selection of [plan.selection, { ...scored.selection, metric: "other" }, { ...scored.selection, direction: "min" as const }]) {
    expect(() => resolveExploration({ ...plan, selection }, { mode: "metric" }, [template], standardSupport, profiles)).toThrow()
  }
  expect(() => resolveExploration(scored, { mode: "metric", patience: 5 }, [template], standardSupport, profiles)).toThrow("approved template range")
})

test("request fields and numeric bounds are strict, including auto/off and reserved", () => {
  const { plan, profiles } = fixturePlan(7)
  const invalid: unknown[] = [null, [], { mode: null }, { mode: undefined }, { mode: "auto", typo: true }, { mode: "off", afterRound: 1 },
    { mode: "auto", template: "" }, { mode: "metric", name: "untrusted" }, { mode: "metric", minimumDelta: 1 },
    { mode: "metric", minimumRounds: 4, maximumRounds: 3 }, { mode: "window" },
    ...[0, -1, 1.2, NaN, Infinity, "2", Number.MAX_SAFE_INTEGER + 1, undefined].map(afterRound => ({ mode: "window", afterRound })),
    ...["auto", "observations", "window", "metric"].map(mode => ({ mode, budgetMode: "reserved" })),
  ]
  for (const request of invalid) expect(() => resolveExploration(plan, request as ExplorationRequest, [v2()], standardSupport, profiles)).toThrow()
})

test("V2 template unknown fields, invalid approvals, duplicate IDs and reserved are rejected", () => {
  const { plan, profiles } = fixturePlan(7)
  for (const template of [
    { ...v2(), extra: true },
    { ...v2(), policy: { ...v2().policy, budget: { mode: "reserved" } } },
    { ...v2(), overrides: { afterRound: { minimum: 3, maximum: 2 } } },
    { ...v2(), overrides: { allowance: { minimum: 1, maximum: 2 } } },
    { ...v2(), policy: { ...v2().policy, extra: true } },
  ]) expect(() => resolveExploration(plan, { mode: "auto" }, [template as HostExplorationTemplate], standardSupport, profiles)).toThrow()
  expect(() => resolveExploration(plan, { mode: "auto" }, [v2(), v2()], standardSupport, profiles)).toThrow("Duplicate")
})
