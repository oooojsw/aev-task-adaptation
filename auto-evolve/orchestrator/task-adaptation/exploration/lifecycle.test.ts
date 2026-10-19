import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile, lstat, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import type { LongTaskSpec } from "../../long-task/contract"
import type { LongTaskCampaignRoundRecord } from "../../long-task-campaign/contract"
import { fingerprint } from "../../protocol-plugins/identity"
import { selectedRuntime } from "../../protocol-plugins/selected-runtime"
import { campaignAcceptance, readCompletedCampaignPass } from "../../protocol-plugins/campaign-acceptance"
import { completeTaskRound } from "../../long-task-campaign/round-control"
import type { LongTaskCampaignState } from "../../long-task-campaign/contract"
import { bindPlan } from "../binding"
import { taskFeedback } from "../feedback"
import { exportTaskDelivery } from "../delivery"
import { plan, policy } from "./policy.test"
import { openTaskCampaignControl } from "./ownership"
import { freezeTaskOrigin } from "./origin"
import { openTaskGeneration, assertTaskGeneration } from "./generation"
import { activateTaskBranch, closeTaskExplorationRound, readTaskExplorationDecision, taskBranchStart } from "./lifecycle"

const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex")

async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aev-exploration-lifecycle-"))
  const root = path.join(cwd, "campaign"), source = path.join(cwd, "source")
  const current = path.join(root, "pending-expert-package/current")
  await mkdir(current, { recursive: true })
  await mkdir(source)
  const cfg = plan()
  cfg.exploration = policy()
  for (const item of cfg.resources) {
    await writeFile(path.join(source, item.path), `initial ${item.id}`)
    if (cfg.deliverable.entries.includes(item.id)) await writeFile(path.join(current, item.path), `initial ${item.id}`)
  }
  const bound = await bindPlan(source, cfg, [])
  const script = path.join(cwd, "check.mjs")
  await writeFile(script, 'import {readFileSync} from "node:fs"; const p=JSON.parse(readFileSync(process.argv[2],"utf8")); const ok=p.candidate.some(x=>x.id==="report" && readFileSync(x.path,"utf8")==="accepted argument"); console.log(JSON.stringify({status:ok?"passed":"rejected",message:ok?"Accepted":"Revise argument"}))')
  const project = { id: "report", version: "1", skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] }
  const selectionPath = path.join(cwd, "selection.json"), projectManifestPath = path.join(cwd, "project.json")
  await writeFile(selectionPath, JSON.stringify({ schema: "aev.protocol-plugins.v1", project,
    run: { skillFormat: "text", productKind: "text", materialKinds: ["text"] },
    protocol: { id: "report-check", version: "1", phases: { source: { claim: "skill_check", checks: [
      { id: "script-json-checker", version: "1", name: "quality", target: "skill", stage: "before_execution",
        mechanism: "script", required: true, settings: { command: process.execPath, commandSHA256: await hash(process.execPath),
          script, scriptSHA256: await hash(script), timeoutMs: 10000, maxOutputBytes: 4096 } },
    ] } } } }))
  await writeFile(projectManifestPath, JSON.stringify({ schema: "aev.project-pack.v1", project,
    skill: { format: "text", entries: [{ id: "report", kind: "text", path: "report.md" }, { id: "facts", kind: "text", path: "facts.md" }] },
    tasks: [{ id: "report", split: "train", materials: [], privateInputs: [] }] }))
  const entry = { schema: "aev.protocol-entry.v1" as const, selectionPath, projectManifestPath, taskID: "report", phase: "source" as const }
  const runtime = await selectedRuntime(path.join(root, "protocol-backends"), cwd, entry)
  const spec = { taskAdaptationContext: bound, taskAdaptationCampaignRoot: root, protocolPlugins: entry,
    taskAdaptation: { schema: "aev.task-adaptation.v1", root: source, planPath: path.join(cwd, "plan.json"), capabilities: [],
      entries: [{ id: "report", path: "report.md" }, { id: "facts", path: "facts.md" }],
      requestBudget: { schema: "aev.task-budget-policy.v1", root: path.join(cwd, "budget"), scope: "same",
        models: [{ model: "fixture", dialect: "openai_chat", expectedModels: ["fixture"], maxInputTokens: 100, maxOutputTokens: 100 }] } },
  } as LongTaskSpec
  const baseSpecPath = path.join(cwd, "spec.json")
  await writeFile(path.join(root, "campaign.json"), JSON.stringify({ id: "campaign", baseSpecPath, status: "recovery_pending", currentRound: 1 }))
  async function evaluate(round: number, pass = 1) {
    const roundID = `round-${String(round).padStart(3, "0")}`
    const passID = `pass-${String(pass).padStart(2, "0")}`
    const attemptRoot = path.join(root, "rounds", roundID, "final-acceptance", passID)
    const result = await campaignAcceptance({ cwd, campaignRoot: root, campaignID: "campaign", roundNumber: round,
      runID: `author-${round}-${pass}`, entry, candidateRoot: current, attemptRoot, resultPath: path.join(attemptRoot, "result.json"),
      taskBinding: { planFingerprint: bound.fingerprint, policyFingerprint: fingerprint({ windows: cfg.windows, workers: cfg.workers }) } }, runtime)
    const reference = { root, path: result.protocolTrainingResultPath, task: "report", phase: "source" as const }
    spec.protocolAuthorContext = { fingerprint: (await taskFeedback(bound, reference)).view.protocolFingerprint } as LongTaskSpec["protocolAuthorContext"]
    const record: LongTaskCampaignRoundRecord = { roundNumber: round, roundID, roundSpecPath: baseSpecPath,
      sourceRunID: `author-${round}-${pass}`, sourceRunDir: cwd, finalStatus: "failed", summary: `Formal local report rejection pass ${pass}`,
      failurePacketCount: 0, retryLessonCount: 0, learningUnitCount: 0, roundSummaryPath: path.join(attemptRoot, "summary.md"),
      snapshotPaths: [], createdAt: new Date().toISOString(), roundClosure: result.passed ? "closed_success" : "closed_repairable",
      finalAcceptanceSignal: { executed: true, passed: result.passed, failedValidatorIDs: [], feedbackPath: reference.path } }
    return record
  }
  const first = await evaluate(1)
  const control = (await openTaskCampaignControl(spec, { root, campaign: "campaign", baseSpecPath }))!
  await freezeTaskOrigin(spec, { root, control, create: true })
  return { cwd, root, current, spec, control, first, evaluate }
}

