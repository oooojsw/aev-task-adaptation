/**
 * MultiInstanceCoordinator — Phase 1 (fan-out) implementation.
 *
 * Launches N independent SkillsBench campaigns in parallel and harvests
 * their pending-expert-package outputs into a single coordinator run-root.
 *
 * Real concurrency is capped two ways:
 *   1. The global OpenCodeGate caps how many OpenCode children can run at
 *      once, regardless of how many campaigns are active.
 *   2. An optional fanoutLimit applies an additional coordinator-level
 *      cap so we don't have hundreds of half-blocked campaigns sitting
 *      in the queue. By default we launch all instances at once and
 *      let the gate sort it out.
 *
 * Persistence: every state transition writes coordinator-state.json
 * atomically, so a crash mid-fanout can be inspected and resumed.
 *
 * Phases 2/3 (merge, validate) live in their own modules — this file
 * only handles phase 1 today, with hooks left for the next milestones.
 */

import path from "node:path"
import { cp, readdir } from "node:fs/promises"
import { ensureDirectory, pathExists, writeJsonFile } from "../fs"
import { OpenCodeGate } from "../opencode-gate"
import { runSkillsBenchTask } from "../skillsbench-adapter"
import type { CoordinatorState, InstanceState, FanoutOutcome } from "./contract"
import { appendCoordinatorLog, fanoutDir, saveCoordinatorState, instanceSlot } from "./repository"
import { harvest } from "../protocol-plugins/harvest"
import { projectCampaign, type ProjectCampaignDriver } from "../protocol-plugins/project-campaign"
import type { Runtime } from "../protocol-plugins/runtime"

export interface InstanceSpec {
  /** Stable id, e.g. "court-form-filling-1". */
  id: string
  /** Absolute path to the task root (skillsbench-adapter taskRoot). */
  sourceTaskRoot: string
  /** Engine that knows how to run this instance. */
  engine: "skillsbench" | "protocol_project"
  /** SkillsBench/SkillLearnBench top-level root, used for verifier paths. */
  skillsbenchRoot: string
  /** Underlying SkillsBench task id (used by docker tag and run-root naming). */
  taskID: string
  /**
   * Role in the train/test split. "train" instances participate in Phase 1
   * fan-out (their skill feeds the merger). "test" instances skip Phase 1
   * entirely and are evaluated only in Phase 3 with the merged skill.
   */
  role?: "train" | "test"
}

export interface CreateCoordinatorRunInput {
  cwd: string
  runRoot: string
  label: string
  rounds: number
  instances: InstanceSpec[]
  fanoutLimit?: number
  minTerminalToStop?: number
}

export interface RunCoordinatorPhase1Input {
  cwd: string
  state: CoordinatorState
  /** Optional callback for monitoring / structured logging. */
  onInstanceUpdate?: (instance: InstanceState) => void
}

function coordinatorRunID(label: string, now = new Date()) {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0")
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    pad(now.getMilliseconds(), 3)
  const safeLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "multi-instance"
  return `${stamp}-${safeLabel}`
}

export async function createCoordinatorRun(input: CreateCoordinatorRunInput): Promise<CoordinatorState> {
  if (input.instances.some((row) => row.engine === "protocol_project") &&
      (!Number.isSafeInteger(input.rounds) || input.rounds < 1 ||
       (input.fanoutLimit !== undefined && (!Number.isSafeInteger(input.fanoutLimit) || input.fanoutLimit < 1)) ||
       new Set(input.instances.map((row) => row.id)).size !== input.instances.length)) {
    throw new Error("Explicit positive project rounds/concurrency and unique task IDs required")
  }
  const now = new Date().toISOString()
  const state: CoordinatorState = {
    id: path.basename(input.runRoot),
    label: input.label,
    phase: "phase1_fanout",
    createdAt: now,
    updatedAt: now,
    ownerPID: process.pid,
    heartbeatAt: now,
    runRoot: input.runRoot,
    options: {
      skillsbenchRoot: input.instances[0]?.skillsbenchRoot ?? "",
      rounds: input.rounds,
      fanoutLimit: input.fanoutLimit,
      minTerminalToStop: input.minTerminalToStop,
    },
    instances: input.instances.map((spec) => ({
      id: spec.id,
      sourceTaskRoot: spec.sourceTaskRoot,
      engine: spec.engine,
      role: spec.role ?? "train",
      status: "queued",
      rounds: input.rounds,
    })),
    log: [],
  }
  await ensureDirectory(input.runRoot)
  await ensureDirectory(fanoutDir(input.runRoot))
  await writeJsonFile(path.join(input.runRoot, "input-spec.json"), {
    instances: input.instances,
    rounds: input.rounds,
    fanoutLimit: input.fanoutLimit,
    minTerminalToStop: input.minTerminalToStop,
  })
  await saveCoordinatorState(state)
  await appendCoordinatorLog(state, "info", `Coordinator run created with ${input.instances.length} instances`)
  return state
}

