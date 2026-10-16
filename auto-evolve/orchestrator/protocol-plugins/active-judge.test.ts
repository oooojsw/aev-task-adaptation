import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { activeJudge } from "./active-judge"
import type { Artifact, Evaluate } from "./runtime"
import type { InvokeTool } from "./tool-session"
import { selectedRuntime } from "./selected-runtime"
import { compile } from "./compile"

const artifact = (id: string, value: string): Artifact => ({ id, kind: "text", bytes: Buffer.from(value),
  length: Buffer.byteLength(value), sha256: createHash("sha256").update(value).digest("hex") })
async function fixture() {
  const root = path.join("E:/project/AEV-task-adaptation-20261016/test-evidence", randomUUID())
  await mkdir(root, { recursive: true })
  const input: Parameters<Evaluate>[0] = { task: "report", phase: "source", skill: [],
    candidate: [artifact("report", "The measured output is 42.")],
    materials: [artifact("measurement", "Recorded output: 42; sample count: 5.")],
    privateInputs: [artifact("criteria", "Check output and sample count.")],
    check: { name: "source-support", target: "skill", stage: "before_execution", mechanism: "judge" },
    settings: { model: "fixture/checker", expectedModel: "fixture/checker", outputPath: "verdict.json", outputKind: "json",
      maxInputBytes: 10000, maxProductBytes: 4096, timeoutMs: 2000, allowShell: false,
      instruction: "Independently verify that the report's number matches the measured source." } }
  return { root, input }
}

function driver(verdict: unknown, probe?: (request: Parameters<InvokeTool>[0]) => Promise<void>): InvokeTool {
  return async request => {
    await probe?.(request)
    await writeFile(path.join(request.editPaths[0], "verdict.json"), JSON.stringify(verdict))
    return { completed: true, actualModel: "fixture/checker", usage: { inputTokens: 25, outputTokens: 9 } }
  }
}
const supported = { status: "passed", message: "The report matches the declared measurement.",
  evidence: [{ id: "source:measurement", quote: "Recorded output: 42" }] }

test("active judge independently reads selected evidence and cannot edit candidate or source", async () => {
  const { root, input } = await fixture()
  let calls = 0
  const plugin = await activeJudge({ evidenceRoot: root, backendImplementation: "a".repeat(64), invoke: driver(supported, async request => {
    calls++
    expect(request.allowShell).toBe(false)
    expect(request.maxAttempts).toBe(1)
    expect(request.prompt).toContain("not the author or reviewer")
    expect(request.prompt).not.toContain("Recorded output: 42; sample count: 5.")
    const files = await Promise.all(request.readPaths.map(file => readFile(file, "utf8")))
    expect(files).toContain("Recorded output: 42; sample count: 5.")
    expect(files).toContain("Check output and sample count.")
    expect(files).toContain("The measured output is 42.")
    expect(request.editPaths).toHaveLength(1)
    expect(request.editPaths[0].replaceAll("\\", "/")).toEndWith("/sandbox/workspace")
    expect(request.readPaths.some(file => file.startsWith(request.editPaths[0]))).toBe(false)
  }) })
  expect(await plugin.evaluate(input)).toEqual({ status: "passed", message: supported.message,
    usage: { inputTokens: 25, outputTokens: 9 } })
  expect(calls).toBe(1)
})

test("ordinary supported rejection remains rejection, not infrastructure failure", async () => {
  const { root, input } = await fixture()
  const plugin = await activeJudge({ evidenceRoot: root, backendImplementation: "a".repeat(64), invoke: driver({
    ...supported, status: "rejected", message: "Report must include the stated sample count.",
  }) })
  expect((await plugin.evaluate(input)).status).toBe("rejected")
})

test("missing or invented quotes and unknown evidence IDs cannot pass", async () => {
  for (const evidence of [[], [{ id: "source:measurement", quote: "Invented 99" }],
    [{ id: "other-private-file", quote: "Recorded output: 42" }], [{ id: "source:measurement", quote: "" }]]) {
    const { root, input } = await fixture()
    const plugin = await activeJudge({ evidenceRoot: root, backendImplementation: "a".repeat(64),
      invoke: driver({ ...supported, evidence }) })
    expect((await plugin.evaluate(input)).status).toBe("scoring_error")
  }
})

test("missing evidence and unsupported binary inputs block before model invocation", async () => {
  const { root, input } = await fixture()
  let calls = 0
  const plugin = await activeJudge({ evidenceRoot: root, backendImplementation: "a".repeat(64),
    invoke: async () => { calls++; throw new Error("must not invoke") } })
  input.candidate[0].kind = "excel"
  expect((await plugin.evaluate(input)).status).toBe("data_error")
  input.candidate[0].kind = "text"
  input.materials = []; input.privateInputs = []
  expect((await plugin.evaluate(input)).status).toBe("data_error")
  expect(calls).toBe(0)
})

test("active check alone selects a frozen tool host without independent execution", async () => {
  const { root, input } = await fixture()
  const selectionPath = path.join(root, "selection.json")
  await writeFile(selectionPath, JSON.stringify({ schema: "aev.protocol-plugins.v1",
    project: { id: "report", version: "1", skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] },
    run: { skillFormat: "text", productKind: "text", materialKinds: ["text"] },
    protocol: { id: "report", version: "1", phases: { source: { claim: "skill_check", checks: [{
      id: "active-tool-judge", version: "1", name: "source-support", target: "skill", stage: "before_execution",
      required: true, mechanism: "judge", privateInputs: ["criteria"], settings: input.settings,
    }] } } } }))
  let loads = 0
  let invokes = 0
  const runtime = await selectedRuntime(path.join(root, "selected"), root, {
    schema: "aev.protocol-entry.v1", selectionPath, projectManifestPath: path.join(root, "project.json"), taskID: "report", phase: "source",
  }, async () => { loads++; return { implementation: "b".repeat(64), preflight: async () => {},
    invoke: driver(supported, async () => { invokes++ }) } })
  expect(runtime.registry.checker({ id: "active-tool-judge", version: "1" }).mechanisms).toEqual(["judge"])
  expect(loads).toBe(1)
  expect(invokes).toBe(0)
  const selection = JSON.parse(await readFile(selectionPath, "utf8"))
  await writeFile(path.join(root, "report.txt"), "The measured output is 42.")
  await writeFile(path.join(root, "measurement.txt"), "Recorded output: 42; sample count: 5.")
  await writeFile(path.join(root, "criteria.txt"), "Check output and sample count.")
  const receipt = await runtime.run(compile(selection, runtime.registry), "source", {
    id: "report", skill: [{ id: "report", kind: "text", path: path.join(root, "report.txt") }],
    materials: [{ id: "measurement", kind: "text", path: path.join(root, "measurement.txt") }],
    privateInputs: [{ id: "criteria", kind: "text", path: path.join(root, "criteria.txt") }], allowedRoots: [root],
  })
  expect(receipt.status).toBe("passed")
  expect(receipt.executed).toBe(false)
  expect(receipt.checks[0].mechanism).toBe("judge")
  expect(invokes).toBe(1)
})
