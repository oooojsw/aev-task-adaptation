import { expect, test } from "bun:test"
import { mkdtemp, writeFile, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { budgetedProviderFetch, readBudgetTransport, budgetTransportEnvironment, type BudgetTransportConfig } from "./budget-transport"
import { inspectBudget } from "./request-budget"

async function config(dialect: BudgetTransportConfig["dialect"] = "openai_chat"): Promise<BudgetTransportConfig> {
  return { schema: "aev.budget-transport.v1", budget: { root: await mkdtemp(path.join(os.tmpdir(), "aev-budget-wire-")), scope: "task", calls: 5, tokens: 10000 },
    role: "executor", dialect, expectedModels: ["fixture"], maxInputTokens: 1000, maxOutputTokens: 100 }
}
const init = (body: object): RequestInit => ({ method: "POST", body: JSON.stringify(body), headers: { authorization: "synthetic-not-persisted" } })
const chat = () => ({ model: "fixture", max_tokens: 100, stream: true, messages: [{ role: "user", content: "Question" }] })
const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
function sse(text: string, chunks = 7): Response {
  const bytes = Buffer.from(text)
  let offset = 0
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return }
    controller.enqueue(bytes.subarray(offset, offset + chunks)); offset += chunks
  } }), { headers: { "content-type": "text/event-stream", "x-fixture": "unchanged" } })
}

test("OpenAI SSE counts real request usage while preserving every response byte", async () => {
  const cfg = await config()
  const raw = chunk({ choices: [{ delta: { content: "原样文本" } }] }) + chunk({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } }) + "data: [DONE]\n\n"
  const response = await budgetedProviderFetch("http://127.0.0.1/model", init(chat()), cfg, 1000, async (_url, options) => {
    expect(options?.body).toBe(JSON.stringify(chat()))
    return sse(raw, 1)
  })
  expect(response.headers.get("x-fixture")).toBe("unchanged")
  expect(await response.text()).toBe(raw)
  expect(await inspectBudget(cfg.budget)).toMatchObject({ admittedAttempts: 1, reportedTokens: 17, outstandingTokens: 0 })
  expect(await readFile(path.join(cfg.budget.root, "budget.json"), "utf8")).not.toContain("synthetic-not-persisted")
})

test("Anthropic stream accounts cache usage plus final output", async () => {
  const cfg = await config("anthropic_messages")
  const raw = chunk({ type: "message_start", message: { usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 0 } } }) +
    chunk({ type: "message_delta", usage: { input_tokens: 10, output_tokens: 7 } }) + chunk({ type: "message_stop" })
  const response = await budgetedProviderFetch("http://127.0.0.1/model", init(chat()), cfg, 1000, async () => sse(raw))
  expect(await response.text()).toBe(raw)
  expect((await inspectBudget(cfg.budget)).reportedTokens).toBe(67)
})

test("Responses completion and nonstream JSON both record complete usage", async () => {
  const cfg = await config("openai_responses")
  const raw = chunk({ type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 9 } } })
  const response = await budgetedProviderFetch("http://127.0.0.1/model", init({ model: "fixture", input: [], max_output_tokens: 100, stream: true }), cfg, 1000, async () => sse(raw))
  expect(await response.text()).toBe(raw)
  const other = await budgetedProviderFetch("http://127.0.0.1/model", init({ model: "fixture", input: [], max_output_tokens: 100 }), cfg, 1000,
    async () => Response.json({ usage: { input_tokens: 4, output_tokens: 2 } }))
  await other.text()
  expect(await inspectBudget(cfg.budget)).toMatchObject({ admittedAttempts: 2, reportedTokens: 35 })
})

