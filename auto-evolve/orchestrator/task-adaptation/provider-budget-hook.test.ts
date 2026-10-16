import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fetchWithTaskBudget, taskBudgetIdentity } from "../../../packages/opencode/src/provider/aev-request-budget"
import { budgetTransportEnvironment, type BudgetTransportConfig } from "./budget-transport"
import { inspectBudget } from "./request-budget"

test("unselected provider preserves exact arguments and response without loading a budget", async () => {
  const init = { method: "GET", headers: { "x-fixture": "unchanged" } }
  const response = new Response("legacy response")
  let calls = 0
  const transport: typeof fetch = async (input, options) => {
    calls++
    expect(input).toBe("https://fixture.invalid")
    expect(options).toBe(init)
    return response
  }
  expect(await fetchWithTaskBudget("https://fixture.invalid", init, 0, transport, {})).toBe(response)
  expect(calls).toBe(1)
  expect(taskBudgetIdentity("model", 0, {})).toBeUndefined()
  expect(JSON.stringify({ provider: "fixture", taskBudget: taskBudgetIdentity("model", 0, {}) })).toBe('{"provider":"fixture"}')
})

test("selected provider hook counts actual local HTTP dispatch and blocks the second request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-provider-hook-"))
  const cfg: BudgetTransportConfig = { schema: "aev.budget-transport.v1", budget: { root: path.join(root, "ledger"), scope: "fixture", calls: 1, tokens: 2000 },
    role: "lead", dialect: "openai_chat", expectedModels: ["fixture"], maxInputTokens: 1000, maxOutputTokens: 100 }
  const env = await budgetTransportEnvironment(cfg, root)
  let calls = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    calls++
    expect(await request.json()).toMatchObject({ model: "fixture", max_tokens: 100 })
    return Response.json({ choices: [{ message: { content: "unchanged" } }], usage: { prompt_tokens: 19, completion_tokens: 3 } })
  } })
  try {
    const init = { method: "POST", body: JSON.stringify({ model: "fixture", max_tokens: 100, messages: [] }) }
    const response = await fetchWithTaskBudget(server.url, init, 1000, fetch, env)
    expect((await response.json()).choices[0].message.content).toBe("unchanged")
    expect(await inspectBudget(cfg.budget)).toMatchObject({ admittedAttempts: 1, reportedTokens: 22 })
    await expect(fetchWithTaskBudget(server.url, init, 1000, fetch, env)).rejects.toThrow()
    expect(calls).toBe(1)
  } finally { await server.stop(true) }
})

test("budgeted SDK cache identity separates both wire model and context bound", () => {
  const env = { OPENCODE_AEV_REQUEST_BUDGET_FILE: "fixture" }
  const key = (model: string, context: number) => JSON.stringify(taskBudgetIdentity(model, context, env))
  expect(key("one", 1000)).not.toBe(key("two", 1000))
  expect(key("one", 1000)).not.toBe(key("one", 2000))
  expect(key("one", 1000)).toBe(key("one", 1000))
})
