import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { bindLocalSearch, localSearchEnvironment } from "./local-search"

test("actual source tool asks permission and uses only its frozen local search binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-search-source-tool-"))
  const source = path.join(root, "source.txt")
  await writeFile(source, "Source evidence 42")
  await writeFile(path.join(root, "private.txt"), "PRIVATE_UNAUTHORIZED")
  const scope = await bindLocalSearch("a".repeat(64), "worker", [{ id: "source", path: source, mutable: false }])
  const privateConfig = path.join(root, "config")
  await mkdir(privateConfig)
  const evidenceRoot = path.join(root, "evidence")
  const env = await localSearchEnvironment({ ...scope, evidenceRoot }, privateConfig)
  const entry = path.resolve(import.meta.dir, "../../../packages/opencode/src/tool/aev-local-search.ts")
  let replaced = false
  const built = await Bun.build({ entrypoints: [entry], target: "bun", outdir: root, naming: "source-search.js",
    plugins: [{ name: "tool-context-boundary", setup(builder) {
      builder.onLoad({ filter: /[\\/]packages[\\/]opencode[\\/]src[\\/]tool[\\/]tool\.ts$/ }, () => {
        replaced = true
        // 只替换SDK注册包装，真实工具执行、权限请求和文件读取不替换。
        return { loader: "ts", contents: "export const Tool = { define: (id, definition) => ({ id, init: async () => definition }) }" }
      })
    } }] })
  if (!built.success) throw new Error(built.logs.map(String).join("\n"))
  expect(replaced).toBe(true)
  const actual = await import(pathToFileURL(built.outputs[0].path).href)
  const tool = await actual.AevLocalSearchTool.init()
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  const abort = new AbortController()
  let permissionCalls = 0
  try {
    const ctx = { abort: abort.signal, ask: async (request: { permission: string }) => {
      permissionCalls++
      expect(request.permission).toBe("aev_local_search")
    } }
    const result = await tool.execute(tool.parameters.parse({ query: "42" }), ctx)
    expect(JSON.parse(result.output).matches[0].resource).toBe("source")
    expect(result.output).not.toContain("PRIVATE_UNAUTHORIZED")
    expect(permissionCalls).toBe(1)
    expect(await readdir(evidenceRoot)).toHaveLength(1)
    await expect(tool.execute({ query: "42" }, { ...ctx, ask: async () => { throw new Error("permission denied") } })).rejects.toThrow("permission denied")
    expect(await readdir(evidenceRoot)).toHaveLength(1)
    await expect(tool.execute({ query: "PRIVATE", resources: ["private"] }, ctx)).rejects.toThrow("Invalid scoped search")
    expect(() => tool.parameters.parse({ query: "42", path: root })).toThrow()
    delete process.env.OPENCODE_AEV_LOCAL_SEARCH_FILE
    delete process.env.OPENCODE_AEV_LOCAL_SEARCH_SHA256
    await expect(tool.execute({ query: "42" }, ctx)).rejects.toThrow("Explicit frozen")
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
