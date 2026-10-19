import { expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fingerprint } from "../../protocol-plugins/identity"
import { inspectBudget, openRequestStage, reserveRequest, settleRequest } from "../request-budget"
import { budgetedProviderFetch } from "../budget-transport"
import { admission, type Admission } from "./admission"
import { writeJsonAtomic } from "../../atomic-write"

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-admission-"))
  const budget = { root, scope: "same-task", calls: 8, tokens: 100 }
  const policy: Admission = {
    schema: "aev.exploration-admission.v1",
    policy: fingerprint("frozen-policy"),
    round: 1,
    generation: 0,
    stage: "author",
    roles: ["lead"],
    calls: 3,
    tokens: 70,
    protectedCalls: 2,
    protectedTokens: 30,
  }
  const gate = await openRequestStage(budget, policy, null)
  const attempt = (id: string, tokens = 40) => ({
    id,
    request: fingerprint(id),
    model: "fixture",
    role: "lead",
    reservationTokens: tokens,
    gate: gate.id,
  })
  return { budget, policy, gate, attempt }
}

test("stage admission has no virtual usage and idempotent opening cannot reset limits", async () => {
  const { budget, policy, gate, attempt } = await setup()
  expect((await inspectBudget(budget)).admittedAttempts).toBe(0)
  await reserveRequest(budget, attempt("one"))
  await settleRequest(budget, "one", 10)
  expect(await openRequestStage(budget, policy, null)).toEqual(gate)
  expect((await inspectBudget(budget)).reportedTokens).toBe(10)
  await expect(openRequestStage(budget, policy, gate.id)).rejects.toThrow("retry drift")
})

test("concurrent reservations cannot spend protected acceptance tokens", async () => {
  const { budget, attempt } = await setup()
  const results = await Promise.allSettled([
    reserveRequest(budget, attempt("one")),
    reserveRequest(budget, attempt("two")),
  ])
  expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1)
  expect((await inspectBudget(budget)).outstandingTokens).toBe(40)
  expect((await inspectBudget(budget)).admittedAttempts).toBe(1)
})

test("missing, stale and wrong-role gates are rejected before any provider request", async () => {
  const { budget, attempt, gate } = await setup()
  await expect(reserveRequest(budget, { ...attempt("missing"), gate: undefined })).rejects.toThrow("gate mismatch")
  await expect(reserveRequest(budget, { ...attempt("role"), role: "checker" })).rejects.toThrow("gate mismatch")
  let sent = false
  await expect(
    budgetedProviderFetch(
      "http://fixture.invalid",
      { method: "POST", body: JSON.stringify({ model: "fixture", messages: [], max_tokens: 10 }) },
      {
        schema: "aev.budget-transport.v1",
        budget,
        role: "lead",
        dialect: "openai_chat",
        expectedModels: ["fixture"],
        maxInputTokens: 30,
        maxOutputTokens: 10,
      },
      30,
      async () => {
        sent = true
        return new Response()
      },
    ),
  ).rejects.toThrow("gate mismatch")
  expect(sent).toBe(false)
  expect((await inspectBudget(budget)).admittedAttempts).toBe(0)
  expect(gate.id).toBe(admission((await setup()).policy).id)
})

test("stage switch requires settled prior requests and does not release unknown billing", async () => {
  const { budget, policy, gate, attempt } = await setup()
  await reserveRequest(budget, attempt("one"))
  const next = {
    ...policy,
    stage: "acceptance" as const,
    roles: ["checker"],
    calls: 2,
    tokens: 30,
    protectedCalls: 0,
    protectedTokens: 0,
  }
  await expect(openRequestStage(budget, next, gate.id)).rejects.toThrow("unresolved usage")
  await settleRequest(budget, "one", undefined)
  await expect(openRequestStage(budget, next, gate.id)).rejects.toThrow("unresolved usage")
  await expect(reserveRequest(budget, attempt("two", 10))).rejects.toThrow("unresolved usage")
})

