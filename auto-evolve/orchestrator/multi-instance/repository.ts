/**
 * Multi-instance coordinator state persistence.
 *
 * State is serialized to a single JSON file (coordinator-state.json) inside
 * the coordinator run root. We use atomic write (write-temp + rename) on
 * every save to keep the file consistent across crashes.
 *
 * The state file is the sole source of truth for resumability. Anything we
 * need to know after a crash (which instances passed, which campaigns are
 * live, what phase we're in) must be persisted here, not just in memory.
 */

import path from "node:path"
import { readFile } from "node:fs/promises"
import { ensureDirectory, pathExists } from "../fs"
import type { CoordinatorState, InstanceState } from "./contract"
import { createHash } from "node:crypto"
import { writeJsonAtomic } from "../atomic-write"

export function coordinatorStatePath(runRoot: string) {
  return path.join(runRoot, "coordinator-state.json")
}

export function instanceSlot(instance: Pick<InstanceState, "id" | "engine">) {
  // 新项目UID是身份而非路径；旧目录布局保持不变。
  return instance.engine === "protocol_project" ? createHash("sha256").update(instance.id).digest("hex") : instance.id
}

export function fanoutDir(runRoot: string) {
  return path.join(runRoot, "phase1-fanout")
}

export function mergeDir(runRoot: string) {
  return path.join(runRoot, "phase2-merge")
}

export function validateDir(runRoot: string) {
  return path.join(runRoot, "phase3-validate")
}

// Per-runRoot save serialization. Multiple coordinator paths run in
// parallel (Phase 1 fan-out, Phase 3 validate) and all call
// saveCoordinatorState concurrently. Without serialization, two parallel
// writes collide on the temp filename and rename(), producing ENOENT.
const saveLocks = new Map<string, Promise<unknown>>()

export async function saveCoordinatorState(state: CoordinatorState) {
  const runRoot = state.runRoot
  const previous = saveLocks.get(runRoot) ?? Promise.resolve()
  const job = previous
    .catch(() => undefined)
    .then(() => writeStateOnce(state))
  saveLocks.set(runRoot, job)
  try {
    await job
  } finally {
    if (saveLocks.get(runRoot) === job) {
      saveLocks.delete(runRoot)
    }
  }
}

async function writeStateOnce(state: CoordinatorState) {
  state.updatedAt = new Date().toISOString()
  const target = coordinatorStatePath(state.runRoot)
  await ensureDirectory(state.runRoot)
  await writeJsonAtomic(target, state, { attempts: 8, baseDelayMs: 80, maxDelayMs: 2000 })
}

export async function loadCoordinatorState(runRoot: string): Promise<CoordinatorState> {
  const target = coordinatorStatePath(runRoot)
  if (!(await pathExists(target))) {
    throw new Error(`Coordinator state not found: ${target}`)
  }
  const raw = await readFile(target, "utf8")
  return JSON.parse(raw) as CoordinatorState
}

/** Append a log line and persist. */
export async function appendCoordinatorLog(
  state: CoordinatorState,
  level: "info" | "warn" | "error",
  message: string,
) {
  state.log.push({ at: new Date().toISOString(), level, message })
  // Cap log size — anything older than the last 500 entries is dropped to
  // keep the state file small.
  if (state.log.length > 500) state.log = state.log.slice(-500)
  await saveCoordinatorState(state)
}
