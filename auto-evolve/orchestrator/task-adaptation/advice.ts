import path from "node:path"
import { readFile, mkdir, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { resolveResource, verifyBinding, type BoundPlan } from "./binding"
import { fingerprint, canonical, immutable } from "../protocol-plugins/identity"
import { writeFileAtomic, writeJsonAtomic } from "../atomic-write"
import { readWorkerAnswer, type WorkerAnswer } from "../long-task-campaign/worker-answer"

export interface AdviceReference { root: string; path: string; kind: "analysis" | "review" }

function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 16000) throw new Error("Invalid bounded task advice text")
  return value
}

function texts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid bounded task advice list")
  return value.map(text)
}

export async function taskAdvice(bound: BoundPlan, input: AdviceReference) {
  return (await taskAdviceBatch(bound, [input]))[0]
}

export async function taskAdviceBatch(bound: BoundPlan, inputs: AdviceReference[]) {
  // 同批建议共享一次材料核验；下一次授权仍重新核验。
  await verifyBinding(bound)
  const results = []
  for (const input of inputs) results.push(await loadAdvice(bound, input))
  return results
}

async function loadAdvice(bound: BoundPlan, input: AdviceReference) {
  if (![input.root, input.path].every(file => typeof file === "string" && path.isAbsolute(file))) throw new Error("Absolute advice identity required")
  const root = await realpath(input.root)
  const relative = path.relative(root, input.path).replaceAll("\\", "/")
  const pattern = input.kind === "analysis"
    ? /^rounds\/round-(\d+)\/workers\/(task-[a-zA-Z0-9_-]+|blank_acceptance_diagnostician)\/(?:(?:pass-\d+|previous-pass-\d+)\/)?suggestion\.json$/
    : /^rounds\/round-(\d+)\/reviewer\/(?:pass-\d+\/)?review-suggestion\.json$/
  const match = pattern.exec(relative)
  if (!match) throw new Error("Unexpected task advice source")
  const bytes = await readFile(await resolveResource(root, relative))
  if (bytes.length > 65536) throw new Error("Task advice exceeds byte budget")
  const value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""))
  if (!Number.isSafeInteger(value.roundNumber) || value.roundNumber < 1 || value.roundNumber !== Number(match[1])) throw new Error("Task advice round mismatch")
  let content: Record<string, unknown>
  let body: string | undefined
  if (value.finalAnswer) {
    await resolveResource(root, path.posix.join(path.posix.dirname(relative), "final-answer.txt"))
    body = await readWorkerAnswer(path.dirname(await resolveResource(root, relative)), value.finalAnswer as WorkerAnswer)
  }
  if (input.kind === "analysis") {
    if (value.role !== match[2] || (value.role !== "blank_acceptance_diagnostician" &&
      !bound.plan.workers.some(worker => `task-${worker.id}` === value.role))) throw new Error("Task advice worker identity mismatch")
    if (value.finalAnswer) {
      const answer = value.finalAnswer as WorkerAnswer
      // 正文引用仅作资料，不授予额外路径权限。
      content = { role: value.role, answerSHA256: answer.sha256, deliveryStatus: answer.status, ...(answer.reason ? { reason: answer.reason } : {}) }
    } else {
      body = "Historical worker result has no verified final-answer artifact. Preserve it for audit; do not treat an empty JSON summary or mixed transcript as a final analysis. No automatic replay is authorized."
      content = { role: value.role, deliveryStatus: "unavailable", reason: "legacy_final_answer_identity_missing" }
    }
  } else {
    if (typeof value.readyForFinalAcceptance !== "boolean") throw new Error("Task review readiness missing")
    content = body === undefined ? { summary: text(value.summary), readinessAdvice: value.readyForFinalAcceptance,
      reasons: texts(value.reasons), nextAttentionAreas: texts(value.nextAttentionAreas) }
      : { answerSHA256: value.finalAnswer.sha256, deliveryStatus: value.finalAnswer.status, readinessAdvice: value.readyForFinalAcceptance }
  }
  // 发布完整最终正文，不包含工具轨迹，正文引用不扩权。
  const view = immutable({ schema: "aev.task-advice.v1", planFingerprint: bound.fingerprint,
    kind: input.kind, round: value.roundNumber, advisoryOnly: true,
    sourceSHA256: createHash("sha256").update(bytes).digest("hex"), content })
  const dir = path.join(root, "task-adaptation", "runtime-views")
  await mkdir(dir, { recursive: true })
  if ((await realpath(dir)).toLowerCase() !== path.resolve(dir).toLowerCase()) throw new Error("Linked advice output directory rejected")
  const target = path.join(dir, `${fingerprint(view)}.json`)
  try {
    const prior = JSON.parse((await readFile(await resolveResource(root, path.relative(root, target).replaceAll("\\", "/")), "utf8")).replace(/^\uFEFF/, ""))
    if (canonical(prior) !== canonical(view)) throw new Error("Published task advice drift")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    await writeJsonAtomic(target, view)
  }
  if (body !== undefined) {
    const file = path.join(dir, `${fingerprint(view)}.txt`)
    try {
      const prior = await readFile(await resolveResource(root, path.relative(root, file).replaceAll("\\", "/")), "utf8")
      if (prior !== body) throw new Error("Published worker final answer drift")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await writeFileAtomic(file, body)
    }
    return { path: file.replaceAll("\\", "/"), fingerprint: fingerprint(view), view }
  }
  return { path: target.replaceAll("\\", "/"), fingerprint: fingerprint(view), view }
}
