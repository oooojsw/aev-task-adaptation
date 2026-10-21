import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"

const repo = path.resolve(import.meta.dir, "../../..")
const baseline = "7d8b7d36d4f5357fb69b4079393cd4f3e28d2293"

async function build(root: string, key: string, old: boolean) {
  const entry = path.join(root, "entry.ts")
  const orchestrator = path.join(repo, "auto-evolve/orchestrator")
  await writeFile(entry, `export {runLongTaskCampaign, resumeLongTaskCampaign} from ${JSON.stringify(path.join(orchestrator, "long-task-campaign/runner.ts"))};
export {DEFAULT_CONFIG} from ${JSON.stringify(path.join(orchestrator, "schema.ts"))};`)
  const sources: string[] = []
  const output = await Bun.build({ entrypoints: [entry], target: "bun", packages: "external", outdir: root,
    naming: "legacy-[hash].js", plugins: [{ name: "fixed-campaign-boundaries", setup(builder) {
      builder.onLoad({ filter: /\.(ts|md)$/ }, async ({ path: file }) => {
        if (!file.startsWith(repo + path.sep)) return
        const relative = path.relative(repo, file).replaceAll("\\", "/")
        let source = await readFile(file, "utf8")
        if (old) {
          const result = Bun.spawnSync(["git", "show", `${baseline}:${relative}`], { cwd: repo })
          if (result.exitCode !== 0) throw new Error(`Baseline source missing: ${relative}`)
          source = result.stdout.toString()
        }
        sources.push(relative)
        for (const [suffix, name] of [["orchestrator/opencode.ts", "runOpencodeTask"],
          ["orchestrator/schema.ts", "loadConfig"], ["orchestrator/blank-eval/runner.ts", "runBlankEval"]]) {
          if (!relative.endsWith(suffix)) continue
          const signature = `export async function ${name}(`
          if (source.split(signature).length !== 2) throw new Error(`Boundary drift: ${relative}`)
          // 两版仅替换外部回执；控制器和依赖各用自身源码。
          source = source.replace(signature, `async function unused_${name}(`) +
            `\nexport async function ${name}(...args:any[]) { const b=(globalThis as any)[${JSON.stringify(key)}];
if (!b) throw new Error("Missing offline boundary"); return b.${name}(...args); }`
        }
        return { contents: source, loader: file.endsWith(".md") ? "text" : "ts" }
      })
    } }] })
  if (!output.success) throw new Error(output.logs.map(String).join("\n"))
  const bundle = await readFile(output.outputs[0].path, "utf8")
  if (bundle.includes("startStaleOpencodeRuntimeCleanup(input.cwd)")) throw new Error("Live backend retained")
  await writeFile(path.join(root, "source-inventory.json"), JSON.stringify({ baseline: old ? baseline : null, sources }))
  return import(pathToFileURL(output.outputs[0].path).href)
}

