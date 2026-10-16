import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import os from "node:os"
import { builtins } from "./builtins"
import { compile } from "./compile"
import type { Settings, Selection } from "./contract"
import { inspectBudget } from "../task-adaptation/request-budget"
import { summarizeResources } from "./resource-summary"

for (const calls of [1, 2]) test(`actual HTTP execution and model judging share ${calls}-request admission limit`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-budget-runtime-"))
  const credentialEnv = `AEV_BUDGET_FIXTURE_${randomUUID().replaceAll("-", "").toUpperCase()}`
  const bodies: unknown[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { messages: Array<{ content: string }> }
    bodies.push(body)
    return Response.json({ model: "fixture-model", choices: [{ finish_reason: "stop", message: {
      content: body.messages[0].content.includes("Return exactly one JSON") ? JSON.stringify({ passed: true, summary: "Fixture judged" }) : "42" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 } })
  } })
  process.env[credentialEnv] = "synthetic-local-only"
  try {
    const config = { root: path.join(root, "budget"), scope: "shared-task", calls, tokens: 1000 }
    const backend = path.join(root, "backend")
    const runtime = await builtins(backend, { httpBudgets: {
      execution: { config, role: "independent", tokenCeiling: 300 },
      judging: { config, role: "checker", tokenCeiling: 300 } } })
    const http: Settings = { dialect: "openai_chat", url: `${server.url.origin}/chat`, allowedOrigins: [server.url.origin],
      model: "fixture-model", expectedModel: "fixture-model", credentialEnv, systemInput: "system", userInputs: ["user"],
      skillPlacement: "system", maxTokens: 100, maxInputBytes: 10000, maxResponseBytes: 4000, temperature: 0, timeoutMs: 2000 }
    const selection: Selection = { schema: "aev.protocol-plugins.v1", project: { id: "fixture", version: "1",
      skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] }, run: { skillFormat: "text", productKind: "text", materialKinds: ["text"] },
      protocol: { id: "fixture", version: "1", phases: { source: { claim: "task_execution", executor: { id: "http-text-chat", version: "1", settings: http },
        checks: [{ name: "judge", id: "http-model-judge", version: "1", target: "product", stage: "after_execution", mechanism: "judge", required: true,
          settings: { rubric: "Judge the provided answer", maxVerdictBytes: 1000, http: { ...http, systemInput: "rubric", userInputs: ["judgment"] } } }] } } } }
    for (const [file, text] of [["skill.txt", "Reusable rule"], ["system.txt", "Answer public task"], ["user.txt", "What is six times seven?"]]) {
      await writeFile(path.join(root, file), text)
    }
    const receipt = await runtime.run(compile(selection, runtime.registry), "source", { id: "task",
      skill: [{ id: "skill", kind: "text", path: path.join(root, "skill.txt") }],
      materials: ["system", "user"].map(id => ({ id, kind: "text", path: path.join(root, `${id}.txt`) })), privateInputs: [], allowedRoots: [root] })
    expect(receipt.executed).toBe(true)
    expect(receipt.status).toBe(calls === 1 ? "scoring_error" : "passed")
    expect(bodies).toHaveLength(calls)
    expect(await inspectBudget(config)).toMatchObject({ admittedAttempts: calls, reportedTokens: 12 * calls, outstandingTokens: 0 })
    expect((await summarizeResources(backend)).invocations).toHaveLength(calls)
  } finally {
    server.stop(true)
    delete process.env[credentialEnv]
  }
})
