import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { Runtime } from "./runtime"
import { runEntry } from "./entry"
import { prepareProjectTasks } from "./project-tasks"
import { runProjectBatch, validateProjectBatch, type ProjectBatchConfig } from "./project-batch"
import { runCoordinatorPhase3Validate } from "../multi-instance/validator"

async function fixture(repair = false, failure?: "test_rejection" | "replay_fault", trainCount = 1,
  repairMode: "append_only" | "rewrite" = "append_only") {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  const pack = path.join(root, "pack")
  await mkdir(pack, { recursive: true })
  await writeFile(path.join(pack, "public.txt"), "Public problem")
  const project = { id: "generic", version: "1", skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] }
  const check = { id: "fixture", version: "1", name: "check", required: true, mechanism: "script", settings: {}, feedback: "checker_message" }
  const phase = { claim: "skill_check", checks: [{ ...check, target: "skill", stage: "before_execution" }] }
  const manifestPath = path.join(pack, "manifest.json")
  const selectionPath = path.join(root, "selection.json")
  await writeFile(manifestPath, JSON.stringify({ schema: "aev.project-pack.v1", project,
    skill: { format: "text", entries: [{ id: "rules", kind: "text", path: "rules.txt" }] },
    tasks: [...Array.from({ length: trainCount }, (_, index) => ({ id: index ? `train-${index + 1}` : "train", split: "train" })),
      { id: "test", split: "test" }].map(({ id, split }) => ({ id, split,
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
    targets: ["skill", "product"], mechanisms: ["script"], productKinds: ["text"], validate() {} }, async (input) => {
    checks++
    if (input.phase === "replay" && failure === "replay_fault") return { status: "scoring_error", message: "Fixture scorer unavailable" }
    const required = input.task === "train" ? "repaired" : `repaired-${input.task}`
    const rejected = repair && input.phase === "replay" && !Buffer.from(input.candidate[0].bytes).toString().includes(required)
    return { status: rejected || (input.phase === "test" && failure === "test_rejection") ? "rejected" : "passed", message: `Fixture ${input.task}` }
  }).addExecutor({ id: "fixture-executor", version: "1", implementation: "b".repeat(64), skillFormats: ["text"],
    productKinds: ["text"], materialKinds: ["text"], validate() {} }, async () => {
    answers++; return { status: "completed", product: { kind: "text", bytes: Buffer.from("42") } }
  })
  await prepareProjectTasks({ manifestPath, selectionPath, destination: path.join(root, "prepared"), trainingGoal: "Learn reusable rules" }, runtime)
  const config: ProjectBatchConfig = { schema: "aev.project-batch.v1", tasksPath: path.join(root, "prepared", "project-tasks.json"),
    rounds: 2, fanoutLimit: 1, requireAllSources: true, sourceReplay: true, replayMustPass: true, repairAttempts: 0, finalTest: true,
    pipeline: { schema: "aev.protocol-pipeline.v1", mergeAuthor: { model: "fixture/author", expectedModel: "fixture/author", timeoutMs: 1000, maxInputBytes: 100000 } } }
  if (repair) {
    config.repairAttempts = 2
    config.replayStages = ["initial_replay", "repair_promote", "final_full_replay", "strict_acceptance_gate"]
    config.pipeline.repairAuthor = { model: "fixture/author", expectedModel: "fixture/author", timeoutMs: 1000, maxInputBytes: 100000, mode: repairMode }
  }
  const projectDriver = { async start(input: { specPath: string }) {
    learners++
    const campaignSpec = JSON.parse(await readFile(input.specPath, "utf8"))
    const spec = JSON.parse(await readFile(campaignSpec.baseSpecPath, "utf8"))
    const campaign = path.join(root, `campaign-${spec.protocolPlugins.taskID}`)
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
    invoke: async (request: { editPaths: string[]; prompt: string }) => {
      authors++
      const rule = request.prompt.includes("Fixture train-2") ? "repaired-train-2" : "repaired"
      const body = request.prompt.startsWith("Revise only")
        ? repairMode === "rewrite" ? `Rewritten reusable rule ${rule}` : (await readFile(request.editPaths[0], "utf8")) + "\n" + rule
        : "Merged reusable rules"
      await writeFile(request.editPaths[0], body)
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

test("batch selected hierarchy reaches replay and held-out test with unchanged original sources", async () => {
  const f = await fixture(false, undefined, 3)
  f.input.config.pipeline.mergeStrategy = { kind: "hierarchical", groupSize: 2 }
  const first = await runProjectBatch(f.input, f.dependencies)
  expect(first.status).toBe("completed")
  expect(first.progress.outcomes.merge.contributingInstances).toEqual(["train", "train-2", "train-3"])
  expect(f.counts()).toEqual({ checks: 10, answers: 1, authors: 3, learners: 3 })
  expect((await runProjectBatch(f.input, f.dependencies)).status).toBe("completed")
  expect(f.counts()).toEqual({ checks: 10, answers: 1, authors: 3, learners: 3 })
  await expect(runProjectBatch({ ...f.input, config: { ...f.input.config,
    pipeline: { ...f.input.config.pipeline, mergeStrategy: { kind: "flat" } } } }, f.dependencies))
    .rejects.toThrow("configuration drift")
  expect(f.counts()).toEqual({ checks: 10, answers: 1, authors: 3, learners: 3 })
})

test("batch configuration changes block before additional calls and unsupported repair is explicit", async () => {
  const f = await fixture()
  await runProjectBatch(f.input, f.dependencies)
  await expect(runProjectBatch({ ...f.input, config: { ...f.input.config, rounds: 3 } }, f.dependencies)).rejects.toThrow("configuration drift")
  expect(f.counts()).toEqual({ checks: 4, answers: 1, authors: 1, learners: 1 })
  expect(() => validateProjectBatch({ ...f.input.config, repairAttempts: 1 })).toThrow("explicit repair author")
  expect(() => validateProjectBatch({ ...f.input.config, sourceReplay: false })).toThrow("valid project")
  expect(() => validateProjectBatch({ ...f.input.config, fanoutLimit: 0 })).toThrow("valid project")
})

test("selected rewrite repair changes whole Skill and still requires final replay before test", async () => {
  const f = await fixture(true, undefined, 1, "rewrite")
  const first = await runProjectBatch(f.input, f.dependencies)
  expect(first.status).toBe("completed")
  expect(first.progress.outcomes.replay.repairFixed).toBe(1)
  expect(first.progress.outcomes.replay.finalReplay).toMatchObject({ passed: 1, failed: 0 })
  expect(await readFile(path.join(first.state.mergedSkillDir!, "rules.txt"), "utf8")).toBe("Rewritten reusable rule repaired")
  expect(f.counts()).toEqual({ checks: 6, answers: 1, authors: 2, learners: 1 })
  expect((await runProjectBatch(f.input, f.dependencies)).status).toBe("completed")
  expect(f.counts()).toEqual({ checks: 6, answers: 1, authors: 2, learners: 1 })
})

test("actual batch repairs rejected replay then fully replays before held-out test", async () => {
  const f = await fixture(true)
  const first = await runProjectBatch(f.input, f.dependencies)
  expect(first.status).toBe("completed")
  const replay = first.progress.outcomes.replay
  expect(replay.initialReplay).toMatchObject({ passed: 0, failed: 1 })
  expect(replay.finalReplay).toMatchObject({ passed: 1, failed: 0 })
  expect(replay.repairAttempts).toBe(1)
  expect(replay.repairFixed).toBe(1)
  expect(replay.accepted).toBe(true)
  expect(f.counts()).toEqual({ checks: 6, answers: 1, authors: 2, learners: 1 })
  expect(await readFile(path.join(first.state.mergedSkillDir!, "rules.txt"), "utf8")).toBe("Merged reusable rules\nrepaired")
  const initial = JSON.parse(await readFile(path.join(first.state.runRoot, "protocol-validation-journal/train/initial.snapshot.json"), "utf8"))
  expect(await readFile(path.join(initial.candidateRoot, "rules.txt"), "utf8")).toBe("Merged reusable rules")
  expect((await runProjectBatch(f.input, f.dependencies)).status).toBe("completed")
  expect(f.counts()).toEqual({ checks: 6, answers: 1, authors: 2, learners: 1 })
  const replayAgain = await runCoordinatorPhase3Validate({ cwd: f.root, state: first.state, validateLimit: 1,
    filter: (row) => row.role === "train" && row.status === "passed",
    acceptancePolicy: { stages: f.input.config.replayStages, successCriterion: "all_pass" },
    repair: { enabled: true, mode: "append_only", maxAttemptsPerCase: 2, protocolAuthor: f.input.config.pipeline.repairAuthor } },
    { protocolRuntime: f.dependencies.runtime, createDriver: f.dependencies.createDriver })
  expect(replayAgain.repairAttempts).toBe(1)
  expect(replayAgain.repairFixed).toBe(1)
  expect(replayAgain.initialReplay).toEqual(replay.initialReplay)
  expect(replayAgain.finalReplay).toEqual(replay.finalReplay)
  expect(replayAgain.mergedSkillDir).toBe(replay.mergedSkillDir)
  expect(f.counts()).toEqual({ checks: 6, answers: 1, authors: 2, learners: 1 })
  expect(() => validateProjectBatch({ ...f.input.config, replayStages: ["initial_replay", "made_up"] })).toThrow("replay stages")
  expect(() => validateProjectBatch({ ...f.input.config, replayStages: ["initial_replay"] })).toThrow("replay stages")
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

test("scoring fault cannot trigger repair and held-out rejection never calls author", async () => {
  const fault = await fixture(true, "replay_fault")
  await expect(runProjectBatch(fault.input, fault.dependencies)).rejects.toThrow("infrastructure fault")
  expect(fault.counts()).toEqual({ checks: 3, answers: 0, authors: 1, learners: 1 })
  await expect(runProjectBatch(fault.input, fault.dependencies)).rejects.toThrow()
  expect(fault.counts()).toEqual({ checks: 3, answers: 0, authors: 1, learners: 1 })
  const heldout = await fixture(true, "test_rejection")
  const result = await runProjectBatch(heldout.input, heldout.dependencies)
  expect(result.progress.outcomes.test).toMatchObject({ failed: 1, passed: 0, repairAttempts: 0, repairFixed: 0 })
  expect(heldout.counts()).toEqual({ checks: 6, answers: 1, authors: 2, learners: 1 })
})

test("two-source repair reconstructs ordered promotions from completed evidence after state loss", async () => {
  const f = await fixture(true, undefined, 2)
  const first = await runProjectBatch(f.input, f.dependencies)
  const originalOutcome = first.progress.outcomes.replay
  expect(originalOutcome.initialReplay).toMatchObject({ failed: 2, passed: 0 })
  expect(originalOutcome.finalReplay).toMatchObject({ failed: 0, passed: 2 })
  expect(originalOutcome.repairAttempts).toBe(2)
  expect(f.counts()).toEqual({ checks: 11, answers: 1, authors: 3, learners: 2 })
  const snapshot = JSON.parse(await readFile(path.join(first.state.runRoot, "protocol-validation-journal/train/initial.snapshot.json"), "utf8"))
  // 模拟晋级状态未落盘，已完成作者及验收证据仍保留。
  first.state.mergedSkillDir = snapshot.candidateRoot
  for (const row of first.state.instances.filter((item) => item.role === "train")) {
    row.validateStatus = undefined
    row.validateRunRoot = undefined
    row.validateCampaignDir = undefined
  }
  const resumed = await runCoordinatorPhase3Validate({ cwd: f.root, state: first.state, validateLimit: 1,
    filter: (row) => row.role === "train" && row.status === "passed",
    acceptancePolicy: { stages: f.input.config.replayStages, successCriterion: "all_pass" },
    repair: { enabled: true, mode: "append_only", maxAttemptsPerCase: 2, protocolAuthor: f.input.config.pipeline.repairAuthor } },
    { protocolRuntime: f.dependencies.runtime, createDriver: f.dependencies.createDriver })
  expect(resumed.repairAttempts).toBe(2)
  expect(resumed.repairFixed).toBe(2)
  expect(resumed.initialReplay).toEqual(originalOutcome.initialReplay)
  expect(resumed.finalReplay).toEqual(originalOutcome.finalReplay)
  expect(resumed.mergedSkillDir).toBe(originalOutcome.mergedSkillDir)
  expect(f.counts()).toEqual({ checks: 11, answers: 1, authors: 3, learners: 2 })
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
