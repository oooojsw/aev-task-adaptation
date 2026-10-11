import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { Runtime } from "./runtime"
import { runEntry } from "./entry"
import { prepareProjectTasks } from "./project-tasks"
import { runProjectBatch, validateProjectBatch, type ProjectBatchConfig } from "./project-batch"
import { runCoordinatorPhase3Validate } from "../multi-instance/validator"

async function fixture() {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  const pack = path.join(root, "pack")
  await mkdir(pack, { recursive: true })
  await writeFile(path.join(pack, "public.txt"), "Public problem")
  const project = { id: "generic", version: "1", skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] }
  const check = { id: "fixture", version: "1", name: "check", required: true, mechanism: "script", settings: {} }
  const phase = { claim: "skill_check", checks: [{ ...check, target: "skill", stage: "before_execution" }] }
  const manifestPath = path.join(pack, "manifest.json")
  const selectionPath = path.join(root, "selection.json")
  await writeFile(manifestPath, JSON.stringify({ schema: "aev.project-pack.v1", project,
    skill: { format: "text", entries: [{ id: "rules", kind: "text", path: "rules.txt" }] },
    tasks: ["train", "test"].map((split) => ({ id: split, split,
      materials: [{ id: "public", kind: "text", path: "public.txt" }], privateInputs: [] })) }))
  await writeFile(selectionPath, JSON.stringify({ schema: "aev.protocol-plugins.v1", project,
    run: { skillFormat: "text", productKind: "text", materialKinds: ["text"] },
    protocol: { id: "fixture", version: "1", phases: { source: phase, merge: phase, replay: phase,
      test: { claim: "task_execution", executor: { id: "fixture-executor", version: "1", settings: {} },
        checks: [{ ...check, target: "product", stage: "after_execution" }] } } } }))
  let checks = 0
  let answers = 0
  let authors = 0
  let learners = 0
  const runtime = new Runtime().addChecker({ id: "fixture", version: "1", implementation: "a".repeat(64),
    targets: ["skill", "product"], mechanisms: ["script"], productKinds: ["text"], validate() {} }, async () => {
    checks++; return { status: "passed", message: "Fixture" }
  }).addExecutor({ id: "fixture-executor", version: "1", implementation: "b".repeat(64), skillFormats: ["text"],
    productKinds: ["text"], materialKinds: ["text"], validate() {} }, async () => {
    answers++; return { status: "completed", product: { kind: "text", bytes: Buffer.from("42") } }
  })
  await prepareProjectTasks({ manifestPath, selectionPath, destination: path.join(root, "prepared"), trainingGoal: "Learn reusable rules" }, runtime)
  const config: ProjectBatchConfig = { schema: "aev.project-batch.v1", tasksPath: path.join(root, "prepared", "project-tasks.json"),
    rounds: 2, fanoutLimit: 1, requireAllSources: true, sourceReplay: true, replayMustPass: true, repairAttempts: 0, finalTest: true,
    pipeline: { schema: "aev.protocol-pipeline.v1", mergeAuthor: { model: "fixture/author", expectedModel: "fixture/author", timeoutMs: 1000, maxInputBytes: 100000 } } }
  const projectDriver = { async start(input: { specPath: string }) {
    learners++
    const campaignSpec = JSON.parse(await readFile(input.specPath, "utf8"))
    const spec = JSON.parse(await readFile(campaignSpec.baseSpecPath, "utf8"))
    const campaign = path.join(root, "campaign")
    const candidate = path.join(campaign, "candidate")
    await mkdir(candidate, { recursive: true })
    await writeFile(path.join(candidate, "rules.txt"), "Reusable rules")
    const attempt = path.join(campaign, "acceptance")
    await runEntry(campaign, spec.protocolPlugins, candidate, attempt, runtime)
    const resultPath = path.join(attempt, "result.json")
    await writeFile(resultPath, JSON.stringify({ passed: true, acceptanceMode: "protocol_plugins", campaignID: "fixed",
      roundNumber: 1, runID: "round1", validationPackageRoot: candidate, protocolReceiptPath: path.join(attempt, "protocol.receipt.json") }))
    await writeFile(path.join(campaign, "campaign.json"), JSON.stringify({ id: "fixed", status: "verified_success", currentRound: 1,
      lastRunID: "round1", lastFinalAcceptancePassed: true, lastFinalAcceptanceResultPath: resultPath }))
    return { campaignID: "fixed", campaignDir: campaign, status: "verified_success", terminal: true }
  }, async resume() { throw new Error("Completed batch must not resume learning") } }
  const createDriver = async () => ({ implementation: "c".repeat(64), preflight: async () => {},
    invoke: async (request: { editPaths: string[] }) => {
      authors++; await writeFile(request.editPaths[0], "Merged reusable rules")
      return { completed: true, actualModel: "fixture/author", evidence: [] }
    } })
  return { root, input: { cwd: root, runRoot: path.join(root, "batch"), config },
    dependencies: { runtime, projectDriver, createDriver }, counts: () => ({ checks, answers, authors, learners }) }
}

