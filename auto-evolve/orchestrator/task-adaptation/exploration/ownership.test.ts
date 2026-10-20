import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile, lstat, rename } from "node:fs/promises"
import { once } from "node:events"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { validateExplorationPolicyV2, type ExplorationPolicyV2 } from "./policy-v2"
import type { LongTaskSpec } from "../../long-task/contract"
import { bindPlan } from "../binding"
import { fingerprint } from "../../protocol-plugins/identity"
import { plan, policy } from "./policy.test"
import { openTaskCampaignControl, preserveExplorationRuntime } from "./ownership"
import { cleanupRuntimeScopeWithRetry, healStaleRuntimeStates } from "../../long-task-campaign/runner"
import { freezeTaskOrigin } from "./origin"
import { openTaskGeneration } from "./generation"
import { saveCandidate } from "./archive"

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "aev-host-control-"))
  const candidate = path.join(base, "candidate"), root = path.join(base, "auto-evolve/runtime-state/long-task-campaigns/campaign")
  await mkdir(candidate)
  await mkdir(root, { recursive: true })
  const cfg = plan()
  cfg.exploration = policy()
  for (const resource of cfg.resources) await writeFile(path.join(candidate, resource.path), resource.id)
  const bound = await bindPlan(candidate, cfg, [])
  const state = { id: "campaign", baseSpecPath: path.join(base, "spec.json"), status: "recovery_pending", currentRound: 1 }
  await writeFile(path.join(root, "campaign.json"), JSON.stringify(state))
  const spec = { taskAdaptationContext: bound, taskAdaptationCampaignRoot: root,
    protocolAuthorContext: { fingerprint: fingerprint("protocol fixture") },
    taskAdaptation: { schema: "aev.task-adaptation.v1", root: candidate, planPath: path.join(base, "plan.json"),
      capabilities: [], entries: [{ id: "report", path: "report.md" }, { id: "facts", path: "facts.md" }],
      requestBudget: { schema: "aev.task-budget-policy.v1", root: path.join(base, "budget"), scope: "task",
        models: [{ model: "fixture", dialect: "openai_chat", expectedModels: ["fixture"], maxInputTokens: 100, maxOutputTokens: 100 }] } },
  } as LongTaskSpec
  return { base, root, spec, state, input: { root, campaign: "campaign", baseSpecPath: state.baseSpecPath } }
}

test("old task does not create a Host directory or acquire a new control lock", async () => {
  const root = path.join(await mkdtemp(path.join(os.tmpdir(), "aev-no-host-")), "absent")
  expect(await openTaskCampaignControl({} as LongTaskSpec, { root, campaign: "old", baseSpecPath: root })).toBeUndefined()
  await expect(lstat(root)).rejects.toThrow()
})

test("initial origin freezes before authors and survives later current changes and closed controller", async () => {
  const f = await fixture(), control = (await openTaskCampaignControl(f.spec, f.input))!
  const current = path.join(f.root, "pending-expert-package/current")
  await mkdir(current, { recursive: true })
  await writeFile(path.join(current, "report.md"), "initial report")
  await writeFile(path.join(current, "facts.md"), "initial facts")
  try {
    await expect(freezeTaskOrigin(f.spec, { root: f.root, control })).rejects.toThrow("origin missing")
    const first = await freezeTaskOrigin(f.spec, { root: f.root, control, create: true })
    expect(first.record.round).toBe(0)
    expect(first.record.feedback).toBeNull()
    await writeFile(path.join(current, "report.md"), "later author revision")
    expect(await freezeTaskOrigin(f.spec, { root: f.root, control })).toEqual(first)
    expect(await readFile(path.join(path.dirname(first.path), first.record.files[0].file), "utf8")).toBe("initial report")
    control.close()
    await expect(freezeTaskOrigin(f.spec, { root: f.root, control })).rejects.toThrow("Live Campaign control")
    await expect(freezeTaskOrigin(f.spec, { root: f.root, control: { ...control } })).rejects.toThrow("Live Campaign control")
    const next = (await openTaskCampaignControl(f.spec, f.input))!
    try { expect(await freezeTaskOrigin(f.spec, { root: f.root, control: next })).toEqual(first) }
    finally { next.close() }
  } finally { control.close() }
})

