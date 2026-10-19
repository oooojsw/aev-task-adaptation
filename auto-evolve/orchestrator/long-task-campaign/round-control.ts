import type { LongTaskSpec } from "../long-task/contract"
import type { LongTaskCampaignRoundRecord, LongTaskCampaignState } from "./contract"
import { recordTaskVersion } from "../task-adaptation/selection"

interface Acceptance {
  passed: boolean
  summary: string
  failureKind?: "product_failure" | "infrastructure_failure" | "dataset_failure"
  protocolTrainingResultPath?: string
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
