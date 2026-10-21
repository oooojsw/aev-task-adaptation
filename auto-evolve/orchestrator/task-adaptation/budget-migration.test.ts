import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { reserveRequest, settleRequest, inspectBudget } from "./request-budget"
import { migrateBudgetToMeterOnly } from "./budget-migration"

async function fixture(usage: number | null = 70) {
  const cfg = { root: await mkdtemp(path.join(os.tmpdir(), "aev-meter-migration-")), scope: "fixture", calls: 1, tokens: 100 }
  await reserveRequest(cfg, { id: "one", request: "a".repeat(64), role: "planner", model: "fixture", reservationTokens: 50 })
  await settleRequest(cfg, "one", usage ?? undefined)
  const bytes = await readFile(path.join(cfg.root, "budget.json"))
  const approval = { expectedSHA256: createHash("sha256").update(bytes).digest("hex"), reason: "Host approved no total cap" }
  return { cfg, approval, attempts: JSON.parse(bytes.toString()).attempts }
}

test("authorized migration preserves every charged attempt and is idempotent", async () => {
  const f = await fixture()
  const target = await migrateBudgetToMeterOnly(f.cfg, f.approval)
  expect((await inspectBudget(target)).effectiveLimits).toEqual({ calls: null, tokens: null })
  expect(JSON.parse(await readFile(path.join(f.cfg.root, "budget.json"), "utf8")).attempts).toEqual(f.attempts)
  expect(await migrateBudgetToMeterOnly(f.cfg, f.approval)).toEqual(target)
  await expect(migrateBudgetToMeterOnly(f.cfg, { ...f.approval, reason: "different" })).rejects.toThrow("drift")
})

test("unknown usage and changed source cannot be released by migration", async () => {
  const f = await fixture(null)
  await expect(migrateBudgetToMeterOnly(f.cfg, f.approval)).rejects.toThrow("unresolved")
  const g = await fixture()
  await expect(migrateBudgetToMeterOnly(g.cfg, { ...g.approval, expectedSHA256: "f".repeat(64) })).rejects.toThrow("changed")
})

test("interrupted ledger-then-claim migration completes only its original intent", async () => {
  const f = await fixture()
  const old = await readFile(path.join(f.cfg.root, "budget.json.started.claim"))
  const target = await migrateBudgetToMeterOnly(f.cfg, f.approval)
  await writeFile(path.join(f.cfg.root, "budget.json.started.claim"), old)
  expect(await migrateBudgetToMeterOnly(f.cfg, f.approval)).toEqual(target)
  expect((await inspectBudget(target)).reportedTokens).toBe(70)
})
