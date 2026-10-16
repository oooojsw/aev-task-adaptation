import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { recomputeEnvironment } from "./recompute"

test("actual source calculator enforces permission and frozen binding before computing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-recompute-source-tool-"))
  const configRoot = path.join(root, "config")
  const evidenceRoot = path.join(root, "evidence")
  await mkdir(configRoot)
  const env = await recomputeEnvironment({ schema: "aev.recompute.v1", task: "a".repeat(64), role: "lead", evidenceRoot }, configRoot)
  const entry = path.resolve(import.meta.dir, "../../../packages/opencode/src/tool/aev-recompute.ts")
  let replaced = false
  const built = await Bun.build({ entrypoints: [entry], target: "bun", outdir: root, naming: "source-recompute.js",
    plugins: [{ name: "tool-context-boundary", setup(builder) {
      builder.onLoad({ filter: /[\\/]packages[\\/]opencode[\\/]src[\\/]tool[\\/]tool\.ts$/ }, () => {
        replaced = true
        // 只替换SDK注册包装，实际权限及复算留证使用真代码。
        return { loader: "ts", contents: "export const Tool = { define: (id, definition) => ({ id, init: async () => definition }) }" }
      })
    } }] })
  if (!built.success) throw new Error(built.logs.map(String).join("\n"))
  expect(replaced).toBe(true)
  const actual = await import(pathToFileURL(built.outputs[0].path).href)
  const tool = await actual.AevRecomputeTool.init()
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  try {
    let calls = 0
    const ctx = { abort: new AbortController().signal, ask: async (request: { permission: string }) => {
      calls++
      expect(request.permission).toBe("aev_recompute")
    } }
    const args = tool.parameters.parse({ expression: { op: "mul", args: [6, 7] } })
    const result = await tool.execute(args, ctx)
    expect(JSON.parse(result.output)).toMatchObject({ result: 42, inputOrigin: "model_arguments_not_source_verified" })
    expect(calls).toBe(1)
    expect(await readdir(evidenceRoot)).toHaveLength(1)
    await expect(tool.execute(args, { ...ctx, ask: async () => { throw new Error("permission denied") } })).rejects.toThrow("permission denied")
    expect(await readdir(evidenceRoot)).toHaveLength(1)
    expect(() => tool.parameters.parse({ ...args, path: root })).toThrow()
    delete process.env.OPENCODE_AEV_RECOMPUTE_FILE
    delete process.env.OPENCODE_AEV_RECOMPUTE_SHA256
    await expect(tool.execute(args, ctx)).rejects.toThrow("Explicit frozen")
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
