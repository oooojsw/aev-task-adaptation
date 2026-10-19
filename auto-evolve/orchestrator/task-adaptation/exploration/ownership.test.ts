import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile, lstat } from "node:fs/promises"
import { once } from "node:events"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import type { LongTaskSpec } from "../../long-task/contract"
import { bindPlan } from "../binding"
import { fingerprint } from "../../protocol-plugins/identity"
import { plan, policy } from "./policy.test"
import { openTaskCampaignControl, preserveExplorationRuntime } from "./ownership"
import { healStaleRuntimeStates } from "../../long-task-campaign/runner"

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
