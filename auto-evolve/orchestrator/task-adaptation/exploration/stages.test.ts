import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { bindPlan } from "../binding"
import { fingerprint } from "../../protocol-plugins/identity"
import type { LongTaskSpec } from "../../long-task/contract"
import { inspectBudget, inspectIntakePrefix, openRequestStage, reserveRequest, settleRequest } from "../request-budget"
import { taskInvocation } from "../context"
import { taskRequestBudget } from "../budget-policy"
import { budgetedProviderFetch } from "../budget-transport"
import { openTaskRequestStage } from "./stages"
import { explorationIdentity } from "./policy"
import { plan, policy } from "./policy.test"

async function fixture(modify?: (cfg: ReturnType<typeof plan>) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-host-stages-")), candidate = path.join(root, "candidate")
  await mkdir(candidate)
  for (const resource of plan().resources) await writeFile(path.join(candidate, resource.path), resource.id)
  const cfg = plan()
  cfg.exploration = policy()
  modify?.(cfg)
  const bound = await bindPlan(candidate, cfg, [])
  const budget = { root: path.join(root, "budget"), scope: "same-task", calls: cfg.stop.calls, tokens: cfg.stop.tokens }
  const protocol = fingerprint("synthetic-protocol-scope")
  const spec = { taskAdaptation: { schema: "aev.task-adaptation.v1", root: candidate, planPath: path.join(root, "plan.json"),
    capabilities: [], entries: [{ id: "report", path: "report.md" }, { id: "facts", path: "facts.md" }],
    requestBudget: { schema: "aev.task-budget-policy.v1", root: budget.root, scope: budget.scope,
      models: [{ model: "fixture", dialect: "openai_chat", expectedModels: ["fixture"], maxInputTokens: 100, maxOutputTokens: 100 }] } },
    taskAdaptationContext: bound, taskAdaptationCampaignRoot: path.join(root, "campaign"),
    protocolAuthorContext: { fingerprint: protocol } } as LongTaskSpec
  const scope = { campaign: "campaign", plan: bound.fingerprint, policy: explorationIdentity(cfg.exploration, bound.plan)!,
    protocol, budget: { root: budget.root, scope: budget.scope } }
  const input = { scope, round: 1, pass: 1, generation: 0 as const, stage: "author" as const, previous: null }
  return { root, spec, budget, input }
}

test("stage adapter derives fixed roles and protections without consuming virtual requests", async () => {
  const f = await fixture()
  const first = await openTaskRequestStage(f.spec, f.input)
  expect(first.gate.policy.roles).toEqual(["planner", "executor", "worker", "lead", "diagnostician"])
  expect(first.gate.policy.protectedCalls).toBe(1)
  expect(first.gate.policy.protectedTokens).toBe(1000)
  expect(first.spec.taskAdaptationRequestGate).toBe(first.gate.id)
  expect(f.spec.taskAdaptationRequestGate).toBeUndefined()
  expect((await inspectBudget(f.budget)).admittedAttempts).toBe(0)
  expect(await openTaskRequestStage(f.spec, f.input)).toEqual(first)
  // 安装预算阶段不等于Host执行能力已具备。
  expect(() => taskInvocation(first.spec, "lead")).toThrow("Host lifecycle not connected")
})

test("all author roles share a finite round cap and next pass does not reset consumption", async () => {
  const f = await fixture(), first = await openTaskRequestStage(f.spec, f.input)
  for (const role of first.gate.policy.roles) {
    await reserveRequest(f.budget, { id: role, request: fingerprint(role), role, model: "fixture", gate: first.gate.id, reservationTokens: 10 })
    await settleRequest(f.budget, role, 1)
  }
  const acceptance = await openTaskRequestStage(first.spec, { ...f.input, stage: "acceptance", previous: first.gate.id })
  expect(acceptance.gate.policy.roles).toEqual(["reviewer", "independent", "checker"])
  expect(acceptance.gate.policy.protectedCalls).toBe(0)
  await expect(reserveRequest(f.budget, { id: "late", request: fingerprint("late"), role: "lead", model: "fixture",
    gate: first.gate.id, reservationTokens: 10 })).rejects.toThrow("gate mismatch")
  await reserveRequest(f.budget, { id: "reviewer", request: fingerprint("reviewer"), role: "reviewer", model: "fixture",
    gate: acceptance.gate.id, reservationTokens: 10 })
  await settleRequest(f.budget, "reviewer", 1)
  const next = await openTaskRequestStage(acceptance.spec, { ...f.input, pass: 2, previous: acceptance.gate.id })
  expect(next.gate.policy).toMatchObject({ protectedCalls: 0, protectedTokens: 0 })
  await expect(reserveRequest(f.budget, { id: "extra-author", request: fingerprint("extra"), role: "lead", model: "fixture",
    gate: next.gate.id, reservationTokens: 10 })).rejects.toThrow("Request budget exhausted")
  expect(await inspectBudget(f.budget)).toMatchObject({ admittedAttempts: 6, reportedTokens: 6,
    stageDenial: { layer: "stage", reason: "calls", gate: next.gate.id } })
  expect(first.spec.taskAdaptationRequestGate).toBe(first.gate.id)
})

