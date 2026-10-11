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
import { cp } from "node:fs/promises"
import { ensureDirectory, pathExists, readJsonFile, readTextFile, writeJsonFile, writeTextFile } from "../fs"
import { runSkillsBenchTask } from "../skillsbench-adapter"
import { runOpencodeTask } from "../opencode"
import { loadConfig } from "../schema"
import { loadLongTaskSpec } from "../long-task/spec"
import type {
  LongTaskPathRef,
  LongTaskPromptValidatorContract,
  LongTaskScriptValidatorContract,
  LongTaskSpec,
  LongTaskValidatorContract,
} from "../long-task/contract"
import { runBlankEval } from "../blank-eval/runner"
import type { CoordinatorState, InstanceState } from "./contract"
import { appendCoordinatorLog, saveCoordinatorState, validateDir, instanceSlot } from "./repository"
import {
  hasMergeAcceptanceStage,
  normalizeMergeAcceptanceStages,
  normalizeMergeAcceptanceSuccessCriterion,
  type MergeAcceptanceStage,
  type MergeAcceptanceStatus,
  type MergeAcceptanceSuccessCriterion,
} from "./merge-acceptance-policy"
import { buildAccessProfile } from "../access-profile"
import { instanceReplay, ProtocolReplayFault } from "../protocol-plugins/instance-replay"
import { instanceRepairCurrent, type ProtocolRepairAuthorConfig } from "../protocol-plugins/instance-repair"
import type { Runtime } from "../protocol-plugins/runtime"

export interface RunValidateInput {
  cwd: string
  state: CoordinatorState
  /** Number of rounds for each validation campaign. */
  rounds?: number
  /** Concurrency cap for parallel validation campaigns. */
  validateLimit?: number
  /** When set, only validate instances with this status (default: all eligible). */
  filter?: (instance: InstanceState) => boolean
  repair?: {
    enabled: boolean
    mode: "append_only"
    maxAttemptsPerCase: number
    promptPath?: string
    contractPath?: string
    protocolAuthor?: ProtocolRepairAuthorConfig
  }
  acceptancePolicy?: {
    stages?: MergeAcceptanceStage[]
    successCriterion?: MergeAcceptanceSuccessCriterion
    finalReplaySlotName?: string
  }
}

export interface ReplaySnapshot {
  total: number
  passed: number
  failed: number
  skipped: number
  regressions: string[]
}

export interface ValidateOutcome {
  total: number
  passed: number
  failed: number
  skipped: number
  regressions: string[]
  repairAttempts?: number
  repairFixed?: number
  initialReplay?: ReplaySnapshot
  finalReplay?: ReplaySnapshot
  acceptanceStatus?: MergeAcceptanceStatus
  accepted?: boolean
  mergedSkillDir?: string
  stagesRun?: MergeAcceptanceStage[]
  durationMs: number
}

