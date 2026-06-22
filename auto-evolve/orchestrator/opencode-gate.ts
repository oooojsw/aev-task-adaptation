/**
 * OpenCodeGate - global concurrency controller for OpenCode child process spawns.
 *
 * The gate enforces two limits at the same time:
 *   1. A global cap across every auto-evolve process on this machine.
 *   2. A per-scope cap so one task family cannot monopolize the global pool.
 *
 * The cross-process coordination lives in a small JSON state file protected by
 * a directory lock. That keeps the limits shared even when separate CLI
 * processes are launched at the same time.
 */

import path from "node:path"
import { mkdir, readFile, rm, rename, stat, writeFile } from "node:fs/promises"
import { setTimeout as sleepMs } from "node:timers/promises"
import { randomBytes } from "node:crypto"
import { ensureDirectory, pathExists, runtimePath } from "./fs"
import { readAdaptiveModelRuntime } from "./adaptive-concurrency"

export interface OpenCodeGateConfig {
  /** Maximum number of OpenCode child processes that may run simultaneously. */
  maxConcurrent: number
  /** Maximum number of OpenCode child processes allowed for one scope. */
  perScopeMaxConcurrent: number
  /** Maximum number of callers that may be queued waiting for a permit. */
  maxQueueDepth: number
  /** How long an `acquire()` call will wait before giving up. */
  acquireTimeoutMs: number
  /** Optional minimum delay between consecutive grants. */
  minSpawnIntervalMs?: number
  /** Optional provider/model-specific caps loaded from adaptive concurrency state. */
  modelLimits?: Record<string, { maxConcurrent: number; minSpawnIntervalMs?: number; cooldownUntil?: string }>
}

export interface OpenCodeGateStatus {
  active: number
  waiting: number
  totalAcquired: number
  totalRejected: number
  totalTimedOut: number
  config: OpenCodeGateConfig
}

export class GateBusyError extends Error {
  readonly queueDepth: number
  readonly maxQueueDepth: number
  constructor(queueDepth: number, maxQueueDepth: number) {
    super(`OpenCodeGate queue full (${queueDepth}/${maxQueueDepth})`)
    this.name = "GateBusyError"
    this.queueDepth = queueDepth
    this.maxQueueDepth = maxQueueDepth
  }
}

export class GateTimeoutError extends Error {
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(`OpenCodeGate acquire timed out after ${timeoutMs} ms`)
    this.name = "GateTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

export interface Permit {
  id: string
  caller: string
  acquiredAt: Date
  release(): Promise<void>
}

interface ActiveSlot {
  id: string
  caller: string
  scope: string
  model?: string
  ownerPid: number
  acquiredAt: string
  acquiredAtMs: number
}

interface QueueSlot {
  id: string
  caller: string
  scope: string
  model?: string
  ownerPid: number
  enqueuedAt: string
  enqueuedAtMs: number
}

interface GateState {
  version: number
  updatedAt: string
  active: ActiveSlot[]
  queue: QueueSlot[]
  lastGrantedAtByModel: Record<string, number>
}

const DEFAULT_CONFIG: OpenCodeGateConfig = {
  maxConcurrent: 15,
  perScopeMaxConcurrent: 5,
  maxQueueDepth: 60,
  acquireTimeoutMs: 60 * 60 * 1000,
  minSpawnIntervalMs: 0,
  modelLimits: {},
}

const LOCK_STALE_MS = 30_000
const LOCK_INIT_GRACE_MS = 3_000
const LOCK_POLL_MS = 50
const LOCK_IO_RETRIES = 5
const STATE_VERSION = 1
const STATE_DIR = "opencode-gate"

let _instance: OpenCodeGate | undefined

export class OpenCodeGate {
  private metrics = { totalAcquired: 0, totalRejected: 0, totalTimedOut: 0 }
  private config: OpenCodeGateConfig
  private adaptiveCache = new Map<string, { checkedAt: number; limit?: { maxConcurrent: number; minSpawnIntervalMs?: number; cooldownUntil?: string } }>()

  private constructor(config: OpenCodeGateConfig) {
    this.config = config
  }

  static instance(): OpenCodeGate {
    if (!_instance) _instance = new OpenCodeGate(DEFAULT_CONFIG)
    return _instance
  }

  static configure(config: Partial<OpenCodeGateConfig>): void {
    const merged: OpenCodeGateConfig = { ...DEFAULT_CONFIG, ..._instance?.config, ...config }
    if (!_instance) {
      _instance = new OpenCodeGate(merged)
      return
    }
    _instance.config = merged
  }

  /** Reset the singleton - for tests only. */
  static __resetForTest(): void {
    _instance = undefined
  }

