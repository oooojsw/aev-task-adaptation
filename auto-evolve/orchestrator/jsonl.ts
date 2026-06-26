import path from "node:path"
import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { ensureDirectory } from "./fs"

export interface JsonlLockOptions {
  timeoutMs?: number
  staleMs?: number
  pollMs?: number
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isErrno(error: unknown, code: string) {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code
}

function isTransientLockError(error: unknown) {
  return isErrno(error, "EEXIST") || isErrno(error, "EPERM") || isErrno(error, "EBUSY") || isErrno(error, "EACCES")
}

async function pathExists(target: string) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function readTextIfExists(target: string) {
  try {
    return await readFile(target, "utf8")
  } catch (error) {
    if (isErrno(error, "ENOENT")) return ""
    throw error
  }
}

function lockDirFor(target: string) {
  return `${target}.lock`
}

export async function withFileLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
  options: JsonlLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const staleMs = options.staleMs ?? 10 * 60_000
  const pollMs = options.pollMs ?? 80
  const startedAt = Date.now()
  const ownerPath = path.join(lockDir, "owner.json")
  const owner = {
    pid: process.pid,
    id: randomUUID(),
    acquiredAt: new Date().toISOString(),
  }

  while (true) {
    try {
      await mkdir(lockDir, { recursive: false })
      try {
        await writeFile(ownerPath, JSON.stringify(owner, null, 2), "utf8")
      } catch {
        // Owner metadata is best-effort only; mkdir is the real cross-process lock.
      }
      break
    } catch (error) {
      if (!isTransientLockError(error)) throw error

      try {
        const info = await stat(lockDir)
        if (Date.now() - info.mtimeMs > staleMs) {
          await rm(lockDir, { recursive: true, force: true })
          continue
        }
      } catch (statError) {
        if (isErrno(statError, "ENOENT")) continue
        if (!isTransientLockError(statError)) throw statError
        // Windows can briefly deny stat() while another process is creating/removing the lock dir.
        // Treat that as normal lock contention instead of failing the append path.
        if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for file lock: ${lockDir}`)
        await sleep(pollMs + Math.floor(Math.random() * pollMs))
        continue
      }

      if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for file lock: ${lockDir}`)
      await sleep(pollMs + Math.floor(Math.random() * pollMs))
    }
  }

  try {
    return await fn()
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function withJsonlLock<T>(target: string, fn: () => Promise<T>, options?: JsonlLockOptions): Promise<T> {
  await ensureDirectory(path.dirname(target))
  return withFileLock(lockDirFor(target), fn, options)
}

export async function ensureJsonlFileLocked(target: string, options?: JsonlLockOptions) {
  await withJsonlLock(
    target,
    async () => {
      if (!(await pathExists(target))) await writeFile(target, "", "utf8")
    },
    options,
  )
}

export async function appendJsonlLocked<T>(target: string, value: T, options?: JsonlLockOptions) {
  await withJsonlLock(
    target,
    async () => {
      await appendFile(target, `${JSON.stringify(value)}\n`, "utf8")
    },
    options,
  )
}

export async function appendJsonlLinesLocked(target: string, lines: string[], options?: JsonlLockOptions) {
  const cleanLines = lines.map((line) => line.trim()).filter(Boolean)
  if (!cleanLines.length) return
  await withJsonlLock(
    target,
    async () => {
      await appendFile(target, `${cleanLines.join("\n")}\n`, "utf8")
    },
    options,
  )
}

export async function readJsonlFile<T>(target: string): Promise<T[]> {
  const raw = await readTextIfExists(target)
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

export async function readJsonlFileLocked<T>(target: string, options?: JsonlLockOptions): Promise<T[]> {
  return withJsonlLock(target, () => readJsonlFile<T>(target), options)
}

export async function appendJsonlIfMissingLocked<T>(
  target: string,
  value: T,
  isDuplicate: (existing: T, next: T) => boolean,
  options?: JsonlLockOptions,
) {
  return withJsonlLock(
    target,
    async () => {
      const existing = await readJsonlFile<T>(target)
      if (existing.some((item) => isDuplicate(item, value))) return false
      await appendFile(target, `${JSON.stringify(value)}\n`, "utf8")
      return true
    },
    options,
  )
}
