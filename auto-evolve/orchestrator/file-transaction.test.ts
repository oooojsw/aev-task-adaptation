import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { openFileTransaction, withFileTransaction } from "./file-transaction"

test("explicit transaction holds the same mutex until idempotent release", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-lease-"))
  const lease = await openFileTransaction(root, "round")
  try {
    await expect(openFileTransaction(root, "round")).rejects.toThrow("writer active")
    await expect(withFileTransaction(root, "round", async () => true)).rejects.toThrow("writer active")
  } finally { lease.rollback() }
  lease.rollback()
  lease.commit()
  expect(await withFileTransaction(root, "round", async () => "released")).toBe("released")
})

test("early return and callback failure release without masking the original failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-lease-exit-"))
  const run = async () => {
    const lease = await openFileTransaction(root, "round")
    try { return "early" }
    finally { lease.rollback() }
  }
  expect(await run()).toBe("early")
  const original = new Error("same error object")
  await expect(withFileTransaction(root, "round", async () => { throw original })).rejects.toBe(original)
  const next = await openFileTransaction(root, "round")
  next.commit()
  next.rollback()
  expect(await withFileTransaction(root, "round", async () => true)).toBe(true)
})
