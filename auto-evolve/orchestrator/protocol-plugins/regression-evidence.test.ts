import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { regressionEvidence } from "./regression-evidence"
import type { Snapshot } from "./contract"

async function fixture() {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(root, { recursive: true })
  const plan = { claim: "task_execution" as const,
    executor: { id: "executor", version: "1", settings: {} }, checks: [] }
  const protocol = { fingerprint: "f".repeat(64), selection: { protocol: { phases: { source: plan, replay: structuredClone(plan) } } } } as Snapshot
  const evidence = { materials: [{ id: "public", sha256: "a".repeat(64), length: 4, kind: "text" }], privateInputs: [] }
  const source = { schema: "aev.protocol-receipt.v1", task: "source", phase: "source", status: "passed",
    claim: "task_execution", executed: true, protocolFingerprint: protocol.fingerprint, evidence }
  const sourceReceiptPath = path.join(root, "protocol.receipt.json")
  await writeFile(sourceReceiptPath, JSON.stringify(source))
  return { source, input: { taskID: "source", sourceReceiptPath, protocol,
    replay: { status: "rejected", claim: "task_execution", executed: true, evidence: structuredClone(evidence) } } }
}

test("matched executed source and rejected replay provide preservation regression evidence", async () => {
  const f = await fixture()
  expect(await regressionEvidence(f.input)).toMatchObject({ comparable: true, regression: true })
  f.input.replay.status = "passed"
  expect(await regressionEvidence(f.input)).toMatchObject({ comparable: true, regression: false })
})

test("Skill-only rejection, absent source and altered execution conditions are not ability regressions", async () => {
  for (const mode of ["skill", "missing", "executor", "inputs", "uid", "fault"] as const) {
    const f = await fixture()
    if (mode === "skill") { f.input.replay.claim = "skill_check"; f.input.replay.executed = false }
    if (mode === "missing") f.input.sourceReceiptPath = path.join(path.dirname(f.input.sourceReceiptPath), "missing.json")
    if (mode === "executor") f.input.protocol.selection.protocol.phases.replay!.executor!.settings = { model: "different" }
    if (mode === "inputs") f.input.replay.evidence.materials[0].sha256 = "b".repeat(64)
    if (mode === "uid") { f.source.task = "another"; await writeFile(f.input.sourceReceiptPath, JSON.stringify(f.source)) }
    if (mode === "fault") { f.source.status = "scoring_error"; await writeFile(f.input.sourceReceiptPath, JSON.stringify(f.source)) }
    expect(await regressionEvidence(f.input)).toMatchObject({ comparable: false, regression: false })
  }
})
