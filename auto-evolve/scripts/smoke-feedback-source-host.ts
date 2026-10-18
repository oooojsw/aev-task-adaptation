import path from "node:path"
import { mkdir, readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { runOpencodeTask } from "../orchestrator/opencode"
import { DEFAULT_CONFIG } from "../orchestrator/schema"
import { writeJsonAtomic } from "../orchestrator/atomic-write"
import { publishTrainingFeedbackResource } from "../orchestrator/task-adaptation/consolidation/feedback-publisher"
import type { ResourceReaderGrant } from "../orchestrator/task-adaptation/consolidation/scoped-reader"

const args = process.argv.slice(2)
if (args.length !== 4 || args[0] !== "--cwd" || args[2] !== "--out" || !path.isAbsolute(args[1]) || !path.isAbsolute(args[3])) {
  throw new Error("Usage: smoke-feedback-source-host.ts --cwd <repo> --out <evidence>")
}
const cwd = args[1]
const root = path.join(args[3], `attempt-${randomUUID()}`)
const profile = path.join(root, "profile")
await mkdir(profile, { recursive: true })
const published = await Promise.all(["alpha", "beta"].map(async id => {
  const dir = path.join(root, id)
  const result = await publishTrainingFeedbackResource({ targetDir: path.join(dir, "feedback"), campaignID: id, round: 1,
    cases: Array.from({ length: 50 }, (_, i) => ({ caseID: `case${i + 1}`, title: id,
      prompt: `Public synthetic question ${i + 1}`, materials: [], modelResponse: `${id}_PUBLIC_ANSWER_${i + 1}`, score: 1, passed: true })) })
  const workspace = path.join(dir, "workspace")
  await mkdir(workspace)
  const grant: ResourceReaderGrant = { sessionID: randomUUID().replaceAll("-", ""), principalID: `fixture:${id}`,
    role: id === "alpha" ? "lead" : "worker", stage: id === "alpha" ? "revise" : "explore",
    planFingerprint: "c".repeat(64), policyFingerprint: "d".repeat(64),
    ...(id === "beta" ? { workerID: "worker1" } : {}), campaignID: id, round: 1,
    resourceID: result.logicalResource.resourceID, version: result.manifest.version, manifestPath: result.manifestPath,
    manifestSHA256: result.manifest.manifestSHA256, casesDir: path.join(dir, "feedback", "cases"),
    allowedCaseIDs: result.manifest.cases.map(item => item.caseID), hmacSecret: randomUUID().replaceAll("-", "").repeat(2) }
  const oracle = path.join(dir, "private.txt").replaceAll("\\", "/")
  await Bun.write(oracle, `${id}_PRIVATE_ORACLE_FORBIDDEN`)
  return { id, dir, workspace, grant, oracle }
}))
type Message = { role: string; content?: unknown }
type Request = { model: string; stream?: boolean; messages: Message[]; tools?: Array<{ function?: { name?: string } }> }
const seen: Array<{ model: string; tool?: string; stage: number; returned?: unknown }> = []
const stages = new Map<string, number>()
const errors: string[] = []
function reply(body: Request, name?: string, parameters?: unknown) {
  const id = `fixture-${randomUUID()}`
  const tool = name ? { index: 0, id: `call-${id}`, type: "function", function: { name, arguments: JSON.stringify(parameters) } } : undefined
  const content = name ? null : "FIXTURE_DONE"
  if (!body.stream) return Response.json({ id, object: "chat.completion", created: 0, model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content, ...(tool ? { tool_calls: [tool] } : {}) }, finish_reason: tool ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })
  const frames = [{ id, object: "chat.completion.chunk", created: 0, model: body.model,
    choices: [{ index: 0, delta: { role: "assistant", ...(tool ? { tool_calls: [tool] } : { content }) }, finish_reason: null }] },
  { id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
  { id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } }]
  return new Response(frames.map(item => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  try {
    const body = await req.json() as Request
    const tools = (body.tools ?? []).map(item => item.function?.name)
    if (!tools.length) {
      if (body.model === "nogrant") stages.set(body.model, 1)
      return reply(body)
    }
    const item = published.find(item => item.id === body.model)
    const stage = stages.get(body.model) ?? 0
    const transcript = JSON.stringify(body.messages)
    const last = [...body.messages].reverse().find(item => item.role === "tool")?.content
    if (transcript.includes("PRIVATE_ORACLE_FORBIDDEN")) throw new Error("Private file leaked")
    if (!item) {
      if (body.model !== "nogrant" || tools.includes("aev_read_resource")) throw new Error("Reader inherited by ungranted child")
      stages.set(body.model, 1)
      return reply(body)
    }
    if (!tools.includes("aev_read_resource")) throw new Error("Real source host did not advertise reader")
    if (stage === 1 && !JSON.stringify(last).includes(`${item.id}_PUBLIC_ANSWER_1`)) throw new Error("Reader did not return actual case")
    if (stage === 2 && !/mismatch|denied|reject/i.test(JSON.stringify(last))) throw new Error("Cross-campaign read not rejected")
    if (stage >= 3 && stage <= 5 && !/denied|reject|permission|unavailable tool/i.test(JSON.stringify(last))) throw new Error("Restricted tool not rejected")
    if (stage === 6 && !JSON.stringify(last).includes(`${item.id}_PUBLIC_ANSWER_25`)) throw new Error("Case25 missing")
    if (stage === 7 && !JSON.stringify(last).includes(`${item.id}_PUBLIC_ANSWER_50`)) throw new Error("Case50 missing")
    const actions = [
      ["aev_read_resource", { resourceID: item.grant.resourceID, caseID: "case1" }],
      ["aev_read_resource", { resourceID: published.find(other => other.id !== item.id)!.grant.resourceID, caseID: "case1" }],
      ["read", { filePath: item.oracle }],
      ["bash", { command: "echo FORBIDDEN_SHELL", description: "Denied fixture shell" }],
      ["write", { filePath: item.grant.manifestPath, content: "FORBIDDEN_EDIT" }],
      ["aev_read_resource", { resourceID: item.grant.resourceID, caseID: "case25" }],
      ["aev_read_resource", { resourceID: item.grant.resourceID, caseID: "case50" }],
    ] as const
    const action = actions[stage]
    seen.push({ model: body.model, tool: action?.[0], stage, returned: last })
    stages.set(body.model, stage + 1)
    if (stage > actions.length) throw new Error("Unexpected repeated host request")
    return reply(body, action?.[0], action?.[1])
  } catch (err) {
    errors.push(err instanceof Error ? err.message : "fixture_failure")
    return Response.json({ error: { message: errors.at(-1) } }, { status: 400 })
  }
} })
const saved = { ...process.env }
try {
  await writeJsonAtomic(path.join(profile, "opencode.json"), { provider: { "feedback-fixture": {
    npm: "@ai-sdk/openai-compatible", name: "Offline feedback fixture", options: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "local-fixture-only" },
    models: Object.fromEntries(["alpha", "beta", "nogrant"].map(id => [id, { id, name: id, tool_call: true, reasoning: false,
      limit: { context: 32768, output: 4096 }, modalities: { input: ["text"], output: ["text"] } }])) } } })
  // 这里只设置本地假服务快照；Reader授权仍逐子进程传递。
  Object.assign(process.env, { AUTO_EVOLVE_OPENCODE_PRIVATE_PROFILE_ROOT: profile, AUTO_EVOLVE_RUNTIME_ROOT: path.join(root, "runtime"),
    AUTO_EVOLVE_OPENCODE_CLEAN_RUNTIME: "false", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true" })
  const config = structuredClone(DEFAULT_CONFIG)
  config.permissionConfig.mode = "restricted"
  const run = (id: string, item?: typeof published[number]) => runOpencodeTask({ cwd, workDir: item?.workspace ?? root,
    config, model: `feedback-fixture/${id}`, title: `Offline restricted feedback ${id}`, prompt: "Execute the deterministic fixture tool calls, then finish.",
    sourceHost: true, allowShell: false, isolateHostRuntime: true, infrastructureAttempts: 1, injectPlatformSafetyRules: false,
    recordAdaptiveConcurrency: false, permissionReadPaths: item ? [item.grant.manifestPath] : [], permissionEditPaths: [],
    permissionExternalPaths: item ? [item.dir] : [], resourceReaderGrant: item?.grant,
    resourceReaderEvidenceRoot: item ? path.join(item.dir, "audit") : undefined,
    runtimeBudget: { profile: "short", hardTimeoutMs: 120000, silentTimeoutMs: 90000, silentTimeoutAfterActivityMs: 90000 } })
  const results = await Promise.all(published.map(item => run(item.id, item)))
  results.push(await run("nogrant"))
  await writeJsonAtomic(path.join(root, "host-results.json"), results)
  await writeJsonAtomic(path.join(root, "tool-events.json"), seen)
  const passed = !errors.length && results.every(item => item.result.exitCode === 0) &&
    stages.get("alpha") === 8 && stages.get("beta") === 8 && stages.get("nogrant") === 1
  await writeJsonAtomic(path.join(root, "summary.json"), { passed, stages: Object.fromEntries(stages), errors,
    externalModelCalls: 0, exitCodes: results.map(item => item.result.exitCode) })
  if (!passed) throw new Error(`Restricted reader fixture failed: ${root}`)
  console.log(`Restricted reader fixture passed: ${root}`)
} finally {
  server.stop(true)
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
}
