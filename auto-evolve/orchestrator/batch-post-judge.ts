import type { BatchLearningPacket } from "./batch-packetization"

export interface BatchEvaluationCaseSummary {
  caseID: string
  passed: boolean
  summary: string
  runDir: string
}

export interface BatchRegressionSummary {
  cases: BatchEvaluationCaseSummary[]
  passedCount: number
  failedCount: number
}

export interface BatchPostJudgeSummary {
  strategyID: string
  decision: "accept" | "retry"
  reasons: string[]
  notes: string[]
  riskLevel: "low" | "medium" | "high"
  targetPassCountBefore: number
  targetPassCountAfter: number
  targetGains: string[]
  targetLosses: string[]
  remainingTargetFailures: string[]
  regressionPassCountBefore: number | null
  regressionPassCountAfter: number | null
  regressionLosses: string[]
}

export interface BatchPostJudgeInput {
  packet: BatchLearningPacket
  afterTargets: BatchEvaluationCaseSummary[]
  regressionBefore?: BatchRegressionSummary
  regressionAfter?: BatchRegressionSummary
  changedFiles: string[]
}

export interface BatchPostJudgeStrategy {
  id: string
  title: string
  evaluate(input: BatchPostJudgeInput): BatchPostJudgeSummary
}

function collectLosses(before: BatchEvaluationCaseSummary[], after: BatchEvaluationCaseSummary[]) {
  const afterMap = new Map(after.map((item) => [item.caseID, item]))
  return before
    .filter((item) => item.passed && !afterMap.get(item.caseID)?.passed)
    .map((item) => item.caseID)
    .sort((left, right) => left.localeCompare(right))
}

function collectGains(before: BatchEvaluationCaseSummary[], after: BatchEvaluationCaseSummary[]) {
  const beforeMap = new Map(before.map((item) => [item.caseID, item]))
  return after
    .filter((item) => !beforeMap.get(item.caseID)?.passed && item.passed)
    .map((item) => item.caseID)
    .sort((left, right) => left.localeCompare(right))
}

function buildBaseSummary(input: BatchPostJudgeInput, strategyID: string) {
  const beforeTargets = input.packet.shardCases.map((item) => ({
    caseID: item.caseID,
    passed: item.passed,
    summary: item.summary,
    runDir: item.runDir,
  }))
  const targetGains = collectGains(beforeTargets, input.afterTargets)
  const targetLosses = collectLosses(beforeTargets, input.afterTargets)
  const remainingTargetFailures = input.afterTargets
    .filter((item) => input.packet.maintenanceCandidateCaseIDs.includes(item.caseID) && !item.passed)
    .map((item) => item.caseID)
    .sort((left, right) => left.localeCompare(right))
  const regressionLosses =
    input.regressionBefore && input.regressionAfter
      ? collectLosses(input.regressionBefore.cases, input.regressionAfter.cases)
      : []

  return {
    strategyID,
    targetPassCountBefore: beforeTargets.filter((item) => item.passed).length,
    targetPassCountAfter: input.afterTargets.filter((item) => item.passed).length,
    targetGains,
    targetLosses,
    remainingTargetFailures,
    regressionPassCountBefore: input.regressionBefore?.passedCount ?? null,
    regressionPassCountAfter: input.regressionAfter?.passedCount ?? null,
    regressionLosses,
  }
}

const strictBatchImprovementGuard: BatchPostJudgeStrategy = {
  id: "strict-batch-improvement-guard",
  title: "Strict Batch Improvement Guard",
  evaluate(input) {
    const base = buildBaseSummary(input, "strict-batch-improvement-guard")
    const reasons: string[] = []
    const notes: string[] = []

    if (input.packet.maintenanceCandidateCaseIDs.length && !base.targetGains.length) {
      reasons.push("The batch update did not improve any maintenance-candidate case.")
    }

    if (base.targetLosses.length) {
      reasons.push(`Previously passing batch cases failed after maintenance: ${base.targetLosses.join(", ")}`)
    }

    if (
      base.regressionPassCountBefore !== null &&
      base.regressionPassCountAfter !== null &&
      base.regressionPassCountAfter < base.regressionPassCountBefore
    ) {
      reasons.push(
        `Regression pass count dropped from ${base.regressionPassCountBefore} to ${base.regressionPassCountAfter}.`,
      )
    }

    if (base.regressionLosses.length) {
      reasons.push(`Previously passing regression cases failed after maintenance: ${base.regressionLosses.join(", ")}`)
    }

    if (!reasons.length) {
      notes.push("Batch maintenance improved target coverage without harming the regression guardrail.")
    }

    return {
      ...base,
      decision: reasons.length ? "retry" : "accept",
      reasons,
      notes,
      riskLevel: reasons.length ? "high" : "low",
    }
  },
}

const addOnlyBatchConservativeGuard: BatchPostJudgeStrategy = {
  id: "add-only-batch-conservative-guard",
  title: "Add-Only Batch Conservative Guard",
  evaluate(input) {
    const base = buildBaseSummary(input, "add-only-batch-conservative-guard")
    const reasons: string[] = []
    const notes: string[] = []

    if (input.packet.maintenanceCandidateCaseIDs.length && !base.targetGains.length) {
      reasons.push("The additive batch patch did not improve any maintenance-candidate case.")
    }

    if (base.targetLosses.length) {
      reasons.push(`The additive patch damaged previously passing batch cases: ${base.targetLosses.join(", ")}`)
    }

    if (
      base.regressionPassCountBefore !== null &&
      base.regressionPassCountAfter !== null &&
      base.regressionPassCountAfter < base.regressionPassCountBefore
    ) {
      reasons.push(
        `The additive patch reduced regression pass count from ${base.regressionPassCountBefore} to ${base.regressionPassCountAfter}.`,
      )
    }

    if (base.regressionLosses.length) {
      reasons.push(`The additive patch damaged previously passing regression cases: ${base.regressionLosses.join(", ")}`)
    }

    if (input.changedFiles.length > 5) {
      notes.push(
        `The additive batch patch touched ${input.changedFiles.length} files; review whether the accepted patch stayed narrow enough.`,
      )
    }

    if (!reasons.length && !notes.length) {
      notes.push("The additive batch patch stayed within a conservative risk envelope.")
    }

    return {
      ...base,
      decision: reasons.length ? "retry" : "accept",
      reasons,
      notes,
      riskLevel: reasons.length ? "high" : input.changedFiles.length > 5 ? "medium" : "low",
    }
  },
}

const STRATEGIES = new Map<string, BatchPostJudgeStrategy>([
  [strictBatchImprovementGuard.id, strictBatchImprovementGuard],
  [addOnlyBatchConservativeGuard.id, addOnlyBatchConservativeGuard],
])

export function resolveBatchPostJudgeStrategy(strategyID: string) {
  const strategy = STRATEGIES.get(strategyID)
  if (!strategy) {
    throw new Error(`Unknown batch post-judge strategy: ${strategyID}`)
  }
  return strategy
}
