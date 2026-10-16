import { fingerprint, immutable } from "../protocol-plugins/identity"

export const roles = ["planner", "executor", "worker", "lead", "reviewer", "diagnostician", "checker", "independent"] as const
export const stages = ["explore", "revise", "accept", "deliver"] as const
export const actions = ["read", "search", "execute", "edit", "research", "verify_source", "recompute", "repair", "optimize", "respond"] as const
export type Role = typeof roles[number]
export type Stage = typeof stages[number]
export type Action = typeof actions[number]
export type RuntimeInformation = "feedback" | "analysis" | "review"

export interface Resource {
  id: string
  path: string
  audience: "public" | "training" | "private"
  mutable: boolean
}

export interface Window {
  role: Role
  stage: Stage
  reads: string[]
  writes: string[]
  inline: string[]
  actions: Action[]
  runtime?: RuntimeInformation[]
}

export interface Plan {
  schema: "aev.task-plan.v1"
  id: string
  objective: string
  deliverable: { kind: "skill" | "report" | "software" | "strategy"; entries: string[] }
  resources: Resource[]
  capabilities: string[]
  windows: Window[]
  workers: Array<{ id: string; purpose: string; resources: string[]; actions: Action[] }>
  acceptance: {
    execution: "none" | "independent" | "script"
    checks: Array<{
      id: string
      target: "candidate" | "product"
      mechanism: "script" | "judge" | "active_judge"
      purpose: string
      required: boolean
      resources: string[]
      feedback: "status_only" | "message"
    }>
  }
  rejection: Array<{ check: string; actions: Action[] }>
  selection: { rule: "first_pass" | "best_pass"; metric?: string; direction?: "min" | "max" }
  stop: { rounds: number; calls: number; tokens: number; stagnant: number }
}

function object(value: unknown, keys: string[], label: string, optional: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !(key in value))) throw new Error(`Invalid ${label}`)
}

function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("Nonempty text required")
}

function list(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim()) || new Set(value).size !== value.length) {
    throw new Error("Unique text array required")
  }
}

function member(value: unknown, values: readonly string[]): asserts value is string {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`Invalid choice: ${String(value)}`)
}

function items(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error("Array required")
}

