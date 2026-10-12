import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile, readdir, rename } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { summarizeResources } from "./resource-summary"

// 离线打包只替换API与配置边界，保留实际内外控制器源码。
export async function buildOfflineCampaign(root: string, boundaryKey: string) {
  const orchestrator = path.resolve(import.meta.dir, "..")
  const entry = path.join(root, "campaign-entry.ts")
  await writeFile(entry, `export { runLongTaskCampaign, resumeLongTaskCampaign } from ${JSON.stringify(path.join(orchestrator, "long-task-campaign/runner.ts"))};
export { runOpencodeTask } from ${JSON.stringify(path.join(orchestrator, "opencode.ts"))};
export { loadConfig, DEFAULT_CONFIG } from ${JSON.stringify(path.join(orchestrator, "schema.ts"))};
export { buildNbaPack } from ${JSON.stringify(path.resolve(import.meta.dir, "../../projects/nba/pack.ts"))};
export { prepareProjectTasks } from ${JSON.stringify(path.join(orchestrator, "protocol-plugins/project-tasks.ts"))};
export { runProjectBatch } from ${JSON.stringify(path.join(orchestrator, "protocol-plugins/project-batch.ts"))};
export { builtins } from ${JSON.stringify(path.join(orchestrator, "protocol-plugins/builtins.ts"))};`)
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

test("NBA actual Campaign batch learns merges replays and tests without repeated calls", async () => {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(root, { recursive: true })
  const key = `__campaignOffline_${randomUUID().replaceAll("-", "")}`
  const actual = await buildOfflineCampaign(root, key)
  const holder = globalThis as Record<string, any>
  const config = structuredClone(actual.DEFAULT_CONFIG)
  config.monitorConfig.enabled = false
  config.monitorConfig.autoStart = false
  let trainingCalls = 0
  const grants: Array<{ title: string; prompt: string; reads: string[]; edits: string[] }> = []
  holder[key] = { async loadConfig() { return config }, async runOpencodeTask(input: any) {
    trainingCalls++
    grants.push({ title: input.title, prompt: input.prompt, reads: [...(input.permissionReadPaths ?? [])],
      edits: [...(input.permissionEditPaths ?? [])] })
    await input.onSpawn?.()
    if (input.title.startsWith("Campaign Lead")) for (const dir of input.permissionEditPaths ?? []) {
      if (!dir.endsWith(".json")) { await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, "skill.txt"), "Reusable legality procedure") }
    }
    const responseText = JSON.stringify(input.title.startsWith("Long Task Graph") ? { completion_validator_ids: [],
      units: [{ id: "explore", operation: "author_work", title: "Explore rules", goal: "Explore", inputs: [], depends_on: [], expected_artifacts: [],
        claim: "Explored", check_plan: "Host acceptance follows", validator_ids: [], retry_budget: 1 }] }
      : { claimed_success: true, claim_statement: "Fixture exploration", summary: "Reusable procedure", blockers: [] })
    return { title: input.title, prompt: input.prompt, selectedModel: input.model, referencedPaths: input.referencePaths ?? [],
      attachedFiles: [], promptInlineFiles: [], permissionReadPaths: input.permissionReadPaths ?? [], permissionEditPaths: input.permissionEditPaths ?? [],
      result: { exitCode: 0, stdout: responseText, stderr: "", events: [], responseText, toolFailures: [] } }
  } }
  const original = path.join(root, "original")
  await mkdir(original)
  await writeFile(path.join(original, "manifest.json"), JSON.stringify({ split: { train: ["source-1", "source-2"], test: ["heldout"] } }))
  for (const [split, ids] of [["train", ["source-1", "source-2"]], ["test", ["heldout"]]] as const) {
    for (const role of ["public", "private-answers"]) await mkdir(path.join(original, role, split), { recursive: true })
    for (const id of ids) {
      await writeFile(path.join(original, "public", split, `${id}.json`), JSON.stringify({ system_prompt: "Public NBA rules", user_prompt: `Public operation ${id}` }))
      await writeFile(path.join(original, "private-answers", split, `${id}.json`), JSON.stringify({ answer: false, private_note: "PRIVATE_BATCH_LABEL" }))
    }
  }
  const pack = await actual.buildNbaPack(original, path.join(root, "pack"))
  const credentialEnv = `AEV_BATCH_FIXTURE_${randomUUID().replaceAll("-", "").toUpperCase()}`
  let httpCalls = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as any
    httpCalls++
    expect(body.tools).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain("PRIVATE_BATCH_LABEL")
    return Response.json({ model: body.model, choices: [{ finish_reason: "stop", message: { content: "Answer: False" } }],
      usage: { prompt_tokens: 20, completion_tokens: 3 } })
  } })
  process.env[credentialEnv] = "synthetic-local-test"
  const previous = process.env.AUTO_EVOLVE_SKIP_STALE_HEAL
  process.env.AUTO_EVOLVE_SKIP_STALE_HEAL = "1"
  try {
    const python = "C:/Users/ZhuanZ/miniconda3/python.exe"
    const scorer = path.resolve(import.meta.dir, "../../projects/nba/official-scorer.py")
    const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex")
    const mergeChecker = path.join(root, "merge-check.py")
    await writeFile(mergeChecker, 'import json\nprint(json.dumps({"status":"passed","message":"fixture merge gate"}))\n')
    const settings = async (script: string) => ({ command: python, commandSHA256: await hash(python), script,
      scriptSHA256: await hash(script), timeoutMs: 10000, maxOutputBytes: 4096 })
    const phase = { claim: "task_execution", executor: { id: "http-text-chat", version: "1", settings: {
      dialect: "openai_chat", url: server.url.origin + "/v1/chat/completions", allowedOrigins: [server.url.origin],
      model: "offline-nba", expectedModel: "offline-nba", credentialEnv, systemInput: "system", userInputs: ["user"],
      skillPlacement: "system", maxTokens: 100, maxInputBytes: 10000, maxResponseBytes: 4096, temperature: 0, timeoutMs: 2000 } },
      checks: [{ id: "script-json-checker", version: "1", name: "nba", target: "product", stage: "after_execution",
        required: true, mechanism: "script", privateInputs: ["gold"], settings: await settings(scorer) }] }
    const selectionPath = path.join(root, "selection.json")
    await writeFile(selectionPath, JSON.stringify({ schema: "aev.protocol-plugins.v1", project: pack.pack.project,
      run: { skillFormat: "text", productKind: "text", materialKinds: ["text"] }, protocol: { id: "nba-batch", version: "1",
        phases: { source: phase, replay: phase, test: phase, merge: { claim: "skill_check", checks: [{ id: "script-json-checker",
          version: "1", name: "merge", target: "skill", stage: "before_execution", required: true, mechanism: "script", settings: await settings(mergeChecker) }] } } } }))
    await actual.prepareProjectTasks({ manifestPath: path.join(root, "pack/manifest.json"), selectionPath,
      destination: path.join(root, "prepared"), trainingGoal: "Learn reusable legality rules" }, await actual.builtins(path.join(root, "prepare-backends")))
    let authors = 0
    const input = { cwd: root, runRoot: path.join(root, "batch"), config: { schema: "aev.project-batch.v1",
      tasksPath: path.join(root, "prepared/project-tasks.json"), rounds: 2, fanoutLimit: 1, requireAllSources: true,
      sourceReplay: true, replayMustPass: true, repairAttempts: 0, finalTest: true,
      pipeline: { schema: "aev.protocol-pipeline.v1", mergeAuthor: { model: "fixture/author", expectedModel: "fixture/author",
        timeoutMs: 1000, maxInputBytes: 100000 } } } }
    const dependencies = { createDriver: async () => ({ implementation: "c".repeat(64), preflight: async () => {},
      invoke: async (request: { editPaths: string[] }) => {
        authors++; for (const file of request.editPaths) await writeFile(file, "Merged reusable legality procedure")
        return { completed: true, actualModel: "fixture/author", evidence: [] }
      } }) }
    const first = await actual.runProjectBatch(input, dependencies)
    await writeFile(path.join(root, "batch-observed.json"), JSON.stringify({ status: first.status, trainingCalls, httpCalls, authors }, null, 2))
    expect(first.status).toBe("completed")
    expect(first.state.instances.filter((row: any) => row.role === "train" && row.status === "passed")).toHaveLength(2)
    expect(first.progress.outcomes.test.passed).toBe(1)
    expect(httpCalls).toBe(5)
    expect(authors).toBe(1)
    const privateFiles = pack.pack.tasks.flatMap((task: any) => task.privateInputs.map((file: any) => path.join(root, "pack", file.path)))
    const contains = (parent: string, file: string) => {
      const rel = path.relative(parent, file)
      return !rel || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
    }
    expect(privateFiles).toHaveLength(3)
    expect(grants.some((grant) => grant.title.startsWith("Campaign Lead"))).toBe(true)
    expect(grants.some((grant) => grant.title.startsWith("Long Task Graph"))).toBe(true)
    for (const grant of grants) {
      expect(grant.prompt).not.toContain("PRIVATE_BATCH_LABEL")
      for (const allowed of [...grant.reads, ...grant.edits]) {
        for (const privateFile of privateFiles) expect(contains(allowed, privateFile)).toBe(false)
      }
    }
    await writeFile(path.join(root, "training-permission-audit.json"), JSON.stringify({ grants, privateFiles }, null, 2))
    const before = trainingCalls
    expect((await actual.runProjectBatch(input, dependencies)).status).toBe("completed")
    expect(trainingCalls).toBe(before)
    expect(httpCalls).toBe(5)
    expect(authors).toBe(1)
  } finally {
    delete holder[key]; delete process.env[credentialEnv]; server.stop(true)
    if (previous === undefined) delete process.env.AUTO_EVOLVE_SKIP_STALE_HEAL
    else process.env.AUTO_EVOLVE_SKIP_STALE_HEAL = previous
  }
}, 30000)

