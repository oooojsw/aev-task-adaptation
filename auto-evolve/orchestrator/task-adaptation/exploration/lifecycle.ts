import { readFile } from "node:fs/promises"
import path from "node:path"
import type { LongTaskSpec } from "../../long-task/contract"
import type { LongTaskCampaignRoundRecord } from "../../long-task-campaign/contract"
import { checkedPath } from "../../file-transaction"
import { writeFileAtomic, writeJsonAtomic } from "../../atomic-write"
import { canonical, fingerprint } from "../../protocol-plugins/identity"
import { inspectBudget } from "../request-budget"
import { activate } from "./activation"
import { readCandidate, type ArchiveScope } from "./archive"
import { archiveRound } from "./evaluation"
import { decide, type Decision, type Observation } from "./decision"
import { readMaterialized } from "./materialize"
import { freezeTaskOrigin } from "./origin"
import { assertTaskCampaignControl, type TaskCampaignControl } from "./ownership"
import { explorationIdentity, explorationPolicy } from "./policy"
import { resetTaskBranchViews } from "./views"

interface State {
  schema: "aev.exploration-campaign.v1"
  scope: ArchiveScope
  origin: string
  candidates: Array<{ round: number; id: string }>
  observations: Observation[]
  decision: Decision
}

async function exists(file: string) {
  try { await checkedPath(file, "file"); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
}

async function state(root: string, scope: ArchiveScope, cap: number) {
  const file = path.join(root, "task-adaptation/exploration/host/state.json")
  if (!await exists(file)) return undefined
  if ((await checkedPath(file, "file")).size > cap) throw new Error("Exploration state exceeds capacity")
  const saved = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) as { fingerprint: string; record: State }
  if (saved.fingerprint !== fingerprint(saved.record) || saved.record.schema !== "aev.exploration-campaign.v1" ||
    canonical(saved.record.scope) !== canonical(scope)) throw new Error("Exploration state binding mismatch")
  return saved.record
}

export async function closeTaskExplorationRound(spec: LongTaskSpec, input: {
  cwd: string
  root: string
  control: TaskCampaignControl
  round: LongTaskCampaignRoundRecord
  pass: number
  generation: 0 | 1
  qualified: boolean
  stopped?: boolean
  maxRounds?: number
}) {
  assertTaskCampaignControl(input.control, input.root)
  const bound = spec.taskAdaptationContext!, cfg = explorationPolicy(bound.plan.exploration, bound.plan)!
  const scope = input.control.scope, round = input.round.roundNumber
  const prior = await state(input.root, scope, cfg.bounds.archiveBytes)
  const origin = await freezeTaskOrigin(spec, input)
  if (prior && prior.origin !== origin.id) throw new Error("Exploration origin changed")
  // 已关闭整轮仅复用决定，不重读后来已切换的current。
  if (prior?.candidates.at(-1)?.round === round) return prior.decision
  if (prior && prior.candidates.at(-1)!.round > round) throw new Error("Exploration round moved backwards")
  const archive = path.join(input.root, "task-adaptation/exploration/archive")
  const parent = prior?.candidates.at(-1)?.id ?? (cfg.origin.kind === "initial" ? origin.id : null)
  const event = { schema: "aev.exploration-archive-event.v1", scope, round }
  const observed = await archiveRound(spec, { ...input, archive, candidateRoot: path.join(input.root, "pending-expert-package/current"),
    scope, policy: cfg, branch: input.generation ? "alternative" : "original", parent,
    recover: await exists(path.join(archive, `${fingerprint(event)}.event.json`)) })
  const budget = spec.taskAdaptation!.requestBudget!
  const usage = await inspectBudget({ root: budget.root, scope: budget.scope,
    calls: bound.plan.stop.calls, tokens: bound.plan.stop.tokens })
  const limit = Math.min(bound.plan.stop.rounds, input.maxRounds ?? bound.plan.stop.rounds)
  const decision = decide({ policy: cfg, campaign: scope.campaign, observations: prior?.observations ?? [],
    observation: observed.observation, branch: input.generation ? "alternative" : "original",
    activated: input.generation === 1, firstPass: bound.plan.selection.rule === "first_pass", qualified: input.qualified,
    stopped: input.stopped === true, fault: false, unresolved: usage.unresolvedAttempts > 0 || usage.overrunAttempts > 0,
    hardStop: round >= limit, originReady: true,
    remaining: { rounds: Math.max(0, limit - round),
      calls: Math.max(0, usage.limits.calls - usage.admittedAttempts),
      tokens: Math.max(0, usage.limits.tokens - usage.reportedTokens - usage.outstandingTokens) } })
  const record: State = { schema: "aev.exploration-campaign.v1", scope, origin: origin.id,
    candidates: [...(prior?.candidates ?? []), { round, id: observed.candidate.id }],
    observations: decision.observations, decision }
  await writeJsonAtomic(path.join(input.root, "task-adaptation/exploration/host/state.json"), { fingerprint: fingerprint(record), record })
  return decision
}

