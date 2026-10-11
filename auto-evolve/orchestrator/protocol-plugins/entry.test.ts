import { expect, test } from "bun:test"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { prepareEntry, runEntry, validateEntry, type Entry } from "./entry"
import type { Selection } from "./contract"
import { Runtime } from "./runtime"
import { campaignAcceptance } from "./campaign-acceptance"

async function fixture(status: "passed" | "rejected" | "scoring_error" | "data_error" = "passed") {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(path.join(root, "candidate"), { recursive: true })
  await writeFile(path.join(root, "candidate", "rules.txt"), "Reusable rule")
  await writeFile(path.join(root, "public.txt"), "Public question")
  const project = { id: "entry-fixture", version: "1", skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] }
  const selection: Selection = { schema: "aev.protocol-plugins.v1", project,
    run: { skillFormat: "text", productKind: "text", materialKinds: ["text"] },
    protocol: { id: "entry-protocol", version: "1", phases: { source: { claim: "skill_check", checks: [{
      id: "check", version: "1", settings: {}, name: "content", target: "skill", stage: "before_execution",
      required: true, mechanism: "script" }] } } } }
  const selectionPath = path.join(root, "selection.json")
  const projectManifestPath = path.join(root, "manifest.json")
  await writeFile(selectionPath, JSON.stringify(selection))
  await writeFile(projectManifestPath, JSON.stringify({ schema: "aev.project-pack.v1", project,
    skill: { format: "text", entries: [{ id: "skill", kind: "text", path: "rules.txt" }] },
    tasks: [{ id: "task", split: "train", materials: [{ id: "question", kind: "text", path: "public.txt" }], privateInputs: [] }] }))
  let calls = 0
  const runtime = new Runtime().addChecker({ id: "check", version: "1", implementation: "d".repeat(64),
    targets: ["skill"], mechanisms: ["script"], productKinds: ["text"], validate() {} }, async () => {
      calls++; return { status, message: "fixture verdict" }
    })
  const entry: Entry = { schema: "aev.protocol-entry.v1", selectionPath, projectManifestPath, taskID: "task", phase: "source" }
  return { root, entry, runtime, selection, calls: () => calls, run: path.join(root, "run") }
}

test("absent opt-in leaves legacy run untouched; enabled run cannot remove entry", async () => {
  const f = await fixture()
  expect(await prepareEntry(f.run, undefined, f.runtime)).toBeUndefined()
  await prepareEntry(f.run, f.entry, f.runtime)
  await expect(prepareEntry(f.run, undefined, f.runtime)).rejects.toThrow("removed")
})

test("campaign bridge maps verdicts without claiming Skill-only task execution", async () => {
  for (const [status, failure] of [["passed", undefined], ["rejected", "product_failure"],
    ["scoring_error", "infrastructure_failure"], ["data_error", "dataset_failure"]] as const) {
    const f = await fixture(status)
    const result = await campaignAcceptance({ campaignRoot: f.run, campaignID: "fixture", roundNumber: 1,
      runID: "fixture-run", entry: f.entry, candidateRoot: path.join(f.root, "candidate"),
      attemptRoot: path.join(f.root, "attempt"), resultPath: path.join(f.root, "result.json") }, f.runtime)
    expect(result.failureKind).toBe(failure)
    expect(result.blankEvalSkipped).toBe(true)
    expect(result.protocolClaim).toBe("skill_check")
    expect(result.validatorResults).toHaveLength(1)
    expect(result.validatorPartitions.surfaceValidatorIDs).toEqual(["content"])
    expect(result.validatorPartitions.productValidatorIDs).toEqual([])
  }
})

test("entry freezes and resumes exact linked project/protocol", async () => {
  const f = await fixture()
  const first = await prepareEntry(f.run, f.entry, f.runtime)
  expect(await prepareEntry(f.run, f.entry, f.runtime)).toEqual(first)
  f.selection.protocol.version = "2"
  await writeFile(f.entry.selectionPath, JSON.stringify(f.selection))
  await expect(prepareEntry(f.run, f.entry, f.runtime)).rejects.toThrow("Cannot change")
})

test("entry saves actual candidate receipt and blocks duplicate attempt", async () => {
  const f = await fixture()
  const attempt = path.join(f.root, "attempt")
  const result = await runEntry(f.run, f.entry, path.join(f.root, "candidate"), attempt, f.runtime)
  expect(result.executed).toBe(false)
  expect(result.claim).toBe("skill_check")
  expect(result.status).toBe("passed")
  expect(JSON.parse(await readFile(path.join(attempt, "protocol.receipt.json"), "utf8"))).toEqual(result)
  await expect(runEntry(f.run, f.entry, path.join(f.root, "candidate"), attempt, f.runtime)).rejects.toThrow()
  expect(f.calls()).toBe(1)
})

test("incomplete entry never auto-recreates frozen state", async () => {
  const f = await fixture()
  await mkdir(path.join(f.run, "protocol-plugins"), { recursive: true })
  await writeFile(path.join(f.run, "protocol-plugins", "entry.started.claim"), "")
  await expect(prepareEntry(f.run, f.entry, f.runtime)).rejects.toThrow("incomplete")
  expect(f.calls()).toBe(0)
})

test("task and phase mismatch block before checker or executor", async () => {
  const f = await fixture()
  await expect(prepareEntry(f.run, { ...f.entry, phase: "test" }, f.runtime)).rejects.toThrow("mismatch")
  await expect(prepareEntry(f.run, { ...f.entry, taskID: "unknown" }, f.runtime)).rejects.toThrow("mismatch")
  expect(f.calls()).toBe(0)
  expect(() => validateEntry({ ...f.entry, fallback: true })).toThrow("Explicit")
})

test("material drift on resume blocks before checks", async () => {
  const f = await fixture()
  await prepareEntry(f.run, f.entry, f.runtime)
  await writeFile(path.join(f.root, "public.txt"), "Changed")
  await expect(prepareEntry(f.run, f.entry, f.runtime)).rejects.toThrow("Cannot change")
  expect(f.calls()).toBe(0)
})

test("orphan attempt evidence cannot be overwritten or send a request", async () => {
  const f = await fixture()
  const attempt = path.join(f.root, "attempt")
  await mkdir(attempt)
  await writeFile(path.join(attempt, "protocol.receipt.json"), '{"historical":true}')
  await expect(runEntry(f.run, f.entry, path.join(f.root, "candidate"), attempt, f.runtime)).rejects.toThrow("Existing attempt")
  expect(await readFile(path.join(attempt, "protocol.receipt.json"), "utf8")).toBe('{"historical":true}')
  expect(f.calls()).toBe(0)
})