test("explicit intake prefix adoption keeps the same wallet and settles before author entry", async () => {
  const f = await fixture()
  await reserveRequest(f.budget, { id: "intake", request: fingerprint("intake"), role: "intake", model: "fixture", reservationTokens: 10 })
  await settleRequest(f.budget, "intake", 4)
  const prefix = await inspectIntakePrefix(f.budget)
  const result = await openTaskRequestStage(f.spec, { ...f.input, prefix })
  expect(result.gate.start).toBe(1)
  expect(await inspectBudget(f.budget)).toMatchObject({ admittedAttempts: 1, reportedTokens: 4 })
  expect(result.spec.taskAdaptation?.requestBudget).toEqual(f.spec.taskAdaptation?.requestBudget)
})

test("wrong Campaign, plan, protocol or wallet scope never receives a stage authorization", async () => {
  const f = await fixture()
  for (const scope of [
    { ...f.input.scope, campaign: "other" }, { ...f.input.scope, plan: "a".repeat(64) },
    { ...f.input.scope, protocol: "b".repeat(64) },
    { ...f.input.scope, budget: { ...f.input.scope.budget, scope: "other" } },
  ]) await expect(openTaskRequestStage(f.spec, { ...f.input, scope })).rejects.toThrow("scope drift")
  expect((await inspectBudget(f.budget)).admittedAttempts).toBe(0)
})

test("stage admission cannot exceed the frozen global round limit", async () => {
  const f = await fixture()
  for (const round of [0, 8, 1.5, Number.NaN]) {
    await expect(openTaskRequestStage(f.spec, { ...f.input, round })).rejects.toThrow("round outside")
  }
  expect((await inspectBudget(f.budget)).admittedAttempts).toBe(0)
})

test("stage grants enforce limits before dispatch and preserve acceptance on the actual budget transport", async () => {
  const f = await fixture(), author = await openTaskRequestStage(f.spec, f.input)
  let calls = 0
  const transport: typeof fetch = async () => {
    calls++
    return Response.json({ model: "fixture", usage: { prompt_tokens: 2, completion_tokens: 1 } })
  }
  const request = (role: string, gate: string) => budgetedProviderFetch("http://127.0.0.1/synthetic", {
    method: "POST", body: JSON.stringify({ model: "fixture", max_tokens: 10,
      messages: [{ role: "user", content: "synthetic" }] }),
  }, taskRequestBudget(f.spec.taskAdaptation!.requestBudget!, f.spec.taskAdaptationContext!.plan.stop,
    role, "fixture", gate), 100, transport)
  for (const role of author.gate.policy.roles) await (await request(role, author.gate.id)).text()
  await expect(request("lead", author.gate.id)).rejects.toThrow("budget exhausted")
  expect(calls).toBe(5)
  const acceptance = await openTaskRequestStage(author.spec, { ...f.input, stage: "acceptance", previous: author.gate.id })
  await expect(request("lead", acceptance.gate.id)).rejects.toThrow("gate mismatch")
  await expect(request("independent", author.gate.id)).rejects.toThrow("gate mismatch")
  await (await request("independent", acceptance.gate.id)).text()
  expect(calls).toBe(6)
  expect(await inspectBudget(f.budget)).toMatchObject({ admittedAttempts: 6, reportedTokens: 18, outstandingTokens: 0 })
})

