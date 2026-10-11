import { expect, test } from "bun:test"
import { readFile, mkdir, readdir } from "node:fs/promises"
import { randomUUID, createHash } from "node:crypto"
import path from "node:path"
import { runProtocolTrainingTask } from "./training-invocation"
import type { OpencodeTaskInput, OpencodeTaskRun } from "../opencode"

const request = { title: "Fixture", prompt: "Public learning", model: "fixture/model" } as OpencodeTaskInput
async function fixture() {
  const stageDir = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(stageDir, { recursive: true })
  return { enabled: true, role: "lead", stageDir }
}
function result(events: any[] = [], exitCode = 0) {
  return { selectedModel: "fixture/model", result: { events, exitCode, modelResolution: { providerID: "fixture", modelID: "model" } } } as OpencodeTaskRun
}
async function ledgerDir(stageDir: string) {
  const root = path.join(stageDir, "protocol-invocations")
  const names = await readdir(root)
  expect(names).toHaveLength(1)
  return path.join(root, names[0])
}
test("opt-in training ledger binds actual reply bytes and reported session usage", async () => {
  const f = await fixture()
  const raw = result([{ type: "step_finish", part: { tokens: { input: 7, output: 3 } } }])
  expect(await runProtocolTrainingTask(f, request, async () => raw)).toBe(raw)
  const dir = await ledgerDir(f.stageDir)
  const accounting = JSON.parse(await readFile(path.join(dir, "accounting.json"), "utf8"))
  expect(accounting.status).toBe("completed")
  expect(accounting.inputTokens).toBe(7)
  expect(accounting.outputTokens).toBe(3)
  expect(accounting.actualModel).toBe("fixture/model")
  expect(accounting.fee).toBeNull()
  expect(accounting.elapsedMs).toBeGreaterThanOrEqual(0)
  expect(accounting.rawResultSha256).toBe(createHash("sha256").update(await readFile(path.join(dir, "task-result.json"))).digest("hex"))
  let calls = 0
  await runProtocolTrainingTask(f, request, async () => { calls++; return raw })
  expect(calls).toBe(1)
  expect(await readdir(path.join(f.stageDir, "protocol-invocations"))).toHaveLength(2)
})
test("missing usage and prereceipt failure remain unknown and sanitized", async () => {
  const f = await fixture()
  await expect(runProtocolTrainingTask(f, request, async () => { throw new Error("PRIVATE_SECRET") })).rejects.toThrow("PRIVATE_SECRET")
  const saved = await readFile(path.join(await ledgerDir(f.stageDir), "accounting.json"), "utf8")
  expect(saved).not.toContain("PRIVATE_SECRET")
  const accounting = JSON.parse(saved)
  expect(accounting.status).toBe("infrastructure_error")
  expect(accounting.inputTokens).toBeNull()
  expect(accounting.outputTokens).toBeNull()
  const incomplete = await fixture()
  await runProtocolTrainingTask(incomplete, request, async () => result([], 1))
  const unknown = JSON.parse(await readFile(path.join(await ledgerDir(incomplete.stageDir), "accounting.json"), "utf8"))
  expect(unknown.status).toBe("incomplete")
  expect(unknown.inputTokens).toBeNull()
})
test("legacy branch calls original backend without creating accounting artifacts", async () => {
  const f = await fixture()
  const raw = result()
  expect(await runProtocolTrainingTask({ ...f, enabled: false }, request, async () => raw)).toBe(raw)
  await expect(readdir(path.join(f.stageDir, "protocol-invocations"))).rejects.toThrow()
})
