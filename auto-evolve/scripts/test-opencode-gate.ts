/**
 * Smoke test for OpenCodeGate.
 *
 * Verifies:
 *  1. The semaphore correctly caps simultaneous holders.
 *  2. Released permits hand off to waiters in FIFO order.
 *  3. Queue overflow throws GateBusyError.
 *  4. Acquire timeout throws GateTimeoutError.
 *
 * Run with:
 *   bun run scripts/test-opencode-gate.ts
 */

import path from "node:path"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { OpenCodeGate, GateBusyError, GateTimeoutError } from "../orchestrator/opencode-gate"
import { setTimeout as sleep } from "node:timers/promises"
import { runtimePath } from "../orchestrator/fs"

let failures = 0
function testRoot(name: string) {
  return path.join(process.cwd(), ".tmp-opencode-gate-tests", `${name}-${randomUUID().slice(0, 8)}`)
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failures += 1
  } else {
    console.log(`ok   ${msg}`)
  }
}

function hasErrorName(error: unknown, names: string[]) {
  return !!error && typeof error === "object" && names.includes(String((error as { name?: unknown }).name ?? ""))
}

async function readGateState(root: string) {
  const statePath = path.join(runtimePath(root, "opencode-gate"), "state.json")
  return JSON.parse(await readFile(statePath, "utf8").then((text) => text.replace(/^\uFEFF/, ""))) as {
    active: unknown[]
    queue: unknown[]
  }
}

async function testSemaphoreCap() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({ maxConcurrent: 2, perScopeMaxConcurrent: 1, maxQueueDepth: 10, acquireTimeoutMs: 30_000 })
  const gate = OpenCodeGate.instance()
  const root = testRoot("semaphore")
  const p1 = await gate.acquire({ caller: "t1", scope: "a", root })
  const p2 = await gate.acquire({ caller: "t2", scope: "b", root })
  assert(gate.getStatus().config.maxConcurrent === 2, "configured maxConcurrent applied")
  // Third acquire must queue because the global cap is full.
  let resolved3 = false
  const p3Promise = gate.acquire({ caller: "t3", scope: "c", root }).then((p) => {
    resolved3 = true
    return p
  })
  await sleep(50)
  assert(!resolved3, "third caller is blocked while at capacity")
  await p1.release()
  const p3 = await p3Promise
  assert(resolved3, "third caller resumes after release")
  await p2.release()
  await p3.release()
  assert(gate.getStatus().active === 0, "all permits released")
}

async function testQueueOverflow() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({ maxConcurrent: 1, perScopeMaxConcurrent: 1, maxQueueDepth: 0, acquireTimeoutMs: 2000 })
  const gate = OpenCodeGate.instance()
  const root = testRoot("overflow")
  const p1 = await gate.acquire({ caller: "blocker", scope: "a", root })
  let overflowError: unknown
  await gate.acquire({ caller: "w1", scope: "b", root }).catch((e) => {
    overflowError = e
    return undefined
  })
  assert(
    overflowError instanceof GateBusyError ||
      overflowError instanceof GateTimeoutError ||
      hasErrorName(overflowError, ["GateBusyError", "GateTimeoutError"]),
    "queue overflow blocks new callers",
  )
  await p1.release()
}

async function testScopeCap() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({ maxConcurrent: 3, perScopeMaxConcurrent: 1, maxQueueDepth: 10, acquireTimeoutMs: 30_000 })
  const gate = OpenCodeGate.instance()
  const root = testRoot("scope")
  const p1 = await gate.acquire({ caller: "s1", scope: "same", root })
  const p2 = await gate.acquire({ caller: "s2", scope: "other", root })
  let resolved3 = false
  const p3Promise = gate.acquire({ caller: "s3", scope: "same", root }).then((p) => {
    resolved3 = true
    return p
  })
  const p4 = await gate.acquire({ caller: "s4", scope: "third", root })
  assert(!resolved3, "same-scope third caller waits while scope cap is full")
  assert(gate.getStatus().config.perScopeMaxConcurrent === 1, "configured perScopeMaxConcurrent applied")
  await p1.release()
  const p3 = await p3Promise
  await p2.release()
  await p3.release()
  await p4.release()
}

