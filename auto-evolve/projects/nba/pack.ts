import path from "node:path"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { loadPack } from "../../orchestrator/protocol-plugins/project-pack"
import type { ProjectPack } from "../../orchestrator/protocol-plugins/project-pack"

const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex")
const json = (data: Buffer) => JSON.parse(data.toString("utf8").replace(/^\uFEFF/, ""))

export async function buildNbaPack(source: string, destination: string) {
  if (!path.isAbsolute(source) || !path.isAbsolute(destination)) throw new Error("Absolute paths required")
  const root = await realpath(source)
  const parent = await realpath(path.dirname(destination))
  const target = path.join(parent, path.basename(destination))
  const relative = path.relative(root, target)
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("Destination must be outside original dataset")
  }
  const manifestBytes = await readFile(path.join(root, "manifest.json"))
  const manifest = json(manifestBytes)
  const split = manifest.split
  if (!split || typeof split !== "object" || Array.isArray(split) ||
      Object.keys(split).some((key) => !["train", "validation", "test"].includes(key))) throw new Error("Invalid dataset split")
  const pack: ProjectPack = { schema: "aev.project-pack.v1", project: { id: "nba", version: "1",
    skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] },
    skill: { format: "text", entries: [{ id: "skill", kind: "text", path: "skill.txt" }] }, tasks: [] }
  const files: Array<{ path: string; data: Buffer | string }> = []
  const lineage = [{ path: "manifest.json", sha256: hash(manifestBytes), bytes: manifestBytes.length }]
  const seen = new Set<string>()
  for (const name of ["train", "validation", "test"] as const) {
    if (split[name] === undefined && name === "validation") continue
    if (!Array.isArray(split[name]) || !split[name].length) throw new Error("Explicit nonempty split required")
    for (const id of split[name]) {
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id) || seen.has(id)) throw new Error("Invalid or overlapping UID")
      seen.add(id)
      const buffers: Buffer[] = []
      for (const file of [`public/${name}/${id}.json`, `private-answers/${name}/${id}.json`]) {
        const resolved = await realpath(path.join(root, file))
        const rel = path.relative(root, resolved)
        if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Dataset path escape")
        const data = await readFile(resolved)
        buffers.push(data)
        lineage.push({ path: file, sha256: hash(data), bytes: data.length })
      }
      const publicInput = json(buffers[0])
      if (typeof publicInput.system_prompt !== "string" || !publicInput.system_prompt.trim() ||
          typeof publicInput.user_prompt !== "string" || !publicInput.user_prompt.trim()) throw new Error("Missing public prompts")
      json(buffers[1])
      const base = `tasks/${name}/${id}`
      // 只导出显式公开字段，其他元数据不能混入执行上下文。
      files.push({ path: `${base}/system.txt`, data: publicInput.system_prompt },
        { path: `${base}/user.txt`, data: publicInput.user_prompt }, { path: `${base}/gold.json`, data: buffers[1] })
      pack.tasks.push({ id, split: name, materials: [
        { id: "system", kind: "text", path: `${base}/system.txt` },
        { id: "user", kind: "text", path: `${base}/user.txt` }],
        privateInputs: [{ id: "gold", kind: "text", path: `${base}/gold.json` }] })
    }
  }
  // 独占新目录；中断留下的半包必须人工核查，不能自动覆盖。
  await mkdir(target)
  for (const file of files) {
    await mkdir(path.dirname(path.join(target, file.path)), { recursive: true })
    await writeFile(path.join(target, file.path), file.data, { flag: "wx" })
  }
  await writeFile(path.join(target, "source-lineage.json"), JSON.stringify({ source: root, files: lineage }, null, 2), { flag: "wx" })
  await writeFile(path.join(target, "manifest.json"), JSON.stringify(pack, null, 2), { flag: "wx" })
  const snapshot = await loadPack(path.join(target, "manifest.json"))
  await writeFile(path.join(target, "complete.json"), JSON.stringify({ fingerprint: snapshot.fingerprint, tasks: pack.tasks.length }), { flag: "wx" })
  return snapshot
}
