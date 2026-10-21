import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile, readdir, rename, rm, cp } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { summarizeResources } from "./resource-summary"
import { taskFeedback } from "../task-adaptation/feedback"
import type { BoundPlan } from "../task-adaptation/binding"
import { prepareTask } from "../task-adaptation/intake"
import type { TaskCatalogue } from "../task-adaptation/catalogue"
import { reserveRequest, settleRequest, inspectBudget } from "../task-adaptation/request-budget"
import type { RequestBudget } from "../task-adaptation/request-budget"
import { exportTaskDelivery } from "../task-adaptation/delivery"
import { restoreTaskContext } from "../task-adaptation/context"
import { loadLongTaskSpec } from "../long-task/spec"

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
export { runTask } from ${JSON.stringify(path.join(orchestrator, "task-adaptation/run-task.ts"))};
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
      // 打包后仍从原源码计算身份，不能把相对资源误指向产物目录。
      builder.onLoad({ filter: /[\\/]orchestrator[\\/].*\.ts$/ }, async ({ path: file }) => ({ loader: "ts",
        contents: (await readFile(file, "utf8")).replaceAll("import.meta.url", JSON.stringify(pathToFileURL(file).href)) }))
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
  { rejectedLeads: 0, execution: true, fault: "execution_error" }, { rejectedLeads: 0, adapted: true },
  { rejectedLeads: 0, adapted: true, bootstrap: true }, { rejectedLeads: 1, adapted: true },
  { rejectedLeads: 2, adapted: true }, { rejectedLeads: 1, adapted: true, bootstrap: true, intake: true },
  { rejectedLeads: 2, adapted: true, bootstrap: true, intake: true, parallelWorkers: true },
  { rejectedLeads: 0, adapted: true, bootstrap: true, intake: true, backendIncomplete: true },
  { rejectedLeads: 1, adapted: true, bootstrap: true, intake: true, program: true },
  { rejectedLeads: 1, adapted: true, bootstrap: true, intake: true, program: true, bestPass: true },
  { rejectedLeads: 0, adapted: true, budget: "pre" }, { rejectedLeads: 0, adapted: true, budget: "mid" },
  { rejectedLeads: 0, adapted: true, budget: "unknown" },
  { rejectedLeads: 0, adapted: true, budget: "fault", fault: "scoring_error" },
  { rejectedLeads: 1, adapted: true, program: true, bestPass: true, budget: "unrelated" },
  { rejectedLeads: 1, adapted: true, program: true, bestPass: true, budget: "qualified" }])
