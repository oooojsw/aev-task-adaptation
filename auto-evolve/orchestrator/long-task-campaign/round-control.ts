import type { LongTaskSpec } from "../long-task/contract"
import type { LongTaskCampaignRoundRecord, LongTaskCampaignState } from "./contract"
import { recordTaskVersion, selectTaskVersion } from "../task-adaptation/selection"
import { closeTaskExplorationRound, findTaskExplorationDecision } from "../task-adaptation/exploration/lifecycle"
import type { TaskCampaignControl } from "../task-adaptation/exploration/ownership"

interface Acceptance {
  passed: boolean
  summary: string
  failureKind?: "product_failure" | "infrastructure_failure" | "dataset_failure"
  protocolTrainingResultPath?: string
  protocolAuditResultPath?: string
}

export async function completeTaskRound(spec: LongTaskSpec, input: {
  cwd: string; root: string; candidateRoot: string; round: number; maxRounds: number
  record: LongTaskCampaignRoundRecord; acceptance?: Acceptance; state: LongTaskCampaignState
  control?: TaskCampaignControl; generation?: 0 | 1
}) {
  if (input.state.currentRound > input.round) throw new Error("Cannot close an earlier Campaign round")
  const saved = input.control ? await findTaskExplorationDecision(spec, input) : undefined
  // 已提交决定可能已切换current，只读正式档案，不再保存旧候选。
  const result = saved ? await (async () => {
    const taskSelection = await selectTaskVersion(spec, { ...input, readonly: true })
    return { taskSelection, ...roundOutcome({ ...input, selection: taskSelection }) }
  })() : await finalizeTaskRound(spec, input)
  let { taskSelection, nextStatus } = result
  const decision = saved ?? (input.control && input.generation !== undefined &&
    ["closed_success", "closed_repairable"].includes(input.record.roundClosure ?? "")
    ? await closeTaskExplorationRound(spec, { ...input, control: input.control, round: input.record,
      pass: Number(input.acceptance?.protocolTrainingResultPath?.match(/pass-(\d+)/)?.[1]),
      generation: input.generation, qualified: input.acceptance?.passed === true }) : undefined)
  if (decision) {
    const stop = decision.action === "finish" || decision.action === "hold"
    if (taskSelection) taskSelection = { ...taskSelection, stop, taskStopReason: stop ? decision.reason : undefined }
    nextStatus = decision.action === "hold" ? "failed" : stop
      ? taskSelection?.passed ? "verified_success" : "round_limit_reached" : "running"
  }
  const state: LongTaskCampaignState = { ...input.state, currentRound: input.round,
    status: nextStatus, updatedAt: new Date().toISOString(), lastRunID: input.record.sourceRunID,
    lastSummary: input.acceptance?.summary ?? input.record.summary, lastRoundSummaryPath: input.record.roundSummaryPath,
    lastRunHardVerified: result.lastRunHardVerified, lastFinalAcceptancePassed: input.acceptance?.passed === true,
    ...(taskSelection ? { selectedTaskVersionPath: taskSelection.selectedTaskVersionPath, taskStopReason: taskSelection.taskStopReason } : {}),
    lastFinalAcceptanceResultPath: input.acceptance?.protocolAuditResultPath ?? input.record.finalAcceptanceSignal?.feedbackPath,
    lastRoundClosure: result.lastRoundClosure, lastGateFailureKind: result.lastGateFailureKind,
    lastGateFailureSummary: result.lastGateFailureSummary,
    recovery: result.acceptanceInfrastructureFailure ? { action: "harvest_round_run", roundNumber: input.round,
      runID: input.record.sourceRunID, reason: `Round ${input.round} validator infrastructure failed; reuse the completed inner run after repair.`,
      detectedAt: new Date().toISOString() } : undefined }
  return { ...result, taskSelection, nextStatus, state, restart: decision?.action === "activate" }
}

export function roundOutcome(input: {
  round: number
  maxRounds: number
  record: LongTaskCampaignRoundRecord
  acceptance?: Acceptance
  selection?: Awaited<ReturnType<typeof recordTaskVersion>>
}) {
  const result = input.acceptance, selection = input.selection
  const infrastructure = result?.failureKind === "infrastructure_failure"
  const dataset = result?.failureKind === "dataset_failure"
  // 平台/数据故障优先，历史合格版本不能掩盖本轮故障。
  const status: LongTaskCampaignState["status"] = infrastructure || dataset ? "failed"
    : selection ? selection.stop ? selection.passed ? "verified_success" : "round_limit_reached" : "running"
    : result?.passed ? "verified_success" : input.round >= input.maxRounds ? "round_limit_reached" : "running"
  const closure: LongTaskCampaignState["lastRoundClosure"] = infrastructure ? "closed_infra_failure"
    : dataset ? "closed_dataset_failure" : result?.passed ? "closed_success"
    : result ? "closed_repairable" : input.record.roundClosure ?? "closed_blocked"
  const failure: LongTaskCampaignState["lastGateFailureKind"] = infrastructure ? "infrastructure_failure"
    : dataset ? "dataset_failure" : result && !result.passed ? "final_acceptance_failed" : input.record.gateFailureKind
  return {
    acceptanceInfrastructureFailure: infrastructure,
    acceptanceDatasetFailure: dataset,
    nextStatus: status,
    lastRoundClosure: closure,
    lastGateFailureKind: failure,
    lastGateFailureSummary: result && !result.passed ? result.summary : input.record.gateFailureSummary,
    lastRunHardVerified: input.record.runVerificationSignal?.completionGateMode === "required" &&
      input.record.runVerificationSignal?.completionGatePassed === true,
  }
}

export async function finalizeTaskRound(spec: LongTaskSpec, input: {
  root: string
  candidateRoot: string
  round: number
  maxRounds: number
  record: LongTaskCampaignRoundRecord
  acceptance?: Acceptance
}) {
  const policy = spec.taskAdaptationContext?.plan.exploration
  // 恢复另走独占入口，不让正常选优或只读终态核验隐式修复档案。
  const taskSelection = await recordTaskVersion(spec, {
    root: input.root, candidateRoot: input.candidateRoot,
    feedback: input.acceptance?.protocolTrainingResultPath,
    passed: input.acceptance?.passed === true, round: input.round, maxRounds: input.maxRounds,
    ...(policy ? { snapshot: { recover: false, cap: policy.bounds.archiveBytes } } : {}),
  })
  return { taskSelection, ...roundOutcome({ ...input, selection: taskSelection }) }
}
