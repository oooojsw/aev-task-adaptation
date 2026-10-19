import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { LongTaskSpec } from "../long-task/contract"
import { loadLongTaskSpec } from "../long-task/spec"
import { bindPlan } from "./binding"
import { taskBudgetOptions, taskInvocation, taskRequestGate, withTaskRequestGate } from "./context"
import { plan } from "./exploration/policy.test"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-gate-context-")), cfg = plan()
  for (const resource of cfg.resources) await writeFile(path.join(root, resource.path), resource.id)
  const file = path.join(root, "plan.json")
  await writeFile(file, JSON.stringify(cfg))
  const bound = await bindPlan(root, cfg, [])
  const spec = { title: "gate fixture", goal: "check gate identity", validators: [],
    protocolPlugins: { schema: "aev.protocol-entry.v1", selectionPath: path.join(root, "selection.json"),
      projectManifestPath: path.join(root, "project.json"), taskID: "fixture", phase: "source" },
    taskAdaptation: { schema: "aev.task-adaptation.v1", planPath: file, root, capabilities: [],
      entries: [{ id: "report", path: "report.md" }, { id: "facts", path: "facts.md" }],
      requestBudget: { schema: "aev.task-budget-policy.v1", root: path.join(root, "budget"), scope: "same-task",
        models: [{ model: "fixture", dialect: "openai_chat", expectedModels: ["fixture"], maxInputTokens: 100, maxOutputTokens: 100 }] } },
    taskAdaptationContext: bound } as LongTaskSpec
  return { root, spec }
}

test("all role invocations inherit their own spec gate rather than the next mutable stage", async () => {
  const f = await fixture(), gate = "a".repeat(64), next = "b".repeat(64)
  const first = withTaskRequestGate(f.spec, gate), second = withTaskRequestGate(first, next)
  for (const role of ["planner", "executor", "worker", "lead", "reviewer", "diagnostician", "checker", "independent"] as const) {
    expect(taskInvocation(first, role)?.requestGate).toBe(gate)
    expect(taskInvocation(second, role)?.requestGate).toBe(next)
    expect(taskInvocation(f.spec, role)?.requestGate).toBeUndefined()
  }
  expect(() => taskInvocation(first, "lead", { requestGate: next })).toThrow("Conflicting")
  expect(taskInvocation(first, "lead", { requestGate: gate })?.requestGate).toBe(gate)
  const ordinary = await taskBudgetOptions(f.spec), staged = await taskBudgetOptions(first)
  expect(staged.requestGate).toBe(gate)
  expect(staged.httpBudgets).toEqual(ordinary.httpBudgets)
  expect(staged.toolBudgets).toEqual(ordinary.toolBudgets)
  await expect(taskBudgetOptions(first, next)).rejects.toThrow("Conflicting")
  expect(f.spec.taskAdaptationRequestGate).toBeUndefined()
})

test("saved inner spec retains explicit gate through the actual spec loader", async () => {
  const f = await fixture(), gate = "a".repeat(64), file = path.join(f.root, "spec.json")
  const { taskAdaptationContext: _, ...spec } = withTaskRequestGate(f.spec, gate)
  await writeFile(file, "\uFEFF" + JSON.stringify(spec))
  expect((await loadLongTaskSpec(file)).spec.taskAdaptationRequestGate).toBe(gate)
  await writeFile(file, JSON.stringify({ ...spec, taskAdaptationRequestGate: "invalid" }))
  await expect(loadLongTaskSpec(file)).rejects.toThrow("bounded transport")
  const { taskAdaptation: __, ...legacy } = spec
  await writeFile(file, JSON.stringify(legacy))
  await expect(loadLongTaskSpec(file)).rejects.toThrow("bounded transport")
})

test("gate cannot silently disappear when adaptation or its explicit budget is missing", () => {
  expect(() => taskRequestGate({ taskAdaptationRequestGate: "a".repeat(64) } as LongTaskSpec)).toThrow("bounded transport")
  expect(() => withTaskRequestGate({} as LongTaskSpec, "a".repeat(64))).toThrow("bounded transport")
  expect(taskRequestGate({} as LongTaskSpec)).toBeUndefined()
})
