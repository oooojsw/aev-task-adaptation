import { Database } from "bun:sqlite"
import { lstat, realpath, readdir } from "node:fs/promises"
import path from "node:path"

export async function checkedPath(file: string, kind: "file" | "directory") {
  if (!path.isAbsolute(file)) throw new Error("Absolute transaction path required")
  for (let current = file; current !== path.dirname(current); current = path.dirname(current)) {
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) throw new Error("Linked transaction ancestor rejected")
  }
  if (path.resolve(await realpath(file)).toLowerCase() !== path.resolve(file).toLowerCase())
    throw new Error("Linked transaction path rejected")
  const stat = await lstat(file)
  if (kind === "file" ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
    throw new Error("Invalid transaction path type")
  return stat
}

export async function directoryBytes(root: string): Promise<number> {
  await checkedPath(root, "directory")
  let total = 0
  for (const name of await readdir(root)) {
    const file = path.join(root, name),
      stat = await lstat(file)
    total +=
      stat.isDirectory() && !stat.isSymbolicLink() ? await directoryBytes(file) : (await checkedPath(file, "file")).size
    if (!Number.isSafeInteger(total)) throw new Error("Transaction storage size overflow")
  }
  return total
}

export async function openFileTransaction(
  root: string,
  name: string,
  capacity?: number,
) {
  await checkedPath(root, "directory")
  if (capacity !== undefined && (!Number.isSafeInteger(capacity) || capacity < 1))
    throw new Error("Finite transaction storage capacity required")
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error("Invalid transaction mutex name")
  const file = path.join(root, `${name}.mutex.sqlite`)
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      await checkedPath(file + suffix, "file")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  const db = new Database(file, { create: true })
  let active = false
  try {
    db.exec("PRAGMA busy_timeout=0")
    if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='mutex'").get()) {
      // 初始化也受容量约束，不能先写锁库再报告空间不足。
      if (capacity !== undefined && (await directoryBytes(root)) + 65536 > capacity)
        throw new Error("Transaction storage capacity exceeded")
    }
    // 硬中断由操作系统释放锁；恢复不按文件年龄抢占活跃写者。
    try {
      // 先固定锁库大小，避免提交时才增加磁盘占用而绕过容量预检。
      db.exec("CREATE TABLE IF NOT EXISTS mutex (id INTEGER PRIMARY KEY)")
      db.exec("BEGIN IMMEDIATE")
      active = true
    } catch (error) {
      throw new Error("Transaction writer active or mutex unavailable", { cause: error })
    }
    await checkedPath(file, "file")
    let closed = false
    const finish = (commit: boolean) => {
      if (closed) return
      try {
        db.exec(commit ? "COMMIT" : "ROLLBACK")
        active = false
      } finally {
        try { if (active) db.exec("ROLLBACK") }
        finally { closed = true; db.close() }
      }
    }
    // 显式租约由调用者finally释放，提前返回也不能越过屏障。
    return { commit: () => finish(true), rollback: () => finish(false) }
  } catch (error) {
    try {
      if (active) db.exec("ROLLBACK")
    } finally {
      db.close()
    }
    throw error
  }
}

export async function withFileTransaction<T>(
  root: string,
  name: string,
  fn: () => Promise<T>,
  capacity?: number,
): Promise<T> {
  const lease = await openFileTransaction(root, name, capacity)
  try {
    const result = await fn()
    lease.commit()
    return result
  } finally {
    lease.rollback()
  }
}
