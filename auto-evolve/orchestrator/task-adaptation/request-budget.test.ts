import { expect, test } from "bun:test"
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { reserveRequest, settleRequest, inspectBudget, type RequestBudget } from "./request-budget"

async function budget(calls = 3, tokens = 100): Promise<RequestBudget> {
  return { root: await mkdtemp(path.join(os.tmpdir(), "aev-request-budget-")), scope: "task", calls, tokens }
}
const attempt = (id: string, reservationTokens = 50) => ({ id, request: "a".repeat(64), role: "lead", model: "fixture/model", reservationTokens })

test("request admission reserves tokens before a call and reclaims only reported difference", async () => {
  const cfg = await budget()
  await reserveRequest(cfg, attempt("1", 80))
  await expect(reserveRequest(cfg, attempt("2", 30))).rejects.toThrow("exhausted")
  await settleRequest(cfg, "1", 20)
  await reserveRequest(cfg, attempt("2", 80))
  expect(await inspectBudget(cfg)).toMatchObject({ admittedAttempts: 2, reportedTokens: 20, outstandingTokens: 80 })
})

test("concurrent admissions cannot overspend a shared task budget", async () => {
  const cfg = await budget(2, 100)
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => reserveRequest(cfg, attempt(String(index)))))
  expect(results.filter(item => item.status === "fulfilled")).toHaveLength(2)
  expect(await inspectBudget(cfg)).toMatchObject({ admittedAttempts: 2, outstandingTokens: 100 })
})

test("unknown usage and provider overrun retain evidence and block later requests", async () => {
  for (const tokens of [undefined, 51]) {
    const cfg = await budget()
    await reserveRequest(cfg, attempt("1"))
    await settleRequest(cfg, "1", tokens)
    await expect(reserveRequest(cfg, attempt("2"))).rejects.toThrow("inspection")
    expect((await inspectBudget(cfg)).admittedAttempts).toBe(1)
  }
})

test("duplicate admission, changed limits and conflicting settlements fail closed", async () => {
  const cfg = await budget(1, 100)
  await reserveRequest(cfg, attempt("1"))
  await expect(reserveRequest(cfg, attempt("1"))).rejects.toThrow("inspect before retry")
  await settleRequest(cfg, "1", 0)
  await settleRequest(cfg, "1", 0)
  await expect(settleRequest(cfg, "1", 10)).rejects.toThrow("Conflicting")
  await expect(inspectBudget({ ...cfg, calls: 2 })).rejects.toThrow("drift")
  await expect(reserveRequest(cfg, attempt("2"))).rejects.toThrow("exhausted")
  expect(JSON.parse(await readFile(path.join(cfg.root, "budget.json"), "utf8")).attempts).toHaveLength(1)
})

test("invalid ceilings and settlement without a request cannot create usage", async () => {
  const cfg = await budget()
  await expect(reserveRequest(cfg, attempt("1", 0))).rejects.toThrow("ceiling")
  await expect(settleRequest(cfg, "missing", 1)).rejects.toThrow("without reservation")
  expect((await inspectBudget(cfg)).admittedAttempts).toBe(0)
})

test("denied admission is durable evidence but not another dispatched or billable attempt", async () => {
  const cfg = await budget(1)
  await reserveRequest(cfg, attempt("1"))
  await settleRequest(cfg, "1", 20)
  await expect(reserveRequest(cfg, attempt("2"))).rejects.toThrow("exhausted")
  expect(await inspectBudget(cfg)).toMatchObject({ admittedAttempts: 1, reportedTokens: 20, denial: { reason: "calls", reservationTokens: 50 } })
  const stored = JSON.parse(await readFile(path.join(cfg.root, "budget.json"), "utf8"))
  expect(stored.attempts).toHaveLength(1)
  expect(stored.lastDenial.reason).toBe("calls")
})

test("concurrent-reservation denial becomes stale after actual usage settlement", async () => {
  const cfg = await budget(3, 100)
  await reserveRequest(cfg, attempt("1", 80))
  await expect(reserveRequest(cfg, attempt("2", 50))).rejects.toThrow("exhausted")
  expect((await inspectBudget(cfg)).denial?.reason).toBe("tokens")
  await settleRequest(cfg, "1", 10)
  expect((await inspectBudget(cfg)).denial).toBeUndefined()
  await reserveRequest(cfg, attempt("2", 50))
  expect((await inspectBudget(cfg)).denial).toBeUndefined()
})

test("a missing ledger after initialization cannot reset consumption on recovery", async () => {
  const cfg = await budget()
  await reserveRequest(cfg, attempt("one"))
  await settleRequest(cfg, "one", 25)
  await unlink(path.join(cfg.root, "budget.json"))
  await expect(inspectBudget(cfg)).rejects.toThrow("state missing after initialization")
  await expect(reserveRequest(cfg, attempt("two"))).rejects.toThrow("state missing after initialization")
  await expect(readFile(path.join(cfg.root, "budget.json"))).rejects.toThrow()
})

test("an existing complete legacy ledger gains a claim without rewriting its history", async () => {
  const cfg = await budget()
  await reserveRequest(cfg, attempt("one"))
  await settleRequest(cfg, "one", 25)
  const file = path.join(cfg.root, "budget.json")
  const before = await readFile(file, "utf8")
  await unlink(`${file}.started.claim`)
  expect((await inspectBudget(cfg)).reportedTokens).toBe(25)
  expect(await readFile(file, "utf8")).toBe(before)
  await writeFile(`${file}.started.claim`, "tampered binding")
  await expect(reserveRequest(cfg, attempt("two"))).rejects.toThrow("claim drift")
})