for (const scenario of [{ rejectedLeads: 0 }, { rejectedLeads: 1 }, { rejectedLeads: 2 },
  { rejectedLeads: 0, fault: "scoring_error" }, { rejectedLeads: 0, fault: "data_error" },
  { rejectedLeads: 0, execution: true }, { rejectedLeads: 1, execution: true },
  { rejectedLeads: 2, execution: true },
  { rejectedLeads: 0, execution: true, seeded: true },
  { rejectedLeads: 0, execution: true, seeded: true, executorPatch: true },
  { rejectedLeads: 0, execution: true, seeded: true, executorPatch: true, recoverBeforeLead: true },
  { rejectedLeads: 1, execution: true, recoverAfterPass: true },
  { rejectedLeads: 1, execution: true, seeded: true, executorPatch: true, partialLead: true },
  { rejectedLeads: 0, execution: true, fault: "execution_error" }])
test(`actual Campaign learner ${scenario.executorPatch ? "executor-change " : ""}${scenario.recoverBeforeLead ? "recovery " : ""}${scenario.seeded ? "seeded " : ""}${scenario.execution ? "HTTP task execution " : ""}${scenario.fault ?? `accepts after ${scenario.rejectedLeads} rejected candidates`} with offline model receipts`, async () => {
  const { rejectedLeads, fault, execution, seeded, executorPatch, partialLead, recoverBeforeLead, recoverAfterPass } = scenario
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(root, { recursive: true })
  const key = `__campaignOffline_${randomUUID().replaceAll("-", "")}`
  const holder = globalThis as Record<string, any>
  const actual = await buildOfflineCampaign(root, key)
  const config = structuredClone(actual.DEFAULT_CONFIG)
  config.monitorConfig.enabled = false
  config.monitorConfig.autoStart = false
  const calls: string[] = []
  const roleRequests: Array<{ title: string; prompt: string; reads: string[]; edits: string[] }> = []
  let leads = 0
  let recoveryTriggered = false
  holder[key] = { async loadConfig() { return config }, async runOpencodeTask(input: any) {
    calls.push(input.title)
    roleRequests.push({ title: input.title, prompt: input.prompt,
      reads: [...(input.referencePaths ?? []), ...(input.permissionReadPaths ?? [])],
      edits: [...(input.permissionEditPaths ?? [])] })
    await input.onSpawn?.()
    if ((recoverBeforeLead || (recoverAfterPass && leads === 1)) && !recoveryTriggered && input.title.startsWith("Campaign Lead")) {
      recoveryTriggered = true
      throw new Error("Fixture interruption before Lead")
    }
    if (executorPatch && input.title.startsWith("Long Task Execute")) {
      const directory = path.join(root, "auto-evolve/runtime-state/long-task-campaigns")
      const names = await readdir(directory)
      expect(names).toHaveLength(1)
      const current = path.join(directory, names[0], "pending-expert-package/current")
      await writeFile(path.join(current, "rules.txt"), rejectedLeads ? "Incomplete rule" : "Reusable rule")
      if (partialLead) await writeFile(path.join(current, "notes.txt"), "Executor note")
    }
    if (input.title.startsWith("Campaign Lead")) leads++
    if (input.title.startsWith("Campaign Lead")) {
      if (seeded && leads === 1) {
        const current = input.permissionReadPaths.find((file: string) => file.replaceAll("\\", "/").endsWith("/pending-expert-package/current"))
        expect(current).toBeDefined()
        expect(await readFile(path.join(current, "rules.txt"), "utf8")).toBe(executorPatch ?
          rejectedLeads ? "Incomplete rule" : "Reusable rule" : "Seeded reusable rule")
      }
      if (executorPatch) {
        const draft = input.permissionEditPaths.find((file: string) => file.replaceAll("\\", "/").endsWith("/pending-package"))
        expect(draft).toBeDefined()
        expect(await readFile(path.join(draft, "rules.txt"), "utf8")).toBe(leads === 1 && !rejectedLeads ? "Reusable rule" : "Incomplete rule")
        if (partialLead) {
          expect(await readFile(path.join(draft, "notes.txt"), "utf8")).toBe(leads === 1 ? "Executor note" : "Executor note + Lead pass1")
          await writeFile(path.join(draft, leads === 1 ? "notes.txt" : "rules.txt"),
            leads === 1 ? "Executor note + Lead pass1" : "Reusable rule")
        }
        const roundRoot = path.dirname(draft)
        const tree = JSON.parse(await readFile(path.join(roundRoot, "exploration-tree.json"), "utf8"))
        const routing = JSON.parse(await readFile(path.join(roundRoot, "routing-control.json"), "utf8"))
        expect(tree.updatedThroughRound).toBe(1)
        expect(routing.updatedThroughRound).toBe(1)
      }
      for (const edit of input.permissionEditPaths ?? []) expect(input.permissionReadPaths).toContain(edit)
      if (execution && leads > 1) {
        expect(input.prompt).toContain("A product rejection means the generated answer failed")
        const productPath = input.permissionReadPaths.find((file: string) => file.endsWith("protocol.product.txt"))
        expect(productPath).toBeDefined()
        expect(input.prompt).toContain("protocol.product.txt")
        expect(await readFile(productPath, "utf8")).toBe("Incomplete rule")
      }
    }
    for (const edit of input.permissionEditPaths ?? []) {
      if (executorPatch) continue
      if (edit.endsWith("rules.txt")) { await mkdir(path.dirname(edit), { recursive: true }); await writeFile(edit, "Reusable rule") }
      if (input.title.startsWith("Campaign Lead") && !edit.endsWith(".json")) {
        await mkdir(edit, { recursive: true }); await writeFile(path.join(edit, "rules.txt"), leads <= rejectedLeads ? "Incomplete rule" : "Reusable rule")
      }
    }
    const responseText = JSON.stringify(input.title.startsWith("Long Task Graph") ? {
      planner_summary: "Fixture replanning", completion_validator_ids: [], units: [{ id: "reexplore", operation: "author_work", title: "Reexplore",
        goal: "Revise reusable rules", inputs: [], depends_on: [], expected_artifacts: [], claim: "Explored",
        check_plan: "Formal protocol follows", validator_ids: [], retry_budget: 1 }] } : {
      claimed_success: true, claim_statement: "Fixture exploration complete",
      summary: "Fixture reusable rule", blockers: [], updated_files: [], suggestions: [] })
    return { title: input.title, prompt: input.prompt, selectedModel: input.model,
      referencedPaths: input.referencePaths ?? [], attachedFiles: [], promptInlineFiles: [],
      permissionReadPaths: input.permissionReadPaths ?? [], permissionEditPaths: input.permissionEditPaths ?? [],
      result: { exitCode: 0, stdout: responseText, stderr: "", events: [], responseText, toolFailures: [] } }
  } }
  const project = { id: "campaign-fixture", version: "1", skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] }
  const python = "C:/Users/ZhuanZ/miniconda3/python.exe"
  const script = path.join(root, "check.py")
  await writeFile(script, 'import json,sys\np=json.load(open(sys.argv[1],encoding="utf-8-sig"))\ng=json.load(open(p["privateInputs"][0]["path"],encoding="utf-8-sig"))\nassert g["marker"]=="PRIVATE_CAMPAIGN_LABEL"\ns=open(p["candidate"][0]["path"],encoding="utf-8").read()\nprint(json.dumps({"status":"passed" if s=="Reusable rule" else "rejected","message":"fixture content gate"}))\n')
  if (fault && fault !== "execution_error") await writeFile(script, `import json\nprint(json.dumps({"status":${JSON.stringify(fault)},"message":"fixture failure"}))\n`)
  const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex")
  await writeFile(path.join(root, "public.txt"), "Public rules")
  await writeFile(path.join(root, "system.txt"), "Independent public execution")
  const privateFile = path.join(root, "private", "gold.json")
  await mkdir(path.dirname(privateFile))
  await writeFile(privateFile, JSON.stringify({ marker: "PRIVATE_CAMPAIGN_LABEL" }))
  const credentialEnv = `AEV_CAMPAIGN_FIXTURE_${randomUUID().replaceAll("-", "").toUpperCase()}`
  let httpCalls = 0
  const server = execution ? Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as any
    httpCalls++
    expect(body.tools).toBeUndefined()
    expect(body.model).toBe("offline-consumer")
    expect(JSON.stringify(body)).not.toContain("PRIVATE_CAMPAIGN_LABEL")
    if (fault === "execution_error") return Response.json({ error: "fixture unavailable" }, { status: 503 })
    const text = body.messages.map((item: any) => item.content).join("\n")
    return Response.json({ model: body.model, choices: [{ finish_reason: "stop", message: {
      content: text.includes("Incomplete rule") ? "Incomplete rule" : "Reusable rule" } }],
      usage: { prompt_tokens: 20, completion_tokens: 3 } })
  } }) : undefined
  if (execution) process.env[credentialEnv] = "synthetic-local-test"
  const executor = server ? { id: "http-text-chat", version: "1", settings: { dialect: "openai_chat",
    url: server.url.origin + "/v1/chat/completions", allowedOrigins: [server.url.origin],
    model: "offline-consumer", expectedModel: "offline-consumer", credentialEnv, systemInput: "system", userInputs: ["public"],
    skillPlacement: "system", maxTokens: 100, maxInputBytes: 10000, maxResponseBytes: 4096, temperature: 0, timeoutMs: 2000 } } : undefined
  await writeFile(path.join(root, "selection.json"), JSON.stringify({ schema: "aev.protocol-plugins.v1", project,
    run: { skillFormat: "text", productKind: "text", materialKinds: ["text"] }, protocol: { id: "fixture", version: "1",
      phases: { source: { claim: execution ? "task_execution" : "skill_check", executor, checks: [{ id: "script-json-checker", version: "1", name: "content",
        target: execution ? "product" : "skill", stage: execution ? "after_execution" : "before_execution", required: true, mechanism: "script", privateInputs: ["gold"], settings: {
          command: python, commandSHA256: await hash(python), script, scriptSHA256: await hash(script), timeoutMs: 10000, maxOutputBytes: 4096 } }] } } } }))
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({ schema: "aev.project-pack.v1", project,
    skill: { format: "text", entries: [{ id: "rules", kind: "text", path: "rules.txt" },
      ...(partialLead ? [{ id: "notes", kind: "text", path: "notes.txt" }] : [])] },
    tasks: [{ id: "source", split: "train", materials: [{ id: "public", kind: "text", path: "public.txt" },
      { id: "system", kind: "text", path: "system.txt" }], privateInputs: [{ id: "gold", kind: "json", path: "private/gold.json" }] }] }))
  const specPath = path.join(root, "spec.json")
  await writeFile(specPath, JSON.stringify({ title: "Offline learning", goal: "Learn reusable public rules",
    materials: [{ label: "public", path: "public.txt" }], validators: [],
    initialGraph: { units: [{ id: "explore", title: "Explore", goal: "Explore public rules", inputs: [], depends_on: [],
      expected_artifacts: [], claim: "Explored", check_plan: "Formal protocol follows", validator_ids: [], retry_budget: 1 }] },
    protocolPlugins: { schema: "aev.protocol-entry.v1", selectionPath: path.join(root, "selection.json"),
      projectManifestPath: path.join(root, "manifest.json"), taskID: "source", phase: "source" } }))
  const campaign = path.join(root, "campaign.json")
  const seedRoot = path.join(root, "initial-candidate")
  if (seeded) {
    await mkdir(seedRoot)
    await writeFile(path.join(seedRoot, "rules.txt"), "Seeded reusable rule")
    if (partialLead) await writeFile(path.join(seedRoot, "notes.txt"), "Seeded note")
  }
  await writeFile(campaign, JSON.stringify({ title: "Offline Campaign", baseSpecPath: specPath, mode: "graph_iterative", maxRounds: rejectedLeads === 2 ? 2 : 1,
    seedTargets: seeded ? [{ seedPath: seedRoot, targetPath: path.join(root, "author-workspace"), kind: "experience_workspace", resetOnStart: true }] : [] }))
  const previous = process.env.AUTO_EVOLVE_SKIP_STALE_HEAL
  process.env.AUTO_EVOLVE_SKIP_STALE_HEAL = "1"
  try {
    let result = await actual.runLongTaskCampaign({ cwd: root, specPath: campaign, forceNew: true })
    if (recoverBeforeLead || recoverAfterPass) {
      expect(result.status).toBe("failed")
      await writeFile(path.join(root, "interrupted-result.json"), JSON.stringify(result))
      const statePath = path.join(result.campaignDir, "campaign.json")
      const state = JSON.parse(await readFile(statePath, "utf8"))
      // 仅离线夹具模拟已审计接管，复用完成的轮内工作。
      await writeFile(statePath, JSON.stringify({ ...state, status: "recovery_pending", ownerPID: undefined,
        ownerCommandHint: undefined, ownerCreationTick: undefined, heartbeatAt: undefined,
        recovery: { action: "harvest_round_run", roundNumber: 1, runID: state.lastRunID,
          reason: "Offline audited interruption", detectedAt: new Date().toISOString() } }))
      result = await actual.resumeLongTaskCampaign({ cwd: root, campaignID: result.campaignID, specPath: campaign })
      expect(calls.filter(title => title.startsWith("Long Task Execute"))).toHaveLength(1)
    }
    await writeFile(path.join(root, "observed-result.json"), JSON.stringify({ result, calls }, null, 2))
    expect(result.status).toBe(fault ? "failed" : "verified_success")
    if (partialLead) expect(await readFile(path.join(result.campaignDir, "pending-expert-package/current/notes.txt"), "utf8"))
      .toBe("Executor note + Lead pass1")
    const accountingFiles = (await readdir(root, { recursive: true })).filter((file) =>
      /\/protocol-invocations\/[^/]+\/accounting\.json$/.test(file.replaceAll("\\", "/")))
    const accounting = await Promise.all(accountingFiles.map(async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"))))
    expect(accounting).toHaveLength(calls.length)
    expect(accounting.every((item) => ["completed", ...(recoverBeforeLead || recoverAfterPass ? ["infrastructure_error"] : [])].includes(item.status) &&
      item.inputTokens === null && item.outputTokens === null)).toBe(true)
    if (recoverBeforeLead || recoverAfterPass) expect(accounting.filter(item => item.status === "infrastructure_error")).toHaveLength(1)
    expect(accounting.some((item) => item.role === "executor")).toBe(true)
    expect(accounting.some((item) => item.role === "lead")).toBe(true)
    if (rejectedLeads === 2) expect(accounting.some((item) => item.role === "planner")).toBe(true)
    await writeFile(path.join(root, "training-accounting-audit.json"), JSON.stringify({ calls: calls.length, accountingFiles, accounting }, null, 2))
    const resourceSummary = await summarizeResources(root)
    expect(resourceSummary.invocations).toHaveLength(calls.length + httpCalls)
    expect(resourceSummary.input.knownTokens).toBe(execution && fault !== "execution_error" ? httpCalls * 20 : 0)
    expect(resourceSummary.output.knownTokens).toBe(execution && fault !== "execution_error" ? httpCalls * 3 : 0)
    expect(resourceSummary.input.unreportedInvocations).toBe(calls.length + (fault === "execution_error" ? httpCalls : 0))
    // 故障缓存只留下开始标记，不能据此声称所有消耗已知。
    expect(resourceSummary.startedWithoutLedger).toHaveLength(fault ? 1 : 0)
    await writeFile(path.join(root, "resource-summary-audit.json"), JSON.stringify(resourceSummary, null, 2))
    expect(calls.some((title) => title.startsWith("Long Task Execute"))).toBe(true)
    for (const request of roleRequests) {
      if (request.title.startsWith("Long Task Graph") || request.title.startsWith("Long Task Execute")) {
        expect(request.prompt).toContain("Selected-protocol training-side work boundary")
        expect(request.prompt).toContain("parent is waiting for your response before it can grade")
        expect(request.prompt).toContain("claimed_success describes completion of this author unit")
        expect(request.prompt).not.toContain("If you suspect runtime stall")
      }
      expect(request.prompt).not.toContain("PRIVATE_CAMPAIGN_LABEL")
      for (const allowed of [...request.reads, ...request.edits]) {
        const rel = path.relative(allowed, privateFile)
        expect(!rel || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))).toBe(false)
      }
    }
    await writeFile(path.join(root, "role-permission-audit.json"), JSON.stringify({ privateFile, roleRequests }, null, 2))
    for (const request of roleRequests.filter((item) => item.title.startsWith("Campaign"))) {
      for (const file of ["public.txt", "system.txt"]) {
        const material = path.join(root, file).replaceAll("\\", "/")
        expect(request.reads.map(file => file.replaceAll("\\", "/"))).toContain(material)
        expect(request.prompt).toContain(material)
      }
      expect(request.reads.some((file) => file.endsWith("protocol.receipt.json"))).toBe(false)
      expect(request.prompt).not.toContain("protocol.receipt.json")
      expect(request.reads.some((file) => file.endsWith("expert-oracle-bundle.json"))).toBe(false)
    }
    expect(leads).toBe(rejectedLeads + 1)
    if (rejectedLeads && !fault) {
      const tickets = JSON.parse(await readFile(path.join(result.campaignDir, "dispatch-tickets.json"), "utf8"))
      expect(tickets.tickets.some((ticket: { key: string }) => ticket.key === `skill:${execution ? "product" : "skill"}:content`)).toBe(true)
      expect(tickets.tickets.some((ticket: { title: string }) => ticket.title.startsWith("Repair validator"))).toBe(false)
      const laterLeads = roleRequests.filter(item => item.title.startsWith("Campaign Lead")).slice(1)
      expect(laterLeads.every(item => item.prompt.includes("Host alone"))).toBe(true)
    }
    expect(result.roundsCompleted).toBe(rejectedLeads === 2 ? 2 : 1)
    if (rejectedLeads === 2) expect(calls.some((title) => title.startsWith("Long Task Graph"))).toBe(true)
    const roundsRoot = path.join(result.campaignDir, "rounds")
    const receipts = (await readdir(roundsRoot, { recursive: true })).filter((file) => file.endsWith("protocol.receipt.json")).sort()
    expect(receipts).toHaveLength(rejectedLeads + 1)
    const values = await Promise.all(receipts.map(async (file) => JSON.parse(await readFile(path.join(roundsRoot, file), "utf8"))))
    expect(values.map((value) => value.status)).toEqual(fault ? [fault] : [...Array(rejectedLeads).fill("rejected"), "passed"])
    expect(new Set(values.map((value) => value.protocolFingerprint)).size).toBe(1)
    expect(values.every((value) => value.claim === (execution ? "task_execution" : "skill_check") &&
      value.executed === Boolean(execution && fault !== "execution_error"))).toBe(true)
    expect(httpCalls).toBe(execution ? Math.min(rejectedLeads, 1) + 1 : 0)
    if (execution && rejectedLeads === 2) expect(values.map(value => value.executionReused)).toEqual([false, true, false])
    if (!fault) {
      const count = calls.length
      const requests = httpCalls
      expect((await actual.resumeLongTaskCampaign({ cwd: root, campaignID: result.campaignID, specPath: campaign })).status).toBe("verified_success")
      expect(calls).toHaveLength(count)
      expect(httpCalls).toBe(requests)
      const state = JSON.parse(await readFile(path.join(result.campaignDir, "campaign.json"), "utf8"))
      const accepted = JSON.parse(await readFile(state.lastFinalAcceptanceResultPath, "utf8"))
      if (execution) {
        const productFile = path.join(path.dirname(accepted.protocolReceiptPath), "protocol.product.txt")
        const productBytes = await readFile(productFile)
        expect(productBytes.toString()).toBe("Reusable rule")
        await writeFile(productFile, "Altered answer")
        try {
          await expect(actual.resumeLongTaskCampaign({ cwd: root, campaignID: result.campaignID, specPath: campaign }))
            .rejects.toThrow("public product evidence drift")
          expect(calls).toHaveLength(count)
          expect(httpCalls).toBe(requests)
        } finally { await writeFile(productFile, productBytes) }
      }
      const feedbackFile = accepted.protocolTrainingResultPath
      const originalFeedback = await readFile(feedbackFile)
      await writeFile(feedbackFile, JSON.stringify({ ...JSON.parse(originalFeedback.toString()), summary: "Altered training feedback" }))
      try {
        await expect(actual.resumeLongTaskCampaign({ cwd: root, campaignID: result.campaignID, specPath: campaign }))
          .rejects.toThrow("training feedback drift")
        expect(calls).toHaveLength(count)
        expect(httpCalls).toBe(requests)
      } finally { await writeFile(feedbackFile, originalFeedback) }
      const file = path.join(accepted.validationPackageRoot, "rules.txt")
      const original = await readFile(file)
      await writeFile(file, "Unverified changed rule")
      await expect(actual.resumeLongTaskCampaign({ cwd: root, campaignID: result.campaignID, specPath: campaign })).rejects.toThrow("identity")
      expect(calls).toHaveLength(count)
      expect(httpCalls).toBe(requests)
      await writeFile(file, original)
      const receiptFile = accepted.protocolReceiptPath
      await rename(receiptFile, `${receiptFile}.fixture-saved`)
      try {
        await expect(actual.resumeLongTaskCampaign({ cwd: root, campaignID: result.campaignID, specPath: campaign })).rejects.toThrow("evidence missing")
        expect(calls).toHaveLength(count)
        expect(httpCalls).toBe(requests)
      } finally { await rename(`${receiptFile}.fixture-saved`, receiptFile) }
    }
    if (rejectedLeads) expect(values[0].evidence.skill.find((file: any) => file.id === "rules").sha256)
      .not.toBe(values.at(-1).evidence.skill.find((file: any) => file.id === "rules").sha256)
    if (partialLead) expect(values[0].evidence.skill.find((file: any) => file.id === "notes").sha256)
      .toBe(values.at(-1).evidence.skill.find((file: any) => file.id === "notes").sha256)
    if (fault) {
      const state = JSON.parse(await readFile(path.join(result.campaignDir, "campaign.json"), "utf8"))
      expect(state.lastGateFailureKind).toBe(fault === "data_error" ? "dataset_failure" : "infrastructure_failure")
      expect(calls.filter((title) => title.startsWith("Campaign Lead"))).toHaveLength(1)
      expect(calls.some((title) => /diagnos/i.test(title))).toBe(false)
    }
  } finally {
    server?.stop(true)
    delete process.env[credentialEnv]
    delete holder[key]
    if (previous === undefined) delete process.env.AUTO_EVOLVE_SKIP_STALE_HEAL
    else process.env.AUTO_EVOLVE_SKIP_STALE_HEAL = previous
  }
}, 30000)
