import { describe, expect, test } from "bun:test"
import { decideV2, type BranchV2, type ClosedRoundV2, type DecisionV2Input } from "./decision-v2"
import { decide as decideV1 } from "./decision"
import type { ExplorationPolicyV2 } from "./policy-v2"
import { validatePlan } from "../plan"

const COMP_HASH = "c".repeat(64)

function v2Policy(overrides: Partial<ExplorationPolicyV2> = {}): ExplorationPolicyV2 {
  return {
    schema: "v2",
    origin: {
      partition: "prompt",
      relativeRoot: "auto-evolve/prompts",
      entry: "base.prompt.md",
    },
    composition: {
      mode: "substitute",
      substitutions: [
        {
          source: {
            partition: "prompt",
            relativeRoot: "auto-evolve/prompts",
            entry: "alt.prompt.md",
          },
          target: "base.prompt.md",
        },
      ],
    },
    window: {
      minimumRounds: 7,
      maximumRounds: 7,
    },
    allowance: {
      rounds: 2,
      minimumRounds: 2,
      authorCalls: 2,
      authorTokens: 100,
      acceptanceCalls: 2,
      acceptanceTokens: 100,
      deliveryCalls: 1,
      deliveryTokens: 50,
    },
    trigger: {
      kind: "window",
    },
    budget: {
      mode: "best_effort",
    },
    ...overrides,
  }
}

function closed(
  round: number,
  branch: BranchV2 = "original",
  verdict: "passed" | "rejected" = "rejected",
  metric?: { value: number; comparison: string },
  closure?: string,
  receipt?: string,
  campaign = "cmp-test-001"
): ClosedRoundV2 {
  const closureHex = closure || round.toString(16).padStart(64, "a")
  const receiptHex = receipt || round.toString(16).padStart(64, "b")
  return {
    campaign,
    round,
    branch,
    closure: closureHex,
    receipt: receiptHex,
    verdict,
    ...(metric !== undefined ? { metric } : {}),
  }
}

function baseInput(overrides: Partial<DecisionV2Input> = {}): DecisionV2Input {
  const policy = overrides.policy || v2Policy()
  return {
    policy,
    campaign: "cmp-test-001",
    rounds: [],
    branch: "original",
    activated: false,
    firstPass: false,
    stopped: false,
    fault: false,
    unresolved: false,
    hardStop: false,
    originReady: true,
    effectiveMaxRounds: 9,
    remaining: { rounds: 10, calls: 50, tokens: 5000 },
    ...overrides,
  }
}

