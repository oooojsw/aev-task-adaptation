import { expect, test } from "bun:test"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Runtime } from "./runtime"
import { prepareEntry, type Entry } from "./entry"
import { runCoordinatorPhase3Validate } from "../multi-instance/validator"
import type { CoordinatorState } from "../multi-instance/contract"

async function fixture(status: "passed" | "rejected" | "scoring_error") {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  const candidate = path.join(root, "merged")
  await mkdir(candidate, { recursive: true })
  await writeFile(path.join(candidate, "rules.txt"), "Reusable rules")
  await writeFile(path.join(root, "public.txt"), "Public task")
  const project = { id: "fixture", version: "1", skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] }
  const phase = { claim: "skill_check", checks: [{ id: "fixture-check", version: "1", name: "check", required: true,
    target: "skill", stage: "before_execution", mechanism: "script", settings: {} }] }
  const entry: Entry = { schema: "aev.protocol-entry.v1", selectionPath: path.join(root, "selection.json"),
    projectManifestPath: path.join(root, "manifest.json"), taskID: "task", phase: "source" }
  await writeFile(entry.selectionPath, JSON.stringify({ schema: "aev.protocol-plugins.v1", project,
    run: { skillFormat: "text", productKind: "text", materialKinds: ["text"] },
    protocol: { id: "fixture", version: "1", phases: { source: phase, replay: phase } } }))
  await writeFile(entry.projectManifestPath, JSON.stringify({ schema: "aev.project-pack.v1", project,
    skill: { format: "text", entries: [{ id: "skill", kind: "text", path: "rules.txt" }] },
    tasks: [{ id: "task", split: "train", materials: [{ id: "public", kind: "text", path: "public.txt" }], privateInputs: [] }] }))
  await writeFile(path.join(root, "spec.json"), JSON.stringify({ title: "Fixture", goal: "Reusable skill",
    materials: [{ label: "public", path: "public.txt" }], validators: [], protocolPlugins: entry }))
  let calls = 0
  const runtime = new Runtime().addChecker({ id: "fixture-check", version: "1", implementation: "a".repeat(64),
    targets: ["skill"], mechanisms: ["script"], productKinds: ["text"], validate() {} }, async () => {
    calls++; return { status, message: "Fixture verdict" }
  })
  const parent = path.join(root, "parent")
  await prepareEntry(parent, entry, runtime)
  const state: CoordinatorState = { id: "fixture", label: "Fixture", phase: "phase2_merge", createdAt: "fixture", updatedAt: "fixture",
    runRoot: path.join(root, "coordinator"), mergedSkillDir: candidate, options: { skillsbenchRoot: root, rounds: 1, fanoutLimit: 1 }, log: [],
    instances: [{ id: "task", sourceTaskRoot: root, engine: "skillsbench", role: "train", status: "passed", rounds: 1, campaignDir: parent }] }
  return { root, runtime, state, calls: () => calls }
}

test("real coordinator records protocol replay and source rejection accurately", async () => {
  for (const status of ["passed", "rejected"] as const) {
    const f = await fixture(status)
    const result = await runCoordinatorPhase3Validate({ cwd: f.root, state: f.state }, { protocolRuntime: f.runtime })
    expect(result.passed).toBe(status === "passed" ? 1 : 0)
    expect(result.failed).toBe(status === "rejected" ? 1 : 0)
    expect(result.regressions).toEqual(status === "rejected" ? ["task"] : [])
    expect(f.state.phase).toBe("completed")
    const run = JSON.parse(await readFile(path.join(f.state.runRoot, "phase3-validate", "task", "run.json"), "utf8"))
    expect(run.executed).toBe(false)
    expect(run.claim).toBe("skill_check")
    expect(f.calls()).toBe(1)
  }
})

test("real coordinator scoring fault stops before repair and never records regression", async () => {
  const f = await fixture("scoring_error")
  await expect(runCoordinatorPhase3Validate({ cwd: f.root, state: f.state,
    repair: { enabled: true, mode: "append_only", maxAttemptsPerCase: 2 } }, { protocolRuntime: f.runtime }))
    .rejects.toThrow("infrastructure fault")
  expect(f.state.phase).toBe("phase3_validate")
  expect(f.state.instances[0].validateProtocolFault).toBe(true)
  expect(f.calls()).toBe(1)
  const run = JSON.parse(await readFile(path.join(f.state.runRoot, "phase3-validate", "task", "run.json"), "utf8"))
  expect(run.protocolStatus).toBe("scoring_error")
  expect(run.infrastructureFailure).toBe(true)
  expect(f.state.log.some((item) => item.message.includes("regression detected"))).toBe(false)
})

test("real coordinator removed protocol cannot start legacy blank execution", async () => {
  const f = await fixture("passed")
  await writeFile(path.join(f.root, "spec.json"), JSON.stringify({ title: "Removed protocol" }))
  await expect(runCoordinatorPhase3Validate({ cwd: f.root, state: f.state }, { protocolRuntime: f.runtime }))
    .rejects.toThrow("infrastructure fault")
  expect(f.calls()).toBe(0)
  expect(f.state.instances[0].validateProtocolFault).toBe(true)
  const saved = JSON.parse(await readFile(path.join(f.state.runRoot, "coordinator-state.json"), "utf8"))
  expect(saved.instances[0].validateProtocolFault).toBe(true)
  expect(saved.phase).toBe("phase3_validate")
})
