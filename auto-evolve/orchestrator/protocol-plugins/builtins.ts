import path from "node:path"
import { Runtime } from "./runtime"
import { httpChat, type HttpRequestBudget } from "./http-chat"
import { scriptChecker } from "./script-checker"
import { cachedExecution, cachedScoring } from "./cache"
import { modelJudge } from "./model-judge"
import { toolSession } from "./tool-session"
import { scriptExecutor } from "./script-executor"
import { activeJudge } from "./active-judge"
import type { InvokeTool } from "./tool-session"

export interface BuiltinOptions {
  tool?: { implementation: string; invoke: InvokeTool; preflight: () => Promise<void> }
  scriptExecution?: boolean
  consolidation?: boolean
  httpBudgets?: { execution: HttpRequestBudget; judging: HttpRequestBudget }
  toolBudgets?: { execution: Parameters<typeof toolSession>[0]["requestBudgets"]; judging: Parameters<typeof toolSession>[0]["requestBudgets"] }
}

export async function builtins(root: string, options: BuiltinOptions = {}) {
  if (!path.isAbsolute(root)) throw new Error("Absolute plugin backend root required")
  const runtime = new Runtime()
  const http = await httpChat({ evidenceRoot: path.join(root, "http"), ...(options.httpBudgets ? { budget: options.httpBudgets.execution } : {}) })
  const script = await scriptChecker(path.join(root, "scripts"))
  // 执行与评分分别缓存，换评分配置不重复发送答题请求。
  runtime.addExecutor(http.descriptor, cachedExecution(path.join(root, "cache"), http.descriptor, http.execute))
  runtime.addChecker(script.descriptor, cachedScoring(path.join(root, "cache"), script.descriptor, script.evaluate, script.preflight))
  const judge = await modelJudge({ evidenceRoot: path.join(root, "judges"), ...(options.httpBudgets ? { budget: options.httpBudgets.judging } : {}) })
  runtime.addChecker(judge.descriptor, cachedScoring(path.join(root, "cache"), judge.descriptor, judge.evaluate))
  // 程序执行显式启用；旧配置不会增加宿主代码执行能力。
  if (options.scriptExecution) {
    const runner = await scriptExecutor(path.join(root, "execution"))
    runtime.addExecutor(runner.descriptor, cachedExecution(path.join(root, "cache"), runner.descriptor,
      runner.execute, runner.preflight))
  }
  // 显式提供工具后端才注册；默认HTTP链路不读取宿主配置。
  if (options.tool) {
    if (typeof options.tool.preflight !== "function") throw new Error("Tool dependency preflight required")
    const tool = await toolSession({ evidenceRoot: path.join(root, "tools"),
      backendImplementation: options.tool.implementation, invoke: options.tool.invoke,
      ...(options.toolBudgets ? { requestBudgets: options.toolBudgets.execution } : {}) })
    runtime.addExecutor(tool.descriptor, cachedExecution(path.join(root, "cache"), tool.descriptor,
      tool.execute, options.tool.preflight))
    const judge = await activeJudge({ evidenceRoot: path.join(root, "active-judges"),
      backendImplementation: options.tool.implementation, invoke: options.tool.invoke,
      ...(options.toolBudgets ? { requestBudgets: options.toolBudgets.judging } : {}) })
    runtime.addChecker(judge.descriptor, cachedScoring(path.join(root, "cache"), judge.descriptor,
      judge.evaluate, options.tool.preflight))
  }
  if (options.consolidation) {
    const { consolidationPlugins } = await import("./consolidation")
    const plugin = await consolidationPlugins(path.join(root, "consolidation"), {
      budget: options.httpBudgets?.execution,
    })
    runtime.addExecutor(plugin.executor, cachedExecution(path.join(root, "cache"), plugin.executor, plugin.execute, async input => {
      await plugin.preflight(input.settings)
    }))
    runtime.addChecker(plugin.checker, cachedScoring(path.join(root, "cache"), plugin.checker, plugin.evaluate))
  }
  return runtime
}
