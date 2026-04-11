import path from "node:path"
import { type CaseRuntimeContext } from "../case-runtime"
import { executeSolveStage } from "./solve-stage"

export async function verifyCurrentCasePrimitive(context: CaseRuntimeContext) {
  const currentCaseVerification = await executeSolveStage({
    context,
    stageDir: path.join(context.acceptanceDir, "current-case-verify"),
    title: `auto-evolve current case verify ${context.loaded.spec.id} attempt ${context.attempt}`,
    phase: "verify",
  })

  context.acceptance.currentCaseVerification = currentCaseVerification
  context.attemptSummary.currentCaseVerificationPassed = currentCaseVerification.evaluation.passed
  context.attemptSummary.currentCaseVerificationReportPath = currentCaseVerification.sessionExecutionReportPath
  const roundSummary =
    context.currentMaintenanceRound !== undefined
      ? context.attemptSummary.maintenanceRounds?.find((item) => item.round === context.currentMaintenanceRound)
      : undefined
  if (roundSummary) {
    roundSummary.currentCaseVerificationPassed = currentCaseVerification.evaluation.passed
    roundSummary.currentCaseVerificationReportPath = currentCaseVerification.sessionExecutionReportPath
  }
}

export async function finishAfterAcceptPrimitive(
  context: CaseRuntimeContext,
): Promise<"finish_run" | null> {
  if (!context.attemptSummary.acceptancePassed) return null
  context.stopReason = "case passed after accepted maintenance"
  return "finish_run"
}