test("tight calls and tokens retain only unused acceptance protection across passes", async () => {
  const f = await fixture(cfg => {
    cfg.stop.calls = 6
    cfg.stop.tokens = 600
    Object.assign(cfg.exploration!.allowance, { minimumRounds: 1,
      authorCalls: 3, authorTokens: 300, acceptanceCalls: 2, acceptanceTokens: 200,
      deliveryCalls: 1, deliveryTokens: 100 })
  })
  const consume = async (id: string, role: string, gate: string) => {
    await reserveRequest(f.budget, { id, role, gate, model: "fixture", request: fingerprint(id), reservationTokens: 100 })
    await settleRequest(f.budget, id, 100)
  }
  const first = await openTaskRequestStage(f.spec, f.input)
  await consume("author1", "lead", first.gate.id)
  const acceptance = await openTaskRequestStage(first.spec, { ...f.input, stage: "acceptance", previous: first.gate.id })
  await consume("acceptance1", "reviewer", acceptance.gate.id)
  const second = await openTaskRequestStage(acceptance.spec, { ...f.input, pass: 2, previous: acceptance.gate.id })
  expect(second.gate.policy).toMatchObject({ protectedCalls: 2, protectedTokens: 200 })
  await consume("author2", "lead", second.gate.id)
  expect(await openTaskRequestStage(acceptance.spec, { ...f.input, pass: 2, previous: acceptance.gate.id })).toEqual(second)
  await consume("author3", "lead", second.gate.id)
  await expect(consume("extra", "lead", second.gate.id)).rejects.toThrow("exhausted")
  const final = await openTaskRequestStage(second.spec, { ...f.input, pass: 2, stage: "acceptance", previous: second.gate.id })
  await consume("acceptance2", "checker", final.gate.id)
  const delivery = await openTaskRequestStage(final.spec, { ...f.input, pass: 2, stage: "delivery", previous: final.gate.id })
  await consume("delivery", "delivery", delivery.gate.id)
  expect(await inspectBudget(f.budget)).toMatchObject({ admittedAttempts: 6, reportedTokens: 600 })
})

test("cross-round stage produces an aligned new spec without changing an old role identity", async () => {
  const f = await fixture(), first = await openTaskRequestStage(f.spec, f.input)
  expect(first.spec.taskAdaptationRound).toBe(1)
  const acceptance = await openTaskRequestStage(first.spec, { ...f.input, stage: "acceptance", previous: first.gate.id })
  const second = await openTaskRequestStage(acceptance.spec, { ...f.input, round: 2, previous: acceptance.gate.id })
  expect(second.spec.taskAdaptationRound).toBe(2)
  expect(second.gate.policy.round).toBe(2)
  expect(first.spec.taskAdaptationRound).toBe(1)
  expect(first.spec.taskAdaptationRequestGate).toBe(first.gate.id)
  expect(f.spec.taskAdaptationRound).toBeUndefined()
})

test("reserved, unknown and overrun requests block stage transitions without changing the wallet", async () => {
  for (const status of ["reserved", "unknown", "overrun"] as const) {
    const f = await fixture(), first = await openTaskRequestStage(f.spec, f.input)
    await reserveRequest(f.budget, { id: "pending", request: fingerprint("pending"), role: "lead", model: "fixture",
      gate: first.gate.id, reservationTokens: 10 })
    if (status !== "reserved") await settleRequest(f.budget, "pending", status === "unknown" ? undefined : 11)
    const file = path.join(f.budget.root, "budget.json"), before = await readFile(file, "utf8")
    await expect(openTaskRequestStage(first.spec, { ...f.input, stage: "acceptance", previous: first.gate.id })).rejects.toThrow("unresolved")
    expect(await readFile(file, "utf8")).toBe(before)
  }
})

test("invalid future-stage declarations are rejected before changing an existing gate", async () => {
  const f = await fixture(), first = await openTaskRequestStage(f.spec, f.input)
  const future = { ...first.gate.policy, stage: "acceptance" as const, roles: ["reviewer", "independent", "checker"],
    calls: 1, tokens: 1000, protectedCalls: 0, protectedTokens: 0 }
  const file = path.join(f.budget.root, "budget.json"), before = await readFile(file, "utf8")
  for (const protection of [[{ ...future, policy: "a".repeat(64) }], [{ ...future, round: 2 }],
    [{ ...future, pass: 2 }], [{ ...future, generation: 1 as const }], [first.gate.policy], [future, future],
    [{ ...future, calls: 2 }]]) {
    await expect(openRequestStage(f.budget, first.gate.policy, null, undefined, protection)).rejects.toThrow()
    expect(await readFile(file, "utf8")).toBe(before)
  }
})

test("acceptance with no tokens left does not retain unusable call protection", async () => {
  const f = await fixture(cfg => {
    cfg.stop.calls = 6
    cfg.stop.tokens = 600
    Object.assign(cfg.exploration!.allowance, { minimumRounds: 1,
      authorCalls: 3, authorTokens: 300, acceptanceCalls: 2, acceptanceTokens: 200,
      deliveryCalls: 1, deliveryTokens: 100 })
  })
  const first = await openTaskRequestStage(f.spec, f.input)
  const acceptance = await openTaskRequestStage(first.spec, { ...f.input, stage: "acceptance", previous: first.gate.id })
  await reserveRequest(f.budget, { id: "accept", request: fingerprint("accept"), role: "checker", model: "fixture",
    gate: acceptance.gate.id, reservationTokens: 200 })
  await settleRequest(f.budget, "accept", 200)
  const next = await openTaskRequestStage(acceptance.spec, { ...f.input, pass: 2, previous: acceptance.gate.id })
  expect(next.gate.policy).toMatchObject({ protectedCalls: 1, protectedTokens: 100 })
})
