import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { scriptExecutor } from "./script-executor"
import { scriptChecker } from "./script-checker"
import { selectedRuntime } from "./selected-runtime"
import { builtins } from "./builtins"
import { cachedExecution } from "./cache"
import { compile } from "./compile"
import type { Selection } from "./contract"
import { type Artifact, type Execute } from "./runtime"

const python = "C:/Users/ZhuanZ/miniconda3/python.exe"
const runner = fileURLToPath(new URL("./fixtures/program-runner.py", import.meta.url))
const scorer = fileURLToPath(new URL("./fixtures/program-checker.py", import.meta.url))
const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex")
const artifact = (id: string, value: string): Artifact => ({ id, kind: "text", bytes: Buffer.from(value),
  length: Buffer.byteLength(value), sha256: createHash("sha256").update(value).digest("hex") })
async function fixture(body = "def solve(x):\n    return x * x\n") {
  const root = path.join("E:/project/AEV-task-adaptation-20261016/test-evidence", randomUUID())
  await mkdir(root, { recursive: true })
  const input: Parameters<Execute>[0] = { task: "program", phase: "source",
    skill: [artifact("program", body)], materials: [artifact("cases", "[2,3,4]")],
    settings: { command: python, commandSHA256: await hash(python), script: runner, scriptSHA256: await hash(runner),
      timeoutMs: 10000, maxInputBytes: 65536, maxOutputBytes: 16384, executionBoundary: "trusted_host_runner" } }
  return { root, input, plugin: await scriptExecutor(path.join(root, "execution")) }
}

test("program executor runs actual candidate and saves outputs and measured timing", async () => {
  const { root, input, plugin } = await fixture()
  process.env.AEV_EXECUTOR_TEST_SECRET = "fixture-not-a-credential"
  try {
    const result = await plugin.execute(input)
    expect(result.status).toBe("completed")
    const value = JSON.parse(Buffer.from(result.product!.bytes).toString())
    expect(value.answers).toEqual([4, 9, 16])
    expect(value.elapsed_ns).toBeGreaterThanOrEqual(0)
    expect(value.secret_inherited).toBe(false)
    expect(value.input_keys).toEqual(["candidate", "materials", "phase", "schema", "task"])
    const [id] = await readdir(path.join(root, "execution"))
    const dir = path.join(root, "execution", id)
    expect(path.resolve(value.cwd)).toBe(path.resolve(dir))
    expect(await readFile(path.join(dir, "product.json"), "utf8")).toBe(Buffer.from(result.product!.bytes).toString())
    const evidence = JSON.parse(await readFile(path.join(dir, "process.json"), "utf8"))
    expect(evidence.exitCode).toBe(0)
    expect(evidence.failure).toBeNull()
    expect(evidence.wallMs).toBeGreaterThan(0)
    expect(evidence.executionBoundary).toBe("trusted_host_runner")
  } finally { delete process.env.AEV_EXECUTOR_TEST_SECRET }
})

test("same program result is reused but runner drift blocks reuse", async () => {
  const { root, input, plugin } = await fixture()
  const local = path.join(root, "runner.py")
  await writeFile(local, await readFile(runner))
  input.settings.script = local
  let calls = 0
  const execute = cachedExecution(path.join(root, "cache"), plugin.descriptor,
    async (value) => { calls++; return plugin.execute(value) }, plugin.preflight)
  expect((await execute(input)).reused).toBe(false)
  expect((await execute(input)).reused).toBe(true)
  expect(calls).toBe(1)
  await writeFile(local, "# changed\n")
  await expect(execute(input)).rejects.toThrow("fingerprint changed")
  expect(calls).toBe(1)
})

test("candidate execution failure is not accepted as a product", async () => {
  for (const body of ["raise RuntimeError('fixture')", "print('non-json')\ndef solve(x): return x"]) {
    const { input, plugin } = await fixture(body)
    const result = await plugin.execute(input)
    expect(result.status).toBe("execution_error")
    expect(result.product).toBeUndefined()
  }
})

