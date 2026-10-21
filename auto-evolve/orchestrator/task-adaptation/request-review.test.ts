import { test, expect } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { inspectBudget, inspectRequestUsage, reserveRequest, reviewUnknownRequest, settleRequest } from "./request-budget"

test("explicit meter-only review preserves unknown costs and duplicate protections", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aev-review-"))
  try {
    const cfg = { root, scope: "review", calls: 1, tokens: 100, mode: "meter_only" as const }
    const attempt = { id: "failed", request: "a".repeat(64), model: "MiniMax-M2.7", role: "worker", reservationTokens: 100 }
    const review = { reason: "Host checked terminal HTTP400; usage not reported", evidenceSHA256: "b".repeat(64) }
    await reserveRequest(cfg, attempt)
    await expect(reviewUnknownRequest(cfg, attempt.id, review)).rejects.toThrow("terminal")
    await settleRequest(cfg, attempt.id, undefined, { dialect: "anthropic_messages", httpStatus: 400, outcome: "http_error" })
    await expect(reserveRequest(cfg, { ...attempt, id: "next" })).rejects.toThrow("inspection")
    await expect(reviewUnknownRequest({ ...cfg, mode: undefined }, attempt.id, review)).rejects.toThrow("meter-only")
    await reviewUnknownRequest(cfg, attempt.id, review)
    await reviewUnknownRequest(cfg, attempt.id, review)
    expect(await inspectBudget(cfg)).toMatchObject({ unknownAttempts: 1, unresolvedAttempts: 1, reviewedUnknownAttempts: 1, blockingAttempts: 0, reportedTokens: 0, outstandingTokens: 100 })
    expect(await inspectRequestUsage(cfg)).toMatchObject({ complete: false, fee: null })
    const state = JSON.parse(await readFile(path.join(root, "budget.json"), "utf8"))
    expect(state.attempts[0].status).toBe("unknown")
    expect(state.attempts[0].usedTokens).toBeUndefined()
    await expect(reserveRequest(cfg, attempt)).rejects.toThrow("Prior")
    await expect(reviewUnknownRequest(cfg, attempt.id, { ...review, reason: "changed" })).rejects.toThrow("Conflicting")
    await reserveRequest(cfg, { ...attempt, id: "next" })
    expect((await inspectBudget(cfg)).admittedAttempts).toBe(2)
    // 限额模式不能借用无限额核查记录，预算绑定仍禁止模式漂移。
    const { mode, ...finite } = cfg
    await expect(inspectBudget(finite)).rejects.toThrow("drift")
  } finally { await rm(root, { recursive: true, force: true }) }
})
