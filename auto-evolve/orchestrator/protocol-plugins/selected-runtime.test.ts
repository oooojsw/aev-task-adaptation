import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { selectedRuntime } from "./selected-runtime"
import type { Entry } from "./entry"
import type { Selection } from "./contract"
import type { opencodeDriver } from "./opencode-driver"

async function fixture(tool: boolean) {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(root, { recursive: true })
  const selection: Selection = { schema: "aev.protocol-plugins.v1",
    project: { id: "fixture", version: "1", skillFormats: ["text"], productKinds: ["text"], materialKinds: [] },
    run: { skillFormat: "text", productKind: "text", materialKinds: [] },
    protocol: { id: "fixture", version: "1", phases: { source: { claim: tool ? "task_execution" : "skill_check",
      ...(tool ? { executor: { id: "isolated-tool-session", version: "1", settings: {
        model: "fixture/model", expectedModel: "fixture/model", outputPath: "result.txt", outputKind: "text",
        maxInputBytes: 10000, maxProductBytes: 1000, timeoutMs: 1000, allowShell: false, instruction: "Fixture" } } } : {}),
      checks: [{ id: "script-json-checker", version: "1", name: "check", target: tool ? "product" : "skill",
        stage: tool ? "after_execution" : "before_execution", required: true, mechanism: "script", settings: {
          command: "C:/fixture/python.exe", commandSHA256: "a".repeat(64), script: "C:/fixture/check.py",
          scriptSHA256: "b".repeat(64), timeoutMs: 1000, maxOutputBytes: 1000 } }] } } } }
  const entry: Entry = { schema: "aev.protocol-entry.v1", selectionPath: path.join(root, "selection.json"),
    projectManifestPath: path.join(root, "project.json"), taskID: "fixture", phase: "source" }
  await writeFile(entry.selectionPath, JSON.stringify(selection))
  return { root, entry, selection }
}

test("skill-only selection never loads OpenCode host", async () => {
  const f = await fixture(false)
  let calls = 0
  const factory: typeof opencodeDriver = async () => { calls++; throw new Error("unexpected host") }
  await selectedRuntime(f.root, undefined, f.entry, factory)
  expect(calls).toBe(0)
})

test("valid tool selection assembles frozen host without executing it", async () => {
  const f = await fixture(true)
  let loads = 0
  let checks = 0
  let invokes = 0
  const runtime = await selectedRuntime(f.root, f.root, f.entry, async () => {
    loads++
    return { implementation: "c".repeat(64), preflight: async () => { checks++ },
      invoke: async () => { invokes++; throw new Error("unexpected execution") } }
  })
  expect(runtime.registry.executor({ id: "isolated-tool-session", version: "1" }).implementation).toHaveLength(64)
  expect(loads).toBe(1)
  expect(checks).toBe(1)
  expect(invokes).toBe(0)
})

test("tool mismatch and absent host block before driver creation", async () => {
  const f = await fixture(true)
  let calls = 0
  const factory: typeof opencodeDriver = async () => { calls++; throw new Error("unexpected host") }
  await expect(selectedRuntime(f.root, undefined, f.entry, factory)).rejects.toThrow("Explicit OpenCode host")
  f.selection.protocol.phases.source!.executor!.settings.outputKind = "json"
  await writeFile(f.entry.selectionPath, JSON.stringify(f.selection))
  await expect(selectedRuntime(f.root, f.root, f.entry, factory)).rejects.toThrow("product kind mismatch")
  expect(calls).toBe(0)
})
