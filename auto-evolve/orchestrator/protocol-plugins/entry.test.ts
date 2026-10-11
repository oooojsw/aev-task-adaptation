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
import { instanceRepair } from "./instance-repair"
import { mergeContext } from "./merge-context"
import { runCoordinatorPhase2Merge } from "../multi-instance/merger"
import type { CoordinatorState } from "../multi-instance/contract"
import { mergeStage } from "./merge-stage"
import { harvest } from "./harvest"

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

test("completed entry reuse verifies Skill and receipt without checker calls", async () => {
  const f = await fixture()
  const candidate = path.join(f.root, "candidate")
  const attempt = path.join(f.root, "attempt")
  const receipt = await runEntry(f.run, f.entry, candidate, attempt, f.runtime)
  expect(await runEntry(f.run, f.entry, candidate, attempt, f.runtime, { reuseCompleted: true })).toEqual(receipt)
  expect(f.calls()).toBe(1)
  await writeFile(path.join(candidate, "rules.txt"), "Changed rule")
  await expect(runEntry(f.run, f.entry, candidate, attempt, f.runtime, { reuseCompleted: true })).rejects.toThrow("identity")
  await writeFile(path.join(candidate, "rules.txt"), "Reusable rule")
  await writeFile(path.join(attempt, "protocol.receipt.json"), JSON.stringify({ ...receipt, status: "rejected" }))
  await expect(runEntry(f.run, f.entry, candidate, attempt, f.runtime, { reuseCompleted: true })).rejects.toThrow("identity")
  expect(f.calls()).toBe(1)
})

test("completed fault cannot be reused or resent", async () => {
  const f = await fixture("scoring_error")
  const attempt = path.join(f.root, "attempt")
  await runEntry(f.run, f.entry, path.join(f.root, "candidate"), attempt, f.runtime)
  await expect(runEntry(f.run, f.entry, path.join(f.root, "candidate"), attempt, f.runtime, { reuseCompleted: true })).rejects.toThrow("verdict")
  expect(f.calls()).toBe(1)
})

test("merge context uses arbitrary declared entries and accepted source identity", async () => {
  const f = await fixture()
  f.selection.protocol.phases.merge = structuredClone(f.selection.protocol.phases.source!)
  await writeFile(f.entry.selectionPath, JSON.stringify(f.selection))
  const candidate = path.join(f.root, "candidate")
  const attempt = path.join(f.root, "attempt")
  await writeFile(path.join(candidate, "private-note.txt"), "Never attach this")
  await runEntry(f.run, f.entry, candidate, attempt, f.runtime)
  const input = { parentRunRoot: f.run, entry: f.entry, outputRoot: path.join(f.root, "merged"),
    sources: [{ id: "task", candidateRoot: candidate, receiptPath: path.join(attempt, "protocol.receipt.json") }], runtime: f.runtime }
  const context = await mergeContext(input)
  expect(context.readPaths).toEqual([path.join(candidate, "rules.txt")])
  expect(context.editPaths).toEqual([path.join(input.outputRoot, "rules.txt")])
  expect(context.prompt).not.toContain("private-note.txt")
  expect(context.prompt).not.toContain(input.sources[0].receiptPath)
  expect(context.contract.sources[0].executed).toBe(false)
  expect(await mergeContext(input)).toEqual(context)
  await writeFile(path.join(candidate, "rules.txt"), "Unaccepted replacement")
  await expect(mergeContext(input)).rejects.toThrow("identity mismatch")
  expect(f.calls()).toBe(1)
})

test("merge context refuses rejected and duplicate sources", async () => {
  for (const status of ["passed", "rejected"] as const) {
    const f = await fixture(status)
    f.selection.protocol.phases.merge = structuredClone(f.selection.protocol.phases.source!)
    await writeFile(f.entry.selectionPath, JSON.stringify(f.selection))
    const candidate = path.join(f.root, "candidate")
    const attempt = path.join(f.root, "attempt")
    await runEntry(f.run, f.entry, candidate, attempt, f.runtime)
    const source = { id: "task", candidateRoot: candidate, receiptPath: path.join(attempt, "protocol.receipt.json") }
    await expect(mergeContext({ parentRunRoot: f.run, entry: f.entry, outputRoot: path.join(f.root, "merged"),
      sources: status === "passed" ? [source, source] : [source], runtime: f.runtime })).rejects.toThrow()
    expect(f.calls()).toBe(1)
  }
})

