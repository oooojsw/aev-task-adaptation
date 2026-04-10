import type { CaseRuntimeContext } from "../case-runtime"
import type { CaseMethodOps } from "../method-strategies"
import {
  finishIfEvalModePrimitive,
  finishIfMaxRetriesReachedPrimitive,
  finishIfPassedPrimitive,
  solveCasePrimitive,
} from "./solve-stage"
import { prepareFeedbackPacketPrimitive } from "./feedback-packet"
import { finishIfJudgeSkippedMaintenancePrimitive, runPreJudgePrimitive } from "./judge"
import {
  invokeKnowledgeMaintainerPrimitive,
  rejectIfMaintenanceFailedPrimitive,
  rejectIfNoExperienceChangePrimitive,
  rejectIfOutOfPolicyFilesPrimitive,
} from "./knowledge-maintenance"
import {
  acceptOrRejectChangePrimitive,
  finishAfterAcceptPrimitive,
  rejectIfCurrentCaseNotFixedPrimitive,
  verifyCurrentCasePrimitive,
} from "./acceptance-flow"
import {
  runRegressionAfterMaintenancePrimitive,
  runRegressionBeforeMaintenancePrimitive,
} from "./regression-suite"

export async function buildCaseMethodOps(context: CaseRuntimeContext): Promise<CaseMethodOps> {
  return {
    solveCase: async () => solveCasePrimitive(context),
    finishIfPassed: async () => finishIfPassedPrimitive(context),
    finishIfEvalMode: async () => finishIfEvalModePrimitive(context),
    finishIfMaxRetriesReached: async () => finishIfMaxRetriesReachedPrimitive(context),
    prepareFeedbackPacket: async () => prepareFeedbackPacketPrimitive(context),
    runRegressionBeforeMaintenance: async () => runRegressionBeforeMaintenancePrimitive(context),
    runPreJudge: async (plan) => runPreJudgePrimitive(context, plan),
    finishIfJudgeSkippedMaintenance: async () => finishIfJudgeSkippedMaintenancePrimitive(context),
    invokeKnowledgeMaintainer: async (plan) => invokeKnowledgeMaintainerPrimitive(context, plan),
    rejectIfMaintenanceFailed: async () => rejectIfMaintenanceFailedPrimitive(context),
    rejectIfNoExperienceChange: async () => rejectIfNoExperienceChangePrimitive(context),
    rejectIfOutOfPolicyFiles: async () => rejectIfOutOfPolicyFilesPrimitive(context),
    verifyCurrentCase: async () => verifyCurrentCasePrimitive(context),
    rejectIfCurrentCaseNotFixed: async () => rejectIfCurrentCaseNotFixedPrimitive(context),
    runRegressionAfterMaintenance: async () => runRegressionAfterMaintenancePrimitive(context),
    acceptOrRejectChange: async () => acceptOrRejectChangePrimitive(context),
    finishAfterAccept: async () => finishAfterAcceptPrimitive(context),
  }
}