test("broken, absent, incomplete or malformed usage retains reservation and blocks retry dispatch", async () => {
  for (const raw of [chunk({ choices: [] }) + "data: [DONE]\n\n",
    chunk({ usage: { prompt_tokens: 12, completion_tokens: 5 } }),
    chunk({ usage: { prompt_tokens: -1, completion_tokens: 5 } }) + "data: [DONE]\n\n",
    "data: not-json\n\ndata: [DONE]\n\n"]) {
    const cfg = await config()
    let calls = 0
    const transport: typeof fetch = async () => { calls++; return sse(raw) }
    const response = await budgetedProviderFetch("http://127.0.0.1/model", init(chat()), cfg, 1000, transport)
    expect(await response.text()).toBe(raw)
    expect(await inspectBudget(cfg.budget)).toMatchObject({ admittedAttempts: 1, unknownAttempts: 1, outstandingTokens: 1100 })
    await expect(budgetedProviderFetch("http://127.0.0.1/model", init(chat()), cfg, 1000, transport)).rejects.toThrow("inspection")
    expect(calls).toBe(1)
  }
})

test("transport errors and caller cancellation preserve uncertain billable request", async () => {
  const cfg = await config()
  await expect(budgetedProviderFetch("http://127.0.0.1/model", init(chat()), cfg, 1000, async () => { throw new Error("synthetic disconnect") })).rejects.toThrow("disconnect")
  expect((await inspectBudget(cfg.budget)).unknownAttempts).toBe(1)
  const cancelled = await config()
  const response = await budgetedProviderFetch("http://127.0.0.1/model", init(chat()), cancelled, 1000, async () => sse(chunk({ choices: [] })))
  await response.body!.cancel()
  expect((await inspectBudget(cancelled.budget)).unknownAttempts).toBe(1)
})

test("invalid wire bounds and context assumptions fail before any dispatch", async () => {
  const cfg = await config()
  let calls = 0
  const transport: typeof fetch = async () => { calls++; return Response.json({}) }
  for (const body of [{ ...chat(), model: "other" }, { ...chat(), max_tokens: undefined },
    { ...chat(), max_tokens: 101 }, { ...chat(), messages: undefined }]) {
    await expect(budgetedProviderFetch("http://127.0.0.1/model", init(body), cfg, 1000, transport)).rejects.toThrow()
  }
  await expect(budgetedProviderFetch("http://127.0.0.1/model", init(chat()), cfg, 2000, transport)).rejects.toThrow("declared model context")
  await expect(budgetedProviderFetch("http://127.0.0.1/model", { method: "GET" }, cfg, 1000, transport)).rejects.toThrow("JSON POST")
  expect(calls).toBe(0)
  expect((await inspectBudget(cfg.budget)).admittedAttempts).toBe(0)
})

test("frozen budget config rejects on-disk mutation without revealing its contents", async () => {
  const cfg = await config()
  const file = path.join(cfg.budget.root, "transport.json")
  const raw = JSON.stringify(cfg)
  await writeFile(file, raw)
  const sha = createHash("sha256").update(raw).digest("hex")
  expect(await readBudgetTransport(file, sha)).toEqual(cfg)
  await writeFile(file, raw + " ")
  await expect(readBudgetTransport(file, sha)).rejects.toThrow("drift")
  await expect(readBudgetTransport(file, undefined)).rejects.toThrow("hash required")
})

test("private provider environment carries only frozen file pointer and clears unselected binding", async () => {
  const cfg = await config()
  const env = await budgetTransportEnvironment(cfg, cfg.budget.root)
  expect(await readBudgetTransport(env.OPENCODE_AEV_REQUEST_BUDGET_FILE!, env.OPENCODE_AEV_REQUEST_BUDGET_SHA256)).toEqual(cfg)
  expect(Object.keys(env).sort()).toEqual(["OPENCODE_AEV_REQUEST_BUDGET_FILE", "OPENCODE_AEV_REQUEST_BUDGET_SHA256"])
  expect(await budgetTransportEnvironment(undefined, cfg.budget.root)).toEqual({ OPENCODE_AEV_REQUEST_BUDGET_FILE: undefined,
    OPENCODE_AEV_REQUEST_BUDGET_SHA256: undefined })
})