test("initial origin interrupted completion recovers frozen blobs rather than rereading changed current", async () => {
  const f = await fixture(), control = (await openTaskCampaignControl(f.spec, f.input))!
  const current = path.join(f.root, "pending-expert-package/current")
  await mkdir(current, { recursive: true })
  await writeFile(path.join(current, "report.md"), "initial report")
  await writeFile(path.join(current, "facts.md"), "initial facts")
  try {
    const first = await freezeTaskOrigin(f.spec, { root: f.root, control, create: true })
    await rename(first.path, `${first.path}.saved`)
    await writeFile(path.join(current, "report.md"), "subsequent current")
    expect(await freezeTaskOrigin(f.spec, { root: f.root, control })).toEqual(first)
    await rename(first.path, `${first.path}.saved2`)
    await rename(path.join(path.dirname(first.path), "files/0.bin"), path.join(f.base, "lost.bin"))
    await expect(freezeTaskOrigin(f.spec, { root: f.root, control })).rejects.toThrow("drift")
    expect(await readFile(path.join(current, "report.md"), "utf8")).toBe("subsequent current")
  } finally { control.close() }
})

test("Campaign round generation lease remains exclusive until round cleanup closes it", async () => {
  const f = await fixture(), control = (await openTaskCampaignControl(f.spec, f.input))!
  try {
    const lease = await openTaskGeneration(f.spec, { root: f.root, control })
    expect(lease.generation).toBe(0)
    expect(lease.state).toBeUndefined()
    await expect(openTaskGeneration(f.spec, { root: f.root, control })).rejects.toThrow("writer active")
    lease.close()
    const next = await openTaskGeneration(f.spec, { root: f.root, control })
    next.close()
  } finally { control.close() }
})

test("controlled round cleanup cannot advance while children remain or cleanup throws", async () => {
  const residual = { scope: "round", cleanedCount: 0, remainingCount: 1 }
  let calls = 0
  const cleanup = async () => { calls++; return residual }
  await expect(cleanupRuntimeScopeWithRetry("round", true, cleanup)).rejects.toThrow("cannot advance generation")
  expect(calls).toBe(2)
  await cleanupRuntimeScopeWithRetry("round", false, cleanup)
  expect(calls).toBe(4)
  const failure = new Error("cleanup unavailable")
  await expect(cleanupRuntimeScopeWithRetry("round", true, async () => { throw failure })).rejects.toBe(failure)
})

test("event-only initial freeze resumes identical bytes and rejects a changed initial without replacing event", async () => {
  const f = await fixture(), control = (await openTaskCampaignControl(f.spec, f.input))!
  const current = path.join(f.root, "pending-expert-package/current")
  await mkdir(current, { recursive: true })
  await writeFile(path.join(current, "report.md"), "initial report")
  await writeFile(path.join(current, "facts.md"), "initial facts")
  try {
    const first = await freezeTaskOrigin(f.spec, { root: f.root, control, create: true })
    const root = path.dirname(path.dirname(first.path))
    const event = path.join(root, `${fingerprint({ schema: "aev.exploration-archive-event.v1", scope: control.scope, round: 0 })}.event.json`)
    const before = await readFile(event, "utf8")
    await rename(path.dirname(first.path), path.join(f.base, "saved-origin"))
    await rename(path.join(root, `${first.id}.intent.json`), path.join(f.base, "saved-intent.json"))
    expect(await freezeTaskOrigin(f.spec, { root: f.root, control })).toEqual(first)
    await rename(path.dirname(first.path), path.join(f.base, "saved-origin2"))
    await rename(path.join(root, `${first.id}.intent.json`), path.join(f.base, "saved-intent2.json"))
    await writeFile(path.join(current, "report.md"), "changed initial")
    await expect(freezeTaskOrigin(f.spec, { root: f.root, control })).rejects.toThrow("event input drift")
    expect(await readFile(event, "utf8")).toBe(before)
  } finally { control.close() }
})

