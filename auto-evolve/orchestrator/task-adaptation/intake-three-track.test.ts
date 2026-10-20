import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { prepareTask, type IntakeInput, type IntakeDependencies } from "./intake"
import { compileTask, type TaskCatalogue, type Decision } from "./catalogue"
import { fingerprint } from "../protocol-plugins/identity"
import type { HostExplorationTemplate, HostExplorationTemplateV2 } from "./exploration/templates"

const created: string[] = []
afterEach(async () => { for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true }) })

const decision: Decision = { kind: "report", profiles: ["reviewed-report"], needs: ["files"], workers: [], rationale: "Explicit fixture" }

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "aev-intake-three-track-"))
  created.push(base)
  const root = path.join(base, "materials")
  const dir = path.join(base, "intake")
  await mkdir(root)
  await writeFile(path.join(root, "report.md"), "draft")
  await writeFile(path.join(root, "facts.txt"), "some source")
  const catalogue: TaskCatalogue = {
    id: "three-track-fixture", request: "Create a checked report",
    entries: ["deliverable"], maxWorkers: 0,
    resources: [
      { id: "deliverable", path: "report.md", audience: "public", mutable: true },
      { id: "facts", path: "facts.txt", audience: "public", mutable: false },
    ],
    capabilities: [{ id: "files", version: "1", description: "File read and edit", actions: ["read", "edit"], available: true }],
    profiles: [{ id: "reviewed-report", description: "Review report", kinds: ["report"], requires: ["files"],
      acceptance: { execution: "none", checks: [{ id: "review", target: "candidate", mechanism: "judge", purpose: "Check facts",
        required: true, resources: ["facts"], feedback: "message" }] },
      rejection: [{ check: "review", actions: ["repair"] }], selection: { rule: "first_pass" } }],
    stop: { rounds: 1, calls: 10, tokens: 10000, stagnant: 1 },
  }
  return { base, root, dir, catalogue, cwd: base }
}

const fixtureTemplate: HostExplorationTemplate = {
  schema: "aev.exploration-template.v1",
  id: "fixture-report-template",
  version: "1.0.0",
  profiles: ["reviewed-report"],
  checker: { name: "review", id: "review" },
  policy: {
    origin: { kind: "initial" },
    replace: ["deliverable"],
    preserve: [],
    dependencies: ["facts"],
    defaultObservations: 1,
    allowance: {
      rounds: 1,
      minimumRounds: 1,
      authorCalls: 5,
      authorTokens: 5000,
      acceptanceCalls: 2,
      acceptanceTokens: 2000,
      deliveryCalls: 0,
      deliveryTokens: 0,
    },
    bounds: { archiveBytes: 100000, candidateBytes: 5000, dependencyBytes: 10000 },
    safety: { reset: "declared_entries", effects: "sandbox_only" },
  },
}

async function preflightFixture(mode: "auto" | "manual_decision") {
  const ctx = await fixture()
  ctx.catalogue.stop.rounds = 2
  let calls = 0
  const common = { ...ctx, explorationRequest: { mode: "auto" as const },
    explorationSupport: { checkers: [{ name: "review", id: "review" }] } }
  const input: IntakeInput = mode === "manual_decision" ? { ...common, mode, decision }
    : { ...common, mode, model: "fixture", expectedModel: "fixture", timeoutMs: 5000,
        maxInputBytes: 64000, maxDecisionBytes: 16000, maxDecisionRepairs: 2 }
  const deps: IntakeDependencies = { templates: [fixtureTemplate], createDriver: async () => ({
    implementation: "e".repeat(64), preflight: async () => {},
    invoke: async (arg: { workDir: string }) => {
      calls++
      await writeFile(path.join(arg.workDir, "decision.json"), JSON.stringify(decision))
      return { completed: true, actualModel: "fixture" }
    },
  }) }
  return { ctx, input, deps, calls: () => calls }
}

