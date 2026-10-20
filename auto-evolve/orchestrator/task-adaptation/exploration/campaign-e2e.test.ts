import { expect, test } from "bun:test"
import path from "node:path"
import { randomUUID, createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { buildOfflineCampaign } from "../../protocol-plugins/offline-campaign-fixture"
import { TRAINING_ROLES, type TrainingConfig } from "../../protocol-plugins/training"
import type { OpencodeTaskInput } from "../../opencode"
import { DEFAULT_CONFIG } from "../../schema"
import { catalogue, decision } from "../intake-fixture"
import { compileTask } from "../catalogue"
import { fingerprint } from "../../protocol-plugins/identity"
import { inspectBudget } from "../request-budget"

const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex")

const testEvidenceRoot = () =>
  process.env.AEV_TEST_EVIDENCE_ROOT ||
  (existsSync("E:/project/AEV-task-adaptation-20261016/test-evidence")
    ? "E:/project/AEV-task-adaptation-20261016/test-evidence"
    : path.join(tmpdir(), "aev-test-evidence"))

// 仅替换模型边界；两类任务走同一个真实Campaign、判卷进程和探索闭环。
for (const kind of ["report", "software"] as const) test(`${kind} exploration uses common Campaign and first-pass delivery`, async () => {
  const cwd = path.resolve(import.meta.dir, "../../../..")
  const root = path.join(testEvidenceRoot(), `${kind}-${randomUUID()}`)
  const source = path.join(root, "sources")
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, "candidate.txt"), kind === "report" ? "initial argument" : "function solve() { return 0 }")
  await writeFile(path.join(source, "source.txt"), "Public evidence supports result 42")
  await writeFile(path.join(source, "private.txt"), "PRIVATE_FIXTURE_ORACLE")
  const saved = { ...process.env }, key = `__exploration_${randomUUID().replaceAll("-", "")}`
  const holder = globalThis as Record<string, unknown>
  const calls: string[] = []
  let leads = 0
  let interrupted = false
  try {
    const profile = path.join(root, "profile")
    await mkdir(profile)
    await writeFile(path.join(profile, "opencode.json"), "{}")
    Object.assign(process.env, { AUTO_EVOLVE_RUNTIME_ROOT: path.join(root, "runtime"), AUTO_EVOLVE_SKIP_STALE_HEAL: "1",
      AUTO_EVOLVE_OPENCODE_PRIVATE_PROFILE_ROOT: profile })
    const actual = await buildOfflineCampaign(root, key)
    const config = structuredClone(DEFAULT_CONFIG)
    config.monitorConfig.enabled = false
    config.monitorConfig.autoStart = false
    holder[key] = { async loadConfig() { return config }, async runOpencodeTask(input: OpencodeTaskInput) {
      if (kind === "software" && !interrupted && input.title === "Campaign Worker task-sources round-003") {
        interrupted = true
        throw new Error("Offline new-generation interruption before dispatch")
      }
      calls.push(input.title)
      await input.onSpawn?.()
      if (input.title.startsWith("Campaign Lead")) {
        leads++
        const round = Number(input.title.match(/round-(\d+)/)?.[1])
        const file = input.permissionEditPaths?.[0]
        if (!file) throw new Error("Lead edit grant missing")
        if (round === 3) expect(await readFile(file, "utf8")).toBe(kind === "report" ? "initial argument" : "function solve() { return 0 }")
        await writeFile(file, kind === "report" ? (round === 3 ? "accepted argument" : `rejected argument ${round}`)
          : `function solve() { return ${round === 3 ? 42 : round} }`)
      }
      const responseText = JSON.stringify(input.title.startsWith("Long Task Graph") ? {
        planner_summary: "Inspect frozen sources", completion_validator_ids: [], units: [{ id: "inspect", operation: "author_work",
          title: "Inspect sources", goal: "Inspect source evidence", inputs: [], depends_on: [], expected_artifacts: [],
          claim: "Inspected", check_plan: "Formal acceptance follows", validator_ids: [], retry_budget: 1 }],
      } : { claimed_success: true, claim_statement: "Source inspected", summary: "Offline actor", blockers: [], updated_files: [],
        ready_for_final_acceptance: true, reasons: [], next_attention_areas: [], findings: [], memory_advice: [], package_advice: [],
        exploration_advice: [], refs: [], package_highlights: [], tree_highlights: [], surface_precheck_passed: true, surface_precheck_details: [] })
      return { title: input.title, prompt: input.prompt, selectedModel: input.model, referencedPaths: input.referencePaths ?? [],
        attachedFiles: [], promptInlineFiles: [], permissionReadPaths: input.permissionReadPaths ?? [], permissionEditPaths: input.permissionEditPaths ?? [],
        result: { exitCode: 0, stdout: responseText, stderr: "", events: [], responseText, toolFailures: [] } }
    } }
    const cfg = catalogue(), choice = decision(kind)
    cfg.request = `Produce verified ${kind}`
    cfg.stop = { rounds: 4, calls: 500, tokens: 20000000, stagnant: 4 }
    cfg.profiles = [{ id: kind, description: "Frozen local correctness", kinds: [kind], requires: ["files"],
      acceptance: { execution: kind === "report" ? "none" : "script", checks: [{ id: "quality", target: kind === "report" ? "candidate" : "product",
        mechanism: "script", purpose: "Verify actual result", required: true, resources: ["candidate", "rubric"], feedback: "status_only" }] },
      rejection: [{ check: "quality", actions: ["repair"] }], selection: { rule: "first_pass" } }]
    choice.profiles = [kind]
    choice.workers = [{ id: "sources", purpose: "Read source evidence", resources: ["source"], actions: ["read"] }]
    const compiled = compileTask(cfg, choice)
    if (compiled.status !== "ready") throw new Error("Missing fixture capabilities")
    const plan = { ...compiled.plan, exploration: { schema: "aev.exploration-policy.v1" as const,
      origin: { kind: "initial" as const }, replace: ["candidate"], preserve: [], dependencies: ["source"],
      trigger: { kind: "attempts" as const, observations: 2 }, allowance: { rounds: 2, minimumRounds: 2,
        authorCalls: 200, authorTokens: 3000000, acceptanceCalls: 5, acceptanceTokens: 300000, deliveryCalls: 0, deliveryTokens: 0 },
      bounds: { archiveBytes: 20000000, candidateBytes: 10000, dependencyBytes: 100000 },
      safety: { reset: "declared_entries" as const, effects: "sandbox_only" as const } } }
    const planPath = path.join(root, "plan.json"), script = path.join(root, "check.mjs")
    await writeFile(planPath, JSON.stringify(plan))
    await writeFile(script, 'import {readFileSync} from "node:fs"; const p=JSON.parse(readFileSync(process.argv[2],"utf8")); const t=readFileSync(p.candidate[0].path,"utf8"); const ok=t==="accepted argument" || (t.startsWith("{") && JSON.parse(t).result===42); console.log(JSON.stringify({status:ok?"passed":"rejected",message:ok?"Accepted":"Revise candidate"}));')
    const runner = fileURLToPath(new URL("../../protocol-plugins/sandbox-js-runner.mjs", import.meta.url))
    const input = { intake: { mode: "manual_plan" as const, cwd, root: source, dir: path.join(root, "intake"),
      catalogue: { ...cfg, approvedPlans: [fingerprint(plan)] }, planPath },
      execution: { dir: path.join(root, "execution"), skillFormat: "text" as const, productKind: "json" as const,
        resourceKinds: Object.fromEntries(cfg.resources.map(item => [item.id, "text" as const])),
        ...(kind === "software" ? { executor: { id: "script-json-executor", version: "1", settings: { command: process.execPath,
          commandSHA256: await hash(process.execPath), script: runner, scriptSHA256: await hash(runner), timeoutMs: 10000,
          maxInputBytes: 100000, maxOutputBytes: 4096, executionBoundary: "trusted_host_runner" } } } : {}),
        checkers: [{ name: "quality", binding: { id: "script-json-checker", version: "1", settings: { command: process.execPath,
          commandSHA256: await hash(process.execPath), script, scriptSHA256: await hash(script), timeoutMs: 10000, maxOutputBytes: 4096 } } }],
        training: { schema: "aev.protocol-training.v1", roles: Object.fromEntries(TRAINING_ROLES.map(role => [role, { model: "fixture/actor", timeoutMs: 10000 }])) as TrainingConfig["roles"],
          budgets: { maxAttemptsPerUnit: 1, maxTotalUnitAttempts: 4, maxGraphReplans: 1, maxValidatorCalls: 4, maxNoProgressCycles: 2, maxUnitsPerGraph: 4 } },
        requestBudget: { schema: "aev.task-budget-policy.v1", root: path.join(root, "budget"), scope: kind,
          models: [{ model: "fixture/actor", dialect: "openai_chat", expectedModels: ["actor"], maxInputTokens: 20000, maxOutputTokens: 4096 }] },
        maxBundleBytes: 1000000 } }
    let result = await actual.runTask(input)
    if (kind === "software") {
      expect(interrupted).toBe(true)
      expect(result.status).toBe("failed")
      await writeFile(path.join(root, "interrupted-outcome.json"), JSON.stringify(result, null, 2))
      const file = path.join(result.campaignDir, "campaign.json")
      const state = JSON.parse(await readFile(file, "utf8"))
      const before = JSON.parse(await readFile(path.join(result.campaignDir, "task-adaptation/exploration/host/state.json"), "utf8"))
      expect(before.record.observations.map((item: { branch: string }) => item.branch)).toEqual(["original", "original"])
      // 已返回终态后模拟人工确认接管，保留同一Campaign及内轮现场。
      await writeFile(file, JSON.stringify({ ...state, status: "recovery_pending", ownerPID: undefined,
        ownerCreationTick: undefined, ownerCommandHint: undefined, heartbeatAt: undefined }))
      result = await actual.runTask(input)
      expect(result.campaignID).toBe(state.id)
    }
    await writeFile(path.join(root, "outcome.json"), JSON.stringify(result, null, 2))
    expect(result.status).toBe("verified_success")
    expect(leads).toBe(5)
    const delivery = JSON.parse(await readFile(result.delivery.path, "utf8"))
    expect(await readFile(path.join(path.dirname(result.delivery.path), delivery.files[0].path), "utf8"))
      .toBe(kind === "report" ? "accepted argument" : "function solve() { return 42 }")
    const state = JSON.parse(await readFile(path.join(result.campaignDir, "task-adaptation/exploration/host/state.json"), "utf8"))
    expect(state.record.observations.map((item: { branch: string }) => item.branch)).toEqual(["original", "original", "alternative"])
    expect(state.record.decision.reason).toBe("first_pass")
    const budget = { root: input.execution.requestBudget.root, scope: kind, calls: cfg.stop.calls, tokens: cfg.stop.tokens }
    const before = await inspectBudget(budget), count = calls.length
    const resumed = await actual.runTask(input)
    expect(resumed.delivery).toEqual({ ...result.delivery, reused: true })
    expect(calls).toHaveLength(count)
    expect(await inspectBudget(budget)).toEqual(before)
    const campaign = JSON.parse(await readFile(path.join(result.campaignDir, "campaign.json"), "utf8"))
    const round = path.join(result.campaignDir, "rounds/round-003")
    const files = await import("node:fs/promises").then(fs => fs.readdir(round))
    const generated = files.find(name => name.endsWith("spec.json"))
    if (!generated) throw new Error("Actual round spec missing")
    await expect(actual.runLongTask({ cwd, specPath: path.join(round, generated) })).rejects.toThrow("live Campaign generation lease")
    await expect(actual.resumeLongTask({ cwd, runID: campaign.lastRunID })).rejects.toThrow("live Campaign generation lease")
    expect(calls).toHaveLength(count)
    expect(await inspectBudget(budget)).toEqual(before)
    await writeFile(path.join(root, "summary.json"), JSON.stringify({ externalModelCalls: 0, leads, calls, state }, null, 2))
    console.log(`${kind} common Campaign evidence: ${root}`)
  } finally {
    delete holder[key]
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
    Object.assign(process.env, saved)
  }
}, 300000)

