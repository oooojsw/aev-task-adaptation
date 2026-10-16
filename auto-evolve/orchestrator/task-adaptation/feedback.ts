import path from "node:path"
import { readFile, access, realpath } from "node:fs/promises"
import { canonical, fingerprint, immutable } from "../protocol-plugins/identity"
import type { Snapshot, Phase } from "../protocol-plugins/contract"
import type { Runtime } from "../protocol-plugins/runtime"
import type { BoundPlan } from "./binding"
import { resolveResource, verifyBinding } from "./binding"
import { writeJsonAtomic } from "../atomic-write"

export interface FeedbackReference { root: string; path: string; task: string; phase: Phase }

export async function taskFeedback(bound: BoundPlan, input: FeedbackReference) {
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
    await writeJsonAtomic(target, view)
  }
  return { path: target.replaceAll("\\", "/"), sha256: fingerprint(view), view }
}
