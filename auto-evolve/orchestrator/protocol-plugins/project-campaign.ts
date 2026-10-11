import path from "node:path"
import { mkdir, readFile, open, access } from "node:fs/promises"
import { loadLongTaskSpec } from "../long-task/spec"
import { loadLongTaskCampaignSpec } from "../long-task-campaign/spec"
import { canonical, fingerprint } from "./identity"
import { writeJsonAtomic } from "../atomic-write"
import { loadPack } from "./project-pack"
import { readCandidate, copyCandidate } from "./candidate"

type CampaignResult = { campaignID: string; campaignDir: string; status: string; terminal?: boolean; attachedLive?: boolean }
export interface ProjectCampaignDriver {
  start(input: { cwd: string; specPath: string; taskID: string }): Promise<CampaignResult>
  resume(input: { cwd: string; specPath: string; taskID: string; campaignID: string }): Promise<CampaignResult>
}

export async function projectCampaign(input: { cwd: string; taskRoot: string; taskID: string; rounds: number;
  launchRoot: string; initialCandidate?: { root: string; fingerprint: string; parentRun: string } }, injected?: ProjectCampaignDriver) {
  if (![input.cwd, input.taskRoot, input.launchRoot].every((value) => typeof value === "string" && path.isAbsolute(value)) ||
      !Number.isSafeInteger(input.rounds) || input.rounds < 1) throw new Error("Explicit project Campaign paths and rounds required")
  const baseSpecPath = path.join(input.taskRoot, "spec.json")
  const baseBytes = await readFile(baseSpecPath)
  const base = (await loadLongTaskSpec(baseSpecPath)).spec
  if (base.protocolPlugins?.phase !== "source" || base.protocolPlugins.taskID !== input.taskID) {
    throw new Error("Project Campaign requires matching source task protocol")
  }
  let seed: { root: string; fingerprint: string; parentRun: string; files: unknown[] } | undefined
  let seedSkill: Awaited<ReturnType<typeof loadPack>>["pack"]["skill"] | undefined
  if (input.initialCandidate) {
    const value = input.initialCandidate
    if (![value.root, value.parentRun].every(file => typeof file === "string" && path.isAbsolute(file)) ||
        !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw new Error("Explicit frozen candidate lineage required")
    const project = await loadPack(base.protocolPlugins.projectManifestPath)
    if (!project.pack.tasks.some(task => task.id === input.taskID && task.split === "train")) throw new Error("Seed task is not a train source")
    seedSkill = project.pack.skill
    const candidate = await readCandidate(value.root, seedSkill)
    if (candidate.fingerprint !== value.fingerprint) throw new Error("Initial candidate fingerprint drift")
    seed = { ...value, files: candidate.metadata }
  }
  const body = { cwd: input.cwd, taskRoot: input.taskRoot, taskID: input.taskID, rounds: input.rounds,
    baseSpecFingerprint: fingerprint(baseBytes.toString("utf8")), ...(seed ? { initialCandidate: seed } : {}) }
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
    mode: "graph_iterative", maxRounds: input.rounds, seedTargets: seed ? [{
      seedPath: path.join(input.launchRoot, "initial-candidate"), targetPath: path.join(input.launchRoot, "author-workspace"),
      kind: "experience_workspace", resetOnStart: true }] : [] }
  if (fresh) {
    // 半完成启动保留认领，禁止把可能已计费的训练静默再发一次。
    for (const file of [snapshotPath, specPath, resultPath]) {
      try { await access(file); throw new Error("Unclaimed project Campaign evidence") }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    }
    if (seed && seedSkill) {
      const target = path.join(input.launchRoot, "initial-candidate")
      try { await access(target); throw new Error("Unclaimed initial candidate evidence") }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      // 仅复用声明的候选字节，不复制历史通过标签或私有资料。
      await copyCandidate(seed.root, target, seedSkill)
    }
    await writeJsonAtomic(specPath, campaignSpec)
    await writeJsonAtomic(snapshotPath, binding)
  } else {
    const savedSpec = JSON.parse((await readFile(specPath, "utf8")).replace(/^\uFEFF/, ""))
    if (canonical(savedSpec) !== canonical(campaignSpec)) throw new Error("Project Campaign spec drift")
  }
  if (seed && seedSkill && (await readCandidate(path.join(input.launchRoot, "initial-candidate"), seedSkill)).fingerprint !== seed.fingerprint) {
    throw new Error("Frozen initial candidate changed")
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
