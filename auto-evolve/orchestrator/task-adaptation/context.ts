import path from "node:path"
import { readFile, access, mkdir, lstat, realpath } from "node:fs/promises"
import { writeFileAtomic } from "../atomic-write"
import type { LongTaskSpec } from "../long-task/contract"
import { canonical, fingerprint } from "../protocol-plugins/identity"
import type { Snapshot } from "../protocol-plugins/contract"
import { verifyProtocolScopes } from "./protocol-scopes"
import { freezePlan, verifyBinding, resolveResource, type BoundPlan } from "./binding"
import { validatePlan, type Role } from "./plan"
import type { Invocation } from "./invocation"
import { loadPack } from "../protocol-plugins/project-pack"
import type { AdviceReference } from "./advice"
import { freezeTaskBudgetPolicy, validateTaskBudgetPolicy, taskRuntimeBudgets, taskRequestBudget, type TaskBudgetPolicy } from "./budget-policy"
import { validateRequestGate } from "./budget-transport"
import { requireExplorationHost } from "./exploration/entry"
import { preflightExploration } from "./exploration/preflight"

export interface Adaptation {
  schema: "aev.task-adaptation.v1"
  planPath: string
  root: string
  capabilities: string[]
  entries: Array<{ id: string; path: string }>
  requestBudget?: TaskBudgetPolicy
}

export function validateAdaptation(value: unknown): Adaptation {
  const cfg = value as Adaptation
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) || cfg.schema !== "aev.task-adaptation.v1" ||
    Object.keys(cfg).some(key => !["schema", "planPath", "root", "capabilities", "entries", "requestBudget"].includes(key)) ||
    ![cfg.planPath, cfg.root].every(file => typeof file === "string" && path.isAbsolute(file)) ||
    !Array.isArray(cfg.capabilities) || cfg.capabilities.some(id => typeof id !== "string" || !id.trim()) ||
    new Set(cfg.capabilities).size !== cfg.capabilities.length || !Array.isArray(cfg.entries) || !cfg.entries.length ||
    cfg.entries.some(entry => !entry || typeof entry.id !== "string" || !entry.id.trim() || typeof entry.path !== "string" ||
      entry.path.includes("\\") || entry.path.includes(":") || entry.path.split("/").some(part => !part || part === "." || part === "..")) ||
    new Set(cfg.entries.map(entry => entry.id)).size !== cfg.entries.length) throw new Error("Invalid task adaptation configuration")
  if (cfg.requestBudget) validateTaskBudgetPolicy(cfg.requestBudget)
  return structuredClone(cfg)
}

export function taskRequestGate(spec: LongTaskSpec, gate?: string) {
  const bounded = Boolean(spec.taskAdaptation?.requestBudget)
  const inherited = validateRequestGate(spec.taskAdaptationRequestGate, bounded)
  const explicit = validateRequestGate(gate, bounded)
  // 已启动角色不能用新阶段授权替换自身携带的旧授权。
  if (inherited !== undefined && explicit !== undefined && inherited !== explicit) throw new Error("Conflicting task request gate")
  return explicit ?? inherited
}

export function withTaskRequestGate(spec: LongTaskSpec, gate: string): LongTaskSpec {
  const selected = validateRequestGate(gate, Boolean(spec.taskAdaptation?.requestBudget))
  if (selected === undefined) throw new Error("Explicit task request gate required")
  // 每阶段创建独立spec，旧角色仍保留旧授权，不读取可变全局指针。
  return { ...spec, taskAdaptationRequestGate: selected }
}

export async function taskBudgetOptions(spec: LongTaskSpec, requestGate?: string) {
  const gate = taskRequestGate(spec, requestGate)
  if (!spec.taskAdaptation?.requestBudget) return {}
  const cfg = validateAdaptation(spec.taskAdaptation)
  const plan = validatePlan(JSON.parse((await readFile(cfg.planPath, "utf8")).replace(/^\uFEFF/, "")))
  requireExplorationHost(plan)
  if (spec.taskAdaptationContext && canonical(spec.taskAdaptationContext.plan) !== canonical(plan)) throw new Error("Task budget plan drift")
  return taskRuntimeBudgets(cfg.requestBudget, plan.stop, gate)
}

export async function checkTaskExploration(value: Adaptation | undefined) {
  if (!value) return
  const cfg = validateAdaptation(value)
  const plan = validatePlan(JSON.parse((await readFile(cfg.planPath, "utf8")).replace(/^\uFEFF/, "")))
  requireExplorationHost(plan)
}

