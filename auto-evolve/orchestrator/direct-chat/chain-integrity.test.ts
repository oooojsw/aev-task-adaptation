import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runDirectChatEvaluation } from "./runner"
import { withEvaluationLock } from "./resume-identity"
import type { DirectChatRunConfig } from "./contract"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-chain-"))
  const script = path.join(root, "judge.ts")
  await writeFile(script, 'console.log(JSON.stringify({passed:true}))')
  const skill = path.join(root, "skill.md"), dataset = path.join(root, "cases.jsonl")
  await writeFile(skill, "Use the evidence.")
  const task = { schema: "direct-chat-case/v1", caseID: "case1", dataset: "fixture", split: "train",
    question: { text: "What is the value?", outputInstruction: "Return a number" }, materials: [],
    privateOracle: { scriptPath: script, runner: "bun", args: ["--candidate", "unused.txt"] },
    materialAudit: { caseID: "case1", expectedSources: [], includedMaterials: [], omittedSources: [], warnings: [], tokenEstimate: 0, compressionPolicy: "none" } }
  await writeFile(dataset, JSON.stringify(task) + "\n")
  const config: DirectChatRunConfig = { skillBundlePath: skill, datasetBundlePath: dataset, outDir: path.join(root, "out"),
    models: { models: { consumer: { transport: "mock", mockResponse: "<answer>42</answer>", maxOutputTokens: 100,
      contextWindowTokens: 20000, promptBudgetTokens: 10000 } }, retry: { maxAttempts: 1 }, transientRecovery: { enabled: false } },
    updateMasterReport: false, skillInputMode: "full", globalConcurrency: 1 }
  return { root, script, dataset, task, config }
}

test("valid reuse sends no request; changed model, question, validator and duplicate IDs fail before dispatch", async () => {
  const f = await fixture()
  const first = await runDirectChatEvaluation(f.config)
  expect(first.results[0].passed).toBe(true)
  const before = await readFile(path.join(f.config.outDir, "config.snapshot.json"), "utf8")
  const stamp = await readFile(first.results[0].rawResponsePath, "utf8")
  const reused = await runDirectChatEvaluation({ ...f.config, resumeExisting: true })
  expect(reused.results[0].latencyMs).toBe(first.results[0].latencyMs)
  expect(await readFile(first.results[0].rawResponsePath, "utf8")).toBe(stamp)
  const snapshot = await readFile(path.join(f.config.outDir, "config.snapshot.json"), "utf8")
  f.config.models.models.consumer.temperature = 0.7
  await expect(runDirectChatEvaluation({ ...f.config, resumeExisting: true })).rejects.toThrow("identity changed")
  expect(await readFile(path.join(f.config.outDir, "config.snapshot.json"), "utf8")).toBe(snapshot)
  delete f.config.models.models.consumer.temperature
  await expect(runDirectChatEvaluation(f.config)).rejects.toThrow("already exists")
  await writeFile(f.dataset, JSON.stringify({ ...f.task, question: { ...f.task.question, text: "Changed" } }) + "\n")
  await expect(runDirectChatEvaluation({ ...f.config, resumeExisting: true })).rejects.toThrow("identity changed")
  await writeFile(f.dataset, JSON.stringify(f.task) + "\n")
  await writeFile(f.script, 'console.log(JSON.stringify({passed:false}))')
  await expect(runDirectChatEvaluation({ ...f.config, resumeExisting: true })).rejects.toThrow("identity changed")
  await writeFile(f.dataset, `${JSON.stringify(f.task)}\n${JSON.stringify(f.task)}\n`)
  await expect(runDirectChatEvaluation(f.config)).rejects.toThrow("duplicate")
  expect(before).toContain("consumer")
})

for (const [name, script] of [
  ["empty successful process", "process.exit(0)"],
  ["crashed checker", 'console.log(JSON.stringify({passed:false}));process.exit(2)'],
  ["contradictory checker", 'console.log(JSON.stringify({passed:true}));process.exit(1)'],
] as const) test(`validator infrastructure: ${name} never becomes a normal score`, async () => {
  const f = await fixture()
  await writeFile(f.script, script)
  const result = await runDirectChatEvaluation(f.config)
  expect(result.results[0].passed).toBe(false)
  expect(result.results[0].errorCategory).toBe("validator_infrastructure")
  expect(result.results[0].attempts).toBe(1)
  expect(result.results[0].usage?.outputTokens).toBeGreaterThan(0)
  expect(JSON.parse(await readFile(path.join(f.config.outDir, "summary.json"), "utf8")).validity.status).toBe("invalid")
})

