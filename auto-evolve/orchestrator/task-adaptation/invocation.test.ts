import { expect, test } from "bun:test"
import { mkdtemp, writeFile, readdir, readFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { bindPlan } from "./binding"
import { authorizeInvocation, type Invocation } from "./invocation"
import { runProtocolTrainingTask } from "../protocol-plugins/training-invocation"
import type { Plan } from "./plan"
import type { OpencodeTaskInput, OpencodeTaskRun } from "../opencode"
import { searchLocalFiles } from "./local-search"
import { recompute } from "./recompute"
import { taskInvocation } from "./context"
import type { LongTaskSpec } from "../long-task/contract"
import { publishWorkerAnswer } from "../long-task-campaign/worker-answer"

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

test("explicit stage authorization cannot silently fall back to the legacy path", () => {
  const legacy = {} as LongTaskSpec
  expect(taskInvocation(legacy, "lead")).toBeUndefined()
  for (const requestGate of ["a".repeat(64), "invalid"]) {
    expect(() => taskInvocation(legacy, "lead", { requestGate })).toThrow("bounded transport")
  }
})

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

test("adapted role derives private request budget from its own frozen task policy", async () => {
  const f = await fixture()
  const ledger = await mkdtemp(path.join(os.tmpdir(), "aev-role-budget-"))
  f.request.model = "fixture/model"
  f.input.requestBudget = { schema: "aev.task-budget-policy.v1", root: ledger, scope: "task",
    models: [{ model: "fixture/model", expectedModels: ["wire-model"], dialect: "openai_chat", maxInputTokens: 1000, maxOutputTokens: 100 }] }
  const ready = await authorizeInvocation(f.input, f.request)
  expect(ready.request.requestBudget).toMatchObject({ role: "lead", budget: { root: ledger, calls: 10, tokens: 10000 } })
  expect(ready.request.prompt).not.toContain(ledger)
  expect(ready.request.permissionReadPaths).not.toContain(ledger)
  f.input.requestGate = "b".repeat(64)
  const gated = await authorizeInvocation(f.input, f.request)
  expect(gated.request.requestBudget?.gate).toBe("b".repeat(64))
  expect(gated.request.prompt).not.toContain("b".repeat(64))
  expect(gated.request.permissionReadPaths).toEqual(ready.request.permissionReadPaths)
  f.input.requestBudget.root = f.root
  await expect(authorizeInvocation(f.input, f.request)).rejects.toThrow("outside model materials")
  f.input.requestBudget = undefined
  await expect(authorizeInvocation(f.input, f.request)).rejects.toThrow("bounded transport")
  f.input.requestGate = undefined
  f.request.requestBudget = ready.request.requestBudget
  expect((await authorizeInvocation(f.input, f.request)).request.requestBudget).toBeUndefined()
})

test("search action binds only actual role resources and the training ledger supplies durable evidence", async () => {
  const f = await fixture()
  f.plan.windows[0].actions.push("search")
  f.input.bound = await f.bind()
  const prepared = await authorizeInvocation(f.input, f.request)
  expect(prepared.request.localSearch?.resources.map(item => item.id)).toEqual(["candidate", "source"])
  expect(prepared.request.prompt).toContain("not a web search")
  const stageDir = path.join(f.root, "stage")
  let invoked = false
  await runProtocolTrainingTask({ enabled: true, stageDir, role: "lead", adaptation: f.input }, f.request, async request => {
    invoked = true
    expect(request.allowShell).toBe(false)
    const result = await searchLocalFiles({ ...request.localSearch!, evidenceRoot: request.localSearchEvidenceRoot! }, { query: "VISIBLE_SOURCE" })
    expect(result.matches[0].resource).toBe("source")
    expect(JSON.stringify(result)).not.toContain("SECRET_LABEL")
    return { result: { exitCode: 0, events: [] } } as unknown as OpencodeTaskRun
  })
  expect(invoked).toBe(true)
  expect((await readdir(path.join(stageDir, "protocol-invocations")))).toHaveLength(1)
  f.plan.windows[0].actions = ["read", "edit"]
  f.input.bound = await f.bind()
  f.request.localSearch = prepared.request.localSearch
  expect((await authorizeInvocation(f.input, f.request)).request.localSearch).toBeUndefined()
})

test("review advice is opt-in, on-demand and never grants its embedded references", async () => {
  const f = await fixture()
  f.plan.windows[0].runtime = ["review"]
  f.input.bound = await f.bind()
  const directory = path.join(f.root, "rounds/round-001/reviewer/pass-01")
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, "review-suggestion.json")
  await writeFile(file, JSON.stringify({ roundNumber: 1, readyForFinalAcceptance: true, summary: "ADVICE_ONLY",
    reasons: ["Check source support"], nextAttentionAreas: ["Recompute figure"],
    responsePath: path.join(f.root, "private.txt"), refs: ["SECRET_LABEL"] }))
  f.input.advice = [{ root: f.root, path: file, kind: "review" }]
  const prepared = await authorizeInvocation(f.input, f.request)
  const advice = prepared.scope.advice![0]
  expect(prepared.request.permissionReadPaths).toContain(advice.path)
  expect(prepared.request.permissionReadPaths).not.toContain(file)
  expect(prepared.request.permissionReadPaths).not.toContain(path.join(f.root, "private.txt"))
  expect(prepared.request.prompt).not.toContain("ADVICE_ONLY")
  const view = JSON.parse(await readFile(advice.path, "utf8"))
  expect(view.advisoryOnly).toBe(true)
  expect(view.content.summary).toBe("ADVICE_ONLY")
  expect(JSON.stringify(view)).not.toContain("SECRET_LABEL")
  expect(JSON.stringify(view)).not.toContain("private.txt")
  expect(JSON.stringify(view)).not.toContain("responsePath")
  expect(prepared.request.permissionEditPaths).not.toContain(advice.path)
  await writeFile(advice.path, JSON.stringify({ ...view, advisoryOnly: false }))
  await expect(authorizeInvocation(f.input, f.request)).rejects.toThrow("Published task advice drift")
})