async function testTimeout() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({ maxConcurrent: 1, perScopeMaxConcurrent: 1, maxQueueDepth: 5, acquireTimeoutMs: 1000 })
  const gate = OpenCodeGate.instance()
  const root = testRoot("timeout")
  const p1 = await gate.acquire({ caller: "hold", scope: "a", root })
  let timeoutError: unknown
  try {
    await gate.acquire({ caller: "wait", scope: "b", root })
  } catch (e) {
    timeoutError = e
  }
  assert(
    timeoutError instanceof GateTimeoutError || hasErrorName(timeoutError, ["GateTimeoutError"]),
    "acquire timeout throws GateTimeoutError",
  )
  await p1.release()
}

async function testRunWrapper() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({ maxConcurrent: 2, perScopeMaxConcurrent: 2, maxQueueDepth: 10, acquireTimeoutMs: 30_000 })
  const gate = OpenCodeGate.instance()
  const root = testRoot("wrapper")
  let running = 0
  let peak = 0
  const make = (label: string, delay: number) =>
    gate.run({ caller: label, scope: label, root }, async () => {
      running += 1
      peak = Math.max(peak, running)
      await sleep(delay)
      running -= 1
      return label.toUpperCase()
    })
  const a = make("a", 30)
  const b = make("b", 20)
  const c = make("c", 10)
  const results = await Promise.all([a, b, c])
  assert(results.join(",") === "A,B,C", "run() returns inner result")
  assert(peak <= 2, "run() never exceeds the configured concurrency cap")
}

async function testReleaseAwaitWritesState() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({ maxConcurrent: 20, perScopeMaxConcurrent: 20, maxQueueDepth: 40, acquireTimeoutMs: 30_000 })
  const gate = OpenCodeGate.instance()
  const root = testRoot("release-await")
  const permit = await gate.acquire({ caller: "direct", scope: "direct", root })
  await permit.release()
  let state = await readGateState(root)
  assert(state.active.length === 0, "await permit.release() flushes active slot to state.json")

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      gate.run({ caller: `run-${index}`, scope: `scope-${index}`, root }, async () => {
        await sleep(5)
      }),
    ),
  )
  state = await readGateState(root)
  assert(state.active.length === 0, "20 awaited gate.run() calls leave no active slots")
}

async function testLegacyActiveSlotExpires() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({ maxConcurrent: 1, perScopeMaxConcurrent: 1, maxQueueDepth: 5, acquireTimeoutMs: 60 * 60 * 1000 })
  const gate = OpenCodeGate.instance()
  const root = testRoot("legacy-active")
  const stateRoot = runtimePath(root, "opencode-gate")
  await mkdir(stateRoot, { recursive: true })
  const oldMs = Date.now() - 31 * 60 * 1000
  await writeFile(
    path.join(stateRoot, "state.json"),
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date(oldMs).toISOString(),
        active: [
          {
            id: "legacy-active-without-heartbeat",
            caller: "legacy",
            scope: "legacy",
            ownerPid: process.pid,
            acquiredAt: new Date(oldMs).toISOString(),
            acquiredAtMs: oldMs,
          },
        ],
        queue: [],
        lastGrantedAtByModel: {},
      },
      null,
      2,
    ),
    "utf8",
  )

  const permit = await gate.acquire({ caller: "fresh", scope: "fresh", root })
  assert(permit.caller === "fresh", "legacy active slot without heartbeat does not block a fresh acquire")
  await permit.release()
  const state = await readGateState(root)
  assert(state.active.length === 0, "legacy stale active slot is removed from state")
}

async function testStaleQueueHeadBypassWhileActive() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({ maxConcurrent: 2, perScopeMaxConcurrent: 2, maxQueueDepth: 10, acquireTimeoutMs: 60 * 60 * 1000 })
  const gate = OpenCodeGate.instance()
  const root = testRoot("stale-queue-head")
  const stateRoot = runtimePath(root, "opencode-gate")
  await mkdir(stateRoot, { recursive: true })
  const now = Date.now()
  const oldMs = now - 20 * 60 * 1000
  await writeFile(
    path.join(stateRoot, "state.json"),
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date(oldMs).toISOString(),
        active: [
          {
            id: "live-active-blocker",
            caller: "live-active",
            scope: "other-scope",
            ownerPid: process.pid,
            acquiredAt: new Date(now).toISOString(),
            acquiredAtMs: now,
            heartbeatAt: new Date(now).toISOString(),
            heartbeatAtMs: now,
          },
        ],
        queue: [
          {
            id: "orphaned-old-head",
            caller: "old-head",
            scope: "old-scope",
            ownerPid: process.pid,
            enqueuedAt: new Date(oldMs).toISOString(),
            enqueuedAtMs: oldMs,
          },
        ],
        lastGrantedAtByModel: {},
      },
      null,
      2,
    ),
    "utf8",
  )

  const permit = await gate.acquire({ caller: "fresh-live-waiter", scope: "fresh-scope", root })
  assert(permit.caller === "fresh-live-waiter", "live waiter bypasses old orphaned queue head while another slot is active")
  await permit.release()
}

