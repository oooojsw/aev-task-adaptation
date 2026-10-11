import path from "node:path"
import { readFile, mkdir, open, access, realpath, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { fingerprint, canonical } from "./identity"
import { prepareEntry } from "./entry"
import { loadLongTaskSpec } from "../long-task/spec"
import { selectedRuntime } from "./selected-runtime"
import { validatePipeline, freezePipeline, type PipelineConfig } from "./pipeline-config"
import { writeJsonAtomic } from "../atomic-write"
import { createCoordinatorRun, runCoordinatorPhase1Fanout } from "../multi-instance/coordinator"
import { loadCoordinatorState } from "../multi-instance/repository"
import { runCoordinatorPhase2Merge } from "../multi-instance/merger"
import { runCoordinatorPhase3Validate } from "../multi-instance/validator"
import type { ProjectCampaignDriver } from "./project-campaign"
import type { Runtime } from "./runtime"
import type { opencodeDriver } from "./opencode-driver"
import { readCandidate, type SkillBinding } from "./candidate"
import type { MergeAcceptanceStage } from "../multi-instance/merge-acceptance-policy"
import { readCurrentProcessCreationTick } from "../process-identity"

export interface ProjectBatchConfig {
  schema: "aev.project-batch.v1"
  tasksPath: string
  rounds: number
  fanoutLimit: number
  requireAllSources: boolean
  sourceReplay: boolean
  replayMustPass: boolean
  repairAttempts: number
  replayStages?: MergeAcceptanceStage[]
  finalTest: boolean
  pipeline: PipelineConfig
}

export function validateProjectBatch(value: unknown): ProjectBatchConfig {
  const cfg = structuredClone(value) as ProjectBatchConfig
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) || cfg.schema !== "aev.project-batch.v1" ||
      Object.keys(cfg).some((key) => !["schema", "tasksPath", "rounds", "fanoutLimit", "requireAllSources", "sourceReplay", "replayMustPass", "repairAttempts", "replayStages", "finalTest", "pipeline"].includes(key)) ||
      typeof cfg.tasksPath !== "string" || !path.isAbsolute(cfg.tasksPath) ||
      ![cfg.rounds, cfg.fanoutLimit].every((n) => Number.isSafeInteger(n) && n > 0) ||
      !Number.isSafeInteger(cfg.repairAttempts) || cfg.repairAttempts < 0 ||
      ![cfg.requireAllSources, cfg.sourceReplay, cfg.replayMustPass, cfg.finalTest].every((flag) => typeof flag === "boolean") ||
      (cfg.replayMustPass && !cfg.sourceReplay)) {
    throw new Error("Explicit valid project batch config required")
  }
  cfg.pipeline = validatePipeline(cfg.pipeline)
  if (cfg.replayStages !== undefined && (!cfg.sourceReplay || !Array.isArray(cfg.replayStages) ||
      !cfg.replayStages.includes("initial_replay") || new Set(cfg.replayStages).size !== cfg.replayStages.length ||
      cfg.replayStages.some((stage) => !["initial_replay", "repair_promote", "final_full_replay", "strict_acceptance_gate"].includes(stage)) ||
      (cfg.repairAttempts > 0 && !cfg.replayStages.includes("repair_promote")))) {
    throw new Error("Explicit compatible replay stages required")
  }
  if (cfg.repairAttempts > 0 && (!cfg.sourceReplay || !cfg.pipeline.repairAuthor)) {
    throw new Error("Project batch repair requires source replay and explicit repair author")
  }
  return cfg
}