export async function runCoordinatorPhase3Validate(input: RunValidateInput,
  dependencies?: { protocolRuntime?: Runtime }): Promise<ValidateOutcome> {
  const state = input.state
  state.phase = "phase3_validate"
  await saveCoordinatorState(state)
  const startedAt = Date.now()
  const heartbeatHandle = setInterval(() => {
    state.heartbeatAt = new Date().toISOString()
    state.updatedAt = state.heartbeatAt
    void saveCoordinatorState(state).catch(() => undefined)
  }, 60_000)

  try {
    if (!state.mergedSkillDir) {
      throw new Error(
        "Phase 3 cannot run: state.mergedSkillDir is not set. Run Phase 2 (merge) first.",
      )
    }
    let mergedSkillDir = state.mergedSkillDir

    const presetStages = input.acceptancePolicy?.stages ?? (input.repair?.enabled ? undefined : ["initial_replay"])
    const stages = normalizeMergeAcceptanceStages({ raw: presetStages, preset: "repair_promote" })
    const successCriterion = normalizeMergeAcceptanceSuccessCriterion(
      input.acceptancePolicy?.successCriterion,
      "all_pass",
    )
    const validateRoot = validateDir(state.runRoot)
    await ensureDirectory(validateRoot)

    const rounds = input.rounds ?? 2
    const limit = input.validateLimit ?? state.options.fanoutLimit ?? state.instances.length
    const filter = input.filter ?? defaultFilter

    const eligible = state.instances.filter(filter)
    let initialReplay: ReplaySnapshot | undefined
    let finalReplay: ReplaySnapshot | undefined
    let acceptanceStatus: MergeAcceptanceStatus = "not_run"
    let accepted = false

    if (hasMergeAcceptanceStage(stages, "initial_replay")) {
      const regressions: string[] = []
      await runValidationBatch({
        cwd: input.cwd,
        state,
        eligible,
        mergedSkillDir,
        rounds,
        limit,
        regressions,
        protocolRuntime: dependencies?.protocolRuntime,
      })
      // 新协议故障先停止，不能进入旧式Skill修补烧额度。
      if (eligible.some((row) => row.validateProtocolFault)) throw new Error("Protocol replay infrastructure fault; inspect before repair")
      initialReplay = replaySnapshot(state.instances, eligible, regressions)
      acceptanceStatus = initialReplay.failed === 0 ? "replay_passed" : "replay_failed"
    } else {
      acceptanceStatus = "merge_only"
    }

    let repairAttempts = 0
    let repairFixed = 0
    if (
      hasMergeAcceptanceStage(stages, "repair_promote") &&
      input.repair?.enabled &&
      input.repair.mode === "append_only"
    ) {
      state.phase = "phase4_repair"
      await saveCoordinatorState(state)
      const targets = eligible.filter((row) => row.role !== "test" && row.validateStatus === "failed")
      for (const row of targets) {
        const got = await runOneRepair({
          cwd: input.cwd,
          state,
          instance: row,
          mergedSkillDir,
          rounds,
          repair: input.repair,
        })
        repairAttempts += got.attempts
        if (got.fixed) {
          repairFixed += 1
          mergedSkillDir = state.mergedSkillDir ?? mergedSkillDir
        }
      }
      if (repairAttempts > 0) acceptanceStatus = "repair_promoted"
    }

    if (hasMergeAcceptanceStage(stages, "final_full_replay")) {
      state.phase = "phase3_validate"
      await saveCoordinatorState(state)
      resetValidationStatus(eligible)
      const finalRegressions: string[] = []
      await appendCoordinatorLog(
        state,
        "info",
        `Phase 3 final full replay starting against promoted merged skill (${eligible.length} instances)`,
      )
      await runValidationBatch({
        cwd: input.cwd,
        state,
        eligible,
        mergedSkillDir,
        rounds,
        limit,
        regressions: finalRegressions,
        slotName: input.acceptancePolicy?.finalReplaySlotName ?? "final-full-replay",
        protocolRuntime: dependencies?.protocolRuntime,
      })
      if (eligible.some((row) => row.validateProtocolFault)) throw new Error("Protocol final replay fault; inspect before promotion")
      finalReplay = replaySnapshot(state.instances, eligible, finalRegressions)
      acceptanceStatus = finalReplay.failed === 0 ? "final_replay_passed" : "final_replay_failed"
    }

    const current = replaySnapshot(state.instances, eligible, finalReplay?.regressions ?? initialReplay?.regressions ?? [])
    const decisive = finalReplay ?? current
    if (hasMergeAcceptanceStage(stages, "strict_acceptance_gate")) {
      accepted =
        successCriterion === "report_only"
          ? true
          : successCriterion === "allow_partial"
            ? decisive.passed > 0
            : decisive.total > 0 && decisive.passed === decisive.total
      acceptanceStatus = accepted ? "strict_success" : "strict_failed"
    } else {
      accepted = decisive.total > 0 && decisive.passed === decisive.total
    }

    const summary: ValidateOutcome = {
      total: current.total,
      passed: current.passed,
      failed: current.failed,
      skipped: current.skipped,
      regressions: current.regressions,
      repairAttempts,
      repairFixed,
      initialReplay,
      finalReplay,
      acceptanceStatus,
      accepted,
      mergedSkillDir,
      stagesRun: stages,
      durationMs: Date.now() - startedAt,
    }
    await writeJsonFile(path.join(validateRoot, "summary.json"), summary)
    await appendCoordinatorLog(
      state,
      "info",
      `Phase 3: ${current.passed}/${current.total} passed, acceptance=${acceptanceStatus}`,
    )

    state.phase = "completed"
    await saveCoordinatorState(state)
    return summary
  } finally {
    clearInterval(heartbeatHandle)
  }
}

async function runValidationBatch(input: {
  cwd: string
  state: CoordinatorState
  eligible: InstanceState[]
  mergedSkillDir: string
  rounds: number
  limit: number
  regressions: string[]
  slotName?: string
  protocolRuntime?: Runtime
}) {
  const inFlight = new Set<Promise<unknown>>()
  for (const instance of input.eligible) {
    while (inFlight.size >= input.limit) {
      await Promise.race(inFlight)
    }
    const job = runOneValidation(
      input.cwd,
      input.state,
      instance,
      input.mergedSkillDir,
      input.rounds,
      input.regressions,
      input.slotName,
      input.protocolRuntime,
    ).finally(() => inFlight.delete(job))
    inFlight.add(job)
  }
  await Promise.all(inFlight)
}

