import path from "node:path"
import { mkdir, open, readFile } from "node:fs/promises"
import { writeJsonAtomic } from "../atomic-write"
import { canonical, fingerprint } from "../protocol-plugins/identity"
import { validateBudgetTransport, validateRequestGate, type BudgetTransportConfig } from "./budget-transport"
import type { Plan } from "./plan"
import type { BuiltinOptions } from "../protocol-plugins/builtins"

export interface TaskBudgetPolicy {
  schema: "aev.task-budget-policy.v1"
  root: string
  scope: string
  models: Array<{
    model: string
    dialect: BudgetTransportConfig["dialect"]
    expectedModels: string[]
    maxInputTokens: number
    maxOutputTokens: number
  }>
}

export function validateTaskBudgetPolicy(value: unknown): TaskBudgetPolicy {
  const cfg = value as TaskBudgetPolicy
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) ||
    Object.keys(cfg).some(key => !["schema", "root", "scope", "models"].includes(key)) ||
    cfg.schema !== "aev.task-budget-policy.v1" || typeof cfg.root !== "string" || !path.isAbsolute(cfg.root) ||
    typeof cfg.scope !== "string" || !cfg.scope.trim() || !Array.isArray(cfg.models) || !cfg.models.length ||
    cfg.models.some(item => !item || typeof item.model !== "string" || !item.model.trim() ||
      Object.keys(item).some(key => !["model", "dialect", "expectedModels", "maxInputTokens", "maxOutputTokens"].includes(key))) ||
    new Set(cfg.models.map(item => item.model)).size !== cfg.models.length) throw new Error("Invalid task request budget policy")
  for (const { model, ...item } of cfg.models) validateBudgetTransport({ ...item, schema: "aev.budget-transport.v1", role: "preflight",
    budget: { root: cfg.root, scope: cfg.scope, calls: 1, tokens: 1 } })
  return structuredClone(cfg)
}

export function taskRequestBudget(value: TaskBudgetPolicy, stop: Plan["stop"], role: string, model: string, requestGate?: string): BudgetTransportConfig {
  const cfg = validateTaskBudgetPolicy(value)
  const item = cfg.models.find(item => item.model === model)
  if (!item) throw new Error("Task model has no frozen request budget binding")
  const { model: _, ...wire } = item
  // 角色仅改变请求绑定，所有角色共用方案中的同一总额。
  const gate = validateRequestGate(requestGate, true)
  return validateBudgetTransport({ ...wire, schema: "aev.budget-transport.v1", role, ...(gate ? { gate } : {}),
    budget: { root: cfg.root, scope: cfg.scope, calls: stop.calls, tokens: stop.tokens } })
}

export function taskRuntimeBudgets(policy: TaskBudgetPolicy | undefined, stop: Plan["stop"], requestGate?: string): Pick<BuiltinOptions, "httpBudgets" | "toolBudgets" | "requestGate"> {
  const gate = validateRequestGate(requestGate, Boolean(policy))
  if (!policy) return {}
  const cfg = validateTaskBudgetPolicy(policy)
  const entries = (role: string) => Object.fromEntries(cfg.models.map(item => [item.model, taskRequestBudget(cfg, stop, role, item.model)]))
  const execution = entries("independent")
  const judging = entries("checker")
  const ceiling = Math.max(...cfg.models.map(item => item.maxInputTokens + item.maxOutputTokens))
  if (!Number.isSafeInteger(ceiling)) throw new Error("Task token ceiling overflow")
  return { ...(gate ? { requestGate: gate } : {}), toolBudgets: { execution, judging }, httpBudgets: {
    execution: { config: Object.values(execution)[0].budget, tokenCeiling: ceiling, role: "independent" },
    judging: { config: Object.values(judging)[0].budget, tokenCeiling: ceiling, role: "checker" },
  } }
}

export async function freezeTaskBudgetPolicy(dir: string, value: TaskBudgetPolicy | undefined, plan: Plan) {
  if (!path.isAbsolute(dir)) throw new Error("Absolute task budget snapshot directory required")
  const file = path.join(dir, "request-budget-policy.json")
  const claim = `${file}.claim`
  if (!value) {
    try { await readFile(claim); throw new Error("Task request budget policy removed from existing run") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    return
  }
  const policy = validateTaskBudgetPolicy(value)
  for (const item of policy.models) taskRequestBudget(policy, plan.stop, "preflight", item.model)
  await mkdir(dir, { recursive: true })
  const body = { schema: "aev.frozen-task-budget.v1", policy, plan: fingerprint(plan) }
  try { const handle = await open(claim, "wx"); await handle.close() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const saved = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))
    if (canonical(saved) !== canonical(body)) throw new Error("Task request budget binding drift")
    return
  }
  try { await readFile(file); throw new Error("Unclaimed task request budget snapshot exists") }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  // 永久认领后不覆盖；半完成需核查，不能重置账本扩大总额。
  await writeJsonAtomic(file, body)
}
