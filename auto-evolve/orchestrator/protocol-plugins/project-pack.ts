import path from "node:path"
import { readFile, realpath, mkdir, open } from "node:fs/promises"
import { createHash } from "node:crypto"
import { writeJsonAtomic } from "../atomic-write"
import { canonical, fingerprint, immutable } from "./identity"
import { identity, strings } from "./registry"
import type { Phase, Project } from "./contract"
import type { InputFile, Task } from "./runtime"

interface File {
  id: string
  kind: string
  path: string
}

export interface PackTask {
  id: string
  split: "train" | "validation" | "test"
  materials: File[]
  privateInputs: File[]
}

export interface ProjectPack {
  schema: "aev.project-pack.v1"
  project: Project
  skill: { format: string; entries: File[] }
  tasks: PackTask[]
}

export interface PackSnapshot {
  schema: "aev.project-pack-snapshot.v1"
  root: string
  pack: ProjectPack
  artifacts: Array<{ path: string; sha256: string; bytes: number }>
  fingerprint: string
}

function fields(value: unknown, keys: string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`Invalid ${label}`)
}

function files(value: unknown): asserts value is File[] {
  if (!Array.isArray(value)) throw new Error("Explicit file bindings required")
  const ids = new Set<string>()
  for (const item of value) {
    fields(item, ["id", "kind", "path"], "file binding")
    if (typeof item.id !== "string" || !item.id.trim() || ids.has(item.id) || typeof item.kind !== "string" ||
        !item.kind.trim() || typeof item.path !== "string" || !item.path.trim()) throw new Error("Invalid file binding")
    relative(item.path)
    ids.add(item.id)
  }
}

