import { Database } from "bun:sqlite"
import path from "node:path"
import { lstat } from "node:fs/promises"
import { regular } from "./publication-evidence"

async function optional(file: string) {
  try {
    await lstat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  await regular(file)
}

export async function withPublicationLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const file = path.join(root, "publication.mutex.sqlite")
  for (const suffix of ["", "-journal", "-wal", "-shm"]) await optional(file + suffix)
  const db = new Database(file, { create: true })
  let claimed = false
  try {
    db.exec("PRAGMA busy_timeout=0")
    // 操作系统在硬中断后释放事务锁，不靠超时删除活跃锁。
    try {
      db.exec("BEGIN IMMEDIATE")
      claimed = true
    } catch (error) {
      throw new Error("Publication writer active or mutex unavailable", { cause: error })
    }
    await regular(file)
    const result = await fn()
    db.exec("COMMIT")
    claimed = false
    return result
  } finally {
    try {
      if (claimed) db.exec("ROLLBACK")
    } finally {
      db.close()
    }
  }
}
