import { canonical, fingerprint } from "../../protocol-plugins/identity"
import type { ExplorationPolicyV2 } from "./policy-v2"

export type BranchV2 = "original" | "alternative"

export interface ClosedRoundV2 {
  campaign: string
  round: number
  branch: BranchV2
  closure: string
  receipt: string
  verdict: "passed" | "rejected"
  metric?: { value: number; comparison: string }
}

export interface DecisionV2Input {
  policy: Readonly<ExplorationPolicyV2>
  campaign: string
  rounds: readonly ClosedRoundV2[]
  current?: ClosedRoundV2
  branch: BranchV2
  activated: boolean
  firstPass: boolean
  stopped: boolean
  fault: boolean
  unresolved: boolean
  hardStop: boolean
  originReady: boolean
  effectiveMaxRounds: number
  remaining: { rounds: number; calls: number; tokens: number }
}

export interface DecisionV2 {
  action: "continue" | "activate" | "finish" | "hold"
  reason: string
  rounds: ClosedRoundV2[]
  identity: string
}

function validateClosedRound(item: ClosedRoundV2, campaign: string): void {
  if (
    !item ||
    typeof item !== "object" ||
    item.campaign !== campaign ||
    !Number.isSafeInteger(item.round) ||
    item.round < 1 ||
    !["original", "alternative"].includes(item.branch) ||
    !["passed", "rejected"].includes(item.verdict) ||
    typeof item.closure !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.closure) ||
    typeof item.receipt !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.receipt)
  ) {
    throw new Error("Invalid exploration closed round")
  }
  if (item.verdict === "rejected" && item.metric !== undefined) {
    throw new Error("Rejected round cannot carry metric")
  }
  if (item.metric !== undefined) {
    if (
      typeof item.metric !== "object" ||
      item.metric === null ||
      typeof item.metric.value !== "number" ||
      !Number.isFinite(item.metric.value) ||
      typeof item.metric.comparison !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.metric.comparison)
    ) {
      throw new Error("Invalid exploration metric in closed round")
    }
  }
}

function validateDecisionInput(input: DecisionV2Input): void {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.campaign !== "string" ||
    !input.campaign ||
    !["original", "alternative"].includes(input.branch) ||
    (input.branch === "alternative") !== input.activated ||
    !Number.isSafeInteger(input.effectiveMaxRounds) ||
    input.effectiveMaxRounds <= 0 ||
    !input.remaining ||
    typeof input.remaining !== "object" ||
    !Number.isSafeInteger(input.remaining.rounds) ||
    input.remaining.rounds < 0 ||
    !Number.isSafeInteger(input.remaining.calls) ||
    input.remaining.calls < 0 ||
    !Number.isSafeInteger(input.remaining.tokens) ||
    input.remaining.tokens < 0
  ) {
    throw new Error("Invalid exploration decision input")
  }
}

