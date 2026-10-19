import type { Plan } from "../plan"

export function requireExplorationHost(plan: Readonly<Plan>) {
  // 主流程屏障及选优交接未闭环，不能仅凭配置承诺已经可执行。
  if (plan.exploration !== undefined) throw new Error("Exploration Host lifecycle not connected; execution unsupported")
}
