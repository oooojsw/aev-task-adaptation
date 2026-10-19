import path from "node:path"
import type { LongTaskSpec } from "../../long-task/contract"
import { canonical, fingerprint } from "../../protocol-plugins/identity"
import { verifyBinding } from "../binding"
import { validateTaskBudgetPolicy } from "../budget-policy"
import { openRequestStage, type IntakePrefix } from "../request-budget"
import { withTaskRequestGate } from "../context"
import { explorationPolicy, explorationIdentity } from "./policy"
import type { ArchiveScope } from "./archive"
import type { Admission } from "./admission"

export async function openTaskRequestStage(spec: LongTaskSpec, input: {
  scope: ArchiveScope
  round: number
  pass: number
  generation: 0 | 1
  stage: Admission["stage"]
  previous: string | null
  prefix?: IntakePrefix
}) {
  const bound = spec.taskAdaptationContext, cfg = spec.taskAdaptation
  if (!bound || !cfg?.requestBudget) throw new Error("Frozen stage task and budget required")
  const policy = explorationPolicy(bound.plan.exploration, bound.plan)
  if (!policy) throw new Error("Frozen exploration policy required for stage scheduling")
  await verifyBinding(bound)
  // 阶段授权不能替调用者扩大原任务的全局轮数。
  if (!Number.isSafeInteger(input.round) || input.round < 1 || input.round > bound.plan.stop.rounds) {
    throw new Error("Stage round outside frozen task limit")
  }
  const budget = validateTaskBudgetPolicy(cfg.requestBudget), scope = input.scope
  if (!spec.taskAdaptationCampaignRoot || path.basename(spec.taskAdaptationCampaignRoot) !== scope.campaign ||
    scope.plan !== bound.fingerprint || scope.policy !== explorationIdentity(policy, bound.plan) ||
    scope.protocol !== spec.protocolAuthorContext?.fingerprint ||
    canonical(scope.budget) !== canonical({ root: budget.root, scope: budget.scope })) {
    throw new Error("Stage task scope drift")
  }
  const allowance = policy.allowance
  const stage = input.stage
  if (!["author", "acceptance", "delivery"].includes(stage)) throw new Error("Unsupported task stage")
  const protectedCalls = stage === "author" ? allowance.acceptanceCalls + allowance.deliveryCalls
    : stage === "acceptance" ? allowance.deliveryCalls : 0
  const protectedTokens = stage === "author" ? allowance.acceptanceTokens + allowance.deliveryTokens
    : stage === "acceptance" ? allowance.deliveryTokens : 0
  // Reviewer属于验收阶段；失败诊断只能使用下一作者阶段的额度。
  const roles = stage === "author" ? ["planner", "executor", "worker", "lead", "diagnostician"]
    : stage === "acceptance" ? ["reviewer", "independent", "checker"] : ["delivery"]
  const identity = fingerprint({ schema: "aev.exploration-stage-scope.v1", scope })
  const template = (stage: Admission["stage"], roles: string[]): Admission => ({
    schema: "aev.exploration-admission.v1",
    policy: identity,
    round: input.round, pass: input.pass, generation: input.generation, stage, roles,
    calls: allowance[`${stage}Calls`], tokens: allowance[`${stage}Tokens`],
    protectedCalls: 0, protectedTokens: 0,
  })
  const protection = stage === "author" ? [template("acceptance", ["reviewer", "independent", "checker"]), template("delivery", ["delivery"])]
    : stage === "acceptance" ? [template("delivery", ["delivery"])] : []
  const gate = await openRequestStage({ root: budget.root, scope: budget.scope,
    calls: bound.plan.stop.calls, tokens: bound.plan.stop.tokens }, {
    ...template(stage, roles),
    protectedCalls, protectedTokens,
  }, input.previous, input.prefix, protection)
  // 轮次和授权一起冻结到新spec，旧角色对象保持不变。
  return { gate, spec: withTaskRequestGate({ ...spec, taskAdaptationRound: input.round }, gate.id) }
}