export function validatePlan(value: unknown): Readonly<Plan> {
  object(value, ["schema", "id", "objective", "deliverable", "resources", "capabilities", "windows", "workers", "acceptance", "rejection", "selection", "stop"], "task plan")
  if (value.schema !== "aev.task-plan.v1") throw new Error("Unsupported task plan")
  text(value.id)
  text(value.objective)
  object(value.deliverable, ["kind", "entries"], "deliverable")
  member(value.deliverable.kind, ["skill", "report", "software", "strategy"])
  list(value.deliverable.entries)
  if (!value.deliverable.entries.length) throw new Error("Deliverable entries required")
  list(value.capabilities)
  items(value.resources)
  const resources = new Map<string, Resource>()
  const paths = new Set<string>()
  for (const item of value.resources) {
    object(item, ["id", "path", "audience", "mutable"], "resource")
    text(item.id)
    text(item.path)
    const file = item.path
    // 使用受控根下的相对文件，物理路径由运行绑定再次核验。
    if (file.includes("\\") || file.includes(":") || file.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) throw new Error("Unsafe resource path")
    member(item.audience, ["public", "training", "private"])
    if (typeof item.mutable !== "boolean" || resources.has(item.id) || [...paths].some(other => other === file.toLowerCase() ||
      other.startsWith(file.toLowerCase() + "/") || file.toLowerCase().startsWith(other + "/"))) throw new Error("Duplicate or overlapping resource")
    resources.set(item.id, item as unknown as Resource)
    paths.add(item.path.toLowerCase())
  }
  const refs = (ids: unknown) => {
    list(ids)
    for (const id of ids) if (!resources.has(id)) throw new Error(`Unknown resource: ${id}`)
    return ids
  }
  for (const id of refs(value.deliverable.entries)) {
    if (!resources.get(id)!.mutable || resources.get(id)!.audience === "private") throw new Error("Deliverable must be mutable and nonprivate")
  }
  items(value.windows)
  const windows = new Set<string>()
  for (const item of value.windows) {
    object(item, ["role", "stage", "reads", "writes", "inline", "actions"], "window", ["runtime"])
    member(item.role, roles)
    member(item.stage, stages)
    if (item.runtime !== undefined) {
      list(item.runtime)
      if (item.runtime.some(kind => !["feedback", "analysis", "review"].includes(kind)) ||
        (item.runtime.length && item.role === "independent")) throw new Error("Forbidden runtime information window")
    }
    const key = `${item.role}:${item.stage}`
    if (windows.has(key)) throw new Error("Duplicate role-stage window")
    windows.add(key)
    const readable = refs(item.reads)
    const writable = refs(item.writes)
    const inline = refs(item.inline)
    list(item.actions)
    for (const action of item.actions) member(action, actions)
    // 信息授权以角色和阶段为边界，不由材料内容扩大权限。
    if (readable.some(id => resources.get(id)!.audience === "private" && item.role !== "checker") ||
      readable.some(id => resources.get(id)!.audience === "training" && item.role === "independent")) throw new Error("Forbidden resource audience")
    if (inline.some(id => !readable.includes(id))) throw new Error("Inline resource is not readable")
    if (writable.some(id => !resources.get(id)!.mutable || resources.get(id)!.audience === "private") ||
      (writable.length && !["executor", "lead"].includes(item.role))) throw new Error("Forbidden write")
    if (readable.length && !item.actions.includes("read")) throw new Error("Read capability required")
    if (writable.length && !item.actions.includes("edit")) throw new Error("Edit capability required")
  }
  items(value.workers)
  const workers = new Set<string>()
  const window = (value.windows as unknown as Window[]).filter(item => item.role === "worker")
  for (const item of value.workers) {
    object(item, ["id", "purpose", "resources", "actions"], "worker")
    text(item.id)
    text(item.purpose)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.id)) throw new Error("Unsafe worker identifier")
    if (workers.has(item.id)) throw new Error("Duplicate worker")
    workers.add(item.id)
    refs(item.resources)
    list(item.actions)
    if (!window.some(scope => (item.resources as string[]).every(id => scope.reads.includes(id)) &&
      (item.actions as string[]).every(action => scope.actions.includes(action as Action)))) throw new Error("Worker exceeds authorized window")
  }
  object(value.acceptance, ["execution", "checks"], "acceptance")
  member(value.acceptance.execution, ["none", "independent", "script"])
  items(value.acceptance.checks)
  const checks = new Set<string>()
  for (const item of value.acceptance.checks) {
    object(item, ["id", "target", "mechanism", "purpose", "required", "resources", "feedback"], "check")
    text(item.id)
    text(item.purpose)
    if (checks.has(item.id)) throw new Error("Duplicate check")
    checks.add(item.id)
    member(item.target, ["candidate", "product"])
    member(item.mechanism, ["script", "judge", "active_judge"])
    member(item.feedback, ["status_only", "message"])
    if (typeof item.required !== "boolean") throw new Error("Explicit required flag required")
    refs(item.resources)
    if (!(value.windows as unknown as Window[]).some(scope => scope.role === "checker" && scope.stage === "accept" &&
      (item.resources as string[]).every(id => scope.reads.includes(id)))) throw new Error("Check exceeds checker window")
    if (item.target === "product" && value.acceptance.execution === "none") throw new Error("Product check requires execution")
  }
  if (!value.acceptance.checks.some(item => (item as Record<string, unknown>).required)) throw new Error("Required acceptance check missing")
  items(value.rejection)
  const routes = new Set<string>()
  for (const item of value.rejection) {
    object(item, ["check", "actions"], "rejection")
    text(item.check)
    list(item.actions)
    if (!checks.has(item.check) || routes.has(item.check) || !item.actions.length) throw new Error("Invalid rejection route")
    routes.add(item.check)
    for (const action of item.actions) member(action, actions)
  }
  if ([...checks].some(id => !routes.has(id))) throw new Error("Rejection route missing")
  const selection = value.selection
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new Error("Invalid selection")
  const rule = (selection as Record<string, unknown>).rule
  member(rule, ["first_pass", "best_pass"])
  object(selection, rule === "best_pass" ? ["rule", "metric", "direction"] : ["rule"], "selection")
  if (rule === "best_pass") { text(selection.metric); member(selection.direction, ["min", "max"]) }
  object(value.stop, ["rounds", "calls", "tokens", "stagnant"], "stop")
  for (const number of Object.values(value.stop)) if (!Number.isSafeInteger(number) || (number as number) < 1) throw new Error("Positive finite stop budget required")
  return immutable(value as unknown as Plan)
}

export function planIdentity(value: unknown) {
  return fingerprint(validatePlan(value))
}

export function roleWindow(value: unknown, role: Role, stage: Stage, worker?: string) {
  const plan = validatePlan(value)
  const scope = plan.windows.find(item => item.role === role && item.stage === stage)
  if (!scope) throw new Error(`Role unavailable in stage: ${role}:${stage}`)
  const analysis = worker ? plan.workers.find(item => item.id === worker) : undefined
  if ((worker && (role !== "worker" || !analysis)) || (role === "worker" && !analysis)) throw new Error("Declared worker required")
  // 未显式声明内联的材料只传目录，不自动读取全文或尾段。
  return immutable({ objective: plan.objective, deliverable: plan.deliverable.kind,
    ...(analysis ? { purpose: analysis.purpose } : {}), reads: plan.resources.filter(item => scope.reads.includes(item.id) && (!analysis || analysis.resources.includes(item.id))),
    writes: plan.resources.filter(item => scope.writes.includes(item.id)),
    inline: scope.inline.filter(id => !analysis || analysis.resources.includes(id)),
    ...(scope.runtime ? { runtime: scope.runtime } : {}),
    actions: analysis ? scope.actions.filter(action => analysis.actions.includes(action)) : scope.actions })
}
