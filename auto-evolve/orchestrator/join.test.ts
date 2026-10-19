import { expect, test } from "bun:test"
import { join } from "./join"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"

function latch<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test("join preserves input order and handles empty work", async () => {
  const first = latch<number>()
  const pending = join([first.promise, Promise.resolve(2)])
  first.resolve(1)
  expect(await pending).toEqual([1, 2])
  expect(await join([])).toEqual([])
})

test("join drains late writers and preserves the first observed failure", async () => {
  const first = latch<number>(), second = latch<number>(), writer = latch<number>()
  const error = new Error("first observed")
  let finished = false, written = false
  const pending = join([first.promise, second.promise, writer.promise.then(value => { written = true; return value })])
    .then(() => { finished = true; return undefined }, reason => { finished = true; return reason })
  second.reject(error)
  await Promise.resolve()
  await Promise.resolve()
  expect(finished).toBe(false)
  first.reject(new Error("later error in earlier input slot"))
  await Promise.resolve()
  expect(finished).toBe(false)
  writer.resolve(3)
  expect(await pending).toBe(error)
  expect(written).toBe(true)
  expect(finished).toBe(true)
})

test("join preserves even undefined rejection without treating it as success", async () => {
  const result = await join([Promise.reject(undefined)]).then(() => "success", reason => ({ reason }))
  expect(result).toEqual({ reason: undefined })
})

test("async role failure before its first await still drains another role's actual file write", async () => {
  const root = path.join("E:/project/AEV-task-adaptation-20261016/test-evidence", `worker-drain-${randomUUID()}`)
  await mkdir(root, { recursive: true })
  const writer = latch<void>()
  const error = new Error("synchronous role setup failure")
  let finished = false
  const pending = join(["failed", "writer"].map(async role => {
    if (role === "failed") throw error
    await writer.promise
    await writeFile(path.join(root, "late-worker.txt"), "completed before barrier release", { flag: "wx" })
    return role
  })).then(() => { finished = true; return undefined }, reason => { finished = true; return reason })
  await Promise.resolve()
  await Promise.resolve()
  expect(finished).toBe(false)
  writer.resolve()
  expect(await pending).toBe(error)
  expect(await readFile(path.join(root, "late-worker.txt"), "utf8")).toBe("completed before barrier release")
})
