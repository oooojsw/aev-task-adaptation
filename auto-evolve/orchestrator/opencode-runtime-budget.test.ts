import { expect, test } from "bun:test"
import { readerDeadline, readerTimeout, resolveRuntimeBudget, readerRuntimeBudget } from "./opencode-runtime-budget"

test("profiles retain original execution deadlines and reader follows explicit role timeout", () => {
  for (const [profile, minutes] of [
    ["short", 60],
    ["medium", 120],
    ["long", 180],
    ["unbounded-with-watchdog", 720],
  ] as const) {
    const budget = resolveRuntimeBudget({ profile, hardTimeoutMs: minutes * 60000 })
    expect(readerDeadline(budget, 100)).toBe(100 + minutes * 60000)
  }
  expect(readerDeadline({ hardTimeoutMs: 1234 }, 100)).toBe(1334)
  expect(() => readerDeadline({ hardTimeoutMs: Infinity })).toThrow("Finite")
  expect(() => readerDeadline({ hardTimeoutMs: 0 })).toThrow("Finite")
})

test("queued readers never acquire another full timeout or silently renew an expired grant", () => {
  const expiry = readerDeadline({ hardTimeoutMs: 3 * 3600000 }, 100)
  expect(readerTimeout(3 * 3600000, expiry, 100 + 61 * 60000)).toBe(119 * 60000)
  expect(readerTimeout(1000, expiry, 100)).toBe(1000)
  expect(readerTimeout(0, undefined)).toBe(0)
  expect(() => readerTimeout(1000, expiry, expiry)).toThrow("expired")
  const budget = readerRuntimeBudget(
    { profile: "long", hardTimeoutMs: 180 * 60000, softDeadlineMs: 120 * 60000 },
    expiry,
    100 + 100 * 60000,
  )
  expect(budget.hardTimeoutMs).toBe(80 * 60000)
  expect(budget.softDeadlineMs).toBe(20 * 60000)
})