for (const scenario of [{ name: "pass", rejects: 0, rounds: 1 }, { name: "reject", rejects: 100, rounds: 1 },
  { name: "cross-round revision", rejects: 2, rounds: 2 }]) test(`complete legacy Campaign ${scenario.name} matches baseline`, async () => {
  const observations: any[] = []
  for (const old of [true, false]) {
    const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
    await mkdir(root, { recursive: true })
    const key = `__legacyCampaign_${randomUUID().replaceAll("-", "")}`
    const actual = await build(root, key, old)
    const config = structuredClone(actual.DEFAULT_CONFIG)
    config.monitorConfig.enabled = false
    config.monitorConfig.autoStart = false
    const requests: any[] = []
    const blanks: any[] = []
    const holder = globalThis as Record<string, any>
    holder[key] = { async loadConfig() { return config }, async runOpencodeTask(input: any) {
      requests.push({ title: input.title, prompt: input.prompt, model: input.model,
        reads: input.permissionReadPaths, edits: input.permissionEditPaths, references: input.referencePaths })
      await input.onSpawn?.()
      if (input.title.startsWith("Campaign Lead")) for (const dir of input.permissionEditPaths ?? []) {
        if (!dir.endsWith(".json")) { await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, "README.md"), "Reusable procedure") }
      }
      if (!old && input.title.startsWith("Campaign Lead")) {
        for (const file of input.permissionReadPaths ?? []) {
          if (file.endsWith("final-answer.txt")) expect(await readFile(file, "utf8")).toBe("Complete worker analysis, including the final recommendation.")
        }
      }
      const responseText = JSON.stringify(input.title.startsWith("Long Task Graph") ? { completion_validator_ids: [],
        units: [{ id: "reexplore", title: "Reexplore", goal: "Revise procedure", inputs: [], depends_on: [], expected_artifacts: [],
          claim: "Explored", check_plan: "Host acceptance", validator_ids: [], retry_budget: 1 }] }
        : { claimed_success: true, claim_statement: "Fixture work complete", summary: "Reusable procedure", blockers: [] })
      return { title: input.title, prompt: input.prompt, selectedModel: input.model, referencedPaths: input.referencePaths ?? [],
        attachedFiles: [], promptInlineFiles: [], permissionReadPaths: input.permissionReadPaths ?? [], permissionEditPaths: input.permissionEditPaths ?? [],
        result: { exitCode: 0, stdout: responseText, stderr: "", events: [
          { type: "assistant_message", message: { id: "final", role: "assistant", summary: false } },
          { type: "text", part: { id: "body", messageID: "final", text: "Complete worker analysis, including the final recommendation." } },
          { type: "step_finish", part: { messageID: "final", reason: "stop" } },
        ], responseText, toolFailures: [] } }
    }, async runBlankEval(input: any) {
      blanks.push({ ...input, spec: JSON.parse(await readFile(input.specPath, "utf8")) })
      const passed = blanks.length > scenario.rejects
      return { passed, summary: "Fixed receipt", runDir: input.runRoot, resultPath: path.join(input.runRoot, "result.json"),
        sessionExecutionReportPath: path.join(input.runRoot, "session.json"),
        validatorResults: [{ validatorID: "product", passed, summary: "Fixed receipt", evidenceRefs: [], details: [], failureKind: passed ? undefined : "product_failure" }] }
    } }
    await writeFile(path.join(root, "public.txt"), "Public material")
    await writeFile(path.join(root, "check.py"), "# Never invoked: fixed blank receipt\n")
    await writeFile(path.join(root, "spec.json"), JSON.stringify({ id: "legacy-fixture", title: "Legacy fixture", goal: "Learn reusable procedure",
      materials: [{ label: "public", path: "public.txt" }], targetPaths: [{ label: "answer", path: "workspace/answer.txt" }], editablePaths: ["workspace"],
      validators: [{ id: "product", title: "Product", type: "script", path: "check.py", placement: "completion_only" }],
      initialGraph: { units: [{ id: "explore", title: "Explore", goal: "Explore", inputs: [], depends_on: [], expected_artifacts: [],
        claim: "Explored", check_plan: "Host acceptance", validator_ids: [], retry_budget: 1 }] } }))
    const specPath = path.join(root, "campaign-input.json")
    const seed = path.join(root, "seed")
    await mkdir(seed)
    await writeFile(path.join(seed, "README.md"), "Initial reusable procedure")
    await writeFile(specPath, JSON.stringify({ title: "Legacy Campaign", baseSpecPath: path.join(root, "spec.json"), mode: "graph_iterative", maxRounds: scenario.rounds,
      seedTargets: [{ seedPath: seed, targetPath: path.join(root, "expert"), kind: "experience_workspace" }] }))
    const previous = process.env.AUTO_EVOLVE_SKIP_STALE_HEAL
    process.env.AUTO_EVOLVE_SKIP_STALE_HEAL = "1"
    try {
      const result = await actual.runLongTaskCampaign({ cwd: root, specPath, forceNew: true })
      const state = JSON.parse(await readFile(path.join(result.campaignDir, "campaign.json"), "utf8"))
      await writeFile(path.join(root, "raw-observed.json"), JSON.stringify({ result, state, requests, blanks }, null, 2))
      expect(blanks.length, state.lastSummary).toBeGreaterThan(0)
      expect(result.status).toBe(scenario.rejects < 100 ? "verified_success" : "round_limit_reached")
      expect(result.roundsCompleted).toBe(scenario.rounds)
      if (scenario.rounds > 1) {
        expect(blanks).toHaveLength(3)
        expect(requests.some((request) => request.title.startsWith("Long Task Graph"))).toBe(true)
        expect(requests.some((request) => request.title.includes("round-002"))).toBe(true)
      }
      const callsBeforeResume = { model: requests.length, blank: blanks.length }
      const resumed = await actual.resumeLongTaskCampaign({ cwd: root, campaignID: result.campaignID, specPath })
      expect(resumed.status).toBe(result.status)
      expect(requests).toHaveLength(callsBeforeResume.model)
      expect(blanks).toHaveLength(callsBeforeResume.blank)
      // Worker正文合同有意升级；独立合同测试覆盖它，其余调度照旧比对。
      for (const request of requests) {
        if (request.title.startsWith("Campaign Worker") || request.title.startsWith("Blank Acceptance Diagnosis")) {
          request.prompt = "<WORKER_FINAL_PROSE_CONTRACT>"
        }
        if (request.title.startsWith("Campaign Lead")) {
          request.prompt = request.prompt.replace(/Worker suggestions:\r?\n[\s\S]*?\r?\n\r?\nEditable targets:/, "Worker suggestions: <DELIVERY_CONTRACT>\n\nEditable targets:")
          request.prompt = request.prompt.replace(/\nWorker delivery:.*$/, "")
          for (const field of ["reads", "references"]) request[field] = request[field]?.filter((file: string) => !/[\\/]workers[\\/]/.test(file))
        }
      }
      const normalize = (value: any) => JSON.parse(JSON.stringify(value, (name, item) => {
        if (["createdAt", "updatedAt", "heartbeatAt", "durationMs", "startedAt", "completedAt", "ownerPID", "ownerCreationTick"].includes(name)) return undefined
        if (typeof item !== "string") return item
        return item.replaceAll(root, "<ROOT>").replaceAll(root.replaceAll("\\", "/"), "<ROOT>")
          .replace(/\b\d{8}-\d{9}-[0-9a-f]{8}-/g, "<RUN-ID>-")
          .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<TIME>")
          .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<UUID>")
      }))
      const observed = normalize({ requests, blanks, result, state, resumed, callsBeforeResume })
      await writeFile(path.join(root, "legacy-observed.json"), JSON.stringify(observed, null, 2))
      observations.push(observed)
    } finally {
      delete holder[key]
      if (previous === undefined) delete process.env.AUTO_EVOLVE_SKIP_STALE_HEAL
      else process.env.AUTO_EVOLVE_SKIP_STALE_HEAL = previous
    }
  }
  expect(observations[1]).toEqual(observations[0])
}, 60000)
