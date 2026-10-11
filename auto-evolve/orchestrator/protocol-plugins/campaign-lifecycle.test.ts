import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
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

for (const revision of [false, true]) test(`actual Campaign learner ${revision ? "rejects revises and reaccepts" : "reaches protocol acceptance"} with offline model receipts`, async () => {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(root, { recursive: true })
  const key = `__campaignOffline_${randomUUID().replaceAll("-", "")}`
  const holder = globalThis as Record<string, any>
  const actual = await buildOfflineCampaign(root, key)
  const config = structuredClone(actual.DEFAULT_CONFIG)
  config.monitorConfig.enabled = false
  config.monitorConfig.autoStart = false
  const calls: string[] = []
  let leads = 0
  holder[key] = { async loadConfig() { return config }, async runOpencodeTask(input: any) {
    calls.push(input.title)
    await input.onSpawn?.()
    if (input.title.startsWith("Campaign Lead")) leads++
    for (const edit of input.permissionEditPaths ?? []) {
      if (edit.endsWith("rules.txt")) { await mkdir(path.dirname(edit), { recursive: true }); await writeFile(edit, "Reusable rule") }
      if (input.title.startsWith("Campaign Lead") && !edit.endsWith(".json")) {
        await mkdir(edit, { recursive: true }); await writeFile(path.join(edit, "rules.txt"), revision && leads === 1 ? "Incomplete rule" : "Reusable rule")
      }
    }
    const responseText = JSON.stringify({ claimed_success: true, claim_statement: "Fixture exploration complete",
      summary: "Fixture reusable rule", blockers: [], updated_files: [], suggestions: [] })
    return { title: input.title, prompt: input.prompt, selectedModel: input.model,
      referencedPaths: input.referencePaths ?? [], attachedFiles: [], promptInlineFiles: [],
      permissionReadPaths: input.permissionReadPaths ?? [], permissionEditPaths: input.permissionEditPaths ?? [],
      result: { exitCode: 0, stdout: responseText, stderr: "", events: [], responseText, toolFailures: [] } }
  } }
  const project = { id: "campaign-fixture", version: "1", skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] }
  const python = "C:/Users/ZhuanZ/miniconda3/python.exe"
  const script = path.join(root, "check.py")
  await writeFile(script, 'import json,sys\np=json.load(open(sys.argv[1],encoding="utf-8-sig"))\ns=open(p["candidate"][0]["path"],encoding="utf-8").read()\nprint(json.dumps({"status":"passed" if s=="Reusable rule" else "rejected","message":"fixture content gate"}))\n')
  const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex")
  await writeFile(path.join(root, "public.txt"), "Public rules")
  await writeFile(path.join(root, "selection.json"), JSON.stringify({ schema: "aev.protocol-plugins.v1", project,
    run: { skillFormat: "text", productKind: "text", materialKinds: ["text"] }, protocol: { id: "fixture", version: "1",
      phases: { source: { claim: "skill_check", checks: [{ id: "script-json-checker", version: "1", name: "content",
        target: "skill", stage: "before_execution", required: true, mechanism: "script", settings: {
          command: python, commandSHA256: await hash(python), script, scriptSHA256: await hash(script), timeoutMs: 10000, maxOutputBytes: 4096 } }] } } } }))
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({ schema: "aev.project-pack.v1", project,
    skill: { format: "text", entries: [{ id: "rules", kind: "text", path: "rules.txt" }] },
    tasks: [{ id: "source", split: "train", materials: [{ id: "public", kind: "text", path: "public.txt" }], privateInputs: [] }] }))
  const specPath = path.join(root, "spec.json")
  await writeFile(specPath, JSON.stringify({ title: "Offline learning", goal: "Learn reusable public rules",
    materials: [{ label: "public", path: "public.txt" }], validators: [],
    initialGraph: { units: [{ id: "explore", title: "Explore", goal: "Explore public rules", inputs: [], depends_on: [],
      expected_artifacts: [], claim: "Explored", check_plan: "Formal protocol follows", validator_ids: [], retry_budget: 1 }] },
    protocolPlugins: { schema: "aev.protocol-entry.v1", selectionPath: path.join(root, "selection.json"),
      projectManifestPath: path.join(root, "manifest.json"), taskID: "source", phase: "source" } }))
  const campaign = path.join(root, "campaign.json")
  await writeFile(campaign, JSON.stringify({ title: "Offline Campaign", baseSpecPath: specPath, mode: "graph_iterative", maxRounds: 1, seedTargets: [] }))
  const previous = process.env.AUTO_EVOLVE_SKIP_STALE_HEAL
  process.env.AUTO_EVOLVE_SKIP_STALE_HEAL = "1"
  try {
    const result = await actual.runLongTaskCampaign({ cwd: root, specPath: campaign, forceNew: true })
    await writeFile(path.join(root, "observed-result.json"), JSON.stringify({ result, calls }, null, 2))
    expect(result.status).toBe("verified_success")
    expect(calls.some((title) => title.startsWith("Long Task Execute"))).toBe(true)
    expect(leads).toBe(revision ? 2 : 1)
    const roundsRoot = path.join(result.campaignDir, "rounds")
    const receipts = (await readdir(roundsRoot, { recursive: true })).filter((file) => file.endsWith("protocol.receipt.json")).sort()
    expect(receipts).toHaveLength(revision ? 2 : 1)
    const values = await Promise.all(receipts.map(async (file) => JSON.parse(await readFile(path.join(roundsRoot, file), "utf8"))))
    expect(values.map((value) => value.status)).toEqual(revision ? ["rejected", "passed"] : ["passed"])
    expect(values.every((value) => value.claim === "skill_check" && value.executed === false)).toBe(true)
    if (revision) expect(values[0].evidence.skill[0].sha256).not.toBe(values[1].evidence.skill[0].sha256)
  } finally {
    delete holder[key]
    if (previous === undefined) delete process.env.AUTO_EVOLVE_SKIP_STALE_HEAL
    else process.env.AUTO_EVOLVE_SKIP_STALE_HEAL = previous
  }
}, 30000)
