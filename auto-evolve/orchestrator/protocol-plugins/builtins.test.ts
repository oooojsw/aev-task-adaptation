import { expect, test } from "bun:test"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { builtins } from "./builtins"
import { toolSession } from "./tool-session"
import { cachedExecution } from "./cache"
import { mkdir, writeFile } from "node:fs/promises"
import type { InvokeTool } from "./tool-session"

const root = () => path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())

test("default builtins do not register or initialize a tool host", async () => {
  const runtime = await builtins(root())
  expect(() => runtime.registry.executor({ id: "isolated-tool-session", version: "1" })).toThrow()
  expect(runtime.registry.executor({ id: "http-text-chat", version: "1" }).implementation).toHaveLength(64)
})

test("explicit frozen tool driver registers alongside independent checkers", async () => {
  let calls = 0
  const runtime = await builtins(root(), { tool: { implementation: "a".repeat(64),
    preflight: async () => {}, invoke: async () => { calls++; throw new Error("must not invoke during registration") } } })
  expect(runtime.registry.executor({ id: "isolated-tool-session", version: "1" }).implementation).toHaveLength(64)
  expect(runtime.registry.checker({ id: "script-json-checker", version: "1" }).implementation).toHaveLength(64)
  expect(calls).toBe(0)
})

test("tool cached product requires current backend preflight without duplicate execution", async () => {
  const dir = root()
  let compatible = true
  let calls = 0
  const invoke: InvokeTool = async (request) => {
    calls++
    const workspace = path.join(request.workDir, "workspace")
    await mkdir(workspace, { recursive: true })
    await writeFile(path.join(workspace, "result.txt"), "actual fixture answer")
    return { completed: true, actualModel: "fixture/model" }
  }
  const tool = await toolSession({ evidenceRoot: path.join(dir, "tools"), backendImplementation: "a".repeat(64), invoke })
  const execute = cachedExecution(path.join(dir, "cache"), tool.descriptor, tool.execute, async () => {
    if (!compatible) throw new Error("host drift")
  })
  const input = { task: "fixture", phase: "source" as const, skill: [], materials: [], settings: {
    model: "fixture/model", expectedModel: "fixture/model", outputPath: "result.txt", outputKind: "text",
    maxInputBytes: 10000, maxProductBytes: 1000, timeoutMs: 1000, allowShell: false,
    instruction: "Write the bound result" } }
  expect((await execute(input)).status).toBe("completed")
  expect((await execute(input)).reused).toBe(true)
  compatible = false
  await expect(execute(input)).rejects.toThrow("host drift")
  expect(calls).toBe(1)
})
