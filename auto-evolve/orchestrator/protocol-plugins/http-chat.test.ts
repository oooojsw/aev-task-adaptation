import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { httpChat } from "./http-chat"
import type { Settings } from "./contract"
import type { Artifact, PublicInputs } from "./runtime"
import { summarizeResources } from "./resource-summary"

function settings(): Settings {
  return { dialect: "openai_chat", url: "http://127.0.0.1:1/v1/chat/completions", allowedOrigins: ["http://127.0.0.1:1"],
    model: "fixture-model", expectedModel: "fixture-model", credentialEnv: "AEV_PLUGIN_TEST_KEY", systemInput: "system",
    userInputs: ["user"], skillPlacement: "system", maxTokens: 100, maxInputBytes: 10000, maxResponseBytes: 4096, temperature: 0, timeoutMs: 1000 }
}
function artifact(id: string, text: string): Artifact {
  return { id, kind: "text", bytes: Buffer.from(text), sha256: "fixture-only", length: Buffer.byteLength(text) }
}
function request(): PublicInputs & { settings: Settings } {
  return { task: "fixture", phase: "source", skill: [artifact("any-entry.md", "Reusable rules")],
    materials: [artifact("system", "Original public system"), artifact("user", "Public task")], settings: settings() }
}
const root = () => path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
const reply = () => ({ model: "fixture-model", choices: [{ finish_reason: "stop", message: { content: "42" } }],
  usage: { prompt_tokens: 10, completion_tokens: 2 } })

test("HTTP adapter sends one request without NBA/OpenCode assumptions", async () => {
  let calls = 0
  const evidenceRoot = root()
  const plugin = await httpChat({ evidenceRoot, credential: () => "synthetic-fixture", transport: async (_url, options) => {
    calls++
    expect(options?.redirect).toBe("error")
    expect((options as RequestInit & { timeout: false }).timeout).toBe(false)
    const body = JSON.parse(String(options?.body))
    expect(body.tools).toBeUndefined()
    expect(body.messages[0].content).toContain("Original public system")
    expect(body.messages[0].content).toContain("any-entry.md")
    expect(body.messages[0].content).not.toContain("nba_skill")
    return new Response(JSON.stringify(reply()))
  } })
  plugin.descriptor.validate(settings())
  const result = await plugin.execute(request())
  expect(result.status).toBe("completed")
  expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2 })
  expect(calls).toBe(1)
  const resources = await summarizeResources(evidenceRoot)
  expect(resources.invocations).toHaveLength(1)
  expect(resources.input.knownTokens).toBe(10)
  expect(resources.output.knownTokens).toBe(2)
  expect(resources.input.completeForDiscoveredInvocations).toBe(true)
})

test("Anthropic mode preserves explicit system/user and checks completion", async () => {
  const plugin = await httpChat({ evidenceRoot: root(), credential: () => "synthetic-fixture", transport: async (_url, options) => {
    const body = JSON.parse(String(options?.body))
    expect(body.system).toContain("Original public system")
    expect(body.messages).toHaveLength(1)
    return new Response(JSON.stringify({ model: "fixture-model", stop_reason: "end_turn", content: [{ type: "text", text: "42" }] }))
  } })
  const input = request()
  input.settings.dialect = "anthropic_messages"
  expect((await plugin.execute(input)).status).toBe("completed")
})

test("disabling socket idle timeout retains the explicit protocol deadline", async () => {
  let aborted = false
  let calls = 0
  const plugin = await httpChat({ evidenceRoot: root(), credential: () => "synthetic-fixture",
    transport: async (_url, options) => {
      calls++
      expect((options as RequestInit & { timeout: false }).timeout).toBe(false)
      return await new Promise<Response>((_resolve, reject) => {
        const signal = options!.signal!
        signal.addEventListener("abort", () => {
          aborted = true
          reject(new Error("synthetic timeout"))
        }, { once: true })
      })
    } })
  const input = request()
  input.settings.timeoutMs = 20
  expect((await plugin.execute(input)).status).toBe("execution_error")
  expect(aborted).toBe(true)
  expect(calls).toBe(1)
})

test("wrong model, output cap and tool call are infrastructure failures", async () => {
  for (const mutate of [
    (data: ReturnType<typeof reply>) => { data.model = "unexpected" },
    (data: ReturnType<typeof reply>) => { data.choices[0].finish_reason = "length" },
    (data: ReturnType<typeof reply>) => { Object.assign(data.choices[0].message, { tool_calls: [{}] }) },
  ]) {
    const data = reply()
    mutate(data)
    const plugin = await httpChat({ evidenceRoot: root(), credential: () => "synthetic-fixture",
      transport: async () => new Response(JSON.stringify(data)) })
    expect((await plugin.execute(request())).status).toBe("execution_error")
  }
})

test("HTTP failure and thinking-only replies are not scored as answers", async () => {
  for (const response of [new Response("quota", { status: 429 }), new Response(JSON.stringify({ model: "fixture-model",
    choices: [{ finish_reason: "stop", message: { content: "", reasoning_content: "thought" } }] }))]) {
    const plugin = await httpChat({ evidenceRoot: root(), credential: () => "synthetic-fixture", transport: async () => response })
    expect((await plugin.execute(request())).status).toBe("execution_error")
  }
})

test("configuration mismatch and absent credential block before transport", async () => {
  let calls = 0
  const plugin = await httpChat({ evidenceRoot: root(), credential: () => undefined,
    transport: async () => { calls++; return new Response(JSON.stringify(reply())) } })
  await expect(plugin.execute(request())).rejects.toThrow("credential")
  const input = request()
  input.settings.url = "http://untrusted.example/v1/messages"
  await expect(plugin.execute(input)).rejects.toThrow()
  expect(calls).toBe(0)
})

test("input byte cap causes no truncation and no request", async () => {
  let calls = 0
  const plugin = await httpChat({ evidenceRoot: root(), credential: () => "synthetic-fixture",
    transport: async () => { calls++; return new Response(JSON.stringify(reply())) } })
  const input = request()
  input.settings.maxInputBytes = 1
  await expect(plugin.execute(input)).rejects.toThrow("no truncation")
  expect(calls).toBe(0)
})

test("duplicate HTTP invocation cannot send twice without cache/audit", async () => {
  let calls = 0
  const plugin = await httpChat({ evidenceRoot: root(), credential: () => "synthetic-fixture",
    transport: async () => { calls++; return new Response(JSON.stringify(reply())) } })
  await plugin.execute(request())
  await expect(plugin.execute(request())).rejects.toThrow()
  expect(calls).toBe(1)
})

test("actual token budget violation and oversized response block scoring", async () => {
  const data = reply()
  data.usage.completion_tokens = 101
  for (const raw of [JSON.stringify(data), "x".repeat(5000)]) {
    const plugin = await httpChat({ evidenceRoot: root(), credential: () => "synthetic-fixture",
      transport: async () => new Response(raw) })
    expect((await plugin.execute(request())).status).toBe("execution_error")
  }
})