export async function runProjectBatch(input: { cwd: string; runRoot: string; config: ProjectBatchConfig },
  dependencies?: { runtime?: Runtime; projectDriver?: ProjectCampaignDriver; createDriver?: typeof opencodeDriver }) {
  if (![input.cwd, input.runRoot].every((value) => typeof value === "string" && path.isAbsolute(value))) throw new Error("Absolute project batch paths required")
  const cfg = validateProjectBatch(input.config)
  const tasks = JSON.parse((await readFile(cfg.tasksPath, "utf8")).replace(/^\uFEFF/, ""))
  if (tasks.schema !== "aev.project-tasks.v1" || !Array.isArray(tasks.tasks) || !tasks.tasks.length ||
      new Set(tasks.tasks.map((row: { id: string }) => row.id)).size !== tasks.tasks.length) throw new Error("Invalid prepared project tasks")
  let runtime = dependencies?.runtime
  let skill: SkillBinding | undefined
  for (const row of tasks.tasks) {
    if (!["train", "test"].includes(row.role) || ![row.sourceTaskRoot, row.specPath].every((file) => typeof file === "string" && path.isAbsolute(file)) ||
        path.resolve(row.specPath) !== path.join(path.resolve(row.sourceTaskRoot), "spec.json")) throw new Error("Invalid prepared task identity")
    const bytes = await readFile(row.specPath, "utf8")
    if (fingerprint(JSON.parse(bytes.replace(/^\uFEFF/, ""))) !== row.specFingerprint) throw new Error("Prepared task spec drift")
    const spec = (await loadLongTaskSpec(row.specPath)).spec
    const entry = spec.protocolPlugins
    if (!entry || entry.taskID !== row.id || entry.phase !== (row.role === "test" ? "test" : "source")) throw new Error("Prepared task split/entry mismatch")
    if (canonical(spec.protocolTraining ?? null) !== canonical(row.role === "train" ? tasks.training ?? null : null)) throw new Error("Prepared training config drift")
    runtime ??= await selectedRuntime(input.runRoot + ".backends", input.cwd, entry)
    const prepared = await prepareEntry(path.join(row.sourceTaskRoot, "preflight"), entry, runtime)
    if (prepared?.project.fingerprint !== tasks.projectFingerprint || prepared.protocol.fingerprint !== tasks.protocolFingerprint) throw new Error("Prepared project/protocol fingerprint drift")
    skill = prepared.project.pack.skill
    const packTask = prepared.project.pack.tasks.find((task) => task.id === row.id)!
    if (spec.goal !== tasks.trainingGoal || canonical(spec.materials.map(({ label, path: file }) => ({ label, path: file }))) !==
        canonical(packTask.materials.map((file) => ({ label: file.id, path: path.join(prepared.project.root, file.path) })))) {
      throw new Error("Prepared author materials/goal differ from project task")
    }
    const inventory = prepared.project.pack.tasks.filter((task) => task.split !== "validation").map((task) => ({ id: task.id, role: task.split }))
    if (canonical(inventory) !== canonical(tasks.tasks.map((task) => ({ id: task.id, role: task.role })))) throw new Error("Prepared project task inventory drift")
    for (const protectedRoot of [prepared.project.root, row.sourceTaskRoot]) {
      const relative = path.relative(protectedRoot, path.resolve(input.runRoot))
      if (!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new Error("Batch output cannot modify project inputs")
    }
    if (cfg.sourceReplay && !prepared.protocol.selection.protocol.phases.replay) throw new Error("Source replay phase missing")
    if (!prepared.protocol.selection.protocol.phases.merge) throw new Error("Merge phase missing")
  }
  if (!tasks.tasks.some((row: { role: string }) => row.role === "train") ||
      (cfg.finalTest && !tasks.tasks.some((row: { role: string }) => row.role === "test"))) throw new Error("Requested batch stage lacks tasks")
  const binding = { schema: "aev.project-batch-snapshot.v1", config: cfg, cwd: input.cwd, tasksFingerprint: fingerprint(tasks) }
  await mkdir(input.runRoot, { recursive: true })
  if (await realpath(input.runRoot) !== path.resolve(input.runRoot)) throw new Error("Project batch root link rejected")
  const leasePath = path.join(input.runRoot, "project-batch.invocation.claim")
  const nonce = randomUUID()
  let lease
  try { lease = await open(leasePath, "wx") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Project batch invocation active or interrupted; inspect owner before recovery")
    throw error
  }
  const ownerCreationTick = await readCurrentProcessCreationTick()
  await lease.writeFile(JSON.stringify({ nonce, pid: process.pid, startedAt: new Date().toISOString(),
    ...(ownerCreationTick ? { ownerCreationTick } : {}) }))
  await lease.close()
  // 同一批次只有一个推进者；异常退出残留锁须先核查，不自动抢占。
  try {
  const snapshot = path.join(input.runRoot, "project-batch.snapshot.json")
  const progressPath = path.join(input.runRoot, "project-batch.progress.json")
  let fresh = true
  try { const claim = await open(path.join(input.runRoot, "project-batch.started.claim"), "wx"); await claim.close() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    fresh = false
    const saved = JSON.parse((await readFile(snapshot, "utf8")).replace(/^\uFEFF/, ""))
    if (canonical(saved) !== canonical(binding)) throw new Error("Project batch configuration drift")
  }
  if (fresh) {
    for (const file of [snapshot, progressPath, path.join(input.runRoot, "coordinator-state.json")]) {
      try { await access(file); throw new Error("Unclaimed project batch state") }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    }
    await writeJsonAtomic(snapshot, binding)
  }
  await freezePipeline(input.runRoot, cfg.pipeline)
  const state = fresh ? await createCoordinatorRun({ cwd: input.cwd, runRoot: input.runRoot,
    label: `project-${tasks.projectFingerprint.slice(0, 12)}`, rounds: cfg.rounds, fanoutLimit: cfg.fanoutLimit,
    instances: tasks.tasks.map((row) => ({ id: row.id, sourceTaskRoot: row.sourceTaskRoot,
      role: row.role, engine: "protocol_project", taskID: row.id, skillsbenchRoot: "" })) }) : await loadCoordinatorState(input.runRoot)
  if (state.instances.length !== tasks.tasks.length || !state.instances.every((row) => tasks.tasks.some((task) =>
      task.id === row.id && task.role === row.role && task.sourceTaskRoot === row.sourceTaskRoot && row.engine === "protocol_project" && row.rounds === cfg.rounds))) {
    throw new Error("Project coordinator task identity drift")
  }
  const progress: { stage: string; binding: string; outcomes: Record<string, unknown>; finalCandidate?: { root: string; fingerprint: string } } = fresh ?
    { stage: "learning", binding: fingerprint(binding), outcomes: {} } : JSON.parse((await readFile(progressPath, "utf8")).replace(/^\uFEFF/, ""))
  if (progress.binding !== fingerprint(binding) || !["learning", "merge", "replay", "test", "completed"].includes(progress.stage)) throw new Error("Project batch progress identity drift")
  const verifyFinal = async () => {
    if (!state.mergedSkillDir || !skill) throw new Error("Final candidate missing")
    const final = { root: state.mergedSkillDir, fingerprint: (await readCandidate(state.mergedSkillDir, skill)).fingerprint }
    if (progress.finalCandidate && canonical(final) !== canonical(progress.finalCandidate)) throw new Error("Completed batch deployment drift")
    return final
  }
  const save = async () => {
    if (progress.stage === "completed") progress.finalCandidate = await verifyFinal()
    await writeJsonAtomic(progressPath, progress)
  }
  if (!fresh && progress.stage === "completed") {
    if (!progress.finalCandidate) throw new Error("Completed batch deployment checkpoint missing")
    await verifyFinal()
  }
  if (fresh) await save()
  if (progress.stage === "learning") {
    const result = await runCoordinatorPhase1Fanout({ cwd: input.cwd, state }, { projectDriver: dependencies?.projectDriver, protocolRuntime: runtime })
    progress.outcomes.learning = result
    if (result.running) { await save(); return { status: "running", state, progress } }
    const sources = state.instances.filter((row) => row.role === "train")
    if (!result.passed || (cfg.requireAllSources && sources.some((row) => row.status !== "passed"))) {
      await save(); return { status: "source_gate_blocked", state, progress }
    }
    progress.stage = "merge"; await save()
  }
  if (progress.stage === "merge") {
    progress.outcomes.merge = await runCoordinatorPhase2Merge({ cwd: input.cwd, state, protocolAuthor: cfg.pipeline.mergeAuthor,
      protocolMergeStrategy: cfg.pipeline.mergeStrategy },
      { runtime, createDriver: dependencies?.createDriver })
    progress.stage = cfg.sourceReplay ? "replay" : cfg.finalTest ? "test" : "completed"; await save()
  }
  if (progress.stage === "replay") {
    const result = await runCoordinatorPhase3Validate({ cwd: input.cwd, state, validateLimit: cfg.fanoutLimit,
      filter: (row) => row.role === "train" && row.status === "passed",
      ...(cfg.replayStages ? { acceptancePolicy: { stages: cfg.replayStages, successCriterion: "all_pass" as const } } : {}),
      repair: { enabled: cfg.repairAttempts > 0, mode: cfg.pipeline.repairAuthor?.mode ?? "append_only", maxAttemptsPerCase: cfg.repairAttempts,
        protocolAuthor: cfg.pipeline.repairAuthor } }, { protocolRuntime: runtime, createDriver: dependencies?.createDriver })
    progress.outcomes.replay = result
    if (cfg.replayMustPass && !result.accepted) { await save(); return { status: "replay_gate_blocked", state, progress } }
    progress.stage = cfg.finalTest ? "test" : "completed"; await save()
  }
  if (progress.stage === "test") {
    // 测试只执行与评分，不提供任何修补作者或训练反馈路径。
    progress.outcomes.test = await runCoordinatorPhase3Validate({ cwd: input.cwd, state, validateLimit: cfg.fanoutLimit,
      filter: (row) => row.role === "test", repair: { enabled: false, mode: "append_only", maxAttemptsPerCase: 0 } },
      { protocolRuntime: runtime })
    progress.stage = "completed"; await save()
  }
  return { status: "completed", state, progress }
  } finally {
    try {
      const owner = JSON.parse((await readFile(leasePath, "utf8")).replace(/^\uFEFF/, ""))
      if (owner.nonce === nonce) await unlink(leasePath)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
}