test("complete Worker prose reaches Lead across rounds, retry and candidate relocation without JSON extraction", async () => {
  const f = await fixture()
  f.plan.workers = [{ id: "sources", purpose: "Analyze", resources: ["source"], actions: ["read"] }]
  f.plan.windows.push({ role: "worker", stage: "explore", reads: ["source"], writes: [], inline: [], actions: ["read"] })
  f.plan.windows[0].runtime = ["analysis"]
  f.input.bound = await f.bind()
  const body = '# Full analysis\n{"summary":""}\n' + "Evidence, uncertainty and advice.\n".repeat(3000)
  for (const round of [1, 7]) {
    const dir = path.join(f.root, `rounds/round-${String(round).padStart(3, "0")}/workers/task-sources`)
    await mkdir(dir, { recursive: true })
    const finalAnswer = await publishWorkerAnswer(dir, { exitCode: 0, sessionID: "s", events: [
      { type: "assistant_message", message: { id: "final", role: "assistant", summary: false } },
      { type: "text", sessionID: "s", part: { messageID: "final", text: body } },
      { type: "step_finish", part: { messageID: "final", reason: "stop" } },
    ] } as OpencodeTaskRun["result"])
    const file = path.join(dir, "suggestion.json")
    await writeFile(file, JSON.stringify({ roundNumber: round, role: "task-sources", finalAnswer,
      summary: "EMPTY_JSON_MUST_NOT_REPLACE_PROSE", refs: [path.join(f.root, "private.txt")] }))
    f.input.advice = [{ root: f.root, path: file, kind: "analysis" }]
    for (const pass of [1, 2]) {
      f.input.passID = `pass-${pass}`
      const candidate = path.join(f.root, `candidate-${round}-${pass}`)
      await mkdir(candidate)
      await writeFile(path.join(candidate, "report.md"), "NEW_BRANCH_CANDIDATE")
      f.input.candidate = { root: candidate, entries: [{ id: "candidate", path: "report.md" }] }
      const prepared = await authorizeInvocation(f.input, f.request)
      const advice = prepared.scope.advice![0]
      expect(advice.path.endsWith(".txt")).toBe(true)
      expect(await readFile(advice.path, "utf8")).toBe(body)
      expect(prepared.request.permissionReadPaths).toContain(advice.path)
      expect(prepared.request.permissionReadPaths).not.toContain(path.join(f.root, "private.txt"))
      expect(prepared.request.permissionEditPaths).not.toContain(advice.path)
      expect(prepared.request.prompt).toContain("complete final Worker answers")
    }
    const diagnosis = path.join(f.root, `rounds/round-${String(round).padStart(3, "0")}/workers/blank_acceptance_diagnostician/previous-pass-02`)
    await mkdir(diagnosis, { recursive: true })
    await writeFile(path.join(diagnosis, "final-answer.txt"), body)
    const metadata = path.join(diagnosis, "suggestion.json")
    await writeFile(metadata, JSON.stringify({ roundNumber: round, role: "blank_acceptance_diagnostician", finalAnswer }))
    f.input.advice = [{ root: f.root, path: metadata, kind: "analysis" }]
    const restored = await authorizeInvocation(f.input, f.request)
    expect(await readFile(restored.scope.advice![0].path, "utf8")).toBe(body)
    f.input.advice = [{ root: f.root, path: file, kind: "analysis" }]
    await writeFile(path.join(dir, "final-answer.txt"), "TAMPERED")
    await expect(authorizeInvocation(f.input, f.request)).rejects.toThrow("fingerprint drift")
  }
})

