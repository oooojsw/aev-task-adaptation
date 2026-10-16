import { expect, test } from "bun:test"
import { mkdtemp, writeFile, readdir, readFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { bindPlan } from "./binding"
import { authorizeInvocation, type Invocation } from "./invocation"
import { runProtocolTrainingTask } from "../protocol-plugins/training-invocation"
import type { Plan } from "./plan"
import type { OpencodeTaskInput, OpencodeTaskRun } from "../opencode"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-task-invocation-"))
  await writeFile(path.join(root, "report.md"), "DRAFT")
  await writeFile(path.join(root, "source.txt"), "VISIBLE_SOURCE")
  await writeFile(path.join(root, "private.txt"), "SECRET_LABEL")
  const plan: Plan = {
    schema: "aev.task-plan.v1", id: "report", objective: "Write a report supported by evidence",
    deliverable: { kind: "report", entries: ["candidate"] }, capabilities: ["files"], workers: [],
    resources: [
      { id: "candidate", path: "report.md", audience: "public", mutable: true },
      { id: "source", path: "source.txt", audience: "public", mutable: false },
      { id: "rubric", path: "private.txt", audience: "private", mutable: false },
    ],
    windows: [
      { role: "lead", stage: "revise", reads: ["candidate", "source"], writes: ["candidate"], inline: [], actions: ["read", "edit"] },
      { role: "checker", stage: "accept", reads: ["candidate", "rubric"], writes: [], inline: [], actions: ["read"] },
    ],
    acceptance: { execution: "none", checks: [{ id: "support", target: "candidate", mechanism: "judge", purpose: "Check evidence", required: true, resources: ["candidate", "rubric"], feedback: "status_only" }] },
    rejection: [{ check: "support", actions: ["research"] }], selection: { rule: "first_pass" },
    stop: { rounds: 2, calls: 10, tokens: 10000, stagnant: 1 },
  }
  const request = { cwd: root, title: "Legacy contaminated request", config: {}, prompt: "SECRET_LABEL forbidden old context",
    referencePaths: [path.join(root, "private.txt")], attachedFiles: [path.join(root, "private.txt")],
    promptInlineFiles: [path.join(root, "private.txt")], permissionReadPaths: [root], permissionEditPaths: [root], allowShell: true,
  } as OpencodeTaskInput
  const bind = async () => bindPlan(root, plan, ["files"])
  const input: Invocation = { bound: await bind(), role: "lead", stage: "revise", output: "Update the candidate and return JSON with summary and updated_files.", maxInlineBytes: 1000 }
  return { root, plan, request, input, bind }
}

test("adaptation rebuilds actual backend context and file grants, not only prompt advice", async () => {
  const f = await fixture()
  const prepared = await authorizeInvocation(f.input, f.request)
  expect(prepared.request.allowShell).toBe(false)
  expect(prepared.request.config.permissionConfig.mode).toBe("restricted")
  expect(prepared.request.infrastructureAttempts).toBe(1)
  expect(prepared.request.isolateHostRuntime).toBe(true)
  expect(prepared.request.attachedFiles).toEqual([])
  expect(prepared.request.promptInlineFiles).toEqual([])
  expect(prepared.request.permissionReadPaths).toHaveLength(2)
  expect(prepared.request.permissionEditPaths).toEqual([path.join(f.root, "report.md").replaceAll("\\", "/")])
  expect(prepared.request.prompt).not.toContain("SECRET_LABEL")
  expect(prepared.request.prompt).not.toContain("private.txt")
  expect(prepared.request.prompt).not.toContain("VISIBLE_SOURCE")
  expect(prepared.request.prompt).not.toContain("reusable guidance")
})

test("explicit inline is bounded by actual UTF-8 bytes", async () => {
  const f = await fixture()
  f.plan.windows[0].inline = ["source"]
  f.input.bound = await f.bind()
  expect((await authorizeInvocation(f.input, f.request)).request.prompt).toContain("VISIBLE_SOURCE")
  f.input.maxInlineBytes = 2
  await expect(authorizeInvocation(f.input, f.request)).rejects.toThrow("context budget")
})

test("missing restricted tools stop before model invocation", async () => {
  const f = await fixture()
  f.plan.windows[0].actions.push("execute")
  f.input.bound = await f.bind()
  let calls = 0
  await expect(runProtocolTrainingTask({ enabled: true, stageDir: f.root, role: "lead", adaptation: f.input }, f.request,
    async () => { calls++; throw new Error("must not run") })).rejects.toThrow("adapter unavailable")
  expect(calls).toBe(0)
})

test("real shared training wrapper passes only adapted grants and records the window", async () => {
  const f = await fixture()
  const result = { selectedModel: "fixture/model", result: { events: [], exitCode: 0 } } as unknown as OpencodeTaskRun
  let seen: OpencodeTaskInput | undefined
  expect(await runProtocolTrainingTask({ enabled: true, stageDir: f.root, role: "lead", adaptation: f.input }, f.request,
    async request => { seen = request; return result })).toBe(result)
  expect(seen!.allowShell).toBe(false)
  expect(seen!.permissionReadPaths).not.toContain(f.root)
  const dir = path.join(f.root, "protocol-invocations", (await readdir(path.join(f.root, "protocol-invocations")))[0])
  const receipt = JSON.parse(await readFile(path.join(dir, "task-window.json"), "utf8"))
  expect(receipt.planFingerprint).toBe(f.input.bound.fingerprint)
  expect(receipt.window.reads.map((item: { id: string }) => item.id)).toEqual(["candidate", "source"])
})

test("legacy invocation remains byte-identical when no new protocol is enabled", async () => {
  const f = await fixture()
  await runProtocolTrainingTask({ enabled: false, stageDir: f.root, role: "lead" }, f.request, async request => {
    expect(request).toBe(f.request)
    return {} as OpencodeTaskRun
  })
  await expect(runProtocolTrainingTask({ enabled: false, stageDir: f.root, role: "lead", adaptation: f.input }, f.request,
    async () => ({} as OpencodeTaskRun))).rejects.toThrow("requires protocol")
})

test("lead writes the current pass candidate, not the initial seed", async () => {
  const f = await fixture()
  const root = path.join(f.root, "pass-2")
  await mkdir(root)
  await writeFile(path.join(root, "report.md"), "LATEST_CANDIDATE")
  f.input.candidate = { root, entries: [{ id: "candidate", path: "report.md" }] }
  const result = await authorizeInvocation(f.input, f.request)
  expect(result.request.permissionEditPaths).toEqual([path.join(root, "report.md").replaceAll("\\", "/")])
  expect(result.request.permissionReadPaths).not.toContain(path.join(f.root, "report.md").replaceAll("\\", "/"))
  expect(result.scope.candidate![0].bytes).toBe(Buffer.byteLength("LATEST_CANDIDATE"))
  f.input.candidate.entries[0].id = "rubric"
  await expect(authorizeInvocation(f.input, f.request)).rejects.toThrow("Unexpected candidate")
})

test("candidate relocation cannot escape or omit declared delivery files", async () => {
  const f = await fixture()
  f.input.candidate = { root: f.root, entries: [{ id: "candidate", path: "../private.txt" }] }
  await expect(authorizeInvocation(f.input, f.request)).rejects.toThrow("Unsafe resource")
  f.input.candidate.entries = []
  await expect(authorizeInvocation(f.input, f.request)).rejects.toThrow("Incomplete candidate")
})
