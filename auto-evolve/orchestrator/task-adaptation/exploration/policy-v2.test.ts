import { expect, test } from "bun:test"
import { validateExplorationPolicyV2, type ExplorationPolicyV2 } from "./policy-v2"
import { explorationPolicy, explorationIdentity, type ExplorationPolicy } from "./policy"
import { validatePlan, type Plan } from "../plan"
import { canonical, fingerprint } from "../../protocol-plugins/identity"

function fixturePlan(): Plan {
  return {
    schema: "aev.task-plan.v1",
    id: "exploration-local-fixture",
    objective: "Create a report",
    deliverable: { kind: "report", entries: ["report", "facts"] },
    resources: [
      { id: "report", path: "report.md", mutable: true, audience: "public" },
      { id: "facts", path: "facts.md", mutable: true, audience: "public" },
      { id: "source", path: "source.txt", mutable: false, audience: "public" },
      { id: "private", path: "private.txt", mutable: false, audience: "private" },
    ],
    capabilities: [],
    windows: [{ role: "checker", stage: "accept", reads: ["report"], writes: [], inline: [], actions: ["read"] }],
    workers: [],
    acceptance: {
      execution: "none",
      checks: [
        {
          id: "quality",
          target: "candidate",
          mechanism: "script",
          purpose: "Check fixture",
          required: true,
          resources: ["report"],
          feedback: "message",
        },
      ],
    },
    rejection: [{ check: "quality", actions: ["repair"] }],
    selection: { rule: "first_pass" },
    stop: { rounds: 7, calls: 100, tokens: 100000, stagnant: 2 },
  }
}

function fixtureV1Policy(): ExplorationPolicy {
  return {
    schema: "aev.exploration-policy.v1",
    origin: { kind: "initial" },
    replace: ["report"],
    preserve: ["facts"],
    dependencies: ["source"],
    trigger: { kind: "attempts", observations: 2 },
    allowance: {
      rounds: 2,
      minimumRounds: 2,
      authorCalls: 5,
      authorTokens: 10000,
      acceptanceCalls: 1,
      acceptanceTokens: 1000,
      deliveryCalls: 0,
      deliveryTokens: 0,
    },
    bounds: { archiveBytes: 1000000, candidateBytes: 10000, dependencyBytes: 10000 },
    safety: { reset: "declared_entries", effects: "sandbox_only" },
  }
}

function v2WindowFixture(stopRounds = 7) {
  const p = fixturePlan()
  p.stop.rounds = stopRounds
  const original = fixtureV1Policy()
  const v2 = {
    schema: "aev.exploration-policy.v2" as const,
    origin: structuredClone(original.origin),
    replace: [...original.replace],
    preserve: [...original.preserve],
    dependencies: [...original.dependencies],
    window: { minimumRounds: 5, maximumRounds: 5 },
    trigger: { kind: "window" as const },
    allowance: {
      ...original.allowance,
      rounds: 2,
      minimumRounds: 2,
    },
    budget: { mode: "best_effort" as const },
    bounds: structuredClone(original.bounds),
    safety: structuredClone(original.safety),
  }
  return { plan: p, policy: v2 }
}

test("V201: 无修改，N=7/f=h=5/m=b=2 合法且返回深冻结 V2", () => {
  const { plan, policy } = v2WindowFixture(7)
  const result = validateExplorationPolicyV2(policy, plan)
  expect(result.schema).toBe("aev.exploration-policy.v2")
  expect(result.window).toEqual({ minimumRounds: 5, maximumRounds: 5 })
  expect(result.trigger).toEqual({ kind: "window" })
  expect(result.allowance.rounds).toBe(2)
  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result.window)).toBe(true)
})

test("V202: N=9/f=h=7/m=b=2 合法；固定第 7 轮取舍可表达", () => {
  const { plan, policy } = v2WindowFixture(9)
  policy.window = { minimumRounds: 7, maximumRounds: 7 }
  policy.allowance.rounds = 2
  policy.allowance.minimumRounds = 2
  const result = validateExplorationPolicyV2(policy, plan)
  expect(result.window).toEqual({ minimumRounds: 7, maximumRounds: 7 })
})

test("V203: N=7/f=h=7/m=b=2 拒绝 h+m>N", () => {
  const { plan, policy } = v2WindowFixture(7)
  policy.window = { minimumRounds: 7, maximumRounds: 7 } // 7 + 2 = 9 > 7
  expect(() => validateExplorationPolicyV2(policy, plan)).toThrow(/exceeds plan stop rounds/)
})

test("V204: N=7/f=4/h=5/m=2/b=4 拒绝 b>N-f (4 > 7-4=3)", () => {
  const { plan, policy } = v2WindowFixture(7)
  policy.window = { minimumRounds: 4, maximumRounds: 5 }
  policy.allowance.rounds = 4 // b=4, N-f = 7-4 = 3, 4 > 3
  policy.allowance.minimumRounds = 2
  expect(() => validateExplorationPolicyV2(policy, plan)).toThrow(/exceeds remaining rounds from window minimum/)
})

