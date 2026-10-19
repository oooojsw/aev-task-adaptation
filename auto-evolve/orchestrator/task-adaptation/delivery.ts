import path from "node:path"
import { mkdir, readFile, realpath, readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import type { LongTaskSpec } from "../long-task/contract"
import { writeFileAtomic, writeJsonAtomic } from "../atomic-write"
import { canonical, fingerprint } from "../protocol-plugins/identity"
import { resolveResource } from "./binding"
import { readTaskVersions } from "./selection"
import { checkedPath, withFileTransaction } from "../file-transaction"
import { materialize } from "./exploration/materialize"

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
  if (spec.taskAdaptationContext?.plan.exploration) return withFileTransaction(parent,
    `delivery-${hash(Buffer.from(input.dir)).slice(0, 32)}`, async () => {
      const read = async (file: string) => {
        try { await checkedPath(file, "file"); return await readFile(file) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
      }
      const marker = path.join(input.dir, "delivery.json"), intent = path.join(input.dir, "delivery.intent.json")
      const completed = await read(marker), started = await read(intent)
      const allowed = ["delivery.json", "delivery.intent.json", ...manifest.files.map(item => item.path)]
      const actual = (await readdir(input.dir, { recursive: true, withFileTypes: true })).filter(item => !item.isDirectory())
        .map(item => path.relative(input.dir, path.join(item.parentPath, item.name)).replaceAll("\\", "/"))
      if (actual.some(file => !allowed.includes(file))) throw new Error("Unexpected delivery files")
      for (const bytes of [completed, started].filter((item): item is Buffer => item !== undefined))
        if (canonical(JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""))) !== canonical(identity))
          throw new Error("Delivery manifest drift")
      if (!started) {
        if (actual.length) throw new Error("Delivery recovery intent missing")
        await materialize(parent, intent, Buffer.from(JSON.stringify(identity, null, 2) + "\n"))
      }
      // 恢复只补缺失的本地文件，不覆盖冲突，不重做验收。
      for (const [index, item] of files.entries()) {
        const target = path.join(input.dir, manifest.files[index].path), saved = await read(target)
        if (saved) {
          if (hash(saved) !== item.sha256 || saved.length !== item.bytes) throw new Error("Delivered file drift")
          continue
        }
        if (completed) throw new Error("Completed delivery file missing")
        await mkdir(path.dirname(target), { recursive: true })
        await checkedPath(path.dirname(target), "directory")
        await materialize(parent, target, item.content)
      }
      if (!completed) await materialize(parent, marker, Buffer.from(JSON.stringify(identity, null, 2) + "\n"))
      return { path: marker, fingerprint: identity.fingerprint, reused: Boolean(completed) }
    })
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
