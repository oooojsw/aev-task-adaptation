import { expect, test } from "bun:test"
import path from "node:path"
import { runManagedProcess } from "./managed-process"
import { activeCallbacks } from "./opencode-runtime-budget"
import { identifyProcessOwner } from "./process-identity"

test("absolute deadline includes a hung startup callback", async () => {
  let entered = false
  const started = Date.now()
  const result = await runManagedProcess({
    title: "deadline-local-fixture",
    command: [process.execPath, path.join(import.meta.dir, "fixtures/managed-deadline-child.ts")],
    cwd: import.meta.dir,
    timeoutMs: 30000,
    deadlineAt: started + 2000,
    onSpawn: async () => {
      entered = true
      await new Promise(() => {})
    },
  })
  expect(entered).toBe(true)
  expect(result.hardTimedOut).toBe(true)
  expect(result.exitCode).toBe(124)
  const pid = result.processPID!
  expect(pid).toBeGreaterThan(0)
  expect((await identifyProcessOwner({ pid })).alive).toBe(false)
  expect(Date.now() - started).toBeLessThan(15000)
}, 20000)

test("startup callback released after return cannot pulse or flush the old attempt", async () => {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  let tail: Promise<void> | undefined
  let writes = 0
  const result = await runManagedProcess({
    title: "late-callback-local-fixture",
    command: [process.execPath, path.join(import.meta.dir, "fixtures/managed-deadline-child.ts")],
    cwd: import.meta.dir,
    timeoutMs: 30000,
    deadlineAt: Date.now() + 2000,
    onSpawn: (signal) => {
      tail = activeCallbacks(signal, [
        () => waiting,
        () => {
          writes++
        },
      ])
      return tail
    },
  })
  expect(result.hardTimedOut).toBe(true)
  expect(tail).toBeDefined()
  release()
  await tail
  expect(writes).toBe(0)
}, 20000)

test("unconfirmed termination holds execution until the real child exits", async () => {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/managed-termination-refused.ts")], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  try {
    const text = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    const result = JSON.parse(text.trim())
    expect(result.exitCode).toBe(124)
    expect(result.stderr).toContain("termination unconfirmed")
    expect(result.stdout).toContain("finite-child-exit")
  } finally {
    child.kill()
    await child.exited
  }
}, 20000)

test("expired absolute deadline prevents process creation", async () => {
  await expect(
    runManagedProcess({
      title: "expired",
      command: ["must-not-spawn"],
      cwd: import.meta.dir,
      timeoutMs: 1000,
      deadlineAt: Date.now() - 1,
    }),
  ).rejects.toThrow("expired before spawn")
})
