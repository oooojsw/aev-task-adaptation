import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { LongTaskSpec } from "../../long-task/contract"
import type { LongTaskCampaignRoundRecord } from "../../long-task-campaign/contract"
import { canonical, fingerprint, immutable } from "../../protocol-plugins/identity"
import {
  verifyCompletedCampaignAcceptance,
  readCompletedRejectedCampaignPass,
} from "../../protocol-plugins/campaign-acceptance"
import { checkedPath } from "../../file-transaction"
import { resolveResource } from "../binding"
import { taskFeedback } from "../feedback"
import { taskSelectionSource } from "../selection"
import { taskRuntimeBudgets, validateTaskBudgetPolicy } from "../budget-policy"
import { saveCandidate, type ArchiveScope } from "./archive"
import { explorationIdentity, explorationPolicy, type ExplorationPolicy } from "./policy"
import type { Observation } from "./decision"

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")

// 仅由Host在关闭整轮后调用；不把每次pass或作者自报分当观察。
export async function archiveRound(
  spec: LongTaskSpec,
  input: {
    cwd: string
    root: string
    archive: string
    candidateRoot: string
    scope: ArchiveScope
    policy: Readonly<ExplorationPolicy>
    round: LongTaskCampaignRoundRecord
    pass: number
    branch: "original" | "alternative"
    parent: string | null
    recover?: boolean
  },
) {
  const bound = spec.taskAdaptationContext,
    entry = spec.protocolPlugins
  if (!bound || !entry || !spec.taskAdaptation?.requestBudget)
    throw new Error("Frozen exploration evaluation context required")
  const policy = explorationPolicy(input.policy, bound.plan)!
  const budget = validateTaskBudgetPolicy(spec.taskAdaptation.requestBudget)
  const declared = bound.plan.deliverable.entries.map((id) => ({
    id,
    path: bound.plan.resources.find((resource) => resource.id === id)!.path,
  }))
  if (canonical(spec.taskAdaptation.entries) !== canonical(declared))
    throw new Error("Exploration deliverable entry mapping drift")
  const round = input.round,
    signal = round.finalAcceptanceSignal
  if (
    !path.isAbsolute(input.root) ||
    !path.isAbsolute(input.cwd) ||
    input.scope.campaign !== path.basename(input.root) ||
    input.scope.plan !== bound.fingerprint ||
    input.scope.policy !== explorationIdentity(policy, bound.plan) ||
    canonical(input.scope.budget) !== canonical({ root: budget.root, scope: budget.scope }) ||
    !Number.isSafeInteger(round.roundNumber) ||
    round.roundNumber < 1 ||
    !Number.isSafeInteger(input.pass) ||
    input.pass < 1 ||
    !round.sourceRunID ||
    !signal?.executed ||
    !signal.feedbackPath ||
    !["closed_success", "closed_repairable"].includes(round.roundClosure ?? "") ||
    (signal.failureKind !== undefined && signal.failureKind !== "product_failure") ||
    (round.roundClosure === "closed_success") !== signal.passed
  )
    throw new Error("Exploration requires a normally closed round")
  const feedback = await resolveResource(
    input.root,
    path.relative(input.root, signal.feedbackPath).replaceAll("\\", "/"),
  )
  if (
    round.roundID !== `round-${String(round.roundNumber).padStart(3, "0")}` ||
    feedback !==
      path.join(
        input.root,
        "rounds",
        round.roundID,
        "final-acceptance",
        `pass-${String(input.pass).padStart(2, "0")}`,
        "result.json.training.json",
      )
  )
    throw new Error("Closed round pass identity drift")
  const training = JSON.parse((await readFile(feedback, "utf8")).replace(/^\uFEFF/, ""))
  if (
    training.roundNumber !== round.roundNumber ||
    training.runID !== round.sourceRunID ||
    training.passed !== signal.passed ||
    training.protocolTrainingResultPath !== feedback ||
    training.validationPackageRoot !== input.candidateRoot ||
    !feedback.endsWith(".training.json")
  )
    throw new Error("Closed round acceptance identity drift")
  const result = feedback.slice(0, -".training.json".length)
  const common = {
    cwd: input.cwd,
    campaignRoot: input.root,
    campaignID: input.scope.campaign,
    roundNumber: round.roundNumber,
    runID: round.sourceRunID,
    entry,
    resultPath: result,
    budgets: taskRuntimeBudgets(budget, bound.plan.stop),
  }
  // 复用入口只核验已完成证据，缺回执时不能补发模型请求。
  if (signal.passed) await verifyCompletedCampaignAcceptance({ ...common, candidateRoot: input.candidateRoot })
  else await readCompletedRejectedCampaignPass(common)
  const actual = await taskFeedback(bound, { root: input.root, path: feedback, task: entry.taskID, phase: entry.phase })
  if (actual.view.protocolFingerprint !== input.scope.protocol || !["passed", "rejected"].includes(actual.view.status))
    throw new Error("Exploration evaluation is not a normal content verdict")
  const entries = []
  let size = 0
  for (const item of spec.taskAdaptation.entries) {
    const file = await resolveResource(input.candidateRoot, item.path)
    const before = await checkedPath(file, "file")
    if (before.size > policy.bounds.candidateBytes - size)
      throw new Error("Exploration evaluated candidate capacity exceeded")
    const bytes = await readFile(file),
      sha256 = hash(bytes)
    if (actual.view.candidate.find((candidate) => candidate.id === item.id)?.sha256 !== sha256)
      throw new Error("Exploration candidate changed after acceptance")
    size += bytes.length
    entries.push({ id: item.id, path: item.path, bytes: bytes.length, sha256 })
  }
  // 拒绝的产物不冒充受信指标；首版仅沿用正式best_pass指标来源。
  const metric =
    actual.view.status === "passed" && bound.plan.selection.rule === "best_pass"
      ? (await taskSelectionSource(spec, input.root, feedback)).metric!
      : undefined
  const closure = fingerprint({
    schema: "aev.exploration-round-closure.v1",
    scope: input.scope,
    round: round.roundNumber,
    sourceRunID: round.sourceRunID,
    pass: input.pass,
    receipt: actual.view.receiptFingerprint,
    feedback: actual.sha256,
    status: actual.view.status,
    closure: round.roundClosure,
  })
  const data = await readFile(
    await resolveResource(input.root, path.relative(input.root, actual.path).replaceAll("\\", "/")),
  )
  if (canonical(JSON.parse(data.toString("utf8").replace(/^\uFEFF/, ""))) !== canonical(actual.view))
    throw new Error("Exploration feedback changed after verification")
  const candidate = await saveCandidate({
    root: input.archive,
    candidateRoot: input.candidateRoot,
    evidenceRoot: input.root,
    scope: input.scope,
    round: round.roundNumber,
    pass: input.pass,
    branch: input.branch,
    parent: input.parent,
    closure,
    entries,
    feedback: {
      path: path.relative(input.root, actual.path).replaceAll("\\", "/"),
      bytes: data.length,
      sha256: hash(data),
      status: actual.view.status as "passed" | "rejected",
    },
    ...(metric === undefined ? {} : { metric }),
    bounds: policy.bounds,
    recover: input.recover,
  })
  const observation: Observation = {
    campaign: input.scope.campaign,
    round: round.roundNumber,
    closure,
    branch: input.branch,
    candidate: fingerprint(entries),
    verdict: actual.view.status as "passed" | "rejected",
    ...(metric === undefined ? {} : { metric }),
  }
  return immutable({ candidate, observation })
}