test("report exploration with low-config manual_decision expands V1 and completes offline Campaign", async () => {
  const cwd = path.resolve(import.meta.dir, "../../../..")
  const root = path.join(testEvidenceRoot(), `report-lowconfig-${randomUUID()}`)
  const source = path.join(root, "sources")
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, "candidate.txt"), "initial argument")
  await writeFile(path.join(source, "source.txt"), "Public evidence supports result 42")
  await writeFile(path.join(source, "rubric.txt"), "PRIVATE_FIXTURE_ORACLE")
  const saved = { ...process.env }, key = `__exploration_${randomUUID().replaceAll("-", "")}`
  const holder = globalThis as Record<string, unknown>
  const calls: string[] = []
  let leads = 0
  try {
    const profile = path.join(root, "profile")
    await mkdir(profile)
    await writeFile(path.join(profile, "opencode.json"), "{}")
    Object.assign(process.env, {
      AUTO_EVOLVE_RUNTIME_ROOT: path.join(root, "runtime"),
      AUTO_EVOLVE_SKIP_STALE_HEAL: "1",
      AUTO_EVOLVE_OPENCODE_PRIVATE_PROFILE_ROOT: profile,
    })
    const actual = await buildOfflineCampaign(root, key)
    const config = structuredClone(DEFAULT_CONFIG)
    config.monitorConfig.enabled = false
    config.monitorConfig.autoStart = false
    holder[key] = {
      async loadConfig() { return config },
      async runOpencodeTask(input: OpencodeTaskInput) {
        calls.push(input.title)
        await input.onSpawn?.()
        if (input.title.startsWith("Campaign Lead")) {
          leads++
          const round = Number(input.title.match(/round-(\d+)/)?.[1])
          const file = input.permissionEditPaths?.[0]
          if (!file) throw new Error("Lead edit grant missing")
          if (round === 3) expect(await readFile(file, "utf8")).toBe("initial argument")
          await writeFile(file, round === 3 ? "accepted argument" : `rejected argument ${round}`)
        }
        const responseText = JSON.stringify(input.title.startsWith("Long Task Graph") ? {
          planner_summary: "Inspect frozen sources", completion_validator_ids: [], units: [{ id: "inspect", operation: "author_work",
            title: "Inspect sources", goal: "Inspect source evidence", inputs: [], depends_on: [], expected_artifacts: [],
            claim: "Inspected", check_plan: "Formal acceptance follows", validator_ids: [], retry_budget: 1 }],
        } : { claimed_success: true, claim_statement: "Source inspected", summary: "Offline actor", blockers: [], updated_files: [],
          ready_for_final_acceptance: true, reasons: [], next_attention_areas: [], findings: [], memory_advice: [], package_advice: [],
          exploration_advice: [], refs: [], package_highlights: [], tree_highlights: [], surface_precheck_passed: true, surface_precheck_details: [] })
        return {
          title: input.title, prompt: input.prompt, selectedModel: input.model, referencedPaths: input.referencePaths ?? [],
          attachedFiles: [], promptInlineFiles: [], permissionReadPaths: input.permissionReadPaths ?? [], permissionEditPaths: input.permissionEditPaths ?? [],
          result: { exitCode: 0, stdout: responseText, stderr: "", events: [], responseText, toolFailures: [] },
        }
      },
    }
    const cfg = catalogue(), choice = decision("report")
    cfg.request = "Produce verified report"
    cfg.stop = { rounds: 4, calls: 500, tokens: 20000000, stagnant: 4 }
    cfg.resources = [
      { id: "candidate", path: "candidate.txt", mutable: true, audience: "public" },
      { id: "source", path: "source.txt", mutable: false, audience: "public" },
      { id: "rubric", path: "rubric.txt", mutable: false, audience: "private" },
    ]
    cfg.entries = ["candidate"]
    cfg.profiles = [{
      id: "report", description: "Frozen local correctness", kinds: ["report"], requires: ["files"],
      acceptance: { execution: "none", checks: [{ id: "quality", target: "candidate",
        mechanism: "script", purpose: "Verify actual result", required: true, resources: ["candidate", "rubric"], feedback: "status_only" }] },
      rejection: [{ check: "quality", actions: ["repair"] }], selection: { rule: "first_pass" },
    }]
    choice.profiles = ["report"]
    choice.workers = [{ id: "sources", purpose: "Read source evidence", resources: ["source"], actions: ["read"] }]

    const script = path.join(root, "check.mjs")
    await writeFile(script, 'import {readFileSync} from "node:fs"; const p=JSON.parse(readFileSync(process.argv[2],"utf8")); const t=readFileSync(p.candidate[0].path,"utf8"); const ok=t==="accepted argument"; console.log(JSON.stringify({status:ok?"passed":"rejected",message:ok?"Accepted":"Revise candidate"}));')

    // 使用 manual_decision + explorationRequest，系统自动展开 V1 策略
    const input = {
      intake: {
        mode: "manual_decision" as const,
        cwd,
        root: source,
        dir: path.join(root, "intake"),
        catalogue: cfg,
        decision: choice,
      },
      explorationRequest: { mode: "observations" as const, after: 2 },
      execution: {
        dir: path.join(root, "execution"),
        skillFormat: "text" as const,
        productKind: "json" as const,
        resourceKinds: Object.fromEntries(cfg.resources.map(item => [item.id, "text" as const])),
        checkers: [{ name: "quality", binding: { id: "script-json-checker", version: "1", settings: { command: process.execPath,
          commandSHA256: await hash(process.execPath), script, scriptSHA256: await hash(script), timeoutMs: 10000, maxOutputBytes: 4096 } } }],
        training: { schema: "aev.protocol-training.v1", roles: Object.fromEntries(TRAINING_ROLES.map(role => [role, { model: "fixture/actor", timeoutMs: 10000 }])) as TrainingConfig["roles"],
          budgets: { maxAttemptsPerUnit: 1, maxTotalUnitAttempts: 4, maxGraphReplans: 1, maxValidatorCalls: 4, maxNoProgressCycles: 2, maxUnitsPerGraph: 4 } },
        requestBudget: { schema: "aev.task-budget-policy.v1", root: path.join(root, "budget"), scope: "report",
          models: [{ model: "fixture/actor", dialect: "openai_chat", expectedModels: ["actor"], maxInputTokens: 20000, maxOutputTokens: 4096 }] },
        maxBundleBytes: 1000000,
      },
    }

    const result = await actual.runTask(input)
    expect(result.status).toBe("verified_success")

    // 验证生成的 task-plan.json 包含由 resolveExploration 自动展开的 V1 策略
    const generatedPlan = JSON.parse(await readFile(path.join(root, "intake/task-plan.json"), "utf8"))
    expect(generatedPlan.exploration?.schema).toBe("aev.exploration-policy.v1")
    expect(generatedPlan.exploration?.trigger).toEqual({ kind: "attempts", observations: 2 })

    // 验证 exploration-resolution.json 存在且绑定了模板
    const resolution = JSON.parse(await readFile(path.join(root, "intake/exploration-resolution.json"), "utf8"))
    expect(resolution.schema).toBe("aev.exploration-resolution.v1")
    expect(resolution.template.id).toBe("report-default-exploration")

    // 验证经过 2 轮失败后成功在第 3 轮激活备用路线并通过
    const state = JSON.parse(await readFile(path.join(result.campaignDir, "task-adaptation/exploration/host/state.json"), "utf8"))
    expect(state.record.observations.map((item: { branch: string }) => item.branch)).toEqual(["original", "original", "alternative"])
    expect(state.record.decision.reason).toBe("first_pass")

    // 验证交付成果来自正式挑选的版本
    const delivery = JSON.parse(await readFile(result.delivery.path, "utf8"))
    expect(await readFile(path.join(path.dirname(result.delivery.path), delivery.files[0].path), "utf8")).toBe("accepted argument")

    // 验证同目录恢复完全复用，零新增调用
    const count = calls.length
    const resumed = await actual.runTask(input)
    expect(resumed.delivery).toEqual({ ...result.delivery, reused: true })
    expect(calls).toHaveLength(count)
    console.log(`Report low-config exploration E2E evidence: ${root}`)
  } finally {
    delete holder[key]
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
    Object.assign(process.env, saved)
  }
}, 300000)
