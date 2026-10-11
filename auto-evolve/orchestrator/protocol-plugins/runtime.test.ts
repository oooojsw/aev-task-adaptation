import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { compile } from "./compile"
import type { Selection } from "./contract"
import { Runtime, type Evaluate, type Execute, type Task } from "./runtime"

const hash = "c".repeat(64)
const execute: Execute = async () => ({ status: "completed", product: { kind: "text", bytes: Buffer.from("42") } })
const score: Evaluate = async () => ({ status: "passed", message: "fixture pass" })
function runtime(run: Execute = execute, check: Evaluate = score) {
  return new Runtime().addExecutor({ id: "fixture-executor", version: "1", implementation: hash,
    skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"], validate() {} }, run)
    .addChecker({ id: "fixture-checker", version: "1", implementation: hash, targets: ["skill", "product"],
      mechanisms: ["script", "judge"], productKinds: ["text"], validate() {} }, check)
}
function selection(): Selection {
  return { schema: "aev.protocol-plugins.v1", project: { id: "runtime-fixture", version: "1", skillFormats: ["text"],
    productKinds: ["text"], materialKinds: ["text"] }, protocol: { id: "runtime-protocol", version: "1", phases: {
      source: { claim: "task_execution", executor: { id: "fixture-executor", version: "1", settings: {} },
        checks: [{ id: "fixture-checker", version: "1", name: "product-score", target: "product", stage: "after_execution",
          mechanism: "script", required: true, privateInputs: ["gold"], settings: {} }] },
    } }, run: { skillFormat: "text", productKind: "text", materialKinds: ["text"] } }
}
async function task(): Promise<Task> {
  const dir = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "skill.txt"), "Use provided material")
  await writeFile(path.join(dir, "material.txt"), "Public source")
  await writeFile(path.join(dir, "gold.txt"), "42")
  return { id: "fixture-task", skill: [{ id: "skill", kind: "text", path: path.join(dir, "skill.txt") }],
    materials: [{ id: "source", kind: "text", path: path.join(dir, "material.txt") }],
    privateInputs: [{ id: "gold", kind: "text", path: path.join(dir, "gold.txt") }], allowedRoots: [dir] }
}

test("execution receives only public inputs; scorer binds actual answer and selected oracle", async () => {
  const rt = runtime(async (input) => {
    expect(Object.keys(input).sort()).toEqual(["materials", "phase", "settings", "skill", "task"])
    expect(input.materials).toHaveLength(1)
    expect(Buffer.from(input.skill[0].bytes).toString()).toBe("Use provided material")
    return execute(input)
  }, async (input) => {
    expect(input.candidate).toHaveLength(1)
    expect(Buffer.from(input.candidate[0].bytes).toString()).toBe("42")
    expect(input.privateInputs.map((item) => item.id)).toEqual(["gold"])
    return score(input)
  })
  const receipt = await rt.run(compile(selection(), rt.registry), "source", await task())
  expect(receipt.status).toBe("passed")
  expect(receipt.executed).toBe(true)
  expect(receipt.product?.length).toBe(2)
  expect(receipt.evidence.skill[0].sha256).toHaveLength(64)
})

test("skill-only protocol never calls executor or claims execution", async () => {
  let calls = 0
  const rt = runtime(async (input) => { calls++; return execute(input) })
  const value = selection()
  const plan = value.protocol.phases.source!
  delete plan.executor
  plan.claim = "skill_check"
  Object.assign(plan.checks[0], { target: "skill", stage: "before_execution", privateInputs: [] })
  const result = await rt.run(compile(value, rt.registry), "source", await task())
  expect(result.status).toBe("passed")
  expect(result.executed).toBe(false)
  expect(result.claim).toBe("skill_check")
  expect(calls).toBe(0)
})

test("precheck rejection stops execution and routes normal rejection", async () => {
  let calls = 0
  const rt = runtime(async (input) => { calls++; return execute(input) }, async () => ({ status: "rejected", message: "skill issue" }))
  const value = selection()
  value.protocol.phases.source!.checks.unshift({ ...value.protocol.phases.source!.checks[0], name: "surface",
    target: "skill", stage: "before_execution", privateInputs: [] })
  const result = await rt.run(compile(value, rt.registry), "source", await task())
  expect(result.status).toBe("rejected")
  expect(result.executed).toBe(false)
  expect(calls).toBe(0)
})

test("executor transport failure is not Skill rejection", async () => {
  let calls = 0
  const rt = runtime(async () => { throw new Error("synthetic transport failure") }, async (input) => { calls++; return score(input) })
  const result = await rt.run(compile(selection(), rt.registry), "source", await task())
  expect(result.status).toBe("execution_error")
  expect(calls).toBe(0)
})

test("missing execution output cannot pass", async () => {
  const rt = runtime(async () => ({ status: "completed" }))
  expect((await rt.run(compile(selection(), rt.registry), "source", await task())).status).toBe("execution_error")
})

test("empty execution output cannot pass", async () => {
  const rt = runtime(async () => ({ status: "completed", product: { kind: "text", bytes: new Uint8Array() } }))
  expect((await rt.run(compile(selection(), rt.registry), "source", await task())).status).toBe("execution_error")
})

test("scorer exception is not Skill rejection", async () => {
  const rt = runtime(execute, async () => { throw new Error("synthetic scoring failure") })
  expect((await rt.run(compile(selection(), rt.registry), "source", await task())).status).toBe("scoring_error")
})

test("ordinary product rejection remains rejection", async () => {
  const rt = runtime(execute, async () => ({ status: "rejected", message: "wrong answer" }))
  expect((await rt.run(compile(selection(), rt.registry), "source", await task())).status).toBe("rejected")
})

test("optional rejection is recorded but does not block required pass", async () => {
  const rt = runtime(execute, async (input) => input.check.name === "advisory"
    ? { status: "rejected", message: "optional" } : score(input))
  const value = selection()
  value.protocol.phases.source!.checks.push({ ...value.protocol.phases.source!.checks[0], name: "advisory", required: false })
  const result = await rt.run(compile(value, rt.registry), "source", await task())
  expect(result.status).toBe("passed")
  expect(result.checks.find((item) => item.name === "advisory")?.status).toBe("rejected")
})

test("missing private binding blocks before paid execution", async () => {
  let calls = 0
  const rt = runtime(async (input) => { calls++; return execute(input) })
  const input = await task()
  input.privateInputs = []
  await expect(rt.run(compile(selection(), rt.registry), "source", input)).rejects.toThrow("Missing declared private")
  expect(calls).toBe(0)
})

test("undeclared phase does not fall back", async () => {
  const rt = runtime()
  await expect(rt.run(compile(selection(), rt.registry), "test", await task())).rejects.toThrow("Undeclared phase")
})

test("path outside declared roots blocked", async () => {
  const rt = runtime()
  const input = await task()
  input.skill[0].path = path.resolve("auto-evolve/orchestrator/protocol-plugins/runtime.ts")
  await expect(rt.run(compile(selection(), rt.registry), "source", input)).rejects.toThrow("outside")
})

test("executing adapter cannot mutate originals used by scoring", async () => {
  const rt = runtime(async (input) => {
    input.skill[0].bytes.fill(0)
    return execute(input)
  }, async (input) => {
    expect(Buffer.from(input.skill[0].bytes).toString()).toBe("Use provided material")
    return score(input)
  })
  expect((await rt.run(compile(selection(), rt.registry), "source", await task())).status).toBe("passed")
})
