import { expect, test } from "bun:test"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { builtins } from "./builtins"
import { toolSession } from "./tool-session"
import { cachedExecution } from "./cache"
import { mkdir, writeFile } from "node:fs/promises"
import type { InvokeTool } from "./tool-session"
import { openRequestStage, inspectBudget } from "../task-adaptation/request-budget"
import type { Admission } from "../task-adaptation/exploration/admission"
import { compile } from "./compile"
import type { Selection } from "./contract"

const root = () => path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())

test("registered cached judge survives stale-gate rejection and reuses completed verdict across stages", async () => {
  let calls = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => {
    calls++
    return Response.json({ model: "fixture", choices: [{ finish_reason: "stop", message: {
      content: '{"passed":true,"summary":"fixture accepted"}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } })
  } })
  const keyEnv = `AEV_FIXTURE_${randomUUID().replaceAll("-", "").toUpperCase()}`
  process.env[keyEnv] = "synthetic-local-only"
  try {
    const config = { root: root(), scope: "registered-stages", calls: 8, tokens: 4000 }
    const policy: Admission = { schema: "aev.exploration-admission.v1", policy: "a".repeat(64), round: 1,
      pass: 1, generation: 0, stage: "author", roles: ["checker"], calls: 2, tokens: 1000,
      protectedCalls: 2, protectedTokens: 1000 }
    const author = await openRequestStage(config, policy, null)
    const backendRoot = root()
    const budgets = { execution: { config, role: "independent", tokenCeiling: 300 },
      judging: { config, role: "checker", tokenCeiling: 300 } }
    const old = await builtins(backendRoot, { httpBudgets: budgets, requestGate: author.id })
    const nextGate = await openRequestStage(config, { ...policy, stage: "acceptance", protectedCalls: 0, protectedTokens: 0 }, author.id)
    const current = await builtins(backendRoot, { httpBudgets: budgets, requestGate: nextGate.id })
    const selection: Selection = { schema: "aev.protocol-plugins.v1", project: { id: "gated-report", version: "1",
      skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] },
      run: { skillFormat: "text", productKind: "text", materialKinds: ["text"] }, protocol: { id: "report-check", version: "1",
        phases: { source: { claim: "skill_check", checks: [{ id: "http-model-judge", version: "1", name: "report",
          target: "skill", stage: "before_execution", mechanism: "judge", required: true, settings: {
            rubric: "Check public report", maxVerdictBytes: 1024, http: { dialect: "openai_chat",
              url: `${server.url.origin}/v1/chat/completions`, allowedOrigins: [server.url.origin], model: "fixture",
              expectedModel: "fixture", credentialEnv: keyEnv, systemInput: "rubric", userInputs: ["judgment"],
              skillPlacement: "system", maxTokens: 100, maxInputBytes: 20000, maxResponseBytes: 4096, temperature: 0, timeoutMs: 2000 } } }] } } } }
    const snapshot = compile(selection, old.registry)
    expect(compile(selection, current.registry).fingerprint).toBe(snapshot.fingerprint)
    const materials = root()
    await mkdir(materials, { recursive: true })
    const file = path.join(materials, "report.md")
    await writeFile(file, "A public synthetic report")
    const task = { id: "report", skill: [{ id: "report", kind: "text", path: file }], materials: [], privateInputs: [], allowedRoots: [materials] }
    expect((await old.run(snapshot, "source", task)).status).toBe("scoring_error")
    expect(calls).toBe(0)
    expect((await current.run(snapshot, "source", task)).status).toBe("passed")
    expect(calls).toBe(1)
    const later = await openRequestStage(config, { ...policy, round: 2 }, nextGate.id)
    const resumed = await builtins(backendRoot, { httpBudgets: budgets, requestGate: later.id })
    expect((await resumed.run(snapshot, "source", task)).status).toBe("passed")
    expect(calls).toBe(1)
    expect((await inspectBudget(config)).admittedAttempts).toBe(1)
  } finally {
    delete process.env[keyEnv]
    await server.stop(true)
  }
})

test("default builtins do not register or initialize a tool host", async () => {
  const runtime = await builtins(root())
  expect(() => runtime.registry.executor({ id: "isolated-tool-session", version: "1" })).toThrow()
  expect(runtime.registry.executor({ id: "http-text-chat", version: "1" }).implementation).toHaveLength(64)
})

test("explicit frozen tool driver registers alongside independent checkers", async () => {
  let calls = 0
  const runtime = await builtins(root(), { tool: { implementation: "a".repeat(64),
    preflight: async () => {}, invoke: async () => { calls++; throw new Error("must not invoke during registration") } } })
  expect(runtime.registry.executor({ id: "isolated-tool-session", version: "1" }).implementation).toHaveLength(64)
  expect(runtime.registry.checker({ id: "script-json-checker", version: "1" }).implementation).toHaveLength(64)
  expect(calls).toBe(0)
})

test("tool cached product requires current backend preflight without duplicate execution", async () => {
  const dir = root()
  let compatible = true
  let calls = 0
  const invoke: InvokeTool = async (request) => {
    calls++
    const workspace = path.join(request.workDir, "workspace")
    await mkdir(workspace, { recursive: true })
    await writeFile(path.join(workspace, "result.txt"), "actual fixture answer")
    return { completed: true, actualModel: "fixture/model" }
  }
  const tool = await toolSession({ evidenceRoot: path.join(dir, "tools"), backendImplementation: "a".repeat(64), invoke })
  const execute = cachedExecution(path.join(dir, "cache"), tool.descriptor, tool.execute, async () => {
    if (!compatible) throw new Error("host drift")
  })
  const input = { task: "fixture", phase: "source" as const, skill: [], materials: [], settings: {
    model: "fixture/model", expectedModel: "fixture/model", outputPath: "result.txt", outputKind: "text",
    maxInputBytes: 10000, maxProductBytes: 1000, timeoutMs: 1000, allowShell: false,
    instruction: "Write the bound result" } }
  expect((await execute(input)).status).toBe("completed")
  expect((await execute(input)).reused).toBe(true)
  compatible = false
  await expect(execute(input)).rejects.toThrow("host drift")
  expect(calls).toBe(1)
})
