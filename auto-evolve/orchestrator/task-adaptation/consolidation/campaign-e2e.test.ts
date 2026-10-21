import { expect, test } from "bun:test"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { buildOfflineCampaign } from "../../protocol-plugins/offline-campaign-fixture"
import { consolidationCatalogue } from "./profile"
import { digest } from "./contract"
import { TRAINING_ROLES, type TrainingConfig } from "../../protocol-plugins/training"
import { runOpencodeTask, type OpencodeTaskInput } from "../../opencode"
import { DEFAULT_CONFIG } from "../../schema"
import { inspectBudget, reserveRequest } from "../request-budget"
import { compileTask } from "../catalogue"
import { fingerprint } from "../../protocol-plugins/identity"
import { harvest } from "../../protocol-plugins/harvest"

type Message = { role: string; content?: unknown }
type Body = { model: string; stream?: boolean; messages: Message[]; tools?: Array<{ function?: { name?: string } }> }
type Action = { name: string; args: Record<string, unknown> }

const testEvidenceRoot = () =>
  process.env.AEV_TEST_EVIDENCE_ROOT ||
  (existsSync("E:/project/AEV-task-adaptation-20261016/test-evidence")
    ? "E:/project/AEV-task-adaptation-20261016/test-evidence"
    : path.join(tmpdir(), "aev-test-evidence"))