test("real merger accepts arbitrary entries and recovers without author or checker repeat", async () => {
  const f = await fixture()
  f.selection.protocol.phases.merge = structuredClone(f.selection.protocol.phases.source!)
  await writeFile(f.entry.selectionPath, JSON.stringify(f.selection))
  const candidate = path.join(f.root, "candidate")
  const attempt = path.join(f.root, "attempt")
  await runEntry(f.run, f.entry, candidate, attempt, f.runtime)
  const state: CoordinatorState = { id: "merge-fixture", label: "Merge", phase: "phase1_fanout", createdAt: "fixed", updatedAt: "fixed",
    runRoot: path.join(f.root, "coordinator"), options: { skillsbenchRoot: f.root, rounds: 1, fanoutLimit: 1 }, log: [],
    instances: [{ id: "task", role: "train", engine: "skillsbench", sourceTaskRoot: f.root, campaignDir: f.run,
      status: "passed", harvestedSkillPath: candidate, rounds: 1 }] }
  const input = { cwd: f.root, state, protocolMerge: { parentRunRoot: f.run, entry: f.entry,
    sources: [{ id: "task", candidateRoot: candidate, receiptPath: path.join(attempt, "protocol.receipt.json") }],
    author: { model: "fixture/author", expectedModel: "fixture/author", timeoutMs: 1000, maxInputBytes: 100000 } } }
  let calls = 0
  const dependencies = { runtime: f.runtime, createDriver: async () => ({ implementation: "a".repeat(64), preflight: async () => {},
    invoke: async (request: { editPaths: string[]; readPaths: string[]; allowShell: boolean }) => {
      calls++
      expect(request.allowShell).toBe(false)
      expect(request.editPaths.map((file) => path.basename(file))).toEqual(["rules.txt"])
      expect(request.readPaths).toHaveLength(1)
      await writeFile(request.editPaths[0], "Combined reusable rules")
      return { completed: true, actualModel: "fixture/author", evidence: [] }
    } }) }
  const first = await runCoordinatorPhase2Merge(input, dependencies)
  expect(first.postMergeValidationPassed).toBe(true)
  expect(await readFile(path.join(first.mergedSkillDir, "rules.txt"), "utf8")).toBe("Combined reusable rules")
  expect(f.calls()).toBe(2)
  expect(await runCoordinatorPhase2Merge(input, dependencies)).toMatchObject({ ...first, reused: true })
  state.instances[0].harvestedProtocolReceiptPath = path.join(attempt, "protocol.receipt.json")
  expect(await runCoordinatorPhase2Merge({ cwd: f.root, state, protocolAuthor: input.protocolMerge.author }, dependencies))
    .toMatchObject({ ...first, reused: true })
  expect(calls).toBe(1)
  expect(f.calls()).toBe(2)
  await writeFile(path.join(first.mergedSkillDir, "rules.txt"), "Changed deployment")
  await expect(runCoordinatorPhase2Merge(input, dependencies)).rejects.toThrow("output drift")
  expect(calls).toBe(1)
  expect(f.calls()).toBe(2)
  await expect(runCoordinatorPhase2Merge({ cwd: f.root, state }, dependencies)).rejects.toThrow("no legacy fallback")
})

test("merge missing output or wrong author model cannot promote or resend", async () => {
  for (const mode of ["missing", "wrong-model"] as const) {
    const f = await fixture()
    f.selection.protocol.phases.merge = structuredClone(f.selection.protocol.phases.source!)
    await writeFile(f.entry.selectionPath, JSON.stringify(f.selection))
    const candidate = path.join(f.root, "candidate")
    const attempt = path.join(f.root, "attempt")
    await runEntry(f.run, f.entry, candidate, attempt, f.runtime)
    let calls = 0
    const input = { cwd: f.root, runRoot: path.join(f.root, "merge"), config: { parentRunRoot: f.run, entry: f.entry,
      sources: [{ id: "task", candidateRoot: candidate, receiptPath: path.join(attempt, "protocol.receipt.json") }],
      author: { model: "fixture/author", expectedModel: "fixture/author", timeoutMs: 1000, maxInputBytes: 100000 } } }
    const dependencies = { runtime: f.runtime, createDriver: async () => ({ implementation: "a".repeat(64), preflight: async () => {},
      invoke: async () => { calls++; return { completed: true, actualModel: mode === "missing" ? "fixture/author" : "other/model", evidence: [] } } }) }
    await expect(mergeStage(input, dependencies)).rejects.toThrow()
    await expect(mergeStage(input, dependencies)).rejects.toThrow()
    expect(calls).toBe(1)
    expect(f.calls()).toBe(1)
    expect(await readFile(path.join(candidate, "rules.txt"), "utf8")).toBe("Reusable rule")
  }
})