test("generic batch traverses real harvest/merge/replay/test and completion resumes without calls", async () => {
  const f = await fixture()
  const first = await runProjectBatch(f.input, f.dependencies)
  expect(first.status).toBe("completed")
  expect(first.progress.stage).toBe("completed")
  expect(first.progress.outcomes).toHaveProperty("learning")
  expect(first.progress.outcomes).toHaveProperty("merge")
  expect(first.progress.outcomes).toHaveProperty("replay")
  expect(first.progress.outcomes).toHaveProperty("test")
  expect(f.counts()).toEqual({ checks: 4, answers: 1, authors: 1, learners: 1 })
  expect((await runProjectBatch(f.input, f.dependencies)).status).toBe("completed")
  expect(f.counts()).toEqual({ checks: 4, answers: 1, authors: 1, learners: 1 })
  await writeFile(path.join(first.state.mergedSkillDir!, "rules.txt"), "Changed deployment")
  await expect(runProjectBatch(f.input, f.dependencies)).rejects.toThrow("deployment drift")
  expect(f.counts()).toEqual({ checks: 4, answers: 1, authors: 1, learners: 1 })
})

test("batch configuration changes block before additional calls and unsupported repair is explicit", async () => {
  const f = await fixture()
  await runProjectBatch(f.input, f.dependencies)
  await expect(runProjectBatch({ ...f.input, config: { ...f.input.config, rounds: 3 } }, f.dependencies)).rejects.toThrow("configuration drift")
  expect(f.counts()).toEqual({ checks: 4, answers: 1, authors: 1, learners: 1 })
  expect(() => validateProjectBatch({ ...f.input.config, repairAttempts: 1 })).toThrow("append-only")
  expect(() => validateProjectBatch({ ...f.input.config, sourceReplay: false })).toThrow("valid project")
  expect(() => validateProjectBatch({ ...f.input.config, fanoutLimit: 0 })).toThrow("valid project")
})

test("actual outer replay resumes initial checkpoint without new checks and blocks altered evidence", async () => {
  const f = await fixture()
  const first = await runProjectBatch(f.input, f.dependencies)
  const input = { cwd: f.root, state: first.state, validateLimit: 1,
    filter: (row: { role: string; status: string }) => row.role === "train" && row.status === "passed",
    repair: { enabled: false, mode: "append_only" as const, maxAttemptsPerCase: 0 } }
  const resumed = await runCoordinatorPhase3Validate(input, { protocolRuntime: f.dependencies.runtime })
  expect(resumed.initialReplay).toEqual(first.progress.outcomes.replay.initialReplay)
  expect(resumed.accepted).toBe(true)
  expect(f.counts()).toEqual({ checks: 4, answers: 1, authors: 1, learners: 1 })
  const row = first.state.instances.find((item) => item.role === "train")!
  const receiptPath = path.join(row.validateRunRoot!, "attempt", "protocol.receipt.json")
  const receipt = await readFile(receiptPath)
  await writeFile(receiptPath, JSON.stringify({ status: "passed" }))
  await expect(runCoordinatorPhase3Validate(input, { protocolRuntime: f.dependencies.runtime })).rejects.toThrow("receipt drift")
  await writeFile(receiptPath, receipt)
  await expect(runCoordinatorPhase3Validate({ ...input, rounds: 3 }, { protocolRuntime: f.dependencies.runtime })).rejects.toThrow("configuration drift")
  await writeFile(path.join(first.state.mergedSkillDir!, "rules.txt"), "Changed original initial candidate")
  await expect(runCoordinatorPhase3Validate(input, { protocolRuntime: f.dependencies.runtime })).rejects.toThrow("candidate drift")
  expect(f.counts()).toEqual({ checks: 4, answers: 1, authors: 1, learners: 1 })
})

test("concurrent batch invocation cannot duplicate learning or overwrite active state", async () => {
  const f = await fixture()
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const hold = new Promise<void>((resolve) => { release = resolve })
  const original = f.dependencies.projectDriver.start
  f.dependencies.projectDriver.start = async (input) => { entered(); await hold; return original(input) }
  const running = runProjectBatch(f.input, f.dependencies)
  await started
  try {
    await expect(runProjectBatch(f.input, f.dependencies)).rejects.toThrow("invocation active")
    expect(f.counts().learners).toBe(0)
  } finally { release() }
  expect((await running).status).toBe("completed")
  expect(f.counts()).toEqual({ checks: 4, answers: 1, authors: 1, learners: 1 })
})

test("prepared task inventory changes cannot silently remove held-out tasks", async () => {
  const f = await fixture()
  const tasks = JSON.parse(await readFile(f.input.config.tasksPath, "utf8"))
  tasks.tasks.pop()
  await writeFile(f.input.config.tasksPath, JSON.stringify(tasks))
  await expect(runProjectBatch(f.input, f.dependencies)).rejects.toThrow("inventory drift")
  expect(f.counts()).toEqual({ checks: 0, answers: 0, authors: 0, learners: 0 })
})
