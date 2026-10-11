import type { Binding, CheckerPluginDescriptor, ExecutorPluginDescriptor, Selection, Settings, Snapshot } from "./contract"
import { canonical, fingerprint, immutable } from "./identity"
import { identity, Registry, strings } from "./registry"

function shape(value: unknown, keys: string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`Invalid fields: ${label}`)
}

function settings(binding: Binding): Settings {
  shape(binding, ["id", "version", "settings", "name", "target", "stage", "required", "mechanism", "privateInputs"], "binding")
  const value = binding.settings
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Explicit plugin settings required")
  function check(item: unknown) {
    if (!item || typeof item !== "object") return
    for (const [key, child] of Object.entries(item)) {
      // 快照仅保存凭证引用，避免配置把真实密钥写进证据。
      if (/^(api[_-]?key|authorization|cookie|password|secret|access[_-]?token)$/i.test(key)) {
        throw new Error("Inline credentials forbidden; use credential reference")
      }
      check(child)
    }
  }
  check(value)
  return value
}

export function compile(input: unknown, registry: Registry): Snapshot {
  // 先规范化并复制，拒绝非JSON并避免插件验证修改调用方配置。
  const value = JSON.parse(canonical(input)) as Selection
  shape(value, ["schema", "project", "protocol", "run"], "selection")
  if (!value || value.schema !== "aev.protocol-plugins.v1") throw new Error("Unsupported protocol selection schema")
  shape(value.project, ["id", "version", "skillFormats", "productKinds", "materialKinds"], "project")
  shape(value.protocol, ["id", "version", "phases"], "protocol")
  shape(value.run, ["skillFormat", "productKind", "materialKinds"], "run")
  identity(value.project)
  identity(value.protocol)
  strings(value.project.skillFormats, "project skill formats")
  strings(value.project.productKinds, "project product kinds")
  strings(value.project.materialKinds, "project material kinds", true)
  if (!value.run || !value.project.skillFormats.includes(value.run.skillFormat) ||
      !value.project.productKinds.includes(value.run.productKind)) throw new Error("Project/run format mismatch")
  strings(value.run.materialKinds, "run material kinds", true)
  if (value.run.materialKinds.some((kind) => !value.project.materialKinds.includes(kind))) throw new Error("Project material mismatch")
  const phases = value.protocol.phases
  if (!phases || typeof phases !== "object" || Array.isArray(phases) || !Object.keys(phases).length) {
    throw new Error("At least one explicit protocol phase required")
  }
  const executors = new Map<string, ExecutorPluginDescriptor>()
  const checkers = new Map<string, CheckerPluginDescriptor>()
  for (const [phase, plan] of Object.entries(phases)) {
    shape(plan, ["claim", "executor", "checks"], "phase")
    if (!["source", "merge", "replay", "test"].includes(phase) || !plan ||
        !["skill_check", "task_execution"].includes(plan.claim) || !Array.isArray(plan.checks)) {
      throw new Error(`Invalid protocol phase: ${phase}`)
    }
    if (!plan.checks.some((check) => check?.required === true)) throw new Error(`Required checks missing: ${phase}`)
    if (plan.claim === "task_execution") {
      if (!plan.executor) throw new Error(`Executor required: ${phase}`)
      const plugin = registry.executor(plan.executor)
      if (!plugin.skillFormats.includes(value.run.skillFormat) || !plugin.productKinds.includes(value.run.productKind) ||
          value.run.materialKinds.some((kind) => !plugin.materialKinds.includes(kind))) {
        throw new Error(`Executor capability mismatch: ${phase}`)
      }
      plugin.validate(immutable(settings(plan.executor)))
      const { validate: _, ...descriptor } = plugin
      executors.set(identity(plugin), descriptor)
      if (!plan.checks.some((check) => check.required && check.target === "product" && check.stage === "after_execution")) {
        throw new Error(`Task execution requires post-execution product scoring: ${phase}`)
      }
    } else if (plan.executor !== undefined) {
      throw new Error(`Skill-only phase must not specify executor: ${phase}`)
    }
    const names = new Set<string>()
    for (const check of plan.checks) {
      if (!check || typeof check.name !== "string" || !check.name.trim() || names.has(check.name) ||
          typeof check.required !== "boolean" || !["skill", "product"].includes(check.target) ||
          !["before_execution", "after_execution"].includes(check.stage) || !["script", "judge"].includes(check.mechanism)) {
        throw new Error(`Invalid or duplicate check: ${phase}`)
      }
      names.add(check.name)
      if (check.privateInputs !== undefined) strings(check.privateInputs, "private input bindings", true)
      if (check.target === "product" && check.stage !== "after_execution") throw new Error("Product check before execution")
      if (plan.claim === "skill_check" && (check.target !== "skill" || check.stage !== "before_execution")) {
        throw new Error("Skill-only phase cannot claim product execution")
      }
      const plugin = registry.checker(check)
      if (!plugin.targets.includes(check.target) || !plugin.mechanisms.includes(check.mechanism) ||
          (check.target === "product" && !plugin.productKinds.includes(value.run.productKind))) {
        throw new Error(`Checker capability mismatch: ${check.name}`)
      }
      plugin.validate(immutable(settings(check)))
      const { validate: _, ...descriptor } = plugin
      checkers.set(identity(plugin), descriptor)
    }
  }
  const body = {
    schema: "aev.protocol-snapshot.v1" as const,
    selection: value,
    implementations: {
      executors: [...executors.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item),
      checkers: [...checkers.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item),
    },
  }
  return immutable({ ...body, fingerprint: fingerprint(body) })
}

export function verify(snapshot: Snapshot, registry: Registry) {
  if (!snapshot || snapshot.schema !== "aev.protocol-snapshot.v1") throw new Error("Invalid snapshot schema")
  const resolved = compile(snapshot.selection, registry)
  // 不信保存的fingerprint，重新核对声明、能力和当前插件版本。
  if (canonical(snapshot) !== canonical(resolved)) throw new Error("Frozen protocol or implementation drift")
  return resolved
}
