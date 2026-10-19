import { expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fingerprint } from "../../protocol-plugins/identity"
import { inspectBudget, inspectIntakePrefix, openRequestStage, reserveRequest, settleRequest } from "../request-budget"
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
    pass: 1,
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

test("settled intake prefix is explicitly adopted without resetting calls or tokens", async () => {
  const f = await setup()
  const budget = { ...f.budget, root: await mkdtemp(path.join(os.tmpdir(), "aev-intake-prefix-")) }
  const request = { id: "intake", request: fingerprint("intake"), role: "intake", model: "fixture", reservationTokens: 10 }
  await reserveRequest(budget, request)
  await settleRequest(budget, request.id, 7)
  const prefix = await inspectIntakePrefix(budget)
  expect(prefix.count).toBe(1)
  await expect(reserveRequest(budget, { ...request, id: "oversized-intake", reservationTokens: 100 })).rejects.toThrow("exhausted")
  expect((await inspectBudget(budget)).denial?.reason).toBe("tokens")
  await expect(openRequestStage(budget, f.policy, null)).rejects.toThrow("first author")
  const policy = { ...f.policy, tokens: 60 }
  const gate = await openRequestStage(budget, policy, null, prefix)
  expect(gate.start).toBe(1)
  expect(await openRequestStage(budget, policy, null, prefix)).toEqual(gate)
  expect(await inspectBudget(budget)).toMatchObject({ admittedAttempts: 1, reportedTokens: 7, outstandingTokens: 0 })
  expect((await inspectBudget(budget)).denial).toBeUndefined()
  await reserveRequest(budget, { ...request, id: "author", request: fingerprint("author"), role: "lead", gate: gate.id })
  await settleRequest(budget, "author", 5)
  expect((await inspectBudget(budget)).reportedTokens).toBe(12)
  await expect(reserveRequest(budget, { ...request, id: "late-intake" })).rejects.toThrow("gate mismatch")
  const next = { ...policy, stage: "acceptance" as const, roles: ["checker"], calls: 2, tokens: 30, protectedCalls: 0, protectedTokens: 0 }
  await expect(openRequestStage(budget, next, gate.id, prefix)).rejects.toThrow("twice")
  const accepting = await openRequestStage(budget, next, gate.id)
  expect((await inspectBudget(budget)).denial).toBeUndefined()
  await reserveRequest(budget, { ...request, id: "checker", request: fingerprint("checker"), role: "checker", gate: accepting.id })
  await settleRequest(budget, "checker", 4)
  expect(await inspectBudget(budget)).toMatchObject({ admittedAttempts: 3, reportedTokens: 16 })
  const file = path.join(budget.root, "budget.json")
  const saved = JSON.parse(await readFile(file, "utf8"))
  saved.attempts[0].usedTokens = 1
  await writeJsonAtomic(file, saved)
  await expect(inspectBudget(budget)).rejects.toThrow("prefix evidence drift")
})

test("intake adoption rejects in-flight, unknown, other-role, changed-prefix and insufficient-wallet states", async () => {
  const f = await setup()
  for (const mode of ["reserved", "unknown", "author", "changed", "insufficient"] as const) {
    const budget = { ...f.budget, root: await mkdtemp(path.join(os.tmpdir(), "aev-intake-reject-")) }
    await reserveRequest(budget, { id: "one", request: fingerprint("one"), role: mode === "author" ? "lead" : "intake", model: "fixture", reservationTokens: 20 })
    if (mode !== "reserved") await settleRequest(budget, "one", mode === "unknown" ? undefined : 20)
    if (["reserved", "unknown", "author"].includes(mode)) {
      await expect(inspectIntakePrefix(budget)).rejects.toThrow("settled intake")
      continue
    }
    const prefix = await inspectIntakePrefix(budget)
    if (mode === "changed") {
      await reserveRequest(budget, { id: "two", request: fingerprint("two"), role: "intake", model: "fixture", reservationTokens: 1 })
      await settleRequest(budget, "two", 1)
      await expect(openRequestStage(budget, f.policy, null, prefix)).rejects.toThrow("prefix changed")
    } else {
      await expect(openRequestStage(budget, f.policy, null, prefix)).rejects.toThrow("minimum resources")
    }
    expect((await inspectBudget(budget)).admittedAttempts).toBe(mode === "changed" ? 2 : 1)
  }
})

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
  await openRequestStage(
    budget,
    { ...policy, stage: "acceptance", roles: ["checker"], calls: 2, tokens: 30, protectedCalls: 0, protectedTokens: 0 },
    gate.id,
  )
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
  const next = await openRequestStage(
    budget,
    { ...policy, stage: "acceptance", roles: ["checker"], calls: 2, tokens: 30, protectedCalls: 0, protectedTokens: 0 },
    gate.id,
  )
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
  await expect(reserveRequest(budget, { ...attempt("bypass"), gate: undefined })).rejects.toThrow(
    "initialization binding drift",
  )
})