test("historical origin is checked against new deliverables at initialization, not only at activation", async () => {
  const prior = await fixture(), owner = (await openTaskCampaignControl(prior.spec, prior.input))!
  const current = path.join(prior.root, "pending-expert-package/current")
  await mkdir(current, { recursive: true })
  await writeFile(path.join(current, "report.md"), "initial report")
  await writeFile(path.join(current, "facts.md"), "initial facts")
  const first = await freezeTaskOrigin(prior.spec, { root: prior.root, control: owner, create: true })
  owner.close()
  for (const mode of ["full", "missing", "path"] as const) {
    const source = path.join(prior.base, mode)
    await mkdir(source)
    await writeFile(path.join(source, "report.md"), "initial report")
    await writeFile(path.join(source, mode === "path" ? "else.md" : "facts.md"), "initial facts")
    const entries = first.record.files.filter(item => mode !== "missing" || item.id === "report")
      .map(item => ({ ...item, path: mode === "path" && item.id === "facts" ? "else.md" : item.path }))
    const archive = path.join(prior.base, `archive-${mode}`)
    const saved = await saveCandidate({ ...first.record, root: archive, candidateRoot: source,
      evidenceRoot: prior.root, entries, bounds: policy().bounds })
    const f = await fixture(), task = structuredClone(f.spec.taskAdaptationContext!.plan)
    task.exploration!.origin = { kind: "candidate", archive, scope: saved.record.scope, fingerprint: saved.id }
    f.spec.taskAdaptationContext = await bindPlan(f.spec.taskAdaptation!.root, task, [])
    const control = (await openTaskCampaignControl(f.spec, f.input))!
    try {
      const result = freezeTaskOrigin(f.spec, { root: f.root, control })
      if (mode === "full") expect(await result).toEqual(saved)
      else await expect(result).rejects.toThrow("entries differ")
    } finally { control.close() }
  }
})

test("Campaign control serializes recovery, rereads state and preserves original evidence", async () => {
  const f = await fixture(), first = await openTaskCampaignControl(f.spec, f.input)
  expect(first!.state.currentRound).toBe(1)
  expect(Object.isFrozen(first!.state)).toBe(true)
  try {
    await expect(openTaskCampaignControl(f.spec, f.input)).rejects.toThrow("writer active")
  } finally { first!.close() }
  first!.close()
  await writeFile(path.join(f.root, "campaign.json"), JSON.stringify({ ...f.state, currentRound: 2 }))
  const next = await openTaskCampaignControl(f.spec, f.input)
  expect(next!.state.currentRound).toBe(2)
  next!.close()
  expect(JSON.parse(await readFile(path.join(f.root, "campaign.json"), "utf8"))).toEqual({ ...f.state, currentRound: 2 })
})

test("identity and frozen protocol scope drift reject and release control without rewriting binding", async () => {
  const f = await fixture(), first = await openTaskCampaignControl(f.spec, f.input)
  first!.close()
  const file = path.join(f.root, "task-adaptation/exploration/host/scope.json"), before = await readFile(file, "utf8")
  await expect(openTaskCampaignControl({ ...f.spec, protocolAuthorContext: {
    ...f.spec.protocolAuthorContext!, fingerprint: "a".repeat(64) } }, f.input)).rejects.toThrow("scope drift")
  expect(await readFile(file, "utf8")).toBe(before)
  await writeFile(path.join(f.root, "campaign.json"), JSON.stringify({ ...f.state, id: "other" }))
  await expect(openTaskCampaignControl(f.spec, f.input)).rejects.toThrow("identity drift")
  await writeFile(path.join(f.root, "campaign.json"), JSON.stringify(f.state))
  const next = await openTaskCampaignControl(f.spec, f.input)
  next!.close()
})

test("an actually live child owner blocks recovery even with an old heartbeat", async () => {
  const f = await fixture(), file = path.join(import.meta.dir, "fixtures/control-owner.ts")
  const child = spawn(process.execPath, [file], { stdio: ["pipe", "pipe", "pipe"] })
  const exited = once(child, "exit")
  try {
    await once(child.stdout, "data")
    await writeFile(path.join(f.root, "campaign.json"), JSON.stringify({ ...f.state, ownerPID: child.pid,
      ownerCommandHint: file, heartbeatAt: "2000-01-01T00:00:00Z" }))
    await expect(openTaskCampaignControl(f.spec, f.input)).rejects.toThrow("owner still active or unresolved")
    await expect(lstat(path.join(f.root, "task-adaptation/exploration/host/scope.json"))).rejects.toThrow()
  } finally {
    child.stdin.end()
    await exited
  }
  const next = await openTaskCampaignControl(f.spec, f.input)
  expect(next!.state.ownerPID).toBe(child.pid)
  next!.close()
}, 20000)

