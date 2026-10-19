import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile, lstat, unlink, open } from "node:fs/promises"
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

async function fixture(options?: { cwd: string; checker: string; source: string; recover?: boolean }) {
  const cwd = options?.cwd ?? await mkdtemp(path.join(os.tmpdir(), "aev-exploration-lifecycle-"))
  const root = path.join(cwd, "campaign"), source = path.join(cwd, "source")
  const current = path.join(root, "pending-expert-package/current")
  await mkdir(current, { recursive: true })
  await mkdir(source, { recursive: true })
  const cfg = plan()
  cfg.exploration = policy()
  for (const item of cfg.resources) {
    await writeFile(path.join(source, item.path), item.id === "source" && options ? options.source : `initial ${item.id}`)
    if (cfg.deliverable.entries.includes(item.id)) await writeFile(path.join(current, item.path), `initial ${item.id}`)
  }
  const bound = await bindPlan(source, cfg, [])
  const script = path.join(cwd, "check.mjs")
  await writeFile(script, options?.checker ?? 'import {readFileSync} from "node:fs"; const p=JSON.parse(readFileSync(process.argv[2],"utf8")); const ok=p.candidate.some(x=>x.id==="report" && readFileSync(x.path,"utf8")==="accepted argument"); console.log(JSON.stringify({status:ok?"passed":"rejected",message:ok?"Accepted":"Revise argument"}))')
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
    const result = options?.recover && round === 1
      ? JSON.parse((await readFile(path.join(attemptRoot, "result.json"), "utf8")).replace(/^\uFEFF/, ""))
      : await campaignAcceptance({ cwd, campaignRoot: root, campaignID: "campaign", roundNumber: round,
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

// 显式双开关才发一次真实请求，普通测试保持完全离线。
test.skipIf(process.env.AEV_LIVE_EXPLORATION_SMOKE !== "1")("live candidate bounded lifecycle smoke (one provider send, synthetic control)", async () => {
  const cwd = process.env.AEV_LIVE_EXPLORATION_ROOT
  if (!cwd || !path.isAbsolute(cwd)) throw new Error("Explicit isolated live smoke root required")
  await mkdir(cwd, { recursive: true })
  let recovering = false
  try {
    const claim = await open(path.join(cwd, "live.started.claim"), "wx")
    await claim.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || process.env.AEV_LIVE_EXPLORATION_RECOVER_LOCAL !== "1") throw error
    // 只接续经核实零发送的本地失败，未知或已发送请求一律不重放。
    const ledger = JSON.parse((await readFile(path.join(cwd, "budget/budget.json"), "utf8")).replace(/^\uFEFF/, ""))
    if (!Array.isArray(ledger.attempts) || ledger.attempts.length) throw new Error("Live smoke has prior provider attempt; inspect without retry")
    try { await lstat(path.join(cwd, "response.json")); throw new Error("Live smoke response already exists") }
    catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing }
    recovering = true
  }
  const { budgetedProviderFetch } = await import("../budget-transport")
  const { inspectBudget } = await import("../request-budget")
  const { writeJsonAtomic } = await import("../../atomic-write")
  const profile = "E:/project/AEV-task-adaptation-20261016/real-tasks/report-v1/private-profile"
  const config = JSON.parse((await readFile(path.join(profile, "opencode.json"), "utf8")).replace(/^\uFEFF/, ""))
  const auth = JSON.parse((await readFile(path.join(profile, "auth.json"), "utf8")).replace(/^\uFEFF/, ""))
  const alias = "minimax-cn-coding-plan"
  const base = config.provider?.[alias]?.options?.baseURL
  const secret = auth[alias]?.key
  if (typeof base !== "string" || typeof secret !== "string" || !secret) throw new Error("Original frozen provider profile unavailable")
  const source = "Synthetic supplied measurements, not a benchmark. Method A times: 9,10,11 ms. Method B: 6,7,8 ms. One workload and three repetitions only."
  const checker = 'import {readFileSync} from "node:fs"; const p=JSON.parse(readFileSync(process.argv[2],"utf8")); let ok=false; try {const r=JSON.parse(readFileSync(p.candidate.find(x=>x.id==="report").path,"utf8")); ok=r.meanA===10 && r.meanB===7 && r.reductionPercent===30 && typeof r.limitation==="string" && r.limitation.length>10;} catch {} console.log(JSON.stringify({status:ok?"passed":"rejected",message:ok?"Arithmetic and limitation accepted":"Check means, reduction and limitation"}));'
  const f = await fixture({ cwd, checker, source, recover: recovering })
  const input = { cwd: f.cwd, root: f.root, control: f.control, pass: 1, generation: 0 as const, qualified: false }
  const budget = { root: path.join(cwd, "budget"), scope: "same", calls: 100, tokens: 100000 }
  const endpoint = `${base.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/messages`
  const model = "MiniMax-M2.7"
  const request = { model, max_tokens: 2048, thinking: { type: "disabled" }, messages: [{ role: "user", content:
    source + '\nReturn only JSON with numeric meanA, meanB, reductionPercent (relative to A) and an English limitation string. No markdown.' }] }
  await writeJsonAtomic(path.join(cwd, "protocol.json"), { scope: "mixed-boundary-lifecycle-not-full-campaign", model,
    endpoint, accountAlias: alias, maxExternalSends: 1, maxInputTokens: 4096, maxOutputTokens: 2048,
    synthetic: ["initial two rejected candidates", "author role scheduling"], real: ["one MiniMax candidate", "formal script acceptance", "archive activation selection delivery"],
    reuse: "Existing complete offline Campaigns and old real report retained; this fills only the new live-candidate lifecycle gap", source,
    noHeldOutScore: true, fees: null })
  try {
    if (!recovering) {
      expect((await closeTaskExplorationRound(f.spec, { ...input, round: f.first })).action).toBe("continue")
      await writeFile(path.join(f.current, "report.md"), "second synthetic rejected report")
      const second = await f.evaluate(2)
      expect((await closeTaskExplorationRound(f.spec, { ...input, round: second })).action).toBe("activate")
    } else expect((await readTaskExplorationDecision(f.spec, { root: f.root, round: 2 })).action).toBe("activate")
    await activateTaskBranch(f.spec, f)
    expect(await readFile(path.join(f.current, "report.md"), "utf8")).toBe("initial report")
    await writeJsonAtomic(path.join(cwd, "request.json"), request)
    // claim在发送前落盘；失败保留现场，不重发可能已经计费的请求。
    const response = await budgetedProviderFetch(endpoint, { method: "POST", headers: { "content-type": "application/json",
      "x-api-key": secret, "anthropic-version": "2023-06-01" }, body: JSON.stringify(request), signal: AbortSignal.timeout(120000) },
      { schema: "aev.budget-transport.v1", budget, role: "lead", dialect: "anthropic_messages",
        expectedModels: [model], maxInputTokens: 4096, maxOutputTokens: 2048 }, 4096, fetch, "live-candidate-one-send")
    const text = await response.text()
    await writeJsonAtomic(path.join(cwd, "response.json"), { status: response.status, body: text })
    if (!response.ok) throw new Error(`Live smoke provider HTTP ${response.status}; inspect isolated response, no retry`)
    const reply = JSON.parse(text)
    expect(reply.model).toBe(model)
    const body = reply.content.filter((item: { type: string }) => item.type === "text").map((item: { text: string }) => item.text).join("").trim()
    await writeFile(path.join(f.current, "report.md"), body)
    const third = await f.evaluate(3)
    expect(third.finalAcceptanceSignal?.passed).toBe(true)
    const acceptance = { passed: true, summary: "Real model candidate passed frozen arithmetic checker",
      protocolTrainingResultPath: third.finalAcceptanceSignal!.feedbackPath }
    const closed = await completeTaskRound(f.spec, { cwd, root: f.root, candidateRoot: f.current, round: 3, maxRounds: 7,
      record: third, acceptance, state: { currentRound: 2 } as LongTaskCampaignState, control: f.control, generation: 1 })
    expect(closed.taskSelection?.passed).toBe(true)
    const delivered = await exportTaskDelivery(f.spec, { root: f.root,
      selectedTaskVersionPath: closed.taskSelection!.selectedTaskVersionPath!, dir: path.join(cwd, "delivery") })
    const before = await inspectBudget(budget)
    expect(before.admittedAttempts).toBe(1)
    expect(before.unresolvedAttempts).toBe(0)
    const reused = await exportTaskDelivery(f.spec, { root: f.root,
      selectedTaskVersionPath: closed.taskSelection!.selectedTaskVersionPath!, dir: path.join(cwd, "delivery") })
    expect(reused.reused).toBe(true)
    expect(await inspectBudget(budget)).toEqual(before)
    await writeJsonAtomic(path.join(cwd, "completion.json"), { status: "passed", budget: before, delivery: delivered,
      boundary: "Hybrid lifecycle validation, not full real multi-Agent Campaign or efficacy experiment" })
    console.log(`Live candidate lifecycle evidence: ${cwd}`)
  } finally { f.control.close() }
}, 180000)

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
