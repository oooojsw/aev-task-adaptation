type Environment = {
  [key: string]: string | undefined
  OPENCODE_AEV_REQUEST_BUDGET_FILE?: string
  OPENCODE_AEV_REQUEST_BUDGET_SHA256?: string
}

export function taskBudgetIdentity(model: string, context: number, env: Environment = process.env) {
  // 预算启用时隔离模型SDK，避免复用首个模型的上下文上限。
  return env.OPENCODE_AEV_REQUEST_BUDGET_FILE ? { model, context } : undefined
}

export async function fetchWithTaskBudget(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  context: number,
  transport: typeof fetch,
  env: Environment = process.env,
) {
  if (!env.OPENCODE_AEV_REQUEST_BUDGET_FILE) return transport(input, init)
  const budget = await import("../../../../auto-evolve/orchestrator/task-adaptation/budget-transport")
  const cfg = await budget.readBudgetTransport(env.OPENCODE_AEV_REQUEST_BUDGET_FILE, env.OPENCODE_AEV_REQUEST_BUDGET_SHA256)
  return budget.budgetedProviderFetch(input, init ?? {}, cfg, context, transport)
}