test("restored historical stages cannot contain unresolved calls", async () => {
  const { budget, policy, gate, attempt } = await setup()
  await reserveRequest(budget, attempt("one", 10))
  await settleRequest(budget, "one", 10)
  const next = await openRequestStage(
    budget,
    { ...policy, stage: "acceptance", roles: ["checker"], calls: 2, tokens: 30, protectedCalls: 0, protectedTokens: 0 },
    gate.id,
  )
  const file = path.join(budget.root, "budget.json"),
    saved = JSON.parse(await readFile(file, "utf8"))
  saved.attempts[0].status = "reserved"
  delete saved.attempts[0].usedTokens
  await writeJsonAtomic(file, saved)
  const before = await readFile(file, "utf8")
  await expect(inspectBudget(budget)).rejects.toThrow("settlement")
  await expect(reserveRequest(budget, { ...attempt("check", 10), gate: next.id, role: "checker" })).rejects.toThrow(
    "settlement",
  )
  await expect(openRequestStage(budget, { ...policy, round: 2 }, next.id)).rejects.toThrow("settlement")
  expect(await readFile(file, "utf8")).toBe(before)
})

test("pass02 stays in the same round without resetting author or acceptance allowance", async () => {
  const { budget, policy, gate, attempt } = await setup()
  for (const id of ["author-one", "author-two"]) {
    await reserveRequest(budget, attempt(id, 1))
    await settleRequest(budget, id, 1)
  }
  const checking: Admission = {
    ...policy,
    stage: "acceptance",
    roles: ["checker"],
    calls: 2,
    tokens: 30,
    protectedCalls: 0,
    protectedTokens: 0,
  }
  const first = await openRequestStage(budget, checking, gate.id)
  await reserveRequest(budget, { ...attempt("check-one", 1), gate: first.id, role: "checker" })
  await settleRequest(budget, "check-one", 1)
  const second = await openRequestStage(
    budget,
    { ...policy, pass: 2, protectedCalls: 1, protectedTokens: 20 },
    first.id,
  )
  expect(second.policy.round).toBe(1)
  expect(second.policy.pass).toBe(2)
  await reserveRequest(budget, { ...attempt("author-three", 1), gate: second.id })
  await settleRequest(budget, "author-three", 1)
  await expect(reserveRequest(budget, { ...attempt("author-four", 1), gate: second.id })).rejects.toThrow("exhausted")
  const last = await openRequestStage(budget, { ...checking, pass: 2 }, second.id)
  await reserveRequest(budget, { ...attempt("check-two", 1), gate: last.id, role: "checker" })
  await settleRequest(budget, "check-two", 1)
  await expect(reserveRequest(budget, { ...attempt("check-three", 1), gate: last.id, role: "checker" })).rejects.toThrow("exhausted")
  expect((await inspectBudget(budget)).reportedTokens).toBe(5)
  expect((await inspectBudget(budget)).admittedAttempts).toBe(5)
})

test("pass changes cannot enlarge round allowance, skip passes or activate inside an open round", async () => {
  const { budget, policy, gate } = await setup()
  const checking = await openRequestStage(
    budget,
    { ...policy, stage: "acceptance", roles: ["checker"], calls: 2, tokens: 30, protectedCalls: 0, protectedTokens: 0 },
    gate.id,
  )
  await expect(openRequestStage(budget, { ...policy, pass: 2, calls: 4 }, checking.id)).rejects.toThrow(
    "allowance drift",
  )
  await expect(openRequestStage(budget, { ...policy, pass: 2, tokens: 71 }, checking.id)).rejects.toThrow("allowance drift")
  await expect(openRequestStage(budget, { ...policy, pass: 2, roles: ["executor"] }, checking.id)).rejects.toThrow("allowance drift")
  await expect(openRequestStage(budget, { ...policy, pass: 3 }, checking.id)).rejects.toThrow("transition")
  await expect(openRequestStage(budget, { ...policy, pass: 2, generation: 1 }, checking.id)).rejects.toThrow(
    "transition",
  )
  const second = await openRequestStage(budget, { ...policy, pass: 2 }, checking.id)
  expect(second.policy.pass).toBe(2)
})

test("both author and acceptance cumulative token ceilings survive pass02 and ledger reload", async () => {
  const { budget, policy, gate, attempt } = await setup()
  await reserveRequest(budget, attempt("author-one", 60))
  await settleRequest(budget, "author-one", 60)
  const checking: Admission = { ...policy, stage: "acceptance", roles: ["checker"], calls: 2, tokens: 30,
    protectedCalls: 0, protectedTokens: 0 }
  const first = await openRequestStage(budget, checking, gate.id)
  await reserveRequest(budget, { ...attempt("check-one", 20), gate: first.id, role: "checker" })
  await settleRequest(budget, "check-one", 20)
  const author = await openRequestStage(budget, { ...policy, pass: 2, protectedCalls: 1, protectedTokens: 10 }, first.id)
  await expect(reserveRequest(budget, { ...attempt("author-over", 11), gate: author.id })).rejects.toThrow("exhausted")
  expect((await inspectBudget(budget)).stageDenial?.layer).toBe("stage")
  await reserveRequest(budget, { ...attempt("author-two", 10), gate: author.id })
  await settleRequest(budget, "author-two", 10)
  const accept = await openRequestStage(budget, { ...checking, pass: 2 }, author.id)
  await expect(reserveRequest(budget, { ...attempt("check-over", 11), gate: accept.id, role: "checker" })).rejects.toThrow("exhausted")
  await reserveRequest(budget, { ...attempt("check-two", 10), gate: accept.id, role: "checker" })
  await settleRequest(budget, "check-two", 10)
  expect((await inspectBudget(budget)).reportedTokens).toBe(100)
  expect((await inspectBudget(budget)).admittedAttempts).toBe(4)
})
