import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { LongTaskSpec } from "../../long-task/contract"
import { checkedPath } from "../../file-transaction"
import { canonical, fingerprint } from "../../protocol-plugins/identity"
import { resolveResource } from "../binding"
import { readCandidate, saveCandidate, type ArchiveInput } from "./archive"
import { assertTaskCampaignControl, type TaskCampaignControl } from "./ownership"
import { explorationPolicy } from "./policy"

async function json(file: string, cap: number) {
  if ((await checkedPath(file, "file")).size > cap) throw new Error("Origin metadata exceeds capacity")
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))
}

export async function freezeTaskOrigin(spec: LongTaskSpec, input: {
  root: string
  control: TaskCampaignControl
  create?: boolean
}) {
  assertTaskCampaignControl(input.control, input.root)
  const bound = spec.taskAdaptationContext
  if (!bound || bound.fingerprint !== input.control.scope.plan) throw new Error("Origin task binding mismatch")
  const cfg = explorationPolicy(bound.plan.exploration, bound.plan)!
  if (cfg.origin.kind === "candidate") {
    // 读取真实历史身份，不赋予新任务的验收通过资格。
    const saved = await readCandidate(cfg.origin.archive, cfg.origin.fingerprint, cfg.origin.scope, cfg.bounds.archiveBytes)
    if (saved.record.files.length !== bound.plan.deliverable.entries.length || saved.record.files.some(item =>
      !bound.plan.deliverable.entries.includes(item.id) ||
      item.path !== bound.plan.resources.find(resource => resource.id === item.id)?.path) ||
      saved.record.files.reduce((sum, item) => sum + item.bytes, 0) > cfg.bounds.candidateBytes) {
      throw new Error("Historical origin entries differ from frozen deliverable")
    }
    return saved
  }
  const root = path.join(input.root, "task-adaptation/exploration/archive")
  const current = path.join(input.root, "pending-expert-package/current")
  const scope = input.control.scope
  const event = { schema: "aev.exploration-archive-event.v1", scope, round: 0 }
  const file = path.join(root, `${fingerprint(event)}.event.json`)
  let prior: { event: typeof event; candidate: string } | undefined
  try { prior = await json(file, cfg.bounds.archiveBytes) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  if (prior) {
    if (canonical(prior.event) !== canonical(event) || !/^[a-f0-9]{64}$/.test(prior.candidate))
      throw new Error("Initial origin event drift")
    try {
      await checkedPath(path.join(root, prior.candidate, "record.json"), "file")
      // 已冻结起点从档案读取，不要求当前工作版仍是旧正文。
      return await readCandidate(root, prior.candidate, scope, cfg.bounds.archiveBytes)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    let saved
    try { saved = await json(path.join(root, `${prior.candidate}.intent.json`), cfg.bounds.archiveBytes) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    if (saved) {
      if (saved.fingerprint !== prior.candidate || fingerprint(saved.record) !== prior.candidate ||
        canonical(saved.record.scope) !== canonical(scope) || saved.record.round !== 0)
        throw new Error("Initial origin recovery identity drift")
      return saveCandidate({ ...saved.record, root, candidateRoot: current, evidenceRoot: input.root,
        entries: saved.record.files, bounds: cfg.bounds, recover: true })
    }
  }
  // 恢复时缺少起点不能将后来正文冒充初始版本。
  if (!prior && !input.create) throw new Error("Frozen initial origin missing; cannot recreate from current")
  const entries: ArchiveInput["entries"] = []
  let size = 0
  for (const id of bound.plan.deliverable.entries) {
    const resource = bound.plan.resources.find(item => item.id === id)!
    const file = await resolveResource(current, resource.path)
    const stat = await checkedPath(file, "file")
    if (stat.size > cfg.bounds.candidateBytes - size) throw new Error("Initial origin content exceeds capacity")
    const bytes = await readFile(file)
    size += bytes.length
    entries.push({ id, path: resource.path, bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") })
  }
  return saveCandidate({ root, candidateRoot: current, evidenceRoot: input.root, scope,
    round: 0, pass: 0, branch: "original", parent: null, closure: null, feedback: null,
    entries, bounds: cfg.bounds, recover: Boolean(prior) })
}
