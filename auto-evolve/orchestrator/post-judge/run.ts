import path from "node:path"
import { writeJsonFile, writeTextFile } from "../fs"
import type { CaseRuntimeContext } from "../case-runtime"
import type { PostJudgePlan, PostJudgeResult } from "./contract"
import { resolvePostJudgeStrategy } from "./strategies"

function buildPostJudgeReport(context: CaseRuntimeContext, summary: PostJudgeResult["summary"]) {
  return [
    "# Post-Judge Report",
    "",
    "## Task",
    "",
    `- strategy: ${summary.strategyID}`,
    `- case: ${context.loaded.spec.id}`,
    `- attempt: ${context.attempt}`,
    context.currentMaintenanceRound !== undefined
      ? `- maintenance round: ${context.currentMaintenanceRound}`
      : "",
    `- decision: ${summary.decision}`,
    `- risk level: ${summary.riskLevel}`,
    "",
    "## Evidence",
    "",
    `- current case fixed: ${summary.currentCaseFixed ? "yes" : "no"}`,
    `- regression checked: ${summary.regressionChecked ? "yes" : "no"}`,
    `- regression pass count before: ${summary.regressionPassCountBefore ?? "(not available)"}`,
    `- regression pass count after: ${summary.regressionPassCountAfter ?? "(not available)"}`,
    summary.regressionLosses.length
      ? `- regression losses: ${summary.regressionLosses.join(", ")}`
      : "- regression losses: none",
    "",
    "## Reasons",
    "",
    ...(summary.reasons.length ? summary.reasons.map((item) => `- ${item}`) : ["- No rejection reasons."]),
    "",
    "## Notes",
    "",
    ...(summary.notes.length ? summary.notes.map((item) => `- ${item}`) : ["- No extra notes."]),
    "",
  ]
    .filter(Boolean)
    .join("\n")
}

export async function runPostJudge(context: CaseRuntimeContext, plan: PostJudgePlan): Promise<PostJudgeResult> {
  const strategy = resolvePostJudgeStrategy(plan.strategyID)
  const summary = strategy.evaluate(context)
  const summaryPath = path.join(context.acceptanceDir, "post_judge_summary.json")
  const reportPath = path.join(context.acceptanceDir, "post_judge_report.md")

  await writeJsonFile(summaryPath, summary)
  await writeTextFile(reportPath, buildPostJudgeReport(context, summary))

  return {
    summary,
    summaryPath,
    reportPath,
  }
}