test("actual stale healer preserves controlled Campaign and inner run despite an old live owner", async () => {
  const f = await fixture(), file = path.join(import.meta.dir, "fixtures/control-owner.ts")
  const child = spawn(process.execPath, [file], { stdio: ["pipe", "pipe", "pipe"] })
  const exited = once(child, "exit")
  try {
    await once(child.stdout, "data")
    const state = JSON.stringify({ ...f.state, status: "running", ownerPID: child.pid, ownerCommandHint: file,
      heartbeatAt: "2000-01-01T00:00:00Z", updatedAt: "2000-01-01T00:00:00Z" })
    await writeFile(path.join(f.root, "campaign.json"), state)
    await mkdir(path.join(f.root, "task-adaptation"))
    await writeFile(path.join(f.root, "task-adaptation/task-plan.snapshot.json"), JSON.stringify(f.spec.taskAdaptationContext))
    const run = path.join(f.base, "auto-evolve/runtime-state/long-task/runs/inner")
    await mkdir(run, { recursive: true })
    const progress = JSON.stringify({ status: "planning", ownerPID: child.pid, ownerCommandHint: file,
      heartbeatAt: "2000-01-01T00:00:00Z", updatedAt: "2000-01-01T00:00:00Z" })
    await writeFile(path.join(run, "progress_state.json"), progress)
    await writeFile(path.join(run, "task.json"), JSON.stringify(f.spec))
    expect(await preserveExplorationRuntime(f.root, "campaign")).toBe(true)
    expect(await preserveExplorationRuntime(run, "run")).toBe(true)
    await healStaleRuntimeStates(f.base)
    expect(child.exitCode).toBeNull()
    expect(await readFile(path.join(f.root, "campaign.json"), "utf8")).toBe(state)
    expect(await readFile(path.join(run, "progress_state.json"), "utf8")).toBe(progress)
  } finally {
    child.stdin.end()
    const [code] = await exited
    expect(code).toBe(0)
  }
}, 20000)

test("ordinary runtime metadata remains eligible for the original healer", async () => {
  const f = await fixture()
  expect(await preserveExplorationRuntime(f.root, "campaign")).toBe(false)
  await writeFile(path.join(f.root, "task.json"), JSON.stringify({ title: "legacy" }))
  expect(await preserveExplorationRuntime(f.root, "run")).toBe(false)
})

