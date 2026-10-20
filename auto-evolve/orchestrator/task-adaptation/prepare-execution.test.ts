import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { catalogue, decision } from "./intake-fixture"
import { compileTask } from "./catalogue"
import { prepareExecution, type ExecutionPreparation } from "./prepare-execution"
import { Runtime } from "../protocol-plugins/runtime"
import { TRAINING_ROLES, type TrainingConfig } from "../protocol-plugins/training"
import { loadLongTaskSpec } from "../long-task/spec"
import { prepareEntry } from "../protocol-plugins/entry"
import { authorContext } from "../protocol-plugins/author-context"
import { loadTaskContext, taskInvocation, taskBudgetOptions } from "./context"
import { prepareTaskRun } from "./prepare-task-run"
import { FIXTURE_REPORT_EXPLORATION_TEMPLATE } from "./exploration/templates"
import { scriptChecker } from "../protocol-plugins/script-checker"
import { createHash } from "node:crypto"

async function fixture(kind: "report" | "software" | "skill" = "report") {
  const parent = await mkdtemp(path.join(os.tmpdir(), "aev-execution-prep-"))
  const root = path.join(parent, "sources")
  await mkdir(root)
  const cat = catalogue()
  for (const item of cat.resources) await writeFile(path.join(root, item.path), item.id)
  const result = compileTask(cat, decision(kind))
  if (result.status !== "ready") throw new Error("Fixture not ready")
  const rt = new Runtime()
    .addChecker({ id: "fixture-check", version: "1", implementation: "a".repeat(64), targets: ["skill", "product"],
      mechanisms: ["script", "judge"], productKinds: ["text"], validate() {} }, async () => { throw new Error("Preparation must not invoke checker") })
    .addExecutor({ id: kind === "software" ? "script-json-executor" : "fixture-execution", version: "1", implementation: "b".repeat(64),
      skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"], validate() {} }, async () => { throw new Error("Preparation must not invoke executor") })
  const input: ExecutionPreparation = { root, dir: path.join(parent, "prepared"), plan: structuredClone(result.plan),
    capabilities: result.plan.capabilities.slice(), skillFormat: "text", productKind: "text",
    resourceKinds: Object.fromEntries(cat.resources.map(item => [item.id, "text"])),
    ...(kind !== "report" ? { executor: { id: kind === "software" ? "script-json-executor" : "fixture-execution", version: "1", settings: {} } } : {}),
    checkers: result.plan.acceptance.checks.map(item => ({ name: item.id, binding: { id: "fixture-check", version: "1", settings: {} } })),
    training: { schema: "aev.protocol-training.v1", roles: Object.fromEntries(TRAINING_ROLES.map(role => [role, { model: "offline/author", timeoutMs: 1000 }])) as TrainingConfig["roles"],
      budgets: { maxAttemptsPerUnit: 1, maxTotalUnitAttempts: 4, maxGraphReplans: 1, maxValidatorCalls: 4, maxNoProgressCycles: 2, maxUnitsPerGraph: 4 } },
    maxBundleBytes: 100000 }
  return { input, rt, parent }
}

for (const kind of ["report", "software", "skill"] as const) test(`generates ${kind} spec, project and scoped protocol accepted by real preparation chain`, async () => {
  const f = await fixture(kind)
  const output = await prepareExecution(f.input, f.rt.registry)
  if (output.status !== "ready") throw new Error("Not ready")
  const loaded = (await loadLongTaskSpec(output.specPath)).spec
  expect(loaded.goal).toBe(f.input.plan.objective)
  expect(loaded.protocolTraining).toEqual(f.input.training)
  const campaign = path.join(f.parent, "campaign")
  const prepared = await prepareEntry(campaign, loaded.protocolPlugins, f.rt)
  if (!prepared) throw new Error("Protocol missing")
  loaded.protocolAuthorContext = authorContext(prepared.entry, prepared.protocol, prepared.project)
  const context = await loadTaskContext(loaded, path.join(campaign, "task-adaptation"))
  expect(context?.plan.deliverable.kind).toBe(kind)
  expect(await prepareExecution(f.input, f.rt.registry)).toEqual({ ...output, reused: true })
  expect(await readFile(path.join(f.input.root, "candidate.txt"), "utf8")).toBe("candidate")
})

test("missing real checker binding is explicit without creating a run", async () => {
  const f = await fixture()
  f.input.checkers = []
  expect(await prepareExecution(f.input, f.rt.registry)).toEqual({ status: "missing_bindings", missing: ["checker:support"] })
  await expect(readFile(path.join(f.input.dir, "execution-preparation.started.claim"))).rejects.toThrow()
})

test("generated spec freezes shared budget through role and acceptance runtime configuration", async () => {
  const f = await fixture()
  f.input.requestBudget = { schema: "aev.task-budget-policy.v1", root: path.join(f.parent, "ledger"), scope: "whole-task",
    models: [{ model: "offline/author", dialect: "openai_chat", expectedModels: ["author"], maxInputTokens: 1000, maxOutputTokens: 100 }] }
  const output = await prepareExecution(f.input, f.rt.registry)
  if (output.status !== "ready") throw new Error("Not ready")
  const loaded = (await loadLongTaskSpec(output.specPath)).spec
  expect(loaded.taskAdaptation?.requestBudget).toEqual(f.input.requestBudget)
  const campaign = path.join(f.parent, "campaign")
  const prepared = await prepareEntry(campaign, loaded.protocolPlugins, f.rt)
  if (!prepared) throw new Error("Protocol missing")
  loaded.protocolAuthorContext = authorContext(prepared.entry, prepared.protocol, prepared.project)
  loaded.taskAdaptationContext = await loadTaskContext(loaded, path.join(campaign, "task-adaptation"))
  expect(taskInvocation(loaded, "lead")?.requestBudget).toEqual(f.input.requestBudget)
  expect((await taskBudgetOptions(loaded)).httpBudgets?.judging.config).toMatchObject({ root: f.input.requestBudget.root,
    calls: f.input.plan.stop.calls, tokens: f.input.plan.stop.tokens })
  loaded.taskAdaptation!.requestBudget!.scope = "altered"
  await expect(loadTaskContext(loaded, path.join(campaign, "task-adaptation"))).rejects.toThrow("drift")
})

test("generated artifact drift and source drift block preparation reuse", async () => {
  const f = await fixture()
  const output = await prepareExecution(f.input, f.rt.registry)
  if (output.status !== "ready") throw new Error("Not ready")
  const original = await readFile(output.specPath)
  await writeFile(output.specPath, "{}")
  await expect(prepareExecution(f.input, f.rt.registry)).rejects.toThrow("artifact drift")
  await writeFile(output.specPath, original)
  await writeFile(path.join(f.input.root, "source.txt"), "changed source")
  await expect(prepareExecution(f.input, f.rt.registry)).rejects.toThrow("identity drift")
})

test("oversized inputs, wrong active judge and nested output fail before preparation", async () => {
  const f = await fixture()
  f.input.maxBundleBytes = 1
  await expect(prepareExecution(f.input, f.rt.registry)).rejects.toThrow("byte budget")
  f.input.maxBundleBytes = 100000
  f.input.plan.acceptance.checks[0].mechanism = "active_judge"
  await expect(prepareExecution(f.input, f.rt.registry)).rejects.toThrow("active-tool-judge")
  f.input.dir = path.join(f.input.root, "nested")
  await expect(prepareExecution(f.input, f.rt.registry)).rejects.toThrow("outside source")
})

test("one task entry interprets once then prepares reusable executable configuration", async () => {
  const f = await fixture()
  let calls = 0
  const dependencies = { createRuntime: async () => f.rt, intake: { createDriver: async () => ({
    implementation: "c".repeat(64), preflight: async () => {}, invoke: async (request: { editPaths: string[] }) => {
      calls++
      await writeFile(request.editPaths[0], JSON.stringify(decision()))
      return { completed: true, actualModel: "offline/intake" }
    } }) } }
  const { root, plan, capabilities, ...execution } = f.input
  const input = { intake: { root, cwd: f.parent, dir: path.join(f.parent, "intake"), catalogue: catalogue(),
    model: "offline/intake", expectedModel: "offline/intake", timeoutMs: 1000, maxInputBytes: 100000, maxDecisionBytes: 10000 }, execution }
  const first = await prepareTaskRun(input, dependencies)
  expect(first.status).toBe("ready")
  const second = await prepareTaskRun(input, dependencies)
  expect(second.status).toBe("ready")
  if (second.status !== "ready") throw new Error("Expected ready")
  expect(second.reused).toBe(true)
  expect(calls).toBe(1)
})

for (const mode of ["auto", "observations", "fault"] as const) test(`real preparation preflight ${mode}: typed unsupported only, before Intake completion`, async () => {
  const f = await fixture()
  const cat = catalogue()
  const choice = decision()
  if (mode === "fault") {
    cat.profiles[0].requires = ["files"]
    cat.profiles[0].rejection = [{ check: "support", actions: ["repair"] }]
    choice.workers[0].actions = ["read"]
  }
  const template = structuredClone(FIXTURE_REPORT_EXPLORATION_TEMPLATE)
  template.checker = { name: "support", id: "fixture-check" }
  template.policy.defaultObservations = 1
  template.policy.allowance = { ...template.policy.allowance, rounds: 1, minimumRounds: 1,
    authorCalls: 5, authorTokens: 5000, acceptanceCalls: 2, acceptanceTokens: 2000 }
  const { root, plan, capabilities, ...execution } = f.input
  const input = { intake: { mode: "manual_decision" as const, root, cwd: f.parent, dir: path.join(f.parent, "intake"),
    catalogue: cat, decision: choice }, execution,
    explorationRequest: mode === "observations" ? { mode, after: 1 } : { mode: "auto" as const } }
  const deps = { createRuntime: async () => f.rt, templates: [template] }
  if (mode === "auto") {
    const result = await prepareTaskRun(input, deps)
    expect(result.status).toBe("ready")
    expect(result.explorationSummary?.enabled).toBe(false)
    expect(result.explorationSummary?.reason).toContain("external effects")
    const saved = JSON.parse(await readFile(path.join(input.intake.dir, "task-plan.json"), "utf8"))
    expect(saved.exploration).toBeUndefined()
    expect((await prepareTaskRun(input, deps)).explorationSummary).toEqual(result.explorationSummary)
  } else {
    await expect(prepareTaskRun(input, deps)).rejects.toThrow(mode === "fault" ? "enforced request stages" : "Host unsupported")
    await expect(readFile(path.join(input.intake.dir, "intake.completed.json"))).rejects.toThrow()
    await expect(readFile(path.join(input.intake.dir, "task-plan.json"))).rejects.toThrow()
  }
})

test("real supported preparation freezes summary; changed checker hash blocks recovery without rewriting Intake", async () => {
  const f = await fixture()
  const cat = catalogue()
  cat.profiles[0].requires = ["files"]
  cat.profiles[0].rejection = [{ check: "support", actions: ["repair"] }]
  cat.profiles[0].acceptance.checks[0].mechanism = "script"
  const choice = decision()
  choice.workers[0].actions = ["read"]
  const script = path.join(f.parent, "checker.mjs")
  await writeFile(script, "throw new Error('Preparation must never execute a checker')")
  const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex")
  const plugin = await scriptChecker(path.join(f.parent, "checks"))
  f.rt.addChecker(plugin.descriptor, plugin.evaluate)
  const template = structuredClone(FIXTURE_REPORT_EXPLORATION_TEMPLATE)
  template.checker = { name: "support", id: "script-json-checker" }
  template.policy.defaultObservations = 1
  template.policy.allowance = { ...template.policy.allowance, rounds: 1, minimumRounds: 1,
    authorCalls: 5, authorTokens: 5000, acceptanceCalls: 2, acceptanceTokens: 2000 }
  const { root, plan, capabilities, ...execution } = f.input
  execution.checkers = [{ name: "support", binding: { id: "script-json-checker", version: "1", settings: {
    command: process.execPath, commandSHA256: await hash(process.execPath), script, scriptSHA256: await hash(script),
    timeoutMs: 1000, maxOutputBytes: 1000,
  } } }]
  const input = { intake: { mode: "manual_decision" as const, root, cwd: f.parent, dir: path.join(f.parent, "intake"),
    catalogue: cat, decision: choice }, execution: { ...execution,
      requestBudget: { schema: "aev.task-budget-policy.v1" as const, root: path.join(f.parent, "budget"), scope: "task",
        models: [{ model: "offline/author", dialect: "openai_chat" as const, expectedModels: ["author"], maxInputTokens: 1000, maxOutputTokens: 100 }] } },
    explorationRequest: { mode: "observations" as const, after: 1 } }
  const deps = { createRuntime: async () => f.rt, templates: [template] }
  const first = await prepareTaskRun(input, deps)
  expect(first.status).toBe("ready")
  expect(first.explorationSummary?.enabled).toBe(true)
  const file = path.join(input.intake.dir, "exploration-resolution.json")
  const bytes = await readFile(file)
  expect(JSON.parse(bytes.toString("utf8")).preflight.status).toBe("supported")
  expect((await prepareTaskRun(input, { ...deps, templates: [] })).explorationSummary).toEqual(first.explorationSummary)
  await writeFile(script, "changed checker")
  await expect(prepareTaskRun(input, deps)).rejects.toThrow("fingerprint changed")
  expect(await readFile(file)).toEqual(bytes)
})
