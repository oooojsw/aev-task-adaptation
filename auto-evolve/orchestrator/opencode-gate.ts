/**
 * OpenCodeGate — global concurrency controller for OpenCode child process spawns.
 *
 * Why this exists
 * ----------------
 * Every auto-evolve workflow eventually shells out to OpenCode through
 * `runOpencodeTask`. Without coordination, parallel campaigns (multi-instance
 * fan-out, batch maintainers, etc.) can fire dozens of OpenCode children
 * simultaneously. That blows past the upstream API's concurrency budget and
 * triggers 429s, retries, and ultimately wasted credits.
 *
 * The gate enforces two independent limits on every `runOpencodeTask` call:
 *   1. A semaphore: only `maxConcurrent` children may be running at once.
 *   2. An optional spawn throttle: at least `minSpawnIntervalMs` between
 *      consecutive grants, so we don't burst-launch many children inside a
 *      single tick.
 *
 * Both must clear before `acquire()` resolves. Callers receive a `Permit` and
 * are responsible for calling `release()` when their OpenCode child has exited.
 *
 * The gate is a process-level singleton because all auto-evolve work shares
 * the same upstream API quota. Use `OpenCodeGate.configure()` once at startup
 * (see `loadConfig` integration in schema.ts) to apply user-configured limits.
 */

import { setTimeout as sleepMs } from "node:timers/promises"
import { randomBytes } from "node:crypto"

export interface OpenCodeGateConfig {
  /** Maximum number of OpenCode child processes that may run simultaneously. */
  maxConcurrent: number
  /** Maximum number of callers that may be queued waiting for a permit. */
  maxQueueDepth: number
  /** How long an `acquire()` call will wait before giving up. */
  acquireTimeoutMs: number
  /**
   * Minimum delay between two successive permit grants. Helps avoid bursting
   * many OpenCode child spawns in the same tick (e.g. when a fan-out kicks
   * off N campaigns at once and they all race past the semaphore).
   */
  minSpawnIntervalMs?: number
}

export interface OpenCodeGateStatus {
  active: number
  waiting: number
  totalAcquired: number
  totalRejected: number
  totalTimedOut: number
  config: OpenCodeGateConfig
  activeCallers: Array<{ caller: string; acquiredAt: string; elapsedMs: number }>
  waitingCallers: Array<{ caller: string; enqueuedAt: string; elapsedMs: number }>
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
  release(): void
}

interface ActiveSlot {
  caller: string
  acquiredAt: Date
}

interface WaitingItem {
  id: string
  caller: string
  enqueuedAt: Date
  resolve(permit: Permit): void
  reject(err: Error): void
  timeoutHandle: ReturnType<typeof setTimeout>
}

const DEFAULT_CONFIG: OpenCodeGateConfig = {
  maxConcurrent: 3,
  maxQueueDepth: 30,
  acquireTimeoutMs: 60 * 60 * 1000, // 1 hour
  minSpawnIntervalMs: 0,
}

let _instance: OpenCodeGate | undefined

