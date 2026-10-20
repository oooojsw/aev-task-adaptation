import { expect, test } from "bun:test"
import path from "node:path"
import { randomUUID, createHash } from "node:crypto"
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises"
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

// 只替换作者模型；正式运行器实际执行候选，判卷、换路和交付均走原链。
for (const mode of ["improve", "preserve", "min"] as const) test(`V2 metric common Campaign: ${mode}`, async () => {
  const cwd = path.resolve(import.meta.dir, "../../../..")
  const root = path.join(process.env.AEV_TEST_EVIDENCE_ROOT ?? path.join(tmpdir(), "aev-test-evidence"), `metric-${mode}-${randomUUID()}`)
  const source = path.join(root, "sources"), profile = path.join(root, "profile")
  await mkdir(source, { recursive: true })
  await mkdir(profile)
  const initial = "function solve() { return 0 }"
  await writeFile(path.join(source, "candidate.txt"), initial)
  await writeFile(path.join(source, "source.txt"), "Frozen public specification")
  await writeFile(path.join(source, "private.txt"), "PRIVATE_FIXTURE_ORACLE")
  await writeFile(path.join(profile, "opencode.json"), "{}")
  const saved = { ...process.env }, key = `__metric_${randomUUID().replaceAll("-", "")}`
  const holder = globalThis as Record<string, unknown>, calls: string[] = []
  const scores = mode === "min" ? [50, 49, 49, 60, 20] : mode === "preserve" ? [50, 51, 51, 40, 45] : [50, 51, 51, 40, 80]
  let interrupted = false, switched = false
  try {
    Object.assign(process.env, { AUTO_EVOLVE_RUNTIME_ROOT: path.join(root, "runtime"),
      AUTO_EVOLVE_SKIP_STALE_HEAL: "1", AUTO_EVOLVE_OPENCODE_PRIVATE_PROFILE_ROOT: profile })
    const actual = await buildOfflineCampaign(root, key), config = structuredClone(DEFAULT_CONFIG)
    config.monitorConfig.enabled = false
    config.monitorConfig.autoStart = false
    holder[key] = { async loadConfig() { return config }, async runOpencodeTask(input: OpencodeTaskInput) {
      if (mode === "preserve" && !interrupted && input.title === "Campaign Worker task-sources round-004") {
        interrupted = true
        throw new Error("Offline interruption before new-branch dispatch")
      }
      calls.push(input.title)
      await input.onSpawn?.()
      if (input.title.startsWith("Campaign Lead")) {
        const round = Number(input.title.match(/round-(\d+)/)?.[1]), file = input.permissionEditPaths?.[0]
        if (!file || !scores[round - 1]) throw new Error("Unexpected author invocation")
        if (round === 4 && !switched) {
          expect(await readFile(file, "utf8")).toBe(initial)
          const match = file.match(/^(.*long-task-campaigns[\\/][^\\/]+)/)
          if (!match) throw new Error("Campaign path missing")
          const state = JSON.parse(await readFile(path.join(match[1], "task-adaptation/exploration/host/state.json"), "utf8"))
          expect(state.record.decision.reason).toBe("metric_stagnation")
          expect(state.record.rounds.map((item: { metric: { value: number } }) => item.metric.value)).toEqual(scores.slice(0, 3))
          switched = true
        }
        await writeFile(file, `function solve() { return ${scores[round - 1]} }`)
      }
      const responseText = JSON.stringify(input.title.startsWith("Long Task Graph") ? {
        planner_summary: "Inspect source", completion_validator_ids: [], units: [{ id: "inspect", operation: "author_work",
          title: "Inspect", goal: "Inspect public source", inputs: [], depends_on: [], expected_artifacts: [],
          claim: "Inspected", check_plan: "Formal checking follows", validator_ids: [], retry_budget: 1 }],
      } : { claimed_success: true, claim_statement: "Inspected", summary: "Offline actor", blockers: [], updated_files: [],
        ready_for_final_acceptance: true, reasons: [], next_attention_areas: [], findings: [], memory_advice: [], package_advice: [],
        exploration_advice: [], refs: [], package_highlights: [], tree_highlights: [], surface_precheck_passed: true, surface_precheck_details: [] })
      return { title: input.title, prompt: input.prompt, selectedModel: input.model, referencedPaths: input.referencePaths ?? [],
        attachedFiles: [], promptInlineFiles: [], permissionReadPaths: input.permissionReadPaths ?? [], permissionEditPaths: input.permissionEditPaths ?? [],
        result: { exitCode: 0, stdout: responseText, stderr: "", events: [], responseText, toolFailures: [] } }
    } }
    const cfg = catalogue(), choice = decision("software")
    cfg.stop = { rounds: 6, calls: 1000, tokens: 50000000, stagnant: 1 }
    cfg.profiles = [{ id: "software", description: "Actual numeric execution", kinds: ["software"], requires: ["files"],
      acceptance: { execution: "script", checks: [{ id: "quality", target: "product", mechanism: "script", purpose: "Check computed result",
        required: true, resources: ["candidate", "rubric"], feedback: "status_only" }] }, rejection: [{ check: "quality", actions: ["repair"] }],
      selection: { rule: "best_pass", metric: "result", direction: mode === "min" ? "min" : "max" } }]
    choice.profiles = ["software"]
    choice.workers = [{ id: "sources", purpose: "Inspect source", resources: ["source"], actions: ["read"] }]
    const compiled = compileTask(cfg, choice)
    if (compiled.status !== "ready") throw new Error("Fixture not ready")
    const plan = { ...compiled.plan, exploration: { schema: "aev.exploration-policy.v2" as const,
      origin: { kind: "initial" as const }, replace: ["candidate"], preserve: [], dependencies: ["source"],
      window: { minimumRounds: 1, maximumRounds: 4 },
      trigger: { kind: "metric" as const, name: "result", direction: mode === "min" ? "min" as const : "max" as const,
        minimumDelta: 3, minimumObservations: 3, patience: 2 },
      allowance: { rounds: 2, minimumRounds: 1, authorCalls: 200, authorTokens: 3000000,
        acceptanceCalls: 5, acceptanceTokens: 300000, deliveryCalls: 0, deliveryTokens: 0 },
      budget: { mode: "best_effort" as const }, bounds: { archiveBytes: 20000000, candidateBytes: 10000, dependencyBytes: 100000 },
      safety: { reset: "declared_entries" as const, effects: "sandbox_only" as const } } }
    const planPath = path.join(root, "plan.json"), script = path.join(root, "check.mjs")
    await writeFile(planPath, JSON.stringify(plan))
    await writeFile(script, 'import {readFileSync} from "node:fs"; const p=JSON.parse(readFileSync(process.argv[2],"utf8")); const v=JSON.parse(readFileSync(p.candidate[0].path,"utf8")); console.log(JSON.stringify({status:Number.isFinite(v.result)?"passed":"rejected",message:"Checked actual product"}));')
    const runner = fileURLToPath(new URL("../../protocol-plugins/sandbox-js-runner.mjs", import.meta.url))
    const input = { intake: { mode: "manual_plan" as const, cwd, root: source, dir: path.join(root, "intake"),
      catalogue: { ...cfg, stop: plan.stop, approvedPlans: [fingerprint(plan)] }, planPath },
      execution: { dir: path.join(root, "execution"), skillFormat: "text" as const, productKind: "json" as const,
        resourceKinds: Object.fromEntries(cfg.resources.map(item => [item.id, "text" as const])),
        executor: { id: "script-json-executor", version: "1", settings: { command: process.execPath, commandSHA256: await hash(process.execPath),
          script: runner, scriptSHA256: await hash(runner), timeoutMs: 10000, maxInputBytes: 100000, maxOutputBytes: 4096, executionBoundary: "trusted_host_runner" } },
        checkers: [{ name: "quality", binding: { id: "script-json-checker", version: "1", settings: { command: process.execPath,
          commandSHA256: await hash(process.execPath), script, scriptSHA256: await hash(script), timeoutMs: 10000, maxOutputBytes: 4096 } } }],
        training: { schema: "aev.protocol-training.v1", roles: Object.fromEntries(TRAINING_ROLES.map(role => [role, { model: "fixture/actor", timeoutMs: 10000 }])) as TrainingConfig["roles"],
          budgets: { maxAttemptsPerUnit: 1, maxTotalUnitAttempts: 4, maxGraphReplans: 1, maxValidatorCalls: 4, maxNoProgressCycles: 2, maxUnitsPerGraph: 4 } },
        requestBudget: { schema: "aev.task-budget-policy.v1", root: path.join(root, "budget"), scope: mode,
          models: [{ model: "fixture/actor", dialect: "openai_chat", expectedModels: ["actor"], maxInputTokens: 20000, maxOutputTokens: 4096 }] }, maxBundleBytes: 1000000 } }
    let result = await actual.runTask(input)
    if (mode === "preserve") {
      expect(interrupted).toBe(true)
      const file = path.join(result.campaignDir, "campaign.json"), state = JSON.parse(await readFile(file, "utf8"))
      await writeFile(file, JSON.stringify({ ...state, status: "recovery_pending", ownerPID: undefined,
        ownerCreationTick: undefined, ownerCommandHint: undefined, heartbeatAt: undefined }))
      result = await actual.runTask(input)
      expect(result.campaignID).toBe(state.id)
    }
    expect(result.status).toBe("verified_success")
    expect(switched).toBe(true)
    const state = JSON.parse(await readFile(path.join(result.campaignDir, "task-adaptation/exploration/host/state.json"), "utf8"))
    expect(state.record.rounds.map((item: { branch: string }) => item.branch)).toEqual(["original", "original", "original", "alternative", "alternative"])
    expect(state.record.decision.reason).toBe("alternative_limit")
    const comparisons = state.record.rounds.map((item: { metric: { comparison: string } }) => item.metric.comparison)
    expect(new Set(comparisons).size).toBe(1)
    const versions = await readdir(path.join(result.campaignDir, "task-adaptation/versions"))
    expect(versions).toHaveLength(5)
    const delivery = JSON.parse(await readFile(result.delivery.path, "utf8"))
    const best = mode === "min" ? Math.min(...scores) : Math.max(...scores)
    expect(await readFile(path.join(path.dirname(result.delivery.path), delivery.files[0].path), "utf8")).toBe(`function solve() { return ${best} }`)
    const budget = { root: input.execution.requestBudget.root, scope: mode, calls: plan.stop.calls, tokens: plan.stop.tokens }
    const before = await inspectBudget(budget), count = calls.length
    const resumed = await actual.runTask(input)
    expect(resumed.delivery).toEqual({ ...result.delivery, reused: true })
    expect(calls).toHaveLength(count)
    expect(await inspectBudget(budget)).toEqual(before)
    await writeFile(path.join(root, "summary.json"), JSON.stringify({ externalModelCalls: 0, mode, calls, state, best }, null, 2))
    console.log(`Metric Campaign evidence: ${root}`)
  } finally {
    delete holder[key]
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
    Object.assign(process.env, saved)
  }
}, 300000)
