import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { summarizeResources } from "./resource-summary"

async function root() {
  const dir = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(dir, { recursive: true })
  return dir
}
async function ledger(dir: string, id: string, fields: Record<string, unknown> = {}) {
  const target = path.join(dir, id)
  await mkdir(target)
  await writeFile(path.join(target, "started.claim"), "")
  await writeFile(path.join(target, "accounting.json"), JSON.stringify({ schema: "aev.training-invocation-accounting.v1",
    requestFingerprint: "a".repeat(64), reused: false, status: "completed", inputTokens: 10, outputTokens: 2, elapsedMs: 3, ...fields }))
}
test("resource summary counts physical calls, not overlapping acceptance or cached usage", async () => {
  const dir = await root()
  await ledger(dir, "one")
  await ledger(dir, "two", { schema: "aev.backend-invocation-accounting.v1", transport: "http" })
  await writeFile(path.join(dir, "protocol.accounting.json"), JSON.stringify({ input: { knownTokens: 999 }, output: { knownTokens: 999 } }))
  const saved = await summarizeResources(dir)
  expect(saved.invocations).toHaveLength(2)
  expect(saved.input.knownTokens).toBe(20)
  expect(saved.output.knownTokens).toBe(4)
  expect(saved.ignoredOverlappingAcceptance).toHaveLength(1)
  expect(saved.input.completeForDiscoveredInvocations).toBe(true)
})
test("missing, failed and partial usage cannot become a complete total", async () => {
  const dir = await root()
  await ledger(dir, "failed", { status: "infrastructure_error", inputTokens: null, outputTokens: null })
  await mkdir(path.join(dir, "interrupted"))
  await writeFile(path.join(dir, "interrupted/started.claim"), "")
  const saved = await summarizeResources(dir)
  expect(saved.input.knownTokens).toBe(0)
  expect(saved.input.unreportedInvocations).toBe(1)
  expect(saved.input.startedWithoutLedger).toBe(1)
  expect(saved.input.completeForDiscoveredInvocations).toBe(false)
})
test("malformed accounting fails closed rather than disappearing from report", async () => {
  const dir = await root()
  await ledger(dir, "bad", { reused: true })
  await expect(summarizeResources(dir)).rejects.toThrow("identity")
})
