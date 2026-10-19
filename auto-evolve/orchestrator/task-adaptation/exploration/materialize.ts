import { createHash } from "node:crypto"
import { mkdir, readFile, rename, readdir } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { writeFileAtomic } from "../../atomic-write"
import { checkedPath } from "../../file-transaction"
import { fingerprint } from "../../protocol-plugins/identity"

export function overlaps(a: string, b: string) {
  const first = path.resolve(a).toLowerCase(),
    second = path.resolve(b).toLowerCase()
  const inside = (root: string, file: string) => {
    const relative = path.relative(root, file)
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  }
  return inside(first, second) || inside(second, first)
}

export async function materialization(root: string, target: string, data: Buffer) {
  const relative = path.relative(root, target)
  if (!path.isAbsolute(root) || !path.isAbsolute(target) || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Materialization escaped transaction root")
  const staging = path.join(root, "staging")
  const file = path.join(
    staging,
    `${fingerprint({ relative, hash: createHash("sha256").update(data).digest("hex") })}.bin`,
  )
  try {
    await checkedPath(staging, "directory")
    await checkedPath(file, "file")
    if (!(await readFile(file)).equals(data)) throw new Error("Materialization staging drift")
    return { file, source: file, required: 0 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  let names: string[] = []
  try {
    names = await readdir(staging)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  for (const name of names.sort()) {
    if (!name.startsWith(`.${path.basename(file)}.tmp-`) || !/\.tmp-\d+-\d+-[a-f0-9-]+$/.test(name)) continue
    const candidate = path.join(staging, name)
    const stat = await checkedPath(candidate, "file")
    // 仅复用同目标且原字节完整的残留；部分写入保留计量但不采纳。
    if (stat.size === data.length && (await readFile(candidate)).equals(data))
      return { file, source: candidate, required: 0 }
  }
  return { file, source: undefined, required: data.length }
}

export async function materialize(root: string, target: string, data: Buffer) {
  const prepared = await materialization(root, target, data)
  if (!prepared.source) {
    await mkdir(path.dirname(prepared.file), { recursive: true })
    await checkedPath(path.dirname(prepared.file), "directory")
    // 临时写入留在视图外，硬中断残留不会污染下一次角色输入。
    await writeFileAtomic(prepared.file, data)
  }
  await mkdir(path.dirname(target), { recursive: true })
  await checkedPath(path.dirname(target), "directory")
  try {
    await checkedPath(target, "file")
    throw new Error("Materialization target already exists")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(prepared.source ?? prepared.file, target)
      return
    } catch (error) {
      if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error
      await sleep(Math.min(1000, 50 * 2 ** attempt))
    }
  }
}
