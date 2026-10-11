import { expect, test } from "bun:test"
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { opencodeDriver } from "./opencode-driver"
import { infrastructureAttempts } from "../opencode-retry-policy"
import { DEFAULT_CONFIG } from "../schema"
import type { ToolRequest } from "./tool-session"
import type { OpencodeTaskInput, OpencodeTaskRun } from "../opencode"

async function fixture() {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  const profile = path.join(root, "auto-evolve", ".opencode-private")
  await mkdir(profile, { recursive: true })
  await writeFile(path.join(profile, "profile.json"), '{"fixture":true}')
  await writeFile(path.join(root, "material"), "Public material")
  await mkdir(path.join(root, "workspace"))
  return { cwd: root, profile, evidenceRoot: path.join(root, "evidence") }
}
const request = (root: string): ToolRequest => ({ workDir: root, model: "fixture/model", prompt: "Public input",
  readPaths: [path.join(root, "material")], editPaths: [path.join(root, "workspace")], allowShell: false,
  timeoutMs: 1000, maxAttempts: 1 })
function response(input: OpencodeTaskInput): OpencodeTaskRun {
  return { title: input.title, prompt: input.prompt, selectedModel: input.model,
    referencedPaths: input.referencePaths ?? [], attachedFiles: [], promptInlineFiles: [],
    permissionReadPaths: input.permissionReadPaths ?? [], permissionEditPaths: input.permissionEditPaths ?? [],
    result: { exitCode: 0, stdout: "", stderr: "", events: [], responseText: "", toolFailures: [],
      modelResolution: { requestedModel: "fixture/model", providerID: "fixture", modelID: "model", providerSource: "runtime-config" } } }
}

test("old retry default is three; explicit new single attempt is validated", () => {
  expect(infrastructureAttempts()).toBe(3)
  expect(infrastructureAttempts(1)).toBe(1)
  for (const value of [0, 4, NaN, 1.5]) expect(() => infrastructureAttempts(value)).toThrow()
})

test("driver freezes host config and sends explicit single-attempt no-shell request", async () => {
  const f = await fixture()
  let calls = 0
  const driver = await opencodeDriver({ ...f, load: async () => structuredClone(DEFAULT_CONFIG), invoke: async (input) => {
    calls++
    expect(input.infrastructureAttempts).toBe(1)
    expect(input.allowShell).toBe(false)
    expect(input.isolateHostRuntime).toBe(true)
    expect(input.permissionEditPaths).toEqual(request(f.cwd).editPaths)
    expect(input.runtimeBudget?.hardTimeoutMs).toBe(1000)
    return response(input)
  } })
  const result = await driver.invoke(request(f.cwd), new AbortController().signal)
  expect(result.completed).toBe(true)
  expect(result.actualModel).toBe("fixture/model")
  expect(result.evidence).toHaveLength(2)
  const accounting = JSON.parse(await readFile(result.evidence![1], "utf8"))
  expect(accounting).toMatchObject({ status: "completed", inputTokens: null, outputTokens: null,
    fee: null, reused: false, usageSource: "missing" })
  expect(accounting.elapsedMs).toBeGreaterThanOrEqual(0)
  await expect(driver.invoke(request(f.cwd), new AbortController().signal)).rejects.toThrow()
  expect(calls).toBe(1)
})

test("profile or config drift blocks before cached reuse or backend invocation", async () => {
  const f = await fixture()
  const config = structuredClone(DEFAULT_CONFIG)
  let calls = 0
  const driver = await opencodeDriver({ ...f, load: async () => config, invoke: async (input) => { calls++; return response(input) } })
  config.defaultModel = "changed"
  await expect(driver.preflight()).rejects.toThrow("fingerprint")
  config.defaultModel = DEFAULT_CONFIG.defaultModel
  await writeFile(path.join(f.profile, "profile.json"), '{"fixture":"changed"}')
  await expect(driver.invoke(request(f.cwd), new AbortController().signal)).rejects.toThrow("fingerprint")
  expect(calls).toBe(0)
})

test("driver forwards reported session tokens and binds persisted result bytes", async () => {
  const f = await fixture()
  const driver = await opencodeDriver({ ...f, load: async () => structuredClone(DEFAULT_CONFIG), invoke: async (input) => {
    const run = response(input)
    run.selectedAgent = undefined
    run.result.events = [{ type: "step_finish", part: { tokens: { input: 12, output: 3 }, cost: 0.25 } }]
    return run
  } })
  const result = await driver.invoke(request(f.cwd), new AbortController().signal)
  expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 })
  const accounting = JSON.parse(await readFile(result.evidence![1], "utf8"))
  expect(accounting).toMatchObject({ inputTokens: 12, outputTokens: 3, usageSource: "step_finish", fee: null })
  expect(accounting.rawResultSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(accounting.steps[0].rawCost).toBe(0.25)
})

test("already aborted driver cannot invoke OpenCode", async () => {
  const f = await fixture()
  let calls = 0
  const driver = await opencodeDriver({ ...f, load: async () => structuredClone(DEFAULT_CONFIG), invoke: async (input) => { calls++; return response(input) } })
  const abort = new AbortController()
  abort.abort()
  await expect(driver.invoke(request(f.cwd), abort.signal)).rejects.toThrow("aborted")
  expect(calls).toBe(0)
})

test("malformed permissions block before backend call and started claim", async () => {
  const f = await fixture()
  let calls = 0
  const driver = await opencodeDriver({ ...f, load: async () => structuredClone(DEFAULT_CONFIG),
    invoke: async (input) => { calls++; return response(input) } })
  await expect(driver.invoke({ ...request(f.cwd), readPaths: [] }, new AbortController().signal)).rejects.toThrow("nonempty")
  await expect(driver.invoke({ ...request(f.cwd), editPaths: [path.dirname(f.cwd)] }, new AbortController().signal)).rejects.toThrow("escaped")
  expect(calls).toBe(0)
  await expect(readdir(f.evidenceRoot)).rejects.toThrow()
})

test("backend throw retains sanitized failure and blocks automatic resend", async () => {
  const f = await fixture()
  let calls = 0
  const driver = await opencodeDriver({ ...f, load: async () => structuredClone(DEFAULT_CONFIG), invoke: async () => {
    calls++
    throw new Error("sensitive-fixture-value")
  } })
  await expect(driver.invoke(request(f.cwd), new AbortController().signal)).rejects.toThrow("failure evidence")
  const dirs = await readdir(f.evidenceRoot)
  const body = await readFile(path.join(f.evidenceRoot, dirs[0], "failure.json"), "utf8")
  expect(JSON.parse(body).status).toBe("infrastructure_error")
  expect(body).not.toContain("sensitive-fixture-value")
  const accounting = await readFile(path.join(f.evidenceRoot, dirs[0], "invocation.accounting.json"), "utf8")
  expect(JSON.parse(accounting)).toMatchObject({ status: "infrastructure_error", inputTokens: null, fee: null })
  expect(accounting).not.toContain("sensitive-fixture-value")
  await expect(driver.invoke(request(f.cwd), new AbortController().signal)).rejects.toThrow()
  expect(calls).toBe(1)
})

test("backend mutation cannot change the frozen configuration", async () => {
  const f = await fixture()
  const config = structuredClone(DEFAULT_CONFIG)
  const driver = await opencodeDriver({ ...f, load: async () => config, invoke: async (input) => {
    input.config.defaultModel = "backend-mutated"
    return response(input)
  } })
  await driver.invoke(request(f.cwd), new AbortController().signal)
  expect(config.defaultModel).toBe(DEFAULT_CONFIG.defaultModel)
  await driver.preflight()
})
