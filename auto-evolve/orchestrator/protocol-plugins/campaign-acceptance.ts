import path from "node:path"
import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { writeJsonAtomic } from "../atomic-write"
import { pathExists } from "../fs"
import type { LongTaskValidatorResult } from "../long-task/contract"
import { runEntry, type Entry } from "./entry"
import { selectedRuntime } from "./selected-runtime"
import type { Runtime } from "./runtime"

export async function campaignAcceptance(input: {
  campaignRoot: string
  cwd?: string
  campaignID: string
  roundNumber: number
  runID: string
  entry: Entry
  candidateRoot: string
  attemptRoot: string
  resultPath: string
}, runtime?: Runtime) {
  // 先阻断历史结果覆盖，避免发出请求后才发现证据路径冲突。
  if (await pathExists(input.resultPath)) throw new Error("Campaign acceptance result already exists; inspect original evidence")
  await mkdir(path.dirname(input.resultPath), { recursive: true })
  // 永久占位防并发覆盖；中断后必须核查，不自动重发。
  try { await mkdir(`${input.resultPath}.claim`) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Campaign acceptance result already claimed; inspect interrupted evidence")
    throw error
  }
  if (await pathExists(input.resultPath)) throw new Error("Campaign acceptance result already exists; inspect original evidence")
  const engine = runtime ?? await selectedRuntime(path.join(input.campaignRoot, "protocol-backends"), input.cwd, input.entry)
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
