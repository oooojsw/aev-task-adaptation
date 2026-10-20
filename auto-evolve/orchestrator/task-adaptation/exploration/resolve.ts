import type { Plan } from "../plan"
import { explorationPolicy, type ExplorationPolicy } from "./policy"
import { readExplorationPolicy, type AnyExplorationPolicy } from "./policy-reader"
import type { ExplorationPolicyV2 } from "./policy-v2"
import {
  BUILTIN_EXPLORATION_TEMPLATES,
  type ExplorationRequest,
  type HostExplorationTemplate,
} from "./templates"

export interface ExplorationSupport {
  checkers?: ReadonlyArray<{ name: string; id: string; version?: string }>
  executor?: { id: string; version?: string }
  resources?: Array<{ id: string; path: string; mutable: boolean; audience: string }>
  capabilities?: string[]
  budget?: { calls: number; tokens: number }
  preflightFingerprint?: string
}

export interface ExplorationResolutionResult {
  enabled: boolean
  template?: HostExplorationTemplate
  policy?: AnyExplorationPolicy
  reason?: string
}

export function explorationSummary(plan: Readonly<Plan>, resolution: ExplorationResolutionResult) {
  const policy = resolution.policy
  const reason = resolution.reason ?? "Approved template matched; exploration enabled"
  const counting = !policy ? { unit: "not_enabled" as const }
    : policy.schema === "aev.exploration-policy.v1"
      ? { unit: "quality_observations" as const, trigger: structuredClone(policy.trigger) }
      : { unit: "closed_original_rounds" as const, trigger: structuredClone(policy.trigger),
          ...(policy.trigger.kind === "metric" ? { metricUnit: "trusted_execution_measurements" as const } : {}) }
  // 摘要独立于 Plan，不能为了展示而改变旧策略指纹。
  return {
    enabled: resolution.enabled, reason,
    message: !resolution.enabled ? `探索未启用，原任务流程保留：${reason}`
      : policy?.schema === "aev.exploration-policy.v1" ?
        `${policy.trigger.kind === "attempts" ? `正常质量观察 ${policy.trigger.observations} 次后考虑备用` : "按可信评分观察触发"}；备用按届时余额准入`
      : `原路线正常闭合第 ${policy?.window.minimumRounds} 至 ${policy?.window.maximumRounds} 轮窗口；备用按届时余额准入`,
    template: resolution.template ? { id: resolution.template.id, version: resolution.template.version } : null,
    policySchema: policy?.schema ?? null,
    counting,
    window: policy?.schema === "aev.exploration-policy.v2" ? structuredClone(policy.window) : null,
    alternative: policy ? { minimumRounds: policy.allowance.minimumRounds, maximumRounds: policy.allowance.rounds } : null,
    budgetMode: "best_effort" as const,
    total: { rounds: plan.stop.rounds, calls: plan.stop.calls, tokens: plan.stop.tokens },
    origin: policy ? structuredClone(policy.origin) : null,
    replace: policy ? [...policy.replace] : [], preserve: policy ? [...policy.preserve] : [],
    dependencies: policy ? [...policy.dependencies] : [],
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every((item) => setA.has(item))
}

function validateObservationWindow(n: number, m: number, t: number): boolean {
  return (
    Number.isSafeInteger(n) &&
    n >= 1 &&
    Number.isSafeInteger(m) &&
    m >= 1 &&
    Number.isSafeInteger(t) &&
    t >= 1 &&
    Number.isSafeInteger(n + m) &&
    n + m <= t
  )
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

export function validateExplorationRequest(request: unknown): asserts request is ExplorationRequest | undefined {
  if (request === undefined) return
  if (!request || typeof request !== "object" || Array.isArray(request) || Object.getPrototypeOf(request) !== Object.prototype)
    throw new Error("Exploration request must be an object")
  const cfg = request as Record<string, unknown>
  if (Object.hasOwn(cfg, "mode") && typeof cfg.mode !== "string") throw new Error("Invalid exploration request mode")
  const mode = cfg.mode ?? "off"
  const fields = mode === "off" ? ["mode"]
    : mode === "auto" ? ["mode", "template", "budgetMode"]
    : mode === "observations" ? ["mode", "after", "template", "budgetMode"]
    : mode === "window" ? ["mode", "afterRound", "template", "budgetMode"]
    : mode === "metric" ? ["mode", "minimumRounds", "maximumRounds", "patience", "template", "budgetMode"] : undefined
  if (!fields) throw new Error(`Unsupported exploration request mode: ${String(mode)}`)
  if (Object.keys(cfg).some(key => !fields.includes(key))) throw new Error(`Exploration ${mode} mode cannot include extra options`)
  if (Object.hasOwn(cfg, "template") && (typeof cfg.template !== "string" || !cfg.template.trim()))
    throw new Error("Existing trusted exploration template ID required")
  if (Object.hasOwn(cfg, "budgetMode") && cfg.budgetMode !== "best_effort")
    throw new Error("Unsupported exploration budget mode; reserved is not supported; only best_effort is supported")
  for (const key of ["after", "afterRound", "minimumRounds", "maximumRounds", "patience"]) {
    if (Object.hasOwn(cfg, key) || (mode === "observations" && key === "after") || (mode === "window" && key === "afterRound")) {
      if (!Number.isSafeInteger(cfg[key]) || Number(cfg[key]) < 1)
        throw new Error(`Exploration ${key} must be a positive safe integer`)
    }
  }
  if (mode === "metric" && cfg.minimumRounds !== undefined && cfg.maximumRounds !== undefined &&
    Number(cfg.minimumRounds) > Number(cfg.maximumRounds)) throw new Error("Invalid exploration metric window")
}

function expand(template: Extract<HostExplorationTemplate, { schema: "aev.exploration-template.v2" }>,
  request: ExplorationRequest, plan: Readonly<Plan>): ExplorationPolicyV2 {
  // 先验证批准的原策略，禁止靠用户覆盖修好损坏模板。
  readExplorationPolicy(template.policy, plan)
  const policy = structuredClone(template.policy)
  const override = (key: "afterRound" | "minimumRounds" | "maximumRounds" | "patience", value: number, original: number) => {
    const range = template.overrides?.[key]
    if (range ? value < range.minimum || value > range.maximum : value !== original)
      throw new Error(`Exploration ${key} exceeds approved template range`)
    return value
  }
  if (request.mode === "window") {
    if (policy.trigger.kind !== "window") throw new Error("Window request requires an approved window template")
    const k = override("afterRound", request.afterRound, policy.window.maximumRounds)
    if (!template.overrides?.afterRound && policy.window.minimumRounds !== k)
      throw new Error("Fixed window requires explicit template approval")
    policy.window = { minimumRounds: k, maximumRounds: k }
  }
  if (request.mode === "metric") {
    if (policy.trigger.kind !== "metric") throw new Error("Metric request requires an approved metric template")
    for (const key of ["minimumRounds", "maximumRounds"] as const) {
      if (request[key] !== undefined) policy.window[key] = override(key, request[key], policy.window[key])
    }
    if (request.patience !== undefined) policy.trigger.patience = override("patience", request.patience, policy.trigger.patience)
  }
  readExplorationPolicy(policy, plan)
  return policy
}

export function validateExplorationTemplates(templates: readonly HostExplorationTemplate[]) {
  // 严格校验模板合法性（结构损坏属于配置错误）
  for (const t of templates) {
    if (
      !t ||
      (t.schema !== "aev.exploration-template.v1" && t.schema !== "aev.exploration-template.v2") ||
      !t.id ||
      !t.version ||
      !Array.isArray(t.profiles) ||
      !t.checker?.name ||
      !t.checker?.id ||
      !t.policy?.origin ||
      !Array.isArray(t.policy?.replace) ||
      !t.policy?.allowance
    ) {
      throw new Error("Invalid exploration template definition")
    }
    if (t.schema === "aev.exploration-template.v2") {
      exact(t, ["schema", "id", "version", "profiles", "checker", "policy",
        ...(t.executor !== undefined ? ["executor"] : []), ...(t.overrides !== undefined ? ["overrides"] : [])], "exploration template v2")
      if (t.policy.schema !== "aev.exploration-policy.v2" || t.policy.budget?.mode !== "best_effort")
        throw new Error("V2 template requires explicit V2 best_effort policy; reserved is not supported")
      if (![t.id, t.version, ...t.profiles].every(value => typeof value === "string" && value.trim()) ||
        !t.profiles.length || new Set(t.profiles).size !== t.profiles.length) throw new Error("Invalid V2 template identity")
      exact(t.checker, ["name", "id", ...(t.checker.version !== undefined ? ["version"] : [])], "template checker")
      if (t.executor) exact(t.executor, ["id", ...(t.executor.version !== undefined ? ["version"] : [])], "template executor")
      if (![t.checker.name, t.checker.id, ...(t.checker.version !== undefined ? [t.checker.version] : []),
        ...(t.executor ? [t.executor.id, ...(t.executor.version !== undefined ? [t.executor.version] : [])] : [])]
        .every(value => typeof value === "string" && value.trim())) throw new Error("Invalid V2 template binding")
      if (t.overrides !== undefined) {
        if (!t.overrides || typeof t.overrides !== "object" || Array.isArray(t.overrides)) throw new Error("Invalid template overrides")
        for (const [key, range] of Object.entries(t.overrides)) {
          if (!["afterRound", "minimumRounds", "maximumRounds", "patience"].includes(key)) throw new Error("Invalid template override key")
          exact(range, ["minimum", "maximum"], "template override range")
          if (!Number.isSafeInteger(range.minimum) || Number(range.minimum) < 1 || !Number.isSafeInteger(range.maximum) ||
            Number(range.maximum) < Number(range.minimum)) throw new Error("Invalid template override range")
        }
      }
    }
  }
  if (new Set(templates.map(t => t.id)).size !== templates.length) throw new Error("Duplicate exploration template IDs")
}

export function resolveExploration(
  basePlan: Readonly<Plan>,
  request: ExplorationRequest | undefined,
  templates: readonly HostExplorationTemplate[] = BUILTIN_EXPLORATION_TEMPLATES,
  support?: ExplorationSupport,
  profiles?: readonly string[],
): ExplorationResolutionResult {
  validateExplorationRequest(request)
  if (request === undefined) return { enabled: false, reason: "Exploration not requested" }
  const mode = request.mode ?? "off"
  if (mode === "off") return { enabled: false, reason: "Exploration explicitly disabled" }
  let observations = request.mode === "observations" ? request.after : undefined
  validateExplorationTemplates(templates)

  if (!profiles || profiles.length === 0) {
    if (mode === "auto" && !request.template) {
      return {
        enabled: false,
        reason: "No trusted profiles provided for task exploration resolution",
      }
    }
    throw new Error("No trusted profiles provided for explicit exploration request")
  }
  const selectedProfiles = profiles

  // 确定性精确匹配
  const matched = templates.filter((template) => {
    if (request.template !== undefined && template.id !== request.template) return false
    if (mode === "observations" && template.schema !== "aev.exploration-template.v1") return false
    if ((mode === "window" || mode === "metric") && template.schema !== "aev.exploration-template.v2") return false
    if (mode === "window" && template.schema === "aev.exploration-template.v2" && template.policy.trigger.kind !== "window") return false
    if (mode === "metric" && template.schema === "aev.exploration-template.v2" && template.policy.trigger.kind !== "metric") return false
    // 1. Profile 严格集合相同
    if (!sameSet(template.profiles, selectedProfiles)) return false

    // 2. 检查 Plan 所有 required 检查项是否在 Host support.checkers 中有唯一同名绑定
    const hostCheckers = support?.checkers ?? []
    const hostCheckerNames = hostCheckers.map((c) => c.name)
    if (new Set(hostCheckerNames).size !== hostCheckerNames.length) {
      return false
    }

    const requiredChecks = basePlan.acceptance.checks.filter((c) => c.required)
    for (const req of requiredChecks) {
      const matches = hostCheckers.filter((hc) => hc.name === req.id)
      if (matches.length !== 1) return false
    }

    // 3. Plan Checker 精确名称匹配
    const planHasChecker = basePlan.acceptance.checks.some(
      (c) => c.id === template.checker.name,
    )
    if (!planHasChecker) return false

    // 4. Host support.checkers 精确匹配模板指定的 checker.name 与 checker.id
    const hostMatches = hostCheckers.filter((hc) => hc.name === template.checker.name)
    if (hostMatches.length !== 1) return false
    const hostChecker = hostMatches[0]
    if (hostChecker.id !== template.checker.id) return false
    if (template.checker.version !== undefined) {
      if (hostChecker.version === undefined || hostChecker.version !== template.checker.version) {
        return false
      }
    }

    // 5. Host support executor 匹配：如果模板要求 executor，Host 必须提供且匹配
    if (template.executor) {
      if (!support?.executor || support.executor.id !== template.executor.id) {
        return false
      }
      if (template.executor.version !== undefined) {
        if (support.executor.version === undefined || support.executor.version !== template.executor.version) {
          return false
        }
      }
    }

    // 6. 资源槽与动作匹配
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

    // 7. 预算约束：不能超过全局 stop.rounds 与最低周期
    if (template.policy.allowance.rounds > basePlan.stop.rounds) return false
    if (template.policy.allowance.minimumRounds > basePlan.stop.rounds) return false
    if (support?.budget) {
      if (template.policy.allowance.authorCalls > support.budget.calls) return false
      if (template.policy.allowance.authorTokens > support.budget.tokens) return false
    }

    return true
  })

  if (matched.length === 0) {
    if (mode === "auto" && !request.template) {
      return {
        enabled: false,
        reason: "No matching approved exploration template found for task",
      }
    }
    throw new Error("No matching approved exploration template for explicit exploration request")
  }

  if (matched.length > 1) {
    if (mode === "auto" && !request.template) {
      return {
        enabled: false,
        reason: `Ambiguous exploration templates matched for task: ${matched.map((m) => m.id).join(", ")}`,
      }
    }
    throw new Error("Ambiguous exploration templates matched for explicit exploration request")
  }

  const template = matched[0]
  if (template.schema === "aev.exploration-template.v2") {
    return { enabled: true, template: structuredClone(template), policy: expand(template, request, basePlan) }
  }
  if (mode === "auto") {
    observations = template.policy.defaultObservations
  }

  if (!observations || observations < 1 || !Number.isSafeInteger(observations)) {
    throw new Error("Invalid exploration observations trigger count")
  }

  // 校验原路线观察窗口与备用路线最低轮数相容性
  const n = observations
  const m = template.policy.allowance.minimumRounds
  const t = basePlan.stop.rounds
  if (!validateObservationWindow(n, m, t)) {
    if (mode === "auto" && !request.template) {
      return {
        enabled: false,
        reason: `Exploration observation window leaves fewer than minimum alternative rounds: observations=${n}, minimumRounds=${m}, stopRounds=${t}`,
      }
    }
    throw new Error(`Exploration observation window leaves fewer than minimum alternative rounds: observations=${n}, minimumRounds=${m}, stopRounds=${t}`)
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
