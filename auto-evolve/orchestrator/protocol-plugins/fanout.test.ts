import { expect, test } from "bun:test"
import { mkdir, writeFile, readFile, access } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Runtime } from "./runtime"
import { runEntry, type Entry } from "./entry"
import { createCoordinatorRun, runCoordinatorPhase1Fanout } from "../multi-instance/coordinator"
import { instanceSlot } from "../multi-instance/repository"
import type { ProjectCampaignDriver } from "./project-campaign"

async function fixture() {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  const taskRoot = path.join(root, "task")
  const campaign = path.join(root, "accepted-campaign")
  const candidate = path.join(campaign, "candidate")
  await mkdir(candidate, { recursive: true })
  await mkdir(taskRoot)
  await writeFile(path.join(root, "public.txt"), "Public task")
  await writeFile(path.join(candidate, "rules.txt"), "Reusable rule")
  await writeFile(path.join(candidate, "internal.txt"), "Must not harvest")
  const id = "../../arbitrary UID"
  const project = { id: "generic", version: "1", skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] }
  const phase = { claim: "skill_check", checks: [{ id: "fixture", version: "1", name: "content", required: true,
    target: "skill", stage: "before_execution", mechanism: "script", settings: {} }] }
  const entry: Entry = { schema: "aev.protocol-entry.v1", selectionPath: path.join(root, "selection.json"),
    projectManifestPath: path.join(root, "manifest.json"), taskID: id, phase: "source" }
  await writeFile(entry.selectionPath, JSON.stringify({ schema: "aev.protocol-plugins.v1", project,
    run: { skillFormat: "text", productKind: "text", materialKinds: ["text"] },
    protocol: { id: "fixture", version: "1", phases: { source: phase } } }))
  await writeFile(entry.projectManifestPath, JSON.stringify({ schema: "aev.project-pack.v1", project,
    skill: { format: "text", entries: [{ id: "rules", kind: "text", path: "rules.txt" }] },
    tasks: [{ id, split: "train", materials: [{ id: "public", kind: "text", path: "public.txt" }], privateInputs: [] }] }))
  await writeFile(path.join(taskRoot, "spec.json"), JSON.stringify({ title: "Source", goal: "Learn reusable rule",
    materials: [{ label: "public", path: path.join(root, "public.txt") }], validators: [], protocolPlugins: entry }))
  let checks = 0
  const runtime = new Runtime().addChecker({ id: "fixture", version: "1", implementation: "a".repeat(64),
    targets: ["skill"], mechanisms: ["script"], productKinds: ["text"], validate() {} }, async () => {
    checks++; return { status: "passed", message: "Fixture" }
  })
  const attempt = path.join(campaign, "actual-acceptance")
  await runEntry(campaign, entry, candidate, attempt, runtime)
  const resultPath = path.join(attempt, "result.json")
  await writeFile(resultPath, JSON.stringify({ passed: true, acceptanceMode: "protocol_plugins", campaignID: "fixed",
    roundNumber: 1, runID: "round1", validationPackageRoot: candidate, protocolReceiptPath: path.join(attempt, "protocol.receipt.json") }))
  await writeFile(path.join(campaign, "campaign.json"), JSON.stringify({ id: "fixed", status: "verified_success",
    currentRound: 1, lastRunID: "round1", lastFinalAcceptancePassed: true, lastFinalAcceptanceResultPath: resultPath }))
  const state = await createCoordinatorRun({ cwd: root, runRoot: path.join(root, "coordinator"), label: "Generic",
    rounds: 2, fanoutLimit: 1, instances: [
      { id, sourceTaskRoot: taskRoot, engine: "protocol_project", skillsbenchRoot: "", taskID: id },
      { id: "test UID", sourceTaskRoot: taskRoot, engine: "protocol_project", skillsbenchRoot: "", taskID: "test UID", role: "test" } ] })
  let starts = 0
  let resumes = 0
  const reply = { campaignID: "fixed", campaignDir: campaign, status: "verified_success", terminal: true }
  const driver: ProjectCampaignDriver = { async start() { starts++; return { ...reply } },
    async resume(input) { resumes++; expect(input.campaignID).toBe("fixed"); return { ...reply } } }
  return { root, state, candidate, runtime, driver, reply, counts: () => ({ starts, resumes, checks }) }
}

test("actual fanout harvests verified declared entries and skips held-out training", async () => {
  const f = await fixture()
  const input = { cwd: f.root, state: f.state }
  const deps = { projectDriver: f.driver, protocolRuntime: f.runtime }
  const summary = await runCoordinatorPhase1Fanout(input, deps)
  expect(summary).toMatchObject({ passed: 1, skipped: 1, running: 0 })
  const row = f.state.instances[0]
  expect(row.harvestedSkillPath).toBe(path.join(f.state.runRoot, "phase1-fanout", instanceSlot(row), "protocol-skill"))
  expect(await readFile(path.join(row.harvestedSkillPath!, "rules.txt"), "utf8")).toBe("Reusable rule")
  await expect(access(path.join(row.harvestedSkillPath!, "internal.txt"))).rejects.toThrow()
  await runCoordinatorPhase1Fanout(input, deps)
  expect(f.counts()).toEqual({ starts: 1, resumes: 0, checks: 1 })
})

test("actual fanout retains live Campaign and resumes it before harvesting", async () => {
  const f = await fixture()
  f.reply.terminal = false
  f.reply.status = "running"
  const input = { cwd: f.root, state: f.state }
  const deps = { projectDriver: f.driver, protocolRuntime: f.runtime }
  expect(await runCoordinatorPhase1Fanout(input, deps)).toMatchObject({ running: 1, exhausted: 0, failed: 0 })
  expect(f.state.instances[0].harvestedSkillPath).toBeUndefined()
  f.reply.terminal = true
  f.reply.status = "verified_success"
  expect(await runCoordinatorPhase1Fanout(input, deps)).toMatchObject({ passed: 1, running: 0 })
  expect(f.counts()).toEqual({ starts: 1, resumes: 1, checks: 1 })
})

test("actual fanout refuses changed accepted Skill and zero concurrency", async () => {
  const f = await fixture()
  await writeFile(path.join(f.candidate, "rules.txt"), "Changed after acceptance")
  expect(await runCoordinatorPhase1Fanout({ cwd: f.root, state: f.state }, { projectDriver: f.driver, protocolRuntime: f.runtime }))
    .toMatchObject({ failed: 1, passed: 0 })
  expect(f.state.instances[0].harvestedSkillPath).toBeUndefined()
  f.state.options.fanoutLimit = 0
  await expect(runCoordinatorPhase1Fanout({ cwd: f.root, state: f.state }, { projectDriver: f.driver })).rejects.toThrow("positive integer")
})
