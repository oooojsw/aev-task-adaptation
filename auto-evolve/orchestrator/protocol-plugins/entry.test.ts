import { expect, test } from "bun:test"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { prepareEntry, runEntry, validateEntry, type Entry } from "./entry"
import type { Selection } from "./contract"
import { Runtime } from "./runtime"
import { campaignAcceptance } from "./campaign-acceptance"
import { deriveEntry } from "./derive-entry"
import { instanceReplay, ProtocolReplayFault } from "./instance-replay"
import { mergeRepair } from "./merge-repair"

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

test("derived replay preserves complete frozen selection and lineage", async () => {
  const f = await fixture()
  f.selection.protocol.phases.replay = structuredClone(f.selection.protocol.phases.source!)
  await writeFile(f.entry.selectionPath, JSON.stringify(f.selection))
  await prepareEntry(f.run, f.entry, f.runtime)
  const options = { parentRunRoot: f.run, parentEntry: f.entry, runRoot: path.join(f.root, "replay"),
    phase: "replay" as const, taskID: "task", runtime: f.runtime }
  const entry = await deriveEntry(options)
  expect(entry.phase).toBe("replay")
  expect(entry.selectionPath).toBe(f.entry.selectionPath)
  expect(await deriveEntry(options)).toEqual(entry)
  const receipt = await runEntry(options.runRoot, entry, path.join(f.root, "candidate"), path.join(f.root, "replay-attempt"), f.runtime)
  expect(receipt.claim).toBe("skill_check")
  expect(receipt.executed).toBe(false)
  expect(f.calls()).toBe(1)
})

test("protocol merge repair uses declared entry and promotes only verified bytes", async () => {
  const f = await fixture()
  f.selection.protocol.phases.replay = structuredClone(f.selection.protocol.phases.source!)
  await writeFile(f.entry.selectionPath, JSON.stringify(f.selection))
  const runtime = new Runtime().addChecker({ id: "check", version: "1", implementation: "d".repeat(64),
    targets: ["skill"], mechanisms: ["script"], productKinds: ["text"], validate() {} }, async (input) => ({
    status: Buffer.from(input.candidate[0].bytes).toString().includes("repaired") ? "passed" : "rejected", message: "Add reusable repair rule" }))
  const initial = await runEntry(f.run, f.entry, path.join(f.root, "candidate"), path.join(f.root, "initial"), runtime)
  const result = await mergeRepair({ parentRunRoot: f.run, parentEntry: f.entry, repairRoot: path.join(f.root, "repair"),
    candidateRoot: path.join(f.root, "candidate"), initial, initialReceiptPath: path.join(f.root, "initial", "protocol.receipt.json"), maxAttempts: 2, mode: "append_only", runtime,
    author: async (input) => {
      expect(input.entries).toEqual(["rules.txt"])
      await writeFile(path.join(input.candidateRoot, "rules.txt"), "Reusable rule\nrepaired")
      return { completed: true, evidence: [] }
    } })
  expect(result.fixed).toBe(true)
  expect(result.attempts).toBe(1)
  expect(await readFile(path.join(f.root, "candidate", "rules.txt"), "utf8")).toBe("Reusable rule")
})

test("repair cannot start from scoring fault or silently violate append-only", async () => {
  const f = await fixture("scoring_error")
  f.selection.protocol.phases.replay = structuredClone(f.selection.protocol.phases.source!)
  await writeFile(f.entry.selectionPath, JSON.stringify(f.selection))
  const initial = await runEntry(f.run, f.entry, path.join(f.root, "candidate"), path.join(f.root, "initial"), f.runtime)
  let calls = 0
  await expect(mergeRepair({ parentRunRoot: f.run, parentEntry: f.entry, repairRoot: path.join(f.root, "repair"),
    candidateRoot: path.join(f.root, "candidate"), initial, initialReceiptPath: path.join(f.root, "initial", "protocol.receipt.json"), maxAttempts: 2, mode: "rewrite", runtime: f.runtime,
    author: async () => { calls++; return { completed: true, evidence: [] } } })).rejects.toThrow("ordinary non-test rejection")
  expect(calls).toBe(0)
  const g = await fixture("rejected")
  g.selection.protocol.phases.replay = structuredClone(g.selection.protocol.phases.source!)
  await writeFile(g.entry.selectionPath, JSON.stringify(g.selection))
  const rejected = await runEntry(g.run, g.entry, path.join(g.root, "candidate"), path.join(g.root, "initial"), g.runtime)
  const result = await mergeRepair({ parentRunRoot: g.run, parentEntry: g.entry, repairRoot: path.join(g.root, "append"),
    candidateRoot: path.join(g.root, "candidate"), initial: rejected, initialReceiptPath: path.join(g.root, "initial", "protocol.receipt.json"), maxAttempts: 1, mode: "append_only", runtime: g.runtime,
    author: async (input) => { await writeFile(path.join(input.candidateRoot, "rules.txt"), "overwritten"); return { completed: true, evidence: [] } } })
  expect(result.fixed).toBe(false)
  expect(g.calls()).toBe(1)
})

