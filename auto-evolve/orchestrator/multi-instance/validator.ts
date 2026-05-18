/**
 * Phase 3 — Fan-in validation.
 *
 * Re-run each instance with the merged skill plugged in as the seed expert
 * workspace, and record pass/fail. This is how we measure whether the
 * merger preserved enough information to actually solve the original
 * instances.
 *
 * Design choices:
 *  - We launch a small number of rounds (default 1–2) since this is a
 *    correctness check, not a training run. The skill should not need to
 *    keep "learning" — if it does, the merge dropped something important.
 *  - Concurrency is again capped by the global OpenCodeGate. We additionally
 *    cap by validateLimit (default = fanoutLimit, then state.options
 *    fallback) so we don't queue every validation at once.
 *  - We do NOT modify the merged-skill directory. Each validation campaign
 *    receives a fresh copy of the merged skill at its seedExpertWorkspacePath
 *    so that any in-place workspace mutation does not leak across runs.
 *
 * Output:
 *  - phase3-validate/<instance-id>/run.json  : verifier outcome + run paths.
 *  - state.instances[i].validateStatus       : "passed" | "failed" | "skipped".
 *  - phase3-validate/summary.json            : aggregate pass/fail counts.
 */

import path from "node:path"
import { ensureDirectory, writeJsonFile } from "../fs"
import { runSkillsBenchTask } from "../skillsbench-adapter"
import type { CoordinatorState, InstanceState } from "./contract"
import { appendCoordinatorLog, saveCoordinatorState, validateDir } from "./repository"

export interface RunValidateInput {
  cwd: string
  state: CoordinatorState
  /** Number of rounds for each validation campaign. */
  rounds?: number
  /** Concurrency cap for parallel validation campaigns. */
  validateLimit?: number
  /** When set, only validate instances with this status (default: all eligible). */
  filter?: (instance: InstanceState) => boolean
}

export interface ValidateOutcome {
  total: number
  passed: number
  failed: number
  skipped: number
  regressions: string[]
  durationMs: number
}

export async function runCoordinatorPhase3Validate(input: RunValidateInput): Promise<ValidateOutcome> {
  const state = input.state
  state.phase = "phase3_validate"
  await saveCoordinatorState(state)
  const startedAt = Date.now()

  if (!state.mergedSkillDir) {
    throw new Error(
      "Phase 3 cannot run: state.mergedSkillDir is not set. Run Phase 2 (merge) first.",
    )
  }
  const mergedSkillDir = state.mergedSkillDir

  const validateRoot = validateDir(state.runRoot)
  await ensureDirectory(validateRoot)

  const rounds = input.rounds ?? 2
  const limit = input.validateLimit ?? state.options.fanoutLimit ?? state.instances.length
  const filter = input.filter ?? defaultFilter

  const eligible = state.instances.filter(filter)
  const inFlight = new Set<Promise<unknown>>()
  const regressions: string[] = []

  for (const instance of eligible) {
    while (inFlight.size >= limit) {
      await Promise.race(inFlight)
    }
    const job = runOneValidation(input.cwd, state, instance, mergedSkillDir, rounds, regressions)
      .finally(() => inFlight.delete(job))
    inFlight.add(job)
  }
  await Promise.all(inFlight)

  const total = eligible.length
  const passed = eligible.filter((i) => i.validateStatus === "passed").length
  const failed = eligible.filter((i) => i.validateStatus === "failed").length
  const skipped = state.instances.length - total

  const summary: ValidateOutcome = {
    total,
    passed,
    failed,
    skipped,
    regressions,
    durationMs: Date.now() - startedAt,
  }
  await writeJsonFile(path.join(validateRoot, "summary.json"), summary)
  await appendCoordinatorLog(
    state,
    "info",
    `Phase 3: ${passed}/${total} passed${regressions.length > 0 ? `, regressions: ${regressions.join(", ")}` : ""}`,
  )

  state.phase = "completed"
  await saveCoordinatorState(state)
  return summary
}

async function runOneValidation(
  cwd: string,
  state: CoordinatorState,
  instance: InstanceState,
  mergedSkillDir: string,
  rounds: number,
  regressions: string[],
) {
  instance.validateStatus = "running"
  await saveCoordinatorState(state)
  await appendCoordinatorLog(state, "info", `[${instance.id}] phase3 validation starting`)

  const slotDir = path.join(validateDir(state.runRoot), instance.id)
  await ensureDirectory(slotDir)

  try {
    const result = await runSkillsBenchTask({
      cwd,
      root: state.options.skillsbenchRoot,
      taskID: skillsbenchTaskIDFromInstance(instance),
      mode: "campaign",
      rounds,
      seedExpertWorkspacePath: mergedSkillDir,
      campaignTitle: `multi-instance-validate-${state.id}-${instance.id}`,
    })
    if (result.mode !== "campaign") {
      throw new Error(`Unexpected non-campaign result for instance ${instance.id}`)
    }
    instance.validateStatus = result.passed ? "passed" : "failed"
    instance.validateCampaignDir = result.runDir
    instance.validateRunRoot = result.runRoot

    await writeJsonFile(path.join(slotDir, "run.json"), {
      instanceID: instance.id,
      passed: result.passed,
      campaignDir: result.runDir,
      runRoot: result.runRoot,
    })

    // A regression is when an instance that originally passed in Phase 1
    // now fails on the merged skill. That signals the merger dropped
    // something the instance depended on.
    if (instance.status === "passed" && !result.passed) {
      regressions.push(instance.id)
      await appendCoordinatorLog(
        state,
        "warn",
        `[${instance.id}] regression detected: passed in fan-out, fails on merged skill`,
      )
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    instance.validateStatus = "failed"
    instance.validateErrorMessage = message
    await writeJsonFile(path.join(slotDir, "run.json"), {
      instanceID: instance.id,
      passed: false,
      error: message,
    })
    await appendCoordinatorLog(state, "error", `[${instance.id}] validation crashed: ${message}`)
  }
  await saveCoordinatorState(state)
}

function defaultFilter(instance: InstanceState): boolean {
  // Validate everything that contributed to the merge — failed/skipped
  // instances had no chance to shape the merged skill, so the validation
  // signal is noisy. We still validate "exhausted" instances because their
  // partial skills were merged and we want to know if the merged result
  // helps them now.
  return instance.status === "passed" || instance.status === "exhausted"
}

function skillsbenchTaskIDFromInstance(instance: InstanceState): string {
  return path.basename(instance.sourceTaskRoot)
}
