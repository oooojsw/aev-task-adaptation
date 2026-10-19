import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { modelJudge } from "./model-judge"
import { cachedScoring } from "./cache"
import { builtins } from "./builtins"
import type { Artifact, Evaluate } from "./runtime"
import { readdir, readFile, stat } from "node:fs/promises"
import { openRequestStage } from "../task-adaptation/request-budget"
import type { Admission } from "../task-adaptation/exploration/admission"

const root = () => path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
function artifact(id: string, text: string): Artifact {
  return { id, kind: "text", bytes: Buffer.from(text), length: Buffer.byteLength(text), sha256: "fixture-only" }
}
function input(): Parameters<Evaluate>[0] {
  return { task: "fixture", phase: "source", skill: [artifact("skill", "Reusable rule")],
    candidate: [artifact("answer", "Candidate answer")], materials: [artifact("question", "Public task")],
    privateInputs: [artifact("selected-label", "Explicit selected label")],
    check: { name: "score", target: "product", stage: "after_execution", mechanism: "judge" }, settings: {
      rubric: "Assess the specified answer", maxVerdictBytes: 1024, http: {
        dialect: "openai_chat", url: "http://127.0.0.1:1/v1/chat/completions", allowedOrigins: ["http://127.0.0.1:1"],
        model: "independent-judge", expectedModel: "independent-judge", credentialEnv: "AEV_JUDGE_TEST_KEY",
        systemInput: "rubric", userInputs: ["judgment"], skillPlacement: "system", maxTokens: 100,
        maxInputBytes: 20000, maxResponseBytes: 4096, temperature: 0, timeoutMs: 1000 } } }
}
const response = (content: string, finish = "stop") => new Response(JSON.stringify({ model: "independent-judge",
  choices: [{ finish_reason: finish, message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }))

test("judge verdict evidence is distinct per dynamic gate and preserves prior bytes", async () => {
  const config = { root: root(), scope: "judge-stages", calls: 4, tokens: 2000 }
  const policy: Admission = { schema: "aev.exploration-admission.v1", policy: "a".repeat(64),
    round: 1, pass: 1, generation: 0, stage: "author", roles: ["checker"], calls: 1, tokens: 500,
    protectedCalls: 1, protectedTokens: 500 }
  const gate = await openRequestStage(config, policy, null)
  const evidenceRoot = root()
  const options = { evidenceRoot, budget: { config, role: "checker", tokenCeiling: 300 },
    credential: () => "fixture", transport: async () => response('{"passed":true,"summary":"ok"}') }
  const first = await modelJudge({ ...options, requestGate: gate.id })
  expect((await first.evaluate(input())).status).toBe("passed")
  const dir = path.join(evidenceRoot, "verdicts")
  const file = path.join(dir, (await readdir(dir))[0])
  const bytes = await readFile(file), before = await stat(file)
  const nextGate = await openRequestStage(config, { ...policy, stage: "acceptance", protectedCalls: 0, protectedTokens: 0 }, gate.id)
  const second = await modelJudge({ ...options, requestGate: nextGate.id })
  expect(second.descriptor.implementation).toBe(first.descriptor.implementation)
  expect((await second.evaluate(input())).status).toBe("passed")
  expect(await readdir(dir)).toHaveLength(2)
  expect(await readFile(file)).toEqual(bytes)
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
})

test("actual built-in descriptors assemble without serializing validation functions", async () => {
  const runtime = await builtins(root())
  expect(runtime.registry.executor({ id: "http-text-chat", version: "1" }).implementation).toHaveLength(64)
  expect(runtime.registry.checker({ id: "script-json-checker", version: "1" }).implementation).toHaveLength(64)
  expect(runtime.registry.checker({ id: "http-model-judge", version: "1" }).implementation).toHaveLength(64)
})

test("judge uses independent backend and explicitly bound candidate/private inputs", async () => {
  const plugin = await modelJudge({ evidenceRoot: root(), credential: () => "synthetic-fixture", transport: async (_url, options) => {
    const body = JSON.parse(String(options?.body))
    expect(body.model).toBe("independent-judge")
    expect(body.tools).toBeUndefined()
    const payload = JSON.parse(body.messages[1].content)
    expect(payload.candidate[0].content).toBe("Candidate answer")
    expect(payload.privateInputs.map((item: { id: string }) => item.id)).toEqual(["selected-label"])
    expect(payload.skill).toBeUndefined()
    return response('{"passed":true,"summary":"Meets rubric"}')
  } })
  plugin.descriptor.validate(input().settings)
  const verdict = await plugin.evaluate(input())
  expect(verdict.status).toBe("passed")
  expect(verdict.usage).toEqual({ inputTokens: 10, outputTokens: 2 })
})

test("normal false verdict is rejection, malformed verdict cannot pass", async () => {
  for (const [text, expected] of [['{"passed":false,"summary":"Fails rubric"}', "rejected"],
    ['{"passed":"true","summary":"wrong type"}', "scoring_error"],
    ['{"passed":true,"summary":"ok","extra":true}', "scoring_error"],
    ['```json\n{"passed":true,"summary":"ok"}\n```', "scoring_error"],
    ['{"passed":true,"summary":""}', "scoring_error"]]) {
    const plugin = await modelJudge({ evidenceRoot: root(), credential: () => "fixture", transport: async () => response(text) })
    expect((await plugin.evaluate(input())).status).toBe(expected)
  }
})

test("judge missing answer or output cap is scoring infrastructure failure", async () => {
  for (const reply of [response(""), response('{"passed":true,"summary":"ok"}', "length")]) {
    const plugin = await modelJudge({ evidenceRoot: root(), credential: () => "fixture", transport: async () => reply })
    expect((await plugin.evaluate(input())).status).toBe("scoring_error")
  }
})

test("judge unsupported binary evidence and bad configuration block before transport", async () => {
  let calls = 0
  const plugin = await modelJudge({ evidenceRoot: root(), credential: () => "fixture", transport: async () => {
    calls++; return response('{"passed":true,"summary":"ok"}')
  } })
  const request = input()
  request.candidate[0].kind = "excel"
  await expect(plugin.evaluate(request)).rejects.toThrow("unsupported")
  const bad = input().settings
  bad.maxVerdictBytes = 0
  expect(() => plugin.descriptor.validate(bad)).toThrow()
  expect(calls).toBe(0)
})

test("judge score reuse retains original usage and records no new judge call", async () => {
  let calls = 0
  const plugin = await modelJudge({ evidenceRoot: root(), credential: () => "fixture", transport: async () => {
    calls++; return response('{"passed":true,"summary":"ok"}')
  } })
  const evaluate = cachedScoring(root(), plugin.descriptor, plugin.evaluate)
  const first = await evaluate(input())
  const second = await evaluate(input())
  expect(second.status).toBe(first.status)
  expect(second.usage).toEqual(first.usage)
  expect(second.reused).toBe(true)
  expect(calls).toBe(1)
})
