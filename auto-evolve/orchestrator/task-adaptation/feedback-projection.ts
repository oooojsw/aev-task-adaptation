import path from "node:path"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { canonical } from "../protocol-plugins/identity"
import { resolveResource } from "./binding"

export async function feedbackProjection(root: string, file: string, saved: Record<string, unknown>, view: Record<string, unknown>) {
  const from = saved.planFingerprint, to = view.planFingerprint
  if (![from, to].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) || from === to ||
      canonical({ ...saved, planFingerprint: to }) !== canonical(view)) throw new Error("Published task feedback drift")
  // 只有Host批准的原字节可派生新视图，旧反馈不覆盖、判决不修改。
  const proof = JSON.parse((await readFile(await resolveResource(root, "task-adaptation/feedback-rebind.json"), "utf8")).replace(/^\uFEFF/, ""))
  const relative = path.relative(root, file).replaceAll("\\", "/")
  const hash = createHash("sha256").update(await readFile(await resolveResource(root, relative))).digest("hex")
  if (proof.schema !== "aev.feedback-rebind.v1" || proof.from !== from || proof.to !== to ||
      !Array.isArray(proof.views) || !proof.views.some((item: { path: string; sha256: string }) => item.path === relative && item.sha256 === hash)) {
    throw new Error("Published task feedback drift: explicit Host rebind required")
  }
  return path.join(path.dirname(file), `task.feedback.${to}.json`)
}
