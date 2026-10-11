import path from "node:path"
import { mkdir, readFile, open, access } from "node:fs/promises"
import { loadLongTaskSpec } from "../long-task/spec"
import { loadLongTaskCampaignSpec } from "../long-task-campaign/spec"
import { canonical, fingerprint } from "./identity"
import { writeJsonAtomic } from "../atomic-write"

type CampaignResult = { campaignID: string; campaignDir: string; status: string; terminal?: boolean; attachedLive?: boolean }
export interface ProjectCampaignDriver {
  start(input: { cwd: string; specPath: string; taskID: string }): Promise<CampaignResult>
  resume(input: { cwd: string; specPath: string; taskID: string; campaignID: string }): Promise<CampaignResult>
}

export async function projectCampaign(input: { cwd: string; taskRoot: string; taskID: string; rounds: number;
  launchRoot: string }, injected?: ProjectCampaignDriver) {
  if (![input.cwd, input.taskRoot, input.launchRoot].every((value) => typeof value === "string" && path.isAbsolute(value)) ||
      !Number.isSafeInteger(input.rounds) || input.rounds < 1) throw new Error("Explicit project Campaign paths and rounds required")
  const baseSpecPath = path.join(input.taskRoot, "spec.json")
  const baseBytes = await readFile(baseSpecPath)
  const base = (await loadLongTaskSpec(baseSpecPath)).spec
  if (base.protocolPlugins?.phase !== "source" || base.protocolPlugins.taskID !== input.taskID) {
    throw new Error("Project Campaign requires matching source task protocol")
  }
  const body = { cwd: input.cwd, taskRoot: input.taskRoot, taskID: input.taskID, rounds: input.rounds,
    baseSpecFingerprint: fingerprint(baseBytes.toString("utf8")) }
  const binding = { ...body, fingerprint: fingerprint(body) }
  const specPath = path.join(input.launchRoot, "campaign-spec.json")
  const snapshotPath = path.join(input.launchRoot, "launch.snapshot.json")
  const resultPath = path.join(input.launchRoot, "campaign-result.json")
  await mkdir(input.launchRoot, { recursive: true })
  let fresh = true
  try { const claim = await open(path.join(input.launchRoot, "launch.started.claim"), "wx"); await claim.close() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    fresh = false
    const saved = JSON.parse((await readFile(snapshotPath, "utf8")).replace(/^\uFEFF/, ""))
    if (canonical(saved) !== canonical(binding)) throw new Error("Project Campaign launch configuration drift")
  }
  const campaignSpec = { title: `project-${binding.fingerprint.slice(0, 24)}`, baseSpecPath,
    mode: "graph_iterative", maxRounds: input.rounds, seedTargets: [] }
  if (fresh) {
    // 半完成启动保留认领，禁止把可能已计费的训练静默再发一次。
    for (const file of [snapshotPath, specPath, resultPath]) {
      try { await access(file); throw new Error("Unclaimed project Campaign evidence") }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    }
    await writeJsonAtomic(specPath, campaignSpec)
    await writeJsonAtomic(snapshotPath, binding)
  } else {
    const savedSpec = JSON.parse((await readFile(specPath, "utf8")).replace(/^\uFEFF/, ""))
    if (canonical(savedSpec) !== canonical(campaignSpec)) throw new Error("Project Campaign spec drift")
  }
  await loadLongTaskCampaignSpec(specPath)
  const previous = fresh ? undefined : JSON.parse((await readFile(resultPath, "utf8")).replace(/^\uFEFF/, ""))
  if (previous && (previous.binding !== binding.fingerprint || !previous.result?.campaignID || !path.isAbsolute(previous.result.campaignDir))) {
    throw new Error("Project Campaign recovery identity missing")
  }
  const driver = injected ?? await import("../long-task-campaign/runner").then((module) => ({
    start: module.runLongTaskCampaign, resume: module.resumeLongTaskCampaign }))
  const common = { cwd: input.cwd, specPath, taskID: input.taskID }
  const result = previous ? await driver.resume({ ...common, campaignID: previous.result.campaignID }) : await driver.start(common)
  if (!result.campaignID || !path.isAbsolute(result.campaignDir) ||
      (previous && (result.campaignID !== previous.result.campaignID || result.campaignDir !== previous.result.campaignDir))) {
    throw new Error("Project Campaign returned different recovery identity")
  }
  await writeJsonAtomic(resultPath, { binding: binding.fingerprint, result })
  return result
}