test(`actual Campaign learner ${scenario.backendIncomplete ? "incomplete backend " : ""}${scenario.parallelWorkers ? "three parallel workers " : ""}${scenario.budget ? `budget ${scenario.budget} ` : ""}${scenario.bestPass ? "best-pass selection " : ""}${scenario.intake ? "from task intake " : ""}${scenario.adapted ? scenario.program ? "adapted program " : "adapted report " : ""}${scenario.bootstrap ? "with planner " : ""}${scenario.executorPatch ? "executor-change " : ""}${scenario.recoverBeforeLead ? "recovery " : ""}${scenario.seeded ? "seeded " : ""}${scenario.execution ? "HTTP task execution " : ""}${scenario.fault ?? `accepts after ${scenario.rejectedLeads} rejected candidates`} with offline model receipts`, async () => {
  const { rejectedLeads, fault, execution, seeded, executorPatch, partialLead, recoverBeforeLead, recoverAfterPass, adapted, bootstrap, intake, program, bestPass, budget } = scenario
  const hasExecution = Boolean(execution || program)
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
  let fixtureBudget: RequestBudget | undefined
  const workers = scenario.parallelWorkers ? ["sources", "coverage", "feedback"] : ["sources"]
  const barriers = new Map<string, { started: number; finished: number; promise: Promise<void>; release: () => void }>()
  holder[key] = { async loadConfig() { return config }, async runOpencodeTask(input: any) {
    if (budget && input.requestBudget) {
      const id = randomUUID()
      await reserveRequest(input.requestBudget.budget, { id, request: "a".repeat(64), role: input.requestBudget.role, model: input.model, reservationTokens: 1100 })
      await settleRequest(input.requestBudget.budget, id, budget === "unknown" ? undefined : 10)
    }
    calls.push(input.title)
    roleRequests.push({ title: input.title, prompt: input.prompt,
      reads: [...(input.referencePaths ?? []), ...(input.permissionReadPaths ?? [])],
      edits: [...(input.permissionEditPaths ?? [])] })
    await input.onSpawn?.()
    if (scenario.parallelWorkers && input.title.startsWith("Campaign Worker task-")) {
      const round = input.title.split(" ").at(-1)!
      if (!barriers.has(round)) {
        let release!: () => void
        const promise = new Promise<void>(resolve => { release = resolve })
        barriers.set(round, { started: 0, finished: 0, promise, release })
      }
      const barrier = barriers.get(round)!
      barrier.started++
      if (barrier.started === 3) barrier.release()
      // 串行实现无法通过该屏障，不能以三个调用记录冒充并行。
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([barrier.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Workers were serialized")), 3000) })])
      } finally { clearTimeout(timer) }
    }
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
    if (budget === "unrelated" && leads === 3 && input.title.startsWith("Campaign Lead")) throw new Error("Fixture ordinary failure after qualification")
    if (input.title.startsWith("Campaign Lead")) {
      if (scenario.parallelWorkers) {
        const barrier = barriers.get(input.title.split(" ").at(-1)!)!
        expect(barrier.started).toBe(3)
        expect(barrier.finished).toBe(3)
      }
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
      if (adapted && leads > 1 && !(bestPass && leads > 2)) {
        const feedback = input.permissionReadPaths.find((file: string) => file.endsWith("task.feedback.json"))
        expect(feedback).toBeDefined()
        const view = JSON.parse(await readFile(feedback, "utf8"))
        expect(view.status).toBe("rejected")
        expect(view.issues[0].actions).toEqual([program ? "repair" : "research"])
        expect(JSON.stringify(view)).not.toContain("PRIVATE_CAMPAIGN_LABEL")
        expect(input.permissionReadPaths.some((file: string) => file.endsWith("protocol.receipt.json"))).toBe(false)
      }
      if (adapted) {
        const advicePaths = input.permissionReadPaths.filter((file: string) => file.includes("/runtime-views/"))
        // 全文交付使用文本；权限不依赖建议正文中的 JSON。
        const advice = await Promise.all(advicePaths.map(async (file: string) => {
          const metadata = file.endsWith(".txt") ? file.slice(0, -4) + ".json" : file
          const view = JSON.parse(await readFile(metadata, "utf8"))
          if (file.endsWith(".txt")) {
            const body = await readFile(file, "utf8")
            expect(body.length).toBeGreaterThan(0)
            expect(body).not.toContain("PRIVATE_CAMPAIGN_LABEL")
          }
          return view
        }))
        expect(advice.some(item => item.kind === "analysis" && item.content.role === "task-sources")).toBe(true)
        expect(advice.every(item => item.advisoryOnly === true)).toBe(true)
        if (leads > 1) expect(advice.some(item => item.kind === "review")).toBe(true)
        expect(JSON.stringify(advice)).not.toContain("PRIVATE_CAMPAIGN_LABEL")
      }
      if (!adapted && execution && leads > 1) {
        expect(input.prompt).toContain("A product rejection means the generated answer failed")
        const productPath = input.permissionReadPaths.find((file: string) => file.endsWith("protocol.product.txt"))
        expect(productPath).toBeDefined()
        expect(input.prompt).toContain("protocol.product.txt")
        expect(await readFile(productPath, "utf8")).toBe("Incomplete rule")
      }
    }
    for (const edit of input.permissionEditPaths ?? []) {
      if (adapted) {
        const rejected = input.title.startsWith("Campaign Lead") && leads <= rejectedLeads
        await writeFile(edit, program ? bestPass && leads > 2
          ? "import time\ndef solve(x):\n    time.sleep(0.02)\n    return x*x\n"
          : `def solve(x): return ${rejected ? "x" : "x*x"}\n` : rejected ? "Incomplete rule" : "Reusable rule")
        continue
      }
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
    if (scenario.parallelWorkers && input.title.startsWith("Campaign Worker task-")) barriers.get(input.title.split(" ").at(-1)!)!.finished++
    return { title: input.title, prompt: input.prompt, selectedModel: input.model,
      referencedPaths: input.referencePaths ?? [], attachedFiles: [], promptInlineFiles: [],
      permissionReadPaths: input.permissionReadPaths ?? [], permissionEditPaths: input.permissionEditPaths ?? [],
      result: { exitCode: scenario.backendIncomplete && input.title.startsWith("Long Task Execute") ? 1 : 0,
        stdout: responseText, stderr: "", events: [], responseText, toolFailures: [] } }
  } }
  const project = { id: "campaign-fixture", version: "1", skillFormats: ["text"], productKinds: [program ? "json" : "text"], materialKinds: ["text"] }
  const python = "C:/Users/ZhuanZ/miniconda3/python.exe"
  const script = path.join(root, "check.py")
  await writeFile(script, 'import json,sys\np=json.load(open(sys.argv[1],encoding="utf-8-sig"))\ng=json.load(open(p["privateInputs"][0]["path"],encoding="utf-8-sig"))\nassert g["marker"]=="PRIVATE_CAMPAIGN_LABEL"\ns=open(p["candidate"][0]["path"],encoding="utf-8").read()\nprint(json.dumps({"status":"passed" if s=="Reusable rule" else "rejected","message":"fixture content gate"}))\n')
  if (program) await writeFile(script, 'import json,sys\np=json.load(open(sys.argv[1],encoding="utf-8-sig"))\ng=json.load(open(p["privateInputs"][0]["path"],encoding="utf-8-sig"))\ns=json.load(open(p["candidate"][0]["path"],encoding="utf-8-sig"))\nassert g["marker"]=="PRIVATE_CAMPAIGN_LABEL"\nprint(json.dumps({"status":"passed" if s["answers"]==g["expected"] and s["elapsed_ns"]>=0 else "rejected","message":"program correctness and measured timing"}))\n')
  if (fault && fault !== "execution_error") await writeFile(script, `import json\nprint(json.dumps({"status":${JSON.stringify(fault)},"message":"fixture failure"}))\n`)
  const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex")
  await writeFile(path.join(root, "public.txt"), program ? "[2,3,4]" : "Public rules")
  await writeFile(path.join(root, "system.txt"), "Independent public execution")
  const privateFile = path.join(root, "private", "gold.json")
  await mkdir(path.dirname(privateFile))
  await writeFile(privateFile, JSON.stringify({ marker: "PRIVATE_CAMPAIGN_LABEL", ...(program ? { expected: [4,9,16] } : {}) }))
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
  const programRunner = path.resolve(import.meta.dir, "fixtures/program-runner.py")
  const executor = program ? { id: "script-json-executor", version: "1", settings: {
    command: python, commandSHA256: await hash(python), script: programRunner, scriptSHA256: await hash(programRunner),
    timeoutMs: 10000, maxInputBytes: 65536, maxOutputBytes: 16384, executionBoundary: "trusted_host_runner",
  } } : server ? { id: "http-text-chat", version: "1", settings: { dialect: "openai_chat",
    url: server.url.origin + "/v1/chat/completions", allowedOrigins: [server.url.origin],
    model: "offline-consumer", expectedModel: "offline-consumer", credentialEnv, systemInput: "system", userInputs: ["public"],
    skillPlacement: "system", maxTokens: 100, maxInputBytes: 10000, maxResponseBytes: 4096, temperature: 0, timeoutMs: 2000 } } : undefined
  await writeFile(path.join(root, "selection.json"), JSON.stringify({ schema: "aev.protocol-plugins.v1", project,
    run: { skillFormat: "text", productKind: program ? "json" : "text", materialKinds: ["text"] }, protocol: { id: "fixture", version: "1",
      phases: { source: { claim: hasExecution ? "task_execution" : "skill_check", executor,
        ...(adapted && program ? { executionInputs: { skill: ["rules"], materials: ["public"] } } : {}),
        checks: [{ id: "script-json-checker", version: "1", name: "content",
        ...(adapted ? { skillInputs: ["rules"], materialInputs: [] } : {}),
        target: hasExecution ? "product" : "skill", stage: hasExecution ? "after_execution" : "before_execution", required: true, mechanism: "script", privateInputs: ["gold"], settings: {
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
  if (adapted) {
    await writeFile(path.join(root, "candidate-seed.txt"), program ? "def solve(x): return x\n" : "Initial report")
    const resources = [
      { id: "rules", path: "candidate-seed.txt", audience: "public", mutable: true },
      { id: "public", path: "public.txt", audience: "public", mutable: false },
      { id: "gold", path: "private/gold.json", audience: "private", mutable: false },
    ]
    const windows = ["planner", "executor", "worker", "lead", "reviewer", "diagnostician"].map(role => ({ role,
      stage: role === "lead" || role === "diagnostician" ? "revise" : role === "reviewer" ? "accept" : "explore",
      reads: ["rules", "public"], writes: role === "lead" || role === "executor" ? ["rules"] : [], inline: [],
      runtime: role === "lead" ? ["feedback", "analysis", "review"] : ["feedback"],
      actions: role === "lead" || role === "executor" ? ["read", "edit"] : ["read"] }))
    windows.push({ role: "checker", stage: "accept", reads: ["rules", "gold"], writes: [], inline: [], actions: ["read"], runtime: [] })
    if (program) windows.push({ role: "independent", stage: "accept", reads: ["rules", "public"], writes: [], inline: [], actions: ["read"], runtime: [] })
    await writeFile(path.join(root, "task-plan.json"), JSON.stringify({ schema: "aev.task-plan.v1", id: program ? "program" : "report", objective: program ? "Implement square function and measure runtime" : "Write an evidence-supported report",
      deliverable: { kind: program ? "software" : "report", entries: ["rules"] }, resources, windows, capabilities: ["file-read", "file-edit"],
      workers: workers.map(id => ({ id, purpose: `Inspect ${id} evidence; analysis only`, resources: ["rules", "public"], actions: ["read"] })),
      acceptance: { execution: program ? "script" : "none", checks: [{ id: "content", target: program ? "product" : "candidate", mechanism: "script", purpose: program ? "Check program outputs and timing" : "Check report", required: true, resources: ["rules", "gold"], feedback: "status_only" }] },
      rejection: [{ check: "content", actions: [program ? "repair" : "research"] }],
      selection: bestPass ? { rule: "best_pass", metric: "elapsed_ns", direction: "min" } : { rule: "first_pass" },
      stop: { rounds: bestPass ? 3 : rejectedLeads === 2 ? 2 : 1, calls: 40, tokens: 100000, stagnant: 1 } }))
    const spec = JSON.parse(await readFile(specPath, "utf8"))
    if (bootstrap) delete spec.initialGraph
    spec.taskAdaptation = { schema: "aev.task-adaptation.v1", planPath: path.join(root, "task-plan.json"), root,
      capabilities: ["file-read", "file-edit"], entries: [{ id: "rules", path: "rules.txt" }] }
    if (budget) {
      const plan = JSON.parse(await readFile(spec.taskAdaptation.planPath, "utf8"))
      plan.stop.calls = budget === "qualified" ? 10 : budget === "fault" ? 4 : budget === "unrelated" ? 100 : 1
      fixtureBudget = { root: path.join(path.dirname(root), `budget-${randomUUID()}`), scope: "campaign-budget", calls: plan.stop.calls, tokens: plan.stop.tokens }
      spec.taskAdaptation.requestBudget = { schema: "aev.task-budget-policy.v1", root: fixtureBudget.root, scope: fixtureBudget.scope,
        models: [{ model: "fixture/budget", dialect: "openai_chat", expectedModels: ["budget"], maxInputTokens: 1000, maxOutputTokens: 100 }] }
      for (const role of ["planning", "execution", "validation"]) spec[role] = { model: "fixture/budget" }
      await writeFile(spec.taskAdaptation.planPath, JSON.stringify(plan))
      if (budget === "pre") {
        await reserveRequest(fixtureBudget, { id: "intake", request: "a".repeat(64), role: "intake", model: "fixture/budget", reservationTokens: 1100 })
        await settleRequest(fixtureBudget, "intake", 10)
      }
    }
    if (intake) {
      const initial = JSON.parse(await readFile(spec.taskAdaptation.planPath, "utf8"))
      const catalogue: TaskCatalogue = { id: initial.id, request: initial.objective, resources: initial.resources,
        entries: ["rules"], maxWorkers: Math.max(2, workers.length), stop: initial.stop,
        capabilities: [{ id: "file-read", version: "1", description: "Read declared files", actions: ["read"], available: true },
          { id: "file-edit", version: "1", description: "Edit declared candidate", actions: ["edit"], available: true }],
        profiles: [{ id: "task-content", description: "Check declared task content", kinds: [initial.deliverable.kind], requires: ["file-read", "file-edit"],
          acceptance: initial.acceptance, rejection: initial.rejection, selection: initial.selection }] }
      let interpretations = 0
      const input = { cwd: root, root, dir: `${root}-intake`, catalogue, model: "fixture/intake", expectedModel: "fixture/intake",
        timeoutMs: 2000, maxInputBytes: 100000, maxDecisionBytes: 16000 }
      const dependencies = { createDriver: async () => ({ implementation: "a".repeat(64), preflight: async () => {},
        invoke: async (request: { prompt: string; editPaths: string[]; readPaths: string[] }) => {
          interpretations++
          expect(request.prompt).not.toContain("PRIVATE_CAMPAIGN_LABEL")
          expect(request.readPaths).not.toContain(privateFile)
          await writeFile(request.editPaths[0], JSON.stringify({ kind: initial.deliverable.kind, profiles: ["task-content"], needs: [],
            workers: initial.workers, rationale: "Report task uses declared source inspection and content checks" }))
          return { completed: true, actualModel: "fixture/intake" }
        } }) }
      const prepared = await prepareTask(input, dependencies)
      if (prepared.status !== "ready") throw new Error("Offline intake did not produce a ready plan")
      spec.taskAdaptation.planPath = prepared.planPath
      expect((await prepareTask(input, dependencies)).reused).toBe(true)
      expect(interpretations).toBe(1)
    }
    await writeFile(specPath, JSON.stringify(spec))
  }
  const campaign = path.join(root, "campaign.json")
  const seedRoot = path.join(root, "initial-candidate")
  if (seeded) {
    await mkdir(seedRoot)
    await writeFile(path.join(seedRoot, "rules.txt"), "Seeded reusable rule")
    if (partialLead) await writeFile(path.join(seedRoot, "notes.txt"), "Seeded note")
  }
  await writeFile(campaign, JSON.stringify({ title: "Offline Campaign", baseSpecPath: specPath, mode: "graph_iterative", maxRounds: bestPass ? 3 : rejectedLeads === 2 ? 2 : 1,
    seedTargets: seeded ? [{ seedPath: seedRoot, targetPath: path.join(root, "author-workspace"), kind: "experience_workspace", resetOnStart: true }] : [] }))
  const previous = process.env.AUTO_EVOLVE_SKIP_STALE_HEAL
  process.env.AUTO_EVOLVE_SKIP_STALE_HEAL = "1"
  try {
    const preparedSpec = budget ? JSON.parse(await readFile(specPath, "utf8")) : undefined
    const unifiedInput = budget ? { intake: { cwd: root }, execution: {
      dir: `${root}-unified`, requestBudget: preparedSpec.taskAdaptation.requestBudget } } : undefined
    const unifiedDependencies = budget ? { prepare: async () => ({ status: "ready", specPath,
      planPath: preparedSpec.taskAdaptation.planPath, selectionPath: preparedSpec.protocolPlugins.selectionPath,
      projectManifestPath: preparedSpec.protocolPlugins.projectManifestPath, reused: true }),
      controller: async () => actual } : undefined
    let registered = false
    let result = budget ? await actual.runTask(unifiedInput, unifiedDependencies)
      : await actual.runLongTaskCampaign({ cwd: root, specPath: campaign, forceNew: true, onCreated: async (created: any) => {
        expect(calls).toHaveLength(0)
        const state = JSON.parse(await readFile(path.join(created.campaignDir, "campaign.json"), "utf8"))
        expect(state.id).toBe(created.campaignID)
        expect(state.status).toBe("bootstrapping")
        registered = true
      } })
    if (!budget) expect(registered).toBe(true)
    if (scenario.backendIncomplete) {
      expect(result.status).toBe("failed")
      expect(calls.filter(title => title.startsWith("Long Task Execute"))).toHaveLength(1)
      expect(calls.some(title => title.startsWith("Campaign Worker") || title.startsWith("Campaign Lead") || title.includes("Replan"))).toBe(false)
      const runDirs = await readdir(path.join(root, "auto-evolve/runtime-state/long-task/runs"))
      expect(runDirs).toHaveLength(1)
      const summary = JSON.parse(await readFile(path.join(root, "auto-evolve/runtime-state/long-task/runs", runDirs[0], "summary.json"), "utf8"))
      expect(summary.status).toBe("blocked_failure")
      expect(summary.summary).toContain("Protocol training executor incomplete")
      return
    }
    if (budget) {
      await writeFile(path.join(root, "budget-observed.json"), JSON.stringify({ result, calls, ledger: await inspectBudget(fixtureBudget!) }, null, 2))
      if (budget === "fault") {
        expect(calls).toHaveLength(4)
        expect((await inspectBudget(fixtureBudget!)).denial).toBeUndefined()
        expect(result.status).toBe("failed")
        expect(result.taskStopReason).not.toBe("request_call_budget")
        return
      }
      if (budget === "unrelated") {
        expect(result.status).toBe("failed")
        expect(result.taskStopReason).toBe("platform_failure")
        expect((await inspectBudget(fixtureBudget!)).denial).toBeUndefined()
        const saved = JSON.parse(await readFile(result.selectedTaskVersionPath, "utf8"))
        expect(saved.round).toBe(1)
        expect(await readFile(path.join(path.dirname(result.selectedTaskVersionPath), saved.files[0].file), "utf8")).toContain("x*x")
        return
      }
      expect(result.taskStopReason).toBe(budget === "unknown" ? "request_usage_unresolved" : "request_call_budget")
      expect(result.status).toBe(budget === "unknown" ? "failed" : budget === "qualified" ? "verified_success" : "round_limit_reached")
      expect(calls).toHaveLength(budget === "pre" ? 0 : budget === "qualified" ? 10 : 1)
      if (budget === "qualified") {
        const saved = JSON.parse(await readFile(result.selectedTaskVersionPath, "utf8"))
        expect(saved.round).toBe(1)
        expect(await readFile(path.join(path.dirname(result.selectedTaskVersionPath), saved.files[0].file), "utf8")).toContain("x*x")
      } else expect(result.selectedTaskVersionPath).toBeUndefined()
      const resumed = await actual.runTask(unifiedInput, unifiedDependencies)
      expect(resumed.status).toBe(result.status)
      expect(resumed.taskStopReason).toBe(result.taskStopReason)
      expect(calls).toHaveLength(budget === "pre" ? 0 : budget === "qualified" ? 10 : 1)
      if (budget === "qualified") {
        expect(result.delivery).toBeDefined()
        expect(resumed.delivery.reused).toBe(true)
        // 旧布局可复用，但损坏旧交付不能被新目录掩盖。
        const legacy = path.join(unifiedInput.execution.dir, "task-run/delivery")
        await cp(path.dirname(result.delivery.path), legacy, { recursive: true })
        const compatible = await actual.runTask(unifiedInput, unifiedDependencies)
        expect(compatible.delivery.path).toBe(path.join(legacy, "delivery.json"))
        expect(compatible.delivery.reused).toBe(true)
        expect(calls).toHaveLength(10)
        const manifest = await readFile(path.join(legacy, "delivery.json"), "utf8")
        await writeFile(path.join(legacy, "delivery.json"), "null")
        await expect(actual.runTask(unifiedInput, unifiedDependencies)).rejects.toThrow()
        expect(calls).toHaveLength(10)
        await writeFile(path.join(legacy, "delivery.json"), manifest)
        const saved = JSON.parse(await readFile(result.selectedTaskVersionPath, "utf8"))
        const file = path.join(path.dirname(result.selectedTaskVersionPath), saved.files[0].file)
        await writeFile(file, "tampered delivery")
        await expect(actual.resumeLongTaskCampaign({ cwd: root, campaignID: result.campaignID, specPath: campaign })).rejects.toThrow("Saved task version bytes drift")
      }
      return
    }
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
    if (bootstrap) expect(calls.some(title => title.startsWith("Long Task Graph"))).toBe(true)
    if (adapted) expect(calls.filter(title => title.startsWith("Campaign Worker task-")).sort()).toEqual(
      ["round-001", ...(rejectedLeads === 2 || bestPass ? ["round-002"] : [])].flatMap(round => workers.map(id => `Campaign Worker task-${id} ${round}`)).sort())
    for (const request of roleRequests) {
      if (!adapted && (request.title.startsWith("Long Task Graph") || request.title.startsWith("Long Task Execute"))) {
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
      if (adapted) {
        expect(request.prompt).toContain(program ? "AEV software task" : "AEV report task")
        expect(request.prompt).not.toContain("Public material suffix excerpts")
        expect(request.prompt).not.toContain("reusable guidance")
        continue
      }
      expect(request.prompt).toContain("Public material suffix excerpts")
      expect(request.prompt).toContain("Independent public execution")
      for (const file of ["public.txt", "system.txt"]) {
        const material = path.join(root, file).replaceAll("\\", "/")
        expect(request.reads.map(file => file.replaceAll("\\", "/"))).toContain(material)
        expect(request.prompt).toContain(material)
      }
      expect(request.reads.some((file) => file.endsWith("protocol.receipt.json"))).toBe(false)
      expect(request.prompt).not.toContain("protocol.receipt.json")
      expect(request.reads.some((file) => file.endsWith("expert-oracle-bundle.json"))).toBe(false)
    }
    expect(leads).toBe(rejectedLeads + (bestPass ? 2 : 1))
    if (rejectedLeads && !fault && !adapted) {
      const tickets = JSON.parse(await readFile(path.join(result.campaignDir, "dispatch-tickets.json"), "utf8"))
      expect(tickets.tickets.some((ticket: { key: string }) => ticket.key === `skill:${execution ? "product" : "skill"}:content`)).toBe(true)
      expect(tickets.tickets.some((ticket: { title: string }) => ticket.title.startsWith("Repair validator"))).toBe(false)
      const laterLeads = roleRequests.filter(item => item.title.startsWith("Campaign Lead")).slice(1)
      expect(laterLeads.every(item => item.prompt.includes("Host alone"))).toBe(true)
    }
    expect(result.roundsCompleted).toBe(rejectedLeads === 2 || bestPass ? 2 : 1)
    if (rejectedLeads === 2) expect(calls.some((title) => title.startsWith("Long Task Graph"))).toBe(true)
    const roundsRoot = path.join(result.campaignDir, "rounds")
    const receipts = (await readdir(roundsRoot, { recursive: true })).filter((file) => file.endsWith("protocol.receipt.json")).sort()
    expect(receipts).toHaveLength(rejectedLeads + (bestPass ? 2 : 1))
    const values = await Promise.all(receipts.map(async (file) => JSON.parse(await readFile(path.join(roundsRoot, file), "utf8"))))
    expect(values.map((value) => value.status)).toEqual(fault ? [fault] : [...Array(rejectedLeads).fill("rejected"), "passed", ...(bestPass ? ["passed"] : [])])
    expect(new Set(values.map((value) => value.protocolFingerprint)).size).toBe(1)
    expect(values.every((value) => value.claim === (hasExecution ? "task_execution" : "skill_check") &&
      value.executed === Boolean(hasExecution && fault !== "execution_error"))).toBe(true)
    if (program) {
      expect(values.every(value => value.product.kind === "json")).toBe(true)
      const answers = await Promise.all(receipts.map(async file => {
        const product = JSON.parse(await readFile(path.join(roundsRoot, path.dirname(file), "protocol.product.bin"), "utf8"))
        expect(product.elapsed_ns).toBeGreaterThanOrEqual(0)
        expect(product.input_keys).not.toContain("privateInputs")
        return product.answers
      }))
      expect(answers).toEqual([[2,3,4], [4,9,16], ...(bestPass ? [[4,9,16]] : [])])
      if (bestPass) {
        expect(result.taskStopReason).toBe("stagnant")
        const selected = JSON.parse(await readFile(result.selectedTaskVersionPath, "utf8"))
        expect(selected.round).toBe(1)
        const bestBytes = await readFile(path.join(path.dirname(result.selectedTaskVersionPath), selected.files[0].file), "utf8")
        expect(bestBytes).not.toContain("time.sleep")
        expect(await readFile(path.join(result.campaignDir, "pending-expert-package/current/rules.txt"), "utf8")).toContain("time.sleep")
      }
    }
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
      if (adapted) {
        expect(result.selectedTaskVersionPath).toBeDefined()
        const deliverySpec = (await loadLongTaskSpec(specPath)).spec
        deliverySpec.taskAdaptationContext = await restoreTaskContext(deliverySpec, JSON.parse(await readFile(
          path.join(result.campaignDir, "task-adaptation/task-plan.snapshot.json"), "utf8")))
        const deliveryInput = { root: result.campaignDir, selectedTaskVersionPath: result.selectedTaskVersionPath,
          dir: `${root}-delivery` }
        const delivery = await exportTaskDelivery(deliverySpec, deliveryInput)
        expect(delivery.reused).toBe(false)
        expect((await exportTaskDelivery(deliverySpec, deliveryInput)).reused).toBe(true)
        const manifest = JSON.parse(await readFile(delivery.path, "utf8"))
        expect(manifest.files.map((item: any) => item.id)).toEqual(["rules"])
        const deliveredFile = path.join(deliveryInput.dir, manifest.files[0].path)
        const deliveredBytes = await readFile(deliveredFile)
        expect(deliveredBytes.toString()).not.toContain("PRIVATE_CAMPAIGN_LABEL")
        if (bestPass) expect(deliveredBytes.toString()).not.toContain("time.sleep")
        await writeFile(deliveredFile, "tampered delivery")
        await expect(exportTaskDelivery(deliverySpec, deliveryInput)).rejects.toThrow("Delivered file drift")
        await writeFile(deliveredFile, deliveredBytes)
        const unexpected = path.join(deliveryInput.dir, "private-copy.txt")
        await writeFile(unexpected, "unexpected file")
        await expect(exportTaskDelivery(deliverySpec, deliveryInput)).rejects.toThrow("Unexpected delivery files")
        await rm(unexpected)
        await expect(exportTaskDelivery(deliverySpec, { ...deliveryInput, dir: result.campaignDir }))
          .rejects.toThrow("separate from task evidence")
        const incomplete = `${root}-incomplete-delivery`
        await mkdir(incomplete)
        await expect(exportTaskDelivery(deliverySpec, { ...deliveryInput, dir: incomplete })).rejects.toThrow()
        expect(await readdir(incomplete)).toEqual([])
        await expect(exportTaskDelivery(deliverySpec, { ...deliveryInput, selectedTaskVersionPath: specPath }))
          .rejects.toThrow("verified task version")
        const version = JSON.parse(await readFile(result.selectedTaskVersionPath, "utf8"))
        const versionFile = path.join(path.dirname(result.selectedTaskVersionPath), version.files[0].file)
        const versionBytes = await readFile(versionFile)
        await writeFile(versionFile, "corrupted frozen delivery")
        try { await expect(actual.resumeLongTaskCampaign({ cwd: root, campaignID: result.campaignID, specPath: campaign }))
          .rejects.toThrow("Saved task version bytes drift") }
        finally { await writeFile(versionFile, versionBytes) }
        const bound = JSON.parse(await readFile(path.join(result.campaignDir, "task-adaptation/task-plan.snapshot.json"), "utf8")) as BoundPlan
        const reference = { root: result.campaignDir, path: accepted.protocolTrainingResultPath, task: "source-1", phase: "source" as const }
        const receipt = JSON.parse(await readFile(accepted.protocolReceiptPath, "utf8"))
        reference.task = receipt.task
        const published = await taskFeedback(bound, reference)
        expect(published.view.status).toBe("passed")
        expect(published.view.issues.every(issue => issue.actions.length === 0)).toBe(true)
        expect(JSON.stringify(published.view)).not.toContain("PRIVATE_CAMPAIGN_LABEL")
        expect(JSON.stringify(published.view)).not.toContain("fixture content gate")
        await expect(taskFeedback(bound, { ...reference, task: "other-task" })).rejects.toThrow("receipt or protocol drift")
        await expect(taskFeedback(bound, { ...reference, phase: "test" })).rejects.toThrow("receipt or protocol drift")
        const original = await readFile(accepted.protocolTrainingResultPath)
        await writeFile(accepted.protocolTrainingResultPath, JSON.stringify({ ...JSON.parse(original.toString()), passed: false }))
        try { await expect(taskFeedback(bound, reference)).rejects.toThrow("verdict identity") }
        finally { await writeFile(accepted.protocolTrainingResultPath, original) }
        const originalView = await readFile(published.path)
        await writeFile(published.path, JSON.stringify({ ...published.view, status: "rejected" }))
        try { await expect(taskFeedback(bound, reference)).rejects.toThrow("Published task feedback drift") }
        finally { await writeFile(published.path, originalView) }
      }
      if (execution || program) {
        const productFile = path.join(path.dirname(accepted.protocolReceiptPath), program ? "protocol.product.bin" : "protocol.product.txt")
        const productBytes = await readFile(productFile)
        if (program) expect(JSON.parse(productBytes.toString()).answers).toEqual([4,9,16])
        else expect(productBytes.toString()).toBe("Reusable rule")
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
