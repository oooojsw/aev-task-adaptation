import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { CheckerPlugin, ExecutorPlugin, Selection } from "./contract"
import { compile, verify } from "./compile"
import { canonical, fingerprint } from "./identity"
import { Registry } from "./registry"
import { freeze, resume } from "./snapshot"

const hash = "a".repeat(64)
function executor(): ExecutorPlugin {
  return { id: "text", version: "1", implementation: hash, skillFormats: ["text"], productKinds: ["text"],
    materialKinds: ["text"], validate(settings) {
      if (settings.maxTokens !== 100) throw new Error("Explicit token budget required")
    } }
}
function checker(): CheckerPlugin {
  return { id: "score", version: "1", implementation: hash, targets: ["skill", "product"],
    mechanisms: ["script", "judge"], productKinds: ["text"], validate() {} }
}
function registry() { return new Registry().addExecutor(executor()).addChecker(checker()) }
function selection(): Selection {
  return { schema: "aev.protocol-plugins.v1",
    project: { id: "fixture", version: "1", skillFormats: ["text", "package"], productKinds: ["text", "excel"], materialKinds: ["text", "image"] },
    protocol: { id: "independent", version: "1", phases: { source: {
      claim: "task_execution", executor: { id: "text", version: "1", settings: { maxTokens: 100 } },
      checks: [{ id: "score", version: "1", name: "official", target: "product", stage: "after_execution", required: true, mechanism: "script", settings: {} }],
    } } }, run: { skillFormat: "text", productKind: "text", materialKinds: ["text"] } }
}
function source(value: Selection) { return value.protocol.phases.source! }
function invalid(change: (value: Selection) => void) {
  const value = selection()
  change(value)
  expect(() => compile(value, registry())).toThrow()
}
async function directory() {
  const dir = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(dir, { recursive: true })
  return dir
}

