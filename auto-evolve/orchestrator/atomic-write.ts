import path from "node:path"
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"

export interface AtomicWriteOptions {
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  encoding?: BufferEncoding
}

function isLockLikeError(error: unknown) {
  if (!error || typeof error !== "object") return false
  const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : ""
  if (code === "EPERM" || code === "EACCES" || code === "EBUSY") return true
  const msg = error instanceof Error ? error.message : String(error)
  return /EPERM|EACCES|EBUSY|resource busy|operation not permitted|sharing violation|locked/i.test(msg)
}

function backoff(attempt: number, options: Required<Pick<AtomicWriteOptions, "baseDelayMs" | "maxDelayMs">>) {
  const raw = options.baseDelayMs * 2 ** Math.max(0, attempt - 1)
  return Math.min(options.maxDelayMs, raw) + Math.floor(Math.random() * Math.min(50, options.baseDelayMs))
}

function tmpPathFor(target: string) {
  const dir = path.dirname(target)
  const base = path.basename(target)
  return path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`)
}

export async function writeFileAtomic(target: string, content: string | Buffer, options: AtomicWriteOptions = {}) {
  const attempts = options.attempts ?? 6
  const retryOptions = {
    baseDelayMs: options.baseDelayMs ?? 50,
    maxDelayMs: options.maxDelayMs ?? 1000,
  }
  const encoding = options.encoding ?? "utf8"
  await mkdir(path.dirname(target), { recursive: true })

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const tmp = tmpPathFor(target)
    try {
      if (Buffer.isBuffer(content)) {
        await writeFile(tmp, content)
      } else {
        await writeFile(tmp, content, encoding)
      }
      await rename(tmp, target)
      return
    } catch (error) {
      lastError = error
      await rm(tmp, { force: true }).catch(() => undefined)
      if (!isLockLikeError(error) || attempt >= attempts) break
      await sleep(backoff(attempt, retryOptions))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export async function writeJsonAtomic(target: string, value: unknown, options: AtomicWriteOptions = {}) {
  await writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`, options)
}

export async function cleanupAtomicWriteTemps(dir: string, basename: string, olderThanMs = 60 * 60 * 1000) {
  const now = Date.now()
  const prefix = `.${basename}.tmp-`
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue
    const full = path.join(dir, entry.name)
    const match = entry.name.match(/\.tmp-\d+-(\d+)-/)
    const createdAt = match ? Number(match[1]) : 0
    if (Number.isFinite(createdAt) && createdAt > 0 && now - createdAt < olderThanMs) continue
    await rm(full, { force: true }).then(() => {
      removed += 1
    }).catch(() => undefined)
  }
  return removed
}
