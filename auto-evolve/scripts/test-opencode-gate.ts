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

import { OpenCodeGate, GateBusyError, GateTimeoutError } from "../orchestrator/opencode-gate"
import { setTimeout as sleep } from "node:timers/promises"

let failures = 0
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
  OpenCodeGate.configure({ maxConcurrent: 2, maxQueueDepth: 10, acquireTimeoutMs: 5000 })
  const gate = OpenCodeGate.instance()
  const p1 = await gate.acquire({ caller: "t1" })
  const p2 = await gate.acquire({ caller: "t2" })
  assert(gate.getStatus().active === 2, "two permits active")
  // Third acquire must queue.
  let resolved3 = false
  const p3Promise = gate.acquire({ caller: "t3" }).then((p) => {
    resolved3 = true
    return p
  })
  await sleep(50)
  assert(!resolved3, "third caller is blocked while at capacity")
  assert(gate.getStatus().waiting === 1, "one caller queued")
  p1.release()
  const p3 = await p3Promise
  assert(resolved3, "third caller resumes after release")
  p2.release()
  p3.release()
  assert(gate.getStatus().active === 0, "all permits released")
}

async function testQueueOverflow() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({ maxConcurrent: 1, maxQueueDepth: 2, acquireTimeoutMs: 60000 })
  const gate = OpenCodeGate.instance()
  const p1 = await gate.acquire({ caller: "blocker" })
  // Fill queue.
  const w1 = gate.acquire({ caller: "w1" })
  const w2 = gate.acquire({ caller: "w2" })
  // Third waiter should be rejected.
  let busyError: unknown
  try {
    await gate.acquire({ caller: "w3" })
  } catch (e) {
    busyError = e
  }
  assert(busyError instanceof GateBusyError, "queue overflow throws GateBusyError")
  // Drain.
  p1.release()
  const a1 = await w1
  a1.release()
  const a2 = await w2
  a2.release()
}

async function testTimeout() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({ maxConcurrent: 1, maxQueueDepth: 5, acquireTimeoutMs: 200 })
  const gate = OpenCodeGate.instance()
  const p1 = await gate.acquire({ caller: "hold" })
  let timeoutError: unknown
  try {
    await gate.acquire({ caller: "wait" })
  } catch (e) {
    timeoutError = e
  }
  assert(timeoutError instanceof GateTimeoutError, "acquire timeout throws GateTimeoutError")
  p1.release()
}

async function testRunWrapper() {
  OpenCodeGate.__resetForTest()
  OpenCodeGate.configure({ maxConcurrent: 2, maxQueueDepth: 10, acquireTimeoutMs: 5000 })
  const gate = OpenCodeGate.instance()
  const order: string[] = []
  const a = gate.run({ caller: "a" }, async () => {
    order.push("a-start")
    await sleep(30)
    order.push("a-end")
    return "A"
  })
  const b = gate.run({ caller: "b" }, async () => {
    order.push("b-start")
    await sleep(20)
    order.push("b-end")
    return "B"
  })
  const c = gate.run({ caller: "c" }, async () => {
    order.push("c-start")
    await sleep(10)
    order.push("c-end")
    return "C"
  })
  const results = await Promise.all([a, b, c])
  assert(results.join(",") === "A,B,C", "run() returns inner result")
  // a and b start immediately; c must wait until one releases.
  assert(order.indexOf("c-start") > order.indexOf("a-end") || order.indexOf("c-start") > order.indexOf("b-end"),
    "c starts after one of a/b releases")
}

async function main() {
  console.log("=== OpenCodeGate smoke test ===")
  await testSemaphoreCap()
  await testQueueOverflow()
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
