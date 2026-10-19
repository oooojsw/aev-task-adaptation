import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { taskRequestBudget, taskRuntimeBudgets, freezeTaskBudgetPolicy, validateTaskBudgetPolicy, type TaskBudgetPolicy } from "./budget-policy"
import type { Plan } from "./plan"
import { reserveRequest, settleRequest } from "./request-budget"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-policy-"))
  const policy: TaskBudgetPolicy = { schema: "aev.task-budget-policy.v1", root: path.join(root, "budget"), scope: "same-task",
    models: [{ model: "fixture/model", dialect: "openai_chat", expectedModels: ["wire-model"], maxInputTokens: 1000, maxOutputTokens: 100 }] }
  const plan = { schema: "aev.task-plan.v1", stop: { rounds: 2, stagnant: 1, calls: 1, tokens: 2000 } } as Plan
  return { root, policy, plan }
}

test("stage gates are dynamic authorizations, not frozen backend mappings", async () => {
  const f = await fixture()
  const gate = "a".repeat(64)
  const ordinary = taskRuntimeBudgets(f.policy, f.plan.stop)
  const staged = taskRuntimeBudgets(f.policy, f.plan.stop, gate)
  expect(staged.requestGate).toBe(gate)
  expect(staged.httpBudgets).toEqual(ordinary.httpBudgets)
  expect(staged.toolBudgets).toEqual(ordinary.toolBudgets)
  expect(taskRequestBudget(f.policy, f.plan.stop, "lead", "fixture/model", gate).gate).toBe(gate)
  expect(() => taskRuntimeBudgets(undefined, f.plan.stop, gate)).toThrow("bounded transport")
  expect(() => taskRuntimeBudgets(f.policy, f.plan.stop, "invalid")).toThrow("bounded transport")
  expect(taskRuntimeBudgets(undefined, f.plan.stop)).toEqual({})
})

test("all roles and models share task-plan total limits rather than per-role limits", async () => {
  const f = await fixture()
  f.policy.models.push({ ...f.policy.models[0], model: "fixture/other", expectedModels: ["other"] })
  const lead = taskRequestBudget(f.policy, f.plan.stop, "lead", "fixture/model")
  const checker = taskRequestBudget(f.policy, f.plan.stop, "checker", "fixture/other")
  expect(lead.budget).toEqual(checker.budget)
  expect(checker.expectedModels).toEqual(["other"])
  const runtime = taskRuntimeBudgets(f.policy, f.plan.stop)
  expect(runtime.httpBudgets?.execution.config).toEqual(lead.budget)
  expect(runtime.httpBudgets?.judging.config).toEqual(lead.budget)
  expect(runtime.toolBudgets?.execution?.["fixture/model"].budget).toEqual(lead.budget)
  expect(runtime.toolBudgets?.judging?.["fixture/other"].budget).toEqual(lead.budget)
  await reserveRequest(lead.budget, { id: "one", request: "a".repeat(64), role: "lead", model: "wire-model", reservationTokens: 1100 })
  await settleRequest(lead.budget, "one", 17)
  await expect(reserveRequest(checker.budget, { id: "two", request: "b".repeat(64), role: "checker", model: "other", reservationTokens: 1100 })).rejects.toThrow("exhausted")
})

test("policy rejects unknown models, duplicated mappings and foreign configuration fields", async () => {
  const f = await fixture()
  expect(() => taskRequestBudget(f.policy, f.plan.stop, "lead", "unknown")).toThrow("no frozen")
  expect(() => validateTaskBudgetPolicy({ ...f.policy, models: [f.policy.models[0], f.policy.models[0]] })).toThrow()
  expect(() => validateTaskBudgetPolicy({ ...f.policy, calls: 100 })).toThrow()
  expect(() => validateTaskBudgetPolicy({ ...f.policy, models: [{ ...f.policy.models[0], credentials: "not allowed" }] })).toThrow()
})

test("frozen policy resumes identical binding but rejects model, plan and removal drift", async () => {
  const f = await fixture()
  await freezeTaskBudgetPolicy(f.root, f.policy, f.plan)
  const before = await readFile(path.join(f.root, "request-budget-policy.json"), "utf8")
  await freezeTaskBudgetPolicy(f.root, f.policy, f.plan)
  expect(await readFile(path.join(f.root, "request-budget-policy.json"), "utf8")).toBe(before)
  await expect(freezeTaskBudgetPolicy(f.root, { ...f.policy, scope: "new" }, f.plan)).rejects.toThrow("drift")
  await expect(freezeTaskBudgetPolicy(f.root, f.policy, { ...f.plan, stop: { ...f.plan.stop, calls: 2 } })).rejects.toThrow("drift")
  await expect(freezeTaskBudgetPolicy(f.root, undefined, f.plan)).rejects.toThrow("removed")
})

test("incomplete policy freeze is not silently overwritten and legacy creates nothing", async () => {
  const f = await fixture()
  await freezeTaskBudgetPolicy(f.root, undefined, f.plan)
  await expect(readFile(path.join(f.root, "request-budget-policy.json"))).rejects.toThrow()
  await writeFile(path.join(f.root, "request-budget-policy.json.claim"), "")
  await expect(freezeTaskBudgetPolicy(f.root, f.policy, f.plan)).rejects.toThrow()
  await expect(readFile(path.join(f.root, "request-budget-policy.json"))).rejects.toThrow()
})

test("orphan snapshot without a claim is not overwritten", async () => {
  const f = await fixture()
  const file = path.join(f.root, "request-budget-policy.json")
  await writeFile(file, "original evidence")
  await expect(freezeTaskBudgetPolicy(f.root, f.policy, f.plan)).rejects.toThrow("Unclaimed")
  expect(await readFile(file, "utf8")).toBe("original evidence")
})
