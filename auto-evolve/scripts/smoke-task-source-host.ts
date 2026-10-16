import path from "node:path"
import { mkdir, open, readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { runOpencodeTask } from "../orchestrator/opencode"
import { DEFAULT_CONFIG } from "../orchestrator/schema"
import { writeJsonAtomic, writeFileAtomic } from "../orchestrator/atomic-write"
import { bindLocalSearch } from "../orchestrator/task-adaptation/local-search"
import { inspectBudget } from "../orchestrator/task-adaptation/request-budget"

const args = process.argv.slice(2)
const cwd = args[args.indexOf("--cwd") + 1]
const out = args[args.indexOf("--out") + 1]
const denyProbe = args.includes("--deny-probe")
const budgetStopProbe = args.includes("--budget-stop-probe")
if (!args.includes("--cwd") || !args.includes("--out") || !path.isAbsolute(cwd ?? "") || !path.isAbsolute(out ?? "") ||
  denyProbe && budgetStopProbe || args.length !== (denyProbe || budgetStopProbe ? 5 : 4)) {
  throw new Error("Usage: bun run smoke-task-source-host.ts --cwd <absolute-worktree> --out <absolute-evidence-directory> [--deny-probe | --budget-stop-probe]")
}
const root = path.join(out, `attempt-${randomUUID()}`)
const workspace = path.join(root, "workspace")
const profile = path.join(root, "private-profile")
await mkdir(workspace, { recursive: true })
await mkdir(profile)
const claim = await open(path.join(root, "started.claim"), "wx")
await claim.close()
const source = path.join(workspace, "source.txt").replaceAll("\\", "/")
const answer = path.join(workspace, "answer.txt").replaceAll("\\", "/")
await writeFileAtomic(source, "The fixture operands are 6 and 7. FIXTURE_SOURCE_ONLY\n")
const forbidden = path.join(workspace, "forbidden.txt").replaceAll("\\", "/")
await writeFileAtomic(forbidden, "AEV_FORBIDDEN_SOURCE_MUST_NEVER_BE_READ\n")
const seen: Array<{ route: string; body: Record<string, any> }> = []
let stage = 0
let fixtureError: string | undefined
let deniedRequestSent = false
let denialObserved = false
function complete(body: any, name?: string, parameters?: unknown) {
  const id = `fixture-${seen.length}`
  const tool = name ? { index: 0, id: `call-${id}`, type: "function", function: { name, arguments: JSON.stringify(parameters) } } : undefined
  const content = name ? null : "AEV_SOURCE_HOST_FIXTURE_DONE"
  if (!body.stream) return Response.json({ id, object: "chat.completion", created: 0, model: "test-model",
    choices: [{ index: 0, message: { role: "assistant", content, ...(tool ? { tool_calls: [tool] } : {}) },
      finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })
  const chunk = (delta: unknown, finish: string | null = null) => ({ id, object: "chat.completion.chunk", created: 0,
    model: "test-model", choices: [{ index: 0, delta, finish_reason: finish }] })
  const frames = [chunk({ role: "assistant", ...(tool ? { tool_calls: [tool] } : { content }) }),
    chunk({}, tool ? "tool_calls" : "stop"), { id, object: "chat.completion.chunk", created: 0, model: "test-model",
      choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } }]
  return new Response(frames.map(item => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  try {
    const route = new URL(request.url).pathname
    const body = await request.json() as Record<string, any>
    seen.push({ route, body })
    if (route !== "/v1/chat/completions" || seen.length > 12 || body.model !== "test-model") throw new Error("Unexpected fixture route/model/request count")
    const tools = (body.tools ?? []).map((item: any) => item.function?.name)
    if (!tools.length) return complete(body)
    const transcript = JSON.stringify(body.messages)
    // 实际触发一次越权，再验证错误返回且正文未泄露。
    if (denyProbe && !deniedRequestSent) {
      deniedRequestSent = true
      return complete(body, "read", { filePath: forbidden })
    }
    if (denyProbe && stage === 0) {
      const last = [...body.messages].reverse().find((message: any) => message.role === "tool")
      const failure = JSON.stringify(last?.content ?? "")
      if (!/reject|denied|permission/i.test(failure) || transcript.includes("AEV_FORBIDDEN_SOURCE_MUST_NEVER_BE_READ")) {
        throw new Error("Actual source-host file permission rejection was not established")
      }
      denialObserved = true
    }
    const select = (name: string, parameters: unknown) => {
      if (!tools.includes(name)) throw new Error(`Fixture tool not advertised: ${name}`)
      stage++
      return complete(body, name, parameters)
    }
    switch (stage) {
      case 0: return select("read", { filePath: source })
      case 1:
        if (!transcript.includes("FIXTURE_SOURCE_ONLY")) throw new Error("Read tool did not return actual source")
        return select("aev_local_search", { query: "FIXTURE_SOURCE_ONLY", resources: ["source"] })
      case 2:
        if (!transcript.includes("declared_local_text")) throw new Error("Local source search result missing")
        return select("aev_recompute", { expression: { op: "mul", args: [6, 7] } })
      case 3:
        if (!transcript.includes("model_arguments_not_source_verified")) throw new Error("Arithmetic result missing")
        return select("write", { filePath: answer, content: "42\n" })
      case 4:
        stage++
        return complete(body)
      default: throw new Error("Unexpected extra tool-enabled request")
    }
  } catch (error) {
    fixtureError = error instanceof Error ? error.message : "fixture_error"
    return Response.json({ error: { message: fixtureError } }, { status: 400 })
  }
} })
const saved = { ...process.env }
const budget = { root: path.join(root, "budget"), scope: "source-host-fixture", calls: budgetStopProbe ? 2 : 12, tokens: 300000 }
try {
  await writeJsonAtomic(path.join(profile, "opencode.json"), {
    provider: { "aev-fixture": { npm: "@ai-sdk/openai-compatible", name: "Local deterministic fixture only",
      options: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "local-fixture-no-real-credential" },
      models: { "test-model": { id: "test-model", name: "test-model", tool_call: true, reasoning: false,
        limit: { context: 32768, output: 4096 }, modalities: { input: ["text"], output: ["text"] } } } } },
  })
  // 只用本地假服务与独立快照，不借宿主真实账号或插件。
  Object.assign(process.env, { AUTO_EVOLVE_OPENCODE_PRIVATE_PROFILE_ROOT: profile,
    AUTO_EVOLVE_RUNTIME_ROOT: path.join(root, "runtime"), AUTO_EVOLVE_OPENCODE_CLEAN_RUNTIME: "false",
    OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true" })
  const config = structuredClone(DEFAULT_CONFIG)
  config.permissionConfig.mode = "restricted"
  const localSearch = await bindLocalSearch("a".repeat(64), "executor", [{ id: "source", path: source, mutable: false }])
  const result = await runOpencodeTask({ cwd, workDir: workspace, config, model: "aev-fixture/test-model",
    title: "AEV source host deterministic tool smoke", prompt: "Read the permitted fixture source, search it, recompute the product, write the allowed answer, then finish. This is an offline deterministic SDK fixture, not an external-model experiment.",
    sourceHost: true, allowShell: false, isolateHostRuntime: true, infrastructureAttempts: 1,
    injectPlatformSafetyRules: false, recordAdaptiveConcurrency: false,
    referencePaths: [source], permissionReadPaths: [source], permissionEditPaths: [answer], permissionExternalPaths: [workspace],
    localSearch, localSearchEvidenceRoot: path.join(root, "search-evidence"),
    recompute: { schema: "aev.recompute.v1", task: "a".repeat(64), role: "executor" }, recomputeEvidenceRoot: path.join(root, "arithmetic-evidence"),
    requestBudget: { schema: "aev.budget-transport.v1", budget, role: "executor", dialect: "openai_chat",
      expectedModels: ["test-model"], maxInputTokens: 32768, maxOutputTokens: 4096 },
    runtimeBudget: { profile: "short", hardTimeoutMs: 90000, silentTimeoutMs: 60000, silentTimeoutAfterActivityMs: 60000 },
  })
  await writeJsonAtomic(path.join(root, "host-result.json"), result)
  await writeJsonAtomic(path.join(root, "requests.json"), seen)
  const usage = await inspectBudget(budget)
  const actual = await readFile(answer, "utf8").catch(() => "")
  const completed = result.result.exitCode === 0 && stage === 5 && actual.trim() === "42" && (!denyProbe || denialObserved)
  const stopped = result.result.exitCode !== 0 && stage === 2 && seen.length === 2 && actual === "" && usage.denial?.reason === "calls"
  const passed = !fixtureError && (budgetStopProbe ? stopped : completed) && usage.admittedAttempts === seen.length &&
    usage.unresolvedAttempts === 0 && usage.reportedTokens === seen.length * 105
  await writeJsonAtomic(path.join(root, "summary.json"), { passed, stage, fixtureError, answer: actual, usage,
    denyProbe, denialObserved, budgetStopProbe,
    requestCount: seen.length, externalModelCalls: 0, usageKind: "synthetic_fixture_usage", sourceHostExit: result.result.exitCode })
  if (!passed) throw new Error(`Source-host fixture did not pass; inspect ${root}`)
  console.log(`Source-host SDK/tool fixture passed: ${root}`)
} catch (error) {
  await writeJsonAtomic(path.join(root, "requests.json"), seen)
  await writeJsonAtomic(path.join(root, "failure.json"), { message: error instanceof Error ? error.message : "fixture_error", fixtureError, stage, externalModelCalls: 0 })
  console.error(`Source-host fixture evidence: ${root}`)
  throw error
} finally {
  server.stop(true)
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
}
