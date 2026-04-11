import type { CaseRuntimeContext, RegressionSuiteResult } from "../case-runtime"
import { collectRegressionLosses } from "../case-runtime"
import type { PostJudgeSummary } from "./contract"

export interface PostJudgeStrategy {
  id: string
  title: string
  evaluate(context: CaseRuntimeContext): PostJudgeSummary
}

function regressionNumbers(result?: RegressionSuiteResult) {
  return {
    passed: result?.passedCount ?? null,
  }
}

function buildBaseSummary(context: CaseRuntimeContext, strategyID: string) {
  const currentCaseFixed = Boolean(context.acceptance.currentCaseVerification?.evaluation.passed)
  const before = context.acceptance.baselineRegression
  const after = context.acceptance.afterRegression
  const regressionChecked = Boolean(before && after)
  const regressionLosses =
    before && after ? collectRegressionLosses(before.cases, after.cases) : []
  const beforeNumbers = regressionNumbers(before)
  const afterNumbers = regressionNumbers(after)

  return {
    strategyID,
    currentCaseFixed,
    regressionChecked,
    regressionPassCountBefore: beforeNumbers.passed,
    regressionPassCountAfter: afterNumbers.passed,
    regressionLosses,
  }
}

const strictRegressionGuard: PostJudgeStrategy = {
  id: "strict-regression-guard",
  title: "Strict Regression Guard",
  evaluate(context) {
    const base = buildBaseSummary(context, "strict-regression-guard")
    const reasons: string[] = []
    const notes: string[] = []

    if (!base.currentCaseFixed) {
      reasons.push("The current case still fails during post-maintenance verification.")
    }

    if (base.currentCaseFixed && !base.regressionChecked) {
      reasons.push("Regression evidence is missing, so the maintenance transaction cannot be accepted.")
    }

    if (
      base.regressionChecked &&
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
      notes.push("Current case is fixed and regression results did not degrade.")
    }

    return {
      ...base,
      decision: reasons.length ? "retry" : "accept",
      reasons,
      riskLevel: reasons.length ? "high" : "low",
      notes,
    }
  },
}

const addOnlyConservativeGuard: PostJudgeStrategy = {
  id: "add-only-conservative-guard",
  title: "Add-Only Conservative Guard",
  evaluate(context) {
    const base = buildBaseSummary(context, "add-only-conservative-guard")
    const reasons: string[] = []
    const notes: string[] = []
    const changedFiles = context.maintenance.workspaceChangedFiles ?? []

    if (!base.currentCaseFixed) {
      reasons.push("The additive patch did not repair the current case.")
    }

    if (
      base.regressionChecked &&
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

    if (changedFiles.length > 3) {
      notes.push(
        `The accepted additive patch touches ${changedFiles.length} files; review whether the patch is still narrow enough for add-only maintenance.`,
      )
    }

    if (!reasons.length && !notes.length) {
      notes.push("The additive patch stayed within a conservative post-maintenance risk envelope.")
    }

    return {
      ...base,
      decision: reasons.length ? "retry" : "accept",
      reasons,
      riskLevel: reasons.length ? "high" : changedFiles.length > 3 ? "medium" : "low",
      notes,
    }
  },
}

const POST_JUDGE_STRATEGIES = new Map<string, PostJudgeStrategy>([
  [strictRegressionGuard.id, strictRegressionGuard],
  [addOnlyConservativeGuard.id, addOnlyConservativeGuard],
])

export function resolvePostJudgeStrategy(strategyID: string): PostJudgeStrategy {
  const strategy = POST_JUDGE_STRATEGIES.get(strategyID)
  if (!strategy) {
    throw new Error(`Unknown post-judge strategy: ${strategyID}`)
  }
  return strategy
}
