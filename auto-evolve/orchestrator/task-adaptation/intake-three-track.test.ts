import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { prepareTask, type IntakeInput } from "./intake"
import { compileTask, type TaskCatalogue, type Decision } from "./catalogue"
import { fingerprint } from "../protocol-plugins/identity"

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

describe("three-track task intake", () => {
  test("manual_decision: compiles, writes audit proof, and reuses with no driver", async () => {
    const ctx = await fixture()
    const input: IntakeInput = { ...ctx, mode: "manual_decision", decision }
    const driver = { createDriver: async () => { throw new Error("No model driver allowed") } }
    const first = await prepareTask(input, driver as never)
    expect(first.status).toBe("ready")
    expect(first.reused).toBe(false)
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
    const result = await prepareTask({ ...ctx, mode: "manual_decision", decision: { ...decision, needs: ["unknown"] } })
    expect(result.status).toBe("missing_capabilities")
  })

  test("manual_decision: original source change prevents reuse", async () => {
    const ctx = await fixture()
    const decisionPath = path.join(ctx.base, "decision.json")
    await writeFile(decisionPath, JSON.stringify(decision))
    const input: IntakeInput = { ...ctx, mode: "manual_decision", decisionPath }
    await prepareTask(input)
    await writeFile(decisionPath, JSON.stringify({ ...decision, rationale: "new" }))
    await expect(prepareTask(input)).rejects.toThrow(/identity drift/)
  })

  test("manual_decision: changing input material prevents reuse", async () => {
    const ctx = await fixture()
    const input: IntakeInput = { ...ctx, mode: "manual_decision", decision }
    await prepareTask(input)
    await writeFile(path.join(ctx.root, "facts.txt"), "changed")
    await expect(prepareTask(input)).rejects.toThrow(/identity drift/)
  })

  test("manual_decision: corrupting completion or plan fails closed", async () => {
    const ctx = await fixture()
    const input: IntakeInput = { ...ctx, mode: "manual_decision", decision }
    const first = await prepareTask(input)
    if (first.status !== "ready") throw new Error("Expected ready")
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
})