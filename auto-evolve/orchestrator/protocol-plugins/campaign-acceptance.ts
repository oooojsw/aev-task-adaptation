import path from "node:path"
import { randomUUID } from "node:crypto"
import { writeJsonAtomic } from "../atomic-write"
import type { LongTaskValidatorResult } from "../long-task/contract"
import { runEntry, type Entry } from "./entry"
import { builtins } from "./builtins"
import type { Runtime } from "./runtime"

export async function campaignAcceptance(input: {
  campaignRoot: string
  campaignID: string
  roundNumber: number
  runID: string
  entry: Entry
  candidateRoot: string
  attemptRoot: string
  resultPath: string
}, runtime?: Runtime) {
  const engine = runtime ?? await builtins(path.join(input.campaignRoot, "protocol-backends"))
  const receipt = await runEntry(input.campaignRoot, input.entry, input.candidateRoot, input.attemptRoot, engine)
  const receiptPath = path.join(input.attemptRoot, "protocol.receipt.json")
  const passed = receipt.status === "passed"
  const failureKind = passed ? undefined : receipt.status === "rejected" ? "product_failure" as const
    : receipt.status === "data_error" ? "dataset_failure" as const : "infrastructure_failure" as const
  const validatorResults: LongTaskValidatorResult[] = receipt.checks.map((check) => ({
    id: randomUUID(), runID: input.runID, unitID: `protocol:${input.entry.taskID}`, attempt: input.roundNumber,
    validatorID: check.name, validatorType: check.mechanism === "judge" ? "prompt_json" : "script", createdAt: new Date().toISOString(),
    passed: check.status === "passed", blocking: check.required,
    ...(check.status === "passed" ? {} : { failureKind: check.status === "rejected" ? "product_failure" as const
      : check.status === "data_error" ? "dataset_failure" as const : "validator_infrastructure" as const }),
    summary: check.message, details: [], evidenceRefs: [receiptPath], rawOutputPath: receiptPath,
  }))
  // 执行故障也留一个阻断结果，但不把它伪装成Skill内容拒绝。
  if (!passed && !validatorResults.some((item) => item.blocking && !item.passed)) validatorResults.push({
    id: randomUUID(), runID: input.runID, unitID: `protocol:${input.entry.taskID}`, attempt: input.roundNumber,
    validatorID: "protocol-execution", validatorType: "script", createdAt: new Date().toISOString(),
    passed: false, blocking: true, failureKind: "validator_infrastructure", summary: receipt.message,
    details: [], evidenceRefs: [receiptPath], rawOutputPath: receiptPath,
  })
  const result = { campaignID: input.campaignID, roundNumber: input.roundNumber, runID: input.runID,
    passed, failureKind, summary: receipt.message, validatorResults,
    acceptanceMode: "protocol_plugins", blankEvalSkipped: !receipt.executed,
    validationPackageRoot: input.candidateRoot, bundlePath: receiptPath,
    blankEvalResultPath: undefined as string | undefined, blankEvalRunDir: undefined as string | undefined,
    preBlankValidationStageResultPath: undefined as string | undefined,
    blankAgentEvidenceBundlePath: undefined as string | undefined,
    blankAgentReadPaths: [] as string[],
    validatorPartitions: { surfaceValidatorIDs: receipt.checks.filter((item) =>
      item.target === "skill").map((item) => item.name), legacyBlankAgentValidatorIDs: [] as string[],
      productValidatorIDs: receipt.checks.filter((item) => item.target === "product").map((item) => item.name) },
    protocolReceiptPath: receiptPath, protocolClaim: receipt.claim, createdAt: new Date().toISOString() }
  await writeJsonAtomic(input.resultPath, result)
  return result
}