test("merge protocol rejection is never promoted and repeated author invocation is blocked", async () => {
  const f = await fixture()
  f.selection.protocol.phases.merge = structuredClone(f.selection.protocol.phases.source!)
  await writeFile(f.entry.selectionPath, JSON.stringify(f.selection))
  const candidate = path.join(f.root, "candidate")
  const attempt = path.join(f.root, "attempt")
  await runEntry(f.run, f.entry, candidate, attempt, f.runtime)
  const runtime = new Runtime().addChecker({ id: "check", version: "1", implementation: "d".repeat(64),
    targets: ["skill"], mechanisms: ["script"], productKinds: ["text"], validate() {} }, async () => ({ status: "rejected", message: "Rejected merge" }))
  let calls = 0
  const input = { cwd: f.root, runRoot: path.join(f.root, "merge"), config: { parentRunRoot: f.run, entry: f.entry,
    sources: [{ id: "task", candidateRoot: candidate, receiptPath: path.join(attempt, "protocol.receipt.json") }],
    author: { model: "fixture/author", expectedModel: "fixture/author", timeoutMs: 1000, maxInputBytes: 100000 } } }
  const dependencies = { runtime, createDriver: async () => ({ implementation: "a".repeat(64), preflight: async () => {},
    invoke: async (request: { editPaths: string[] }) => {
      calls++; await writeFile(request.editPaths[0], "Rejected merged rules")
      return { completed: true, actualModel: "fixture/author", evidence: [] }
    } }) }
  await expect(mergeStage(input, dependencies)).rejects.toThrow("Merge not accepted: rejected")
  await expect(mergeStage(input, dependencies)).rejects.toThrow()
  expect(calls).toBe(1)
})

test("source harvest binds actual acceptance and copies only declared files without merge phase", async () => {
  const f = await fixture()
  const candidate = path.join(f.run, "candidate")
  await mkdir(candidate, { recursive: true })
  await writeFile(path.join(candidate, "rules.txt"), "Reusable rule")
  await writeFile(path.join(candidate, "private-note.txt"), "Never harvest")
  const attempt = path.join(f.run, "rounds", "round-001", "final-acceptance")
  await campaignAcceptance({ campaignRoot: f.run, campaignID: "fixture", roundNumber: 1, runID: "fixture",
    entry: f.entry, candidateRoot: candidate, attemptRoot: attempt, resultPath: path.join(attempt, "result.json") }, f.runtime)
  await writeFile(path.join(f.run, "campaign.json"), JSON.stringify({ id: "fixture", currentRound: 1, lastRunID: "fixture",
    status: "verified_success", lastFinalAcceptancePassed: true,
    lastFinalAcceptanceResultPath: path.join(attempt, "result.json") }))
  const input = { cwd: f.root, campaignRoot: f.run, taskID: "task", targetRoot: path.join(f.root, "harvest") }
  const first = await harvest(input, f.runtime)
  expect(await harvest(input, f.runtime)).toEqual(first)
  expect(await readFile(path.join(input.targetRoot, "rules.txt"), "utf8")).toBe("Reusable rule")
  await expect(readFile(path.join(input.targetRoot, "private-note.txt"))).rejects.toThrow()
  expect(f.calls()).toBe(1)
  await writeFile(path.join(candidate, "rules.txt"), "Unaccepted replacement")
  await expect(harvest(input, f.runtime)).rejects.toThrow("identity mismatch")
  expect(await readFile(path.join(input.targetRoot, "rules.txt"), "utf8")).toBe("Reusable rule")
  await writeFile(path.join(candidate, "rules.txt"), "Reusable rule")
  await writeFile(path.join(f.run, "campaign.json"), JSON.stringify({ id: "wrong-campaign", currentRound: 1, lastRunID: "fixture",
    status: "verified_success", lastFinalAcceptancePassed: true, lastFinalAcceptanceResultPath: path.join(attempt, "result.json") }))
  await expect(harvest(input, f.runtime)).rejects.toThrow("acceptance identity")
  expect(f.calls()).toBe(1)
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
    candidateRoot: path.join(f.root, "candidate"), initial, initialReceiptPath: path.join(f.root, "initial", "protocol.receipt.json"), maxAttempts: 2, mode: "append_only", runtime, authorIdentity: "a".repeat(64),
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
    candidateRoot: path.join(f.root, "candidate"), initial, initialReceiptPath: path.join(f.root, "initial", "protocol.receipt.json"), maxAttempts: 2, mode: "rewrite", runtime: f.runtime, authorIdentity: "a".repeat(64),
    author: async () => { calls++; return { completed: true, evidence: [] } } })).rejects.toThrow("ordinary non-test rejection")
  expect(calls).toBe(0)
  const g = await fixture("rejected")
  g.selection.protocol.phases.replay = structuredClone(g.selection.protocol.phases.source!)
  await writeFile(g.entry.selectionPath, JSON.stringify(g.selection))
  const rejected = await runEntry(g.run, g.entry, path.join(g.root, "candidate"), path.join(g.root, "initial"), g.runtime)
  const result = await mergeRepair({ parentRunRoot: g.run, parentEntry: g.entry, repairRoot: path.join(g.root, "append"),
    candidateRoot: path.join(g.root, "candidate"), initial: rejected, initialReceiptPath: path.join(g.root, "initial", "protocol.receipt.json"), maxAttempts: 1, mode: "append_only", runtime: g.runtime, authorIdentity: "a".repeat(64),
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
    maxAttempts: 1, mode: "rewrite" as const, runtime: f.runtime, authorIdentity: "a".repeat(64),
    author: async () => { calls++; return { completed: true, evidence: [] } } }
  await expect(mergeRepair({ ...options, initial: { ...initial, task: "other" } })).rejects.toThrow("identity mismatch")
  await writeFile(path.join(f.root, "candidate", "rules.txt"), "different candidate")
  await expect(mergeRepair(options)).rejects.toThrow("differs from repair candidate")
  expect(calls).toBe(0)
})