/**
 * Launch all queued instances in parallel, respecting fanoutLimit and the
 * global OpenCodeGate. Returns a summary when all instances reach a
 * terminal state (or minTerminalToStop is hit).
 */
export async function runCoordinatorPhase1Fanout(input: RunCoordinatorPhase1Input,
  dependencies?: { projectDriver?: ProjectCampaignDriver; protocolRuntime?: Runtime }): Promise<FanoutOutcome> {
  const state = input.state
  const startedAt = Date.now()
  const fanoutLimit = state.options.fanoutLimit ?? state.instances.length
  if (state.instances.some((row) => row.engine === "protocol_project") && (!Number.isSafeInteger(fanoutLimit) || fanoutLimit < 1)) {
    throw new Error("Project fanout concurrency must be a positive integer")
  }
  const inFlight = new Set<Promise<unknown>>()

  // Index by id for cheap lookups.
  const byId = new Map(state.instances.map((i) => [i.id, i]))

  // Spec lookup: rebuild from instance state.
  const specs: InstanceSpec[] = state.instances.map((i) => ({
    id: i.id,
    sourceTaskRoot: i.sourceTaskRoot,
    engine: i.engine,
    skillsbenchRoot: state.options.skillsbenchRoot,
    taskID: skillsbenchTaskIDFromInstance(i),
  }))

  for (const spec of specs) {
    const instance = byId.get(spec.id)!
    if (instance.status !== "queued" && !(instance.engine === "protocol_project" && instance.status === "running")) continue
    // Held-out test instances skip Phase 1 entirely. They get marked
    // "skipped" with a special note so Phase 3 still validates them.
    if (instance.role === "test") {
      instance.status = "skipped"
      instance.errorMessage = "test-only instance — held out from fan-out"
      instance.finishedAt = new Date().toISOString()
      await saveCoordinatorState(state)
      input.onInstanceUpdate?.(instance)
      await appendCoordinatorLog(state, "info", `[${instance.id}] held out (role=test)`)
      continue
    }
    while (inFlight.size >= fanoutLimit) {
      await Promise.race(inFlight)
    }
    const job = runSingleInstance(input.cwd, state, spec, instance, input.onInstanceUpdate, dependencies)
      .finally(() => {
        inFlight.delete(job)
      })
    inFlight.add(job)
  }
  await Promise.all(inFlight)

  const summary: FanoutOutcome = {
    totalInstances: state.instances.length,
    passed: state.instances.filter((i) => i.status === "passed").length,
    exhausted: state.instances.filter((i) => i.status === "exhausted").length,
    failed: state.instances.filter((i) => i.status === "failed").length,
    skipped: state.instances.filter((i) => i.status === "skipped").length,
    durationMs: Date.now() - startedAt,
  }
  if (state.instances.some((row) => row.engine === "protocol_project")) {
    summary.running = state.instances.filter((row) => row.status === "running").length
  }
  await appendCoordinatorLog(
    state,
    "info",
    `Phase 1 fanout ${summary.running ? "pending" : "complete"}: ${summary.passed} passed, ${summary.exhausted} exhausted, ${summary.failed} failed, ${summary.skipped} skipped`,
  )
  return summary
}

