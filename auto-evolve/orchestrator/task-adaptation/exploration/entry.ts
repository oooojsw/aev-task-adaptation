import type { Plan } from "../plan"
import { readExplorationPolicy } from "./policy-reader"

export function requireExplorationHost(plan: Readonly<Plan>) {
  const cfg = readExplorationPolicy(plan.exploration, plan)
  if (!cfg) return
  if (cfg.schema === "aev.exploration-policy.v2" && cfg.trigger.kind === "metric") {
    throw new Error("Host V2 metric scoring binding not implemented")
  }
  // 首版只开放已接线的受限文件任务，不承诺任意外部状态可重置。
  for (const [role, stage] of [
    ["planner", "explore"],
    ["executor", "explore"],
    ["worker", "explore"],
    ["lead", "revise"],
    ["reviewer", "accept"],
    ["diagnostician", "revise"],
  ]) {
    if (!plan.windows.some((window) => window.role === role && window.stage === stage))
      throw new Error(`Exploration Host role window missing: ${role}/${stage}`)
  }
  if (
    plan.windows.some((window) =>
      window.actions.some((action) => ["execute", "research", "verify_source"].includes(action)),
    )
  )
    throw new Error("Exploration Host does not reset external effects")
  if (cfg.allowance.deliveryCalls || cfg.allowance.deliveryTokens)
    throw new Error("Exploration Host delivery is local export only")
}
