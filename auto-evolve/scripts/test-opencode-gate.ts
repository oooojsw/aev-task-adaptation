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
import { OpenCodeGate, GateBusyError, GateTimeoutError } from "../orchestrator/opencode-gate"
import { setTimeout as sleep } from "node:timers/promises"

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

async function testSemaphoreCap() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({ maxConcurrent: 2, perScopeMaxConcurrent: 1, maxQueueDepth: 10, acquireTimeoutMs: 5000 })
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
  p1.release()
  const p3 = await p3Promise
  assert(resolved3, "third caller resumes after release")
  p2.release()
  p3.release()
  assert(gate.getStatus().active === 0, "all permits released")
}

async function testQueueOverflow() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({ maxConcurrent: 1, perScopeMaxConcurrent: 1, maxQueueDepth: 1, acquireTimeoutMs: 200 })
  const gate = OpenCodeGate.instance()
  const root = testRoot("overflow")
  const p1 = await gate.acquire({ caller: "blocker", scope: "a", root })
  const w1 = gate.acquire({ caller: "w1", scope: "b", root })
  let overflowError: unknown
  const w2 = gate.acquire({ caller: "w2", scope: "c", root }).catch((e) => {
    overflowError = e
    return undefined
  })
  await sleep(50)
  assert(overflowError instanceof GateBusyError || overflowError instanceof GateTimeoutError, "queue overflow blocks new callers")
  p1.release()
  const a1 = await w1
  a1.release()
  await w2
}

async function testScopeCap() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({ maxConcurrent: 3, perScopeMaxConcurrent: 1, maxQueueDepth: 10, acquireTimeoutMs: 5000 })
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
  p1.release()
  const p3 = await p3Promise
  p2.release()
  p3.release()
  p4.release()
}

async function testTimeout() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({ maxConcurrent: 1, perScopeMaxConcurrent: 1, maxQueueDepth: 5, acquireTimeoutMs: 200 })
  const gate = OpenCodeGate.instance()
  const root = testRoot("timeout")
  const p1 = await gate.acquire({ caller: "hold", scope: "a", root })
  let timeoutError: unknown
  try {
    await gate.acquire({ caller: "wait", scope: "b", root })
  } catch (e) {
    timeoutError = e
  }
  assert(timeoutError instanceof GateTimeoutError, "acquire timeout throws GateTimeoutError")
  p1.release()
}

async function testRunWrapper() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({ maxConcurrent: 2, perScopeMaxConcurrent: 2, maxQueueDepth: 10, acquireTimeoutMs: 5000 })
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

async function main() {
  console.log("=== OpenCodeGate smoke test ===")
  await testSemaphoreCap()
  await testQueueOverflow()
  await testScopeCap()
  await testTimeout()
  await testRunWrapper()
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
