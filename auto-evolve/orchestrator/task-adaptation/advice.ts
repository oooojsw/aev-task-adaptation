import path from "node:path"
import { readFile, mkdir, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { resolveResource, verifyBinding, type BoundPlan } from "./binding"
import { fingerprint, canonical, immutable } from "../protocol-plugins/identity"
import { writeJsonAtomic } from "../atomic-write"

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
  await verifyBinding(bound)
  if (![input.root, input.path].every(file => typeof file === "string" && path.isAbsolute(file))) throw new Error("Absolute advice identity required")
  const root = await realpath(input.root)
  const relative = path.relative(root, input.path).replaceAll("\\", "/")
  const pattern = input.kind === "analysis"
    ? /^rounds\/round-(\d+)\/workers\/(task-[a-zA-Z0-9_-]+|blank_acceptance_diagnostician)\/(?:pass-\d+\/)?suggestion\.json$/
    : /^rounds\/round-(\d+)\/reviewer\/(?:pass-\d+\/)?review-suggestion\.json$/
  const match = pattern.exec(relative)
  if (!match) throw new Error("Unexpected task advice source")
  const bytes = await readFile(await resolveResource(root, relative))
  if (bytes.length > 65536) throw new Error("Task advice exceeds byte budget")
  const value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""))
  if (!Number.isSafeInteger(value.roundNumber) || value.roundNumber < 1 || value.roundNumber !== Number(match[1])) throw new Error("Task advice round mismatch")
  let content: Record<string, unknown>
  if (input.kind === "analysis") {
    if (value.role !== match[2] || (value.role !== "blank_acceptance_diagnostician" &&
      !bound.plan.workers.some(worker => `task-${worker.id}` === value.role))) throw new Error("Task advice worker identity mismatch")
    content = { role: value.role, summary: text(value.summary), findings: texts(value.findings),
      memoryAdvice: texts(value.memoryAdvice), packageAdvice: texts(value.packageAdvice), explorationAdvice: texts(value.explorationAdvice) }
  } else {
    if (typeof value.readyForFinalAcceptance !== "boolean") throw new Error("Task review readiness missing")
    content = { summary: text(value.summary), readinessAdvice: value.readyForFinalAcceptance,
      reasons: texts(value.reasons), nextAttentionAreas: texts(value.nextAttentionAreas) }
  }
  // 仅发布建议正文，排除原始回复、任意引用和内部路径授权。
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
  return { path: target.replaceAll("\\", "/"), fingerprint: fingerprint(view), view }
}
