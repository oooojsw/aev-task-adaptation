import { createHash } from "node:crypto"
import { mkdir, readFile, rename, readdir, open } from "node:fs/promises"
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

export async function readMaterialized(file: string, expected: { bytes: number; sha256: string }) {
  const before = await checkedPath(file, "file")
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || before.size !== expected.bytes)
    throw new Error("Recoverable materialization source size drift")
  const handle = await open(file, "r")
  try {
    const opened = await handle.stat()
    if (opened.ino !== before.ino || opened.size !== expected.bytes) throw new Error("Materialization source replaced")
    // 按声明大小有界读取，防止检查后文件变大导致整文件分配。
    const data = Buffer.alloc(expected.bytes)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await handle.stat()
    if (
      offset !== data.length ||
      after.size !== expected.bytes ||
      after.mtimeMs !== opened.mtimeMs ||
      (await checkedPath(file, "file")).ino !== before.ino ||
      createHash("sha256").update(data).digest("hex") !== expected.sha256
    )
      throw new Error("Recoverable materialization content drift")
    return data
  } finally {
    await handle.close()
  }
}

export async function recoverMaterialization(
  root: string,
  target: string,
  expected: { bytes: number; sha256: string },
) {
  const relative = path.relative(root, target)
  if (
    !path.isAbsolute(root) ||
    !path.isAbsolute(target) ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(expected.sha256)
  )
    throw new Error("Invalid materialization recovery identity")
  const staging = path.join(root, "staging")
  const name = `${fingerprint({ relative, hash: expected.sha256 })}.bin`
  const candidates = [target, path.join(staging, name)]
  try {
    await checkedPath(staging, "directory")
    candidates.push(
      ...(await readdir(staging))
        .sort()
        .filter((item) => item.startsWith(`.${name}.tmp-`) && /\.tmp-\d+-\d+-[a-f0-9-]+$/.test(item))
        .map((item) => path.join(staging, item)),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  for (const [index, file] of candidates.entries()) {
    let stat
    try {
      stat = await checkedPath(file, "file")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      continue
    }
    if (stat.size === expected.bytes) {
      try {
        return await readMaterialized(file, expected)
      } catch (error) {
        if (index < 2) throw error
      }
    }
    // 已提交文件不得降级取别处；半写临时文件保留但不采纳。
    if (index < 2) throw new Error("Recoverable materialization content drift")
  }
  return undefined
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
