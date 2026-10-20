import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { budgetedProviderFetch, type BudgetTransportConfig } from "./budget-transport"
import { inspectRequestUsage, reserveRequest, settleRequest } from "./request-budget"
import { parseRequestUsage, requestUsageTotal } from "./request-usage"

async function config(): Promise<BudgetTransportConfig> {
  return { schema: "aev.budget-transport.v1", budget: { root: await mkdtemp(path.join(os.tmpdir(), "aev-usage-")),
    scope: "audit", calls: 10, tokens: 10000 }, role: "intake", dialect: "openai_chat",
    expectedModels: ["fixture"], maxInputTokens: 1000, maxOutputTokens: 100 }
}
const init = { method: "POST", body: JSON.stringify({ model: "fixture", messages: [], max_tokens: 100 }) }

test("wire components persist, retries are distinct and summaries group roles and models", async () => {
  const cfg = await config()
  const transport: typeof fetch = async () => Response.json({ usage: { prompt_tokens: 20, completion_tokens: 8,
    prompt_tokens_details: { cached_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 5 } } })
  await (await budgetedProviderFetch("https://fixture.invalid", init, cfg, 1000, transport)).text()
  await (await budgetedProviderFetch("https://fixture.invalid", init, { ...cfg, role: "checker" }, 1000, transport)).text()
  const report = await inspectRequestUsage(cfg.budget)
  expect(report).toMatchObject({ admittedAttempts: 2, reportedTokens: 56, complete: true })
  expect(report.groups).toHaveLength(2)
  expect(report.attempts[0]).toMatchObject({ stage: "intake", usage: { inputTokens: 20, outputTokens: 8,
    cacheReadTokens: 12, reasoningTokens: 5, outcome: "complete", httpStatus: 200 } })
  expect(report.groups[0].components.inputTokens).toEqual({ knownTokens: 20, unreportedAttempts: 0 })
  const stored = JSON.parse(await readFile(path.join(cfg.budget.root, "budget.json"), "utf8"))
  expect(stored.attempts[0].usage).toEqual(report.attempts[0].usage)
  expect((await inspectRequestUsage(cfg.budget)).reportedTokens).toBe(56)
})

test("partial failure keeps known components but never releases unknown total", async () => {
  const cfg = await config()
  const raw = 'data: {"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n'
  const response = await budgetedProviderFetch("https://fixture.invalid", init, cfg, 1000,
    async () => new Response(raw, { headers: { "content-type": "text/event-stream" } }))
  await response.text()
  expect(await inspectRequestUsage(cfg.budget)).toMatchObject({ complete: false, unknownAttempts: 1,
    reportedTokens: 0, outstandingTokens: 1100,
    attempts: [{ usage: { inputTokens: 12, outputTokens: 3, outcome: "incomplete_usage" } }] })
})

test("HTTP failure usage is billed, transport failure is unknown and cancellation is classified", async () => {
  for (const mode of ["http", "transport", "cancel"] as const) {
    const cfg = await config()
    if (mode === "transport") {
      await expect(budgetedProviderFetch("https://fixture.invalid", init, cfg, 1000,
        async () => { throw new Error("synthetic") })).rejects.toThrow()
    } else {
      const response = await budgetedProviderFetch("https://fixture.invalid", init, cfg, 1000,
        async () => Response.json({ usage: { prompt_tokens: 7, completion_tokens: 1 } }, { status: mode === "http" ? 429 : 200 }))
      if (mode === "cancel") await response.body!.cancel()
      else await response.text()
    }
    const report = await inspectRequestUsage(cfg.budget)
    expect(report.attempts[0].usage?.outcome).toBe(mode === "http" ? "http_error" : mode === "cancel" ? "cancelled" : "transport_error")
    expect(report.reportedTokens).toBe(mode === "http" ? 8 : 0)
    expect(report.outstandingTokens).toBe(mode === "http" ? 0 : 1100)
  }
})

test("settlement detail is idempotent, conflicting or corrupted detail fails closed", async () => {
  const cfg = (await config()).budget
  await reserveRequest(cfg, { id: "one", request: "a".repeat(64), role: "lead", model: "fixture", reservationTokens: 100 })
  const usage = { inputTokens: 10, outputTokens: 2 }
  await settleRequest(cfg, "one", 12, usage)
  await settleRequest(cfg, "one", 12, usage)
  await expect(settleRequest(cfg, "one", 12, { inputTokens: 11, outputTokens: 1 })).rejects.toThrow("Conflicting")
  const file = path.join(cfg.root, "budget.json")
  const stored = JSON.parse(await readFile(file, "utf8"))
  stored.attempts[0].usage.inputTokens = 500
  await writeFile(file, JSON.stringify(stored))
  await expect(inspectRequestUsage(cfg)).rejects.toThrow("drift")
})

test("dialect totals distinguish disjoint Anthropic cache from inclusive OpenAI details", () => {
  expect(requestUsageTotal(parseRequestUsage({ input_tokens: 10, output_tokens: 2,
    cache_read_input_tokens: 30, cache_creation_input_tokens: 20 }, "anthropic_messages"))).toBe(62)
  expect(requestUsageTotal(parseRequestUsage({ input_tokens: 10, output_tokens: 2,
    input_tokens_details: { cached_tokens: 8 }, output_tokens_details: { reasoning_tokens: 1 } }, "openai_responses"))).toBe(12)
  expect(() => parseRequestUsage({ prompt_tokens: -1 }, "openai_chat")).toThrow()
  expect(requestUsageTotal({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 })).toBeUndefined()
})
