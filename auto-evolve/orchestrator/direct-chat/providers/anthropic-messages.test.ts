import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { anthropicMessagesProvider } from "./anthropic-messages"
import { resolveDirectChatProvider } from "./index"
import { inspectBudget } from "../../task-adaptation/request-budget"

test("native Anthropic direct chat preserves one text request, final answer and shared usage", async () => {
  let count = 0
  const server = Bun.serve({ port: 0, fetch: async request => {
    count++
    expect(new URL(request.url).pathname).toBe("/v1/messages")
    const body = await request.json()
    expect(body.system).toBe("Frozen Skill")
    expect(body.messages).toEqual([{role: "user", content: "Question"}])
    expect(body.max_tokens).toBe(100)
    expect(body.stream).toBe(false)
    expect(body).not.toHaveProperty("tools")
    return Response.json({ model: "MiniMax-M2.7", content: [{type: "thinking", thinking: "not final"}, {type: "text", text: "<answer>42</answer>"}],
      stop_reason: "end_turn", usage: {input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 5} })
  } })
  const budget = {root: `E:/project/AEV-task-adaptation-20261016/test-evidence/anthropic-${randomUUID()}`, scope: "native-chat", calls: 1, tokens: 2000}
  const model = {id: "consumer", transport: "anthropic-messages" as const, baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "local-fixture",
    model: "MiniMax-M2.7", maxOutputTokens: 100, contextWindowTokens: 1000}
  try {
    expect(resolveDirectChatProvider(model).id).toBe("anthropic-messages")
    const result = await anthropicMessagesProvider.call(model, [{role: "system", content: "Frozen Skill"}, {role: "user", content: "Question"}], {
      stableRequestID: "case1", enforceRequestBudget: true, requestBudgetTransport: {schema: "aev.budget-transport.v1", budget,
        dialect: "anthropic_messages", role: "independent", expectedModels: ["MiniMax-M2.7"], maxInputTokens: 1000, maxOutputTokens: 100} })
    expect(result.content).toBe("<answer>42</answer>")
    expect(result.usage?.totalTokens).toBe(35)
    expect((await inspectBudget(budget)).reportedTokens).toBe(35)
    expect(count).toBe(1)
    await expect(anthropicMessagesProvider.call({...model, apiKey: undefined}, [], {})).rejects.toThrow("credential")
    await expect(anthropicMessagesProvider.call(model, [{role: "user", content: [{type: "image"}]}], {})).rejects.toThrow("non-text")
  } finally { server.stop(true) }
})

test("native Anthropic surfaces HTTP failure, output caps and missing final answers", async () => {
  let mode = "cap"
  const server = Bun.serve({ port: 0, fetch: () => mode === "http"
    ? Response.json({ error: { message: "capacity" } }, {status: 429})
    : Response.json({ model: "MiniMax-M2.7", content: mode === "empty" ? [{type: "thinking", thinking: "reasoning"}] : [{type: "text", text: "partial"}],
      stop_reason: "max_tokens", usage: {input_tokens: 10, output_tokens: 20} }) })
  const model = { id: "consumer", transport: "anthropic-messages" as const, model: "MiniMax-M2.7", apiKey: "fixture",
    baseURL: `http://127.0.0.1:${server.port}/v1` }
  try {
    expect((await anthropicMessagesProvider.call(model, [])).finishReason).toBe("length")
    mode = "http"
    await expect(anthropicMessagesProvider.call(model, [])).rejects.toThrow("HTTP 429")
    mode = "empty"
    await expect(anthropicMessagesProvider.call(model, [])).rejects.toThrow("thinking is not an answer")
  } finally { server.stop(true) }
})