test("execution bounds stop slow and oversized runs and preserve failure evidence", async () => {
  for (const [body, reason] of [
    ["import time\ntime.sleep(3)\ndef solve(x): return x", "timeout"],
    ["print('x' * 100000)\ndef solve(x): return x", "output_limit"],
  ]) {
    const { root, input, plugin } = await fixture(body)
    input.settings.timeoutMs = reason === "timeout" ? 300 : 10000
    input.settings.maxOutputBytes = 1024
    expect((await plugin.execute(input)).status).toBe("execution_error")
    const [id] = await readdir(path.join(root, "execution"))
    const evidence = JSON.parse(await readFile(path.join(root, "execution", id, "process.json"), "utf8"))
    expect(evidence.failure).toBe(reason)
  }
}, 20000)

test("script executor requires explicit host boundary and immutable runner identity", async () => {
  const { input, plugin } = await fixture()
  delete input.settings.executionBoundary
  expect(() => plugin.descriptor.validate(input.settings)).toThrow("Explicit")
  input.settings.executionBoundary = "os_sandbox"
  expect(() => plugin.descriptor.validate(input.settings)).toThrow("boundary")
  input.settings.executionBoundary = "trusted_host_runner"
  input.settings.scriptSHA256 = "0".repeat(64)
  await expect(plugin.execute(input)).rejects.toThrow("fingerprint changed")
})

test("input byte bound is checked before starting an execution directory", async () => {
  const { root, input, plugin } = await fixture()
  input.settings.maxInputBytes = 1
  await expect(plugin.execute(input)).rejects.toThrow("input exceeds byte budget")
  await expect(readdir(path.join(root, "execution"))).rejects.toThrow()
})

test("legacy builtin registration does not gain program execution implicitly", async () => {
  const { root } = await fixture()
  const old = await builtins(path.join(root, "old"))
  expect(() => old.registry.executor({ id: "script-json-executor", version: "1" })).toThrow("Missing executor")
  const enabled = await builtins(path.join(root, "enabled"), { scriptExecution: true })
  expect(enabled.registry.executor({ id: "script-json-executor", version: "1" }).productKinds).toEqual(["json"])
})

test("real protocol checks correctness separately after actual program execution", async () => {
  const { root, input, plugin } = await fixture()
  const checker = await scriptChecker(path.join(root, "checks"))
  const selection: Selection = { schema: "aev.protocol-plugins.v1",
    project: { id: "program", version: "1", skillFormats: ["text"], productKinds: ["json"], materialKinds: ["text"] },
    run: { skillFormat: "text", productKind: "json", materialKinds: ["text"] },
    protocol: { id: "correct-program", version: "1", phases: { source: { claim: "task_execution",
      executor: { id: plugin.descriptor.id, version: "1", settings: input.settings },
      checks: [{ id: checker.descriptor.id, version: "1", name: "correctness", target: "product", stage: "after_execution",
        mechanism: "script", required: true, privateInputs: ["expected"], settings: {
          command: python, commandSHA256: await hash(python), script: scorer, scriptSHA256: await hash(scorer),
          timeoutMs: 10000, maxOutputBytes: 4096,
        } }],
    } } } }
  const selectionPath = path.join(root, "selection.json")
  await writeFile(selectionPath, JSON.stringify(selection))
  let hostLoads = 0
  const rt = await selectedRuntime(path.join(root, "selected"), undefined, {
    schema: "aev.protocol-entry.v1", selectionPath, projectManifestPath: path.join(root, "project.json"),
    taskID: "program", phase: "source",
  }, async () => { hostLoads++; throw new Error("Script protocol must not load OpenCode") })
  expect(hostLoads).toBe(0)
  for (const [body, status] of [["def solve(x): return x*x", "passed"], ["def solve(x): return x", "rejected"]]) {
    await writeFile(path.join(root, "program.py"), body)
    await writeFile(path.join(root, "cases.json"), "[2,3,4]")
    await writeFile(path.join(root, "expected.json"), "[4,9,16]")
    const receipt = await rt.run(compile(selection, rt.registry), "source", {
      id: "program", skill: [{ id: "program", kind: "text", path: path.join(root, "program.py") }],
      materials: [{ id: "cases", kind: "text", path: path.join(root, "cases.json") }],
      privateInputs: [{ id: "expected", kind: "json", path: path.join(root, "expected.json") }], allowedRoots: [root],
    })
    expect(receipt.status).toBe(status)
    expect(receipt.executed).toBe(true)
    expect(receipt.checks[0].status).toBe(status)
    expect(receipt.product!.kind).toBe("json")
  }
})