export async function activateTaskBranch(spec: LongTaskSpec, input: { root: string; control: TaskCampaignControl }) {
  assertTaskCampaignControl(input.control, input.root)
  const bound = spec.taskAdaptationContext!, cfg = explorationPolicy(bound.plan.exploration, bound.plan)!
  const saved = await state(input.root, input.control.scope, cfg.bounds.archiveBytes)
  if (!saved || saved.decision.action !== "activate") return undefined
  const root = path.join(input.root, "task-adaptation/exploration")
  const current = path.join(input.root, "pending-expert-package/current")
  const last = saved.candidates.at(-1)!
  const archive = path.join(root, "archive")
  const before = await readCandidate(archive, last.id, input.control.scope, cfg.bounds.archiveBytes)
  const prepared = await activate({ root: path.join(root, "activation"), candidateRoot: current,
    composition: { root: path.join(root, "composition"), archive, scope: input.control.scope,
      bound, policy: cfg, origin: saved.origin, current: last.id,
      recover: await exists(path.join(root, "composition/composition.intent.json")) &&
        !await exists(path.join(root, "composition/composition.json")) },
    recover: await exists(path.join(root, "activation/activation.intent.json")) &&
      !await exists(path.join(root, "activation/activation.json")) })
  const record = { schema: "aev.exploration-projection.v1", scope: input.control.scope,
    activation: prepared.fingerprint, nextRound: last.round + 1 }
  const projection = path.join(root, "host/projection.json")
  if (await exists(projection)) {
    const prior = JSON.parse((await readFile(projection, "utf8")).replace(/^\uFEFF/, ""))
    if (prior.fingerprint !== fingerprint(record) || canonical(prior.record) !== canonical(record))
      throw new Error("Exploration projection binding mismatch")
    // 投影完成后current可继续演化，恢复不能重置新分支成果。
    return { ...record, view: prepared.record.view }
  }
  const composition = JSON.parse((await readFile(path.join(root, "composition/composition.json"), "utf8")).replace(/^\uFEFF/, ""))
  // 只物化声明入口；原候选已在档案保留，半完成写入可逐文件接续。
  for (const file of before.record.files) {
    const item = composition.record.files.find((item: { id: string }) => item.id === file.id)
    if (!item) throw new Error("Activated entry missing")
    const target = path.join(current, file.path)
    const bytes = await readMaterialized(path.join(prepared.record.view, file.path), item)
    try { await readMaterialized(target, item); continue }
    catch { await readMaterialized(target, file) }
    await writeFileAtomic(target, bytes)
  }
  await resetTaskBranchViews({ ...input, activation: prepared.fingerprint, round: record.nextRound, cap: cfg.bounds.archiveBytes })
  await writeJsonAtomic(projection, { fingerprint: fingerprint(record), record })
  return { ...record, view: prepared.record.view }
}

export async function taskBranchStart(spec: LongTaskSpec, root: string) {
  const bound = spec.taskAdaptationContext
  if (!bound?.plan.exploration) return 1
  const file = path.join(root, "task-adaptation/exploration/host/projection.json")
  if (!await exists(file)) return 1
  const cfg = explorationPolicy(bound.plan.exploration, bound.plan)!
  if ((await checkedPath(file, "file")).size > cfg.bounds.archiveBytes) throw new Error("Branch projection exceeds capacity")
  const saved = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))
  if (saved.fingerprint !== fingerprint(saved.record) || saved.record.schema !== "aev.exploration-projection.v1" ||
    saved.record.scope.plan !== bound.fingerprint || saved.record.scope.campaign !== path.basename(root) ||
    saved.record.scope.policy !== explorationIdentity(cfg, bound.plan) ||
    !Number.isSafeInteger(saved.record.nextRound) || saved.record.nextRound < 2)
    throw new Error("Branch projection identity drift")
  return saved.record.nextRound as number
}

export async function findTaskExplorationDecision(spec: LongTaskSpec, input: { root: string; round: number }) {
  const bound = spec.taskAdaptationContext, budget = spec.taskAdaptation?.requestBudget
  if (!bound?.plan.exploration || !budget || !spec.protocolAuthorContext) throw new Error("Exploration decision context missing")
  const cfg = explorationPolicy(bound.plan.exploration, bound.plan)!
  const scope = { campaign: path.basename(input.root), plan: bound.fingerprint,
    policy: explorationIdentity(cfg, bound.plan)!, protocol: spec.protocolAuthorContext.fingerprint,
    budget: { root: budget.root, scope: budget.scope } }
  const saved = await state(input.root, scope, cfg.bounds.archiveBytes)
  if (!saved || saved.candidates.at(-1)!.round < input.round) return undefined
  if (saved.candidates.at(-1)?.round !== input.round) throw new Error("Exploration round identity drift")
  return saved.decision
}

export async function readTaskExplorationDecision(spec: LongTaskSpec, input: { root: string; round: number }) {
  const saved = await findTaskExplorationDecision(spec, input)
  if (!saved) throw new Error("Exploration terminal round missing")
  return saved
}
