import { expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { runTask } from "./run-task"
import type { TaskRunPreparation } from "./prepare-task-run"
import { longTaskCampaignPaths } from "../long-task-campaign/repository"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-task-launch-"))
  const dir = path.join(root, "prepared")
  await mkdir(dir)
  const planPath = path.join(dir, "task-plan.json")
  const specPath = path.join(dir, "spec.json")
  await writeFile(planPath, JSON.stringify({ objective: "Task launch fixture", stop: { rounds: 2 } }))
  await writeFile(specPath, JSON.stringify({ goal: "Task launch fixture" }))
  const input = { intake: { cwd: root }, execution: { dir, requestBudget: { scope: "fixture" } } } as TaskRunPreparation
  let launches = 0, resumes = 0
  const campaignID = "fixture-campaign"
  const campaignDir = longTaskCampaignPaths(root, campaignID).root
  const result = { campaignID, campaignDir, status: "round_limit_reached" as const, terminal: true,
    roundsCompleted: 2, lessonsPath: path.join(campaignDir, "lessons"), taskStopReason: "round_budget" }
  const dependencies = {
    prepare: (async () => ({ status: "ready", planPath, specPath, selectionPath: "unused", projectManifestPath: "unused", reused: false })) as typeof import("./prepare-task-run").prepareTaskRun,
    controller: async () => ({
      runLongTaskCampaign: async (args: Parameters<typeof import("../long-task-campaign/runner").runLongTaskCampaign>[0]) => {
        launches++
        expect(args.forceNew).toBe(true)
        await mkdir(campaignDir, { recursive: true })
        await writeFile(path.join(campaignDir, "campaign.json"), JSON.stringify({ id: campaignID, baseSpecPath: specPath }))
        await args.onCreated?.({ campaignID, campaignDir })
        return result
      },
      resumeLongTaskCampaign: async (args: { campaignID: string }) => { resumes++; expect(args.campaignID).toBe(campaignID); return result },
    }),
  }
  return { input, dependencies, result, root, dir, specPath, count: () => ({ launches, resumes }) }
}

test("unified task entry launches once and delegates every continuation to original resume", async () => {
  const f = await fixture()
  const first = await runTask(f.input, f.dependencies)
  expect(first.status).toBe("round_limit_reached")
  expect(await runTask(f.input, f.dependencies)).toEqual(first)
  expect(f.count()).toEqual({ launches: 1, resumes: 1 })
  expect(JSON.parse(await readFile(path.join(f.dir, "task-run/outcome.json"), "utf8")).taskStopReason).toBe("round_budget")
})

test("interruption after Campaign registration resumes same identity without new launch", async () => {
  const f = await fixture()
  const original = f.dependencies.controller
  f.dependencies.controller = async () => {
    const controller = await original()
    return { ...controller, runLongTaskCampaign: async args => { await controller.runLongTaskCampaign(args); throw new Error("after registration") } }
  }
  await expect(runTask(f.input, f.dependencies)).rejects.toThrow("after registration")
  f.dependencies.controller = original
  await runTask(f.input, f.dependencies)
  expect(f.count()).toEqual({ launches: 1, resumes: 1 })
})

test("unregistered interrupted launch blocks automatic resend", async () => {
  const f = await fixture()
  const original = f.dependencies.controller
  f.dependencies.controller = async () => ({ ...await original(), runLongTaskCampaign: async () => { throw new Error("before registration") } })
  await expect(runTask(f.input, f.dependencies)).rejects.toThrow("before registration")
  f.dependencies.controller = original
  await expect(runTask(f.input, f.dependencies)).rejects.toThrow()
  expect(f.count()).toEqual({ launches: 0, resumes: 0 })
})

test("launch identity changes and missing launch receipt cannot create another Campaign", async () => {
  const f = await fixture()
  await runTask(f.input, f.dependencies)
  await writeFile(f.specPath, "changed spec")
  await expect(runTask(f.input, f.dependencies)).rejects.toThrow("identity drift")
  await rm(path.join(f.dir, "task-run/launch.json"))
  await expect(runTask(f.input, f.dependencies)).rejects.toThrow()
  expect(f.count()).toEqual({ launches: 1, resumes: 0 })
})

test("explicit budget and missing-capability checks precede controller launch", async () => {
  const f = await fixture()
  const unbudgeted = structuredClone(f.input)
  delete unbudgeted.execution.requestBudget
  await expect(runTask(unbudgeted, f.dependencies)).rejects.toThrow("explicit shared request budget")
  const missing = { status: "missing_bindings" as const, missing: ["checker:sources"] }
  const prepare = (async () => missing) as typeof import("./prepare-task-run").prepareTaskRun
  expect(await runTask(f.input, { ...f.dependencies, prepare })).toEqual(missing)
  expect(f.count()).toEqual({ launches: 0, resumes: 0 })
})

test("deleting only the claim never resets an existing task identity", async () => {
  const f = await fixture()
  await runTask(f.input, f.dependencies)
  await rm(path.join(f.dir, "task-run/launch.started.claim"))
  await expect(runTask(f.input, f.dependencies)).rejects.toThrow("Unclaimed task launch evidence")
  expect(f.count()).toEqual({ launches: 1, resumes: 0 })
})
