import type { CheckerPlugin, ExecutorPlugin, Identity } from "./contract"
import { immutable } from "./identity"

export function identity(value: Identity) {
  if (!value || typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.id) ||
      typeof value.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value.version)) {
    throw new Error("Plugin identity requires explicit safe id and version")
  }
  return `${value.id}@${value.version}`
}

export function strings(value: unknown, label: string, empty = false): asserts value is string[] {
  if (!Array.isArray(value) || (!empty && !value.length) || value.some((item) => typeof item !== "string" || !item.trim()) ||
      new Set(value).size !== value.length) throw new Error(`Invalid ${label}`)
}

export class Registry {
  private executors = new Map<string, ExecutorPlugin>()
  private checkers = new Map<string, CheckerPlugin>()

  addExecutor(plugin: ExecutorPlugin) {
    const key = identity(plugin)
    if (this.executors.has(key)) throw new Error(`Duplicate executor: ${key}`)
    if (!/^[a-f0-9]{64}$/.test(plugin.implementation)) throw new Error("Executor implementation hash required")
    strings(plugin.skillFormats, "executor skill formats")
    strings(plugin.productKinds, "executor product kinds")
    strings(plugin.materialKinds, "executor material kinds", true)
    if (typeof plugin.validate !== "function") throw new Error("Executor settings validator required")
    const { validate, ...descriptor } = plugin
    // 注册后冻结能力声明，防止外部对象变更影响恢复身份。
    this.executors.set(key, Object.freeze({ ...immutable(descriptor), validate }))
    return this
  }

  addChecker(plugin: CheckerPlugin) {
    const key = identity(plugin)
    if (this.checkers.has(key)) throw new Error(`Duplicate checker: ${key}`)
    if (!/^[a-f0-9]{64}$/.test(plugin.implementation)) throw new Error("Checker implementation hash required")
    strings(plugin.targets, "checker targets")
    strings(plugin.mechanisms, "checker mechanisms")
    strings(plugin.productKinds, "checker product kinds")
    if (plugin.targets.some((item) => !["skill", "product"].includes(item)) ||
        plugin.mechanisms.some((item) => !["script", "judge"].includes(item)) ||
        typeof plugin.validate !== "function") throw new Error("Invalid checker capabilities")
    const { validate, ...descriptor } = plugin
    this.checkers.set(key, Object.freeze({ ...immutable(descriptor), validate }))
    return this
  }

  executor(binding: Identity) {
    const key = identity(binding)
    const plugin = this.executors.get(key)
    if (!plugin) throw new Error(`Missing executor: ${key}`)
    return plugin
  }

  checker(binding: Identity) {
    const key = identity(binding)
    const plugin = this.checkers.get(key)
    if (!plugin) throw new Error(`Missing checker: ${key}`)
    return plugin
  }
}
