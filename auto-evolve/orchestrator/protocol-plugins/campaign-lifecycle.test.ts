import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"

// 离线打包只替换API与配置边界，保留实际内外控制器源码。
export async function buildOfflineCampaign(root: string, boundaryKey: string) {
  const orchestrator = path.resolve(import.meta.dir, "..")
  const entry = path.join(root, "campaign-entry.ts")
  await writeFile(entry, `export { runLongTaskCampaign, resumeLongTaskCampaign } from ${JSON.stringify(path.join(orchestrator, "long-task-campaign/runner.ts"))};
export { runOpencodeTask } from ${JSON.stringify(path.join(orchestrator, "opencode.ts"))};
export { loadConfig, DEFAULT_CONFIG } from ${JSON.stringify(path.join(orchestrator, "schema.ts"))};`)
  const replaced = new Set<string>()
  const built = await Bun.build({ entrypoints: [entry], target: "bun", packages: "external",
    // 避免同名.ts优先解析，必须导入独立的离线打包产物。
    outdir: root, naming: "offline-campaign-[hash].js", plugins: [{ name: "offline-campaign-boundaries", setup(builder) {
      builder.onLoad({ filter: /[\\/]orchestrator[\\/](opencode|schema)\.ts$/ }, async ({ path: file }) => {
        const name = path.basename(file)
        const source = await readFile(file, "utf8")
        const exported = name === "opencode.ts" ? "runOpencodeTask" : "loadConfig"
        const signature = `export async function ${exported}(`
        if (source.split(signature).length !== 2) throw new Error(`Unexpected boundary: ${file}`)
        replaced.add(name)
        return { loader: "ts", contents: source.replace(signature, `async function unusedOriginal_${exported}(`) +
          `\nexport async function ${exported}(...args: any[]) {
            const boundary = (globalThis as any)[${JSON.stringify(boundaryKey)}];
            if (!boundary || typeof boundary.${exported} !== "function") throw new Error("Offline boundary missing");
            return boundary.${exported}(...args);
          }` }
      })
    } }] })
  if (!built.success) throw new Error(built.logs.map(String).join("\n"))
  if (replaced.size !== 2) throw new Error("Offline model/config boundaries were not both replaced")
  const bundle = await readFile(built.outputs[0].path, "utf8")
  if (!bundle.includes(boundaryKey) || bundle.includes("startStaleOpencodeRuntimeCleanup(input.cwd)")) {
    throw new Error("Unsafe offline bundle: live model implementation retained")
  }
  return import(pathToFileURL(built.outputs[0].path).href)
}

test("actual Campaign bundle routes model calls through mandatory offline boundary", async () => {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(root, { recursive: true })
  const key = `__campaignOffline_${randomUUID().replaceAll("-", "")}`
  const holder = globalThis as Record<string, unknown>
  let calls = 0
  holder[key] = { async runOpencodeTask(input: { title: string }) { calls++; return { marker: input.title } },
    async loadConfig() { throw new Error("No fixture config installed") } }
  try {
    const actual = await buildOfflineCampaign(root, key)
    expect(typeof actual.runLongTaskCampaign).toBe("function")
    expect(typeof actual.resumeLongTaskCampaign).toBe("function")
    expect(await actual.runOpencodeTask({ title: "offline probe" })).toEqual({ marker: "offline probe" })
    await expect(actual.loadConfig(root)).rejects.toThrow("No fixture config installed")
    expect(calls).toBe(1)
    delete holder[key]
    await expect(actual.runOpencodeTask({ title: "must not use real API" })).rejects.toThrow("Offline boundary missing")
    await expect(actual.loadConfig(root)).rejects.toThrow("Offline boundary missing")
    expect(calls).toBe(1)
  } finally { delete holder[key] }
}, 30000)
