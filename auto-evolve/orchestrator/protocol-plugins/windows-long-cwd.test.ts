import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runManagedProcess } from "../managed-process"

test.skipIf(process.platform !== "win32")("actual Windows wrapper preserves a long working directory through its physical short alias", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-long-cwd-"))
  const cwd = path.join(root, "nested-".repeat(16), "nested-".repeat(16), "sandbox")
  await mkdir(cwd, { recursive: true })
  expect(cwd.length).toBeGreaterThan(260)
  const result = await runManagedProcess({ title: "Long cwd equivalent directory regression",
    command: [process.execPath, "-p", "process.cwd()"], cwd, timeoutMs: 15000 })
  // 部分卷关闭8.3短名；明确阻断，不冒充已在原目录执行。
  if (result.stderr.includes("no usable short name")) {
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe("")
    return
  }
  expect(result.exitCode).toBe(0)
  expect(await realpath(result.stdout.trim())).toBe(await realpath(cwd))
}, 20000)

test.skipIf(process.platform !== "win32")("actual Windows wrapper leaves ordinary working directory behavior unchanged", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aev-short-cwd-"))
  const result = await runManagedProcess({ title: "Ordinary cwd regression",
    command: [process.execPath, "-p", "process.cwd()"], cwd, timeoutMs: 15000 })
  expect(result.exitCode).toBe(0)
  expect(await realpath(result.stdout.trim())).toBe(await realpath(cwd))
}, 20000)
