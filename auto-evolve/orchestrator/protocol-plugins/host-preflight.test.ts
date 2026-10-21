import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { preflightSourceHost, readinessEnvironment } from "./host-preflight"
import { runManagedProcess, type ManagedProcessResult } from "../managed-process"

const reply = (fields: Partial<ManagedProcessResult> = {}): ManagedProcessResult => ({
  exitCode: 0, stdout: "Commands:\n  help\nOptions:\n  --help", stderr: "", timedOut: false,
  hardTimedOut: false, silentTimedOut: false, silentTimeoutAfterActivity: false, observedRuntimeOutput: true, ...fields,
})
const fixture = async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aev-host-ready-"))
  return { cwd, evidenceRoot: path.join(cwd, "evidence") }
}

test("readiness environment excludes credentials, plugins, model budget and live configuration", () => {
  const env = readinessEnvironment("E:/isolated/readiness", { Path: "fixture-path", SystemRoot: "fixture-system",
    OPENAI_API_KEY: "never-copy", OPENCODE_CONFIG: "live.json", NODE_OPTIONS: "--require=untrusted",
    OPENCODE_AEV_REQUEST_BUDGET_FILE: "private", OPENCODE_AEV_LOCAL_SEARCH_FILE: "private",
    AUTO_EVOLVE_OPENCODE_PRIVATE_PROFILE_ROOT: "live", HTTP_PROXY: "http://credential-proxy" })
  expect(env.Path).toBe("fixture-path")
  expect(env.SystemRoot).toBe("fixture-system")
  for (const key of ["OPENAI_API_KEY", "OPENCODE_CONFIG", "NODE_OPTIONS", "OPENCODE_AEV_REQUEST_BUDGET_FILE",
    "OPENCODE_AEV_LOCAL_SEARCH_FILE", "AUTO_EVOLVE_OPENCODE_PRIVATE_PROFILE_ROOT", "HTTP_PROXY"]) expect(env[key]).toBeUndefined()
  expect(env.OPENCODE_CONFIG_CONTENT).toBe("{}")
  expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe("true")
  expect(env.XDG_CONFIG_HOME).toBe("E:/isolated/readiness/config")
})

test("readiness checks real source entry command with explicit isolated environment and saves bounded evidence", async () => {
  const f = await fixture()
  let calls = 0
  await preflightSourceHost(f, async input => {
    calls++
    expect(input.command).toEqual([process.execPath, "run", "--cwd", "packages/opencode", "--conditions=browser", "src/index.ts", "--help"])
    expect(input.cwd).toBe(f.cwd)
    expect(input.inheritEnv).toBe(false)
    expect(input.timeoutMs).toBe(60000)
    expect(input.env?.HOME).toStartWith(f.evidenceRoot.replaceAll("\\", "/"))
    return reply()
  })
  const saved = JSON.parse(await readFile(path.join(f.evidenceRoot, "source-host-readiness/result.json"), "utf8"))
  expect(calls).toBe(1)
  expect(saved).toMatchObject({ ready: true, exitCode: 0, modelRequests: 0 })
  expect(saved.stdoutSHA256).toMatch(/^[a-f0-9]{64}$/)
})

test("nonzero, timeout and successful exit without help evidence all block", async () => {
  for (const result of [reply({ exitCode: 1, stderr: "Missing dependency" }), reply({ timedOut: true }), reply({ stdout: "" })]) {
    const f = await fixture()
    await expect(preflightSourceHost(f, async () => result)).rejects.toThrow("readiness failed before model request")
    const saved = JSON.parse(await readFile(path.join(f.evidenceRoot, "source-host-readiness/result.json"), "utf8"))
    expect(saved.ready).toBe(false)
  }
})

test("CLI help on stderr is accepted; later readiness preserves previous receipt", async () => {
  const f = await fixture()
  await preflightSourceHost(f, async () => reply({ stdout: "", stderr: "Commands:\nOptions:" }))
  const file = path.join(f.evidenceRoot, "source-host-readiness/result.json")
  const first = JSON.parse(await readFile(file, "utf8"))
  const original = await readFile(first.receipt, "utf8")
  await expect(preflightSourceHost(f, async () => reply({ exitCode: 1 }))).rejects.toThrow("readiness failed")
  const second = JSON.parse(await readFile(file, "utf8"))
  expect(first.ready).toBe(true)
  expect(second.ready).toBe(false)
  expect(second.receipt).not.toBe(first.receipt)
  expect(await readFile(first.receipt, "utf8")).toBe(original)
})

test("managed process isolation actually strips inherited environment; default inheritance remains compatible", async () => {
  const f = await fixture()
  const file = path.join(f.cwd, "inspect-env.mjs")
  await writeFile(file, 'process.stdout.write(JSON.stringify({ inherited: Boolean(process.env.AEV_READINESS_TEST_SENTINEL), explicit: process.env.AEV_EXPLICIT_TEST }))')
  const prior = process.env.AEV_READINESS_TEST_SENTINEL
  process.env.AEV_READINESS_TEST_SENTINEL = "not-a-secret"
  try {
    const input = { title: "Readiness environment isolation fixture", command: [process.execPath, file], cwd: f.cwd,
      env: { ...readinessEnvironment(f.cwd), AEV_EXPLICIT_TEST: "retained" }, timeoutMs: 10000 }
    const isolated = await runManagedProcess({ ...input, inheritEnv: false })
    expect(isolated.exitCode).toBe(0)
    expect(JSON.parse(isolated.stdout)).toEqual({ inherited: false, explicit: "retained" })
    const legacy = await runManagedProcess(input)
    expect(legacy.exitCode).toBe(0)
    expect(JSON.parse(legacy.stdout)).toEqual({ inherited: true, explicit: "retained" })
  } finally {
    if (prior === undefined) delete process.env.AEV_READINESS_TEST_SENTINEL
    else process.env.AEV_READINESS_TEST_SENTINEL = prior
  }
})

test("parallel readiness uses different database roots and errors retain their own receipt", async () => {
  const f = await fixture()
  const homes: string[] = []
  let count = 0
  const results = await Promise.allSettled(Array.from({length: 3}, () => preflightSourceHost(f, async input => {
    homes.push(input.env!.HOME!)
    const fail = count++ === 0
    await new Promise(resolve => setTimeout(resolve, fail ? 5 : 20))
    return reply(fail ? {exitCode: 1, stderr: "fixture database collision"} : {})
  })))
  expect(new Set(homes).size).toBe(3)
  const failure = results.find(item => item.status === "rejected") as PromiseRejectedResult
  const file = failure.reason.message.split("inspect ")[1]
  expect(file).toContain("attempt-")
  expect(JSON.parse(await readFile(file, "utf8")).ready).toBe(false)
  expect(JSON.parse(await readFile(path.join(f.evidenceRoot, "source-host-readiness/result.json"), "utf8")).ready).toBe(true)
})