// 只使用回环假服务，真实控制器、预算、判卷进程和受限工具不替换。
for (const mode of ["original", "recovery", "exploration", "v2", "ten", "meter"] as const) test(`unified consolidation ${mode} runs real restricted tools and delivers best round`, async () => {
  const recovery = mode === "recovery", exploration = mode === "exploration" || mode === "v2"
  const targets = mode === "ten" ? [38, 43, 41, 45, 44, 46, 40, 47, 46, 44] : [38, 43, 41]
  const evaluationsExpected = exploration ? 100 : new Set(targets).size * 50
  const cwd = path.resolve(import.meta.dir, "../../../..")
  const root = path.join(testEvidenceRoot(), `consolidation-${randomUUID()}`)
  await mkdir(root, { recursive: true })
  const sources = path.join(root, "sources")
  const profile = path.join(root, "profile")
  await mkdir(sources)
  await mkdir(profile)
  const saved = { ...process.env }
  const key = `__consolidation_${randomUUID().replaceAll("-", "")}`
  const holder = globalThis as Record<string, unknown>
  const invocations = new Map<string, { input: OpencodeTaskInput; target: number; stage: number; reads: number; oversized: boolean }>()
  const calls: Array<{ title: string; round?: number; pass?: string; cases: number }> = []
  const errors: string[] = []
  let evaluations = 0
  let leads = 0
  let origins = 0
  let interrupted = false
  function reply(body: Body, content: string, actions: Action[] = []) {
    const id = randomUUID()
    const tools = actions.map((action, index) => ({ index, id: `call_${randomUUID()}`, type: "function",
      function: { name: action.name, arguments: JSON.stringify(action.args) } }))
    const finish = tools.length ? "tool_calls" : "stop"
    const usage = { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 }
    if (!body.stream) return Response.json({ id, model: body.model, choices: [{ index: 0,
      message: { role: "assistant", content: tools.length ? null : content, ...(tools.length ? { tool_calls: tools } : {}) }, finish_reason: finish }], usage })
    const frames = [{ id, model: body.model, object: "chat.completion.chunk", created: 0,
      choices: [{ index: 0, delta: { role: "assistant", ...(tools.length ? { tool_calls: tools } : { content }) }, finish_reason: null }] },
    { id, model: body.model, object: "chat.completion.chunk", created: 0, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { id, model: body.model, object: "chat.completion.chunk", created: 0, choices: [], usage }]
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    try {
      const body = await req.json() as Body
      const text = JSON.stringify(body.messages)
      if (body.model === "consumer") {
        evaluations++
        const target = Number(text.match(/ROUND_TARGET=(\d+)/)?.[1])
        const index = Number(text.match(/Synthetic question (\d+)/)?.[1])
        if (!target || !Number.isSafeInteger(index)) throw new Error("Missing actual candidate or question")
        return reply(body, `<answer>${index < target ? 42 : 0}</answer>`)
      }
      const id = text.match(/OFFLINE_INVOCATION:([a-f0-9-]+)/)?.[1]
      const item = id ? invocations.get(id) : undefined
      if (!item || body.model !== "actor") throw new Error("Unknown offline actor")
      if (text.includes("PRIVATE_FIXTURE_ORACLE")) throw new Error("Private oracle leaked")
      const grant = item.input.resourceReaderGrant
      const tools = body.tools?.map(tool => tool.function?.name) ?? []
      if (Boolean(grant) !== tools.includes("aev_read_resource")) throw new Error("Reader tool grant mismatch")
      if (grant && item.stage === 0 && mode !== "ten") {
        item.stage++
        return reply(body, "", grant.allowedCaseIDs.map(caseID => ({ name: "aev_read_resource", args: { resourceID: grant.resourceID, caseID } })))
      }
      if (grant && item.stage === 1 && mode !== "ten") {
        const replies = body.messages.filter(message => message.role === "tool")
        if (replies.length !== 50 || replies.some(message => !JSON.stringify(message.content).includes('Synthetic question'))) throw new Error("Did not actually read all 50 feedback cases")
        item.reads = replies.length
        item.stage++
      }
      if (item.input.title.startsWith("Campaign Lead") && item.stage < 3) {
        item.stage = 3
        const file = item.input.permissionEditPaths?.[0]
        if (!file) throw new Error("Lead candidate grant missing")
        return reply(body, "", [{ name: "read", args: { filePath: file } }])
      }
      if (item.input.title.startsWith("Campaign Lead") && item.stage === 3) {
        item.stage = 4
        const file = item.input.permissionEditPaths?.[0]
        if (!file) throw new Error("Lead candidate grant missing")
        return reply(body, "", [{ name: "write", args: { filePath: file,
          content: `Use public evidence and give one answer. ROUND_TARGET=${item.target}` + (item.oversized ? "x".repeat(5001) : "") } }])
      }
      item.stage = 5
      return reply(body, JSON.stringify({ summary: "Offline source analysis", updated_files: item.input.permissionEditPaths ?? [],
        package_highlights: [], tree_highlights: [], refs: [], surface_precheck_passed: true,
        surface_precheck_details: [], findings: [], memory_advice: [], package_advice: [], exploration_advice: [] }))
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "offline failure")
      return Response.json({ error: { message: errors.at(-1) } }, { status: 400 })
    }
  } })
  try {
    await writeFile(path.join(profile, "opencode.json"), JSON.stringify({ provider: { fixture: {
      npm: "@ai-sdk/openai-compatible", name: "Local consolidation fixture", options: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "offline-only" },
      models: { actor: { id: "actor", name: "actor", tool_call: true, reasoning: false,
        limit: { context: 131072, output: 4096 }, modalities: { input: ["text"], output: ["text"] } } } } } }))
    Object.assign(process.env, { AUTO_EVOLVE_OPENCODE_PRIVATE_PROFILE_ROOT: profile,
      AUTO_EVOLVE_RUNTIME_ROOT: path.join(root, "runtime"), AUTO_EVOLVE_SKIP_STALE_HEAL: "1",
      AUTO_EVOLVE_OPENCODE_CLEAN_RUNTIME: "false", OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", AEV_OFFLINE_CONSUMER_KEY: "offline-only" })
    const actual = await buildOfflineCampaign(root, key)
    const config = structuredClone(DEFAULT_CONFIG)
    config.monitorConfig.enabled = false
    config.monitorConfig.autoStart = false
    holder[key] = { async loadConfig() { return config }, async runOpencodeTask(input: OpencodeTaskInput) {
      // 在发出新模型请求前模拟已审计中断，保留第一轮完整判卷。
      if (recovery && !interrupted && input.title === "Campaign Worker task-sources round-002") {
        interrupted = true
        throw new Error("Offline interruption before dispatch")
      }
      if (input.title.startsWith("Campaign Lead")) leads++
      if (exploration && input.title.startsWith("Campaign Lead") && input.title.includes("round-003") && leads === 3) {
        origins++
        expect(await readFile(input.permissionEditPaths![0], "utf8")).toContain("ROUND_TARGET=1")
      }
      await input.onSpawn?.()
      if (input.title.startsWith("Campaign Lead") || input.resourceReaderGrant) {
        const id = randomUUID()
        const round = Number(input.title.match(/round-(\d+)/)?.[1])
        const item = { input, target: targets[round - 1], stage: 0, reads: 0,
          oversized: recovery && leads === 1 || exploration && round === 3 }
        invocations.set(id, item)
        const result = await runOpencodeTask({ ...input, cwd, prompt: input.prompt + `\nOFFLINE_INVOCATION:${id}`,
          recordAdaptiveConcurrency: false, runtimeBudget: { profile: "short", hardTimeoutMs: 120000, silentTimeoutMs: 90000 } })
        await writeFile(path.join(root, `host-${id}.json`), JSON.stringify(result))
        if (result.result.exitCode !== 0) throw new Error(`Actual source host failed: ${id}`)
        // 退出成功不能替代工具成功和候选正文核验。
        if (result.result.toolFailures.length) throw new Error(`Actual tool failed: ${id}`)
        if (input.title.startsWith("Campaign Lead")) {
          expect(await readFile(input.permissionEditPaths![0], "utf8")).toContain(`ROUND_TARGET=${item.target}`)
        }
        calls.push({ title: input.title, round: input.resourceReaderGrant?.round, pass: input.resourceReaderGrant?.passID, cases: item.reads })
        await writeFile(path.join(root, "calls.json"), JSON.stringify(calls, null, 2))
        return result
      }
      if (input.resourceReaderGrant) throw new Error("Unrouted reader")
      const responseText = JSON.stringify(input.title.startsWith("Long Task Graph") ? {
        planner_summary: "Inspect frozen source Skills", completion_validator_ids: [], units: [{ id: "inspect", operation: "author_work",
          title: "Inspect sources", goal: "Inspect reusable rules", inputs: [], depends_on: [], expected_artifacts: [],
          claim: "Inspected", check_plan: "Formal host acceptance follows", validator_ids: [], retry_budget: 1 }] } : {
        claimed_success: true, claim_statement: "Offline exploration complete", summary: "Sources inspected", blockers: [], updated_files: [],
        ready_for_final_acceptance: true, reasons: [], next_attention_areas: [], findings: [], memory_advice: [], package_advice: [], exploration_advice: [], refs: [] })
      return { title: input.title, prompt: input.prompt, selectedModel: input.model, referencedPaths: input.referencePaths ?? [], attachedFiles: [], promptInlineFiles: [],
        permissionReadPaths: input.permissionReadPaths ?? [], permissionEditPaths: input.permissionEditPaths ?? [],
        result: { exitCode: 0, stdout: responseText, stderr: "", events: [], responseText, toolFailures: [] } }
    } }
    const ids = Array.from({ length: 50 }, (_, i) => `case_${i}`)
    const rows = []
    for (const id of ids) {
      const file = `${id}.md`
      await writeFile(path.join(sources, file), `Reusable source guidance for ${id}`)
      rows.push({ id, caseID: id, path: file, sha256: digest(await readFile(path.join(sources, file))) })
    }
    await writeFile(path.join(sources, "source-manifest.json"), JSON.stringify({ schema: "aev.consolidation-sources.v1", sources: rows }))
    await writeFile(path.join(sources, "DIRECT_CHAT.md"), "Initial reusable guidance. ROUND_TARGET=1")
    const catalogue = await consolidationCatalogue({ root: sources, manifest: "source-manifest.json", cases: ids,
      id: "offline-consolidation", objective: "Consolidate frozen Skills into reusable guidance", stop: { rounds: targets.length, calls: 2000, tokens: exploration || mode === "ten" ? 50000000 : 10000000, stagnant: targets.length } })
    const validator = path.join(root, "validator.mjs")
    await writeFile(validator, 'import {readFileSync} from "node:fs"; const file=process.argv[process.argv.indexOf("--candidate")+1]; console.log(JSON.stringify({passed:readFileSync(file,"utf8").trim()==="42"}));')
    const dataset = path.join(root, "cases.jsonl")
    await writeFile(dataset, ids.map((caseID, i) => JSON.stringify({ schema: "direct-chat-case/v1", caseID, dataset: "synthetic", split: "train",
      question: { text: `Synthetic question ${i}`, outputInstruction: "Return one number" },
      materials: [{ id: "m", title: "public", type: "text", content: `Public ${i}` }],
      materialAudit: { caseID, expectedSources: [], includedMaterials: ["m"], omittedSources: [], warnings: [], tokenEstimate: 5, compressionPolicy: "none" },
      privateOracle: { validatorID: "private-fixture", runner: "bun", scriptPath: validator, args: ["--candidate", ""], candidateArgName: "--candidate" } })).join("\n") + "\n")
    const models = path.join(root, "models.json")
    await writeFile(models, JSON.stringify({ models: { consumer: { transport: "openai-compatible", model: "consumer",
      baseURL: `http://127.0.0.1:${server.port}/v1`, apiKeyEnv: "AEV_OFFLINE_CONSUMER_KEY", contextWindowTokens: 32768, maxOutputTokens: 128, temperature: 0 } } }))
    const common = { candidateID: "merged_skill", maxChars: 5000, expectedCases: 50, modelID: "consumer", datasetSHA256: digest(await readFile(dataset)) }
    const input = { intake: { mode: "manual_decision", cwd, root: sources, dir: path.join(root, "intake"), catalogue,
      decision: { kind: "skill", profiles: ["multi_skill_consolidation_v1"], needs: [],
        workers: [{ id: "sources", purpose: "Analyze source and training feedback", resources: catalogue.resources.map(item => item.id), actions: ["read"] }], rationale: "Offline consolidation" } },
      execution: { dir: path.join(root, "execution"), skillFormat: "text", productKind: "json",
        resourceKinds: Object.fromEntries(catalogue.resources.map(item => [item.id, "text"])),
        executor: { id: "consolidation-direct-chat", version: "1", settings: { ...common, datasetPath: dataset, modelsPath: models,
          modelsSHA256: digest(await readFile(models)), concurrency: mode === "ten" ? 10 : 2 } },
        checkers: ["consolidation_surface", "consolidation_score"].map(name => ({ name, binding: { id: "consolidation-checker", version: "1", settings: common } })),
        training: { schema: "aev.protocol-training.v1", roles: Object.fromEntries(TRAINING_ROLES.map(role => [role, { model: "fixture/actor", timeoutMs: 120000 }])) as TrainingConfig["roles"],
          budgets: { maxAttemptsPerUnit: 1, maxTotalUnitAttempts: 4, maxGraphReplans: 1, maxValidatorCalls: 4, maxNoProgressCycles: 2, maxUnitsPerGraph: 4 } },
        requestBudget: { schema: "aev.task-budget-policy.v1", root: path.join(root, "budget"), scope: "offline-consolidation",
          ...(mode === "meter" ? { mode: "meter_only" as const } : {}),
          models: [{ model: "fixture/actor", dialect: "openai_chat", expectedModels: ["actor"], maxInputTokens: 131072, maxOutputTokens: 4096 },
            { model: "consumer", dialect: "openai_chat", expectedModels: ["consumer"], maxInputTokens: 10000, maxOutputTokens: 128 }] }, maxBundleBytes: 1000000 } }
    const compiled = compileTask(catalogue, input.intake.decision)
    if (compiled.status !== "ready") throw new Error("Fixture Plan missing capabilities")
    const preset = { ...structuredClone(compiled.plan), ...(exploration ? { exploration: {
      schema: "aev.exploration-policy.v1", origin: { kind: "initial" }, replace: ["merged_skill"], preserve: [],
      dependencies: catalogue.resources.filter(item => !item.mutable).map(item => item.id),
      trigger: { kind: "attempts", observations: 2 }, allowance: { rounds: 1, minimumRounds: 1,
        authorCalls: 200, authorTokens: 3000000, acceptanceCalls: 60, acceptanceTokens: 7000000,
        deliveryCalls: 0, deliveryTokens: 0 }, bounds: { archiveBytes: 20000000, candidateBytes: 10000, dependencyBytes: 100000 },
      safety: { reset: "declared_entries", effects: "sandbox_only" },
    } } : {}) }
    const selected = mode === "v2" ? { ...preset, exploration: {
      ...preset.exploration!, schema: "aev.exploration-policy.v2",
      window: { minimumRounds: 1, maximumRounds: 2 },
      trigger: { kind: "metric", name: compiled.plan.selection.metric, direction: compiled.plan.selection.direction,
        minimumDelta: 0.2, minimumObservations: 2, patience: 1 }, budget: { mode: "best_effort" },
    } } : preset
    const planPath = path.join(root, "exploration-plan.json")
    if (exploration) await writeFile(planPath, JSON.stringify(selected))
    const launch = exploration ? { ...input, intake: { mode: "manual_plan", cwd, root: sources,
      dir: input.intake.dir, catalogue: { ...catalogue, approvedPlans: [fingerprint(selected)] }, planPath } } : input
    let result = await actual.runTask(launch)
    let preserved: { path: string; manifest: string; file: string; content: string } | undefined
    if (recovery) {
      await writeFile(path.join(root, "interrupted-result.json"), JSON.stringify(result, null, 2))
      expect(result.status).toBe("failed")
      expect(evaluations).toBe(50)
      const manifest = await readFile(result.delivery.path, "utf8")
      const delivered = path.join(path.dirname(result.delivery.path), JSON.parse(manifest).files[0].path)
      preserved = { path: result.delivery.path, manifest, file: delivered, content: await readFile(delivered, "utf8") }
      expect(preserved.content).toContain("ROUND_TARGET=38")
      const rejected = JSON.parse(await readFile(path.join(result.campaignDir, "rounds/round-001/final-acceptance/pass-01/protocol.receipt.json"), "utf8"))
      expect(rejected.status).toBe("rejected")
      expect(rejected.executionAttempted).toBe(false)
      const file = path.join(result.campaignDir, "campaign.json")
      const state = JSON.parse(await readFile(file, "utf8"))
      // 仅夹具记录已核验接管，不清空请求账本或旧正式回执。
      await writeFile(file, JSON.stringify({ ...state, status: "recovery_pending", ownerPID: undefined,
        ownerCommandHint: undefined, ownerCreationTick: undefined, heartbeatAt: undefined,
        recovery: { action: "harvest_round_run", roundNumber: 2, runID: state.lastRunID,
          reason: "Offline audited interruption before request", detectedAt: new Date().toISOString() } }))
      result = await actual.runTask(launch)
    }
    await writeFile(path.join(root, "outcome.json"), JSON.stringify(result, null, 2))
    expect(errors).toEqual([])
    expect(result.status).toBe("verified_success")
    expect(leads).toBe(recovery || exploration ? 4 : targets.length)
    expect(evaluations).toBe(evaluationsExpected)
    const records = await readdir(path.join(result.campaignDir, "task-adaptation/versions"))
    const versions = await Promise.all(records.map(async name => JSON.parse(await readFile(path.join(result.campaignDir, "task-adaptation/versions", name, "record.json"), "utf8"))))
    expect(versions.sort((a, b) => a.round - b.round).map(row => row.metric))
      .toEqual(exploration ? [38 / 50, 43 / 50] : targets.map(value => value / 50))
    const delivery = JSON.parse(await readFile(result.delivery.path, "utf8"))
    expect(await readFile(path.join(path.dirname(result.delivery.path), delivery.files[0].path), "utf8")).toContain(`ROUND_TARGET=${Math.max(...targets)}`)
    if (preserved) {
      expect(result.delivery.path).not.toBe(preserved.path)
      expect(await readFile(preserved.path, "utf8")).toBe(preserved.manifest)
      expect(await readFile(preserved.file, "utf8")).toBe(preserved.content)
    }
    expect(calls.filter(item => item.cases === 50)).toHaveLength(mode === "ten" ? 0 : exploration ? 2 : 4)
    expect(calls.filter(item => item.title.startsWith("Campaign Lead") && item.round).every(item => item.pass === "pass-01")).toBe(true)
    const budget = { root: input.execution.requestBudget.root, scope: input.execution.requestBudget.scope,
      calls: catalogue.stop.calls, tokens: catalogue.stop.tokens, ...(mode === "meter" ? { mode: "meter_only" as const } : {}) }
    const before = await inspectBudget(budget)
    if (mode === "meter") expect(before.effectiveLimits).toEqual({ calls: null, tokens: null })
    const resumed = await actual.runTask(launch)
    const after = await inspectBudget(budget)
    expect(resumed.delivery).toEqual({ ...result.delivery, reused: true })
    expect(evaluations).toBe(evaluationsExpected)
    expect(leads).toBe(recovery || exploration ? 4 : targets.length)
    expect(after).toEqual(before)
    if (exploration) {
      expect(origins).toBe(1)
      const saved = JSON.parse(await readFile(path.join(result.campaignDir, "task-adaptation/exploration/host/state.json"), "utf8"))
      expect((mode === "v2" ? saved.record.rounds : saved.record.observations).map((item: { branch: string }) => item.branch)).toEqual(["original", "original", "alternative"])
      if (mode === "v2") {
        expect(saved.record.rounds.slice(0, 2).map((item: { metric: { value: number } }) => item.metric.value)).toEqual([38 / 50, 43 / 50])
        expect(saved.record.rounds[0].metric.comparison).toBe(saved.record.rounds[1].metric.comparison)
        expect(saved.record.rounds[2].metric).toBeUndefined()
      }
      expect(saved.record.decision.reason).toBe("global_limit")
      const targetRoot = path.join(root, "harvested")
      await harvest({ cwd, campaignRoot: result.campaignDir, taskID: compiled.plan.id, targetRoot })
      expect(await readFile(path.join(targetRoot, "DIRECT_CHAT.md"), "utf8")).toContain("ROUND_TARGET=43")
      await harvest({ cwd, campaignRoot: result.campaignDir, taskID: compiled.plan.id, targetRoot })
      expect(evaluations).toBe(100)
      const file = path.join(result.campaignDir, "campaign.json")
      const state = JSON.parse(await readFile(file, "utf8"))
      expect(state.lastFinalAcceptancePassed).toBe(false)
      // 用真实准入拒绝证明预算终态，拒绝本身不制造请求或费用。
      const ledger = JSON.parse(await readFile(path.join(budget.root, "budget.json"), "utf8"))
      const gate = ledger.gates.at(-1)
      await expect(reserveRequest(budget, { id: randomUUID(), request: "a".repeat(64),
        role: gate.policy.roles[0], model: "consumer", reservationTokens: budget.tokens, gate: gate.id })).rejects.toThrow("exhausted")
      await writeFile(file, JSON.stringify({ ...state, taskStopReason: "request_token_budget" }))
      const limited = path.join(root, "harvested-budget-stop")
      await harvest({ cwd, campaignRoot: result.campaignDir, taskID: compiled.plan.id, targetRoot: limited })
      expect(await readFile(path.join(limited, "DIRECT_CHAT.md"), "utf8")).toContain("ROUND_TARGET=43")
      await writeFile(file, JSON.stringify({ ...state, taskStopReason: "request_call_budget" }))
      await expect(harvest({ cwd, campaignRoot: result.campaignDir, taskID: compiled.plan.id,
        targetRoot: path.join(root, "harvested-false-stop") })).rejects.toThrow("budget evidence drift")
      await writeFile(file, JSON.stringify(state))
    }
    await writeFile(path.join(root, "summary.json"), JSON.stringify({ passed: true, externalModelCalls: 0, evaluations, calls, versions, errors }, null, 2))
    console.log(`Consolidation full chain evidence: ${root}`)
  } finally {
    server.stop(true)
    delete holder[key]
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
    Object.assign(process.env, saved)
  }
}, mode === "ten" ? 1800000 : 600000)
