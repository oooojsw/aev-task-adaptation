import path from "node:path"
import { randomUUID } from "node:crypto"
import { createHash } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { writeJsonAtomic } from "../atomic-write"
import { pathExists } from "../fs"
import type { LongTaskValidatorResult } from "../long-task/contract"
import { prepareEntry, runEntry, type Entry } from "./entry"
import { selectedRuntime } from "./selected-runtime"
import type { Runtime } from "./runtime"
import { productEvidenceName } from "./runtime"
import { trainingCheckMessage } from "./training-feedback"
import { canonical, fingerprint } from "./identity"
import { protocolRepairDirective } from "./failure-routing"
import { taskFromPack } from "./project-pack"
import { attemptAccounting } from "./attempt-accounting"
import type { BuiltinOptions } from "./builtins"
import { regular } from "../task-adaptation/consolidation/publication-evidence"

export async function campaignAcceptance(input: {
  budgets?: Pick<BuiltinOptions, "httpBudgets" | "toolBudgets">
  campaignRoot: string
  cwd?: string
  campaignID: string
  roundNumber: number
  runID: string
  entry: Entry
  candidateRoot: string
  attemptRoot: string
  resultPath: string
  taskBinding?: { planFingerprint: string; policyFingerprint: string }
  recoverPublication?: boolean
  publicationCapacityBytes?: number
}, runtime?: Runtime) {
  // 先阻断历史结果覆盖，避免发出请求后才发现证据路径冲突。
  if (await pathExists(input.resultPath)) throw new Error("Campaign acceptance result already exists; inspect original evidence")
  await mkdir(path.dirname(input.resultPath), { recursive: true })
  // 永久占位防并发覆盖；中断后必须核查，不自动重发。
  if (input.recoverPublication) {
    // 出版恢复只使用已完成回执，缺任一证据绝不进入执行器。
    for (const name of ["protocol.receipt.json", "protocol.completed.json", "publication_error.json"]) await regular(path.join(input.attemptRoot, name))
    const failure = JSON.parse((await readFile(path.join(input.attemptRoot, "publication_error.json"), "utf8")).replace(/^\uFEFF/, ""))
    const receipt = JSON.parse((await readFile(path.join(input.attemptRoot, "protocol.receipt.json"), "utf8")).replace(/^\uFEFF/, ""))
    if (failure.receipt !== fingerprint(receipt)) throw new Error("Publication recovery receipt drift")
  } else try { await mkdir(`${input.resultPath}.claim`) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Campaign acceptance result already claimed; inspect interrupted evidence")
    throw error
  }
  if (await pathExists(input.resultPath)) throw new Error("Campaign acceptance result already exists; inspect original evidence")
  const engine = runtime ?? await selectedRuntime(path.join(input.campaignRoot, "protocol-backends"), input.cwd, input.entry, undefined, input.budgets)
  const receipt = await runEntry(input.campaignRoot, input.entry, input.candidateRoot, input.attemptRoot, engine, { reuseCompleted: input.recoverPublication })
  const prepared = await prepareEntry(input.campaignRoot, input.entry, engine)
  if (!prepared) throw new Error("Frozen feedback protocol required")
  const receiptPath = path.join(input.attemptRoot, "protocol.receipt.json")
  const trainingPath = path.join(input.attemptRoot, "protocol.training-feedback.json")
  const productPath = receipt.product ? path.join(input.attemptRoot, productEvidenceName(receipt.product.kind)) : undefined
  const trainingChecks = receipt.checks.map((check) => ({ name: check.name, target: check.target,
    required: check.required, status: check.status,
    message: trainingCheckMessage(prepared.protocol, input.entry.phase, check) }))

  // 生产调用点：核验 Checker 产物并自动发布 50 题受控训练反馈视图
  let caseFeedbackMeta: {
    resourceID: string
    manifestPath: string
    manifestSHA256: string
    totalCases: number
    passedCases: number
  } | undefined

  const selected = prepared.protocol.selection.protocol.phases[input.entry.phase]
  const consolidation = selected?.executor?.id === "consolidation-direct-chat"
  if (consolidation && productPath && receipt.product) {
    try {
      const bytes = await readFile(productPath)
      if (bytes.length !== receipt.product.length || createHash("sha256").update(bytes).digest("hex") !== receipt.product.sha256) {
        throw new Error("Formal product digest mismatch")
      }
      const product = JSON.parse(bytes.toString("utf8"))
      if (!receipt.checks.some(check => check.target === "product" && check.required && check.status === "passed") ||
          receipt.checks.some(check => check.required && check.status !== "passed") ||
          receipt.evidence.skill.length !== 1 || receipt.evidence.skill[0].sha256 !== product.candidate_sha256) {
        throw new Error("Formal consolidation Checker did not verify this candidate")
      }
      const { loadVerifiedConsolidationEvidence } = await import("./consolidation")
      const evidence = await loadVerifiedConsolidationEvidence(path.join(input.campaignRoot, "protocol-backends", "consolidation"),
        product, selected!.executor!.settings)
      const { publishTrainingFeedbackResource } = await import("../task-adaptation/consolidation/feedback-publisher")
      const published = await publishTrainingFeedbackResource({ targetDir: path.join(input.attemptRoot, "training-feedback"),
        campaignID: input.campaignID, round: input.roundNumber, cases: evidence.cases,
        ...(input.publicationCapacityBytes !== undefined ? { maxTotalBytes: input.publicationCapacityBytes } : {}),
        ...(input.recoverPublication && await pathExists(path.join(input.attemptRoot, "training-feedback", "publication.intent.json")) ? { recoverIncomplete: true } : {}),
        expectedCaseIDs: evidence.cases.map(item => item.caseID), binding: { task: receipt.task, phase: receipt.phase,
          protocolFingerprint: receipt.protocolFingerprint, receiptFingerprint: fingerprint(receipt),
          candidateSHA256: product.candidate_sha256, datasetSHA256: product.dataset_sha256, modelID: product.model_id,
          runID: product.runID, passID: path.basename(input.attemptRoot), ...input.taskBinding } })
      caseFeedbackMeta = { resourceID: published.logicalResource.resourceID, manifestPath: published.manifestPath,
        manifestSHA256: published.manifest.manifestSHA256, totalCases: published.manifest.totalCases, passedCases: published.manifest.passedCases }
    } catch (error) {
      // 发布故障保留正式回执，不伪造反馈或重新发送评测。
      await writeJsonAtomic(path.join(input.attemptRoot, "publication_error.json"), {
        schema: "aev.publication-error.v1", receipt: fingerprint(receipt),
        message: error instanceof Error ? error.message : String(error) })
      throw new Error(`publication_error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 训练侧证据引用只指向反馈视图，原始回执仍供审计保存。
  await writeJsonAtomic(trainingPath, { schema: "aev.training-feedback.v1", task: receipt.task,
    phase: receipt.phase, protocolFingerprint: receipt.protocolFingerprint, status: receipt.status,
    claim: receipt.claim, executed: receipt.executed, checks: trainingChecks,
    ...(productPath ? { product: { ...receipt.product, path: productPath } } : {}),
    ...(caseFeedbackMeta ? { caseFeedback: caseFeedbackMeta } : {}) })
  const passed = receipt.status === "passed"
  const failureKind = passed ? undefined : receipt.status === "rejected" ? "product_failure" as const
    : receipt.status === "data_error" ? "dataset_failure" as const : "infrastructure_failure" as const
  const validatorResults: LongTaskValidatorResult[] = receipt.checks.map((check) => ({
    id: randomUUID(), runID: input.runID, unitID: `protocol:${input.entry.taskID}`, attempt: input.roundNumber,
    validatorID: check.name, validatorType: check.mechanism === "judge" ? "prompt_json" : "script", createdAt: new Date().toISOString(),
    passed: check.status === "passed", blocking: check.required,
    ...(check.status === "passed" ? {} : { failureKind: check.status === "rejected" ? "product_failure" as const
      : check.status === "data_error" ? "dataset_failure" as const : "validator_infrastructure" as const }),
    summary: trainingCheckMessage(prepared.protocol, input.entry.phase, check),
    details: protocolRepairDirective(check) ? [protocolRepairDirective(check)!.actionableFix] : [],
    evidenceRefs: [trainingPath], rawOutputPath: trainingPath,
  }))
  // 执行故障也留一个阻断结果，但不把它伪装成Skill内容拒绝。
  if (!passed && !validatorResults.some((item) => item.blocking && !item.passed)) validatorResults.push({
    id: randomUUID(), runID: input.runID, unitID: `protocol:${input.entry.taskID}`, attempt: input.roundNumber,
    validatorID: "protocol-execution", validatorType: "script", createdAt: new Date().toISOString(),
    passed: false, blocking: true, failureKind: "validator_infrastructure", summary: receipt.message,
    details: [], evidenceRefs: [trainingPath], rawOutputPath: trainingPath,
  })
  const protocolTrainingResultPath = `${input.resultPath}.training.json`
  const result = { campaignID: input.campaignID, roundNumber: input.roundNumber, runID: input.runID,
    passed, failureKind, summary: receipt.message, validatorResults,
    acceptanceMode: "protocol_plugins", blankEvalSkipped: !receipt.executed,
    protocolChecks: receipt.checks.map(({ name, target, required, status }) => ({ name, target, required, status })),
    validationPackageRoot: input.candidateRoot, bundlePath: trainingPath,
    blankEvalResultPath: undefined as string | undefined, blankEvalRunDir: undefined as string | undefined,
    preBlankValidationStageResultPath: undefined as string | undefined,
    blankAgentEvidenceBundlePath: trainingPath as string | undefined,
    blankAgentEvidenceReadPaths: [
      trainingPath,
      ...(productPath ? [productPath] : []),
    ],
    blankAgentReadPaths: [] as string[],
    validatorPartitions: { surfaceValidatorIDs: receipt.checks.filter((item) =>
      item.target === "skill").map((item) => item.name), legacyBlankAgentValidatorIDs: [] as string[],
      productValidatorIDs: receipt.checks.filter((item) => item.target === "product").map((item) => item.name) },
    protocolReceiptPath: receiptPath, protocolClaim: receipt.claim,
    protocolTrainingResultPath, protocolAuditResultPath: input.resultPath, createdAt: new Date().toISOString() }
  const { protocolReceiptPath: _, protocolAuditResultPath: __, ...trainingResult } = result
  await writeJsonAtomic(protocolTrainingResultPath, trainingResult)
  await writeJsonAtomic(input.resultPath, result)
  return result
}

export async function verifyCompletedCampaignAcceptance(input: {
  budgets?: Pick<BuiltinOptions, "httpBudgets" | "toolBudgets">
  campaignRoot: string; cwd: string; campaignID: string; roundNumber: number;
  runID: string; entry: Entry; candidateRoot: string; resultPath: string;
}) {
  const result = JSON.parse((await readFile(input.resultPath, "utf8")).replace(/^\uFEFF/, ""))
  const receiptPath = path.join(path.dirname(input.resultPath), "protocol.receipt.json")
  const relative = path.relative(input.campaignRoot, input.resultPath)
  if (!path.isAbsolute(input.resultPath) || relative === ".." || relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) || result.campaignID !== input.campaignID || result.roundNumber !== input.roundNumber ||
    result.runID !== input.runID || result.passed !== true || result.acceptanceMode !== "protocol_plugins" ||
    result.protocolReceiptPath !== receiptPath || result.validationPackageRoot !== input.candidateRoot ||
    result.protocolAuditResultPath !== input.resultPath || result.protocolTrainingResultPath !== `${input.resultPath}.training.json`) {
    throw new Error("Completed Campaign acceptance identity drift")
  }
  const { protocolReceiptPath: _, protocolAuditResultPath: __, ...expectedTraining } = result
  const training = JSON.parse((await readFile(result.protocolTrainingResultPath, "utf8")).replace(/^\uFEFF/, ""))
  if (canonical(training) !== canonical(expectedTraining)) throw new Error("Completed Campaign training feedback drift")
  // 缺少冻结证据只能阻断，不能让复用入口悄悄发出新请求。
  if (!await pathExists(receiptPath) || !await pathExists(path.join(path.dirname(receiptPath), "protocol.completed.json"))) {
    throw new Error("Completed Campaign acceptance evidence missing")
  }
  const runtime = await selectedRuntime(path.join(input.campaignRoot, "protocol-backends"), input.cwd, input.entry, undefined, input.budgets)
  const receipt = await runEntry(input.campaignRoot, input.entry, input.candidateRoot, path.dirname(receiptPath), runtime,
    { reuseCompleted: true })
  if (receipt.status !== "passed" || result.protocolClaim !== receipt.claim) throw new Error("Completed Campaign acceptance verdict drift")
}

export async function readCompletedRejectedCampaignPass(input: {
  budgets?: Pick<BuiltinOptions, "httpBudgets" | "toolBudgets">
  campaignRoot: string; cwd: string; campaignID: string; roundNumber: number;
  runID: string; entry: Entry; resultPath: string;
}) {
  const result = JSON.parse((await readFile(input.resultPath, "utf8")).replace(/^\uFEFF/, "")) as Awaited<ReturnType<typeof campaignAcceptance>>
  const dir = path.dirname(input.resultPath)
  const relative = path.relative(input.campaignRoot, input.resultPath)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      result.campaignID !== input.campaignID || result.roundNumber !== input.roundNumber || result.runID !== input.runID ||
      result.passed !== false || result.failureKind !== "product_failure" || result.acceptanceMode !== "protocol_plugins" ||
      result.protocolReceiptPath !== path.join(dir, "protocol.receipt.json") || result.protocolAuditResultPath !== input.resultPath ||
      result.protocolTrainingResultPath !== `${input.resultPath}.training.json`) throw new Error("Historical rejected pass identity drift")
  const { protocolReceiptPath: _, protocolAuditResultPath: __, ...expected } = result
  const training = JSON.parse((await readFile(result.protocolTrainingResultPath, "utf8")).replace(/^\uFEFF/, ""))
  const receipt = JSON.parse((await readFile(result.protocolReceiptPath, "utf8")).replace(/^\uFEFF/, ""))
  const checkpoint = JSON.parse((await readFile(path.join(dir, "protocol.completed.json"), "utf8")).replace(/^\uFEFF/, ""))
  const accounting = JSON.parse((await readFile(path.join(dir, "protocol.accounting.json"), "utf8")).replace(/^\uFEFF/, ""))
  const runtime = await selectedRuntime(path.join(input.campaignRoot, "protocol-backends"), input.cwd, input.entry, undefined, input.budgets)
  const prepared = await prepareEntry(input.campaignRoot, input.entry, runtime)
  // 历史拒绝只作反馈，不把已变化的当前Skill冒充旧送验版本。
  if (!prepared || canonical(training) !== canonical(expected) || receipt.status !== "rejected" ||
      receipt.task !== input.entry.taskID || receipt.phase !== input.entry.phase || receipt.protocolFingerprint !== prepared.protocol.fingerprint ||
      checkpoint.receipt !== fingerprint(receipt) || checkpoint.accounting !== fingerprint(accounting) ||
      !await pathExists(path.join(dir, "protocol.started.claim")) || !await pathExists(`${input.resultPath}.claim`) ||
      await pathExists(path.join(dir, "protocol.failure.json"))) throw new Error("Historical rejected pass evidence drift")
  const task = await taskFromPack(prepared.project, input.entry.taskID, input.entry.phase, result.validationPackageRoot)
  const inputs = await Promise.all([task.skill, task.materials, task.privateInputs].map(async (files, index) =>
    Promise.all(files.map(async file => {
      const hash = index === 0 ? receipt.evidence.skill.find((item: { id: string }) => item.id === file.id)?.sha256
        : createHash("sha256").update(await readFile(file.path)).digest("hex")
      if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Historical input identity missing")
      return { ...file, sha256: hash }
    }))))
  if (checkpoint.binding !== fingerprint({ entry: input.entry, project: prepared.project.fingerprint,
    protocol: prepared.protocol.fingerprint, inputs }) ||
    canonical(accounting) !== canonical(attemptAccounting(prepared.protocol, input.entry.phase, receipt, accounting.elapsedMs))) {
    throw new Error("Historical rejected input/accounting drift")
  }
  if (receipt.product) {
    const bytes = await readFile(path.join(dir, productEvidenceName(receipt.product.kind)))
    if (canonical(checkpoint.product) !== canonical(receipt.product) || bytes.length !== receipt.product.length ||
        createHash("sha256").update(bytes).digest("hex") !== receipt.product.sha256) throw new Error("Historical rejected product drift")
  }
  return result
}