  async acquire(meta: { caller: string; scope: string; root: string; model?: string }): Promise<Permit> {
    const start = Date.now()
    const scope = normalizeScope(meta.scope)
    const model = normalizeModel(meta.model)
    const stateRoot = resolveStateRoot(meta.root)
    const request: QueueSlot = {
      id: randomID(),
      caller: meta.caller,
      scope,
      model,
      ownerPid: process.pid,
      enqueuedAt: new Date().toISOString(),
      enqueuedAtMs: Date.now(),
    }

    while (true) {
      const elapsed = Date.now() - start
      if (elapsed >= this.config.acquireTimeoutMs) {
        this.metrics.totalTimedOut += 1
        throw new GateTimeoutError(this.config.acquireTimeoutMs)
      }

      const adaptiveLimit = model ? await this.readDynamicModelLimit(meta.root, model) : undefined
      const effectiveConfig: OpenCodeGateConfig = adaptiveLimit
        ? { ...this.config, modelLimits: { ...(this.config.modelLimits ?? {}), [model!]: adaptiveLimit } }
        : this.config
      const result = await withGateLock(stateRoot, async () => {
        const state = await readState(stateRoot)
        const cleaned = cleanupState(state, this.config.acquireTimeoutMs)
        const alreadyQueued = cleaned.queue.some((item) => item.id === request.id)
        if (!alreadyQueued && cleaned.queue.length >= this.config.maxQueueDepth) {
          throw new GateBusyError(cleaned.queue.length, this.config.maxQueueDepth)
        }
        const queue = ensureQueued(cleaned.queue, request)
        if (!alreadyQueued && queue.length > this.config.maxQueueDepth) {
          await writeState(stateRoot, {
            version: STATE_VERSION,
            updatedAt: new Date().toISOString(),
            active: cleaned.active,
            queue: queue.filter((item) => item.id !== request.id),
            lastGrantedAtByModel: cleaned.lastGrantedAtByModel,
          })
          throw new GateBusyError(queue.length - 1, this.config.maxQueueDepth)
        }

        const grant = selectGrant(queue, cleaned.active, cleaned.lastGrantedAtByModel, effectiveConfig)
        if (!grant || grant.id !== request.id) {
          await writeState(stateRoot, {
            version: STATE_VERSION,
            updatedAt: new Date().toISOString(),
            active: cleaned.active,
            queue,
            lastGrantedAtByModel: cleaned.lastGrantedAtByModel,
          })
          return { granted: false as const }
        }

        const next: GateState = {
          version: STATE_VERSION,
          updatedAt: new Date().toISOString(),
          active: [
            ...cleaned.active,
            {
              id: request.id,
              caller: request.caller,
              scope: request.scope,
              model: request.model,
              ownerPid: request.ownerPid,
              acquiredAt: new Date().toISOString(),
              acquiredAtMs: Date.now(),
            },
          ],
          queue: queue.filter((item) => item.id !== request.id),
          lastGrantedAtByModel: request.model
            ? { ...cleaned.lastGrantedAtByModel, [request.model]: Date.now() }
            : cleaned.lastGrantedAtByModel,
        }
        await writeState(stateRoot, next)
        return { granted: true as const, id: request.id, caller: request.caller, acquiredAt: new Date() }
      })

      if (result.granted) {
        this.metrics.totalAcquired += 1
        return {
          id: result.id,
          caller: result.caller,
          acquiredAt: result.acquiredAt,
          release: () => {
            void this.release(stateRoot, result.id)
          },
        }
      }

      await sleepMs(waitDelay(this.config.minSpawnIntervalMs, elapsed))
    }
  }

  private async readDynamicModelLimit(root: string, model: string) {
    const cached = this.adaptiveCache.get(model)
    if (cached && Date.now() - cached.checkedAt < 1000) return cached.limit
    const runtime = await readAdaptiveModelRuntime(root, model).catch(() => undefined)
    const limit = runtime
      ? {
          maxConcurrent: runtime.safeOpenCodeConcurrency,
          minSpawnIntervalMs: runtime.safeRequestSpacingMs,
          cooldownUntil: runtime.cooldownUntil ?? undefined,
        }
      : this.config.modelLimits?.[model]
    this.adaptiveCache.set(model, { checkedAt: Date.now(), limit })
    return limit
  }

  async run<T>(meta: { caller: string; scope: string; root: string; model?: string }, fn: () => Promise<T>): Promise<T> {
    const permit = await this.acquire(meta)
    try {
      return await fn()
    } finally {
      await permit.release()
    }
  }

  getStatus(): OpenCodeGateStatus {
    return {
      active: 0,
      waiting: 0,
      totalAcquired: this.metrics.totalAcquired,
      totalRejected: this.metrics.totalRejected,
      totalTimedOut: this.metrics.totalTimedOut,
      config: { ...this.config },
    }
  }