test("V205: f=0 或 h<f；m=0 或 b<m 分别拒绝", () => {
  const { plan, policy } = v2WindowFixture(7)
  // f=0
  const fZero = structuredClone(policy)
  fZero.window.minimumRounds = 0
  expect(() => validateExplorationPolicyV2(fZero, plan)).toThrow(/minimumRounds/)

  // h < f
  const hSmaller = structuredClone(policy)
  hSmaller.window.minimumRounds = 5
  hSmaller.window.maximumRounds = 4
  expect(() => validateExplorationPolicyV2(hSmaller, plan)).toThrow(/cannot exceed maximumRounds/)

  // m=0
  const mZero = structuredClone(policy)
  mZero.allowance.minimumRounds = 0
  expect(() => validateExplorationPolicyV2(mZero, plan)).toThrow(/minimumRounds/)

  // b < m
  const bSmaller = structuredClone(policy)
  bSmaller.allowance.rounds = 1
  bSmaller.allowance.minimumRounds = 2
  expect(() => validateExplorationPolicyV2(bSmaller, plan)).toThrow(/cannot exceed rounds/)
})

test("V206: window 多一字段或少一字段拒绝", () => {
  const { plan, policy } = v2WindowFixture(7)
  const extra = structuredClone(policy)
  ;(extra.window as any).extra = 1
  expect(() => validateExplorationPolicyV2(extra, plan)).toThrow(/Invalid exploration window/)

  const missing = structuredClone(policy)
  delete (missing.window as any).maximumRounds
  expect(() => validateExplorationPolicyV2(missing, plan)).toThrow(/Invalid exploration window/)
})

test("V207: trigger:{kind:'window',patience:2} 拒绝未知字段", () => {
  const { plan, policy } = v2WindowFixture(7)
  const bad = structuredClone(policy)
  ;(bad.trigger as any).patience = 2
  expect(() => validateExplorationPolicyV2(bad, plan)).toThrow(/Invalid exploration window trigger/)
})

test("V208: budget:{mode:'reserved'} 拒绝且不自动替换", () => {
  const { plan, policy } = v2WindowFixture(7)
  const bad = structuredClone(policy)
  ;(bad.budget as any).mode = "reserved"
  expect(() => validateExplorationPolicyV2(bad, plan)).toThrow(/only 'best_effort' is supported/)
})

test("V209: budget:{mode:'best_effort',extra:1} 拒绝", () => {
  const { plan, policy } = v2WindowFixture(7)
  const bad = structuredClone(policy)
  ;(bad.budget as any).extra = 1
  expect(() => validateExplorationPolicyV2(bad, plan)).toThrow(/Invalid exploration budget/)
})

test("V210: metric 触发与 first_pass Plan 配对拒绝", () => {
  const { plan, policy } = v2WindowFixture(7)
  plan.selection = { rule: "first_pass" }
  const metricPolicy = {
    ...policy,
    trigger: {
      kind: "metric" as const,
      name: "score",
      direction: "max" as const,
      minimumDelta: 0.1,
      minimumObservations: 2,
      patience: 2,
    },
  }
  expect(() => validateExplorationPolicyV2(metricPolicy, plan)).toThrow(/requires a plan with best_pass selection rule/)
})

test("V211: best_pass + 正式同名同方向 metric (score/max) 合法且不产生额外评测调用", () => {
  const { plan, policy } = v2WindowFixture(7)
  plan.selection = { rule: "best_pass", metric: "score", direction: "max" }
  const metricPolicy = {
    ...policy,
    trigger: {
      kind: "metric" as const,
      name: "score",
      direction: "max" as const,
      minimumDelta: 0.1,
      minimumObservations: 2,
      patience: 2,
    },
  }
  const result = validateExplorationPolicyV2(metricPolicy, plan)
  expect(result.trigger).toEqual(metricPolicy.trigger)
})

test("V212: best_pass metric 名称不符、方向不符、负 Delta、NaN、零耐心分别拒绝", () => {
  const { plan, policy } = v2WindowFixture(7)
  plan.selection = { rule: "best_pass", metric: "score", direction: "max" }
  const base = {
    ...policy,
    trigger: {
      kind: "metric" as const,
      name: "score",
      direction: "max" as const,
      minimumDelta: 0.1,
      minimumObservations: 2,
      patience: 2,
    },
  }

  // 名称不符
  const badName = structuredClone(base)
  badName.trigger.name = "other_score"
  expect(() => validateExplorationPolicyV2(badName, plan)).toThrow(/does not match plan selection metric/)

  // 方向不符
  const badDir = structuredClone(base)
  badDir.trigger.direction = "min"
  expect(() => validateExplorationPolicyV2(badDir, plan)).toThrow(/does not match plan selection direction/)

  // 负 Delta
  const negDelta = structuredClone(base)
  negDelta.trigger.minimumDelta = -0.1
  expect(() => validateExplorationPolicyV2(negDelta, plan)).toThrow(/minimumDelta/)

  // NaN
  const nanDelta = structuredClone(base)
  nanDelta.trigger.minimumDelta = NaN
  expect(() => validateExplorationPolicyV2(nanDelta, plan)).toThrow(/minimumDelta/)

  // 零耐心
  const zeroPatience = structuredClone(base)
  zeroPatience.trigger.patience = 0
  expect(() => validateExplorationPolicyV2(zeroPatience, plan)).toThrow(/patience/)
})