export class OpenCodeGate {
  private active = new Map<string, ActiveSlot>()
  private waiting: WaitingItem[] = []
  private lastSpawnAt = 0
  private metrics = { totalAcquired: 0, totalRejected: 0, totalTimedOut: 0 }
  private config: OpenCodeGateConfig

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
    } else {
      _instance.config = merged
      // Wake the queue in case maxConcurrent grew.
      _instance.processQueue()
    }
  }

  /** Reset the singleton — for tests only. */
  static __resetForTest(): void {
    _instance = undefined
  }

  async acquire(meta: { caller: string }): Promise<Permit> {
    if (this.active.size < this.config.maxConcurrent) {
      // Synchronously claim the slot before any await. If we awaited the
      // spawn throttle here, multiple callers racing through `acquire()` in
      // the same tick would all observe `active.size < max` and over-commit.
      // By inserting into `active` first and only then awaiting the throttle
      // delay, we keep the semaphore correct.
      const slotId = this.reserveSlotSync(meta.caller)
      await this.respectSpawnThrottle()
      this.lastSpawnAt = Date.now()
      return this.permitFor(slotId)
    }
    if (this.waiting.length >= this.config.maxQueueDepth) {
      this.metrics.totalRejected += 1
      throw new GateBusyError(this.waiting.length, this.config.maxQueueDepth)
    }
    const id = randomID()
    return new Promise<Permit>((resolve, reject) => {
      const item: WaitingItem = {
        id,
        caller: meta.caller,
        enqueuedAt: new Date(),
        resolve,
        reject,
        timeoutHandle: setTimeout(() => {
          this.removeFromQueue(id)
          this.metrics.totalTimedOut += 1
          reject(new GateTimeoutError(this.config.acquireTimeoutMs))
        }, this.config.acquireTimeoutMs),
      }
      this.waiting.push(item)
    })
  }

  /**
   * Convenience wrapper: acquire a permit, run `fn`, release on exit.
   * Use this for nice scoped semantics.
   */
  async run<T>(meta: { caller: string }, fn: () => Promise<T>): Promise<T> {
    const permit = await this.acquire(meta)
    try {
      return await fn()
    } finally {
      permit.release()
    }
  }

  getStatus(): OpenCodeGateStatus {
    const now = Date.now()
    return {
      active: this.active.size,
      waiting: this.waiting.length,
      totalAcquired: this.metrics.totalAcquired,
      totalRejected: this.metrics.totalRejected,
      totalTimedOut: this.metrics.totalTimedOut,
      config: { ...this.config },
      activeCallers: Array.from(this.active.entries()).map(([, slot]) => ({
        caller: slot.caller,
        acquiredAt: slot.acquiredAt.toISOString(),
        elapsedMs: now - slot.acquiredAt.getTime(),
      })),
      waitingCallers: this.waiting.map((w) => ({
        caller: w.caller,
        enqueuedAt: w.enqueuedAt.toISOString(),
        elapsedMs: now - w.enqueuedAt.getTime(),
      })),
    }
  }

  private async respectSpawnThrottle() {
    if (!this.config.minSpawnIntervalMs) return
    const elapsed = Date.now() - this.lastSpawnAt
    if (elapsed < this.config.minSpawnIntervalMs) {
      await sleepMs(this.config.minSpawnIntervalMs - elapsed)
    }
  }

  private reserveSlotSync(caller: string): string {
    const id = randomID()
    this.active.set(id, { caller, acquiredAt: new Date() })
    this.metrics.totalAcquired += 1
    return id
  }

  private permitFor(slotId: string): Permit {
    const slot = this.active.get(slotId)!
    let released = false
    return {
      id: slotId,
      caller: slot.caller,
      acquiredAt: slot.acquiredAt,
      release: () => {
        if (released) return
        released = true
        this.active.delete(slotId)
        this.processQueue()
      },
    }
  }

  private grant(caller: string): Permit {
    // Used by the queue-drain path where we already know throttle is fine
    // (the inter-grant gap is naturally introduced by upstream callers
    // releasing). Equivalent to reserveSlotSync + permitFor.
    const id = this.reserveSlotSync(caller)
    this.lastSpawnAt = Date.now()
    return this.permitFor(id)
  }

  private processQueue() {
    while (this.active.size < this.config.maxConcurrent && this.waiting.length > 0) {
      const item = this.waiting.shift()!
      clearTimeout(item.timeoutHandle)
      // Spawn throttle is best-effort here — the queue drains quickly when a
      // permit is released, and inserting a real sleep would block other
      // releases. Callers can still see throttling on the next entry path.
      const permit = this.grant(item.caller)
      item.resolve(permit)
    }
  }

  private removeFromQueue(id: string) {
    const idx = this.waiting.findIndex((w) => w.id === id)
    if (idx >= 0) {
      const [item] = this.waiting.splice(idx, 1)
      clearTimeout(item.timeoutHandle)
    }
  }
}

function randomID(): string {
  return `gate-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`
}