test("formal no-execution report closes rounds and activation recovery preserves new branch edits", async () => {
  const f = await fixture()
  try {
    const input = { cwd: f.cwd, root: f.root, control: f.control, pass: 1, generation: 0 as const, qualified: false }
    expect((await closeTaskExplorationRound(f.spec, { ...input, round: f.first })).action).toBe("continue")
    await writeFile(path.join(f.current, "report.md"), "failed argument two")
    await writeFile(path.join(f.current, "facts.md"), "new verified fact")
    const second = await f.evaluate(2)
    const decision = await closeTaskExplorationRound(f.spec, { ...input, round: second })
    expect(decision.action).toBe("activate")
    expect(await closeTaskExplorationRound(f.spec, { ...input, round: second })).toEqual(decision)
    const tickets = path.join(f.root, "dispatch-tickets.json")
    const old = '{"tickets":[{"issue":"Old algorithm must be repaired"}]}'
    await writeFile(tickets, old)
    expect(await taskBranchStart(f.spec, f.root)).toBe(1)
    const result = await activateTaskBranch(f.spec, f)
    expect(result?.nextRound).toBe(3)
    expect(await taskBranchStart(f.spec, f.root)).toBe(3)
    expect(JSON.parse(await readFile(tickets, "utf8")).tickets).toEqual([])
    const views = JSON.parse(await readFile(path.join(f.root, "task-adaptation/exploration/host/local-views.intent.json"), "utf8"))
    expect(Buffer.from(views.record.files.find((item: { name: string }) => item.name === "dispatch-tickets.json").before, "base64").toString()).toBe(old)
    expect(await readFile(path.join(f.current, "report.md"), "utf8")).toBe("initial report")
    expect(await readFile(path.join(f.current, "facts.md"), "utf8")).toBe("new verified fact")
    const projection = path.join(f.root, "task-adaptation/exploration/host/projection.json")
    const before = await lstat(projection)
    await writeFile(path.join(f.current, "report.md"), "new branch work after activation")
    await writeFile(tickets, '{"tickets":[{"issue":"New branch issue"}]}')
    expect(await activateTaskBranch(f.spec, f)).toEqual(result)
    expect(await readFile(path.join(f.current, "report.md"), "utf8")).toBe("new branch work after activation")
    expect((await lstat(projection)).mtimeMs).toBe(before.mtimeMs)
    expect(JSON.parse(await readFile(tickets, "utf8")).tickets[0].issue).toBe("New branch issue")
    const lease = await openTaskGeneration(f.spec, f)
    expect(lease.generation).toBe(1)
    f.spec.taskAdaptationCampaignRoot = f.root
    expect(() => assertTaskGeneration(f.spec)).toThrow("live Campaign generation lease")
    expect(() => assertTaskGeneration(f.spec, { ...lease })).toThrow("live Campaign generation lease")
    expect(() => assertTaskGeneration(f.spec, lease)).not.toThrow()
    lease.close()
    expect(() => assertTaskGeneration(f.spec, lease)).toThrow("live Campaign generation lease")
    await writeFile(path.join(f.current, "report.md"), "accepted argument")
    const third = await f.evaluate(3)
    expect(third.finalAcceptanceSignal?.passed).toBe(true)
    const final = await closeTaskExplorationRound(f.spec, { ...input, round: third, generation: 1, qualified: true })
    expect(final).toMatchObject({ action: "finish", reason: "first_pass" })
    expect(final.observations.map(item => item.branch)).toEqual(["original", "original", "alternative"])
    expect(await readTaskExplorationDecision(f.spec, { root: f.root, round: 3 })).toEqual(final)
  } finally { f.control.close() }
}, 30000)

