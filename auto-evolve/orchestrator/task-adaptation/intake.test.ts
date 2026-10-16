import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { prepareTask, type IntakeInput } from "./intake"
import { catalogue, decision } from "./intake-fixture"
import type { ToolRequest } from "../protocol-plugins/tool-session"

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aev-intake-"))
  const root = path.join(dir, "materials")
  await mkdir(root)
  for (const [name, value] of [["candidate.txt", "Initial candidate"], ["source.txt", "PUBLIC_EVIDENCE"], ["private.txt", "PRIVATE_INTAKE_LABEL"]]) await writeFile(path.join(root, name), value)
  const input: IntakeInput = { cwd: dir, root, dir: path.join(dir, "run"), catalogue: catalogue(),
    model: "fixture/planner", expectedModel: "fixture/planner", timeoutMs: 2000, maxInputBytes: 100000, maxDecisionBytes: 16000 }
  const requests: ToolRequest[] = []
  let reply = { completed: true, actualModel: "fixture/planner" }
  let choice: unknown = decision()
  const dependencies = { createDriver: async () => ({ implementation: "a".repeat(64), preflight: async () => {},
    invoke: async (request: ToolRequest) => {
      requests.push(request)
      await writeFile(request.editPaths[0], JSON.stringify(choice))
      return reply
    } }) }
  return { input, requests, dependencies, choose(value: unknown) { choice = value }, reply(value: typeof reply) { reply = value } }
}

test("natural-language intake writes a frozen usable plan and resumes without another model invocation", async () => {
  const f = await fixture()
  const result = await prepareTask(f.input, f.dependencies)
  expect(result.status).toBe("ready")
  expect(result.reused).toBe(false)
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0].allowShell).toBe(false)
  expect(f.requests[0].readPaths).not.toContain(path.join(f.input.root, "private.txt"))
  expect(f.requests[0].editPaths).toEqual([path.join(f.input.dir, "workspace/decision.json")])
  expect(f.requests[0].prompt).not.toContain("PRIVATE_INTAKE_LABEL")
  expect(f.requests[0].prompt).toContain(path.join(f.input.root, "source.txt").replaceAll("\\", "/"))
  if (result.status !== "ready") throw new Error("Expected ready fixture")
  expect(JSON.parse(await readFile(result.planPath!, "utf8")).objective).toBe(f.input.catalogue.request)
  expect((await prepareTask(f.input, f.dependencies)).reused).toBe(true)
  expect(f.requests).toHaveLength(1)
})

test("missing capability is a persisted outcome, not automatic replacement or another interpretation call", async () => {
  const f = await fixture()
  f.choose(decision("software"))
  f.input.catalogue.capabilities.find(item => item.id === "program")!.available = false
  expect(await prepareTask(f.input, f.dependencies)).toMatchObject({ status: "missing_capabilities", missing: ["program"] })
  expect((await prepareTask(f.input, f.dependencies)).reused).toBe(true)
  expect(f.requests).toHaveLength(1)
})

test("wrong model and invalid interpretation retain failure and never resend during recovery", async () => {
  for (const invalid of ["model", "decision"] as const) {
    const f = await fixture()
    if (invalid === "model") f.reply({ completed: true, actualModel: "unexpected/model" })
    else f.choose({ ...decision(), profiles: ["made-up"] })
    await expect(prepareTask(f.input, f.dependencies)).rejects.toThrow()
    await expect(prepareTask(f.input, f.dependencies)).rejects.toThrow("failed; inspect")
    expect(f.requests).toHaveLength(1)
    expect(JSON.parse(await readFile(path.join(f.input.dir, "intake.failure.json"), "utf8")).status).toBe("incomplete")
  }
})