function replaySnapshot(allInstances: InstanceState[], eligible: InstanceState[], regressions: string[]): ReplaySnapshot {
  const total = eligible.length
  return {
    total,
    passed: eligible.filter((i) => i.validateStatus === "passed").length,
    failed: eligible.filter((i) => i.validateStatus === "failed").length,
    skipped: allInstances.length - total,
    regressions: [...regressions],
  }
}

function resetValidationStatus(instances: InstanceState[]) {
  for (const instance of instances) {
    instance.validateStatus = undefined
    instance.validateCampaignDir = undefined
    instance.validateRunRoot = undefined
    instance.validateErrorMessage = undefined
    instance.validateProtocolFault = undefined
  }
}

async function runOneValidation(
  cwd: string,
  state: CoordinatorState,
  instance: InstanceState,
  mergedSkillDir: string,
  rounds: number,
  regressions: string[],
  slotName?: string,
  protocolRuntime?: Runtime,
) {
  instance.validateStatus = "running"
  await saveCoordinatorState(state)
  await appendCoordinatorLog(
    state,
    "info",
    `[${instance.id}] ${slotName ? `${slotName} ` : ""}phase3 validation starting`,
  )

  const slotDir = path.join(validateDir(state.runRoot), instanceSlot(instance), ...(slotName ? [slotName] : []))
  await ensureDirectory(slotDir)

  try {
    const protocol = await instanceReplay({ cwd, sourceTaskRoot: instance.sourceTaskRoot,
      parentRunRoot: instance.role === "test" ? state.protocolMergeParentRunRoot : instance.campaignDir,
      candidateRoot: mergedSkillDir, slotDir, role: instance.role,
      sourceReceiptPath: instance.harvestedProtocolReceiptPath,
      deploymentRoot: path.join(state.runRoot, "protocol-test-deployment") }, protocolRuntime)
    if (protocol) {
      instance.validateStatus = protocol.passed ? "passed" : "failed"
      instance.validateProtocolFault = protocol.infrastructureFailure
      instance.validateCampaignDir = protocol.runRoot
      instance.validateRunRoot = protocol.runRoot
      await writeJsonFile(path.join(slotDir, "run.json"), { instanceID: instance.id,
        passed: protocol.passed, protocolStatus: protocol.receipt.status,
        claim: protocol.receipt.claim, executed: protocol.receipt.executed,
        preservation: protocol.preservation,
        runRoot: protocol.runRoot, infrastructureFailure: protocol.infrastructureFailure })
      if (!protocol.infrastructureFailure && protocol.preservation?.regression && instance.role !== "test" && instance.status === "passed") {
        regressions.push(instance.id)
      }
      await saveCoordinatorState(state)
      return
    }
    const hasTaskToml = await pathExists(path.join(instance.sourceTaskRoot, "task.toml"))
    if (hasTaskToml) {
      const result = await runSkillsBenchTask({
        cwd,
        taskRoot: instance.sourceTaskRoot,
        taskID: skillsbenchTaskIDFromInstance(instance),
        concurrencyScope: `skillsbench:${path.basename(path.dirname(instance.sourceTaskRoot))}`,
        mode: "campaign",
        rounds,
        seedExpertWorkspacePath: mergedSkillDir,
        campaignTitle: `mi-${instance.id}-validate-${state.id}`,
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
    } else {
      const specPath = await writeBlankEvalSpec({
        cwd,
        instance,
        slotDir,
      })
      const result = await runBlankEval({
        cwd,
        specPath,
        skillRoots: [mergedSkillDir],
        runRoot: path.join(slotDir, "blank-eval"),
        sourceID: instance.id,
        mode: instance.role === "test" ? "test" : "train-backtest",
        concurrencyScope: `multi-instance-validate:${state.id}`,
      })
      instance.validateStatus = result.passed ? "passed" : "failed"
      instance.validateCampaignDir = result.runDir
      instance.validateRunRoot = result.runDir
      await writeJsonFile(path.join(slotDir, "run.json"), {
        instanceID: instance.id,
        passed: instance.validateStatus === "passed",
        blankEvalDir: result.runDir,
        status: result.passed ? "verified_success" : "failed",
        summary: result.summary,
      })
    }

    // A regression is when an instance that originally passed in Phase 1
    // now fails on the merged skill. That signals the merger dropped
    // something the instance depended on. Held-out test instances cannot
    // regress (they had no Phase 1 baseline to begin with) — failure on a
    // test instance is just a generalization gap.
    if (instance.role !== "test" && instance.status === "passed" && instance.validateStatus !== "passed") {
      regressions.push(instance.id)
      await appendCoordinatorLog(
        state,
        "warn",
        `[${instance.id}] regression detected: passed in fan-out, fails on merged skill`,
      )
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof ProtocolReplayFault) instance.validateProtocolFault = true
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

async function runOneRepair(input: {
  cwd: string
  state: CoordinatorState
  instance: InstanceState
  mergedSkillDir: string
  rounds: number
  repair: NonNullable<RunValidateInput["repair"]>
}) {
  const sourceSpecPath = path.join(input.instance.sourceTaskRoot, "spec.json")
  if (await pathExists(sourceSpecPath)) {
    const source = await readJsonFile<{ protocolPlugins?: unknown }>(sourceSpecPath)
    if (source.protocolPlugins) {
      if (!input.instance.campaignDir || !input.instance.validateRunRoot || !input.repair.protocolAuthor) {
        throw new Error("Frozen parent, rejection receipt and explicit protocol author required; no legacy repair fallback")
      }
      const result = await instanceRepairCurrent({ cwd: input.cwd, sourceTaskRoot: input.instance.sourceTaskRoot,
        parentRunRoot: input.instance.campaignDir, candidateRoot: input.mergedSkillDir,
        initialReceiptPath: path.join(input.instance.validateRunRoot, "attempt", "protocol.receipt.json"),
        repairRoot: path.join(input.state.runRoot, "phase4-repair", instanceSlot(input.instance)),
        maxAttempts: input.repair.maxAttemptsPerCase, author: input.repair.protocolAuthor })
      if (result.fixed) {
        input.state.mergedSkillDir = result.candidateRoot
        input.instance.validateStatus = "passed"
        await saveCoordinatorState(input.state)
      }
      return { attempts: result.attempts, fixed: result.fixed }
    }
  }
  const root = path.join(input.state.runRoot, "phase4-repair", instanceSlot(input.instance))
  await ensureDirectory(root)
  const max = Math.max(1, input.repair.maxAttemptsPerCase)
  const promptPath =
    input.repair.promptPath ??
    path.join(input.cwd, "auto-evolve", "methods", "recipes", "multi-instance", "prompts", "merge-repair.md")
  let previousAppendOnlyFailure: unknown

  for (let i = 1; i <= max; i += 1) {
    const n = String(i).padStart(2, "0")
    const dir = path.join(root, `attempt-${n}`)
    const draft = path.join(dir, "draft-merged-skill")
    await ensureDirectory(dir)
    await cp(input.mergedSkillDir, draft, { recursive: true, force: true })

    await bootstrapPatchFiles(draft)
    const cls = await classifyFailure(input.instance)
    const prompt = await buildRepairPrompt({
      instance: input.instance,
      cls,
      promptPath,
      contractPath: input.repair.contractPath,
      draft,
      base: input.mergedSkillDir,
      previousAppendOnlyFailure,
    })
    const cfg = await loadConfig(input.cwd)
    const access = await buildAccessProfile({
      role: "multi_instance_repair_agent",
      mode: "open_book",
      readPaths: [
        input.instance.sourceTaskRoot,
        input.mergedSkillDir,
        ...(input.repair.contractPath ? [input.repair.contractPath] : []),
      ],
      editPaths: [draft],
    })
    const task = await runOpencodeTask({
      cwd: input.cwd,
      config: cfg,
      title: `mi-append-repair-${input.instance.id}-${n}`,
      prompt,
      referencePaths: access.referencePaths,
      permissionReadPaths: access.permissionReadPaths,
      permissionEditPaths: access.permissionEditPaths,
      concurrencyScope: `mi-repair:${input.state.id}`,
    })
    await writeTextFile(path.join(dir, "response.txt"), task.result.responseText)
    await writeTextFile(path.join(dir, "stdout.log"), task.result.stdout)
    await writeTextFile(path.join(dir, "stderr.log"), task.result.stderr)

    const check = await runAppendOnlyCheck(input.cwd, input.mergedSkillDir, draft)
    await writeJsonFile(path.join(dir, "append-only-check.json"), check)
    if (!check.passed) {
      previousAppendOnlyFailure = check
      await appendCoordinatorLog(
        input.state,
        "warn",
        `[${input.instance.id}] repair attempt ${n} rejected by append-only check`,
      )
      continue
    }

    const res = await rerunValidationWithMerged({
      cwd: input.cwd,
      state: input.state,
      instance: input.instance,
      mergedSkillDir: draft,
      rounds: input.rounds,
      slotName: `repair-${n}`,
    })
    await writeJsonFile(path.join(dir, "validation-result.json"), res)
    if (res.passed) {
      input.state.mergedSkillDir = draft
      await saveCoordinatorState(input.state)
      await appendCoordinatorLog(
        input.state,
        "info",
        `[${input.instance.id}] repair succeeded at attempt ${n}`,
      )
      return { attempts: i, fixed: true }
    }
  }

  await appendCoordinatorLog(
    input.state,
    "warn",
    `[${input.instance.id}] repair exhausted without fix`,
  )
  return { attempts: max, fixed: false }
}

async function rerunValidationWithMerged(input: {
  cwd: string
  state: CoordinatorState
  instance: InstanceState
  mergedSkillDir: string
  rounds: number
  slotName: string
}) {
  const slotDir = path.join(validateDir(input.state.runRoot), instanceSlot(input.instance), input.slotName)
  await ensureDirectory(slotDir)

  const hasTaskToml = await pathExists(path.join(input.instance.sourceTaskRoot, "task.toml"))
  if (hasTaskToml) {
    const result = await runSkillsBenchTask({
      cwd: input.cwd,
      taskRoot: input.instance.sourceTaskRoot,
      taskID: skillsbenchTaskIDFromInstance(input.instance),
      concurrencyScope: `skillsbench:${path.basename(path.dirname(input.instance.sourceTaskRoot))}`,
      mode: "campaign",
      rounds: input.rounds,
      seedExpertWorkspacePath: input.mergedSkillDir,
      campaignTitle: `mi-${input.instance.id}-repair-${input.state.id}`,
    })
    const passed = result.mode === "campaign" && result.passed
    await writeJsonFile(path.join(slotDir, "run.json"), {
      passed,
      runDir: result.mode === "campaign" ? result.runDir : "",
      runRoot: result.mode === "campaign" ? result.runRoot : "",
    })
    input.instance.validateStatus = passed ? "passed" : "failed"
    return { passed }
  }

  const specPath = await writeBlankEvalSpec({
    cwd: input.cwd,
    instance: input.instance,
    slotDir,
  })
  const result = await runBlankEval({
    cwd: input.cwd,
    specPath,
    skillRoots: [input.mergedSkillDir],
    runRoot: path.join(slotDir, "blank-eval"),
    sourceID: input.instance.id,
    mode: input.instance.role === "test" ? "test" : "train-backtest",
    concurrencyScope: `multi-instance-repair-validate:${input.state.id}`,
  })
  const passed = result.passed
  await writeJsonFile(path.join(slotDir, "run.json"), {
    passed,
    blankEvalDir: result.runDir,
    status: passed ? "verified_success" : "failed",
    summary: result.summary,
  })
  input.instance.validateStatus = passed ? "passed" : "failed"
  return { passed }
}

function keyPath(input: string) {
  const got = path.resolve(input).replace(/\\/g, "/").replace(/\/+$/g, "")
  return process.platform === "win32" ? got.toLowerCase() : got
}

function within(root: string, target: string) {
  const base = keyPath(root)
  const got = keyPath(target)
  return got === base || got.startsWith(`${base}/`)
}

function uniqueStrings(items: string[]) {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)))
}

function resolveProfileRefForGeneratedSpec(cwd: string, ref: string) {
  const trimmed = ref.trim()
  if (!trimmed) return trimmed
  if (path.isAbsolute(trimmed)) return trimmed
  const normalized = trimmed.replace(/\\/g, "/").replace(/^\/+/, "")
  const withExt = normalized.endsWith(".json") ? normalized : `${normalized}.json`
  return path.resolve(cwd, "task-packs", "validator-profiles", withExt)
}

function uniqueRefs(items: LongTaskPathRef[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = keyPath(item.path)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function mapInto(root: string, slotDir: string, target: string) {
  const resolved = path.resolve(target)
  if (within(root, resolved)) {
    const relative = path.relative(root, resolved)
    if (relative === "workspace" || relative.startsWith(`workspace${path.sep}`)) return relative
    return path.join("workspace", relative)
  }
  return path.join("workspace", "external", path.basename(resolved))
}

function isSkillish(spec: LongTaskSpec, target: string) {
  const lower = target.replace(/\\/g, "/").toLowerCase()
  if (lower.includes("/expert-workspace")) return true
  if (lower.includes("/validation-expert-workspace")) return true
  return (spec.formalPackageRoots ?? []).some((root) => within(root, target))
}

function inferTargets(spec: LongTaskSpec, root: string, slotDir: string): LongTaskPathRef[] {
  const artifacts = uniqueStrings(
    (spec.initialGraph?.units ?? [])
      .flatMap((unit) => unit.expected_artifacts)
      .filter((item) => !isSkillish(spec, item)),
  )
  const source = artifacts.length ? artifacts : (spec.targetPaths ?? []).map((item) => item.path).filter((item) => !isSkillish(spec, item))
  return sortCandidateLikeTargets(uniqueStrings(source)).map((item) => ({
    path: mapInto(root, slotDir, item),
    label: path.basename(item) || "blank eval output",
    role: "target-artifact",
  }))
}

function candidatePriority(item: string) {
  const base = path.basename(item).toLowerCase()
  if (base === "answer.txt") return 0
  if (base === "answer.json") return 1
  if (base === "plan.json") return 2
  if (base.startsWith("answer.")) return 3
  if (base.includes("answer")) return 4
  return 10
}

function sortCandidateLikeTargets(items: string[]) {
  return items
    .map((item, index) => ({ item, index, priority: candidatePriority(item) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((entry) => entry.item)
}

function inferEdits(spec: LongTaskSpec, root: string, slotDir: string, targets: LongTaskPathRef[]) {
  const edits = (spec.editablePaths ?? [])
    .filter((item) => !isSkillish(spec, item))
    .map((item) => mapInto(root, slotDir, item))
  const dirs = targets.map((item) => (path.extname(item.path) ? path.dirname(item.path) : item.path))
  return uniqueStrings([...edits, ...dirs])
}

async function firstExisting(items: string[]) {
  for (const item of items) {
    if (!item.trim()) continue
    if (await pathExists(item)) return item
  }
  return undefined
}

function isSkillValidator(item: LongTaskValidatorContract) {
  const id = item.id.toLowerCase()
  if (id.includes("workspace-layout")) return true
  if (id.includes("surface-generalization")) return true
  if (item.type === "script" && item.path.toLowerCase().includes("validate-experience")) return true
  return false
}

async function patchValidator(input: {
  item: LongTaskValidatorContract
  root: string
  targets: LongTaskPathRef[]
  human?: string
}): Promise<LongTaskValidatorContract> {
  const target = selectValidatorCandidateTarget(input.item, input.targets)
  if (input.item.type === "script") {
    const val: LongTaskScriptValidatorContract = {
      ...input.item,
      args: patchScriptValidatorArgs({
        args: input.item.args ?? [],
        root: input.root,
        target,
      }),
    }
    return val
  }
  if (input.item.type !== "prompt_json") return input.item
  const answer = await firstExisting([
    input.item.inputFiles?.answerPath ?? "",
    path.join(input.root, "answer", "answer.md"),
  ])
  const val: LongTaskPromptValidatorContract = {
    ...input.item,
    attachedFiles: [],
    inputFiles: {
      ...(input.item.inputFiles ?? {}),
      answerPath: answer ?? input.item.inputFiles?.answerPath,
      candidatePath: target ?? input.item.inputFiles?.candidatePath,
      humanGuidancePath: input.human ?? input.item.inputFiles?.humanGuidancePath,
    },
  }
  return val
}

function expectedCandidateBasename(item: LongTaskValidatorContract) {
  if (item.type === "script") {
    for (let i = 0; i < (item.args ?? []).length; i += 1) {
      const prev = item.args?.[i - 1]
      if (prev === "--candidate" || prev === "--candidate-path") {
        const value = item.args?.[i]
        return value ? path.basename(value).toLowerCase() : undefined
      }
    }
  }
  if (item.type === "prompt_json" && item.inputFiles?.candidatePath) {
    return path.basename(item.inputFiles.candidatePath).toLowerCase()
  }
  return undefined
}

function selectValidatorCandidateTarget(item: LongTaskValidatorContract, targets: LongTaskPathRef[]) {
  if (!targets.length) return undefined
  const expected = expectedCandidateBasename(item)
  if (expected) {
    const hit = targets.find((target) => path.basename(target.path).toLowerCase() === expected)
    if (hit) return hit.path
  }
  return targets[0]?.path
}

function patchScriptValidatorArgs(input: { args: string[]; root: string; target?: string }) {
  return input.args.map((arg, index, all) => {
    const prev = all[index - 1]
    if ((prev === "--candidate" || prev === "--candidate-path") && input.target) return input.target
    if (prev === "--answer" || prev === "--answer-path" || prev === "--expected") {
      if (path.isAbsolute(arg)) return arg
      return path.resolve(input.root, arg)
    }
    return arg
  })
}

async function writeBlankEvalSpec(input: {
  cwd: string
  instance: InstanceState
  slotDir: string
}) {
  const root = input.instance.sourceTaskRoot
  const loaded = await loadLongTaskSpec(path.join(root, "spec.json"), {
    allowMissingInitialExpertContextPaths: true,
  })
  const targets = inferTargets(loaded.spec, root, input.slotDir)
  const edits = inferEdits(loaded.spec, root, input.slotDir, targets)
  const human = await firstExisting([path.join(root, "human-guidance.md"), path.join(root, "instruction.md")])
  const materials = uniqueRefs([
    ...loaded.spec.materials,
    ...(human ? [{ path: human, label: "human task guidance", role: "human-guidance" }] : []),
  ])
  const validators = await Promise.all(
    loaded.spec.validators
      .filter((item) => !isSkillValidator(item))
      .map((item) =>
        patchValidator({
          item,
          root,
          targets,
          human,
        }),
      ),
  )
  const blankEvalValidatorProfiles = uniqueStrings(
    (loaded.spec.blankEvalValidatorProfiles ?? []).map((item) =>
      resolveProfileRefForGeneratedSpec(input.cwd, item),
    ),
  )
  const useProfileValidators = blankEvalValidatorProfiles.length > 0
  if (!useProfileValidators && validators.length === 0) {
    throw new Error(`Blank eval spec for ${input.instance.id} has no task-output validators after filtering skill validators.`)
  }
  const spec = {
    id: loaded.spec.id,
    title: `${loaded.spec.title} blank eval`,
    goal: [
      loaded.spec.goal,
      "",
      "Deployment validation only: use the supplied formal skill and allowed materials to complete the declared task outputs. Do not create, repair, or validate a skill package.",
    ].join("\n"),
    taskFamily: loaded.spec.taskFamily,
    domainTags: loaded.spec.domainTags,
    materials,
    targetPaths: targets.length ? targets : loaded.spec.targetPaths,
    editablePaths: edits,
    initialExpertContextPaths: [],
    formalPackageRoots: [],
    capabilities: loaded.spec.capabilities,
    validatorProfiles: useProfileValidators ? blankEvalValidatorProfiles : undefined,
    validators: useProfileValidators ? [] : validators,
    execution: loaded.spec.execution,
    validation: loaded.spec.validation,
    disableCompletionValidators: false,
    notes: "Generated by multi-instance validation as a hermetic blank-agent evaluation spec.",
  }
  const specPath = path.join(input.slotDir, "blank-eval.spec.json")
  await writeJsonFile(specPath, spec)
  return specPath
}

async function bootstrapPatchFiles(dir: string) {
  const patchDir = path.join(dir, "patches")
  await ensureDirectory(patchDir)
  const doc = path.join(patchDir, "training-backtest-patches.md")
  const log = path.join(patchDir, "patch-log.jsonl")
  if (!(await pathExists(doc))) {
    await writeTextFile(doc, "# Training Backtest Patches\n\n")
  }
  if (!(await pathExists(log))) {
    await writeTextFile(log, "")
  }
}

async function classifyFailure(row: InstanceState) {
  const text = (await failureText(row)).toLowerCase()
  const cls = failureClass(text)
  if (cls) return cls
  if (text.includes("schema") || text.includes("json")) return "schema_invalid"
  if (
    text.includes("candidate_missing") ||
    text.includes("missing_candidate") ||
    text.includes("candidate file not found") ||
    text.includes("candidate not found") ||
    (text.includes("candidate") && text.includes("missing"))
  ) {
    return "missing_candidate"
  }
  if (text.includes("candidate") || text.includes("format")) return "candidate_format_invalid"
  if (text.includes("evidence") || text.includes("specific_evidence=false")) return "evidence_missing"
  if (text.includes("actionable") || text.includes("not_actionable")) return "not_actionable"
  if (text.includes("infrastructure") || text.includes("infra")) return "infra_error"
  if (text.includes("score")) return "score_below_threshold"
  if (text.includes("issue") || text.includes("same_issue=false")) return "issue_mismatch"
  return "issue_mismatch"
}

async function failureText(row: InstanceState) {
  const parts = [row.validateErrorMessage ?? ""]
  for (const root of [row.validateCampaignDir, row.validateRunRoot]) {
    if (!root) continue
    const result = await readJsonFile<Record<string, unknown>>(
      path.join(root, "final-acceptance", "result.json"),
    ).catch(() => undefined)
    collectText(result, parts)
  }
  return parts.filter(Boolean).join("\n")
}

function collectText(value: unknown, out: string[]) {
  if (typeof value === "string") {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectText(item, out))
    return
  }
  if (!value || typeof value !== "object") return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === "summary" ||
      key === "details" ||
      key === "failure_class" ||
      key === "failureClass" ||
      key === "validatorID"
    ) {
      collectText(item, out)
    }
  }
}

function failureClass(text: string) {
  const hit = text.match(/failure[_ -]?class\s*[:=]\s*["'`]?([a-z_]+)/i)?.[1]
  if (!hit) return undefined
  if (hit === "candidate_missing") return "missing_candidate"
  if (
    hit === "missing_candidate" ||
    hit === "candidate_format_invalid" ||
    hit === "issue_mismatch" ||
    hit === "evidence_missing" ||
    hit === "not_actionable" ||
    hit === "schema_invalid" ||
    hit === "score_below_threshold" ||
    hit === "infra_error"
  ) {
    return hit
  }
  return undefined
}

async function buildRepairPrompt(input: {
  instance: InstanceState
  cls: string
  promptPath: string
  contractPath?: string
  draft: string
  base: string
  previousAppendOnlyFailure?: unknown
}) {
  const fallback = [
    "You are append-only repair agent.",
    "Only append or add content. Do not delete or rewrite existing content.",
    "Only edit CORE.md, INDEX.md, casebook/*, patches/*, open_observations.md under draft skill.",
  ].join("\n")
  const head = (await readTextFile(input.promptPath).catch(() => fallback)).trim()
  const contractBody = input.contractPath
    ? await readTextFile(input.contractPath).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        return JSON.stringify({ id: "unreadable-contract", error: message }, null, 2)
      })
    : JSON.stringify(
        {
          id: "inline.generic-fallback",
          note: "No merge contract path was provided; use a conservative generic repair.",
        },
        null,
        2,
      )
  return [
    head,
    "",
    "# Merge Contract",
    "",
    input.contractPath ? `Merge contract path: ${input.contractPath}` : "Merge contract path: (inline generic fallback)",
    "",
    "```json",
    contractBody.trim(),
    "```",
    "",
    `Failed instance id: ${input.instance.id}`,
    `Failure class: ${input.cls}`,
    `Base merged skill path: ${input.base}`,
    `Draft merged skill path: ${input.draft}`,
    "",
    "# Platform Append-Only Safety Reminder",
    "",
    "If the merge contract repairPolicy.mode is append_only:",
    "- Existing CORE.md, INDEX.md, open_observations.md, and patches/* are append-only. Add text at the end only.",
    "- Do not rewrite, reorder, reformat, or delete existing lines in append-only files.",
    "- Use repairPolicy.patchLogPath when present; otherwise use patches/patch-log.jsonl.",
    "- Append exactly one JSON object as a new JSONL line to the patch log; never rewrite previous lines.",
    "- Do not create root-level patch-log.md, patches.md, repair.md, or other ad hoc repair logs unless the contract explicitly allows them.",
    "- New or rewritten casebook files are allowed only when the contract allows casebook rewrite/addition.",
    "",
    ...(input.previousAppendOnlyFailure
      ? [
          "# Previous Append-Only Rejection",
          "",
          "The immediately previous repair attempt was rejected before blank-agent validation because it violated append-only policy.",
          "You must not repeat that edit pattern. Use a narrower append/add-only operation this time.",
          "Previous append-only check JSON:",
          "```json",
          JSON.stringify(input.previousAppendOnlyFailure, null, 2),
          "```",
          "",
        ]
      : []),
    "Write additive repairs into draft only.",
    "Do not touch files outside draft.",
    "Do not remove old content.",
  ].join("\n")
}

async function runAppendOnlyCheck(cwd: string, base: string, draft: string) {
  const child = Bun.spawn(
    [process.execPath, "run", "scripts/validate-append-only-skill-patch.ts", base, draft],
    { cwd: path.join(cwd, "auto-evolve"), stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const json = JSON.parse(stdout || "{}") as Record<string, unknown>
  return { ...json, exitCode: code, stderr, passed: code === 0 }
}

function defaultFilter(instance: InstanceState): boolean {
  // Validate verified train skills plus held-out test instances by default.
  // Exhausted train instances never contributed to the merge, because they
  // are unverified drafts rather than learned skills.
  if (instance.role === "test") return true
  return instance.status === "passed"
}

function skillsbenchTaskIDFromInstance(instance: InstanceState): string {
  return path.basename(instance.sourceTaskRoot)
}