describe("opt-in protocol compiler, offline only", () => {
  test("independent executor and scorer identities frozen", () => {
    const value = selection()
    const snapshot = compile(value, registry())
    expect(snapshot.implementations.executors[0].id).toBe("text")
    expect(snapshot.implementations.checkers[0].id).toBe("score")
    value.project.id = "changed"
    expect(snapshot.selection.project.id).toBe("fixture")
    expect(Object.isFrozen(snapshot.selection.protocol.phases.source!.checks)).toBe(true)
    expect(verify(snapshot, registry())).toEqual(snapshot)
  })
  test("same project supports skill-only protocol without execution claim", () => {
    const value = selection()
    delete source(value).executor
    source(value).claim = "skill_check"
    Object.assign(source(value).checks[0], { target: "skill", stage: "before_execution" })
    expect(compile(value, registry()).implementations.executors).toEqual([])
  })
  test("skill-only protocol rejects executor", () => invalid((value) => { source(value).claim = "skill_check" }))
  test("execution rejects missing executor", () => invalid((value) => { delete source(value).executor }))
  test("execution rejects missing product scoring", () => invalid((value) => {
    Object.assign(source(value).checks[0], { target: "skill", stage: "before_execution" })
  }))
  test("required empty blocks", () => invalid((value) => { source(value).checks = [] }))
  test("optional-only scoring blocks", () => invalid((value) => { source(value).checks[0].required = false }))
  test("unknown executor does not fall back", () => invalid((value) => { source(value).executor!.id = "opencode-default" }))
  test("unknown checker does not fall back", () => invalid((value) => { source(value).checks[0].id = "missing" }))
  test("missing plugin version blocks", () => invalid((value) => { source(value).executor!.version = "" }))
  test("excel cannot silently use text executor", () => invalid((value) => { value.run.productKind = "excel" }))
  test("unsupported skill representation blocks", () => invalid((value) => { value.run.skillFormat = "package" }))
  test("unsupported material blocks", () => invalid((value) => { value.run.materialKinds = ["image"] }))
  test("project/run mismatch blocks", () => invalid((value) => { value.run.productKind = "unknown" }))
  test("duplicate check names block", () => invalid((value) => { source(value).checks.push(structuredClone(source(value).checks[0])) }))
  test("product checks cannot precede execution", () => invalid((value) => { source(value).checks[0].stage = "before_execution" }))
  test("checker mechanism must be supported", () => {
    const item = checker()
    item.mechanisms = ["judge"]
    expect(() => compile(selection(), new Registry().addExecutor(executor()).addChecker(item))).toThrow()
  })
  test("executor validates explicit settings", () => invalid((value) => { source(value).executor!.settings = {} }))
  test("inline secrets forbidden in nested settings", () => invalid((value) => {
    source(value).executor!.settings.extra = { authorization: "synthetic-not-a-secret" }
  }))
  test("credential reference can be frozen", () => {
    const value = selection()
    source(value).executor!.settings.credentialEnv = "AEV_FIXTURE_KEY"
    expect(compile(value, registry()).selection).toEqual(value)
  })
  test("settings NaN blocks", () => invalid((value) => { source(value).executor!.settings.maxTokens = NaN }))
  test("unknown top-level field blocks", () => {
    expect(() => compile({ ...selection(), executorDefault: "legacy" }, registry())).toThrow()
  })
  test("unknown phase blocks", () => {
    const value = selection()
    Object.assign(value.protocol.phases, { misspelled: source(value) })
    expect(() => compile(value, registry())).toThrow()
  })
  test("unknown phase field blocks", () => invalid((value) => { Object.assign(source(value), { requird: true }) }))
  test("canonical identity unaffected by object key ordering", () => {
    expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }))
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }))
  })
  test("unsafe or cyclic JSON blocks", () => {
    expect(() => canonical(JSON.parse('{"__proto__":{}}'))).toThrow()
    const value: Record<string, unknown> = {}
    value.self = value
    expect(() => canonical(value)).toThrow()
    expect(() => canonical(new Date())).toThrow()
  })
  test("duplicate plugin registration blocks", () => {
    expect(() => registry().addExecutor(executor())).toThrow()
    expect(() => registry().addChecker(checker())).toThrow()
  })
  test("plugin implementation fingerprint required", () => {
    expect(() => new Registry().addExecutor({ ...executor(), implementation: "" })).toThrow()
  })
  test("registry capability mutations cannot affect compiled protocol", () => {
    const item = executor()
    const plugins = new Registry().addExecutor(item).addChecker(checker())
    item.productKinds.push("excel")
    expect(plugins.executor(item).productKinds).toEqual(["text"])
    expect(Object.isFrozen(plugins.executor(item))).toBe(true)
  })
  test("tampered snapshot blocks", () => {
    const value = structuredClone(compile(selection(), registry()))
    value.selection.project.id = "tampered"
    expect(() => verify(value, registry())).toThrow()
  })
  test("same version changed implementation blocks recovery", () => {
    const value = compile(selection(), registry())
    const item = executor()
    item.implementation = "b".repeat(64)
    expect(() => verify(value, new Registry().addExecutor(item).addChecker(checker()))).toThrow()
  })
  test("freeze and resume existing snapshot without overwrite", async () => {
    const dir = await directory()
    const value = compile(selection(), registry())
    const first = await freeze(dir, value, registry())
    const original = await readFile(first.file, "utf8")
    expect(first.reused).toBe(false)
    expect((await freeze(dir, value, registry())).reused).toBe(true)
    expect(await resume(dir, registry())).toEqual(value)
    expect(await readFile(first.file, "utf8")).toBe(original)
  })
  test("different protocol cannot replace existing run", async () => {
    const dir = await directory()
    const first = await freeze(dir, compile(selection(), registry()), registry())
    const original = await readFile(first.file, "utf8")
    const value = selection()
    value.protocol.version = "2"
    await expect(freeze(dir, compile(value, registry()), registry())).rejects.toThrow()
    expect(await readFile(first.file, "utf8")).toBe(original)
  })
  test("incomplete claim cannot be automatically resent", async () => {
    const dir = await directory()
    await writeFile(path.join(dir, "protocol.started.claim"), "")
    await expect(freeze(dir, compile(selection(), registry()), registry())).rejects.toThrow("incomplete")
  })
  test("unclaimed snapshot cannot be overwritten", async () => {
    const dir = await directory()
    const file = path.join(dir, "protocol.snapshot.json")
    await writeFile(file, "original")
    await expect(freeze(dir, compile(selection(), registry()), registry())).rejects.toThrow("Unclaimed")
    expect(await readFile(file, "utf8")).toBe("original")
  })
  test("concurrent same snapshot has exactly one owner", async () => {
    const dir = await directory()
    const value = compile(selection(), registry())
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => freeze(dir, value, registry())))
    const owners = results.filter((item) => item.status === "fulfilled" && !item.value.reused)
    expect(owners).toHaveLength(1)
    expect(await resume(dir, registry())).toEqual(value)
    for (const result of results) {
      if (result.status === "rejected") expect(String(result.reason)).toContain("incomplete")
    }
  })
  test("relative snapshot path blocks", async () => {
    await expect(freeze("relative", compile(selection(), registry()), registry())).rejects.toThrow()
    await expect(resume("relative", registry())).rejects.toThrow()
  })
})
