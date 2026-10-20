import path from "node:path"
import { validatePlan } from "./plan"
import { requireExplorationHost } from "./exploration/entry"
import { prepareTask, readPresetPlan, type IntakeInput, type IntakeDependencies } from "./intake"
import { prepareExecution, type ExecutionPreparation } from "./prepare-execution"
import { builtins } from "../protocol-plugins/builtins"
import { opencodeDriver } from "../protocol-plugins/opencode-driver"
import type { Runtime } from "../protocol-plugins/runtime"
import { preflightBindings } from "./preflight-bindings"
import { taskRequestBudget, taskRuntimeBudgets } from "./budget-policy"

import type { ExplorationRequest, HostExplorationTemplate } from "./exploration/templates"
import type { ExplorationSupport } from "./exploration/resolve"

export interface TaskRunPreparation {
  intake: IntakeInput
  execution: Omit<ExecutionPreparation, "root" | "plan" | "capabilities">
  explorationRequest?: ExplorationRequest
}

async function preparationRuntime(input: TaskRunPreparation) {
  const requiresTool = input.execution.executor?.id === "isolated-tool-session" ||
    input.execution.checkers.some(item => item.binding.id === "active-tool-judge")
  const root = path.join(input.execution.dir, "backend-preflight")
  const tool = requiresTool ? await opencodeDriver({ cwd: input.intake.cwd, evidenceRoot: path.join(root, "host") }) : undefined
  await tool?.preflight()
  const runtime = await builtins(root, { ...(tool ? { tool } : {}), scriptExecution: input.execution.executor?.id === "script-json-executor",
    ...taskRuntimeBudgets(input.execution.requestBudget, input.intake.catalogue.stop),
    consolidation: input.execution.executor?.id === "consolidation-direct-chat" ||
      input.execution.checkers.some(item => item.binding.id === "consolidation-checker") })
  await preflightBindings(input.execution, runtime.registry)
  return runtime
}

export async function prepareTaskRun(input: TaskRunPreparation, dependencies?: {
  intake?: IntakeDependencies
  createRuntime?: (input: TaskRunPreparation) => Promise<Runtime>
  templates?: readonly HostExplorationTemplate[]
}) {
  // 顶层任务输入禁止随普通 JSON 提交模板；模板仅由 Host 批准列表或依赖注入提供。
  if ((input as Record<string, unknown>).explorationTemplates !== undefined) {
    throw new Error("Task run preparation rejects inline explorationTemplates; templates are host-managed")
  }
  // 受信预设先检查，不能等创建后端或付费理解任务之后才拒绝。
  if (input.intake.mode === "manual_plan") {
    requireExplorationHost(validatePlan(await readPresetPlan(input.intake.planPath)))
  }
  // 本地必需条件先检查，避免已知缺依赖仍付费理解任务。
  const runtime = await (dependencies?.createRuntime ?? preparationRuntime)(input)
  const support: ExplorationSupport = {
    ...(input.execution.checkers[0]?.binding ? { checker: input.execution.checkers[0].binding } : {}),
    ...(input.execution.executor ? { executor: input.execution.executor } : {}),
    capabilities: input.intake.catalogue.capabilities.filter(item => item.available).map(item => item.id),
    budget: {
      calls: input.intake.catalogue.stop.calls,
      tokens: input.intake.catalogue.stop.tokens,
    },
  }
  // 手动轨道绝不生成 Intake 模型请求预算，也绝不调用 Intake 模型。
  const baseIntake = input.intake.mode === undefined || input.intake.mode === "auto"
    ? { ...input.intake, ...(input.execution.requestBudget ? { requestBudget: taskRequestBudget(
        input.execution.requestBudget, input.intake.catalogue.stop, "intake", input.intake.model) } : {}) }
    : input.intake
  const intake: IntakeInput = {
    ...baseIntake,
    ...(input.explorationRequest !== undefined ? { explorationRequest: input.explorationRequest } : {}),
    explorationSupport: support,
  } as IntakeInput
  const intakeDeps: IntakeDependencies = {
    ...(dependencies?.intake ?? {}),
    ...(dependencies?.templates ? { templates: dependencies.templates } : {}),
  }
  const interpreted = await prepareTask(intake, intakeDeps)
  if (interpreted.status !== "ready") return interpreted
  if (interpreted.plan.exploration) {
    requireExplorationHost(interpreted.plan)
  }
  // 同一入口贯通方案与配置；这里只准备，不隐式启动模型演化。
  return prepareExecution({ ...input.execution, root: input.intake.root, plan: structuredClone(interpreted.plan),
    capabilities: input.intake.catalogue.capabilities.filter(item => item.available).map(item => item.id) }, runtime.registry)
}
