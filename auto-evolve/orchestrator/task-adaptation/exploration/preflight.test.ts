import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { plan, policy } from "./policy.test"
import { preflightExploration } from "./preflight"
import { TRAINING_ROLES, type TrainingConfig } from "../../protocol-plugins/training"
import type { TaskBudgetPolicy } from "../budget-policy"
import { taskRuntimeBudgets } from "../budget-policy"
import { openRequestStage, reserveRequest, settleRequest, inspectBudget } from "../request-budget"
import { fingerprint } from "../../protocol-plugins/identity"

const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex")

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-host-preflight-"))
  const cfg = plan()
  cfg.exploration = policy()
  cfg.windows.push(...TRAINING_ROLES.map(role => ({ role, stage: role === "lead" || role === "diagnostician" ? "revise" as const
    : role === "reviewer" ? "accept" as const : "explore" as const, reads: ["report", "source"],
    writes: role === "lead" || role === "executor" ? ["report"] : [], inline: [], actions: role === "lead" || role === "executor"
      ? ["read" as const, "edit" as const] : ["read" as const] })))
  for (const resource of cfg.resources) await writeFile(path.join(root, resource.path), `initial ${resource.id}`)
  const script = path.join(root, "check.mjs")
  await writeFile(script, 'console.log(JSON.stringify({status:"passed"}))')
  const training = { schema: "aev.protocol-training.v1", roles: Object.fromEntries(TRAINING_ROLES.map(role =>
    [role, { model: "fixture", timeoutMs: 10000 }])), budgets: {} } as TrainingConfig
  const requestBudget: TaskBudgetPolicy = { schema: "aev.task-budget-policy.v1", root: path.join(root, "budget"), scope: "fixture",
    models: [{ model: "fixture", dialect: "openai_chat", expectedModels: ["fixture"], maxInputTokens: 100, maxOutputTokens: 100 }] }
  const checkers = [{ name: "quality", binding: { id: "script-json-checker", version: "1", settings: {
    command: process.execPath, commandSHA256: await hash(process.execPath), script, scriptSHA256: await hash(script),
    timeoutMs: 10000, maxOutputBytes: 4096 } } }]
  return { cfg, input: { root, training, capabilities: [], requestBudget, checkers } }
}

test("Host supports bounded report adapters but refuses missing budget and external effects", async () => {
  const f = await fixture()
  await expect(preflightExploration(f.cfg, f.input)).resolves.toBeUndefined()
  await expect(preflightExploration(f.cfg, { ...f.input, requestBudget: undefined })).rejects.toThrow("enforced request stages")
  const changed = structuredClone(f.cfg)
  changed.windows.find(item => item.role === "executor")!.actions.push("execute")
  await expect(preflightExploration(changed, f.input)).rejects.toThrow("external effects")
  const small = structuredClone(f.cfg)
  small.exploration!.allowance.acceptanceTokens = 100
  await expect(preflightExploration(small, f.input)).rejects.toThrow("cannot admit selected model")
})

test("Host permits only the bundled replay-safe JS runner, not arbitrary host scripts", async () => {
  const f = await fixture()
  const cfg = structuredClone(f.cfg)
  cfg.deliverable.kind = "software"
  cfg.acceptance.execution = "script"
  cfg.windows.push({ role: "independent", stage: "accept", reads: ["report"], writes: [], inline: [], actions: ["read"] })
  const script = fileURLToPath(new URL("../../protocol-plugins/sandbox-js-runner.mjs", import.meta.url))
  const executor = { id: "script-json-executor", version: "1", settings: { command: process.execPath,
    commandSHA256: await hash(process.execPath), script, scriptSHA256: await hash(script), timeoutMs: 10000,
    maxInputBytes: 10000, maxOutputBytes: 4096, executionBoundary: "trusted_host_runner" } }
  await expect(preflightExploration(cfg, { ...f.input, executor })).resolves.toBeUndefined()
  await expect(preflightExploration(cfg, { ...f.input, executor: { ...executor, settings: {
    ...executor.settings, script: f.input.checkers[0].binding.settings.script } } })).rejects.toThrow("bundled replay-safe")
  await expect(preflightExploration(cfg, { ...f.input, executor: { ...executor, id: "isolated-tool-session" } }))
    .rejects.toThrow("no replay-safe adapter")
})

test("heterogeneous HTTP allowance matches actual stage reservations after reviewer settlement", async () => {
  const f = await fixture()
  f.cfg.acceptance.execution = "independent"
  f.cfg.exploration!.allowance.acceptanceCalls = 2
  f.cfg.exploration!.allowance.acceptanceTokens = 1100
  f.input.requestBudget.models.push({ model: "larger", dialect: "openai_chat", expectedModels: ["larger"], maxInputTokens: 900, maxOutputTokens: 100 })
  const input = { ...f.input, executor: { id: "http-text-chat", version: "1", settings: {} } }
  await expect(preflightExploration(f.cfg, input)).rejects.toThrow("cannot cover frozen workload")
  f.cfg.exploration!.allowance.acceptanceTokens = 1200
  await expect(preflightExploration(f.cfg, input)).resolves.toBeUndefined()
  const budget = { root: f.input.requestBudget.root, scope: f.input.requestBudget.scope, calls: f.cfg.stop.calls, tokens: f.cfg.stop.tokens }
  const common = { schema: "aev.exploration-admission.v1" as const, policy: fingerprint(f.cfg.exploration), round: 1, pass: 1,
    generation: 0 as const, calls: 2, protectedCalls: 0, protectedTokens: 0 }
  const author = await openRequestStage(budget, { ...common, stage: "author", roles: ["lead"], tokens: 10000 }, null)
  const stage = await openRequestStage(budget, { ...common, stage: "acceptance", roles: ["reviewer", "independent"], tokens: 1200 }, author.id)
  await reserveRequest(budget, { id: "reviewer", request: fingerprint("reviewer"), role: "reviewer", model: "fixture", gate: stage.id, reservationTokens: 200 })
  await settleRequest(budget, "reviewer", 200)
  const http = taskRuntimeBudgets(f.input.requestBudget, f.cfg.stop).httpBudgets!.execution
  await reserveRequest(budget, { id: "consumer", request: fingerprint("consumer"), role: http.role, model: "fixture", gate: stage.id, reservationTokens: http.tokenCeiling })
  await settleRequest(budget, "consumer", 1000)
  expect(await inspectBudget(budget)).toMatchObject({ admittedAttempts: 2, reportedTokens: 1200, outstandingTokens: 0 })
})