test("three analysis workers retain distinct scopes and authorship boundaries across candidate relocation", async () => {
  const f = await fixture()
  f.plan.objective = "Merge all source Skills into a complete Skill"
  f.plan.deliverable.kind = "skill"
  f.plan.resources.push({ id: "other", path: "other.txt", audience: "training", mutable: false })
  await writeFile(path.join(f.root, "other.txt"), "SECOND_SOURCE")
  f.plan.workers = [
    { id: "sources", purpose: "Analyze first source only; no full draft", resources: ["source"], actions: ["read"] },
    { id: "coverage", purpose: "Analyze second source only; no full draft", resources: ["other"], actions: ["read"] },
    { id: "feedback", purpose: "Analyze candidate constraints; no full draft", resources: ["candidate"], actions: ["read"] },
  ]
  f.plan.windows.push({ role: "worker", stage: "explore", reads: ["candidate", "source", "other"], writes: [], inline: [], actions: ["read"] })
  f.plan.windows[0].runtime = ["analysis"]
  f.input.bound = await f.bind()
  for (const round of [1, 8]) {
    const candidate = path.join(f.root, `worker-candidate-${round}`)
    await mkdir(candidate)
    await writeFile(path.join(candidate, "report.md"), "CURRENT")
    const advice = []
    for (const worker of f.plan.workers) {
      const prepared = await authorizeInvocation({ ...f.input, role: "worker", stage: "explore", worker: worker.id,
        output: "Return complete analysis", candidate: { root: candidate, entries: [{ id: "candidate", path: "report.md" }] } }, f.request)
      expect(prepared.request.prompt).toContain("You are not the final author")
      expect(prepared.request.prompt).toContain(worker.purpose)
      expect(prepared.request.prompt).not.toContain("Produce reusable guidance;")
      expect(prepared.request.permissionEditPaths).toEqual([])
      expect(prepared.request.permissionReadPaths).toHaveLength(1)
      const dir = path.join(f.root, `rounds/round-${String(round).padStart(3, "0")}/workers/task-${worker.id}`)
      await mkdir(dir, { recursive: true })
      const body = `Complete ${worker.id} analysis for round ${round}`
      const finalAnswer = await publishWorkerAnswer(dir, { exitCode: 0, sessionID: worker.id, events: [
        { type: "assistant_message", message: { id: "final", role: "assistant", summary: false } },
        { type: "text", sessionID: worker.id, part: { messageID: "final", text: body } },
        { type: "step_finish", part: { messageID: "final", reason: "stop" } },
      ] } as OpencodeTaskRun["result"])
      const file = path.join(dir, "suggestion.json")
      await writeFile(file, JSON.stringify({ roundNumber: round, role: `task-${worker.id}`, finalAnswer }))
      advice.push({ root: f.root, path: file, kind: "analysis" as const })
    }
    const lead = await authorizeInvocation({ ...f.input, advice }, f.request)
    expect(lead.scope.advice).toHaveLength(3)
    for (const item of lead.scope.advice!) expect(await readFile(item.path, "utf8")).toContain(`round ${round}`)
    expect(lead.request.prompt).not.toContain("You are not the final author")
  }
})