test("request, source, limits and plan drift block reuse without another model call", async () => {
  for (const change of ["request", "source", "limits", "plan", "receipt"] as const) {
    const f = await fixture()
    await prepareTask(f.input, f.dependencies)
    if (change === "request") f.input.catalogue.request = "An actually different task"
    if (change === "source") await writeFile(path.join(f.input.root, "source.txt"), "Changed evidence")
    if (change === "limits") f.input.timeoutMs++
    if (change === "plan") await writeFile(path.join(f.input.dir, "task-plan.json"), "{}")
    if (change === "receipt") await writeFile(path.join(f.input.dir, "intake.backend-result.json"), '{"completed":true,"actualModel":"fake"}')
    await expect(prepareTask(f.input, f.dependencies)).rejects.toThrow("drift")
    expect(f.requests).toHaveLength(1)
  }
})

test("input budget and unsafe output layout fail before backend construction", async () => {
  const f = await fixture()
  f.input.maxInputBytes = 1
  await expect(prepareTask(f.input, { createDriver: async () => { throw new Error("Should not construct backend") } })).rejects.toThrow("byte budget")
  expect(f.requests).toHaveLength(0)
  f.input.dir = path.join(f.input.root, "outputs")
  await expect(prepareTask(f.input, f.dependencies)).rejects.toThrow("outside task materials")
})

test("incomplete claim is never silently regenerated", async () => {
  const f = await fixture()
  await mkdir(f.input.dir)
  await writeFile(path.join(f.input.dir, "intake.started.claim"), "")
  await expect(prepareTask(f.input, f.dependencies)).rejects.toThrow()
  expect(f.requests).toHaveLength(0)
})

test("opt-in decision repair only corrects a completed invalid proposal and preserves each reply", async () => {
  const f = await fixture()
  f.input.maxDecisionRepairs = 1
  let calls = 0
  const dependencies = { createDriver: async () => ({ implementation: "a".repeat(64), preflight: async () => {},
    invoke: async (request: ToolRequest) => {
      calls++
      const value = decision()
      if (calls === 1) value.workers[0].resources = ["invented-resource"]
      else {
        expect(request.prompt).toContain("Platform decision validation rejected")
        expect(request.prompt).toContain("do not imply missing author capabilities")
      }
      await writeFile(request.editPaths[0], JSON.stringify(value))
      return { completed: true, actualModel: "fixture/planner" }
    } }) }
  expect((await prepareTask(f.input, dependencies)).status).toBe("ready")
  expect(calls).toBe(2)
  expect(await readFile(path.join(f.input.dir, "decision-attempts/1/decision.json"), "utf8")).toContain("invented-resource")
  expect(await readFile(path.join(f.input.dir, "decision-attempts/1/validation.json"), "utf8")).toContain("invalid_decision")
  expect(await readFile(path.join(f.input.dir, "decision-attempts/2/decision.json"), "utf8")).not.toContain("invented-resource")
  expect((await prepareTask(f.input, dependencies)).reused).toBe(true)
  expect(calls).toBe(2)
})

test("decision repair never retries incomplete backend responses and invalid caps block before construction", async () => {
  const f = await fixture()
  f.input.maxDecisionRepairs = 2
  f.reply({ completed: false, actualModel: "fixture/planner" })
  await expect(prepareTask(f.input, f.dependencies)).rejects.toThrow("incomplete")
  expect(f.requests).toHaveLength(1)
  const other = await fixture()
  other.input.maxDecisionRepairs = 3
  await expect(prepareTask(other.input, { createDriver: async () => { throw new Error("Should not construct driver") } })).rejects.toThrow("bounded task intake")
})

test("bounded invalid decision repairs stop and cannot be silently restarted", async () => {
  const f = await fixture()
  f.input.maxDecisionRepairs = 1
  f.choose({ ...decision(), profiles: ["nonexistent"] })
  await expect(prepareTask(f.input, f.dependencies)).rejects.toThrow()
  expect(f.requests).toHaveLength(2)
  await expect(prepareTask(f.input, f.dependencies)).rejects.toThrow("failed; inspect")
  expect(f.requests).toHaveLength(2)
})
