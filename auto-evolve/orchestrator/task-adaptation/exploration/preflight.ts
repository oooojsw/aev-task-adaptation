import path from "node:path"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { Plan } from "../plan"
import type { Binding } from "../../protocol-plugins/contract"
import type { TrainingConfig } from "../../protocol-plugins/training"
import { verifyScriptExecution } from "../../protocol-plugins/script-executor"
import { verifyScriptChecker } from "../../protocol-plugins/script-checker"
import { readCandidate } from "./archive"
import { bindPlan } from "../binding"
import { taskRequestBudget, taskRuntimeBudgets, type TaskBudgetPolicy } from "../budget-policy"
import { requireExplorationHost, ExplorationUnsupportedError } from "./entry"

export async function preflightExploration(plan: Readonly<Plan>, input: {
  root: string; capabilities: string[]; executor?: Binding; checkers: Array<{ name: string; binding: Binding }>
  training: TrainingConfig; requestBudget?: TaskBudgetPolicy
}) {
  requireExplorationHost(plan)
  const cfg = plan.exploration
  if (!cfg) return
  if (!input.requestBudget) throw new Error("Exploration Host requires enforced request stages")
  const bound = await bindPlan(input.root, plan, input.capabilities)
  const size = (ids: string[]) => bound.resources.filter(item => ids.includes(item.id)).reduce((sum, item) => sum + item.bytes, 0)
  if (size(plan.deliverable.entries) > cfg.bounds.candidateBytes || size(cfg.dependencies) > cfg.bounds.dependencyBytes)
    throw new Error("Exploration initial resource capacity exceeded")
  if (cfg.origin.kind === "candidate") {
    const origin = await readCandidate(cfg.origin.archive, cfg.origin.fingerprint, cfg.origin.scope, cfg.bounds.archiveBytes)
    if (cfg.replace.some(id => !origin.record.files.some(file => file.id === id))) throw new Error("Exploration historical origin entries missing")
  }
  const budget = input.requestBudget
  for (const [role, item] of Object.entries(input.training.roles)) {
    const request = taskRequestBudget(budget, plan.stop, role, item.model)
    const stage = role === "reviewer" ? "acceptance" : "author"
    if (request.maxInputTokens + request.maxOutputTokens > cfg.allowance[`${stage}Tokens`])
      throw new Error(`Exploration ${stage} allowance cannot admit selected model`)
  }
  const executor = input.executor
  if ((plan.acceptance.execution === "none") !== !executor) throw new Error("Exploration executor differs from Plan")
  if (executor && !["consolidation-direct-chat", "http-text-chat", "script-json-executor"].includes(executor.id))
    throw new ExplorationUnsupportedError("Exploration executor has no replay-safe adapter")
  if (executor?.id === "script-json-executor") {
    const file = fileURLToPath(new URL("../../protocol-plugins/sandbox-js-runner.mjs", import.meta.url))
    const hash = createHash("sha256").update(await readFile(file)).digest("hex")
    // 只接入固定的同步JS运行器；任意宿主脚本不自报可回滚。
    if (path.resolve(String(executor.settings.script)) !== path.resolve(file) || executor.settings.scriptSHA256 !== hash)
      throw new Error("Exploration script requires bundled replay-safe JS runner")
    await verifyScriptExecution(executor.settings)
  }
  for (const item of input.checkers) {
    if (!["script-json-checker", "http-model-judge", "consolidation-checker"].includes(item.binding.id))
      throw new ExplorationUnsupportedError("Exploration checker has no bounded adapter")
    if (item.binding.id === "script-json-checker") await verifyScriptChecker(item.binding.settings)
  }
  const reviewer = taskRequestBudget(budget, plan.stop, "reviewer", input.training.roles.reviewer.model)
  const ceiling = taskRuntimeBudgets(budget, plan.stop).httpBudgets!.execution!.tokenCeiling
  let calls = 1, tokens = reviewer.maxInputTokens + reviewer.maxOutputTokens
  const include = (count = 1, output = 0) => {
    calls += count
    tokens += count * (ceiling + output)
  }
  if (executor?.id === "consolidation-direct-chat") {
    const count = executor.settings.expectedCases
    if (!Number.isSafeInteger(count) || Number(count) < 1) throw new Error("Bounded consolidation case count required")
    // 用冻结逐请求上界保护完整评测，不以平均消耗估算可运行。
    const bytes = await readFile(String(executor.settings.modelsPath))
    if (createHash("sha256").update(bytes).digest("hex") !== executor.settings.modelsSHA256)
      throw new Error("Exploration model configuration changed")
    const models = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""))
    const output = models.models?.[String(executor.settings.modelID)]?.maxOutputTokens ?? 2048
    if (!Number.isSafeInteger(output) || output < 1) throw new Error("Bounded consolidation output required")
    include(Number(count), output)
  }
  if (executor?.id === "http-text-chat") include()
  for (const item of input.checkers) if (item.binding.id === "http-model-judge") {
    include()
  }
  if (calls > cfg.allowance.acceptanceCalls || tokens > cfg.allowance.acceptanceTokens)
    throw new Error("Exploration acceptance allowance cannot cover frozen workload")
}