test("Campaign round cap stops before activation even when Plan permits later rounds", async () => {
  const f = await fixture()
  try {
    const input = { cwd: f.cwd, root: f.root, control: f.control, pass: 1, generation: 0 as const, qualified: false, maxRounds: 2 }
    await closeTaskExplorationRound(f.spec, { ...input, round: f.first })
    await writeFile(path.join(f.current, "report.md"), "failed alternative argument")
    const result = await closeTaskExplorationRound(f.spec, { ...input, round: await f.evaluate(2) })
    expect(result).toMatchObject({ action: "finish", reason: "global_limit" })
    expect(await readTaskExplorationDecision(f.spec, { root: f.root, round: 2 })).toEqual(result)
    expect(await activateTaskBranch(f.spec, f)).toBeUndefined()
    await expect(lstat(path.join(f.root, "task-adaptation/exploration/activation/activation.json"))).rejects.toThrow()
  } finally { f.control.close() }
}, 30000)

test("shared round close repairs history-only boundary and reuses decisions after current changes", async () => {
  const f = await fixture()
  try {
    const state = JSON.parse(await readFile(path.join(f.root, "campaign.json"), "utf8")) as LongTaskCampaignState
    async function close(record: LongTaskCampaignRoundRecord, generation: 0 | 1, verify = true) {
      const resultPath = record.finalAcceptanceSignal!.feedbackPath!.replace(/\.training\.json$/, "")
      const acceptance = verify ? await readCompletedCampaignPass({ campaignRoot: f.root, cwd: f.cwd,
        campaignID: "campaign", roundNumber: record.roundNumber, runID: record.sourceRunID,
        entry: f.spec.protocolPlugins!, candidateRoot: f.current, resultPath })
        : JSON.parse(await readFile(resultPath, "utf8"))
      return completeTaskRound(f.spec, { cwd: f.cwd, root: f.root, candidateRoot: f.current,
        round: record.roundNumber, maxRounds: 7, record, acceptance, state, control: f.control, generation })
    }
    expect((await close(f.first, 0)).nextStatus).toBe("running")
    await writeFile(path.join(f.current, "report.md"), "different rejection")
    const second = await f.evaluate(2)
    const result = await close(second, 0)
    expect(result.restart).toBe(true)
    await activateTaskBranch(f.spec, f)
    await writeFile(path.join(f.current, "report.md"), "new branch edits")
    expect((await close(second, 0, false)).restart).toBe(true)
    expect(await readFile(path.join(f.current, "report.md"), "utf8")).toBe("new branch edits")
    await writeFile(path.join(f.current, "report.md"), "accepted argument")
    const third = await f.evaluate(3)
    const final = await close(third, 1)
    expect(final.state.status).toBe("verified_success")
    expect(final.state.selectedTaskVersionPath).toBeDefined()
    expect(final.state.lastFinalAcceptanceResultPath).toBe(third.finalAcceptanceSignal!.feedbackPath!.replace(/\.training\.json$/, ""))
    const dir = path.join(f.cwd, "delivery")
    const delivery = await exportTaskDelivery(f.spec, { root: f.root,
      selectedTaskVersionPath: final.state.selectedTaskVersionPath!, dir })
    expect(delivery.reused).toBe(false)
    const manifest = JSON.parse(await readFile(delivery.path, "utf8"))
    const delivered = path.join(dir, manifest.files[0].path)
    const bytes = await readFile(delivered)
    for (const stage of ["temporary", "delivery.intent.json", "report.md", "delivery.json"]) {
      const target = path.join(f.cwd, `delivery-${stage.replaceAll(".", "-")}`)
      const input = { root: f.root, selectedTaskVersionPath: final.state.selectedTaskVersionPath!, dir: target }
      const file = path.join(f.cwd, "delivery-child.json")
      await writeFile(file, JSON.stringify({ spec: f.spec, input }))
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/delivery-interruption.ts"), file, stage], { stdout: "pipe", stderr: "pipe" })
      const reader = child.stdout.getReader()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([(async () => {
          let text = ""
          for (;;) {
            const value = await reader.read()
            if (value.done) throw new Error("Delivery child exited before checkpoint")
            text += new TextDecoder().decode(value.value)
            if (text.includes("delivery-checkpoint")) return
          }
        })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Delivery checkpoint timeout")), 10000) })])
      } finally {
        if (timer) clearTimeout(timer)
        child.kill()
        await child.exited
        reader.releaseLock()
      }
      const recovered = await exportTaskDelivery(f.spec, input)
      expect(JSON.parse(await readFile(recovered.path, "utf8")).version).toBe(final.state.selectedTaskVersionPath)
      expect(await readFile(path.join(target, "files/report.md"))).toEqual(bytes)
      expect((await exportTaskDelivery(f.spec, input)).reused).toBe(true)
    }
    await unlink(delivery.path)
    await unlink(delivered)
    expect((await exportTaskDelivery(f.spec, { root: f.root,
      selectedTaskVersionPath: final.state.selectedTaskVersionPath!, dir })).reused).toBe(false)
    expect(await readFile(delivered)).toEqual(bytes)
    expect((await exportTaskDelivery(f.spec, { root: f.root,
      selectedTaskVersionPath: final.state.selectedTaskVersionPath!, dir })).reused).toBe(true)
    await writeFile(path.join(f.current, "report.md"), "later working contents")
    const reused = await close(third, 1, false)
    expect(reused.state.selectedTaskVersionPath).toBe(final.state.selectedTaskVersionPath)
    expect(reused.state.taskStopReason).toBe("first_pass")
  } finally { f.control.close() }
}, 30000)

test("round-002 pass-01 failure into pass-02 interruption and recovery reuses decision and preserves single restart opportunity", async () => {
  const f = await fixture()
  try {
    const input = { cwd: f.cwd, root: f.root, control: f.control, pass: 1, generation: 0 as const, qualified: false }

    // Round 1 fails and continues
    const firstDecision = await closeTaskExplorationRound(f.spec, { ...input, round: f.first })
    expect(firstDecision.action).toBe("continue")

    // Round 2 pass-01 fails
    await writeFile(path.join(f.current, "report.md"), "failed round 2 pass 1")
    const round2Pass1 = await f.evaluate(2, 1)
    expect(round2Pass1.finalAcceptanceSignal?.passed).toBe(false)

    // Pass-02 in round 2: candidate is updated, closed, and stagnation trigger fires activation
    await writeFile(path.join(f.current, "report.md"), "failed round 2 pass 2 candidate")
    const round2Pass2 = await f.evaluate(2, 2)
    const pass2Input = { ...input, pass: 2, round: round2Pass2 }
    const decisionBeforeInterruption = await closeTaskExplorationRound(f.spec, pass2Input)
    expect(decisionBeforeInterruption.action).toBe("activate")

    // Interrupted recovery replay: re-calling closeTaskExplorationRound reuses exact persisted decision and observations
    const decisionAfterRecovery = await closeTaskExplorationRound(f.spec, pass2Input)
    expect(decisionAfterRecovery).toEqual(decisionBeforeInterruption)
    expect(decisionAfterRecovery.identity).toBe(decisionBeforeInterruption.identity)
    expect(decisionAfterRecovery.observations).toHaveLength(2)

    // Verify persisted decision on disk matches exactly
    const persisted = await readTaskExplorationDecision(f.spec, { root: f.root, round: 2 })
    expect(persisted).toEqual(decisionBeforeInterruption)

    // Activation switches to alternative branch exactly once
    const activation = await activateTaskBranch(f.spec, f)
    expect(activation?.nextRound).toBe(3)
    expect(await taskBranchStart(f.spec, f.root)).toBe(3)

    // Repeated activation replay after recovery is idempotent and never grants a second restart
    const secondActivation = await activateTaskBranch(f.spec, f)
    expect(secondActivation).toEqual(activation)
    expect(await taskBranchStart(f.spec, f.root)).toBe(3)

    // Candidate identity preserved across recovery
    expect(await readFile(path.join(f.current, "report.md"), "utf8")).toBe("initial report")
  } finally { f.control.close() }
}, 30000)