describe("Task Card B: V2 effective Campaign round window before round 1", () => {
  async function fixtureV2(opts: {
    planN: number
    campaignMaxRounds?: number
    f: number
    h: number
    m: number
    b: number
  }) {
    const base = await mkdtemp(path.join(os.tmpdir(), "aev-host-v2-"))
    const candidate = path.join(base, "candidate"),
      root = path.join(base, "auto-evolve/runtime-state/long-task-campaigns/campaign")
    await mkdir(candidate)
    await mkdir(root, { recursive: true })
    const cfg = plan()
    cfg.stop = { rounds: opts.planN, calls: 200, tokens: 2000000, stagnant: 5 }
    const v1p = policy()
    const v2p: ExplorationPolicyV2 = {
      schema: "aev.exploration-policy.v2",
      origin: structuredClone(v1p.origin),
      replace: structuredClone(v1p.replace),
      preserve: structuredClone(v1p.preserve),
      dependencies: structuredClone(v1p.dependencies),
      window: { minimumRounds: opts.f, maximumRounds: opts.h },
      trigger: { kind: "window" },
      allowance: {
        ...structuredClone(v1p.allowance),
        minimumRounds: opts.m,
        rounds: opts.b,
      },
      budget: { mode: "best_effort" },
      bounds: structuredClone(v1p.bounds),
      safety: structuredClone(v1p.safety),
    }
    cfg.exploration = validateExplorationPolicyV2(v2p, cfg)
    for (const resource of cfg.resources) await writeFile(path.join(candidate, resource.path), resource.id)
    const bound = await bindPlan(candidate, cfg, [])
    const state: Record<string, unknown> = {
      id: "campaign",
      baseSpecPath: path.join(base, "spec.json"),
      status: "recovery_pending",
      currentRound: 1,
    }
    if (opts.campaignMaxRounds !== undefined) {
      state.maxRounds = opts.campaignMaxRounds
    }
    await writeFile(path.join(root, "campaign.json"), JSON.stringify(state))
    const spec = {
      taskAdaptationContext: bound,
      taskAdaptationCampaignRoot: root,
      protocolAuthorContext: { fingerprint: fingerprint("protocol fixture") },
      taskAdaptation: {
        schema: "aev.task-adaptation.v1",
        root: candidate,
        planPath: path.join(base, "plan.json"),
        capabilities: [],
        entries: [
          { id: "report", path: "report.md" },
          { id: "facts", path: "facts.md" },
        ],
        requestBudget: {
          schema: "aev.task-budget-policy.v1",
          root: path.join(base, "budget"),
          scope: "task",
          models: [
            {
              model: "fixture",
              dialect: "openai_chat",
              expectedModels: ["fixture"],
              maxInputTokens: 100,
              maxOutputTokens: 100,
            },
          ],
        },
      },
    } as LongTaskSpec
    return { base, root, spec, input: { root, campaign: "campaign", baseSpecPath: state.baseSpecPath as string } }
  }

  test("B01: Plan N=9, Campaign maxRounds=9, f/h=7/7, m/b=2/2 -> 准入", async () => {
    const f = await fixtureV2({ planN: 9, campaignMaxRounds: 9, f: 7, h: 7, m: 2, b: 2 })
    const control = await openTaskCampaignControl(f.spec, f.input)
    expect(control).toBeDefined()
    control!.close()
  })

  test("B02: Plan N=9, Campaign maxRounds=7, f/h=7/7, m/b=2/2 -> 首轮前拒绝 (h+m > N)", async () => {
    const f = await fixtureV2({ planN: 9, campaignMaxRounds: 7, f: 7, h: 7, m: 2, b: 2 })
    await expect(openTaskCampaignControl(f.spec, f.input)).rejects.toThrow(
      /V2 effective Campaign round window incompatible: window maximum \(7\) \+ allowance minimum \(2\) exceeds effective rounds \(7\)/
    )
  })

  test("B03: Plan N=9, Campaign maxRounds=7, f/h=5/5, m/b=2/2 -> 准入", async () => {
    const f = await fixtureV2({ planN: 9, campaignMaxRounds: 7, f: 5, h: 5, m: 2, b: 2 })
    const control = await openTaskCampaignControl(f.spec, f.input)
    expect(control).toBeDefined()
    control!.close()
  })

  test("B04: Plan N=9, Campaign maxRounds=7, f/h=4/5, m/b=2/3 -> 准入 (5+2<=7, 3<=7-4=3)", async () => {
    const f = await fixtureV2({ planN: 9, campaignMaxRounds: 7, f: 4, h: 5, m: 2, b: 3 })
    const control = await openTaskCampaignControl(f.spec, f.input)
    expect(control).toBeDefined()
    control!.close()
  })

  test("B05: Plan N=9, Campaign maxRounds=7, f/h=4/5, m/b=2/4 -> 首轮前拒绝 (b > N-f)", async () => {
    // 4 > 7 - 4 = 3
    // 注意：Plan N=9 时，4 <= 9-4=5 合法，但实际 Campaign 紧缩至 7，使得有效 N=7，b=4 超出 N-f=3
    const f = await fixtureV2({ planN: 9, campaignMaxRounds: 7, f: 4, h: 5, m: 2, b: 4 })
    await expect(openTaskCampaignControl(f.spec, f.input)).rejects.toThrow(
      /V2 effective Campaign round window incompatible: allowance rounds \(4\) exceeds remaining effective rounds \(3\)/
    )
  })

  test("B06: Plan N=4, Campaign maxRounds=4, f/h=2/2, m/b=2/2 -> 现有标准 V2 E2E 准入", async () => {
    const f = await fixtureV2({ planN: 4, campaignMaxRounds: 4, f: 2, h: 2, m: 2, b: 2 })
    const control = await openTaskCampaignControl(f.spec, f.input)
    expect(control).toBeDefined()
    control!.close()
  })

  test("B07: V1 合法，Campaign 原配置 -> 准入，不引入 V2 专属拒绝", async () => {
    const f = await fixture()
    const control = await openTaskCampaignControl(f.spec, f.input)
    expect(control).toBeDefined()
    control!.close()
  })

  test("B08: 无探索旧配置 -> openTaskCampaignControl 返回 undefined", async () => {
    const root = path.join(await mkdtemp(path.join(os.tmpdir(), "aev-no-exp-")), "absent")
    expect(await openTaskCampaignControl({} as LongTaskSpec, { root, campaign: "old", baseSpecPath: root })).toBeUndefined()
  })
})
