import { describe, expect, test } from "bun:test"
import { readExplorationPolicy, explorationIdentityAny } from "./policy-reader"
import { explorationPolicy, explorationIdentity, type ExplorationPolicy } from "./policy"
import { validateExplorationPolicyV2, type ExplorationPolicyV2 } from "./policy-v2"
import { validatePlan, type Plan } from "../plan"
import { requireExplorationHost } from "./entry"

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
    windows: [
      { role: "planner", stage: "explore", reads: ["report"], writes: [], inline: [], actions: ["read"] },
      { role: "executor", stage: "explore", reads: ["report"], writes: ["report"], inline: [], actions: ["read", "edit"] },
      { role: "worker", stage: "explore", reads: ["report"], writes: [], inline: [], actions: ["read"] },
      { role: "lead", stage: "revise", reads: ["report"], writes: ["report"], inline: [], actions: ["read", "edit"] },
      { role: "reviewer", stage: "accept", reads: ["report"], writes: [], inline: [], actions: ["read"] },
      { role: "diagnostician", stage: "revise", reads: ["report"], writes: [], inline: [], actions: ["read"] },
      { role: "checker", stage: "accept", reads: ["report"], writes: [], inline: [], actions: ["read"] },
    ],
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

function fixtureV1(): ExplorationPolicy {
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

function fixtureV2Window(): ExplorationPolicyV2 {
  return {
    schema: "aev.exploration-policy.v2",
    origin: { kind: "initial" },
    replace: ["report"],
    preserve: ["facts"],
    dependencies: ["source"],
    window: { minimumRounds: 3, maximumRounds: 5 },
    trigger: { kind: "window" },
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
    budget: { mode: "best_effort" },
    bounds: { archiveBytes: 1000000, candidateBytes: 10000, dependencyBytes: 10000 },
    safety: { reset: "declared_entries", effects: "sandbox_only" },
  }
}

describe("Exploration Policy Reader", () => {
  test("1. V1 identity 与原 explorationIdentity(V1,Plan) 逐字相同", () => {
    const plan = fixturePlan()
    const v1 = fixtureV1()
    const idOld = explorationIdentity(v1, plan)
    const idAny = explorationIdentityAny(v1, plan)
    expect(idAny).toBe(idOld)
  })

  test("2. V2 window 已冻结身份稳定、V2 不能误用 V1 Reader", () => {
    const plan = fixturePlan()
    const v2 = fixtureV2Window()
    const read = readExplorationPolicy(v2, plan)
    expect(read?.schema).toBe("aev.exploration-policy.v2")

    // 直接调用 V1 Reader 会抛出 Invalid exploration policy
    expect(() => explorationPolicy(v2 as any, plan)).toThrow("Invalid exploration policy")
  })

  test("3. V2 metric 通过独立 Schema 校验，但 Host preflight / requireExplorationHost 必须明确拒绝", () => {
    const plan = {
      ...fixturePlan(),
      selection: { rule: "best_pass" as const, metric: "score", direction: "max" as const },
    }
    const v2Metric: ExplorationPolicyV2 = {
      ...fixtureV2Window(),
      trigger: {
        kind: "metric",
        name: "score",
        direction: "max",
        minimumDelta: 1,
        minimumObservations: 2,
        patience: 2,
      },
    }
    // 独立静态校验可过
    const valid = validateExplorationPolicyV2(v2Metric, plan)
    expect(valid.schema).toBe("aev.exploration-policy.v2")

    // Host 准入必须明确拒绝
    const planWithMetric = { ...plan, exploration: valid }
    expect(() => requireExplorationHost(planWithMetric)).toThrow(
      "Host V2 metric scoring binding not implemented"
    )
  })

  test("4. 不存在 exploration 时旧 Plan identity、preflight 行为不变", () => {
    const plan = fixturePlan()
    expect(readExplorationPolicy(undefined, plan)).toBeUndefined()
    expect(explorationIdentityAny(undefined, plan)).toBeUndefined()
    // requireExplorationHost 静默通过
    expect(() => requireExplorationHost(plan)).not.toThrow()
  })

  test("5. 已冻结 V2 window 受 Host 原权限窗口约束", () => {
    const plan = fixturePlan()
    const v2 = fixtureV2Window()
    const validPlan = validatePlan({ ...plan, exploration: v2 })
    expect(() => requireExplorationHost(validPlan)).not.toThrow()

    // 缺少必要角色窗口
    const planMissingRole = {
      ...validPlan,
      windows: validPlan.windows.filter((w) => w.role !== "lead"),
    }
    expect(() => requireExplorationHost(planMissingRole)).toThrow(
      "Exploration Host role window missing: lead/revise"
    )
  })

  test("6. V2 预算超限依然失败，不能把静态通过等同于可执行", () => {
    const plan = fixturePlan()
    const v2Overflow: ExplorationPolicyV2 = {
      ...fixtureV2Window(),
      window: { minimumRounds: 6, maximumRounds: 6 },
      allowance: {
        ...fixtureV2Window().allowance,
        minimumRounds: 2,
        rounds: 2,
      },
    }
    // 6 + 2 = 8 > plan.stop.rounds (7)
    expect(() => readExplorationPolicy(v2Overflow, plan)).toThrow(/exceeds plan stop rounds/)
  })

  test("7. 混合 V1/V2 相同路径的 scope.policy 必须不同，不能跨版本拿旧缓存当 V2 决策", () => {
    const plan = fixturePlan()
    const v1 = fixtureV1()
    const v2 = fixtureV2Window()
    const idV1 = explorationIdentityAny(v1, plan)
    const idV2 = explorationIdentityAny(v2, plan)
    expect(idV1).toBeDefined()
    expect(idV2).toBeDefined()
    expect(idV1).not.toBe(idV2)
  })

  test("8. 未知/非法 exploration schema 拒绝", () => {
    const plan = fixturePlan()
    expect(() =>
      readExplorationPolicy({ schema: "aev.exploration-policy.v999" }, plan)
    ).toThrow(/Unsupported exploration policy schema/)
  })

  test("A01: 合法原 fixturePlan() 不含探索字段；validatePlan + Reader 仍合法且 Reader undefined", () => {
    const raw = fixturePlan()
    delete (raw as any).exploration
    const validated = validatePlan(raw)
    expect(validated.exploration).toBeUndefined()
    expect(readExplorationPolicy(validated.exploration, validated)).toBeUndefined()
    expect(explorationIdentityAny(validated.exploration, validated)).toBeUndefined()
  })

  test("A02: validatePlan({...fixturePlan(), exploration:null}) 抛错而非合法普通任务", () => {
    const raw = { ...fixturePlan(), exploration: null }
    expect(() => validatePlan(raw)).toThrow(/Invalid exploration policy: explicit null not allowed/)
  })

  test("A03: readExplorationPolicy(null,fixturePlan()) 与 explorationIdentityAny(null,fixturePlan()) 均拒绝", () => {
    const plan = fixturePlan()
    expect(() => readExplorationPolicy(null, plan)).toThrow(/Invalid exploration policy: explicit null not allowed/)
    expect(() => explorationIdentityAny(null, plan)).toThrow(/Invalid exploration policy: explicit null not allowed/)
  })

  test("A04: 正确 V1 fixture 和已批准 V2 window fixture 都仍合法；V1/V2 指纹与基线完全一致", () => {
    const plan = fixturePlan()
    const v1 = fixtureV1()
    const v2 = fixtureV2Window()
    const validatedV1 = readExplorationPolicy(v1, plan)
    const validatedV2 = readExplorationPolicy(v2, plan)
    expect(validatedV1).toBeDefined()
    expect(validatedV2).toBeDefined()
    expect(explorationIdentityAny(v1, plan)).toBe(explorationIdentity(v1, plan))
    expect(explorationIdentityAny(v2, plan)).toBeDefined()
  })

  test("A05: exploration:undefined 显式写在 Plan 里仍由 validatePlan 拒绝，不变成 off", () => {
    const raw = { ...fixturePlan(), exploration: undefined }
    expect(() => validatePlan(raw)).toThrow(/Explicit exploration policy required/)
  })
})