  private async release(stateRoot: string, id: string) {
    await withGateLock(stateRoot, async () => {
      const state = await readState(stateRoot)
      const next: GateState = {
        version: STATE_VERSION,
        updatedAt: new Date().toISOString(),
        active: state.active.filter((item) => item.id !== id),
        queue: state.queue,
        lastGrantedAtByModel: state.lastGrantedAtByModel,
      }
      await writeState(stateRoot, next)
    })
  }
}

function resolveStateRoot(root: string) {
  const cwd = path.resolve(root)
  const stateRoot = runtimePath(cwd, STATE_DIR)
  const base = path.parse(stateRoot).root
  const normalized = path.normalize(stateRoot)
  if (!normalized || normalized === "." || normalized === path.sep || normalized === base) {
    throw new Error(`OpenCodeGate resolved invalid state root: ${stateRoot}`)
  }
  return stateRoot
}

function normalizeScope(scope: string) {
  return scope.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "default"
}

function normalizeModel(model: string | undefined) {
  const value = model?.trim().toLowerCase()
  return value || undefined
}

function waitDelay(minSpawnIntervalMs: number | undefined, elapsed: number) {
  if (!minSpawnIntervalMs) return LOCK_POLL_MS
  if (elapsed < minSpawnIntervalMs) return Math.max(LOCK_POLL_MS, minSpawnIntervalMs - elapsed)
  return LOCK_POLL_MS
}

function selectGrant(
  queue: QueueSlot[],
  active: ActiveSlot[],
  lastGrantedAtByModel: Record<string, number>,
  config: OpenCodeGateConfig,
) {
  const activeByScope = countByScope(active)
  const activeByModel = countByModel(active)
  const activeTotal = active.length
  if (activeTotal >= config.maxConcurrent) return undefined
  for (const item of queue) {
    const scopeCount = activeByScope.get(item.scope) ?? 0
    if (scopeCount >= config.perScopeMaxConcurrent) continue
    if (item.model) {
      const modelLimit = config.modelLimits?.[item.model]
      if (modelLimit) {
        if (modelLimit.cooldownUntil && Date.parse(modelLimit.cooldownUntil) > Date.now()) continue
        const modelCount = activeByModel.get(item.model) ?? 0
        if (modelCount >= modelLimit.maxConcurrent) continue
        const lastGrant = lastGrantedAtByModel[item.model] ?? 0
        if (modelLimit.minSpawnIntervalMs && Date.now() - lastGrant < modelLimit.minSpawnIntervalMs) continue
      }
    }
    return item
  }
  return undefined
}

function countByModel(active: ActiveSlot[]) {
  const map = new Map<string, number>()
  for (const item of active) {
    if (!item.model) continue
    map.set(item.model, (map.get(item.model) ?? 0) + 1)
  }
  return map
}

function countByScope(active: ActiveSlot[]) {
  const map = new Map<string, number>()
  for (const item of active) {
    map.set(item.scope, (map.get(item.scope) ?? 0) + 1)
  }
  return map
}

function ensureQueued(queue: QueueSlot[], request: QueueSlot) {
  if (queue.some((item) => item.id === request.id)) return queue
  return [...queue, request]
}

function cleanupState(state: GateState, acquireTimeoutMs: number) {
  const now = Date.now()
  return {
    active: state.active.filter((item) => isAlive(item.ownerPid) && now - item.acquiredAtMs < acquireTimeoutMs * 2),
    queue: state.queue.filter((item) => isAlive(item.ownerPid) && now - item.enqueuedAtMs < acquireTimeoutMs),
    lastGrantedAtByModel: state.lastGrantedAtByModel,
  }
}

function isAlive(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readState(stateRoot: string): Promise<GateState> {
  const target = path.join(stateRoot, "state.json")
  if (!(await pathExists(target))) {
    return { version: STATE_VERSION, updatedAt: new Date().toISOString(), active: [], queue: [], lastGrantedAtByModel: {} }
  }
  try {
    const raw = JSON.parse(await readFile(target, "utf8")) as Partial<GateState>
    return {
      version: typeof raw.version === "number" ? raw.version : STATE_VERSION,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
      active: Array.isArray(raw.active) ? raw.active.filter(isActiveSlot) : [],
      queue: Array.isArray(raw.queue) ? raw.queue.filter(isQueueSlot) : [],
      lastGrantedAtByModel:
        raw.lastGrantedAtByModel && typeof raw.lastGrantedAtByModel === "object"
          ? (raw.lastGrantedAtByModel as Record<string, number>)
          : {},
    }
  } catch {
    return { version: STATE_VERSION, updatedAt: new Date().toISOString(), active: [], queue: [], lastGrantedAtByModel: {} }
  }
}

async function writeState(stateRoot: string, state: GateState) {
  await ensureDirectory(stateRoot)
  const target = path.join(stateRoot, "state.json")
  const tmp = `${target}.tmp-${process.pid}-${randomID()}`
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8")
  await rm(target, { force: true }).catch(() => undefined)
  await rename(tmp, target)
}

function isActiveSlot(input: unknown): input is ActiveSlot {
  return !!input && typeof input === "object" && typeof (input as ActiveSlot).id === "string"
}

function isQueueSlot(input: unknown): input is QueueSlot {
  return !!input && typeof input === "object" && typeof (input as QueueSlot).id === "string"
}

async function withGateLock<T>(stateRoot: string, fn: () => Promise<T>): Promise<T> {
  const normalized = path.normalize(stateRoot)
  const base = path.parse(normalized).root
  if (!normalized || normalized === "." || normalized === path.sep || normalized === base) {
    throw new Error(`OpenCodeGate lock root rejected: ${stateRoot}`)
  }
  const lockRoot = path.join(stateRoot, "lock")
  const owner = path.join(lockRoot, "owner.json")
  const token = randomID()
  const parent = path.dirname(lockRoot)
  const root = path.parse(parent).root
  if (!parent || parent === "." || parent === path.sep || parent === root) {
    throw new Error(`OpenCodeGate lock parent rejected: ${parent}`)
  }
  await ensureDirectory(parent)
  while (true) {
    try {
      await mkdir(lockRoot)
      await writeOwner(owner, token)
      break
    } catch {
      const exists = await pathExists(lockRoot)
      if (!exists) continue
      const stale = await isStaleLock(lockRoot, owner)
      if (stale) {
        await quarantineLock(lockRoot)
        continue
      }
      await sleepMs(LOCK_POLL_MS)
    }
  }

  try {
    return await fn()
  } finally {
    if (await isOwnedBySelf(owner, token)) {
      if (!(await quarantineLock(lockRoot))) {
        await rm(lockRoot, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }
}

async function isStaleLock(lockRoot: string, owner: string) {
  if (!(await pathExists(owner))) return await isExpiredWithoutOwner(lockRoot)
  try {
    const raw = await readOwnerWithRetry(owner)
    if (!raw) return await isExpiredWithoutOwner(lockRoot)
    if (typeof raw.pid === "number" && !isAlive(raw.pid)) return true
    if (typeof raw.at === "string") {
      const time = Date.parse(raw.at)
      if (Number.isFinite(time) && Date.now() - time > LOCK_STALE_MS) return true
    }
  } catch {
    return await isExpiredWithoutOwner(lockRoot)
  }
  return false
}

async function isOwnedBySelf(owner: string, token: string) {
  if (!(await pathExists(owner))) return false
  try {
    const raw = await readOwnerWithRetry(owner)
    if (!raw) return false
    return raw.pid === process.pid && raw.token === token
  } catch {
    return false
  }
}

async function writeOwner(owner: string, token: string) {
  const tmp = `${owner}.tmp-${process.pid}-${randomID()}`
  const body = JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() })
  await writeFile(tmp, body, "utf8")
  try {
    await renameWithRetry(tmp, owner)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function isExpiredWithoutOwner(lockRoot: string) {
  const info = await stat(lockRoot).catch(() => undefined)
  if (!info) return true
  const t = Math.max(info.ctimeMs, info.mtimeMs)
  return Date.now() - t >= LOCK_INIT_GRACE_MS
}

function randomID(): string {
  return `gate-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`
}

async function readOwnerWithRetry(owner: string) {
  for (let attempt = 1; attempt <= LOCK_IO_RETRIES; attempt += 1) {
    try {
      const raw = JSON.parse(await readFile(owner, "utf8")) as { pid?: unknown; token?: unknown; at?: unknown }
      return raw
    } catch (error) {
      if (attempt >= LOCK_IO_RETRIES || !isLockIoError(error)) return undefined
      await sleepMs(lockIoDelay(attempt))
    }
  }
  return undefined
}

async function renameWithRetry(from: string, to: string) {
  for (let attempt = 1; attempt <= LOCK_IO_RETRIES; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (attempt >= LOCK_IO_RETRIES || !isLockIoError(error)) throw error
      await sleepMs(lockIoDelay(attempt))
    }
  }
}

async function quarantineLock(lockRoot: string) {
  const trash = `${lockRoot}.trash-${randomID()}`
  try {
    await renameWithRetry(lockRoot, trash)
    await rm(trash, { recursive: true, force: true }).catch(() => undefined)
    return true
  } catch {
    return false
  }
}

function isLockIoError(error: unknown) {
  if (!error || typeof error !== "object") return false
  const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : ""
  return code === "EPERM" || code === "EACCES" || code === "EBUSY"
}

function lockIoDelay(attempt: number) {
  return 10 * 2 ** (attempt - 1) + Math.floor(Math.random() * 15)
}
