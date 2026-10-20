import type { Plan } from "../plan"
import { readExplorationPolicy } from "./policy-reader"

// 仅明确能力不支持可在冻结前回退；配置和证据故障仍必须阻断。
export class ExplorationUnsupportedError extends Error {
  constructor(message: string) { super(message); this.name = "ExplorationUnsupportedError" }
}

export function requireExplorationHost(plan: Readonly<Plan>) {
  const cfg = readExplorationPolicy(plan.exploration, plan)
  if (!cfg) return
  if (cfg.schema === "aev.exploration-policy.v2" && cfg.trigger.kind === "metric") {
    // 评分必须来自正式受检的执行产物，不能读作者自报分。
    if (plan.acceptance.execution === "none" ||
      !plan.acceptance.checks.some(check => check.required && check.target === "product")) {
      throw new Error("Metric exploration requires executed product and required product checker")
    }
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
      throw new ExplorationUnsupportedError(`Exploration Host role window missing: ${role}/${stage}`)
  }
  if (
    plan.windows.some((window) =>
      window.actions.some((action) => ["execute", "research", "verify_source"].includes(action)),
    )
  )
    throw new ExplorationUnsupportedError("Exploration Host does not reset external effects")
  if (cfg.allowance.deliveryCalls || cfg.allowance.deliveryTokens)
    throw new ExplorationUnsupportedError("Exploration Host delivery is local export only")
}
