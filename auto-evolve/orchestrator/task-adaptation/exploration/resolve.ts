import type { Plan } from "../plan"
import { explorationPolicy, type ExplorationPolicy } from "./policy"
import {
  BUILTIN_EXPLORATION_TEMPLATES,
  type ExplorationRequest,
  type HostExplorationTemplate,
} from "./templates"

export interface ExplorationSupport {
  checker?: { id: string; version?: string }
  executor?: { id: string; version?: string }
  resources?: Array<{ id: string; path: string; mutable: boolean; audience: string }>
  capabilities?: string[]
  budget?: { calls: number; tokens: number }
}

export interface ExplorationResolutionResult {
  enabled: boolean
  template?: HostExplorationTemplate
  policy?: ExplorationPolicy
  reason?: string
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
    throw new Error(`Invalid ${label}`)
  }
}

export function resolveExploration(
  basePlan: Readonly<Plan>,
  request: ExplorationRequest | undefined,
  templates: readonly HostExplorationTemplate[] = BUILTIN_EXPLORATION_TEMPLATES,
  support?: ExplorationSupport,
  profiles?: readonly string[],
): ExplorationResolutionResult {
  if (request === undefined || request === null) {
    return { enabled: false, reason: "Exploration not requested" }
  }

  if (typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Exploration request must be an object")
  }

  const mode = request.mode ?? "off"

  if (mode === "off") {
    const keys = Object.keys(request)
    if (keys.length > 1 || (keys.length === 1 && keys[0] !== "mode")) {
      throw new Error("Exploration off mode cannot include extra options")
    }
    return { enabled: false, reason: "Exploration explicitly disabled" }
  }

  if (mode !== "auto" && mode !== "observations") {
    throw new Error(`Unsupported exploration request mode: ${String(mode)}`)
  }

  let observations: number | undefined
  if (mode === "observations") {
    exact(request, ["mode", "after"], "exploration observations request")
    if (!Number.isSafeInteger(request.after) || request.after < 1) {
      throw new Error("Exploration after observations must be a positive integer")
    }
    observations = request.after
  }

  // 严格校验模板合法性（结构损坏属于配置错误）
  for (const t of templates) {
    if (
      t.schema !== "aev.exploration-template.v1" ||
      !t.id ||
      !t.version ||
      !Array.isArray(t.profiles) ||
      !t.checker?.id ||
      !t.policy?.origin ||
      !Array.isArray(t.policy?.replace) ||
      !t.policy?.allowance
    ) {
      throw new Error("Invalid exploration template definition")
    }
  }

  const selectedProfiles = profiles && profiles.length > 0 ? profiles : [basePlan.deliverable.kind]

  // 确定性精确匹配
  const matched = templates.filter((template) => {
    // 1. Profile 约束
    const matchesProfile = template.profiles.some((p) => selectedProfiles.includes(p))
    if (!matchesProfile) return false

    // 2. 计划 Checker 匹配
    const planHasChecker = basePlan.acceptance.checks.some(
      (c) => c.id === template.checker.id || c.mechanism === template.checker.id || c.mechanism === "script",
    )
    if (!planHasChecker) return false

    // 3. Host support checker 严格匹配：缺必需 Host checker 支持视作不支持
    if (!support?.checker || support.checker.id !== template.checker.id) {
      return false
    }
    if (template.checker.version && support.checker.version && template.checker.version !== support.checker.version) {
      return false
    }

    // 4. Host support executor 匹配：如果模板要求 executor，Host 必须提供且匹配
    if (template.executor) {
      if (!support?.executor || support.executor.id !== template.executor.id) {
        return false
      }
      if (template.executor.version && support.executor.version && template.executor.version !== support.executor.version) {
        return false
      }
    }

    // 5. 资源槽与动作匹配
    const planResourceMap = new Map(basePlan.resources.map((r) => [r.id, r]))
    for (const r of template.policy.replace) {
      const res = planResourceMap.get(r)
      if (!res || !res.mutable || !basePlan.deliverable.entries.includes(r)) return false
    }
    for (const p of template.policy.preserve) {
      if (!planResourceMap.has(p)) return false
    }
    for (const d of template.policy.dependencies) {
      if (!planResourceMap.has(d)) return false
    }

    // 6. 预算约束：不能超过全局 stop.rounds 与最低周期
    if (template.policy.allowance.rounds > basePlan.stop.rounds) return false
    if (template.policy.allowance.minimumRounds > basePlan.stop.rounds) return false
    if (support?.budget) {
      if (template.policy.allowance.authorCalls > support.budget.calls) return false
      if (template.policy.allowance.authorTokens > support.budget.tokens) return false
    }

    return true
  })

  if (matched.length === 0) {
    if (mode === "auto") {
      return {
        enabled: false,
        reason: "No matching approved exploration template found for task",
      }
    }
    throw new Error("No matching approved exploration template for explicit exploration request")
  }

  if (matched.length > 1) {
    if (mode === "auto") {
      return {
        enabled: false,
        reason: `Ambiguous exploration templates matched for task: ${matched.map((m) => m.id).join(", ")}`,
      }
    }
    throw new Error("Ambiguous exploration templates matched for explicit exploration request")
  }

  const template = matched[0]
  if (mode === "auto") {
    observations = template.policy.defaultObservations
  }

  if (!observations || observations < 1 || !Number.isSafeInteger(observations)) {
    throw new Error("Invalid exploration observations trigger count")
  }

  // 展开为完整 V1 ExplorationPolicy
  const candidatePolicy: ExplorationPolicy = {
    schema: "aev.exploration-policy.v1",
    origin: structuredClone(template.policy.origin),
    replace: structuredClone(template.policy.replace),
    preserve: structuredClone(template.policy.preserve),
    dependencies: structuredClone(template.policy.dependencies),
    trigger: { kind: "attempts", observations },
    allowance: structuredClone(template.policy.allowance),
    bounds: structuredClone(template.policy.bounds),
    safety: structuredClone(template.policy.safety),
  }

  const validated = explorationPolicy(candidatePolicy, basePlan)
  if (!validated) {
    throw new Error("Generated exploration policy is invalid for base plan")
  }

  return {
    enabled: true,
    template,
    policy: candidatePolicy,
  }
}