test("repair refuses stale candidate or altered rejection before author call", async () => {
  const f = await fixture("rejected")
  f.selection.protocol.phases.replay = structuredClone(f.selection.protocol.phases.source!)
  await writeFile(f.entry.selectionPath, JSON.stringify(f.selection))
  const initial = await runEntry(f.run, f.entry, path.join(f.root, "candidate"), path.join(f.root, "initial"), f.runtime)
  let calls = 0
  const options = { parentRunRoot: f.run, parentEntry: f.entry, repairRoot: path.join(f.root, "repair"),
    candidateRoot: path.join(f.root, "candidate"), initial, initialReceiptPath: path.join(f.root, "initial", "protocol.receipt.json"),
    maxAttempts: 1, mode: "rewrite" as const, runtime: f.runtime,
    author: async () => { calls++; return { completed: true, evidence: [] } } }
  await expect(mergeRepair({ ...options, initial: { ...initial, task: "other" } })).rejects.toThrow("identity mismatch")
  await writeFile(path.join(f.root, "candidate", "rules.txt"), "different candidate")
  await expect(mergeRepair(options)).rejects.toThrow("differs from repair candidate")
  expect(calls).toBe(0)
})

test("instance replay routes explicit protocol and does not use legacy blank executor", async () => {
  const f = await fixture()
  f.selection.protocol.phases.replay = structuredClone(f.selection.protocol.phases.source!)
  await writeFile(f.entry.selectionPath, JSON.stringify(f.selection))
  await writeFile(path.join(f.root, "spec.json"), JSON.stringify({ title: "Replay fixture", goal: "Reusable skill",
    materials: [{ path: "public.txt", label: "public" }], validators: [], protocolPlugins: f.entry }))
  await prepareEntry(f.run, f.entry, f.runtime)
  const result = await instanceReplay({ cwd: f.root, sourceTaskRoot: f.root, parentRunRoot: f.run,
    candidateRoot: path.join(f.root, "candidate"), slotDir: path.join(f.root, "slot"), role: "train" }, f.runtime)
  expect(result?.passed).toBe(true)
  expect(result?.receipt.executed).toBe(false)
  expect(result?.infrastructureFailure).toBe(false)
  expect(f.calls()).toBe(1)
  await expect(instanceReplay({ cwd: f.root, sourceTaskRoot: f.root,
    candidateRoot: path.join(f.root, "candidate"), slotDir: path.join(f.root, "missing"), role: "train" }, f.runtime))
    .rejects.toBeInstanceOf(ProtocolReplayFault)
})

test("legacy instance spec is not reinterpreted by protocol replay", async () => {
  const f = await fixture()
  await writeFile(path.join(f.root, "spec.json"), JSON.stringify({ title: "Legacy fixture" }))
  expect(await instanceReplay({ cwd: f.root, sourceTaskRoot: f.root,
    candidateRoot: path.join(f.root, "candidate"), slotDir: path.join(f.root, "slot"), role: "train" }, f.runtime)).toBeUndefined()
  expect(f.calls()).toBe(0)
  await prepareEntry(f.run, f.entry, f.runtime)
  await expect(instanceReplay({ cwd: f.root, sourceTaskRoot: f.root, parentRunRoot: f.run,
    candidateRoot: path.join(f.root, "candidate"), slotDir: path.join(f.root, "removed"), role: "train" }, f.runtime))
    .rejects.toBeInstanceOf(ProtocolReplayFault)
})

test("undeclared replay and test on training UID cannot inherit source acceptance", async () => {
  const f = await fixture()
  f.selection.protocol.phases.test = structuredClone(f.selection.protocol.phases.source!)
  await writeFile(f.entry.selectionPath, JSON.stringify(f.selection))
  await prepareEntry(f.run, f.entry, f.runtime)
  const options = { parentRunRoot: f.run, parentEntry: f.entry, runRoot: path.join(f.root, "derived"),
    taskID: "task", runtime: f.runtime }
  await expect(deriveEntry({ ...options, phase: "replay" })).rejects.toThrow("Task/phase mismatch")
  await expect(deriveEntry({ ...options, phase: "test" })).rejects.toThrow("Task/phase mismatch")
  expect(f.calls()).toBe(0)
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
