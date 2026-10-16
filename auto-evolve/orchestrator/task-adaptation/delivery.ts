import path from "node:path"
import { mkdir, readFile, realpath, readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import type { LongTaskSpec } from "../long-task/contract"
import { writeFileAtomic, writeJsonAtomic } from "../atomic-write"
import { canonical, fingerprint } from "../protocol-plugins/identity"
import { resolveResource } from "./binding"
import { readTaskVersions } from "./selection"

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export async function exportTaskDelivery(spec: LongTaskSpec, input: {
  root: string; selectedTaskVersionPath: string; dir: string
}) {
  if (![input.root, input.selectedTaskVersionPath, input.dir].every(path.isAbsolute)) throw new Error("Absolute delivery paths required")
  for (const root of [input.root, spec.taskAdaptation?.root].filter((item): item is string => Boolean(item))) {
    const tail = path.relative(root, input.dir)
    const reverse = path.relative(input.dir, root)
    if (!tail || !path.isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${path.sep}`) ||
        !path.isAbsolute(reverse) && reverse !== ".." && !reverse.startsWith(`..${path.sep}`)) throw new Error("Delivery must be separate from task evidence and candidate")
  }
  const versions = await readTaskVersions(spec, input.root)
  const selected = versions.find(item => path.resolve(item.path) === path.resolve(input.selectedTaskVersionPath))
  if (!selected) throw new Error("Delivery must reference a verified task version")
  const files = await Promise.all(selected.record.files.map(async item => {
    const bytes = await readFile(await resolveResource(path.dirname(selected.path), item.file))
    if (hash(bytes) !== item.sha256 || bytes.length !== item.bytes) throw new Error("Delivery source changed")
    return { ...item, content: bytes }
  }))
  const manifest = { schema: "aev.task-delivery.v1", plan: selected.record.plan, receipt: selected.record.receipt,
    version: selected.path, round: selected.record.round, metric: selected.record.metric,
    files: files.map(({ id, entry, sha256, bytes }) => ({ id, path: `files/${entry}`, sha256, bytes })) }
  const identity = { ...manifest, fingerprint: fingerprint(manifest) }
  const parent = path.dirname(input.dir)
  await mkdir(parent, { recursive: true })
  if (path.resolve(await realpath(parent)).toLowerCase() !== path.resolve(parent).toLowerCase()) throw new Error("Linked delivery parent rejected")
  let fresh = false
  try { await mkdir(input.dir); fresh = true } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  if (path.resolve(await realpath(input.dir)).toLowerCase() !== path.resolve(input.dir).toLowerCase()) throw new Error("Linked delivery directory rejected")
  if (!fresh) {
    // 半完成导出不覆盖，避免把混合版本误报为已交付。
    const saved = JSON.parse((await readFile(await resolveResource(input.dir, "delivery.json"), "utf8")).replace(/^\uFEFF/, ""))
    if (canonical(saved) !== canonical(identity)) throw new Error("Delivery manifest drift")
    const actual = (await readdir(input.dir, { recursive: true, withFileTypes: true })).filter(item => !item.isDirectory())
      .map(item => path.relative(input.dir, path.join(item.parentPath, item.name)).replaceAll("\\", "/")).sort()
    if (canonical(actual) !== canonical(["delivery.json", ...manifest.files.map(item => item.path)].sort())) throw new Error("Unexpected delivery files")
    for (const item of manifest.files) {
      const bytes = await readFile(await resolveResource(input.dir, item.path))
      if (hash(bytes) !== item.sha256 || bytes.length !== item.bytes) throw new Error("Delivered file drift")
    }
    return { path: path.join(input.dir, "delivery.json"), fingerprint: identity.fingerprint, reused: true }
  }
  // 只复制声明的合格交付文件，不复制工作区或私有验收材料。
  for (const [index, item] of files.entries()) {
    const target = path.join(input.dir, manifest.files[index].path)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFileAtomic(target, item.content)
  }
  await writeJsonAtomic(path.join(input.dir, "delivery.json"), identity)
  return { path: path.join(input.dir, "delivery.json"), fingerprint: identity.fingerprint, reused: false }
}
