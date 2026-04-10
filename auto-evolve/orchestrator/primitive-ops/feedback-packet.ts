import path from "node:path"
import { buildActionTrace } from "../action-trace"
import { buildRefineRoutingBlock, classifyRefineRouting } from "../acceptance"
import { ensureDirectory, writeJsonFile, writeTextFile } from "../fs"
import type { CaseRuntimeContext } from "../case-runtime"

export async function prepareFeedbackPacketPrimitive(context: CaseRuntimeContext) {
  if (!context.solveTask || !context.evaluation) {
    throw new Error("prepareFeedbackPacket requires a completed solve stage.")
  }

  await ensureDirectory(context.maintainInputDir)
  await ensureDirectory(context.acceptanceDir)

  const actualOutputPath = path.join(context.maintainInputDir, "actual_output.txt")
  const evaluationPath = path.join(context.maintainInputDir, "evaluation.json")
  const actionTracePath = path.join(context.maintainInputDir, "action_trace.md")
  const routing = classifyRefineRouting({
    mode: context.loaded.spec.expected.mode,
    actualText: context.solveTask.result.responseText,
    expectedText: context.expectedText,
    evaluation: context.evaluation,
    workspace: context.workspace,
  })

  context.feedback.actualOutputPath = actualOutputPath
  context.feedback.evaluationPath = evaluationPath
  context.feedback.actionTracePath = actionTracePath
  context.feedback.routing = routing
  context.attemptSummary.refineRoutingClass = routing.classification
  context.attemptSummary.refinePreferredFiles = routing.preferredFiles
  context.attemptSummary.refineSuggestedRoles = routing.suggestedRoles

  await writeJsonFile(path.join(context.acceptanceDir, "routing.json"), routing)
  await writeTextFile(actualOutputPath, (context.solveTask.result.responseText || "").trim() + "\n")
  await writeJsonFile(evaluationPath, context.evaluation)
  await writeTextFile(actionTracePath, buildActionTrace(context.solveTask.result.events))
}

export function buildKnowledgeMaintainerContractBlock(context: CaseRuntimeContext, methodContractBlock: string) {
  if (!context.feedback.routing) {
    throw new Error("buildKnowledgeMaintainerContractBlock requires prepared routing.")
  }
  return `${methodContractBlock}\n\n${buildRefineRoutingBlock(context.feedback.routing)}`
}
