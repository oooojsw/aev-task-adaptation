import type { Plan } from "../plan"
import { fingerprint, immutable } from "../../protocol-plugins/identity"

export interface ExplorationPolicy {
  schema: "aev.exploration-policy.v1"
  origin: { kind: "initial" } | { kind: "candidate"; fingerprint: string }
  replace: string[]
  preserve: string[]
  dependencies: string[]
  trigger:
    | { kind: "attempts"; observations: number }
    | {
        kind: "metric"
        name: string
        direction: "min" | "max"
        minimumDelta: number
        patience: number
        minimumObservations: number
      }
  allowance: {
    rounds: number
    minimumRounds: number
    authorCalls: number
    authorTokens: number
    acceptanceCalls: number
    acceptanceTokens: number
    deliveryCalls: number
    deliveryTokens: number
  }
  bounds: { archiveBytes: number; candidateBytes: number; dependencyBytes: number }
  safety: { reset: "declared_entries"; effects: "sandbox_only" }
}

function exact(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error(`Invalid exploration ${label}`)
}

function count(value: unknown, zero = false): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < (zero ? 0 : 1))
    throw new Error("Finite exploration bound required")
}

export function explorationPolicy(value: unknown, plan: Readonly<Plan>): Readonly<ExplorationPolicy> | undefined {
  if (value === undefined) return undefined
  exact(
    value,
    ["schema", "origin", "replace", "preserve", "dependencies", "trigger", "allowance", "bounds", "safety"],
    "policy",
  )
  if (value.schema !== "aev.exploration-policy.v1") throw new Error("Unsupported exploration policy")
  const cfg = value as unknown as ExplorationPolicy
  exact(cfg.origin, cfg.origin?.kind === "initial" ? ["kind"] : ["kind", "fingerprint"], "origin")
  if (
    cfg.origin.kind !== "initial" &&
    (cfg.origin.kind !== "candidate" ||
      typeof cfg.origin.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(cfg.origin.fingerprint))
  ) {
    throw new Error("One explicit exploration origin required")
  }
  for (const ids of [cfg.replace, cfg.preserve, cfg.dependencies]) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) {
      throw new Error("Unique exploration resource IDs required")
    }
  }
  if (
    !cfg.replace.length ||
    cfg.replace.some((id) => !plan.deliverable.entries.includes(id)) ||
    cfg.preserve.some((id) => !plan.deliverable.entries.includes(id) || cfg.replace.includes(id)) ||
    plan.deliverable.entries.some((id) => !cfg.replace.includes(id) && !cfg.preserve.includes(id))
  ) {
    throw new Error("Exploration must partition declared deliverables into replace and preserve")
  }
  for (const id of cfg.dependencies) {
    const resource = plan.resources.find((item) => item.id === id)
    if (!resource || resource.mutable || resource.audience === "private")
      throw new Error("Exploration dependencies must be frozen nonprivate resources")
  }
  exact(
    cfg.trigger,
    cfg.trigger?.kind === "attempts"
      ? ["kind", "observations"]
      : ["kind", "name", "direction", "minimumDelta", "patience", "minimumObservations"],
    "trigger",
  )
  if (cfg.trigger.kind === "attempts") count(cfg.trigger.observations)
  else {
    if (
      cfg.trigger.kind !== "metric" ||
      plan.selection.rule !== "best_pass" ||
      cfg.trigger.name !== plan.selection.metric ||
      cfg.trigger.direction !== plan.selection.direction ||
      !Number.isFinite(cfg.trigger.minimumDelta) ||
      cfg.trigger.minimumDelta < 0
    ) {
      throw new Error("Exploration metric must match the frozen trusted selection metric")
    }
    count(cfg.trigger.patience)
    count(cfg.trigger.minimumObservations)
  }
  exact(
    cfg.allowance,
    [
      "rounds",
      "minimumRounds",
      "authorCalls",
      "authorTokens",
      "acceptanceCalls",
      "acceptanceTokens",
      "deliveryCalls",
      "deliveryTokens",
    ],
    "allowance",
  )
  for (const [key, amount] of Object.entries(cfg.allowance))
    count(amount, !["rounds", "minimumRounds", "authorCalls", "authorTokens"].includes(key))
  if (
    cfg.allowance.minimumRounds > cfg.allowance.rounds ||
    cfg.allowance.rounds > plan.stop.rounds ||
    ["acceptance", "delivery"].some((role) => {
      const calls = cfg.allowance[`${role}Calls` as "acceptanceCalls" | "deliveryCalls"]
      const tokens = cfg.allowance[`${role}Tokens` as "acceptanceTokens" | "deliveryTokens"]
      return (calls === 0) !== (tokens === 0)
    })
  )
    throw new Error("Inconsistent exploration allowance")
  for (const unit of ["Calls", "Tokens"] as const) {
    const cycle = cfg.allowance[`author${unit}`] + cfg.allowance[`acceptance${unit}`]
    const required = cycle * cfg.allowance.minimumRounds + cfg.allowance[`delivery${unit}`]
    if (!Number.isSafeInteger(required) || required > plan.stop[unit === "Calls" ? "calls" : "tokens"]) {
      throw new Error("Minimum exploration cycle exceeds global budget")
    }
  }
  exact(cfg.bounds, ["archiveBytes", "candidateBytes", "dependencyBytes"], "storage bounds")
  for (const amount of Object.values(cfg.bounds)) count(amount)
  exact(cfg.safety, ["reset", "effects"], "safety")
  if (cfg.safety.reset !== "declared_entries" || cfg.safety.effects !== "sandbox_only")
    throw new Error("Unsupported exploration reset safety")
  return immutable(structuredClone(cfg))
}

export function explorationIdentity(value: unknown, plan: Readonly<Plan>) {
  const cfg = explorationPolicy(value, plan)
  return cfg ? fingerprint({ plan: fingerprint(plan), policy: cfg }) : undefined
}

export interface ExplorationCapabilities {
  fencedReaders: boolean
  isolatedViews: boolean
  selectedDelivery: boolean
  enforcedStageBudget: boolean
  verifiedOrigin: boolean
  verifiedDependencies: boolean
  replaySafe: boolean
}

export function requireExplorationCapabilities(
  policy: Readonly<ExplorationPolicy> | undefined,
  value: ExplorationCapabilities,
) {
  if (!policy) return
  // 能力由Host适配器提供，不能采纳作者自报的安全性。
  for (const key of [
    "fencedReaders",
    "isolatedViews",
    "selectedDelivery",
    "enforcedStageBudget",
    "verifiedOrigin",
    "verifiedDependencies",
    "replaySafe",
  ] as const) {
    if (value?.[key] !== true) throw new Error(`Exploration entry unsupported: ${key}`)
  }
}
