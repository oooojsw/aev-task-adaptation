import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { verifyProtocolScopes } from "./protocol-scopes"
import { catalogue, decision } from "./intake-fixture"
import { compileTask } from "./catalogue"
import { loadPack } from "../protocol-plugins/project-pack"
import type { PhaseProtocol } from "../protocol-plugins/contract"

async function fixture(program = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-protocol-scopes-"))
  const input = catalogue()
  for (const resource of input.resources) await writeFile(path.join(root, resource.path), resource.id)
  await writeFile(path.join(root, "other.txt"), "other public file")
  const compiled = compileTask(input, decision(program ? "software" : "report"))
  if (compiled.status !== "ready") throw new Error("Fixture not ready")
  const plan = structuredClone(compiled.plan)
  await writeFile(path.join(root, "project.json"), JSON.stringify({ schema: "aev.project-pack.v1",
    project: { id: "scope", version: "1", skillFormats: ["text"], productKinds: ["text"], materialKinds: ["text"] },
    skill: { format: "text", entries: [{ id: "candidate", kind: "text", path: "delivered.txt" }] },
    tasks: [{ id: "task", split: "train", materials: [{ id: "source", kind: "text", path: "source.txt" }],
      privateInputs: [{ id: "rubric", kind: "text", path: "private.txt" }] }] }))
  const project = await loadPack(path.join(root, "project.json"))
  const protocol: PhaseProtocol = { claim: program ? "task_execution" : "skill_check",
    ...(program ? { executor: { id: "script-json-executor", version: "1", settings: {} },
      executionInputs: { skill: ["candidate"], materials: ["source"] } } : {}),
    checks: [{ id: "checker", version: "1", name: program ? "correctness" : "support", target: program ? "product" : "skill",
      stage: program ? "after_execution" : "before_execution", mechanism: program ? "script" : "judge", required: true,
      skillInputs: ["candidate"], materialInputs: [], privateInputs: ["rubric"], settings: {} }] }
  return { root, plan, project, protocol, run: () => verifyProtocolScopes(plan, root, project, "task", protocol) }
}

test("task check binds exact candidate and criteria without widening public inputs", async () => {
  const item = await fixture()
  await item.run()
  delete item.protocol.checks[0].materialInputs
  await expect(item.run()).rejects.toThrow("scope mismatch")
})

test("task check requires identical physical source file, not just same ID", async () => {
  const item = await fixture()
  item.plan.acceptance.checks[0].resources.push("source")
  item.protocol.checks[0].materialInputs = ["source"]
  await item.run()
  item.plan.resources.find(resource => resource.id === "source")!.path = "other.txt"
  await expect(item.run()).rejects.toThrow("physical input mismatch")
})

test("task feedback permission cannot be widened by protocol checker", async () => {
  const item = await fixture()
  item.protocol.checks[0].feedback = "checker_message"
  await expect(item.run()).rejects.toThrow("scope mismatch")
})

test("script execution uses its own window and rejects wrong backend or private inputs", async () => {
  const item = await fixture(true)
  await item.run()
  item.protocol.executor!.id = "http-text-chat"
  await expect(item.run()).rejects.toThrow("backend mismatch")
  item.protocol.executor!.id = "consolidation-direct-chat"
  await expect(item.run()).rejects.toThrow("backend mismatch")
  item.protocol.executor!.id = "script-json-executor"
  item.plan.windows.find(window => window.role === "independent")!.reads.push("rubric")
  await expect(item.run()).rejects.toThrow("execution input scope mismatch")
})

test("missing execution window cannot silently inherit all public inputs", async () => {
  const item = await fixture(true)
  item.plan.windows = item.plan.windows.filter(window => window.role !== "independent")
  await expect(item.run()).rejects.toThrow("independent input window")
})

test("public protocol material cannot map to private or mutable resource", async () => {
  const item = await fixture()
  item.plan.acceptance.checks[0].resources.push("source")
  item.protocol.checks[0].materialInputs = ["source"]
  item.plan.resources.find(resource => resource.id === "source")!.audience = "private"
  await expect(item.run()).rejects.toThrow("input role mismatch")
})
