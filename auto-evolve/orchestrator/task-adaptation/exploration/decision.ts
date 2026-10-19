import { canonical, fingerprint } from "../../protocol-plugins/identity"
import type { ExplorationPolicy } from "./policy"

export interface Observation {
  campaign: string
  round: number
  closure: string
  branch: "original" | "alternative"
  candidate: string
  verdict: "passed" | "rejected"
  metric?: number
}

export interface DecisionInput {
  policy: Readonly<ExplorationPolicy>
  campaign: string
  observations: readonly Observation[]
  observation?: Observation
  branch: "original" | "alternative"
  activated: boolean
  firstPass: boolean
  qualified: boolean
  stopped: boolean
  fault: boolean
  unresolved: boolean
  hardStop: boolean
  originReady: boolean
  remaining: { rounds: number; calls: number; tokens: number }
}

export interface Decision {
  action: "continue" | "activate" | "finish" | "hold"
  reason: string
  observations: Observation[]
  identity: string
}

function valid(item: Observation, campaign: string) {
  if (
    item.campaign !== campaign ||
    !Number.isSafeInteger(item.round) ||
    item.round < 1 ||
    !["original", "alternative"].includes(item.branch) ||
    !["passed", "rejected"].includes(item.verdict) ||
    typeof item.closure !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.closure) ||
    typeof item.candidate !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.candidate) ||
    (item.metric !== undefined && !Number.isFinite(item.metric))
  )
    throw new Error("Invalid exploration observation")
}

export function decide(input: DecisionInput): Decision {
  if (
    !input.campaign ||
    !["original", "alternative"].includes(input.branch) ||
    (input.branch === "alternative") !== input.activated ||
    Object.values(input.remaining).some((value) => !Number.isSafeInteger(value) || value < 0)
  )
    throw new Error("Invalid exploration decision state")
  const observations: Observation[] = []
  for (const raw of [...input.observations, ...(input.observation ? [input.observation] : [])]) {
    valid(raw, input.campaign)
    // 空指标统一省略，保证内存与JSON恢复的同一观察身份一致。
    const item: Observation = {
      campaign: raw.campaign,
      round: raw.round,
      closure: raw.closure,
      branch: raw.branch,
      candidate: raw.candidate,
      verdict: raw.verdict,
      ...(raw.metric === undefined ? {} : { metric: raw.metric }),
    }
    const prior = observations.find((saved) => saved.round === item.round)
    if (prior) {
      // 同轮恢复只能复用同一关闭事件，冲突不得覆盖旧观察。
      if (canonical(prior) !== canonical(item)) throw new Error("Exploration round closure conflict")
      continue
    }
    if (observations.length && item.round <= observations.at(-1)!.round)
      throw new Error("Exploration observations out of order")
    if (observations.some((saved) => saved.closure === item.closure))
      throw new Error("Exploration closure reused across rounds")
    if (observations.some((saved) => saved.branch === "alternative") && item.branch === "original")
      throw new Error("Exploration branch moved backwards")
    observations.push(structuredClone(item))
  }
  if (observations.some((item) => item.branch === "alternative") && input.branch !== "alternative")
    throw new Error("Exploration active branch mismatch")
  if (input.observation && input.observation.branch !== input.branch)
    throw new Error("Exploration current observation mismatch")
  const { observation: _, observations: __, ...state } = input
  const result = (action: Decision["action"], reason: string): Decision => ({
    action,
    reason,
    observations,
    identity: fingerprint({ state, observations, action, reason }),
  })
  if (input.stopped) return result("finish", "user_stop")
  if (input.fault || input.unresolved) return result("hold", input.fault ? "infrastructure" : "unresolved_request")
  if (input.firstPass && input.qualified) return result("finish", "first_pass")
  if (input.hardStop || Object.values(input.remaining).some((value) => value === 0))
    return result("finish", "global_limit")
  const local = observations.filter((item) => item.branch === input.branch)
  if (input.branch === "alternative" && local.length >= input.policy.allowance.rounds)
    return result("finish", "alternative_limit")
  const trigger = input.policy.trigger
  let ready = local.length >= (trigger.kind === "attempts" ? trigger.observations : trigger.minimumObservations)
  if (trigger.kind === "metric") {
    let best: number | undefined,
      patience = 0
    const seen = new Set<string>()
    for (const item of local) {
      // 重复正文仍消耗轮次，但不获得新的进展和耐心。
      if (seen.has(item.candidate)) {
        patience++
        continue
      }
      seen.add(item.candidate)
      if (item.metric === undefined) {
        patience++
        continue
      }
      const gain = best === undefined ? Infinity : trigger.direction === "max" ? item.metric - best : best - item.metric
      if (gain > 0 && gain >= trigger.minimumDelta) {
        best = item.metric
        patience = 0
      } else patience++
    }
    ready = ready && patience >= trigger.patience
  }
  if (!ready) return result("continue", "local_allowance")
  if (input.activated) return result("finish", "restart_used")
  if (!input.originReady) return result("finish", "origin_unavailable")
  const allowance = input.policy.allowance
  for (const unit of ["calls", "tokens"] as const) {
    const suffix = unit === "calls" ? "Calls" : "Tokens"
    const required =
      (allowance[`author${suffix}`] + allowance[`acceptance${suffix}`]) * allowance.minimumRounds +
      allowance[`delivery${suffix}`]
    if (!Number.isSafeInteger(required) || input.remaining[unit] < required) return result("finish", "cycle_budget")
  }
  if (input.remaining.rounds < allowance.minimumRounds) return result("finish", "cycle_rounds")
  return result("activate", "bounded_restart")
}
