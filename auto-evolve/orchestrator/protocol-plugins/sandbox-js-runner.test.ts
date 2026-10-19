import { expect, test } from "bun:test"
import { readFile, mkdtemp } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { scriptExecutor } from "./script-executor"
import type { Execute } from "./runtime"

test("bundled synchronous JS runner executes declared input without host interfaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-js-runner-"))
  const runner = await scriptExecutor(root)
  const script = fileURLToPath(new URL("./sandbox-js-runner.mjs", import.meta.url))
  const digest = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex")
  const settings = { command: process.execPath, commandSHA256: await digest(process.execPath), script,
    scriptSHA256: await digest(script), timeoutMs: 5000, maxInputBytes: 10000, maxOutputBytes: 4096,
    executionBoundary: "trusted_host_runner" }
  const execute = async (code: string) => runner.execute({ task: "software", phase: "source", settings,
    skill: [{ id: "code", kind: "text", bytes: Buffer.from(code) }],
    materials: [{ id: "input", kind: "text", bytes: Buffer.from("21") }] } as Parameters<Execute>[0])
  const result = await execute("function solve(materials) { return Number(materials[0].content) * 2 }")
  expect(result.status).toBe("completed")
  if (result.status === "completed") expect(JSON.parse(Buffer.from(result.product.bytes).toString())).toEqual({ result: 42 })
  const boundary = await execute("function solve() { return [typeof process, typeof require, typeof fetch] }")
  expect(boundary.status).toBe("completed")
  if (boundary.status === "completed") expect(JSON.parse(Buffer.from(boundary.product.bytes).toString()).result)
    .toEqual(["undefined", "undefined", "undefined"])
  expect((await execute('function solve(){ return (()=>{}).constructor("return process")() }')).status).toBe("execution_error")
  expect((await execute("function solve(){ while(true){} }")).status).toBe("execution_error")
}, 20000)
