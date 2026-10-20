import type { Plan } from "../plan"
import { explorationPolicy, type ExplorationPolicy } from "./policy"
import { immutable } from "../../protocol-plugins/identity"

export interface ExplorationPolicyV2 {
  schema: "aev.exploration-policy.v2"
  origin: ExplorationPolicy["origin"]
  replace: ExplorationPolicy["replace"]
  preserve: ExplorationPolicy["preserve"]
  dependencies: ExplorationPolicy["dependencies"]
  window: { minimumRounds: number; maximumRounds: number }
  trigger:
    | { kind: "window" }
    | {
        kind: "metric"
        name: string
        direction: "min" | "max"
        minimumDelta: number
        minimumObservations: number
        patience: number
      }
  allowance: ExplorationPolicy["allowance"]
  budget: { mode: "best_effort" }
  bounds: ExplorationPolicy["bounds"]
  safety: ExplorationPolicy["safety"]
}

function exact(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`Invalid exploration ${label}`)
  }
}

export function validateExplorationPolicyV2(value: unknown, plan: Readonly<Plan>): Readonly<ExplorationPolicyV2> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid exploration policy v2: expected object")
  }

  // 步骤 A1：严格顶层对象形状
  exact(
    value,
    ["schema", "origin", "replace", "preserve", "dependencies", "window", "trigger", "allowance", "budget", "bounds", "safety"],
    "policy v2",
  )

  if (value.schema !== "aev.exploration-policy.v2") {
    throw new Error(`Unsupported exploration policy v2 schema: ${String(value.schema)}`)
  }

  // 步骤 A2：校验窗口 window
  exact(value.window, ["minimumRounds", "maximumRounds"], "window")
  const rawWindow = value.window as Record<string, unknown>
  const f = rawWindow.minimumRounds
  const h = rawWindow.maximumRounds
  if (typeof f !== "number" || !Number.isSafeInteger(f) || f < 1) {
    throw new Error("Invalid exploration window minimumRounds: positive safe integer required")
  }
  if (typeof h !== "number" || !Number.isSafeInteger(h) || h < 1) {
    throw new Error("Invalid exploration window maximumRounds: positive safe integer required")
  }
  if (f > h) {
    throw new Error(`Invalid exploration window: minimumRounds (${f}) cannot exceed maximumRounds (${h})`)
  }

  // 步骤 A3：校验触发 trigger
  if (!value.trigger || typeof value.trigger !== "object" || Array.isArray(value.trigger)) {
    throw new Error("Invalid exploration trigger: expected object")
  }
  const rawTrigger = value.trigger as Record<string, unknown>
  if (rawTrigger.kind === "window") {
    exact(rawTrigger, ["kind"], "window trigger")
  } else if (rawTrigger.kind === "metric") {
    exact(rawTrigger, ["kind", "name", "direction", "minimumDelta", "minimumObservations", "patience"], "metric trigger")
    if (typeof rawTrigger.name !== "string" || !rawTrigger.name.trim()) {
      throw new Error("Invalid metric trigger name: non-empty string required")
    }
    if (rawTrigger.direction !== "min" && rawTrigger.direction !== "max") {
      throw new Error("Invalid metric trigger direction: must be 'min' or 'max'")
    }
    if (typeof rawTrigger.minimumDelta !== "number" || !Number.isFinite(rawTrigger.minimumDelta) || rawTrigger.minimumDelta < 0) {
      throw new Error("Invalid metric trigger minimumDelta: non-negative finite number required")
    }
    const minObs = rawTrigger.minimumObservations
    if (typeof minObs !== "number" || !Number.isSafeInteger(minObs) || minObs < 1) {
      throw new Error("Invalid metric trigger minimumObservations: positive safe integer required")
    }
    const pat = rawTrigger.patience
    if (typeof pat !== "number" || !Number.isSafeInteger(pat) || pat < 1) {
      throw new Error("Invalid metric trigger patience: positive safe integer required")
    }

    // 检查与 Plan selection 的匹配：
    // Plan 必须为 best_pass，且 metric 名称与 direction 必须完全一致
    if (plan.selection.rule !== "best_pass") {
      throw new Error("Metric exploration trigger requires a plan with best_pass selection rule")
    }
    if (!plan.selection.metric || plan.selection.metric !== rawTrigger.name) {
      throw new Error(`Metric exploration trigger name '${rawTrigger.name}' does not match plan selection metric '${plan.selection.metric}'`)
    }
    if (!plan.selection.direction || plan.selection.direction !== rawTrigger.direction) {
      throw new Error(`Metric exploration trigger direction '${rawTrigger.direction}' does not match plan selection direction '${plan.selection.direction}'`)
    }
    // V2 metric 的实际比较身份/缺分规则由下一轮决定器和真实评估回执实现，本函数只确认静态合法性，不表示动态测量已经接通
  } else {
    throw new Error(`Unsupported exploration trigger kind: ${String(rawTrigger.kind)}`)
  }

  // 步骤 A4：预算模式 budget
  exact(value.budget, ["mode"], "budget")
  if (value.budget.mode !== "best_effort") {
    throw new Error(`Unsupported exploration budget mode: ${String(value.budget.mode)}; only 'best_effort' is supported`)
  }

  // 校验 allowance 基础结构以便提取 m 与 b
  if (!value.allowance || typeof value.allowance !== "object" || Array.isArray(value.allowance)) {
    throw new Error("Invalid exploration allowance: expected object")
  }
  const allowance = value.allowance as Record<string, unknown>
  const m = allowance.minimumRounds
  const b = allowance.rounds
  if (typeof m !== "number" || !Number.isSafeInteger(m) || m < 1) {
    throw new Error("Invalid exploration allowance minimumRounds: positive safe integer required")
  }
  if (typeof b !== "number" || !Number.isSafeInteger(b) || b < 1) {
    throw new Error("Invalid exploration allowance rounds: positive safe integer required")
  }
  if (m > b) {
    throw new Error(`Invalid exploration allowance: minimumRounds (${m}) cannot exceed rounds (${b})`)
  }

  // 步骤 A5：计算 N/f/h/m/b 静态相容约束
  const N = plan.stop.rounds
  if (!Number.isSafeInteger(N) || N < 1) {
    throw new Error("Plan stop rounds must be a positive safe integer")
  }
  if (!Number.isSafeInteger(h + m)) {
    throw new Error("Exploration window and allowance calculation exceeds safe integer limit")
  }
  if (h + m > N) {
    throw new Error(`Exploration policy v2 window maximum (${h}) + allowance minimumRounds (${m}) exceeds plan stop rounds (${N})`)
  }
  if (b > N - f) {
    throw new Error(`Exploration policy v2 allowance rounds (${b}) exceeds remaining rounds from window minimum (${N - f})`)
  }

  // 步骤 A6：完整复用现有 V1 共用安全合同（内存投影复核）
  const forValidation = {
    schema: "aev.exploration-policy.v1",
    origin: value.origin,
    replace: value.replace,
    preserve: value.preserve,
    dependencies: value.dependencies,
    trigger: rawTrigger.kind === "metric"
      ? {
          kind: "metric" as const,
          name: rawTrigger.name,
          direction: rawTrigger.direction,
          minimumDelta: rawTrigger.minimumDelta,
          patience: rawTrigger.patience,
          minimumObservations: rawTrigger.minimumObservations,
        }
      : { kind: "attempts" as const, observations: 1 },
    allowance: value.allowance,
    bounds: value.bounds,
    safety: value.safety,
  }

  const v1Validated = explorationPolicy(forValidation as any, plan)
  if (!v1Validated) {
    throw new Error("Exploration policy v2 failed underlying V1 safety contract")
  }

  // 步骤 A7：返回深冻结只读副本，绝不篡改原对象
  const validatedV2: ExplorationPolicyV2 = {
    schema: "aev.exploration-policy.v2",
    origin: structuredClone(value.origin) as ExplorationPolicy["origin"],
    replace: structuredClone(value.replace) as ExplorationPolicy["replace"],
    preserve: structuredClone(value.preserve) as ExplorationPolicy["preserve"],
    dependencies: structuredClone(value.dependencies) as ExplorationPolicy["dependencies"],
    window: { minimumRounds: f, maximumRounds: h },
    trigger: structuredClone(value.trigger) as ExplorationPolicyV2["trigger"],
    allowance: structuredClone(value.allowance) as ExplorationPolicy["allowance"],
    budget: { mode: "best_effort" },
    bounds: structuredClone(value.bounds) as ExplorationPolicy["bounds"],
    safety: structuredClone(value.safety) as ExplorationPolicy["safety"],
  }

  return immutable(validatedV2)
}
