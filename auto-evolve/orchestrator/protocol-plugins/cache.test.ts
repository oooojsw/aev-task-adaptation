import { expect, test } from "bun:test"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { randomUUID, createHash } from "node:crypto"
import path from "node:path"
import { cachedExecution, cachedScoring } from "./cache"
import type { Artifact, Evaluate, Execute, PublicInputs } from "./runtime"

const descriptor = { id: "fixture", version: "1", implementation: "d".repeat(64) }
function artifact(text: string): Artifact {
  const bytes = Buffer.from(text)
  return { id: "fixture", kind: "text", bytes, length: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") }
}
function request(): PublicInputs & { settings: {} } {
  return { task: "fixture", phase: "source", settings: {}, skill: [artifact("skill")], materials: [artifact("task")] }
}
function scoring(): Parameters<Evaluate>[0] {
  return { ...request(), candidate: [artifact("answer")], privateInputs: [artifact("gold")],
    check: { name: "score", target: "product", stage: "after_execution", mechanism: "script" } }
}
async function directory() {
  const dir = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(dir, { recursive: true })
  return dir
}
const answer: Awaited<ReturnType<Execute>> = { status: "completed", product: { kind: "text", bytes: Buffer.from("answer") },
  usage: { inputTokens: 10, outputTokens: 2 } }

test("same execution reuses actual answer and marks reuse", async () => {
  let calls = 0
  const run = cachedExecution(await directory(), descriptor, async () => { calls++; return answer })
  expect((await run(request())).reused).toBe(false)
  const result = await run(request())
  expect(result.reused).toBe(true)
  expect(Buffer.from(result.product!.bytes).toString()).toBe("answer")
  expect(calls).toBe(1)
})

test("dependency preflight runs before cache hit or claim and preserves completed evidence", async () => {
  const root = await directory()
  let calls = 0
  let compatible = true
  const guard = async () => { if (!compatible) throw new Error("dependency drift") }
  const run = cachedExecution(root, descriptor, async () => { calls++; return answer }, guard)
  const check = cachedScoring(root, descriptor, async () => {
    calls++; return { status: "passed", message: "ok" }
  }, guard)
  await run(request())
  await check(scoring())
  compatible = false
  await expect(run(request())).rejects.toThrow("dependency drift")
  await expect(check(scoring())).rejects.toThrow("dependency drift")
  expect(calls).toBe(2)
  compatible = true
  expect((await run(request())).reused).toBe(true)
  expect((await check(scoring())).reused).toBe(true)
  expect(calls).toBe(2)
})

test("changed skill, material or settings changes execution identity", async () => {
  let calls = 0
  const run = cachedExecution(await directory(), descriptor, async () => { calls++; return answer })
  await run(request())
  await run({ ...request(), skill: [artifact("new-skill")] })
  await run({ ...request(), materials: [artifact("new-material")] })
  await run({ ...request(), settings: { budget: 2 } })
  expect(calls).toBe(4)
})

test("changed checker reevaluates same execution without another executor call", async () => {
  let executes = 0
  let scores = 0
  const root = await directory()
  const run = cachedExecution(root, descriptor, async () => { executes++; return answer })
  await run(request())
  const first = cachedScoring(root, descriptor, async () => { scores++; return { status: "passed", message: "v1" } })
  await first(scoring())
  await first(scoring())
  const second = cachedScoring(root, { ...descriptor, implementation: "e".repeat(64) }, async () => {
    scores++; return { status: "rejected", message: "v2" }
  })
  expect((await run(request())).reused).toBe(true)
  expect((await second(scoring())).status).toBe("rejected")
  expect(executes).toBe(1)
  expect(scores).toBe(2)
})

test("private gold change invalidates only scoring", async () => {
  let calls = 0
  const check = cachedScoring(await directory(), descriptor, async () => { calls++; return { status: "passed", message: "ok" } })
  await check(scoring())
  await check({ ...scoring(), privateInputs: [artifact("new-gold")] })
  expect(calls).toBe(2)
})

test("normal rejected score can be reused", async () => {
  let calls = 0
  const check = cachedScoring(await directory(), descriptor, async () => { calls++; return { status: "rejected", message: "wrong" } })
  expect((await check(scoring())).status).toBe("rejected")
  expect((await check(scoring())).status).toBe("rejected")
  expect(calls).toBe(1)
})

test("scoring infrastructure failure cannot auto-repeat", async () => {
  let calls = 0
  const check = cachedScoring(await directory(), descriptor, async () => { calls++; return { status: "scoring_error", message: "broken" } })
  expect((await check(scoring())).status).toBe("scoring_error")
  await expect(check(scoring())).rejects.toThrow("pending/incomplete")
  expect(calls).toBe(1)
})

test("transport interruption cannot auto-repeat", async () => {
  let calls = 0
  const run = cachedExecution(await directory(), descriptor, async () => { calls++; throw new Error("interrupted") })
  await expect(run(request())).rejects.toThrow("interrupted")
  await expect(run(request())).rejects.toThrow("pending/incomplete")
  expect(calls).toBe(1)
})

test("concurrent identical requests start handler only once", async () => {
  let calls = 0
  const run = cachedExecution(await directory(), descriptor, async () => {
    calls++; await new Promise((resolve) => setTimeout(resolve, 20)); return answer
  })
  const result = await Promise.allSettled(Array.from({ length: 8 }, () => run(request())))
  expect(calls).toBe(1)
  expect(result.some((item) => item.status === "fulfilled")).toBe(true)
  expect((await run(request())).reused).toBe(true)
})

test("tampered cached product blocked without retry", async () => {
  let calls = 0
  const root = await directory()
  const run = cachedExecution(root, descriptor, async () => { calls++; return answer })
  await run(request())
  const [key] = await readdir(path.join(root, "execution"))
  const file = path.join(root, "execution", key, "completed.json")
  const value = JSON.parse(await readFile(file, "utf8"))
  value.body.base64 = Buffer.from("tampered").toString("base64")
  await writeFile(file, JSON.stringify(value))
  await expect(run(request())).rejects.toThrow("drift")
  expect(calls).toBe(1)
})

test("caller-provided wrong digest cannot hide actual changed bytes", async () => {
  let calls = 0
  const run = cachedExecution(await directory(), descriptor, async () => { calls++; return answer })
  const value = request()
  await run(value)
  value.skill[0].bytes = Buffer.from("changed-but-stale-hash")
  await run(value)
  expect(calls).toBe(2)
})