test("complete Reviewer prose and explicit controller repairs survive adapted invocation", async () => {
  const f = await fixture()
  f.plan.windows[0].runtime = ["review"]
  f.input.bound = await f.bind()
  const dir = path.join(f.root, "rounds/round-001/reviewer/pass-02")
  await mkdir(dir, { recursive: true })
  const body = "Evidence and recommendations.\n".repeat(3000) + 'AEV_REVIEW_CONTROL: {"ready_for_final_acceptance":false}'
  const finalAnswer = await publishWorkerAnswer(dir, { exitCode: 0, sessionID: "s", events: [
    { type: "assistant_message", message: { id: "final", role: "assistant" } },
    { type: "text", sessionID: "s", part: { messageID: "final", text: body } },
    { type: "step_finish", part: { messageID: "final", reason: "stop" } },
  ] } as OpencodeTaskRun["result"])
  const file = path.join(dir, "review-suggestion.json")
  await writeFile(file, JSON.stringify({ roundNumber: 1, readyForFinalAcceptance: false, finalAnswer }))
  f.input.advice = [{ root: f.root, path: file, kind: "review" }, { root: f.root, path: file, kind: "review" }]
  f.input.requirements = ["Repair the length defect using the actual candidate."]
  const result = await authorizeInvocation(f.input, f.request)
  expect(result.scope.advice).toHaveLength(1)
  expect(await readFile(result.scope.advice![0].path, "utf8")).toBe(body)
  expect(result.request.prompt).toContain(f.input.requirements[0])
  const views = await readdir(path.dirname(result.scope.advice![0].path))
  const metadata = views.find(name => name.endsWith(".json"))!
  expect(await readFile(path.join(path.dirname(result.scope.advice![0].path), metadata), "utf8")).not.toContain("Evidence and recommendations")
  expect(result.request.prompt).toContain("complete declared Reviewer final answer")
  await writeFile(path.join(dir, "final-answer.txt"), "TAMPERED")
  await expect(authorizeInvocation(f.input, f.request)).rejects.toThrow("fingerprint drift")
  await writeFile(path.join(dir, "final-answer.txt"), body)
  await writeFile(path.join(f.root, "source.txt"), "DRIFTED")
  await expect(authorizeInvocation(f.input, f.request)).rejects.toThrow("drift")
})

test("recompute action enables bounded arithmetic with persistent evidence, never shell or inherited grants", async () => {
  const f = await fixture()
  f.plan.windows[0].actions.push("recompute")
  f.input.bound = await f.bind()
  await runProtocolTrainingTask({ enabled: true, stageDir: path.join(f.root, "stage"), role: "lead", adaptation: f.input },
    f.request, async request => {
      expect(request.recompute).toMatchObject({ schema: "aev.recompute.v1", role: "lead", task: f.input.bound.fingerprint })
      expect(request.recomputeEvidenceRoot).toContain("protocol-invocations")
      expect(request.allowShell).toBe(false)
      expect(request.prompt).toContain("does not verify where your numbers came from")
      const result = await recompute({ ...request.recompute!, evidenceRoot: request.recomputeEvidenceRoot! }, { op: "add", args: [2, 3] })
      expect(result.result).toBe(5)
      return { result: { exitCode: 0, events: [] } } as unknown as OpencodeTaskRun
    })
  f.request.recompute = { schema: "aev.recompute.v1", task: f.input.bound.fingerprint, role: "lead" }
  f.request.recomputeEvidenceRoot = "E:/must-not-inherit"
  f.plan.windows[0].actions = ["read", "edit"]
  f.input.bound = await f.bind()
  const restricted = (await authorizeInvocation(f.input, f.request)).request
  expect(restricted.recompute).toBeUndefined()
  expect(restricted.recomputeEvidenceRoot).toBeUndefined()
})

test("undeclared runtime advice is not opened and declared advice cannot scan arbitrary files", async () => {
  const f = await fixture()
  f.input.advice = [{ root: f.root, path: path.join(f.root, "missing.txt"), kind: "review" }]
  expect((await authorizeInvocation(f.input, f.request)).scope.advice).toBeUndefined()
  f.plan.windows[0].runtime = ["review"]
  f.input.bound = await f.bind()
  f.input.advice[0].path = path.join(f.root, "private.txt")
  await expect(authorizeInvocation(f.input, f.request)).rejects.toThrow("Unexpected task advice source")
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
