import { expect, test } from "bun:test"
import { readerDeadline, readerTimeout, resolveRuntimeBudget, readerRuntimeBudget, convergenceWindows } from "./opencode-runtime-budget"

test("convergence windows scale below short deadlines and retain long-task thresholds", () => {
  expect(convergenceWindows(7200000)).toEqual({converge: 900000, prepare: 300000, finish: 120000})
  for (const duration of [1000, 60000, 600000, 900000]) {
    const w = convergenceWindows(duration)
    expect(w.finish).toBeLessThan(w.prepare)
    expect(w.prepare).toBeLessThan(w.converge)
    expect(w.converge).toBeLessThan(duration)
  }
})

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

test("shortened hard timeout scales default subordinate deadlines and rejects explicit invalid numbers", () => {
  const budget = resolveRuntimeBudget({profile: "long", hardTimeoutMs: 900000}, false)
  expect(budget.softDeadlineMs).toBe(600000)
  expect(budget.silentTimeoutMs).toBe(150000)
  expect(budget.silentTimeoutAfterActivityMs).toBe(450000)
  for (const value of [NaN, Infinity, 0, -1, 1.5]) expect(() => resolveRuntimeBudget({hardTimeoutMs: value})).toThrow()
  expect(() => resolveRuntimeBudget({hardTimeoutMs: 1000, softDeadlineMs: 2000})).toThrow("exceeds")
  const saved = process.env.AUTO_EVOLVE_OPENCODE_SOFT_DEADLINE_MS
  try {
    for (const value of ["NaN", "12garbage", "1.5", "0", "-1"]) {
      process.env.AUTO_EVOLVE_OPENCODE_SOFT_DEADLINE_MS = value
      expect(() => resolveRuntimeBudget()).toThrow("Invalid runtime")
    }
    process.env.AUTO_EVOLVE_OPENCODE_SOFT_DEADLINE_MS = "10000000"
    expect(resolveRuntimeBudget({profile: "long", hardTimeoutMs: 900000}, false)).toEqual(budget)
  } finally {
    if (saved === undefined) delete process.env.AUTO_EVOLVE_OPENCODE_SOFT_DEADLINE_MS
    else process.env.AUTO_EVOLVE_OPENCODE_SOFT_DEADLINE_MS = saved
  }
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
  expect(budget.silentTimeoutAfterActivityMs).toBe(80 * 60000)
  expect(resolveRuntimeBudget(budget, false)).toEqual(budget)
})