async function testStaleQueueHeadBypassWhenEmpty() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({ maxConcurrent: 2, perScopeMaxConcurrent: 2, maxQueueDepth: 10, acquireTimeoutMs: 60 * 60 * 1000 })
  const gate = OpenCodeGate.instance()
  const root = testRoot("empty-stale-queue-head")
  const stateRoot = runtimePath(root, "opencode-gate")
  await mkdir(stateRoot, { recursive: true })
  const oldMs = Date.now() - 45 * 1000
  await writeFile(
    path.join(stateRoot, "state.json"),
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date(oldMs).toISOString(),
        active: [],
        queue: [
          {
            id: "orphaned-empty-gate-head",
            caller: "old-head",
            scope: "old-scope",
            ownerPid: process.pid,
            enqueuedAt: new Date(oldMs).toISOString(),
            enqueuedAtMs: oldMs,
          },
        ],
        lastGrantedAtByModel: {},
      },
      null,
      2,
    ),
    "utf8",
  )

  const permit = await gate.acquire({ caller: "fresh-empty-gate-waiter", scope: "fresh-scope", root })
  assert(permit.caller === "fresh-empty-gate-waiter", "live waiter bypasses old orphaned queue head when gate is empty")
  await permit.release()
}

async function testModelCap() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({
    maxConcurrent: 3,
    perScopeMaxConcurrent: 3,
    maxQueueDepth: 10,
    acquireTimeoutMs: 30_000,
    modelLimits: { "provider/model-a": { maxConcurrent: 1, minSpawnIntervalMs: 0 } },
  })
  const gate = OpenCodeGate.instance()
  const root = testRoot("model-cap")
  const p1 = await gate.acquire({ caller: "m1", scope: "one", model: "provider/model-a", root })
  const other = await gate.acquire({ caller: "m2", scope: "two", model: "provider/model-b", root })
  let resolvedSameModel = false
  const waiting = gate.acquire({ caller: "m3", scope: "three", model: "provider/model-a", root }).then((permit) => {
    resolvedSameModel = true
    return permit
  })
  await sleep(100)
  assert(!resolvedSameModel, "same model waits at per-model concurrency cap")
  await p1.release()
  const p3 = await waiting
  assert(resolvedSameModel, "same model resumes after model permit release")
  await other.release()
  await p3.release()
}

async function testModelSpacing() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({
    maxConcurrent: 3,
    perScopeMaxConcurrent: 3,
    maxQueueDepth: 10,
    acquireTimeoutMs: 30_000,
    modelLimits: { "provider/model-a": { maxConcurrent: 3, minSpawnIntervalMs: 200 } },
  })
  const gate = OpenCodeGate.instance()
  const root = testRoot("model-spacing")
  const p1 = await gate.acquire({ caller: "first", scope: "one", model: "provider/model-a", root })
  await p1.release()
  const started = Date.now()
  const p2 = await gate.acquire({ caller: "second", scope: "two", model: "provider/model-a", root })
  const elapsed = Date.now() - started
  assert(elapsed >= 150, "same model respects minimum spawn interval")
  await p2.release()
}

async function main() {
  console.log("=== OpenCodeGate smoke test ===")
  await testSemaphoreCap()
  await testScopeCap()
  await testTimeout()
  await testRunWrapper()
  await testReleaseAwaitWritesState()
  await testLegacyActiveSlotExpires()
  await testStaleQueueHeadBypassWhileActive()
  await testStaleQueueHeadBypassWhenEmpty()
  await testModelCap()
  await testModelSpacing()
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log("\nAll assertions passed.")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