test("repair resumes completed acceptance and rejects configuration drift or interrupted author", async () => {
  const f = await fixture()
  f.selection.protocol.phases.replay = structuredClone(f.selection.protocol.phases.source!)
  await writeFile(f.entry.selectionPath, JSON.stringify(f.selection))
  const runtime = new Runtime().addChecker({ id: "check", version: "1", implementation: "d".repeat(64),
    targets: ["skill"], mechanisms: ["script"], productKinds: ["text"], validate() {} }, async (input) => ({
    status: Buffer.from(input.candidate[0].bytes).toString().includes("repaired") ? "passed" : "rejected", message: "Reusable correction needed" }))
  const initial = await runEntry(f.run, f.entry, path.join(f.root, "candidate"), path.join(f.root, "initial"), runtime)
  let calls = 0
  const options = { parentRunRoot: f.run, parentEntry: f.entry, repairRoot: path.join(f.root, "repair"),
    candidateRoot: path.join(f.root, "candidate"), initial, initialReceiptPath: path.join(f.root, "initial", "protocol.receipt.json"),
    maxAttempts: 2, mode: "rewrite" as const, runtime, authorIdentity: "a".repeat(64),
    author: async (request: { candidateRoot: string }) => {
      calls++; await writeFile(path.join(request.candidateRoot, "rules.txt"), "repaired")
      return { completed: true, evidence: [] }
    } }
  const first = await mergeRepair(options)
  expect(await mergeRepair(options)).toEqual(first)
  expect(calls).toBe(1)
  const authorResultPath = path.join(options.repairRoot, "attempt-01", "author.result.json")
  const authorRequestPath = path.join(options.repairRoot, "attempt-01", "author.request.json")
  const originalResult = await readFile(authorResultPath)
  const originalRequest = await readFile(authorRequestPath)
  await writeFile(authorResultPath, JSON.stringify({ completed: false, evidence: [] }))
  await expect(mergeRepair(options)).rejects.toThrow("checkpoint identity changed")
  await writeFile(authorResultPath, originalResult)
  await writeFile(authorRequestPath, JSON.stringify({ mode: "rewrite", entries: [] }))
  await expect(mergeRepair(options)).rejects.toThrow("checkpoint identity changed")
  await writeFile(authorRequestPath, originalRequest)
  expect(await mergeRepair(options)).toEqual(first)
  expect(calls).toBe(1)
  await expect(mergeRepair({ ...options, authorIdentity: "b".repeat(64) })).rejects.toThrow("configuration changed")
  await expect(mergeRepair({ ...options, maxAttempts: 3 })).rejects.toThrow("configuration changed")
  const interrupted = { ...options, repairRoot: path.join(f.root, "interrupted"), author: async () => {
    calls++; throw new Error("interrupted")
  } }
  await expect(mergeRepair(interrupted)).rejects.toThrow("interrupted")
  await expect(mergeRepair(interrupted)).rejects.toThrow()
  expect(calls).toBe(2)
  await writeFile(path.join(first.candidateRoot, "rules.txt"), "changed after acceptance")
  await expect(mergeRepair(options)).rejects.toThrow("checkpoint identity changed")
  expect(calls).toBe(2)
})

