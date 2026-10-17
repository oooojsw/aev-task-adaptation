import { canonical, fingerprint, immutable } from "../protocol-plugins/identity"
import { validatePlan, type Plan } from "./plan"
import { validateCatalogue, type TaskCatalogue } from "./catalogue"

/**
 * 只有宿主掌握 catalogue.approvedPlans 的发布权时，Plan 白名单才构成授权。
 * 指纹取 fingerprint(plan)（规范化 JSON 的 SHA256），不是原文件字节 SHA256。
 */
export function approvePresetPlan(raw: unknown, sourceCatalogue: TaskCatalogue) {
  const catalogue = validateCatalogue(sourceCatalogue)
  const plan = validatePlan(raw)
  const approved = fingerprint(plan)
  if (!catalogue.approvedPlans?.includes(approved)) throw new Error("Preset Plan is not host-approved")
  // 即使批准指纹写错，也不允许静态方案改写基础资源、预算与任务身份。
  if (plan.id !== catalogue.id || plan.objective !== catalogue.request ||
    canonical(plan.resources) !== canonical(catalogue.resources) ||
    canonical(plan.deliverable.entries) !== canonical(catalogue.entries) ||
    canonical(plan.stop) !== canonical(catalogue.stop)) throw new Error("Preset Plan exceeds catalogue envelope")
  const caps = new Map(catalogue.capabilities.map(item => [item.id, item]))
  if (plan.capabilities.some(id => !caps.has(id))) throw new Error("Preset Plan uses undeclared capabilities")
  const authorized = new Set(plan.capabilities.flatMap(id => caps.get(id)!.actions))
  for (const window of plan.windows) {
    // checker 和 independent 的只读能力也必须有 read 授权。
    if (window.actions.some(action => !authorized.has(action))) throw new Error("Preset Plan exceeds capability actions")
  }
  const missing = plan.capabilities.filter(id => !caps.get(id)!.available)
  if (missing.length) return immutable({ status: "missing_capabilities" as const, missing,
    rationale: "Host-approved static Plan requires unavailable capabilities" })
  return immutable({ status: "ready" as const, plan: plan as Plan, profiles: [] as string[],
    rationale: "Host-approved static TaskPlan" })
}