for (const mode of ["auto", "manual_decision"] as const) {
  test(`${mode}: empty off and explicit off have no preflight, summary or resolution, including recovery`, async () => {
    for (const request of [{}, { mode: "off" as const }]) {
      const f = await preflightFixture(mode)
      f.input.explorationRequest = request
      f.deps.preflightExploration = async () => { throw new Error("Off must not preflight exploration") }
      expect((await prepareTask(f.input, f.deps)).explorationSummary).toBeUndefined()
      expect((await prepareTask(f.input, f.deps)).reused).toBe(true)
      await expect(readFile(path.join(f.ctx.dir, "exploration-resolution.json"))).rejects.toThrow()
    }
  })

  test(`${mode}: Host preflight precedes completion; summary freezes and recovery cannot downgrade`, async () => {
    const f = await preflightFixture(mode)
    let checks = 0
    f.deps.preflightExploration = async plan => {
      checks++
      expect(plan.exploration?.schema).toBe("aev.exploration-policy.v1")
      if (checks === 1) for (const file of ["intake.completed.json", "task-plan.json", "exploration-resolution.json"])
        await expect(readFile(path.join(f.ctx.dir, file))).rejects.toThrow()
      return { status: "supported" }
    }
    const first = await prepareTask(f.input, f.deps)
    const file = path.join(f.ctx.dir, "exploration-resolution.json")
    const bytes = await readFile(file)
    const proof = JSON.parse(bytes.toString("utf8"))
    expect(proof.summary).toEqual(first.explorationSummary)
    expect(proof.summary.counting.unit).toBe("quality_observations")
    expect(proof.summary.message).toContain("正常质量观察 1 次")
    expect(proof.summary.message).toContain("届时余额")
    expect(proof.templateFingerprint).toBe(fingerprint(fixtureTemplate))
    expect(proof.resolverFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(proof.budgetMode).toBe("best_effort")
    const again = await prepareTask(f.input, { ...f.deps, templates: [] })
    expect(again.explorationSummary).toEqual(first.explorationSummary)
    expect(checks).toBe(2)
    f.deps.preflightExploration = async () => ({ status: "unsupported", reason: "Host changed" })
    await expect(prepareTask(f.input, f.deps)).rejects.toThrow("Frozen exploration Host no longer supported")
    f.deps.preflightExploration = async () => { throw new Error("hash mismatch") }
    await expect(prepareTask(f.input, f.deps)).rejects.toThrow("hash mismatch")
    await expect(prepareTask(f.input, { ...f.deps, preflightExploration: undefined })).rejects.toThrow("identity drift")
    expect(await readFile(file)).toEqual(bytes)
    expect(f.calls()).toBe(mode === "auto" ? 1 : 0)
  })

  test(`${mode}: only plain auto falls back before freezing and disabled recovery stays disabled`, async () => {
    const f = await preflightFixture(mode)
    let checks = 0
    f.deps.preflightExploration = async () => { checks++; return { status: "unsupported", reason: "no replay-safe adapter" } }
    const first = await prepareTask(f.input, f.deps)
    if (first.status !== "ready") throw new Error("Expected ready")
    const base = compileTask(f.ctx.catalogue, decision)
    if (base.status !== "ready") throw new Error("Expected ready")
    expect(first.plan).toEqual(base.plan)
    expect(first.explorationSummary?.message).toContain("探索未启用，原任务流程保留")
    const file = path.join(f.ctx.dir, "exploration-resolution.json")
    const bytes = await readFile(file)
    const proof = JSON.parse(bytes.toString("utf8"))
    expect(proof.reason).toBe("no replay-safe adapter")
    expect(proof.counting.unit).toBe("not_enabled")
    expect(proof.budgetMode).toBe("best_effort")
    expect(proof.preflight.status).toBe("unsupported")
    f.deps.preflightExploration = async () => { checks++; return { status: "supported" } }
    const again = await prepareTask(f.input, f.deps)
    expect(again.explorationSummary).toEqual(first.explorationSummary)
    expect(checks).toBe(1)
    expect(await readFile(file)).toEqual(bytes)
    expect(f.calls()).toBe(mode === "auto" ? 1 : 0)
  })

  test(`${mode}: explicit unsupported and ordinary faults never complete or repair Decision`, async () => {
    for (const kind of ["explicit", "fault"] as const) {
      const f = await preflightFixture(mode)
      if (kind === "explicit") f.input.explorationRequest = { mode: "auto", template: fixtureTemplate.id }
      f.deps.preflightExploration = async () => {
        if (kind === "fault") throw new Error("permission/hash/ledger fault")
        return { status: "unsupported", reason: "no adapter" }
      }
      await expect(prepareTask(f.input, f.deps)).rejects.toThrow(kind === "fault" ? "permission/hash/ledger fault" : "Host unsupported")
      await expect(readFile(path.join(f.ctx.dir, "intake.completed.json"))).rejects.toThrow()
      await expect(readFile(path.join(f.ctx.dir, "task-plan.json"))).rejects.toThrow()
      expect(f.calls()).toBe(mode === "auto" ? 1 : 0)
    }
  })
}

test("summary is recomputed on recovery, not trusted merely because receipt hash was rewritten", async () => {
  const f = await preflightFixture("manual_decision")
  await prepareTask(f.input, f.deps)
  const file = path.join(f.ctx.dir, "exploration-resolution.json")
  const proof = JSON.parse(await readFile(file, "utf8"))
  proof.summary.counting.unit = "closed_original_rounds"
  await writeFile(file, JSON.stringify(proof))
  const receipt = path.join(f.ctx.dir, "intake.completed.json")
  const saved = JSON.parse(await readFile(receipt, "utf8"))
  saved.resolutionSHA256 = new Bun.CryptoHasher("sha256").update(await readFile(file)).digest("hex")
  await writeFile(receipt, JSON.stringify(saved))
  await expect(prepareTask(f.input, f.deps)).rejects.toThrow("summary drift")
})

test("approved manual Plan is checked before completion and cannot fall back during recovery", async () => {
  const f = await preflightFixture("manual_decision")
  const ready = await prepareTask(f.input, f.deps)
  if (ready.status !== "ready") throw new Error("Expected ready")
  const planPath = path.join(f.ctx.base, "approved-plan.json")
  await writeFile(planPath, JSON.stringify(ready.plan))
  const input: IntakeInput = { ...f.ctx, dir: path.join(f.ctx.base, "manual-plan"), mode: "manual_plan", planPath,
    catalogue: { ...f.ctx.catalogue, approvedPlans: [fingerprint(ready.plan)] } }
  let supported = true
  const deps: IntakeDependencies = { preflightExploration: async () => supported
    ? { status: "supported" } : { status: "unsupported", reason: "missing Host" } }
  const first = await prepareTask(input, deps)
  expect(first.status).toBe("ready")
  const bytes = await readFile(path.join(input.dir, "task-plan.json"))
  supported = false
  await expect(prepareTask(input, deps)).rejects.toThrow("Frozen approved exploration Host no longer supported")
  expect(await readFile(path.join(input.dir, "task-plan.json"))).toEqual(bytes)
  const fresh = { ...input, dir: path.join(f.ctx.base, "unsupported-plan") }
  await expect(prepareTask(fresh, deps)).rejects.toThrow("Approved exploration Host unsupported")
  await expect(readFile(path.join(fresh.dir, "intake.completed.json"))).rejects.toThrow()
})

describe("three-track task intake", () => {
  test("manual_decision: compiles, writes audit proof, and reuses with no driver", async () => {
    const ctx = await fixture()
    const input: IntakeInput = { ...ctx, mode: "manual_decision", decision }
    const driver = { createDriver: async () => { throw new Error("No model driver allowed") } }
    const first = await prepareTask(input, driver as never)
    expect(first.status).toBe("ready")
    expect(first.reused).toBe(false)
    expect(first.explorationSummary).toBeUndefined()
    const again = await prepareTask(input, driver as never)
    expect(again.status).toBe("ready")
    expect(again.reused).toBe(true)
    expect(await readFile(path.join(ctx.dir, "intake.backend-result.json"), "utf8").then(() => true, () => false)).toBe(false)
  })

  test("manual_decision: missing payload does not fall back to auto", async () => {
    const ctx = await fixture()
    await expect(prepareTask({ ...ctx, mode: "manual_decision" } as IntakeInput)).rejects.toThrow("exactly one")
  })

  test("manual_decision: rejects double input and unknown capability without execution", async () => {
    const ctx = await fixture()
    const decisionPath = path.join(ctx.base, "decision.json")
    await writeFile(decisionPath, JSON.stringify(decision))
    await expect(prepareTask({ ...ctx, mode: "manual_decision", decision, decisionPath })).rejects.toThrow("exactly one")
    const badDecision = { ...decision, needs: ["magic"] }
    const compiled = await prepareTask({ ...ctx, mode: "manual_decision", decision: badDecision })
    expect(compiled.status).toBe("missing_capabilities")
  })

  test("manual_decision: original source change prevents reuse", async () => {
    const ctx = await fixture()
    const decisionPath = path.join(ctx.base, "decision.json")
    await writeFile(decisionPath, JSON.stringify(decision))
    const input: IntakeInput = { ...ctx, mode: "manual_decision", decisionPath }
    await prepareTask(input)
    await writeFile(decisionPath, JSON.stringify({ ...decision, rationale: "tampered" }))
    await expect(prepareTask(input)).rejects.toThrow(/drift/)
  })

  test("manual_decision: changing input material prevents reuse", async () => {
    const ctx = await fixture()
    const input: IntakeInput = { ...ctx, mode: "manual_decision", decision }
    await prepareTask(input)
    await writeFile(path.join(ctx.root, "report.md"), "modified content")
    await expect(prepareTask(input)).rejects.toThrow(/drift/)
  })

  test("manual_decision: corrupting completion or plan fails closed", async () => {
    const ctx = await fixture()
    const input: IntakeInput = { ...ctx, mode: "manual_decision", decision }
    await prepareTask(input)
    await writeFile(path.join(ctx.dir, "task-plan.json"), '{"bad":true}')
    await expect(prepareTask(input)).rejects.toThrow(/drift/)
  })

  test("manual_plan: host-approved plan accepted and reused", async () => {
    const ctx = await fixture()
    const ready = compileTask(ctx.catalogue, decision)
    if (ready.status !== "ready") throw new Error("Expected ready")
    const planPath = path.join(ctx.base, "preset-plan.json")
    await writeFile(planPath, JSON.stringify(ready.plan))
    const input: IntakeInput = { ...ctx, mode: "manual_plan", planPath,
      catalogue: { ...ctx.catalogue, approvedPlans: [fingerprint(ready.plan)] } }
    expect((await prepareTask(input)).status).toBe("ready")
    expect((await prepareTask(input)).reused).toBe(true)
  })

  test("manual_plan: cannot approve itself; must be in trusted catalogue", async () => {
    const ctx = await fixture()
    const ready = compileTask(ctx.catalogue, decision)
    if (ready.status !== "ready") throw new Error("Expected ready")
    const planPath = path.join(ctx.base, "preset-plan.json")
    await writeFile(planPath, JSON.stringify(ready.plan))
    await expect(prepareTask({ ...ctx, mode: "manual_plan", planPath })).rejects.toThrow(/host-approved/)
  })

  test("manual_plan: rejects tampered plan and catalogue budget drift", async () => {
    const ctx = await fixture()
    const ready = compileTask(ctx.catalogue, decision)
    if (ready.status !== "ready") throw new Error("Expected ready")
    const altered = structuredClone(ready.plan)
    altered.stop.calls += 1
    const planPath = path.join(ctx.base, "preset-plan.json")
    await writeFile(planPath, JSON.stringify(altered))
    await expect(prepareTask({ ...ctx, mode: "manual_plan", planPath,
      catalogue: { ...ctx.catalogue, approvedPlans: [fingerprint(ready.plan)] } })).rejects.toThrow(/host-approved/)
    await expect(prepareTask({ ...ctx, mode: "manual_plan", planPath,
      catalogue: { ...ctx.catalogue, approvedPlans: [fingerprint(altered)] } })).rejects.toThrow(/envelope/)
  })

  test("switching modes inside the same claimed directory fails", async () => {
    const ctx = await fixture()
    await prepareTask({ ...ctx, mode: "manual_decision", decision })
    const ready = compileTask(ctx.catalogue, decision)
    if (ready.status !== "ready") throw new Error("Expected ready")
    const planPath = path.join(ctx.base, "preset-plan.json")
    await writeFile(planPath, JSON.stringify(ready.plan))
    await expect(prepareTask({ ...ctx, mode: "manual_plan", planPath,
      catalogue: { ...ctx.catalogue, approvedPlans: [fingerprint(ready.plan)] } })).rejects.toThrow(/identity drift/)
  })

  test("auto remains supported with injected deterministic mock driver", async () => {
    const ctx = await fixture()
    const input: IntakeInput = { ...ctx, mode: "auto", model: "fixture", expectedModel: "fixture",
      timeoutMs: 5000, maxInputBytes: 64000, maxDecisionBytes: 16000 }
    let calls = 0
    const deps = { createDriver: async () => ({ implementation: "a".repeat(64), preflight: async () => {},
      invoke: async (arg: { workDir: string }) => {
        calls++
        await writeFile(path.join(arg.workDir, "decision.json"), JSON.stringify(decision))
        return { completed: true, actualModel: "fixture" }
      } }) }
    const first = await prepareTask(input, deps as never)
    expect(first.status).toBe("ready")
    const again = await prepareTask(input, deps as never)
    expect(again.reused).toBe(true)
    expect(calls).toBe(1)
  })

  test("rejects inline explorationTemplates in input", async () => {
    const ctx = await fixture()
    const input = {
      ...ctx,
      mode: "manual_decision" as const,
      decision,
      explorationTemplates: [fixtureTemplate],
    }
    await expect(prepareTask(input as any)).rejects.toThrow("Task intake rejects inline explorationTemplates")
  })

  test("manual_decision: resolves exploration V1, writes proof, and recovers across host template update", async () => {
    const ctx = await fixture()
    const catalogueWith2Rounds = {
      ...ctx.catalogue,
      stop: { ...ctx.catalogue.stop, rounds: 2 },
    }
    const input: IntakeInput = {
      ...ctx,
      catalogue: catalogueWith2Rounds,
      mode: "manual_decision",
      decision,
      explorationRequest: { mode: "observations", after: 1 },
      explorationSupport: {
        checkers: [{ name: "review", id: "review" }],
      },
    }
    const deps = { templates: [fixtureTemplate] }
    const res = await prepareTask(input, deps)
    expect(res.status).toBe("ready")
    if (res.status !== "ready") throw new Error("Expected ready")
    expect(res.plan.exploration?.schema).toBe("aev.exploration-policy.v1")
    expect(res.plan.exploration?.trigger).toEqual({ kind: "attempts", observations: 1 })

    // Check exploration-resolution.json was written
    const resFile = path.join(ctx.dir, "exploration-resolution.json")
    const resJson = JSON.parse(await readFile(resFile, "utf8"))
    expect(resJson.schema).toBe("aev.exploration-resolution.v1")
    expect(resJson.enabled).toBe(true)
    expect(resJson.template.id).toBe("fixture-report-template")

    // Reuse check: even if host templates change to empty, recovery uses frozen evidence without error
    const emptyDeps = { templates: [] }
    const reused = await prepareTask(input, emptyDeps)
    if (reused.status !== "ready") throw new Error("Expected ready")
    expect(reused.reused).toBe(true)
    expect(reused.plan.exploration?.trigger).toEqual({ kind: "attempts", observations: 1 })
  })

  test("auto: auto-disabled writes enabled:false proof and plan has no exploration", async () => {
    const ctx = await fixture()
    let calls = 0
    const deps = {
      createDriver: async () => ({
        implementation: "c".repeat(64),
        preflight: async () => {},
        invoke: async (arg: { workDir: string }) => {
          calls++
          await writeFile(path.join(arg.workDir, "decision.json"), JSON.stringify(decision))
          return { completed: true, actualModel: "fixture" }
        },
      }),
      templates: [], // 无获批模板
    }
    const input: IntakeInput = {
      ...ctx,
      mode: "auto",
      model: "fixture",
      expectedModel: "fixture",
      timeoutMs: 5000,
      maxInputBytes: 64000,
      maxDecisionBytes: 16000,
      explorationRequest: { mode: "auto" },
      explorationSupport: { checkers: [{ name: "review", id: "review" }] },
    }
    const res = await prepareTask(input, deps)
    expect(res.status).toBe("ready")
    if (res.status !== "ready") throw new Error("Expected ready")
    expect(res.plan.exploration).toBeUndefined()

    // 检查 exploration-resolution.json 持久化 enabled: false 及原因
    const resFile = path.join(ctx.dir, "exploration-resolution.json")
    const resJson = JSON.parse(await readFile(resFile, "utf8"))
    expect(resJson.schema).toBe("aev.exploration-resolution.v1")
    expect(resJson.enabled).toBe(false)
    expect(resJson.reason).toContain("No matching approved exploration template")

    // 恢复检查：零新增模型调用
    const again = await prepareTask(input, deps)
    if (again.status !== "ready") throw new Error("Expected ready")
    expect(again.reused).toBe(true)
    expect(again.plan.exploration).toBeUndefined()
    expect(calls).toBe(1)
  })

  test("auto: exploration resolution error does NOT retry model decision repairs", async () => {
    const ctx = await fixture()
    let calls = 0
    const deps = {
      createDriver: async () => ({
        implementation: "b".repeat(64),
        preflight: async () => {},
        invoke: async (arg: { workDir: string }) => {
          calls++
          await writeFile(path.join(arg.workDir, "decision.json"), JSON.stringify(decision))
          return { completed: true, actualModel: "fixture" }
        },
      }),
    }
    const input: IntakeInput = {
      ...ctx,
      mode: "auto",
      model: "fixture",
      expectedModel: "fixture",
      timeoutMs: 5000,
      maxInputBytes: 64000,
      maxDecisionBytes: 16000,
      maxDecisionRepairs: 2,
      // 未发布 V2 模板时拒绝，不进入模型纠错。
      explorationRequest: { mode: "window", afterRound: 3 } as any,
    }
    await expect(prepareTask(input, deps as never)).rejects.toThrow("No matching approved exploration template")
    expect(calls).toBe(0)
  })

  for (const [mode, kind] of (["auto", "manual_decision"] as const).flatMap(mode =>
    (["window", "metric"] as const).map(kind => [mode, kind] as const))) {
    test(`${mode}/${kind}: V2 freezes approved template and replays it after registry upgrade`, async () => {
      const ctx = await fixture()
      ctx.catalogue.stop.rounds = 4
      if (kind === "metric") ctx.catalogue.profiles[0].selection = { rule: "best_pass", metric: "score", direction: "min" }
      const { defaultObservations, ...policy } = fixtureTemplate.policy
      const template: HostExplorationTemplateV2 = {
        ...fixtureTemplate, schema: "aev.exploration-template.v2", version: "2",
        policy: { ...policy, schema: "aev.exploration-policy.v2", window: { minimumRounds: 2, maximumRounds: 2 },
          trigger: kind === "window" ? { kind } : {
            kind, name: "score", direction: "min", minimumDelta: 0.01, minimumObservations: 2, patience: 2,
          }, budget: { mode: "best_effort" } },
      }
      let calls = 0
      const createDriver = async () => ({
        implementation: "a".repeat(64), preflight: async () => {},
        invoke: async (arg: { workDir: string }) => {
          calls++
          await writeFile(path.join(arg.workDir, "decision.json"), JSON.stringify(decision))
          return { completed: true, actualModel: "fixture" }
        },
      })
      const common = { ...ctx, explorationRequest: kind === "window"
          ? { mode: kind, afterRound: 2, template: template.id }
          : { mode: kind, template: template.id },
        explorationSupport: { checkers: [{ name: "review", id: "review" }] } }
      const input: IntakeInput = mode === "auto"
        ? { ...common, mode, model: "fixture", expectedModel: "fixture", timeoutMs: 5000, maxInputBytes: 64000, maxDecisionBytes: 16000 }
        : { ...common, mode, decision }
      const first = await prepareTask(input, { templates: [template], createDriver })
      if (first.status !== "ready") throw new Error("Expected ready")
      const file = path.join(ctx.dir, "exploration-resolution.json")
      const bytes = await readFile(file)
      const proof = JSON.parse(bytes.toString("utf8"))
      expect(proof.template).toEqual(template)
      expect(proof.policy).toEqual(template.policy)
      expect(proof.summary.counting.unit).toBe("closed_original_rounds")
      expect(proof.summary.window).toEqual(template.policy.window)
      expect(proof.summary.budgetMode).toBe("best_effort")
      if (kind === "metric") expect(proof.summary.counting.metricUnit).toBe("trusted_execution_measurements")
      const upgraded = structuredClone(template)
      upgraded.version = "3"
      upgraded.policy.window = { minimumRounds: 3, maximumRounds: 3 }
      const again = await prepareTask(input, { templates: [upgraded], createDriver })
      if (again.status !== "ready") throw new Error("Expected ready")
      expect(again.reused).toBe(true)
      expect(again.plan).toEqual(first.plan)
      expect(await readFile(file)).toEqual(bytes)
      expect(calls).toBe(mode === "auto" ? 1 : 0)
      const empty = await prepareTask(input, { templates: [], createDriver })
      if (empty.status !== "ready") throw new Error("Expected ready")
      expect(empty.plan).toEqual(first.plan)

      // 即使回执 hash 同步改写，冻结模板与 policy 不一致仍拒绝。
      proof.template.policy.window = { minimumRounds: 1, maximumRounds: 1 }
      await writeFile(file, JSON.stringify(proof))
      const receipt = path.join(ctx.dir, "intake.completed.json")
      const saved = JSON.parse(await readFile(receipt, "utf8"))
      saved.resolutionSHA256 = new Bun.CryptoHasher("sha256").update(await readFile(file)).digest("hex")
      await writeFile(receipt, JSON.stringify(saved))
      await expect(prepareTask(input, { templates: [], createDriver })).rejects.toThrow()
      expect(calls).toBe(mode === "auto" ? 1 : 0)
    })
  }

  test("auto: template/Host mismatch after Decision never invokes decision repair", async () => {
    const ctx = await fixture()
    ctx.catalogue.stop.rounds = 2
    let calls = 0
    const input: IntakeInput = { ...ctx, mode: "auto", model: "fixture", expectedModel: "fixture",
      timeoutMs: 5000, maxInputBytes: 64000, maxDecisionBytes: 16000, maxDecisionRepairs: 2,
      explorationRequest: { mode: "observations", after: 1 },
      explorationSupport: { checkers: [{ name: "review", id: "wrong-checker" }] } }
    const dependencies = { templates: [fixtureTemplate], createDriver: async () => ({
      implementation: "d".repeat(64), preflight: async () => {},
      invoke: async (arg: { workDir: string }) => {
        calls++
        await writeFile(path.join(arg.workDir, "decision.json"), JSON.stringify(decision))
        return { completed: true, actualModel: "fixture" }
      },
    }) }
    await expect(prepareTask(input, dependencies)).rejects.toThrow("No matching approved exploration template")
    expect(calls).toBe(1)
  })

  test("malformed trusted templates reject before the first Intake request", async () => {
    const { defaultObservations, ...policy } = fixtureTemplate.policy
    const template: HostExplorationTemplateV2 = {
      ...fixtureTemplate, schema: "aev.exploration-template.v2",
      policy: { ...policy, schema: "aev.exploration-policy.v2", window: { minimumRounds: 1, maximumRounds: 2 },
        trigger: { kind: "window" }, budget: { mode: "best_effort" } },
      overrides: { patience: { minimum: 3, maximum: 1 } },
    }
    for (const explorationRequest of [{ mode: "auto" as const }, { mode: "auto" as const, template: template.id }]) {
      const ctx = await fixture()
      let drivers = 0
      const dependencies = { templates: [template], createDriver: async () => { drivers++; throw new Error("Unexpected driver") } }
      await expect(prepareTask({ ...ctx, mode: "auto", model: "fixture", expectedModel: "fixture", timeoutMs: 5000,
        maxInputBytes: 64000, maxDecisionBytes: 16000, explorationRequest }, dependencies)).rejects.toThrow("Invalid template override range")
      expect(drivers).toBe(0)
    }
  })

  test("malformed low-config requests reject before driver creation on every intake track", async () => {
    for (const explorationRequest of [{ mode: "window", afterRound: 0 }, { mode: "metric", budgetMode: "reserved" }, { mode: "off", patience: 2 }]) {
      const ctx = await fixture()
      let drivers = 0
      const dependencies = { createDriver: async () => { drivers++; throw new Error("Unexpected driver") } }
      await expect(prepareTask({ ...ctx, mode: "auto", model: "fixture", expectedModel: "fixture", timeoutMs: 5000,
        maxInputBytes: 64000, maxDecisionBytes: 16000, explorationRequest } as IntakeInput, dependencies)).rejects.toThrow()
      await expect(prepareTask({ ...ctx, mode: "manual_decision", decision, explorationRequest } as IntakeInput, dependencies)).rejects.toThrow()
      expect(drivers).toBe(0)
    }
  })

  test("manual_plan: active exploration rejected and conflicts fail closed", async () => {
    const ctx = await fixture()
    const ready = compileTask(ctx.catalogue, decision)
    if (ready.status !== "ready") throw new Error("Expected ready")
    const planPath = path.join(ctx.base, "preset-plan.json")
    await writeFile(planPath, JSON.stringify(ready.plan))

    // Active exploration on manual_plan rejected
    await expect(
      prepareTask({
        ...ctx,
        mode: "manual_plan",
        planPath,
        catalogue: { ...ctx.catalogue, approvedPlans: [fingerprint(ready.plan)] },
        explorationRequest: { mode: "auto" },
      }),
    ).rejects.toThrow(/Manual Plan mode does not support active exploration requests/)

    // off request with no exploration is valid
    const res = await prepareTask({
      ...ctx,
      mode: "manual_plan",
      planPath,
      catalogue: { ...ctx.catalogue, approvedPlans: [fingerprint(ready.plan)] },
      explorationRequest: { mode: "off" },
    })
    expect(res.status).toBe("ready")
    if (res.status !== "ready") throw new Error("Expected ready")
    expect(res.plan.exploration).toBeUndefined()
  })
})
