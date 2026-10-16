import path from "node:path"
import { prepareTask, type IntakeInput } from "./intake"
import { prepareExecution, type ExecutionPreparation } from "./prepare-execution"
import { builtins } from "../protocol-plugins/builtins"
import { opencodeDriver } from "../protocol-plugins/opencode-driver"
import type { Runtime } from "../protocol-plugins/runtime"

export interface TaskRunPreparation {
  intake: IntakeInput
  execution: Omit<ExecutionPreparation, "root" | "plan" | "capabilities">
}

async function preparationRuntime(input: TaskRunPreparation) {
  const requiresTool = input.execution.executor?.id === "isolated-tool-session" ||
    input.execution.checkers.some(item => item.binding.id === "active-tool-judge")
  const root = path.join(input.execution.dir, "backend-preflight")
  const tool = requiresTool ? await opencodeDriver({ cwd: input.intake.cwd, evidenceRoot: path.join(root, "host") }) : undefined
  await tool?.preflight()
  return builtins(root, { ...(tool ? { tool } : {}), scriptExecution: input.execution.executor?.id === "script-json-executor" })
}

export async function prepareTaskRun(input: TaskRunPreparation, dependencies?: {
  intake?: Parameters<typeof prepareTask>[1]
  createRuntime?: (input: TaskRunPreparation) => Promise<Runtime>
}) {
  const interpreted = await prepareTask(input.intake, dependencies?.intake)
  if (interpreted.status !== "ready") return interpreted
  const runtime = await (dependencies?.createRuntime ?? preparationRuntime)(input)
  // 同一入口贯通方案与配置；这里只准备，不隐式启动模型演化。
  return prepareExecution({ ...input.execution, root: input.intake.root, plan: structuredClone(interpreted.plan),
    capabilities: input.intake.catalogue.capabilities.filter(item => item.available).map(item => item.id) }, runtime.registry)
}
