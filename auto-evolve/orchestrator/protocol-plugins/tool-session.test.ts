import { expect, test } from "bun:test"
import { writeFile, readFile, symlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { toolSession, type InvokeTool } from "./tool-session"
import type { Execute } from "./runtime"

const root = () => path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
function input(): Parameters<Execute>[0] {
  const bytes = Buffer.from("Public rule")
  return { task: "fixture", phase: "source", skill: [{ id: "../../private-path", kind: "text", bytes, length: bytes.length, sha256: "fixture" }],
    materials: [], settings: { model: "fixture", expectedModel: "fixture", outputPath: "final.txt", outputKind: "text",
      maxInputBytes: 4096, maxProductBytes: 1024, timeoutMs: 1000, allowShell: false, instruction: "Answer using public material" } }
}
async function plugin(invoke: InvokeTool) {
  return toolSession({ evidenceRoot: root(), backendImplementation: "a".repeat(64), invoke })
}

test("tool session stages bytes with safe names and explicit no-shell fresh workspace", async () => {
  const p = await plugin(async (request) => {
    expect(request.allowShell).toBe(false)
    expect(request.maxAttempts).toBe(1)
    expect(request.readPaths).toHaveLength(1)
    expect(request.readPaths[0]).toEndWith("skill/0.data")
    expect(await readFile(request.readPaths[0], "utf8")).toBe("Public rule")
    expect(request.editPaths).toEqual([path.join(request.workDir, "workspace")])
    await writeFile(path.join(request.workDir, "workspace", "final.txt"), "Result")
    return { completed: true, actualModel: "fixture", usage: { inputTokens: 10, outputTokens: 2 } }
  })
  const result = await p.execute(input())
  expect(result.status).toBe("completed")
  expect(Buffer.from(result.product!.bytes).toString()).toBe("Result")
})

test("missing product and wrong model are infrastructure failures", async () => {
  for (const model of ["fixture", "wrong"]) {
    const p = await plugin(async () => ({ completed: true, actualModel: model }))
    expect((await p.execute(input())).status).toBe("execution_error")
  }
})

test("tool output symlink outside workspace cannot pass", async () => {
  const p = await plugin(async (request) => {
    const outside = path.join(path.dirname(request.workDir), "outside.txt")
    await writeFile(outside, "Should not be accepted")
    await symlink(outside, path.join(request.workDir, "workspace", "final.txt"), "file")
    return { completed: true, actualModel: "fixture" }
  })
  expect((await p.execute(input())).status).toBe("execution_error")
})

test("tool budget and shell override block before backend invocation", async () => {
  let calls = 0
  const p = await plugin(async () => { calls++; return { completed: true, actualModel: "fixture" } })
  const request = input()
  request.settings.maxInputBytes = 1
  await expect(p.execute(request)).rejects.toThrow("budget")
  request.settings.allowShell = true
  expect(() => p.descriptor.validate(request.settings)).toThrow("Invalid")
  expect(calls).toBe(0)
})

test("tool interrupted or duplicate execution is never automatically resent", async () => {
  let calls = 0
  const p = await plugin(async () => { calls++; throw new Error("Interrupted") })
  expect((await p.execute(input())).status).toBe("execution_error")
  await expect(p.execute(input())).rejects.toThrow()
  expect(calls).toBe(1)
})

test("tool timeout aborts backend and cannot produce a successful receipt", async () => {
  let aborted = false
  const p = await plugin(async (_request, signal) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("Aborted")) }, { once: true })
  }))
  const request = input()
  request.settings.timeoutMs = 15
  expect((await p.execute(request)).status).toBe("execution_error")
  expect(aborted).toBe(true)
})
