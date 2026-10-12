import { expect, test } from "bun:test"
import { authorContext, protocolRolePrompt, publicMaterialSuffixes, type AuthorContext } from "./author-context"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildCampaignWorkerPrompt, buildCampaignLeadPrompt, buildCampaignReviewerPrompt } from "../long-task-campaign/prompts"

const context: AuthorContext = { fingerprint: "a".repeat(64), projectFingerprint: "b".repeat(64), task: "task",
  phase: "source", claim: "skill_check", skill: { format: "text", entries: [{ id: "skill", kind: "text", path: "rules.txt" }] },
  checks: [{ name: "content", target: "skill", stage: "before_execution", mechanism: "script", required: true }] }
const common = { title: "Fixture", roundNumber: 1, role: "blank_acceptance_diagnostician" as const,
  runTracePath: "E:/trace.json", runTraceDigestPath: "E:/digest.json", pendingPackageRoot: "E:/candidate",
  explorationTreePath: "E:/tree.json", workingMemoryPath: "E:/memory.json", routingControlPath: "E:/routing.json",
  dispatchTicketsPath: "E:/tickets.json", previousPendingPackageRoot: "E:/previous", previousExplorationTreePath: "E:/previous-tree.json",
  previousRoutingControlPath: "E:/previous-routing.json", nextPendingPackageRoot: "E:/next",
  nextExplorationTreePath: "E:/next-tree.json", nextRoutingControlPath: "E:/next-routing.json", workerSuggestionPaths: [] }

test("author-facing view includes inference budget but excludes credential and private inputs", () => {
  const project = { id: "fixture", version: "1", skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] }
  const view = authorContext({ schema: "aev.protocol-entry.v1", selectionPath: "E:/selection.json",
    projectManifestPath: "E:/pack.json", taskID: "task", phase: "source" }, {
    schema: "aev.protocol-snapshot.v1", fingerprint: "a".repeat(64), implementations: { executors: [], checkers: [] },
    selection: { schema: "aev.protocol-plugins.v1", project, run: { skillFormat: "text", productKind: "text", materialKinds: ["text"] },
      protocol: { id: "fixture", version: "1", phases: { source: { claim: "task_execution", executor: {
        id: "http-text-chat", version: "1", settings: { model: "fixture", maxTokens: 123,
          credentialEnv: "PRIVATE_CREDENTIAL_REFERENCE", url: "http://localhost:1/private" } }, checks: [{
        id: "check", version: "1", name: "score", target: "product", stage: "after_execution", mechanism: "script",
        required: true, privateInputs: ["private-gold"], settings: { script: "E:/private-script.py" } }] } } } } },
    { schema: "aev.project-pack-snapshot.v1", root: "E:/pack", fingerprint: "b".repeat(64), artifacts: [],
      pack: { schema: "aev.project-pack.v1", project, skill: context.skill, tasks: [{ id: "task", split: "train",
        materials: [{ id: "public", kind: "text", path: "public.txt" }],
        privateInputs: [{ id: "private-gold", kind: "text", path: "private-gold.json" }] }] } })
  expect(view.executor?.settings.maxTokens).toBe(123)
  expect(view.publicMaterials).toEqual([{ id: "public", kind: "text", path: "E:/pack/public.txt" }])
  expect(JSON.stringify(view)).not.toContain("PRIVATE_CREDENTIAL_REFERENCE")
  expect(JSON.stringify(view)).not.toContain("private-gold")
  expect(JSON.stringify(view)).not.toContain("private-script")
  expect(JSON.stringify(view)).not.toContain("localhost")
})

test("public suffixes expose omitted tail with bounded text and exclude non-text inputs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aev-public-suffix-"))
  try {
    const file = path.join(dir, "public.txt")
    await writeFile(file, "PREFIX_ONLY" + "x".repeat(100000) + "PUBLIC_OUTPUT_CONVENTION")
    const excerpt = await publicMaterialSuffixes({ ...context, publicMaterials: [
      ...Array.from({ length: 6 }, (_, index) => ({ id: String(index), kind: "text", path: file })),
      { id: "binary", kind: "image", path: path.join(dir, "does-not-exist") } ] })
    const entries = JSON.parse(excerpt.slice(excerpt.indexOf("[\n")))
    expect(entries).toHaveLength(4)
    expect(entries.reduce((total: number, entry: { suffix: string }) => total + entry.suffix.length, 0)).toBe(16000)
    expect(entries[0].suffix).toContain("PUBLIC_OUTPUT_CONVENTION")
    expect(entries[0].sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(excerpt).not.toContain("PREFIX_ONLY")
    expect(excerpt).not.toContain("binary")
    expect(await publicMaterialSuffixes(context)).toBe("")
    await expect(publicMaterialSuffixes({ ...context, publicMaterials: [{ id: "missing", kind: "text", path: path.join(dir, "missing") }] })).rejects.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("plugin role prompts use declared entry and do not demand tool evidence or fixed surface contract", () => {
  for (const role of ["worker", "lead", "reviewer"] as const) {
    const prompt = protocolRolePrompt(role, { ...common, protocolContext: context })
    expect(prompt).toContain("rules.txt")
    expect(prompt).toContain("skill_check")
    expect(prompt).toContain("Absent tool traces do not imply failure")
    expect(prompt).toContain("public task instructions override contradictory existing Skill text")
    expect(prompt).toContain("zero legacy completion validators is expected")
    expect(prompt).not.toContain("tool-calls.compact.json")
    expect(prompt).not.toContain("surface_contract.json is a machine-only control file")
    expect(prompt).not.toContain("Each repair item requires at least one file change")
  }
})

test("legacy role prompts remain byte-identical to pre-wiring Git baseline", async () => {
  const result = Bun.spawnSync(["git", "show", "f9b080a:auto-evolve/orchestrator/long-task-campaign/prompts.ts"], { cwd: import.meta.dir })
  expect(result.exitCode).toBe(0)
  const source = new Bun.Transpiler({ loader: "ts" }).transformSync(result.stdout.toString())
  const baseline = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
  for (const [name, current] of [["buildCampaignWorkerPrompt", buildCampaignWorkerPrompt],
    ["buildCampaignLeadPrompt", buildCampaignLeadPrompt], ["buildCampaignReviewerPrompt", buildCampaignReviewerPrompt]] as const) {
    expect(current(common)).toBe(baseline[name](common))
    expect(current({ ...common, blankEvalExecutorKind: "single_turn_http" })).toBe(baseline[name]({ ...common, blankEvalExecutorKind: "single_turn_http" }))
    expect(current({ ...common, protocolContext: context })).toContain("Frozen acceptance contract")
  }
})
