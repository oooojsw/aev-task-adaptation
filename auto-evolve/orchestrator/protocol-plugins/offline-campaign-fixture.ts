import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

// 仅替换模型与配置边界，测试必须经过原控制器和正式协议模块。
export async function buildOfflineCampaign(root: string, key: string) {
  const base = path.resolve(import.meta.dir, "..")
  const entry = path.join(root, "offline-entry.ts")
  await writeFile(entry, [
    `export { runLongTaskCampaign, resumeLongTaskCampaign } from ${JSON.stringify(path.join(base, "long-task-campaign/runner.ts"))};`,
    `export { runTask } from ${JSON.stringify(path.join(base, "task-adaptation/run-task.ts"))};`,
  ].join("\n"))
  const seen = new Set<string>()
  const built = await Bun.build({ entrypoints: [entry], target: "bun", packages: "external", outdir: root,
    naming: "offline-consolidation-[hash].js", plugins: [{ name: "offline-model-boundary", setup(builder) {
      builder.onLoad({ filter: /[\\/]orchestrator[\\/](opencode|schema)\.ts$/ }, async ({ path: file }) => {
        const source = (await readFile(file, "utf8")).replaceAll("import.meta.dir", JSON.stringify(path.dirname(file)))
        const name = path.basename(file) === "opencode.ts" ? "runOpencodeTask" : "loadConfig"
        const signature = `export async function ${name}(`
        if (source.split(signature).length !== 2) throw new Error("Offline boundary signature drift")
        seen.add(name)
        return { loader: "ts", contents: source.replace(signature, `async function unused_${name}(`) +
          `\nexport async function ${name}(...args: any[]) {
            const boundary = (globalThis as any)[${JSON.stringify(key)}];
            if (!boundary || typeof boundary.${name} !== "function") throw new Error("Offline boundary missing");
            return boundary.${name}(...args);
          }` }
      })
      builder.onLoad({ filter: /[\\/]orchestrator[\\/].*\.ts$/ }, async ({ path: file }) => ({ loader: "ts",
        contents: (await readFile(file, "utf8")).replaceAll("import.meta.url", JSON.stringify(pathToFileURL(file).href))
          .replaceAll("import.meta.dir", JSON.stringify(path.dirname(file))) }))
    } }] })
  if (!built.success || seen.size !== 2) throw new Error("Offline controller build failed: " + built.logs.map(String).join("\n"))
  const text = await readFile(built.outputs[0].path, "utf8")
  if (!text.includes(key) || text.includes("startStaleOpencodeRuntimeCleanup(input.cwd)")) throw new Error("Live model boundary retained")
  return import(pathToFileURL(built.outputs[0].path).href)
}