test("V213: origin 错误、依赖 private、替换/保留分区错误仍被复用的 V1 校验拒绝", () => {
  const { plan, policy } = v2WindowFixture(7)

  // origin 错误
  const badOrigin = structuredClone(policy)
  ;(badOrigin.origin as any).kind = "unknown"
  expect(() => validateExplorationPolicyV2(badOrigin, plan)).toThrow()

  // 依赖 private
  const badDeps = structuredClone(policy)
  badDeps.dependencies = ["private"]
  expect(() => validateExplorationPolicyV2(badDeps, plan)).toThrow()

  // 替换/保留冲突 (相同 resource 既在 replace 又在 preserve)
  const badPartition = structuredClone(policy)
  badPartition.preserve = ["report"]
  expect(() => validateExplorationPolicyV2(badPartition, plan)).toThrow()

  // unsafe safety
  const badSafety = structuredClone(policy)
  ;(badSafety.safety as any).effects = "system_wide"
  expect(() => validateExplorationPolicyV2(badSafety, plan)).toThrow()
})

test("V214: calls/tokens 最低完整备用周期超过 Plan.stop 拒绝", () => {
  const { plan, policy } = v2WindowFixture(7)
  plan.stop.calls = 5 // 限制全局调用为 5
  policy.allowance.authorCalls = 100 // 单周期就需要 100
  expect(() => validateExplorationPolicyV2(policy, plan)).toThrow(/budget|Minimum exploration cycle/)
})

test("V215: 非安全整数、N/h+m 溢出拒绝", () => {
  const { plan, policy } = v2WindowFixture(7)
  policy.window.maximumRounds = Number.MAX_SAFE_INTEGER
  expect(() => validateExplorationPolicyV2(policy, plan)).toThrow(/exceeds plan stop rounds|safe integer/)
})

test("V216: 任意未知顶层字段、V1 policy 冒充 V2、缺少 schema 拒绝", () => {
  const { plan, policy } = v2WindowFixture(7)

  // 未知顶层字段
  const extraField = structuredClone(policy)
  ;(extraField as any).stagnant = 4
  expect(() => validateExplorationPolicyV2(extraField, plan)).toThrow(/Invalid exploration policy v2/)

  // V1 policy 冒充 V2
  const v1 = fixtureV1Policy()
  expect(() => validateExplorationPolicyV2(v1, plan)).toThrow(/Invalid exploration policy v2/)

  // 缺少 schema
  const noSchema = structuredClone(policy)
  delete (noSchema as any).schema
  expect(() => validateExplorationPolicyV2(noSchema, plan)).toThrow(/Invalid exploration policy v2/)
})

test("V217: 重复输入重复校验 canonical 结果恒等，原 raw 与 plan 不被修改", () => {
  const { plan, policy } = v2WindowFixture(7)
  const rawCopy = JSON.stringify(policy)
  const planCopy = JSON.stringify(plan)

  const res1 = validateExplorationPolicyV2(policy, plan)
  const res2 = validateExplorationPolicyV2(policy, plan)

  expect(canonical(res1)).toBe(canonical(res2))
  expect(JSON.stringify(policy)).toBe(rawCopy)
  expect(JSON.stringify(plan)).toBe(planCopy)
})

test("V218: 旧 explorationPolicy(V1)、validatePlan(V1)、explorationIdentity(V1) 原样通过，旧指纹相同", () => {
  const p = fixturePlan()
  const v1 = fixtureV1Policy()
  const validV1 = explorationPolicy(v1, p)
  expect(validV1?.schema).toBe("aev.exploration-policy.v1")

  const planWithV1 = { ...p, exploration: v1 }
  const validPlan = validatePlan(planWithV1)
  expect(validPlan.exploration?.schema).toBe("aev.exploration-policy.v1")

  const id1 = explorationIdentity(v1, p)
  const id2 = explorationIdentity(validV1!, p)
  expect(id1).toBe(id2)
})

test("V219: 将 V2 直接塞入当前 validatePlan 仍拒绝，证明未偷开生产入口", () => {
  const { plan, policy } = v2WindowFixture(7)
  const v2 = validateExplorationPolicyV2(policy, plan)
  const planWithV2 = { ...plan, exploration: v2 }
  expect(() => validatePlan(planWithV2 as any)).toThrow()
})

test("V220: window 合法但没有实际关闭轮事件，validator 只证明静态合法性", () => {
  const { plan, policy } = v2WindowFixture(7)
  const v2 = validateExplorationPolicyV2(policy, plan)
  expect(v2.schema).toBe("aev.exploration-policy.v2")
  // 纯静态校验，不产生异步请求或副作用
})
