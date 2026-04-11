export interface PostJudgePlan {
  strategyID: string
}

export interface PostJudgeSummary {
  strategyID: string
  decision: "accept" | "retry"
  currentCaseFixed: boolean
  regressionChecked: boolean
  regressionPassCountBefore: number | null
  regressionPassCountAfter: number | null
  regressionLosses: string[]
  reasons: string[]
  riskLevel: "low" | "medium" | "high"
  notes: string[]
}

export interface PostJudgeResult {
  summary: PostJudgeSummary
  summaryPath: string
  reportPath: string
}