export function decideV2(input: DecisionV2Input): DecisionV2 {
  validateDecisionInput(input)

  const rawList: ClosedRoundV2[] = [...input.rounds, ...(input.current ? [input.current] : [])]
  const normalizedRounds: ClosedRoundV2[] = []

  for (const raw of rawList) {
    validateClosedRound(raw, input.campaign)
    const item: ClosedRoundV2 = {
      campaign: raw.campaign,
      round: raw.round,
      branch: raw.branch,
      closure: raw.closure,
      receipt: raw.receipt,
      verdict: raw.verdict,
      ...(raw.metric !== undefined
        ? {
            metric: {
              value: raw.metric.value,
              comparison: raw.metric.comparison,
            },
          }
        : {}),
    }

    const prior = normalizedRounds.find((saved) => saved.round === item.round)
    if (prior) {
      if (canonical(prior) !== canonical(item)) {
        throw new Error("Exploration round closure conflict")
      }
      continue
    }

    if (normalizedRounds.length && item.round <= normalizedRounds.at(-1)!.round) {
      throw new Error("Exploration rounds out of order")
    }
    if (normalizedRounds.some((saved) => saved.closure === item.closure)) {
      throw new Error("Exploration closure reused across rounds")
    }
    const priorReceipt = normalizedRounds.find((saved) => saved.receipt === item.receipt)
    if (priorReceipt) {
      const matchVerdict = priorReceipt.verdict === item.verdict
      const matchMetric =
        (priorReceipt.metric === undefined && item.metric === undefined) ||
        (priorReceipt.metric !== undefined &&
          item.metric !== undefined &&
          priorReceipt.metric.value === item.metric.value &&
          priorReceipt.metric.comparison === item.metric.comparison)
      if (!matchVerdict || !matchMetric) {
        throw new Error("Exploration receipt conflict across rounds")
      }
    }
    if (normalizedRounds.some((saved) => saved.branch === "alternative") && item.branch === "original") {
      throw new Error("Exploration branch moved backwards")
    }

    normalizedRounds.push(structuredClone(item))
  }

  if (normalizedRounds.some((item) => item.branch === "alternative") && input.branch !== "alternative") {
    throw new Error("Exploration active branch mismatch")
  }
  if (input.current && input.current.branch !== input.branch) {
    throw new Error("Exploration current round branch mismatch")
  }

  const { current: _, rounds: __, ...state } = input
  const result = (action: DecisionV2["action"], reason: string): DecisionV2 => ({
    action,
    reason,
    rounds: normalizedRounds,
    identity: fingerprint({ state, rounds: normalizedRounds, action, reason }),
  })

  // 1. stopped -> finish/user_stop
  if (input.stopped) return result("finish", "user_stop")

  // 2. fault 或 unresolved -> hold/infrastructure 或 hold/unresolved_request
  if (input.fault || input.unresolved) {
    return result("hold", input.fault ? "infrastructure" : "unresolved_request")
  }

  // 3. firstPass=true 且当前最后一个正式关闭 Round 的 verdict=passed -> finish/first_pass
  const lastRound = normalizedRounds.at(-1)
  if (input.firstPass && lastRound && lastRound.verdict === "passed") {
    return result("finish", "first_pass")
  }

  // 4. hardStop 或 remaining.rounds/calls/tokens 有 0 -> finish/global_limit
  if (
    input.hardStop ||
    input.remaining.rounds === 0 ||
    input.remaining.calls === 0 ||
    input.remaining.tokens === 0
  ) {
    return result("finish", "global_limit")
  }

  // 5. 已在 alternative
  if (input.branch === "alternative") {
    const altRounds = normalizedRounds.filter((item) => item.branch === "alternative").length
    if (altRounds >= input.policy.allowance.rounds) {
      return result("finish", "alternative_limit")
    }
    return result("continue", "alternative_window")
  }

  // 6 - 10. original 路线判断
  const f = input.policy.window.minimumRounds
  const h = input.policy.window.maximumRounds
  const m = input.policy.allowance.minimumRounds
  const b = input.policy.allowance.rounds
  const N = input.effectiveMaxRounds
  const origClosed = normalizedRounds.filter((item) => item.branch === "original").length

  let isMetricStagnant = false

  if (input.policy.trigger.kind === "metric") {
    // 运行 B.3 评分停滞算法，并严格验证 metric 的存在性与比较身份一致性
    const originalRounds = normalizedRounds.filter((item) => item.branch === "original")
    let anchorScore: number | undefined
    let continuousScored = 0
    let patienceUsed = 0
    const seenReceipts = new Set<string>()
    let comparisonIdentity: string | undefined

    for (const round of originalRounds) {
      if (round.verdict === "rejected") {
        anchorScore = undefined
        continuousScored = 0
        patienceUsed = 0
        continue
      }

      if (round.metric === undefined) {
        return result("hold", "metric_missing")
      }
      if (comparisonIdentity === undefined) {
        comparisonIdentity = round.metric.comparison
      } else if (comparisonIdentity !== round.metric.comparison) {
        return result("hold", "metric_identity_drift")
      }

      if (seenReceipts.has(round.receipt)) {
        continue
      }
      seenReceipts.add(round.receipt)

      if (anchorScore === undefined) {
        anchorScore = round.metric.value
        continuousScored = 1
        patienceUsed = 0
      } else {
        continuousScored++
        const trigger = input.policy.trigger
        const gain =
          trigger.direction === "max"
            ? round.metric.value - anchorScore
            : anchorScore - round.metric.value
        if (gain > 0 && gain >= trigger.minimumDelta) {
          anchorScore = round.metric.value
          patienceUsed = 0
        } else {
          patienceUsed++
        }
      }
    }

    const trigger = input.policy.trigger
    isMetricStagnant =
      origClosed >= f &&
      continuousScored >= trigger.minimumObservations &&
      patienceUsed >= trigger.patience &&
      origClosed < h
  }

  // 6. 仍在 original 且正常闭轮数小于 f -> continue/original_minimum
  if (origClosed < f) {
    return result("continue", "original_minimum")
  }

  // 7 & 8 & 9: 检查换路意图
  let switchIntentionReason: "window_exhausted" | "metric_stagnation" | undefined

  if (input.policy.trigger.kind === "metric") {
    if (origClosed >= h) {
      switchIntentionReason = "window_exhausted"
    } else if (isMetricStagnant) {
      switchIntentionReason = "metric_stagnation"
    } else {
      return result("continue", "metric_progress")
    }
  } else {
    // trigger.kind === "window"
    if (origClosed >= h) {
      switchIntentionReason = "window_exhausted"
    } else {
      return result("continue", "original_window")
    }
  }

  // 10. 有换路意图时检查
  if (h + m > N || b > N - f) {
    return result("hold", "effective_window_incompatible")
  }

  if (!input.originReady) {
    return result("finish", "origin_unavailable")
  }

  if (input.remaining.rounds < m) {
    return result("finish", "cycle_rounds")
  }

  const allowance = input.policy.allowance
  for (const unit of ["calls", "tokens"] as const) {
    const suffix = unit === "calls" ? "Calls" : "Tokens"
    const required =
      (allowance[`author${suffix}`] + allowance[`acceptance${suffix}`]) * allowance.minimumRounds +
      allowance[`delivery${suffix}`]
    if (!Number.isSafeInteger(required) || input.remaining[unit] < required) {
      return result("finish", "cycle_budget")
    }
  }

  return result("activate", switchIntentionReason!)
}
