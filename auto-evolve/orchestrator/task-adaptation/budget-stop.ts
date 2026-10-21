import type { LongTaskSpec } from "../long-task/contract"
import { inspectBudget } from "./request-budget"
import { taskRequestBudget, validateTaskBudgetPolicy } from "./budget-policy"

const reasons = ["request_call_budget", "request_token_budget", "request_usage_unresolved", "request_budget_overrun"] as const
export type RequestStopReason = typeof reasons[number]
export const isRequestBudgetStop = (value: string | undefined): value is RequestStopReason => reasons.includes(value as RequestStopReason)

export async function requestBudgetStop(spec: LongTaskSpec) {
  if (!spec.taskAdaptation?.requestBudget) return undefined
  const bound = spec.taskAdaptationContext
  if (!bound) throw new Error("Frozen task plan required for budget stop")
  const policy = validateTaskBudgetPolicy(spec.taskAdaptation.requestBudget)
  const cfg = taskRequestBudget(policy, bound.plan.stop, "controller", policy.models[0].model)
  const evidence = await inspectBudget(cfg.budget)
  // 控制器安全点仍有未结算请求时须核查，不能当正常耗尽交付成功。
  // 只计量策略无总额停止，但无法确认的调用仍须人工核查。
  const reason: RequestStopReason | undefined = evidence.mode === "meter_only"
    ? evidence.unresolvedAttempts ? "request_usage_unresolved" : undefined
    : evidence.overrunAttempts ? "request_budget_overrun"
    : evidence.unresolvedAttempts ? "request_usage_unresolved"
    : evidence.admittedAttempts >= evidence.limits.calls || evidence.denial?.reason === "calls" ? "request_call_budget"
    : evidence.reportedTokens >= evidence.limits.tokens || evidence.denial?.reason === "tokens" ||
      evidence.limits.tokens - evidence.reportedTokens < Math.min(...policy.models.map(item => item.maxInputTokens + 1)) ? "request_token_budget" : undefined
  if (!reason) return undefined
  return { reason, inspectionRequired: reason === "request_usage_unresolved" || reason === "request_budget_overrun", evidence }
}
