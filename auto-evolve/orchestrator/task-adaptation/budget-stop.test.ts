import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import type { LongTaskSpec } from "../long-task/contract"
import { taskRequestBudget } from "./budget-policy"
import { requestBudgetStop } from "./budget-stop"
import { reserveRequest, settleRequest } from "./request-budget"
import { chooseTaskVersion, type readTaskVersions } from "./selection"

async function fixture(calls = 2, tokens = 2000) {
  const policy = { schema: "aev.task-budget-policy.v1" as const, root: await mkdtemp(path.join(os.tmpdir(), "aev-budget-stop-")), scope: "task",
    models: [{ model: "fixture", dialect: "openai_chat" as const, expectedModels: ["fixture"], maxInputTokens: 100, maxOutputTokens: 100 }] }
  const plan = { stop: { calls, tokens, rounds: 8, stagnant: 8 }, selection: { rule: "best_pass", direction: "min" } }
  const spec = { taskAdaptation: { requestBudget: policy }, taskAdaptationContext: { plan } } as LongTaskSpec
  const cfg = taskRequestBudget(policy, plan.stop, "lead", "fixture").budget
  const reserve = (id: string) => reserveRequest(cfg, { id, request: "a".repeat(64), role: "lead", model: "fixture", reservationTokens: 200 })
  return { spec, cfg, reserve }
}

test("legacy and available task budgets do not invent a stop", async () => {
  expect(await requestBudgetStop({} as LongTaskSpec)).toBeUndefined()
  expect(await requestBudgetStop((await fixture()).spec)).toBeUndefined()
})

test("normal calls/tokens stop only selects existing qualified versions", async () => {
  const f = await fixture(1)
  await f.reserve("one")
  await settleRequest(f.cfg, "one", 17)
  const stop = await requestBudgetStop(f.spec)
  expect(stop).toMatchObject({ reason: "request_call_budget", inspectionRequired: false })
  const versions = [{ path: "qualified", record: { round: 1, metric: 8 } }] as Awaited<ReturnType<typeof readTaskVersions>>
  expect(chooseTaskVersion(f.spec, versions, 2, 8, stop!.reason)).toMatchObject({ selectedTaskVersionPath: "qualified", passed: true, stop: true })
  expect(chooseTaskVersion(f.spec, [], 2, 8, stop!.reason)).toMatchObject({ passed: false, stop: true })
  const t = await fixture(2, 200)
  await t.reserve("one")
  await settleRequest(t.cfg, "one", 150)
  expect(await requestBudgetStop(t.spec)).toMatchObject({ reason: "request_token_budget", inspectionRequired: false })
})

test("actual token admission denial stops even with some tokens still remaining", async () => {
  const f = await fixture(2, 250)
  await f.reserve("one")
  await settleRequest(f.cfg, "one", 100)
  expect(await requestBudgetStop(f.spec)).toBeUndefined()
  await expect(f.reserve("two")).rejects.toThrow("exhausted")
  expect(await requestBudgetStop(f.spec)).toMatchObject({ reason: "request_token_budget", inspectionRequired: false })
})

test("reserved, unknown and overrun usage require inspection rather than a successful budget finish", async () => {
  for (const usage of ["reserved", undefined, 201] as const) {
    const f = await fixture(1)
    await f.reserve("one")
    if (usage !== "reserved") await settleRequest(f.cfg, "one", usage)
    expect(await requestBudgetStop(f.spec)).toMatchObject({ inspectionRequired: true,
      reason: usage === 201 ? "request_budget_overrun" : "request_usage_unresolved" })
  }
})
