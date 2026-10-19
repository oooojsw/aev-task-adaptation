import path from "node:path"
import { readFile, access, realpath } from "node:fs/promises"
import { canonical, fingerprint, immutable } from "../protocol-plugins/identity"
import type { Snapshot, Phase } from "../protocol-plugins/contract"
import type { Runtime } from "../protocol-plugins/runtime"
import type { BoundPlan } from "./binding"
import { resolveResource, verifyBinding } from "./binding"
import { writeJsonAtomic } from "../atomic-write"
import type { LogicalResource } from "../task-profile-access/unified-access"
import { verifyPublication } from "./consolidation/publication-evidence"
import { publicationResource } from "./consolidation/feedback-publisher"
import { createHash } from "node:crypto"
import { productEvidenceName } from "../protocol-plugins/runtime"

export interface FeedbackReference { root: string; path: string; task: string; phase: Phase }

export async function taskFeedback(bound: BoundPlan, input: FeedbackReference, options?: { readonly?: boolean }) {
  await verifyBinding(bound)
  if (![input.root, input.path].every(file => typeof file === "string" && path.isAbsolute(file))) throw new Error("Absolute feedback identity required")
  const root = await realpath(input.root)
  const relative = path.relative(root, input.path).replaceAll("\\", "/")
  const file = await resolveResource(root, relative)
  const result = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))
  if (result.acceptanceMode !== "protocol_plugins" || result.campaignID !== path.basename(root) ||
    result.protocolTrainingResultPath !== input.path || !Number.isSafeInteger(result.roundNumber) || result.roundNumber < 1) throw new Error("Feedback result identity mismatch")
  const dir = path.dirname(file)
  const receipt = JSON.parse((await readFile(await resolveResource(root, path.relative(root, path.join(dir, "protocol.receipt.json")).replaceAll("\\", "/")), "utf8")).replace(/^\uFEFF/, "")) as Awaited<ReturnType<Runtime["run"]>>
  const checkpoint = JSON.parse((await readFile(await resolveResource(root, path.relative(root, path.join(dir, "protocol.completed.json")).replaceAll("\\", "/")), "utf8")).replace(/^\uFEFF/, ""))
  const protocol = JSON.parse((await readFile(await resolveResource(root, "protocol-plugins/protocol.snapshot.json"), "utf8")).replace(/^\uFEFF/, "")) as Snapshot
  const { fingerprint: hash, ...body } = protocol
  if (fingerprint(body) !== hash || receipt.schema !== "aev.protocol-receipt.v1" || receipt.task !== input.task || receipt.phase !== input.phase ||
    receipt.protocolFingerprint !== hash || checkpoint.receipt !== fingerprint(receipt)) throw new Error("Feedback receipt or protocol drift")
  // 训练侧结果必须对应原始判决，不能把旧拒绝或伪造通过接到新反馈。
  if (result.passed !== (receipt.status === "passed") || result.protocolClaim !== receipt.claim ||
    canonical(result.protocolChecks) !== canonical(receipt.checks.map(({ name, target, required, status }) => ({ name, target, required, status }))) ||
    new Set(receipt.checks.map(check => check.name)).size !== receipt.checks.length) throw new Error("Feedback verdict identity mismatch")
  if (receipt.evidence.skill.length !== bound.plan.deliverable.entries.length ||
    new Set(receipt.evidence.skill.map(item => item.id)).size !== receipt.evidence.skill.length ||
    receipt.evidence.skill.some(item => !bound.plan.deliverable.entries.includes(item.id) || !/^[a-f0-9]{64}$/.test(item.sha256))) throw new Error("Feedback candidate identity mismatch")
  const issues = receipt.checks.map(check => {
    const planned = bound.plan.acceptance.checks.find(item => item.id === check.name)
    const actual = protocol.selection.protocol.phases[input.phase]?.checks.find(item => item.name === check.name)
    if (!planned || !actual || check.target !== (planned.target === "candidate" ? "skill" : "product") ||
      actual.target !== check.target || actual.required !== planned.required || check.required !== actual.required ||
      check.mechanism !== actual.mechanism) throw new Error("Feedback check identity mismatch")
    const rejected = check.status === "rejected"
    // 只有任务与冻结协议双方授权，才披露检查器原话。
    const disclose = planned.feedback === "message" && actual.feedback === "checker_message" && ["passed", "rejected"].includes(check.status)
    return { check: check.name, target: planned.target, status: check.status,
      message: disclose ? check.message : `Declared ${planned.target} check ${check.name}: ${check.status}`,
      actions: rejected ? bound.plan.rejection.find(route => route.check === check.name)!.actions : [] }
  })
  const view = immutable({ schema: "aev.task-feedback.v1", planFingerprint: bound.fingerprint, task: receipt.task, phase: receipt.phase,
    protocolFingerprint: hash, round: result.roundNumber, receiptFingerprint: checkpoint.receipt,
    candidate: receipt.evidence.skill.map(({ id, sha256 }) => ({ id, sha256 })), status: receipt.status,
    disposition: ["passed", "rejected"].includes(receipt.status) ? "content" : "platform_fault", issues })
  const target = path.join(dir, "task.feedback.json")
  try {
    await access(target)
    const saved = JSON.parse((await readFile(await resolveResource(root, path.relative(root, target).replaceAll("\\", "/")), "utf8")).replace(/^\uFEFF/, ""))
    if (canonical(saved) !== canonical(view)) throw new Error("Published task feedback drift")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    // 只读核验不能借缺文件取得恢复写权限。
    if (options?.readonly) throw new Error("Published task feedback missing during readonly verification")
    await writeJsonAtomic(target, view)
  }

  let feedbackResource: LogicalResource | undefined
  try {
    const trainingFile = path.join(dir, "protocol.training-feedback.json")
    const trainingContent = JSON.parse((await readFile(trainingFile, "utf8")).replace(/^\uFEFF/, ""))
    if (trainingContent.caseFeedback?.manifestPath) {
      const manifestPath = path.resolve(trainingContent.caseFeedback.manifestPath)
      if (path.resolve(manifestPath) !== path.join(dir, "training-feedback", "manifest.json")) throw new Error("Feedback publication location drift")
      const manifest = await verifyPublication(manifestPath, trainingContent.caseFeedback.manifestSHA256)
      if (manifest.campaignID !== result.campaignID || manifest.round !== result.roundNumber ||
          manifest.binding?.task !== receipt.task || manifest.binding?.phase !== receipt.phase ||
          manifest.binding?.receiptFingerprint !== fingerprint(receipt) || manifest.binding?.protocolFingerprint !== hash ||
          manifest.binding?.candidateSHA256 !== receipt.evidence.skill[0]?.sha256) throw new Error("Feedback publication receipt drift")
      if (manifest.binding.planFingerprint && manifest.binding.planFingerprint !== bound.fingerprint) throw new Error("Feedback task plan drift")
      if (!receipt.product) throw new Error("Feedback source product missing")
      const bytes = await readFile(await resolveResource(root, path.relative(root, path.join(dir, productEvidenceName(receipt.product.kind))).replaceAll("\\", "/")))
      const product = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""))
      if (manifest.binding.datasetSHA256 !== product.dataset_sha256 || manifest.binding.modelID !== product.model_id ||
          manifest.binding.runID !== product.runID || manifest.binding.passID !== path.basename(dir) ||
          createHash("sha256").update(bytes).digest("hex") !== receipt.product.sha256) throw new Error("Feedback source evaluation drift")
      feedbackResource = publicationResource(manifestPath, manifest)
    }
  } catch (error) {
    // 旧任务可无报告；已声明报告损坏不能静默降级。
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || await access(path.join(dir, "protocol.training-feedback.json")).then(() => true, () => false)) throw error
  }

  return { path: target.replaceAll("\\", "/"), sha256: fingerprint(view), view, feedbackResource }
}
