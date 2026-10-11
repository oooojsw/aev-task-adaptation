import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { projectCampaign, type ProjectCampaignDriver } from "./project-campaign"
import { instanceSlot } from "../multi-instance/repository"
import { readCandidate } from "./candidate"

async function fixture() {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  const taskRoot = path.join(root, "task")
  await mkdir(taskRoot, { recursive: true })
  await writeFile(path.join(taskRoot, "public.txt"), "Public task")
  const spec = { title: "Generic", goal: "Learn reusable rules", validators: [], materials: [{ label: "public", path: "public.txt" }],
    protocolPlugins: { schema: "aev.protocol-entry.v1", selectionPath: path.join(root, "selection.json"),
      projectManifestPath: path.join(root, "manifest.json"), taskID: "../arbitrary UID", phase: "source" } }
  await writeFile(path.join(taskRoot, "spec.json"), JSON.stringify(spec))
  let starts = 0
  let resumes = 0
  const result = { campaignID: "fixed-id", campaignDir: path.join(root, "actual-campaign"), status: "running", terminal: false }
  const driver: ProjectCampaignDriver = {
    async start(input) {
      starts++
      const campaignSpec = JSON.parse(await readFile(input.specPath, "utf8"))
      expect(campaignSpec.baseSpecPath).toBe(path.join(taskRoot, "spec.json"))
      expect(campaignSpec.maxRounds).toBe(3)
      expect(campaignSpec.mode).toBe("graph_iterative")
      return { ...result }
    },
    async resume(input) { resumes++; expect(input.campaignID).toBe("fixed-id"); return { ...result } },
  }
  return { root, spec, result, driver, counts: () => ({ starts, resumes }), input: { cwd: root, taskRoot,
    taskID: "../arbitrary UID", rounds: 3, launchRoot: path.join(root, "launch") } }
}

test("project Campaign starts existing learner and resumes only recorded identity", async () => {
  const f = await fixture()
  expect((await projectCampaign(f.input, f.driver)).terminal).toBe(false)
  f.result.status = "verified_success"
  f.result.terminal = true
  expect((await projectCampaign(f.input, f.driver)).status).toBe("verified_success")
  expect(f.counts()).toEqual({ starts: 1, resumes: 1 })
  await expect(projectCampaign({ ...f.input, rounds: 4 }, f.driver)).rejects.toThrow("drift")
  expect(f.counts()).toEqual({ starts: 1, resumes: 1 })
})

test("interrupted Campaign launch does not resend and task/test mismatch blocks", async () => {
  const f = await fixture()
  let attempts = 0
  const fail = { ...f.driver, async start() { attempts++; throw new Error("Interrupted after dispatch") } }
  await expect(projectCampaign(f.input, fail)).rejects.toThrow("Interrupted")
  await expect(projectCampaign(f.input, fail)).rejects.toThrow()
  expect(attempts).toBe(1)
  const other = await fixture()
  other.spec.protocolPlugins.phase = "test"
  await writeFile(path.join(other.input.taskRoot, "spec.json"), JSON.stringify(other.spec))
  await expect(projectCampaign(other.input, other.driver)).rejects.toThrow("source task")
  expect(other.counts()).toEqual({ starts: 0, resumes: 0 })
})

test("generic IDs never become filesystem paths while legacy slots remain unchanged", () => {
  const slot = instanceSlot({ id: "../../outside", engine: "protocol_project" })
  expect(slot).toMatch(/^[a-f0-9]{64}$/)
  expect(slot).not.toBe(instanceSlot({ id: "other", engine: "protocol_project" }))
  expect(instanceSlot({ id: "old-task", engine: "skillsbench" })).toBe("old-task")
})

test("declared candidate seed freezes bytes and lineage without inheriting acceptance", async () => {
  const f = await fixture()
  const project = { id: "seed-fixture", version: "1", skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] }
  const skill = { format: "text", entries: [{ id: "skill", kind: "text", path: "rules.txt" }] }
  await writeFile(f.spec.protocolPlugins.projectManifestPath, JSON.stringify({ schema: "aev.project-pack.v1", project, skill,
    tasks: [{ id: f.input.taskID, split: "train", materials: [{ id: "public", kind: "text", path: "task/public.txt" }], privateInputs: [] }] }))
  const source = path.join(f.root, "old-candidate")
  await mkdir(source)
  await writeFile(path.join(source, "rules.txt"), "Reusable old rule")
  await writeFile(path.join(source, "private-answer.json"), "NOT_A_SKILL")
  const candidate = await readCandidate(source, skill)
  const input = { ...f.input, initialCandidate: { root: source, fingerprint: candidate.fingerprint, parentRun: f.root } }
  const driver: ProjectCampaignDriver = { ...f.driver, async start(args) {
    const spec = JSON.parse(await readFile(args.specPath, "utf8"))
    expect(spec.seedTargets).toHaveLength(1)
    expect(await readFile(path.join(spec.seedTargets[0].seedPath, "rules.txt"), "utf8")).toBe("Reusable old rule")
    await expect(readFile(path.join(spec.seedTargets[0].seedPath, "private-answer.json"))).rejects.toThrow()
    return f.driver.start(args)
  } }
  await projectCampaign(input, driver)
  expect(f.counts()).toEqual({ starts: 1, resumes: 0 })
  await projectCampaign(input, driver)
  expect(f.counts()).toEqual({ starts: 1, resumes: 1 })
  await writeFile(path.join(f.input.launchRoot, "initial-candidate/rules.txt"), "Changed frozen seed")
  await expect(projectCampaign(input, driver)).rejects.toThrow("Frozen initial candidate changed")
  expect(f.counts()).toEqual({ starts: 1, resumes: 1 })
})

test("incorrect candidate hash blocks before starting a learner", async () => {
  const f = await fixture()
  const project = { id: "seed-fixture", version: "1", skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] }
  await writeFile(f.spec.protocolPlugins.projectManifestPath, JSON.stringify({ schema: "aev.project-pack.v1", project,
    skill: { format: "text", entries: [{ id: "skill", kind: "text", path: "rules.txt" }] },
    tasks: [{ id: f.input.taskID, split: "train", materials: [{ id: "public", kind: "text", path: "task/public.txt" }], privateInputs: [] }] }))
  const source = path.join(f.root, "candidate")
  await mkdir(source)
  await writeFile(path.join(source, "rules.txt"), "Old rule")
  await expect(projectCampaign({ ...f.input, initialCandidate: { root: source, fingerprint: "0".repeat(64), parentRun: f.root } }, f.driver))
    .rejects.toThrow("fingerprint drift")
  expect(f.counts()).toEqual({ starts: 0, resumes: 0 })
})
