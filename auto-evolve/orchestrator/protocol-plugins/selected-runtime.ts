import path from "node:path"
import { readFile } from "node:fs/promises"
import { builtins, type BuiltinOptions } from "./builtins"
import { compile } from "./compile"
import { validateEntry, type Entry } from "./entry"
import { opencodeDriver } from "./opencode-driver"
import type { Selection } from "./contract"
import { verifyScriptExecution } from "./script-executor"

export async function selectedRuntime(root: string, cwd: string | undefined, entry: Entry,
  createDriver: typeof opencodeDriver = opencodeDriver) {
  validateEntry(entry)
  const selection = JSON.parse((await readFile(entry.selectionPath, "utf8")).replace(/^\uFEFF/, "")) as Selection
  const phases = selection?.protocol?.phases
  const requiresTool = phases && typeof phases === "object" && Object.values(phases).some(
    (phase) => phase?.executor?.id === "isolated-tool-session" ||
      phase?.checks?.some(check => check.id === "active-tool-judge"))
  const requiresScript = phases && typeof phases === "object" && Object.values(phases).some(
    (phase) => phase?.executor?.id === "script-json-executor")
  let options: BuiltinOptions = { scriptExecution: Boolean(requiresScript) }
  if (requiresTool) {
    // 先校验完整协议，再读取宿主配置；探测驱动绝不能执行。
    const probe = await builtins(root, { ...options, tool: { implementation: "0".repeat(64),
      preflight: async () => { throw new Error("Validation-only tool backend") },
      invoke: async () => { throw new Error("Validation-only tool backend") } } })
    const checked = compile(selection, probe.registry)
    for (const phase of Object.values(checked.selection.protocol.phases)) {
      if (phase?.executor?.id === "isolated-tool-session" &&
          phase.executor.settings.outputKind !== checked.selection.run.productKind) {
        throw new Error("Tool output kind and selected product kind mismatch")
      }
    }
    if (!cwd || !path.isAbsolute(cwd)) throw new Error("Explicit OpenCode host required for selected tool protocol")
    const driver = await createDriver({ cwd, evidenceRoot: path.join(root, "opencode-driver") })
    await driver.preflight()
    options = { ...options, tool: driver }
  }
  const runtime = await builtins(root, options)
  const checked = compile(selection, runtime.registry)
  for (const phase of Object.values(checked.selection.protocol.phases)) {
    // 选择阶段即验证真实依赖；缺失不能等模型训练后才发现。
    if (phase?.executor?.id === "script-json-executor") await verifyScriptExecution(phase.executor.settings)
  }
  return runtime
}
