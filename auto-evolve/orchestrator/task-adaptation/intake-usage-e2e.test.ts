import { expect, test } from "bun:test"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { prepareTask } from "./intake"
import { catalogue, decision } from "./intake-fixture"
import { opencodeDriver } from "../protocol-plugins/opencode-driver"
import { DEFAULT_CONFIG } from "../schema"
import { inspectRequestUsage } from "./request-budget"
import type { BudgetTransportConfig } from "./budget-transport"

type Body = { model: string; stream?: boolean; messages: Array<{ role: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> }
const evidence = "E:/project/AEV-task-adaptation-20261016/test-evidence/S2-metric-usage-20261020"

// 复用source-host夹具的SSE协议，实际driver、SDK与工具不替换。
for (const failure of [false, true]) test(`intake actual source SDK tool loop usage ${failure ? "failed unknown" : "complete and reused"}`, async () => {
  const cwd = path.resolve(import.meta.dir, "../../..")
  const root = path.join(evidence, `intake-${failure ? "failure" : "success"}-${randomUUID()}`)
  const materials = path.join(root, "materials"), profile = path.join(root, "profile"), dir = path.join(root, "intake")
  await mkdir(materials, { recursive: true })
  await mkdir(profile)
  for (const name of ["candidate.txt", "source.txt", "private.txt"]) await writeFile(path.join(materials, name), name === "private.txt" ? "PRIVATE_NOT_FOR_INTAKE" : "Synthetic public evidence")
  const output = path.join(dir, "workspace", "decision.json")
  const requests: Array<{ model: string; tools: string[]; toolReplies: number; status: number }> = []
  const errors: string[] = []
  const secret = "synthetic-local-only-usage-e2e"
  function reply(body: Body, action?: { name: string; args: object }) {
    const id = randomUUID(), index = requests.length
    const tools = action ? [{ index: 0, id: `call_${randomUUID()}`, type: "function", function: { name: action.name, arguments: JSON.stringify(action.args) } }] : []
    const usage = { prompt_tokens: index * 10, completion_tokens: index * 2,
      prompt_tokens_details: { cached_tokens: index }, completion_tokens_details: { reasoning_tokens: index } }
    const finish = action ? "tool_calls" : "stop"
    if (!body.stream) return Response.json({ id, model: body.model, choices: [{ index: 0, finish_reason: finish,
      message: { role: "assistant", content: action ? null : "Decision written", ...(action ? { tool_calls: tools } : {}) } }], usage })
    const frames = [{ id, model: body.model, object: "chat.completion.chunk", created: 0,
      choices: [{ index: 0, delta: { role: "assistant", ...(action ? { tool_calls: tools } : { content: "Decision written" }) }, finish_reason: null }] },
    { id, model: body.model, object: "chat.completion.chunk", created: 0, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { id, model: body.model, object: "chat.completion.chunk", created: 0, choices: [], usage }]
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    try {
      const body = await req.json() as Body
      if (body.model !== "actor" || JSON.stringify(body.messages).includes("PRIVATE_NOT_FOR_INTAKE")) throw new Error("Offline model or permission boundary mismatch")
      const tools = body.tools?.map(tool => tool.function?.name ?? "") ?? []
      const toolReplies = body.messages.filter(message => message.role === "tool").length
      const status = failure && toolReplies >= 2 ? 500 : 200
      requests.push({ model: body.model, tools, toolReplies, status })
      if (status === 500) return Response.json({ error: { message: "Synthetic failure without usage" } }, { status })
      if (!toolReplies) return reply(body, { name: "read", args: { filePath: output } })
      if (toolReplies === 1) return reply(body, { name: "write", args: { filePath: output, content: JSON.stringify(decision()) } })
      return reply(body)
    } catch {
      errors.push("Offline fixture request rejected")
      return Response.json({ error: { message: errors.at(-1) } }, { status: 400 })
    }
  } })
  const saved = { ...process.env }
  try {
    // 禁离线夹具下载语言服务器，避免工具后处理引入外网依赖。
    await writeFile(path.join(profile, "opencode.json"), JSON.stringify({ lsp: false, formatter: false, provider: { fixture: {
      npm: "@ai-sdk/openai-compatible", name: "Offline usage fixture", options: { baseURL: `${server.url}v1`, apiKey: secret },
      models: { actor: { id: "actor", name: "actor", tool_call: true, reasoning: false,
        limit: { context: 131072, output: 4096 }, modalities: { input: ["text"], output: ["text"] } } } } } }))
    Object.assign(process.env, { AUTO_EVOLVE_OPENCODE_PRIVATE_PROFILE_ROOT: profile,
      AUTO_EVOLVE_RUNTIME_ROOT: path.join(root, "runtime"), AUTO_EVOLVE_SKIP_STALE_HEAL: "1",
      AUTO_EVOLVE_OPENCODE_CLEAN_RUNTIME: "false", OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true" })
    const config = structuredClone(DEFAULT_CONFIG)
    config.monitorConfig.enabled = false
    config.monitorConfig.autoStart = false
    const transport: BudgetTransportConfig = { schema: "aev.budget-transport.v1", budget: {
      root: path.join(root, "wallet"), scope: "intake-sdk", calls: 10, tokens: 2000000 }, role: "intake",
      dialect: "openai_chat", expectedModels: ["actor"], maxInputTokens: 131072, maxOutputTokens: 4096 }
    const input = { cwd, root: materials, dir, catalogue: catalogue(), model: "fixture/actor", expectedModel: "fixture/actor",
      timeoutMs: 120000, maxInputBytes: 100000, maxDecisionBytes: 16000, requestBudget: transport }
    const dependencies = { createDriver: (options: { cwd: string; evidenceRoot: string }) => opencodeDriver({ ...options, load: async () => structuredClone(config) }) }
    if (failure) await expect(prepareTask(input, dependencies)).rejects.toThrow()
    else {
      expect((await prepareTask(input, dependencies)).status).toBe("ready")
      const before = requests.length
      expect((await prepareTask(input, dependencies)).reused).toBe(true)
      expect(requests.length).toBe(before)
    }
    const report = await inspectRequestUsage(transport.budget)
    await writeFile(path.join(root, "usage-summary.json"), JSON.stringify(report, null, 2))
    await writeFile(path.join(root, "http-observations.json"), JSON.stringify({ requests, errors, externalModelCalls: 0 }, null, 2))
    expect(errors).toEqual([])
    expect(requests).toHaveLength(3)
    expect(requests.map(row => row.toolReplies)).toEqual([0, 1, 2])
    expect(report.admittedAttempts).toBe(requests.length)
    expect(report.attempts.every(row => row.role === "intake" && row.model === "actor")).toBe(true)
    expect(report.attempts[0].usage).toMatchObject({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, reasoningTokens: 1 })
    expect(report.attempts[1].usage).toMatchObject({ inputTokens: 20, outputTokens: 4, cacheReadTokens: 2, reasoningTokens: 2 })
    expect(report.reportedTokens).toBe(failure ? 36 : 72)
    expect(report.unknownAttempts).toBe(failure ? 1 : 0)
    expect(report.outstandingTokens).toBe(failure ? 135168 : 0)
    expect(report.groups).toHaveLength(1)
    expect(await readFile(path.join(transport.budget.root, "budget.json"), "utf8")).not.toContain(secret)
    expect(JSON.stringify(report)).not.toContain(secret)
    console.log(`Intake SDK usage evidence: ${root}`)
  } finally {
    await server.stop(true)
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
}, 240000)
