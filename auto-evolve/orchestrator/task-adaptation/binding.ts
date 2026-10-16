import path from "node:path"
import { lstat, readFile, realpath, mkdir, open, access } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fingerprint, immutable } from "../protocol-plugins/identity"
import { validatePlan, roleWindow, type Role, type Stage } from "./plan"
import { writeJsonAtomic } from "../atomic-write"

export async function resolveResource(root: string, relative: string) {
  if (typeof relative !== "string" || relative.includes("\\") || relative.includes(":") ||
    relative.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) throw new Error("Unsafe resource relocation")
  let file = root
  for (const part of relative.split("/")) {
    file = path.join(file, part)
    const stat = await lstat(file)
    // 禁止链接和硬链接把公开材料别名指向私有区。
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw new Error("Linked task resource rejected")
  }
  if (!(await lstat(file)).isFile()) throw new Error("Task resource must be a regular file")
  const actual = await realpath(file)
  const tail = path.relative(root, actual)
  if (tail.startsWith("..") || path.isAbsolute(tail)) throw new Error("Task resource escaped root")
  return actual
}

export async function bindPlan(root: string, value: unknown, capabilities: readonly string[]) {
  const plan = validatePlan(value)
  const missing = plan.capabilities.filter(id => !capabilities.includes(id))
  if (missing.length) throw new Error(`Missing task capabilities: ${missing.join(", ")}`)
  if (!path.isAbsolute(root)) throw new Error("Absolute task root required")
  const actual = await realpath(root)
  if (actual.toLowerCase() !== path.resolve(root).toLowerCase()) throw new Error("Linked task root rejected")
  const resources = []
  for (const resource of plan.resources) {
    const file = await resolveResource(actual, resource.path)
    const bytes = await readFile(file)
    resources.push({ id: resource.id, path: file.replaceAll("\\", "/"), bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), mutable: resource.mutable })
  }
  const identity = { plan, root: actual.replaceAll("\\", "/"), resources }
  return immutable({ ...identity, fingerprint: fingerprint(identity) })
}

export type BoundPlan = Awaited<ReturnType<typeof bindPlan>>

export async function freezePlan(dir: string, root: string, value: unknown, capabilities: readonly string[]) {
  if (!path.isAbsolute(dir)) throw new Error("Absolute task snapshot directory required")
  const current = await bindPlan(root, value, capabilities)
  await mkdir(dir, { recursive: true })
  if ((await realpath(dir)).toLowerCase() !== path.resolve(dir).toLowerCase()) throw new Error("Linked task snapshot directory rejected")
  const file = path.join(dir, "task-plan.snapshot.json")
  try {
    const claim = await open(path.join(dir, "task-plan.started.claim"), "wx")
    await claim.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    // 缺完整快照时保留中断现场，不用新方案静默覆盖。
    const saved = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) as BoundPlan
    if (fingerprint(saved.plan) !== fingerprint(current.plan) || saved.root !== current.root) throw new Error("Frozen task plan drift")
    await verifyBinding(saved)
    return saved
  }
  try {
    await access(file)
    throw new Error("Unclaimed task snapshot exists")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  await writeJsonAtomic(file, current)
  return current
}

export async function verifyBinding(bound: BoundPlan) {
  const current = await bindPlan(bound.root, bound.plan, bound.plan.capabilities)
  // 候选允许更新；任务、固定材料及物理路径不允许静默漂移。
  for (const before of bound.resources) {
    const after = current.resources.find(item => item.id === before.id)!
    if (before.path !== after.path || (!before.mutable && before.sha256 !== after.sha256)) throw new Error(`Task resource drift: ${before.id}`)
  }
  if (fingerprint({ plan: bound.plan, root: bound.root, resources: bound.resources }) !== bound.fingerprint) throw new Error("Task binding fingerprint mismatch")
}

export async function boundWindow(bound: BoundPlan, role: Role, stage: Stage, worker?: string) {
  await verifyBinding(bound)
  const scope = roleWindow(bound.plan, role, stage, worker)
  const file = (id: string) => bound.resources.find(item => item.id === id)!
  // 返回最小视图，不把整份绑定中的私有路径交给作者角色。
  return immutable({ objective: scope.objective, deliverable: scope.deliverable,
    ...(scope.purpose ? { purpose: scope.purpose } : {}), actions: scope.actions,
    reads: scope.reads.map(item => ({ id: item.id, path: file(item.id).path })),
    writes: scope.writes.map(item => ({ id: item.id, path: file(item.id).path })),
    // 保留显式运行时授权，避免修订角色丢失受控反馈。
    ...(scope.runtime ? { runtime: scope.runtime } : {}), inline: scope.inline })
}