test("repair blocks candidate mutation even when replay rejects", async () => {
  const f = await fixture()
  f.selection.protocol.phases.replay = structuredClone(f.selection.protocol.phases.source!)
  await writeFile(f.entry.selectionPath, JSON.stringify(f.selection))
  const repairRoot = path.join(f.root, "repair")
  let checks = 0
  let authors = 0
  const runtime = new Runtime().addChecker({ id: "check", version: "1", implementation: "d".repeat(64),
    targets: ["skill"], mechanisms: ["script"], productKinds: ["text"], validate() {} }, async () => {
    checks++
    if (checks > 1) await writeFile(path.join(repairRoot, "attempt-01", "candidate", "rules.txt"), "mutated while judging")
    return { status: "rejected", message: "Needs correction" }
  })
  const initial = await runEntry(f.run, f.entry, path.join(f.root, "candidate"), path.join(f.root, "initial"), runtime)
  const options = { parentRunRoot: f.run, parentEntry: f.entry, repairRoot,
    candidateRoot: path.join(f.root, "candidate"), initial, initialReceiptPath: path.join(f.root, "initial", "protocol.receipt.json"),
    maxAttempts: 2, mode: "rewrite" as const, runtime, authorIdentity: "a".repeat(64),
    author: async (request: { candidateRoot: string }) => {
      authors++
      await writeFile(path.join(request.candidateRoot, "rules.txt"), "stable proposed revision")
      return { completed: true, evidence: [] }
    } }
  await expect(mergeRepair(options)).rejects.toThrow("candidate changed during acceptance")
  expect(authors).toBe(1)
  await expect(mergeRepair(options)).rejects.toThrow()
  expect(authors).toBe(1)
})

test("instance repair author receives staged public material and declared edits only", async () => {
  const f = await fixture()
  f.selection.protocol.phases.replay = structuredClone(f.selection.protocol.phases.source!)
  await writeFile(f.entry.selectionPath, JSON.stringify(f.selection))
  await writeFile(path.join(f.root, "spec.json"), JSON.stringify({ title: "Repair fixture", goal: "Reusable skill",
    materials: [{ path: "public.txt", label: "public" }], validators: [], protocolPlugins: f.entry }))
  const runtime = new Runtime().addChecker({ id: "check", version: "1", implementation: "d".repeat(64),
    targets: ["skill"], mechanisms: ["script"], productKinds: ["text"], validate() {} }, async (input) => ({
    status: Buffer.from(input.candidate[0].bytes).toString().includes("repaired") ? "passed" : "rejected", message: "Reusable correction needed" }))
  await runEntry(f.run, f.entry, path.join(f.root, "candidate"), path.join(f.root, "initial"), runtime)
  let calls = 0
  const result = await instanceRepair({ cwd: f.root, sourceTaskRoot: f.root, parentRunRoot: f.run,
    candidateRoot: path.join(f.root, "candidate"), repairRoot: path.join(f.root, "repair"),
    initialReceiptPath: path.join(f.root, "initial", "protocol.receipt.json"), maxAttempts: 2,
    author: { model: "fixture/model", expectedModel: "fixture/model", timeoutMs: 1000, maxInputBytes: 10000, mode: "append_only" } },
    { runtime, createDriver: async () => ({ implementation: "e".repeat(64), preflight: async () => {}, invoke: async (request) => {
      calls++
      expect(request.allowShell).toBe(false)
      expect(request.maxAttempts).toBe(1)
      expect(request.editPaths).toEqual([path.join(request.workDir, "rules.txt")])
      expect(request.readPaths.some((file) => file.includes("author-public"))).toBe(true)
      expect(request.readPaths).not.toContain(path.join(f.root, "public.txt"))
      await writeFile(path.join(request.workDir, "rules.txt"), "Reusable rule\nrepaired")
      return { completed: true, actualModel: "fixture/model", evidence: [] }
    } }) })
  expect(result.fixed).toBe(true)
  expect(calls).toBe(1)
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
  expect(await instanceReplay({ cwd: f.root, sourceTaskRoot: f.root, parentRunRoot: f.run,
    candidateRoot: path.join(f.root, "candidate"), slotDir: path.join(f.root, "slot"), role: "train" }, f.runtime)).toEqual(result)
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