export async function loadTaskContext(spec: LongTaskSpec, dir: string): Promise<BoundPlan | undefined> {
  if (!spec.taskAdaptation) {
    try { await access(path.join(dir, "task-plan.started.claim")) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    throw new Error("Task adaptation removed from existing campaign")
  }
  if (!spec.protocolPlugins || !spec.protocolAuthorContext) throw new Error("Task adaptation requires prepared protocol context")
  const cfg = validateAdaptation(spec.taskAdaptation)
  const plan = validatePlan(JSON.parse((await readFile(cfg.planPath, "utf8")).replace(/^\uFEFF/, "")))
  requireExplorationHost(plan)
  const phase = spec.protocolAuthorContext
  const snapshot: Snapshot = JSON.parse((await readFile(path.join(dir, "..", "protocol-plugins", "protocol.snapshot.json"), "utf8")).replace(/^\uFEFF/, ""))
  const { fingerprint: savedFingerprint, ...body } = snapshot
  const project = await loadPack(spec.protocolPlugins.projectManifestPath)
  const actualPhase = snapshot.selection.protocol.phases[spec.protocolPlugins.phase]
  if (fingerprint(body) !== savedFingerprint || savedFingerprint !== phase.fingerprint ||
      project.fingerprint !== phase.projectFingerprint || !actualPhase) throw new Error("Task protocol scope identity drift")
  // 声明的验收必须与实际协议一致，不能只在作者提示中更换标准。
  if ((plan.acceptance.execution === "none") !== (phase.claim === "skill_check") ||
    plan.acceptance.checks.length !== phase.checks.length || plan.acceptance.checks.some(check =>
      !actualPhase.checks.some(actual => actual.name === check.id && actual.target === (check.target === "candidate" ? "skill" : "product") &&
        actual.required === check.required && (actual.mechanism === check.mechanism ||
          (check.mechanism === "active_judge" && actual.mechanism === "judge" && actual.id === "active-tool-judge"))))) throw new Error("Task plan and execution protocol disagree")
  if (plan.deliverable.entries.length !== phase.skill.entries.length || plan.deliverable.entries.some(id =>
    !phase.skill.entries.some(entry => entry.id === id)) ||
    canonical(cfg.entries) !== canonical(phase.skill.entries.map(({ id, path }) => ({ id, path })))) throw new Error("Task deliverable does not match protocol entry files")
  await verifyProtocolScopes(plan, cfg.root, project, spec.protocolPlugins.taskID, actualPhase)
  if (plan.exploration) {
    if (!spec.protocolTraining) throw new Error("Exploration Host training configuration missing")
    await preflightExploration(plan, { root: cfg.root, capabilities: cfg.capabilities, training: spec.protocolTraining,
      requestBudget: cfg.requestBudget, executor: actualPhase.executor,
      checkers: actualPhase.checks.map(check => ({ name: check.name, binding: check })) })
  }
  if (cfg.requestBudget) {
    const models = [...Object.values(spec.protocolTraining?.roles ?? {}).map(item => item.model),
      actualPhase.executor?.settings.model, ...actualPhase.checks.map(item => item.settings.model ??
        (item.settings.http && typeof item.settings.http === "object" ? (item.settings.http as Record<string, unknown>).model : undefined))]
    // 模型绑定先齐全再训练，不能做完作者工作才发现裁判缺预算配置。
    for (const model of models) if (typeof model === "string") taskRequestBudget(cfg.requestBudget, plan.stop, "preflight", model)
  }
  await freezeTaskBudgetPolicy(dir, cfg.requestBudget, plan)
  return freezePlan(dir, cfg.root, plan, cfg.capabilities)
}

export async function restoreTaskContext(spec: LongTaskSpec, value: unknown) {
  if (value === undefined) return undefined
  if (!spec.taskAdaptation) throw new Error("Task context without adaptation config")
  const bound = value as BoundPlan
  await verifyBinding(bound)
  const cfg = validateAdaptation(spec.taskAdaptation)
  const plan = validatePlan(JSON.parse((await readFile(cfg.planPath, "utf8")).replace(/^\uFEFF/, "")))
  requireExplorationHost(plan)
  if (!spec.protocolPlugins) throw new Error("Restored task context requires protocol entry")
  const project = await loadPack(spec.protocolPlugins.projectManifestPath)
  if (canonical(cfg.entries) !== canonical(project.pack.skill.entries.map(({ id, path }) => ({ id, path })))) {
    throw new Error("Restored candidate entry mapping drift")
  }
  if (canonical(plan) !== canonical(bound.plan) || path.resolve(cfg.root).toLowerCase() !== path.resolve(bound.root).toLowerCase()) {
    throw new Error("Task context configuration drift")
  }
  return bound
}

export async function seedTaskCandidate(spec: LongTaskSpec, root: string) {
  if (!spec.taskAdaptation) return
  const bound = spec.taskAdaptationContext
  if (!bound) throw new Error("Frozen task context required before seeding")
  await verifyBinding(bound)
  const actual = await realpath(root)
  if (actual.toLowerCase() !== path.resolve(root).toLowerCase()) throw new Error("Linked candidate seed root rejected")
  for (const entry of spec.taskAdaptation.entries) {
    const source = bound.resources.find(file => file.id === entry.id)
    if (!source || !bound.plan.deliverable.entries.includes(entry.id)) throw new Error("Candidate seed identity missing")
    let parent = root
    for (const part of entry.path.split("/").slice(0, -1)) {
      parent = path.join(parent, part)
      await mkdir(parent).catch(error => { if (error.code !== "EEXIST") throw error })
      if ((await lstat(parent)).isSymbolicLink()) throw new Error("Linked candidate seed parent rejected")
    }
    const file = path.join(root, entry.path)
    const bytes = await readFile(source.path)
    try {
      const existing = await readFile(await resolveResource(root, entry.path))
      if (!existing.equals(bytes)) throw new Error("Conflicting task candidate seed")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      // 新任务从冻结起点建候选；恢复不重置已演化的正文。
      await mkdir(path.dirname(file), { recursive: true })
      await writeFileAtomic(file, bytes)
    }
  }
}

import type { LogicalResource } from "../task-profile-access/unified-access"
import { REVIEW_OUTPUT } from "../long-task-campaign/review-answer"

export function taskInvocation(spec: LongTaskSpec, role: Role, input: { candidateRoot?: string; worker?: string; output?: string; requirements?: string[]; feedbackPath?: string; feedbackResource?: LogicalResource; round?: number; passID?: string; requestGate?: string; advice?: Array<Omit<AdviceReference, "root">> } = {}): Invocation | undefined {
  const gate = taskRequestGate(spec, input.requestGate)
  if (!spec.taskAdaptation) {
    return undefined
  }
  const bound = spec.taskAdaptationContext
  if (!bound) throw new Error("Frozen task adaptation context missing")
  requireExplorationHost(bound.plan)
  const output = role === "planner" ? 'Return JSON: {"planner_summary":"", "completion_validator_ids":[], "units":[{"id":"work", "operation":"author_work", "title":"", "goal":"", "inputs":[], "depends_on":[], "expected_artifacts":[], "claim":"", "check_plan":"", "validator_ids":[], "retry_budget":1}]}. Units must perform author work, not formal acceptance.'
    : role === "executor" ? 'Return JSON: {"claimed_success":true,"claim_statement":"","summary":"","blockers":[],"artifacts":[]} after completing the assigned work.'
    : role === "lead" ? 'Edit the declared candidate files. Return JSON: {"summary":"","updated_files":[],"package_highlights":[],"tree_highlights":[],"refs":[],"surface_precheck_passed":false,"surface_precheck_details":[]}.'
    : role === "reviewer" ? REVIEW_OUTPUT
    : 'Return your complete final analysis for the Lead as ordinary text or Markdown, not a JSON schema. Include findings, supporting evidence, uncertainties and actionable recommendations. Do not include hidden reasoning, tool transcripts or context-compaction summaries. Finish the assigned analysis before your final answer.'
  const entries = spec.taskAdaptation.entries
  if (input.candidateRoot && !entries) throw new Error("Declared candidate entries missing")
  const feedback = input.feedbackPath ?? spec.taskAdaptationFeedbackPath
  if (feedback && (!spec.taskAdaptationCampaignRoot || !spec.protocolPlugins)) throw new Error("Task feedback campaign identity missing")
  if (input.advice?.length && !spec.taskAdaptationCampaignRoot) throw new Error("Task advice campaign identity missing")
  return { bound, role, stage: role === "lead" || role === "diagnostician" ? "revise" : role === "reviewer" || role === "checker" || role === "independent" ? "accept" : "explore",
    ...(spec.taskAdaptationCampaignRoot ? { campaignID: path.basename(spec.taskAdaptationCampaignRoot), round: input.round ?? spec.taskAdaptationRound,
      ...(input.passID ? { passID: input.passID } : {}) } : {}),
    ...(input.worker ? { worker: input.worker } : {}), output: input.output ?? output, maxInlineBytes: 16000,
    ...(input.requirements?.length ? { requirements: input.requirements } : {}),
    ...(spec.taskAdaptation.requestBudget ? { requestBudget: spec.taskAdaptation.requestBudget } : {}),
    ...(gate === undefined ? {} : { requestGate: gate }),
    ...(input.advice?.length ? { advice: input.advice.map(item => ({ ...item, root: spec.taskAdaptationCampaignRoot! })) } : {}),
    ...(feedback ? { feedback: { root: spec.taskAdaptationCampaignRoot!, path: feedback,
      task: spec.protocolPlugins!.taskID, phase: spec.protocolPlugins!.phase } } : {}),
    ...(input.feedbackResource ? { feedbackResource: input.feedbackResource } : {}),
    ...(input.candidateRoot ? { candidate: { root: input.candidateRoot, entries: entries!.map(entry => ({ id: entry.id, path: entry.path })) } } : {}) }
}