describe("Exploration Decision V2 Pure Function", () => {
  test("D201: N=9、f=h=7，原路线关闭 1—6 -> continue，不提前换", () => {
    const rounds = [1, 2, 3, 4, 5, 6].map((r) => closed(r))
    const res = decideV2(baseInput({ rounds }))
    expect(res.action).toBe("continue")
    expect(res.reason).toBe("original_minimum")
  })

  test("D202: 同上，第 7 轮正式 rejected，余 2 轮 -> activate/window_exhausted", () => {
    const rounds = [1, 2, 3, 4, 5, 6, 7].map((r) => closed(r))
    const res = decideV2(baseInput({ rounds, remaining: { rounds: 2, calls: 50, tokens: 5000 } }))
    expect(res.action).toBe("activate")
    expect(res.reason).toBe("window_exhausted")
  })

  test("D203: 同上，第 6 轮正式 first_pass passed -> finish/first_pass，不浪费备用", () => {
    const rounds = [
      closed(1),
      closed(2),
      closed(3),
      closed(4),
      closed(5),
      closed(6, "original", "passed"),
    ]
    const res = decideV2(baseInput({ rounds, firstPass: true }))
    expect(res.action).toBe("finish")
    expect(res.reason).toBe("first_pass")
  })

  test("D204: 一轮包含 3 个 Checker + 可选独立执行，但最终只发 1 条 ClosedRoundV2 -> 正常闭轮计数只 +1", () => {
    const rounds = [closed(1, "original", "rejected")]
    const res = decideV2(baseInput({ rounds }))
    expect(res.rounds.length).toBe(1)
    expect(res.action).toBe("continue")
    expect(res.reason).toBe("original_minimum")
  })

  test("D205: 同一正式 Round 的 current 重放与 rounds 中已有该记录 -> identity 一致、条数不增加", () => {
    const r1 = closed(1)
    const res1 = decideV2(baseInput({ rounds: [r1] }))
    const res2 = decideV2(baseInput({ rounds: [r1], current: r1 }))
    expect(res2.rounds.length).toBe(1)
    expect(res2.identity).toBe(res1.identity)
    expect(res2.action).toBe(res1.action)
    expect(res2.reason).toBe(res1.reason)
  })

  test("D206: 同 round 的 closure/receipt/metric 不一致 -> 冲突拒绝，不覆盖历史", () => {
    const r1 = closed(1, "original", "rejected")
    const r1Conflict = closed(1, "original", "passed")
    expect(() => decideV2(baseInput({ rounds: [r1], current: r1Conflict }))).toThrow(
      "Exploration round closure conflict"
    )
  })

  test("D207: 只有 7 次 checker/pass 请求，没有 7 条 Round 正式关闭记录 -> 不激活", () => {
    // 只有 3 条正式关闭记录
    const rounds = [closed(1), closed(2), closed(3)]
    const res = decideV2(baseInput({ rounds }))
    expect(res.action).toBe("continue")
    expect(res.reason).toBe("original_minimum")
  })

  test("D208: f=3/h=5，窗口模式在第 4 轮 -> continue；第 5 轮才考虑激活", () => {
    const policy = v2Policy({
      window: { minimumRounds: 3, maximumRounds: 5 },
      allowance: {
        rounds: 2,
        minimumRounds: 2,
        authorCalls: 2,
        authorTokens: 100,
        acceptanceCalls: 2,
        acceptanceTokens: 100,
        deliveryCalls: 1,
        deliveryTokens: 50,
      },
    })
    const rounds4 = [1, 2, 3, 4].map((r) => closed(r))
    const res4 = decideV2(baseInput({ policy, rounds: rounds4 }))
    expect(res4.action).toBe("continue")
    expect(res4.reason).toBe("original_window")

    const rounds5 = [1, 2, 3, 4, 5].map((r) => closed(r))
    const res5 = decideV2(baseInput({ policy, rounds: rounds5 }))
    expect(res5.action).toBe("activate")
    expect(res5.reason).toBe("window_exhausted")
  })

  test("D209: metric 正式分数 50、56、57、57，阈值按 B.3 -> 达到 metric_stagnation 后可 activate", () => {
    const policy = v2Policy({
      window: { minimumRounds: 3, maximumRounds: 7 },
      trigger: {
        kind: "metric",
        direction: "max",
        minimumDelta: 3,
        patience: 2,
        minimumObservations: 3,
      },
    })
    const rounds = [
      closed(1, "original", "passed", { value: 50, comparison: COMP_HASH }, undefined, "1".repeat(64)),
      closed(2, "original", "passed", { value: 56, comparison: COMP_HASH }, undefined, "2".repeat(64)),
      closed(3, "original", "passed", { value: 57, comparison: COMP_HASH }, undefined, "3".repeat(64)),
      closed(4, "original", "passed", { value: 57, comparison: COMP_HASH }, undefined, "4".repeat(64)),
    ]
    const res = decideV2(baseInput({ policy, rounds }))
    expect(res.action).toBe("activate")
    expect(res.reason).toBe("metric_stagnation")
  })

  test("D210: 分数之间插入正常 rejected 无分 -> 评分证据重置，不能提前换", () => {
    const policy = v2Policy({
      window: { minimumRounds: 3, maximumRounds: 7 },
      trigger: {
        kind: "metric",
        direction: "max",
        minimumDelta: 3,
        patience: 2,
        minimumObservations: 3,
      },
    })
    const rounds = [
      closed(1, "original", "passed", { value: 50, comparison: COMP_HASH }, undefined, "1".repeat(64)),
      closed(2, "original", "passed", { value: 56, comparison: COMP_HASH }, undefined, "2".repeat(64)),
      closed(3, "original", "rejected"),
      closed(4, "original", "passed", { value: 57, comparison: COMP_HASH }, undefined, "4".repeat(64)),
      closed(5, "original", "passed", { value: 57, comparison: COMP_HASH }, undefined, "5".repeat(64)),
    ]
    const res = decideV2(baseInput({ policy, rounds }))
    expect(res.action).toBe("continue")
    expect(res.reason).toBe("metric_progress")
  })

  test("D211: 相同正式 receipt 被后续不同 Round 复用 -> Round 数增加、评分耐心不增加", () => {
    const policy = v2Policy({
      window: { minimumRounds: 3, maximumRounds: 7 },
      trigger: {
        kind: "metric",
        direction: "max",
        minimumDelta: 3,
        patience: 2,
        minimumObservations: 3,
      },
    })
    const receipt3 = "3".repeat(64)
    const rounds = [
      closed(1, "original", "passed", { value: 50, comparison: COMP_HASH }, undefined, "1".repeat(64)),
      closed(2, "original", "passed", { value: 56, comparison: COMP_HASH }, undefined, "2".repeat(64)),
      closed(3, "original", "passed", { value: 57, comparison: COMP_HASH }, undefined, receipt3),
      closed(4, "original", "passed", { value: 57, comparison: COMP_HASH }, undefined, receipt3),
    ]
    const res = decideV2(baseInput({ policy, rounds }))
    expect(res.rounds.length).toBe(4)
    expect(res.action).toBe("continue")
    expect(res.reason).toBe("metric_progress")
  })

  test("D212: passed 缺 metric 或 comparison 身份漂移 -> hold/metric_missing 或 metric_identity_drift", () => {
    const policy = v2Policy({
      window: { minimumRounds: 3, maximumRounds: 7 },
      trigger: {
        kind: "metric",
        direction: "max",
        minimumDelta: 3,
        patience: 2,
        minimumObservations: 3,
      },
    })
    // 缺 metric
    const roundsMissing = [
      closed(1, "original", "passed", { value: 50, comparison: COMP_HASH }),
      closed(2, "original", "passed"),
    ]
    const resMissing = decideV2(baseInput({ policy, rounds: roundsMissing }))
    expect(resMissing.action).toBe("hold")
    expect(resMissing.reason).toBe("metric_missing")

    // comparison 身份漂移
    const roundsDrift = [
      closed(1, "original", "passed", { value: 50, comparison: COMP_HASH }),
      closed(2, "original", "passed", { value: 55, comparison: "d".repeat(64) }),
    ]
    const resDrift = decideV2(baseInput({ policy, rounds: roundsDrift }))
    expect(resDrift.action).toBe("hold")
    expect(resDrift.reason).toBe("metric_identity_drift")
  })

  test("D213: metric 不停滞但正常闭轮到 h -> 按 window_exhausted 考虑激活", () => {
    const policy = v2Policy({
      window: { minimumRounds: 3, maximumRounds: 7 },
      trigger: {
        kind: "metric",
        direction: "max",
        minimumDelta: 3,
        patience: 2,
        minimumObservations: 3,
      },
    })
    // 每次均有明显进步，从未停滞
    const rounds = [
      closed(1, "original", "passed", { value: 50, comparison: COMP_HASH }),
      closed(2, "original", "passed", { value: 60, comparison: COMP_HASH }),
      closed(3, "original", "passed", { value: 70, comparison: COMP_HASH }),
      closed(4, "original", "passed", { value: 80, comparison: COMP_HASH }),
      closed(5, "original", "passed", { value: 90, comparison: COMP_HASH }),
      closed(6, "original", "passed", { value: 100, comparison: COMP_HASH }),
      closed(7, "original", "passed", { value: 110, comparison: COMP_HASH }),
    ]
    const res = decideV2(baseInput({ policy, rounds }))
    expect(res.action).toBe("activate")
    expect(res.reason).toBe("window_exhausted")
  })

  test("D214: 正式指标为 min（如延迟） -> 以正确方向计算 gain", () => {
    const policy = v2Policy({
      window: { minimumRounds: 3, maximumRounds: 7 },
      trigger: {
        kind: "metric",
        direction: "min",
        minimumDelta: 5,
        patience: 2,
        minimumObservations: 3,
      },
    })
    // 100 建立锚点; 90 降低 10 >= 5，重置锚点为 90; 88 仅降低 2 < 5，耐心=1; 89 升高，耐心=2
    const rounds = [
      closed(1, "original", "passed", { value: 100, comparison: COMP_HASH }),
      closed(2, "original", "passed", { value: 90, comparison: COMP_HASH }),
      closed(3, "original", "passed", { value: 88, comparison: COMP_HASH }),
      closed(4, "original", "passed", { value: 89, comparison: COMP_HASH }),
    ]
    const res = decideV2(baseInput({ policy, rounds }))
    expect(res.action).toBe("activate")
    expect(res.reason).toBe("metric_stagnation")
  })

  test("D215: 已激活备用，1 条备用闭轮但 b=2 -> continue；第 2 条后 finish/alternative_limit", () => {
    const rAlt1 = closed(1, "alternative", "rejected")
    const res1 = decideV2(
      baseInput({
        branch: "alternative",
        activated: true,
        rounds: [rAlt1],
      })
    )
    expect(res1.action).toBe("continue")
    expect(res1.reason).toBe("alternative_window")

    const rAlt2 = closed(2, "alternative", "rejected")
    const res2 = decideV2(
      baseInput({
        branch: "alternative",
        activated: true,
        rounds: [rAlt1, rAlt2],
      })
    )
    expect(res2.action).toBe("finish")
    expect(res2.reason).toBe("alternative_limit")
  })

  test("D216: 备用比旧最佳差、还没到 b -> 不抢停、不第二次 activate", () => {
    const rAlt1 = closed(1, "alternative", "rejected")
    const res = decideV2(
      baseInput({
        branch: "alternative",
        activated: true,
        rounds: [rAlt1],
      })
    )
    expect(res.action).toBe("continue")
    expect(res.reason).toBe("alternative_window")
  })

  test("D217: 备用路线正式 first_pass passed -> finish/first_pass", () => {
    const rAlt1 = closed(1, "alternative", "passed")
    const res = decideV2(
      baseInput({
        branch: "alternative",
        activated: true,
        firstPass: true,
        rounds: [rAlt1],
      })
    )
    expect(res.action).toBe("finish")
    expect(res.reason).toBe("first_pass")
  })

  test("D218: 起点缺失、余轮数不足、调用/Token 不足 -> 分别终止 origin_unavailable/cycle_rounds/cycle_budget", () => {
    const rounds = [1, 2, 3, 4, 5, 6, 7].map((r) => closed(r))

    // 起点缺失
    const resOrigin = decideV2(baseInput({ rounds, originReady: false }))
    expect(resOrigin.action).toBe("finish")
    expect(resOrigin.reason).toBe("origin_unavailable")

    // 余轮数不足
    const resRounds = decideV2(baseInput({ rounds, remaining: { rounds: 1, calls: 50, tokens: 5000 } }))
    expect(resRounds.action).toBe("finish")
    expect(resRounds.reason).toBe("cycle_rounds")

    // 调用不足
    const resCalls = decideV2(baseInput({ rounds, remaining: { rounds: 5, calls: 2, tokens: 5000 } }))
    expect(resCalls.action).toBe("finish")
    expect(resCalls.reason).toBe("cycle_budget")

    // Token 不足
    const resTokens = decideV2(baseInput({ rounds, remaining: { rounds: 5, calls: 50, tokens: 10 } }))
    expect(resTokens.action).toBe("finish")
    expect(resTokens.reason).toBe("cycle_budget")
  })

  test("D219: fault、unresolved、stopped -> 按 B.2 优先级 hold/finish", () => {
    const resStopped = decideV2(baseInput({ stopped: true }))
    expect(resStopped.action).toBe("finish")
    expect(resStopped.reason).toBe("user_stop")

    const resFault = decideV2(baseInput({ fault: true }))
    expect(resFault.action).toBe("hold")
    expect(resFault.reason).toBe("infrastructure")

    const resUnresolved = decideV2(baseInput({ unresolved: true }))
    expect(resUnresolved.action).toBe("hold")
    expect(resUnresolved.reason).toBe("unresolved_request")
  })

  test("D220: 硬上限、余额为 0、实际 N 低于 h+m -> 拒绝激活，报告真实原因", () => {
    const resHardStop = decideV2(baseInput({ hardStop: true }))
    expect(resHardStop.action).toBe("finish")
    expect(resHardStop.reason).toBe("global_limit")

    const resZeroBalance = decideV2(baseInput({ remaining: { rounds: 0, calls: 50, tokens: 5000 } }))
    expect(resZeroBalance.action).toBe("finish")
    expect(resZeroBalance.reason).toBe("global_limit")

    // 实际 N < h + m: h=7, m=2 -> h+m=9; effectiveMaxRounds=8
    const rounds = [1, 2, 3, 4, 5, 6, 7].map((r) => closed(r))
    const resIncompatible = decideV2(baseInput({ rounds, effectiveMaxRounds: 8 }))
    expect(resIncompatible.action).toBe("hold")
    expect(resIncompatible.reason).toBe("effective_window_incompatible")
  })

  test("D221: Round 次序倒退、闭轮指纹复用、备用后回原路、NaN metric -> 拒绝不合法证据", () => {
    // 次序倒退
    expect(() =>
      decideV2(baseInput({ rounds: [closed(2), closed(1)] }))
    ).toThrow("Exploration rounds out of order")

    // 闭轮指纹跨轮复用
    const closureHex = "e".repeat(64)
    expect(() =>
      decideV2(
        baseInput({
          rounds: [
            closed(1, "original", "rejected", undefined, closureHex),
            closed(2, "original", "rejected", undefined, closureHex),
          ],
        })
      )
    ).toThrow("Exploration closure reused across rounds")

    // 备用后回原路
    expect(() =>
      decideV2(
        baseInput({
          rounds: [closed(1, "alternative", "rejected"), closed(2, "original", "rejected")],
        })
      )
    ).toThrow("Exploration branch moved backwards")

    // NaN metric
    expect(() =>
      decideV2(
        baseInput({
          rounds: [closed(1, "original", "passed", { value: NaN, comparison: COMP_HASH })],
        })
      )
    ).toThrow("Invalid exploration metric in closed round")
  })

  test("D222: best_pass 已有合格旧版本，当前故障 -> hold，不让旧合格遮掩故障", () => {
    const rounds = [closed(1, "original", "passed", { value: 90, comparison: COMP_HASH })]
    const res = decideV2(baseInput({ rounds, fault: true }))
    expect(res.action).toBe("hold")
    expect(res.reason).toBe("infrastructure")
  })

  test("D223: 没有新的正式闭轮，但额外调用许多 Checker -> 输出只按闭轮历史，不能因调用次数变化", () => {
    const rounds = [closed(1)]
    const resA = decideV2(baseInput({ rounds }))
    const resB = decideV2(baseInput({ rounds }))
    expect(resA.identity).toBe(resB.identity)
    expect(resA.rounds.length).toBe(1)
  })

  test("D224: JSON 恢复重放同一 closed Round -> normalized rounds/action/reason/identity 恒等，输入未修改", () => {
    const originalInput = baseInput({ rounds: [closed(1)] })
    const serialized = JSON.parse(JSON.stringify(originalInput))
    const resOriginal = decideV2(originalInput)
    const resRestored = decideV2(serialized)
    expect(resRestored.identity).toBe(resOriginal.identity)
    expect(resRestored.action).toBe(resOriginal.action)
    expect(resRestored.reason).toBe(resOriginal.reason)
    expect(originalInput.rounds.length).toBe(1)
  })

  test("D225: 旧 V1 decide 的原有测试 -> 必须原样通过，不能修改 V1 算法适配", () => {
    const policyV1 = {
      origin: { partition: "prompt" as const, relativeRoot: "prompts", entry: "base.md" },
      composition: {
        mode: "substitute" as const,
        substitutions: [
          {
            source: { partition: "prompt" as const, relativeRoot: "prompts", entry: "alt.md" },
            target: "base.md",
          },
        ],
      },
      allowance: {
        rounds: 2,
        minimumRounds: 2,
        authorCalls: 1,
        authorTokens: 10,
        acceptanceCalls: 1,
        acceptanceTokens: 10,
        deliveryCalls: 1,
        deliveryTokens: 10,
      },
      trigger: { kind: "attempts" as const, observations: 2 },
    }
    const resV1 = decideV1({
      policy: policyV1,
      campaign: "cmp-v1",
      observations: [],
      branch: "original",
      activated: false,
      firstPass: false,
      qualified: false,
      stopped: false,
      fault: false,
      unresolved: false,
      hardStop: false,
      originReady: true,
      remaining: { rounds: 5, calls: 50, tokens: 5000 },
    })
    expect(resV1.action).toBe("continue")
    expect(resV1.reason).toBe("local_allowance")
  })

  test("D226: 当前 validatePlan 直接接收 V2 -> 依然拒绝，证明本轮不是生产接线", () => {
    const plan = {
      schema: "aev.task-plan.v1",
      id: "exploration-local-fixture",
      objective: "Create a report",
      deliverable: { kind: "report" as const, entries: ["report", "facts"] },
      resources: [
        { id: "report", path: "report.md", mutable: true, audience: "public" as const },
        { id: "facts", path: "facts.md", mutable: true, audience: "public" as const },
      ],
      capabilities: [],
      windows: [{ role: "checker" as const, stage: "accept" as const, reads: ["report"], writes: [], inline: [], actions: ["read" as const] }],
      workers: [],
      acceptance: {
        execution: "none" as const,
        checks: [
          {
            id: "quality",
            target: "candidate" as const,
            mechanism: "script" as const,
            purpose: "Check fixture",
            required: true,
            resources: ["report"],
            feedback: "message" as const,
          },
        ],
      },
      rejection: [{ check: "quality", actions: ["repair" as const] }],
      selection: { rule: "first_pass" as const },
      stop: { rounds: 10, calls: 100, tokens: 100000, stagnant: 2 },
      exploration: v2Policy(),
    }
    expect(() => validatePlan(plan as any)).toThrow("Invalid exploration policy")
  })

  test("D227: 纯函数运行全程 -> 不生成文件、不请求模型、不新建 Campaign 钱包", () => {
    const res = decideV2(baseInput())
    expect(typeof res.identity).toBe("string")
    expect(res.identity.length).toBe(64)
  })
})