function relative(file: string) {
  if (path.isAbsolute(file) || file.includes("\\") || file.includes(":") ||
      file.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Pack paths must be contained relative paths")
  return file
}

async function contained(root: string, file: string) {
  const resolved = await realpath(path.join(root, relative(file)))
  const rel = path.relative(root, resolved)
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Pack path escapes declared root")
  return resolved
}

function validate(value: unknown): ProjectPack {
  fields(value, ["schema", "project", "skill", "tasks"], "project pack")
  const pack = value as ProjectPack
  if (pack.schema !== "aev.project-pack.v1") throw new Error("Unsupported project pack schema")
  fields(pack.project, ["id", "version", "skillFormats", "productKinds", "materialKinds"], "project")
  identity(pack.project)
  strings(pack.project.skillFormats, "project skill formats")
  strings(pack.project.productKinds, "project product kinds")
  strings(pack.project.materialKinds, "project material kinds", true)
  fields(pack.skill, ["format", "entries"], "skill binding")
  files(pack.skill.entries)
  if (!pack.skill.entries.length || !pack.project.skillFormats.includes(pack.skill.format)) throw new Error("Invalid project skill format")
  if (!Array.isArray(pack.tasks) || !pack.tasks.length) throw new Error("Project requires explicit tasks")
  const ids = new Set<string>()
  for (const task of pack.tasks) {
    fields(task, ["id", "split", "materials", "privateInputs"], "task")
    if (typeof task.id !== "string" || !task.id.trim() || ids.has(task.id) ||
        !["train", "validation", "test"].includes(task.split)) throw new Error("Duplicate task or invalid split")
    ids.add(task.id)
    files(task.materials)
    files(task.privateInputs)
    if (task.materials.some((item) => !pack.project.materialKinds.includes(item.kind))) throw new Error("Project material kind mismatch")
  }
  // 同一实际输入不可同时标为公开材料和私有答案，避免声明层旁路。
  const publicPaths = new Set(pack.tasks.flatMap((task) => task.materials.map((item) => item.path)))
  if (pack.tasks.some((task) => task.privateInputs.some((item) => publicPaths.has(item.path)))) {
    throw new Error("Public/private input role collision")
  }
  return immutable(pack)
}

export async function loadPack(file: string): Promise<PackSnapshot> {
  if (!path.isAbsolute(file)) throw new Error("Absolute project manifest required")
  const resolved = await realpath(file)
  const root = await realpath(path.dirname(resolved))
  const pack = validate(JSON.parse((await readFile(resolved, "utf8")).replace(/^\uFEFF/, "")))
  const paths = [...new Set(pack.tasks.flatMap((task) => [...task.materials, ...task.privateInputs].map((item) => item.path)))].sort()
  const artifacts: PackSnapshot["artifacts"] = []
  const publicResolved = new Set<string>()
  for (const task of pack.tasks) for (const item of task.materials) publicResolved.add(await contained(root, item.path))
  for (const task of pack.tasks) for (const item of task.privateInputs) {
    if (publicResolved.has(await contained(root, item.path))) throw new Error("Actual public/private path collision")
  }
  for (const file of paths) {
    const data = await readFile(await contained(root, file))
    artifacts.push({ path: file, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") })
  }
  const body = { schema: "aev.project-pack-snapshot.v1" as const, root, pack, artifacts }
  return immutable({ ...body, fingerprint: fingerprint(body) })
}

export async function verifyPack(snapshot: PackSnapshot) {
  if (!snapshot || snapshot.schema !== "aev.project-pack-snapshot.v1") throw new Error("Invalid project snapshot")
  const { fingerprint: expected, ...body } = snapshot
  if (fingerprint(body) !== expected) throw new Error("Project snapshot drift")
  validate(snapshot.pack)
  if (!path.isAbsolute(snapshot.root) || await realpath(snapshot.root) !== snapshot.root) throw new Error("Project root drift")
  const declared = [...new Set(snapshot.pack.tasks.flatMap((task) => [...task.materials, ...task.privateInputs].map((item) => item.path)))].sort()
  if (canonical(declared) !== canonical(snapshot.artifacts.map((item) => item.path))) throw new Error("Project evidence coverage drift")
  for (const item of snapshot.artifacts) {
    const data = await readFile(await contained(snapshot.root, item.path))
    if (data.length !== item.bytes || createHash("sha256").update(data).digest("hex") !== item.sha256) throw new Error("Project material fingerprint drift")
  }
  return immutable(snapshot)
}

export async function freezePack(dir: string, value: PackSnapshot) {
  if (!path.isAbsolute(dir)) throw new Error("Absolute project snapshot directory required")
  const snapshot = await verifyPack(value)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, "project.snapshot.json")
  try {
    // 独占保存；旧run不能通过再次选择项目替换原来源。
    const claim = await open(path.join(dir, "project.started.claim"), "wx")
    await claim.close()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    const previous = await resumePack(dir)
    if (canonical(previous) !== canonical(snapshot)) throw new Error("Cannot replace project in existing run")
    return previous
  }
  try {
    await readFile(file)
    throw new Error("Unclaimed project snapshot; inspect before recovery")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
  await writeJsonAtomic(file, snapshot)
  return snapshot
}

export async function resumePack(dir: string) {
  if (!path.isAbsolute(dir)) throw new Error("Absolute project snapshot directory required")
  return verifyPack(JSON.parse((await readFile(path.join(dir, "project.snapshot.json"), "utf8")).replace(/^\uFEFF/, "")))
}

export async function taskFromPack(snapshot: PackSnapshot, id: string, phase: Phase, skillRoot: string): Promise<Task> {
  await verifyPack(snapshot)
  const task = snapshot.pack.tasks.find((item) => item.id === id)
  if (!task) throw new Error("Task absent from frozen project")
  if ((phase === "test" && task.split !== "test") || (phase !== "test" && task.split !== "train")) {
    throw new Error("Task split is incompatible with selected phase")
  }
  if (!path.isAbsolute(skillRoot)) throw new Error("Absolute candidate skill root required")
  const root = await realpath(skillRoot)
  const bind = async (items: File[], base: string): Promise<InputFile[]> => Promise.all(items.map(async (item) => ({
    id: item.id, kind: item.kind, path: await contained(base, item.path),
  })))
  return { id: task.id, skill: await bind(snapshot.pack.skill.entries, root),
    materials: await bind(task.materials, snapshot.root), privateInputs: await bind(task.privateInputs, snapshot.root),
    allowedRoots: [snapshot.root, root] }
}