async function runSingleInstance(
  cwd: string,
  state: CoordinatorState,
  spec: InstanceSpec,
  instance: InstanceState,
  notify?: (instance: InstanceState) => void,
  dependencies?: { projectDriver?: ProjectCampaignDriver; protocolRuntime?: Runtime },
) {
  instance.status = "running"
  await saveCoordinatorState(state)
  notify?.(instance)
  await appendCoordinatorLog(state, "info", `[${instance.id}] launching campaign`)

  // Heartbeat: keep coordinator-state.json fresh while the campaign runs,
  // so external monitors don't see stale timestamps during long operations.
  const heartbeatHandle = setInterval(() => {
    state.heartbeatAt = new Date().toISOString()
    state.updatedAt = state.heartbeatAt
    void saveCoordinatorState(state).catch(() => undefined)
  }, 60_000)

  try {
    const project = spec.engine === "protocol_project" ? await projectCampaign({ cwd,
      taskRoot: spec.sourceTaskRoot, taskID: spec.id, rounds: instance.rounds,
      launchRoot: path.join(fanoutDir(state.runRoot), instanceSlot(instance), "campaign-launch") }, dependencies?.projectDriver) : undefined
    if (project) {
      instance.campaignID = project.campaignID
      instance.campaignDir = project.campaignDir
      instance.campaignRunRoot = project.campaignDir
      if (!project.terminal) {
        // 健康运行的接管结果不是失败，也不是训练结束。
        instance.status = "running"
        await saveCoordinatorState(state)
        notify?.(instance)
        return
      }
    }
    const result = project ? { mode: "campaign" as const, runDir: project.campaignDir,
      runRoot: project.campaignDir, passed: project.status === "verified_success" } : await runSkillsBenchTask({
      cwd,
      // Use absolute taskRoot so SkillLearnBench-style nested layouts
      // (`<root>/tasks/<family>/<instance>`) work alongside the canonical
      // SkillsBench layout. taskID is still passed for docker-tag naming.
      taskRoot: spec.sourceTaskRoot,
      taskID: spec.taskID,
      concurrencyScope: `skillsbench:${path.basename(path.dirname(spec.sourceTaskRoot))}`,
      mode: "campaign",
      rounds: instance.rounds,
      // Title goes through createLongTaskCampaignID's slugify, which
      // truncates to 48 chars. Put the unique instance id FIRST so it
      // survives truncation; otherwise multiple parallel fan-out children
      // would collide on the same campaign directory and clobber each
      // other's pending-expert-package output.
      campaignTitle: `mi-${instance.id}-fanout-${state.id}`,
    })
    if (result.mode !== "campaign") {
      throw new Error(`Unexpected non-campaign result for instance ${instance.id}`)
    }
    instance.campaignDir = result.runDir
    instance.campaignRunRoot = result.runRoot
    instance.status = project?.status === "failed" ? "failed" : result.passed ? "passed" : "exhausted"
    instance.finishedAt = new Date().toISOString()

    // Snapshot the pending-expert-package into the coordinator run root.
    if (result.runDir) {
      if (project && !await pathExists(path.join(result.runDir, "protocol-plugins", "entry.snapshot.json"))) {
        throw new Error("Project Campaign missing frozen protocol; no legacy harvest fallback")
      }
      if (await pathExists(path.join(result.runDir, "protocol-plugins", "entry.snapshot.json"))) {
        // 新协议只收集实际通过的候选，不能复制未验收current冒充成功。
        if (result.passed) {
          const got = await harvest({ cwd, campaignRoot: result.runDir, taskID: instance.id,
            targetRoot: path.join(fanoutDir(state.runRoot), instanceSlot(instance), "protocol-skill") }, dependencies?.protocolRuntime)
          instance.harvestedSkillPath = got.candidateRoot
          instance.harvestedProtocolReceiptPath = got.receiptPath
        }
      } else {
      const pendingDir = path.join(result.runDir, "pending-expert-package", "current")
      if (await pathExists(pendingDir)) {
        const harvestRoot = path.join(fanoutDir(state.runRoot), instance.id)
        await ensureDirectory(harvestRoot)
        // Copy the pending package — it's the canonical skill output for
        // this instance and may be referenced by phases 2 and 3 even after
        // the source campaign is cleaned up.
        await copyTree(pendingDir, path.join(harvestRoot, "pending-expert-package"))
        instance.harvestedSkillPath = path.join(harvestRoot, "pending-expert-package")
      } else {
        await appendCoordinatorLog(
          state,
          "warn",
          `[${instance.id}] no pending-expert-package found at ${pendingDir}`,
        )
      }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    instance.status = "failed"
    instance.errorMessage = message
    instance.finishedAt = new Date().toISOString()
    await appendCoordinatorLog(state, "error", `[${instance.id}] failed: ${message}`)
  } finally {
    clearInterval(heartbeatHandle)
  }
  await saveCoordinatorState(state)
  notify?.(instance)
}

async function copyTree(source: string, target: string) {
  await ensureDirectory(target)
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const s = path.join(source, entry.name)
    const t = path.join(target, entry.name)
    if (entry.isDirectory()) {
      await copyTree(s, t)
    } else {
      await cp(s, t, { force: true })
    }
  }
}

/**
 * Resolve the SkillsBench task id for an instance. For SkillsBench tasks
 * (which are the only engine in M2), the source task root path is the task
 * directory itself, so the task id is just its basename.
 */
function skillsbenchTaskIDFromInstance(instance: InstanceState): string {
  return path.basename(instance.sourceTaskRoot)
}

export { coordinatorRunID }