test("OpenAI reasoning-only and partial capped answers retain evidence and invalidate aggregate", async () => {
  let mode = "empty", calls = 0
  const server = Bun.serve({ port: 0, fetch: () => {
    calls++
    return Response.json({ model: "fixture", choices: [{ message: { content: mode === "empty" ? "" : "<answer>42</answer>", reasoning_content: "private reasoning" }, finish_reason: "length" }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })
  } })
  try {
    for (const variant of ["empty", "partial"]) {
      mode = variant
      const f = await fixture()
      f.config.models.models.consumer = { transport: "openai-compatible", model: "fixture", apiKey: "local-fixture",
        baseURL: `http://127.0.0.1:${server.port}/v1`, maxOutputTokens: 20, contextWindowTokens: 20000, promptBudgetTokens: 10000 }
      const result = await runDirectChatEvaluation(f.config)
      const row = result.results[0]
      expect(row.attempts).toBe(1)
      expect(row.usage?.outputTokens).toBe(20)
      expect(row.outputBudgetExceeded).toBe(true)
      expect(JSON.parse(await readFile(row.responseAuditPath!, "utf8")).raw.choices[0].message.reasoning_content).toBe("private reasoning")
      if (variant === "empty") expect(row.answer).toBe("")
      expect(JSON.parse(await readFile(path.join(f.config.outDir, "summary.json"), "utf8")).validity.status).toBe("invalid")
    }
    expect(calls).toBe(2)
  } finally { server.stop(true) }
})

test("unsafe case IDs cannot escape results directory", async () => {
  const f = await fixture()
  await writeFile(f.dataset, JSON.stringify({ ...f.task, caseID: "../outside" }) + "\n")
  await expect(runDirectChatEvaluation(f.config)).rejects.toThrow("Unsafe")
})

test("invalid capacities and unknown consumers stop before any call", async () => {
  const f = await fixture()
  f.config.models.models.consumer.concurrency = -1
  await expect(runDirectChatEvaluation(f.config)).rejects.toThrow("capacity")
  delete f.config.models.models.consumer.concurrency
  await expect(runDirectChatEvaluation({ ...f.config, modelIDs: ["consumer", "missing"] })).rejects.toThrow("Unknown requested")
})

test("hung validator terminates with billed model evidence retained", async () => {
  const f = await fixture()
  await writeFile(f.script, "setInterval(()=>{},1000)")
  await writeFile(f.dataset, JSON.stringify({ ...f.task, privateOracle: { ...f.task.privateOracle, timeoutMs: 250 } }) + "\n")
  const started = Date.now()
  const result = await runDirectChatEvaluation(f.config)
  expect(Date.now() - started).toBeLessThan(20000)
  expect(result.results[0].errorCategory).toBe("validator_infrastructure")
  expect(result.results[0].attempts).toBe(1)
  expect(JSON.parse(await readFile(result.results[0].validatorResultPath!, "utf8")).timedOut).toBe(true)
})

test("HTTP failures retain real retry attempt count", async () => {
  const f = await fixture()
  let calls = 0
  const server = Bun.serve({ port: 0, fetch: () => { calls++; return Response.json({ error: "capacity" }, { status: 503 }) } })
  try {
    f.config.models.models.consumer = { transport: "openai-compatible", model: "fixture", apiKey: "local-fixture",
      baseURL: `http://127.0.0.1:${server.port}/v1`, maxOutputTokens: 20, contextWindowTokens: 20000, promptBudgetTokens: 10000 }
    f.config.models.retry = { maxAttempts: 2, backoffMs: 0 }
    const result = await runDirectChatEvaluation(f.config)
    expect(calls).toBe(2)
    expect(result.results[0].attempts).toBe(2)
    expect(result.results[0].errorCategory).toBe("provider_5xx")
  } finally { server.stop(true) }
})

test("one evaluation owns each output directory; incomplete requests require review", async () => {
  const f = await fixture()
  await runDirectChatEvaluation({ ...f.config, preflightOnly: true })
  await withEvaluationLock(f.config.outDir, async () => {
    await expect(runDirectChatEvaluation(f.config)).rejects.toThrow("already active")
  })
  const { mkdir } = await import("node:fs/promises")
  const dir = path.join(f.config.outDir, "results", "consumer", "case1")
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "request-audit.json"), JSON.stringify({ status: "interrupted" }))
  await expect(runDirectChatEvaluation({ ...f.config, resumeExisting: true })).rejects.toThrow("evidence review")
})

test("output reservation and transport mismatches fail once before any consumer call", async () => {
  const f = await fixture()
  let calls = 0
  const server = Bun.serve({ port: 0, fetch: () => { calls++; return Response.json({}) } })
  try {
    f.config.models.models.consumer = { transport: "anthropic-messages", model: "fixture", apiKey: "local-fixture",
      baseURL: `http://127.0.0.1:${server.port}/v1`, maxOutputTokens: 40, contextWindowTokens: 20000, promptBudgetTokens: 10000 }
    f.config.requestBudgetTransport = { schema: "aev.budget-transport.v1", budget: { root: path.join(f.root, "budget"), scope: "fixture", calls: 1, tokens: 20000 },
      role: "consumer", dialect: "anthropic_messages", expectedModels: ["fixture"], maxInputTokens: 10000, maxOutputTokens: 20 }
    await expect(runDirectChatEvaluation(f.config)).rejects.toThrow("mismatch before dispatch")
    f.config.requestBudgetTransport.maxOutputTokens = 40
    f.config.requestBudgetTransport.dialect = "openai_chat"
    await expect(runDirectChatEvaluation(f.config)).rejects.toThrow("mismatch before dispatch")
    expect(calls).toBe(0)
  } finally { server.stop(true) }
})