test("bounded stages preserve global costs and reject old or backward stage writes", async () => {
  const { budget, policy, gate, attempt } = await setup()
  await reserveRequest(budget, attempt("one"))
  await settleRequest(budget, "one", 10)
  const next = await openRequestStage(
    budget,
    { ...policy, stage: "acceptance", roles: ["checker"], calls: 2, tokens: 30, protectedCalls: 0, protectedTokens: 0 },
    gate.id,
  )
  await expect(reserveRequest(budget, attempt("late", 1))).rejects.toThrow("gate mismatch")
  await reserveRequest(budget, { ...attempt("check", 20), role: "checker", gate: next.id })
  await settleRequest(budget, "check", 20)
  const branch = await openRequestStage(
    budget,
    { ...policy, generation: 1, round: 2, calls: 2, tokens: 40, protectedCalls: 1, protectedTokens: 20 },
    next.id,
  )
  expect(branch.start).toBe(2)
  await expect(openRequestStage(budget, { ...policy, round: 3 }, branch.id)).rejects.toThrow("transition")
  const result = await inspectBudget(budget)
  expect(result.reportedTokens).toBe(30)
  expect(result.admittedAttempts).toBe(2)
})

test("author local cap persists even when the global wallet is ample", async () => {
  const { budget, attempt } = await setup()
  for (const id of ["one", "two", "three"]) {
    await reserveRequest(budget, attempt(id, 1))
    await settleRequest(budget, id, 1)
  }
  await expect(reserveRequest(budget, attempt("four", 1))).rejects.toThrow("exhausted")
  expect((await inspectBudget(budget)).reportedTokens).toBe(3)
})

test("local stage denial is not global exhaustion and disappears on acceptance transition", async () => {
  const { budget, policy, gate, attempt } = await setup()
  for (const id of ["one", "two", "three"]) {
    await reserveRequest(budget, attempt(id, 1))
    await settleRequest(budget, id, 1)
  }
  await expect(reserveRequest(budget, attempt("extra", 1))).rejects.toThrow("exhausted")
  const denied = await inspectBudget(budget)
  expect(denied.denial).toBeUndefined()
  expect(denied.stageDenial?.layer).toBe("stage")
  await openRequestStage(budget, { ...policy, stage: "acceptance", roles: ["checker"], calls: 2, tokens: 30,
    protectedCalls: 0, protectedTokens: 0 }, gate.id)
  const next = await inspectBudget(budget)
  expect(next.denial).toBeUndefined()
  expect(next.stageDenial).toBeUndefined()
})

test("a large author request denial cannot stop a smaller affordable acceptance request", async () => {
  const { budget, policy, gate, attempt } = await setup()
  await reserveRequest(budget, attempt("author", 70))
  await settleRequest(budget, "author", 40)
  await expect(reserveRequest(budget, attempt("too-large", 70))).rejects.toThrow("exhausted")
  expect((await inspectBudget(budget)).denial?.reason).toBe("tokens")
  const next = await openRequestStage(budget, { ...policy, stage: "acceptance", roles: ["checker"], calls: 2, tokens: 30,
    protectedCalls: 0, protectedTokens: 0 }, gate.id)
  expect((await inspectBudget(budget)).denial).toBeUndefined()
  await reserveRequest(budget, { ...attempt("check", 30), role: "checker", gate: next.id })
  expect((await inspectBudget(budget)).outstandingTokens).toBe(30)
})

test("an empty protected ledger cannot be restored to unprotected legacy mode", async () => {
  const { budget, attempt } = await setup()
  const file = path.join(budget.root, "budget.json")
  const saved = JSON.parse(await readFile(file, "utf8"))
  delete saved.gates
  await writeJsonAtomic(file, saved)
  await expect(inspectBudget(budget)).rejects.toThrow("initialization binding drift")
  await expect(reserveRequest(budget, { ...attempt("bypass"), gate: undefined })).rejects.toThrow("initialization binding drift")
})

test("restored historical stages cannot contain unresolved calls", async () => {
  const { budget, policy, gate, attempt } = await setup()
  await reserveRequest(budget, attempt("one", 10))
  await settleRequest(budget, "one", 10)
  const next = await openRequestStage(budget, { ...policy, stage: "acceptance", roles: ["checker"], calls: 2, tokens: 30,
    protectedCalls: 0, protectedTokens: 0 }, gate.id)
  const file = path.join(budget.root, "budget.json"), saved = JSON.parse(await readFile(file, "utf8"))
  saved.attempts[0].status = "reserved"
  delete saved.attempts[0].usedTokens
  await writeJsonAtomic(file, saved)
  const before = await readFile(file, "utf8")
  await expect(inspectBudget(budget)).rejects.toThrow("settlement")
  await expect(reserveRequest(budget, { ...attempt("check", 10), gate: next.id, role: "checker" })).rejects.toThrow("settlement")
  await expect(openRequestStage(budget, { ...policy, round: 2 }, next.id)).rejects.toThrow("settlement")
  expect(await readFile(file, "utf8")).toBe(before)
})
