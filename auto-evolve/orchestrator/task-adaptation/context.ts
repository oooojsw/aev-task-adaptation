import path from "node:path"
import { readFile, access, mkdir, lstat, realpath } from "node:fs/promises"
import { writeFileAtomic } from "../atomic-write"
import type { LongTaskSpec } from "../long-task/contract"
import { canonical } from "../protocol-plugins/identity"
import { freezePlan, verifyBinding, resolveResource, type BoundPlan } from "./binding"
import { validatePlan, type Role } from "./plan"
import type { Invocation } from "./invocation"
import { loadPack } from "../protocol-plugins/project-pack"
import type { AdviceReference } from "./advice"

export interface Adaptation {
  schema: "aev.task-adaptation.v1"
  planPath: string
  root: string
  capabilities: string[]
  entries: Array<{ id: string; path: string }>
}

export function validateAdaptation(value: unknown): Adaptation {
  const cfg = value as Adaptation
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) || cfg.schema !== "aev.task-adaptation.v1" ||
    Object.keys(cfg).some(key => !["schema", "planPath", "root", "capabilities", "entries"].includes(key)) ||
    ![cfg.planPath, cfg.root].every(file => typeof file === "string" && path.isAbsolute(file)) ||
    !Array.isArray(cfg.capabilities) || cfg.capabilities.some(id => typeof id !== "string" || !id.trim()) ||
    new Set(cfg.capabilities).size !== cfg.capabilities.length || !Array.isArray(cfg.entries) || !cfg.entries.length ||
    cfg.entries.some(entry => !entry || typeof entry.id !== "string" || !entry.id.trim() || typeof entry.path !== "string" ||
      entry.path.includes("\\") || entry.path.includes(":") || entry.path.split("/").some(part => !part || part === "." || part === "..")) ||
    new Set(cfg.entries.map(entry => entry.id)).size !== cfg.entries.length) throw new Error("Invalid task adaptation configuration")
  return structuredClone(cfg)
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
  const phase = spec.protocolAuthorContext
  // 声明的验收必须与实际协议一致，不能只在作者提示中更换标准。
  if ((plan.acceptance.execution === "none") !== (phase.claim === "skill_check") ||
    plan.acceptance.checks.length !== phase.checks.length || plan.acceptance.checks.some(check =>
      !phase.checks.some(actual => actual.name === check.id && actual.target === (check.target === "candidate" ? "skill" : "product") &&
        actual.required === check.required && (actual.mechanism === check.mechanism ||
          (check.mechanism === "active_judge" && actual.mechanism === "judge" && actual.id === "active-tool-judge"))))) throw new Error("Task plan and execution protocol disagree")
  if (plan.deliverable.entries.length !== phase.skill.entries.length || plan.deliverable.entries.some(id =>
    !phase.skill.entries.some(entry => entry.id === id)) ||
    canonical(cfg.entries) !== canonical(phase.skill.entries.map(({ id, path }) => ({ id, path })))) throw new Error("Task deliverable does not match protocol entry files")
  return freezePlan(dir, cfg.root, plan, cfg.capabilities)
}

export async function restoreTaskContext(spec: LongTaskSpec, value: unknown) {
  if (value === undefined) return undefined
  if (!spec.taskAdaptation) throw new Error("Task context without adaptation config")
  const bound = value as BoundPlan
  await verifyBinding(bound)
  const cfg = validateAdaptation(spec.taskAdaptation)
  const plan = validatePlan(JSON.parse((await readFile(cfg.planPath, "utf8")).replace(/^\uFEFF/, "")))
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

export function taskInvocation(spec: LongTaskSpec, role: Role, input: { candidateRoot?: string; worker?: string; output?: string; feedbackPath?: string; advice?: Array<Omit<AdviceReference, "root">> } = {}): Invocation | undefined {
  if (!spec.taskAdaptation) return undefined
  const bound = spec.taskAdaptationContext
  if (!bound) throw new Error("Frozen task adaptation context missing")
  const output = role === "planner" ? 'Return JSON: {"planner_summary":"", "completion_validator_ids":[], "units":[{"id":"work", "operation":"author_work", "title":"", "goal":"", "inputs":[], "depends_on":[], "expected_artifacts":[], "claim":"", "check_plan":"", "validator_ids":[], "retry_budget":1}]}. Units must perform author work, not formal acceptance.'
    : role === "executor" ? 'Return JSON: {"claimed_success":true,"claim_statement":"","summary":"","blockers":[],"artifacts":[]} after completing the assigned work.'
    : role === "lead" ? 'Edit the declared candidate files. Return JSON: {"summary":"","updated_files":[],"package_highlights":[],"tree_highlights":[],"refs":[],"surface_precheck_passed":false,"surface_precheck_details":[]}.'
    : role === "reviewer" ? 'Return JSON: {"ready_for_final_acceptance":false,"summary":"","reasons":[],"next_attention_areas":[],"refs":[]}.'
    : 'Return JSON: {"summary":"","findings":[],"memory_advice":[],"package_advice":[],"exploration_advice":[],"refs":[]}.'
  const entries = spec.taskAdaptation.entries
  if (input.candidateRoot && !entries) throw new Error("Declared candidate entries missing")
  const feedback = input.feedbackPath ?? spec.taskAdaptationFeedbackPath
  if (feedback && (!spec.taskAdaptationCampaignRoot || !spec.protocolPlugins)) throw new Error("Task feedback campaign identity missing")
  if (input.advice?.length && !spec.taskAdaptationCampaignRoot) throw new Error("Task advice campaign identity missing")
  return { bound, role, stage: role === "lead" || role === "diagnostician" ? "revise" : role === "reviewer" || role === "checker" || role === "independent" ? "accept" : "explore",
    ...(input.worker ? { worker: input.worker } : {}), output: input.output ?? output, maxInlineBytes: 16000,
    ...(input.advice?.length ? { advice: input.advice.map(item => ({ ...item, root: spec.taskAdaptationCampaignRoot! })) } : {}),
    ...(feedback ? { feedback: { root: spec.taskAdaptationCampaignRoot!, path: feedback,
      task: spec.protocolPlugins!.taskID, phase: spec.protocolPlugins!.phase } } : {}),
    ...(input.candidateRoot ? { candidate: { root: input.candidateRoot, entries: entries!.map(entry => ({ id: entry.id, path: entry.path })) } } : {}) }
}
