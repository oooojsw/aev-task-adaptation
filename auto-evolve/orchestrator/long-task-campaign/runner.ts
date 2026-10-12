import path from "node:path"
import process from "node:process"
import { freezeTraining, verifyTraining, trainingExecution, trainingRuntimeBudget, type TrainingRole } from "../protocol-plugins/training"
import { randomUUID } from "node:crypto"
import { cp, lstat, readdir, rm } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import {
  autoEvolvePath,
  ensureDirectory,
  isPathWithinTruthRoot,
  pathExists,
  readJsonFile,
  readTextFile,
  resolvePathTruth,
  writeJsonFile,
  writeTextFile,
} from "../fs"
import { appendJsonlLocked } from "../jsonl"
import {
  identifyProcessOwner,
  optionalProcessOwnerHints,
  strongProcessOwnerHints,
} from "../process-identity"
import {
  experienceWorkspacePathsFromRoot,
  readExperienceWorkspace,
  writeExperienceWorkspaceSnapshot,
} from "../experience-workspace"
import { resumeLongTask, runLongTask } from "../long-task/runner"
import { runLongTaskValidator } from "../long-task/validators"
import { runValidationStage } from "../validation-engine/stage-runner"
import { readOperationalContext, resolveExistingLongTaskRun } from "../long-task/repository"
import { loadLongTaskSpec } from "../long-task/spec"
import { hasConcreteAnswerLeakageSurface } from "../answer-surface"
import { runBlankEval } from "../blank-eval/runner"
import { campaignAcceptance, verifyCompletedCampaignAcceptance, readCompletedRejectedCampaignPass } from "../protocol-plugins/campaign-acceptance"
import { prepareEntry } from "../protocol-plugins/entry"
import { selectedRuntime } from "../protocol-plugins/selected-runtime"
import { authorContext, protocolAuthorLines } from "../protocol-plugins/author-context"
import { protocolFeedbackEvidence, previousProtocolFeedback } from "../protocol-plugins/feedback-evidence"
import { protocolRepairDirective, type ProtocolRepairCheck } from "../protocol-plugins/failure-routing"
import { copyCandidate, hasCandidate, type SkillBinding } from "../protocol-plugins/candidate"
import {
  defaultReuseForPolicy,
  hashFileIfExists,
  isCampaignAuthorizedForContext,
  lineageForAttempt,
  registerCampaignAttempt,
  type BenchmarkHistoryContext,
} from "../history-manager"
import {
  writeBlankAgentEvidenceBundle,
  readLatestBlankAgentEvidenceBundlePath,
  readBlankAgentEvidenceReadablePaths,
} from "./blank-agent-evidence"
import {
  collectExpertOracleReadPaths,
  writeExpertOracleBundle,
  type OracleValidatorResult,
} from "./expert-oracle-evidence"
import { buildAccessProfile } from "../access-profile"
import {
  MULTI_SKILL_MERGE_WORKER_ROLES,
  buildMultiSkillMergeLeadPrompt,
  buildMultiSkillMergeReviewerPrompt,
  buildMultiSkillMergeRoleAccess,
  buildMultiSkillMergeWorkerPrompt,
  isMultiSkillMergeProfile,
} from "../task-profiles/multi-skill-merge"
import type {
  LongTaskBudgets,
  LongTaskOperationalContextItem,
  LongTaskProgressState,
  LongTaskRunStatus,
  LongTaskSpec,
  LongTaskValidatorContract,
  LongTaskValidatorResult,
  LongTaskWorkUnit,
} from "../long-task/contract"
import {
  DEFAULT_LONG_TASK_CAMPAIGN_CARRYOVER,
  type LongTaskCampaignConfidence,
  type LongTaskCampaignDispatchTicket,
  type LongTaskCampaignDispatchTicketDocument,
  type LongTaskCampaignExplorationTreeDocument,
  type LongTaskCampaignExplorationNode,
  type LongTaskCampaignOperationalMemoryRecord,
  type LongTaskCampaignRecoveryDecision,
  type LongTaskCampaignReviewSuggestion,
  type LongTaskCampaignRoundRecord,
  type LongTaskCampaignRoutingControl,
  type LongTaskCampaignRunTraceDigest,
  type LongTaskCampaignSeedTarget,
  type LongTaskCampaignSpec,
  type LongTaskCampaignState,
  type LongTaskCampaignRunTrace,
  type LongTaskCampaignRunTraceAttemptRecord,
  type LongTaskCampaignRunTraceCommandRecord,
  type LongTaskCampaignWorkingMemoryDocument,
  type LongTaskCampaignWorkingMemoryKind,
  type LongTaskCampaignWorkerRole,
  type LongTaskCampaignWorkerSuggestion,
} from "./contract"
import {
  appendLinesToAggregate,
  appendLongTaskCampaignHistory,
  createLongTaskCampaignID,
  initializeLongTaskCampaign,
  longTaskCampaignPaths,
  longTaskCampaignRoundPaths,
  readLongTaskCampaignExplorationTree,
  readLongTaskCampaignOperationalMemory,
  readLongTaskCampaignState,
  readLongTaskCampaignRoutingControl,
  readLongTaskCampaignWorkingMemory,
  rewriteLongTaskCampaignHistoryRecord,
  writeLongTaskCampaignLessons,
  writeLongTaskCampaignExplorationTree,
  writeLongTaskCampaignOperationalMemory,
  writeLongTaskCampaignRoutingControl,
  writeLongTaskCampaignReviewerSuggestion,
  writeLongTaskCampaignSeedContext,
  writeLongTaskCampaignState,
  writeLongTaskCampaignWorkingMemory,
  writeLongTaskCampaignWorkerSuggestion,
} from "./repository"
import { loadLongTaskCampaignSpec } from "./spec"
import { buildCampaignLeadPrompt, buildCampaignReviewerPrompt, buildCampaignWorkerPrompt, blankExecutorProtocolLines } from "./prompts"
import { loadConfig } from "../schema"
import { resolveModelSelection } from "../model-selection"
import { runOpencodeTask } from "../opencode"
import type { OpencodeTaskInput } from "../opencode"
import { writeTaskArtifacts } from "../task-artifacts"
import { runProtocolTrainingTask } from "../protocol-plugins/training-invocation"
import type { ExecutionSpec, ModelPhase } from "../schema"
import { campaignRoundRuntimeScope, cleanupRuntimeProcessScope, terminateProcessTree } from "../runtime-process-registry"
import { defaultRunHealthPolicy, readCampaignHealth } from "../run-health"

function nowISO() {
  return new Date().toISOString()
}

function short(text: string, limit = 220) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit - 3)}...`
}

const BLANK_AGENT_EXECUTION_HINTS = [
  "blank-agent",
  "blank agent",
  "deployment",
  "single-session",
  "single session",
  "harness",
  "acceptance",
  "run-blank-agent",
]

const SYSTEM_RUNTIME_HINTS = [
  "timeout",
  "timed out",
  "spawn",
  "eperm",
  "access is denied",
  "permission denied",
  "exit code",
  "no structured signal",
  "no-structured-signal",
  "infrastructure",
  "heartbeat",
  "stale",
  "bootstrapping",
  "startup",
  "formaterror",
  "model init",
  "provider",
  "process",
  "crash",
  "encoding",
  "unicode",
  "codepage",
]

function mentionsAny(input: string, hints: string[]) {
  const normalized = input.toLowerCase()
  return hints.some((hint) => normalized.includes(hint))
}

function isBlankAgentExecutionContext(input: string) {
  return mentionsAny(input, BLANK_AGENT_EXECUTION_HINTS)
}

function isSystemRuntimeSignal(input: string) {
  return mentionsAny(input, SYSTEM_RUNTIME_HINTS)
}

function extractBlankAgentDriftSignalsFromDigest(digest: LongTaskCampaignRunTraceDigest) {
  return uniqueStrings([
    ...digest.blockers.filter((item) => isBlankAgentExecutionContext(item) && !isSystemRuntimeSignal(item)),
    ...digest.keyFailurePaths.filter((item) => isBlankAgentExecutionContext(item) && !isSystemRuntimeSignal(item)),
    ...digest.pendingPackageImpact.filter((item) => isBlankAgentExecutionContext(item) && !isSystemRuntimeSignal(item)),
    ...digest.commandOutcomes
      .filter((item) => isBlankAgentExecutionContext(item.unitID))
      .flatMap((item) => item.failedCommands.filter((command) => !isSystemRuntimeSignal(command))),
  ]).slice(0, 8)
}

function onceActivationCallback(callback?: OpencodeTaskInput["onSpawn"]) {
  if (!callback) return undefined
  let activated = false
  return async () => {
    if (activated) return
    activated = true
    await callback()
  }
}

async function cleanupRuntimeScopeWithRetry(scope: string | undefined) {
  const first = await cleanupRuntimeProcessScope(scope)
  if (first.remainingCount <= 0) return
  await sleep(250)
  await cleanupRuntimeProcessScope(scope)
}

async function retryWriteJson(file: string, value: unknown) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await writeJsonFile(file, value)
      return true
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const locked =
        msg.includes("EBUSY") || msg.includes("EPERM") || msg.toLowerCase().includes("locked") || msg.includes("sharing violation")
      if (!locked || attempt >= 3) return false
      await sleep(150 * attempt)
    }
  }
  return false
}

const STALE_BOOTSTRAP_GRACE_MS = (() => {
  const value = Number.parseInt(process.env.AUTO_EVOLVE_STALE_BOOTSTRAP_GRACE_MS ?? "", 10)
  if (Number.isFinite(value) && value > 0) return value
  // Bootstrapping on Windows can be slow under heavy IO/model load.
  // Default to 60 minutes to reduce false stale classification under long startup windows.
  return 60 * 60 * 1000
})()

const STALE_OWNER_TIMEOUT_MS = (() => {
  const value = Number.parseInt(process.env.AUTO_EVOLVE_STALE_OWNER_TIMEOUT_MS ?? "", 10)
  if (Number.isFinite(value) && value > 0) return value
  return defaultRunHealthPolicy().staleOwnerMs
})()

type OwnerUseCase = "block_recovery" | "kill"

function campaignOwnerHints(input: {
  campaignID?: string
  campaignRoot?: string
  baseSpecPath?: string
  runID?: string
  commandHint?: string
}) {
  return {
    requiredAny: strongProcessOwnerHints([
      input.campaignID,
      input.campaignRoot ? path.basename(input.campaignRoot) : undefined,
      input.baseSpecPath,
      input.baseSpecPath ? path.basename(input.baseSpecPath) : undefined,
      input.runID,
      input.commandHint,
    ]),
    optional: optionalProcessOwnerHints([input.commandHint]),
  }
}

async function identifyCampaignOwnerProcess(input: {
  pid: number
  useCase: OwnerUseCase
  commandHint?: string
  expectedCreationTick?: string
  heartbeatAt?: string
  updatedAt?: string
  campaignID?: string
  campaignRoot?: string
  baseSpecPath?: string
  runID?: string
}) {
  const hints = campaignOwnerHints(input)
  const identity = await identifyProcessOwner({
    pid: input.pid,
    requiredAnyCommandHints: hints.requiredAny,
    optionalCommandHints: hints.optional,
    expectedCreationTick: input.expectedCreationTick,
    heartbeatAt: input.heartbeatAt,
    updatedAt: input.updatedAt,
    staleAfterMs: STALE_OWNER_TIMEOUT_MS,
  })
  if (input.useCase === "kill") return identity.ownership === "owned"
  if (identity.ownership === "owned") return true
  // A fresh unknown owner can be observed briefly, but it must not block stale recovery indefinitely.
  return identity.ownership === "unknown_owner" && !isOwnerHeartbeatStale(input)
}

function isLiveCampaignStatus(status: LongTaskCampaignState["status"]) {
  return status === "bootstrapping" || status === "running"
}

function isLiveRunStatus(status: LongTaskProgressState["status"]) {
  return status === "planning" || status === "bootstrapping" || status === "running" || status === "waiting_for_retry"
}

function hasLegacyCampaignRecoveryAction(state: LongTaskCampaignState) {
  return (state as { recovery?: { action?: unknown } }).recovery?.action === "resume_round_postrun"
}

function parseTimestampMs(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function isOwnerHeartbeatStale(input: { heartbeatAt?: unknown; updatedAt?: unknown; nowMs: number }) {
  const referenceMs = parseTimestampMs(input.heartbeatAt) ?? parseTimestampMs(input.updatedAt)
  if (typeof referenceMs !== "number") return false
  return input.nowMs - referenceMs > STALE_OWNER_TIMEOUT_MS
}

function isBootstrappingWithoutOwnerStale(input: {
  status: string
  ownerPID: unknown
  heartbeatAt?: unknown
  updatedAt?: unknown
  createdAt?: unknown
  nowMs: number
}) {
  if (input.status !== "bootstrapping") return false
  if (typeof input.ownerPID === "number" && Number.isFinite(input.ownerPID) && input.ownerPID > 0) return false
  const referenceMs =
    parseTimestampMs(input.heartbeatAt) ?? parseTimestampMs(input.updatedAt) ?? parseTimestampMs(input.createdAt)
  if (typeof referenceMs !== "number") return true
  return input.nowMs - referenceMs > STALE_BOOTSTRAP_GRACE_MS
}

async function healStaleRuntimeStates(cwd: string) {
  const now = nowISO()
  const nowMs = Date.now()
  const campaignsRoot = autoEvolvePath(cwd, "runtime-state", "long-task-campaigns")
  if (await pathExists(campaignsRoot)) {
    const campaignEntries = await readdir(campaignsRoot, { withFileTypes: true })
    for (const entry of campaignEntries) {
      if (!entry.isDirectory()) continue
      const campaignPaths = longTaskCampaignPaths(cwd, entry.name)
      const campaignStatePath = campaignPaths.campaignStatePath
      if (!(await pathExists(campaignStatePath))) continue
      let state: LongTaskCampaignState
      try {
        state = await readJsonFile<LongTaskCampaignState>(campaignStatePath)
      } catch {
        continue
      }
      if (state.status === "recovery_pending" && hasLegacyCampaignRecoveryAction(state)) {
        const history = await readJsonLinesIfExists<LongTaskCampaignRoundRecord>(campaignPaths.historyPath)
        const recovery =
          (await determineCampaignRecoveryDecision({
            cwd,
            campaignPaths,
            state,
            history,
          })) ??
          ({
            action: "restart_round",
            roundNumber: Math.max(1, state.currentRound || 1),
            reason:
              "Campaign had a legacy resume_round_postrun recovery marker, but no safe source run could be recovered; restart the current round from the latest safe checkpoint.",
            detectedAt: now,
          } satisfies LongTaskCampaignRecoveryDecision)
        await retryWriteJson(campaignStatePath, {
          ...state,
          ownerPID: undefined,
          ownerCommandHint: undefined,
          ownerCreationTick: undefined,
          heartbeatAt: undefined,
          updatedAt: now,
          lastSummary: `Normalized legacy recovery marker: ${recovery.reason}`,
          recovery,
        } satisfies LongTaskCampaignState)
        continue
      }
      if (!isLiveCampaignStatus(state.status)) continue
      let kill = false
      if (typeof state.ownerPID !== "number") {
        if (
          !isBootstrappingWithoutOwnerStale({
            status: state.status,
            ownerPID: state.ownerPID,
            heartbeatAt: state.heartbeatAt,
            updatedAt: state.updatedAt,
            createdAt: state.createdAt,
            nowMs,
          })
        ) {
          continue
        }
      } else {
        if (state.ownerPID === process.pid) continue
        const stale = isOwnerHeartbeatStale({
          heartbeatAt: state.heartbeatAt,
          updatedAt: state.updatedAt,
          nowMs,
        })
        const blockRecovery = await identifyCampaignOwnerProcess({
          pid: state.ownerPID,
          useCase: "block_recovery",
          commandHint: state.ownerCommandHint,
          expectedCreationTick: state.ownerCreationTick,
          heartbeatAt: state.heartbeatAt,
          updatedAt: state.updatedAt,
          campaignID: entry.name,
          campaignRoot: campaignPaths.root,
          baseSpecPath: state.baseSpecPath,
        })
        if (!stale && blockRecovery) continue
        kill = await identifyCampaignOwnerProcess({
          pid: state.ownerPID,
          useCase: "kill",
          commandHint: state.ownerCommandHint,
          expectedCreationTick: state.ownerCreationTick,
          heartbeatAt: state.heartbeatAt,
          updatedAt: state.updatedAt,
          campaignID: entry.name,
          campaignRoot: campaignPaths.root,
          baseSpecPath: state.baseSpecPath,
        })
      }
      if (kill && typeof state.ownerPID === "number" && Number.isFinite(state.ownerPID) && state.ownerPID > 0) {
        await terminateProcessTree(state.ownerPID)
      }
      const stale = isOwnerHeartbeatStale({
        heartbeatAt: state.heartbeatAt,
        updatedAt: state.updatedAt,
        nowMs,
      })
      const history = await readJsonLinesIfExists<LongTaskCampaignRoundRecord>(campaignPaths.historyPath)
      const recovery =
        (await determineCampaignRecoveryDecision({
          cwd,
          campaignPaths,
          state,
          history,
        })) ??
        ({
          action: "restart_round",
          roundNumber: Math.max(1, state.currentRound || 1),
          reason:
            stale && kill && typeof state.ownerPID === "number"
              ? `Campaign owner process ${state.ownerPID} stopped heartbeating past the hard stale timeout; killed its process tree and marked the campaign for recovery.`
              : stale && typeof state.ownerPID === "number"
              ? `Campaign owner process ${state.ownerPID} stopped heartbeating past the hard stale timeout; marked the campaign for recovery without killing because the PID no longer matched the recorded owner hint.`
              : typeof state.ownerPID === "number"
              ? `Campaign owner process ${state.ownerPID} disappeared; restart the current round from its latest safe checkpoint.`
              : "Campaign stalled before a stable owner was recorded; restart the current round from its latest safe checkpoint.",
          detectedAt: now,
        } satisfies LongTaskCampaignRecoveryDecision)

      const wroteCampaign = await retryWriteJson(campaignStatePath, {
        ...state,
        status: "recovery_pending",
        // Marking a stale campaign as recoverable is not ownership. The next
        // real runner will claim owner fields when it actually resumes work.
        ownerPID: undefined,
        ownerCommandHint: undefined,
        ownerCreationTick: undefined,
        heartbeatAt: now,
        updatedAt: now,
        lastSummary: recovery.reason,
        recovery,
      } satisfies LongTaskCampaignState)
      if (!wroteCampaign) {
        continue
      }
    }
  }

  const runsRoot = autoEvolvePath(cwd, "runtime-state", "long-task", "runs")
  if (await pathExists(runsRoot)) {
    const runEntries = await readdir(runsRoot, { withFileTypes: true })
    for (const entry of runEntries) {
      if (!entry.isDirectory()) continue
      const progressPath = path.join(runsRoot, entry.name, "progress_state.json")
      if (!(await pathExists(progressPath))) continue
      let progress: LongTaskProgressState
      try {
        progress = await readJsonFile<LongTaskProgressState>(progressPath)
      } catch {
        continue
      }
      if (!isLiveRunStatus(progress.status)) continue
      let kill = false
      if (typeof progress.ownerPID !== "number") {
        if (
          !isBootstrappingWithoutOwnerStale({
            status: progress.status,
            ownerPID: progress.ownerPID,
            heartbeatAt: progress.heartbeatAt,
            updatedAt: progress.updatedAt,
            createdAt: progress.createdAt,
            nowMs,
          })
        ) {
          continue
        }
      } else {
        if (progress.ownerPID === process.pid) continue
        const stale = isOwnerHeartbeatStale({
          heartbeatAt: progress.heartbeatAt,
          updatedAt: progress.updatedAt,
          nowMs,
        })
        const blockRecovery = await identifyCampaignOwnerProcess({
          pid: progress.ownerPID,
          useCase: "block_recovery",
          commandHint: progress.ownerCommandHint,
          expectedCreationTick: progress.ownerCreationTick,
          heartbeatAt: progress.heartbeatAt,
          updatedAt: progress.updatedAt,
          runID: entry.name,
        })
        if (!stale && blockRecovery) continue
        kill = await identifyCampaignOwnerProcess({
          pid: progress.ownerPID,
          useCase: "kill",
          commandHint: progress.ownerCommandHint,
          expectedCreationTick: progress.ownerCreationTick,
          heartbeatAt: progress.heartbeatAt,
          updatedAt: progress.updatedAt,
          runID: entry.name,
        })
      }
      if (kill && typeof progress.ownerPID === "number" && Number.isFinite(progress.ownerPID) && progress.ownerPID > 0) {
        await terminateProcessTree(progress.ownerPID)
      }
      const stale = isOwnerHeartbeatStale({
        heartbeatAt: progress.heartbeatAt,
        updatedAt: progress.updatedAt,
        nowMs,
      })
      const hadMeaningfulProgress =
        Boolean(progress.activeUnitID) ||
        Boolean(progress.lastProgressAt) ||
        (progress.totalUnitAttempts ?? 0) > 0 ||
        (progress.graphRevision ?? 0) > 0
      const recoveredStatus: LongTaskProgressState["status"] =
        progress.status === "planning" ? "planning" : hadMeaningfulProgress ? "waiting_for_retry" : "bootstrapping"
      const wroteRun = await retryWriteJson(progressPath, {
        ...progress,
        status: recoveredStatus,
        // A healer only changes the run back into a resumable state; it must
        // not become the recorded owner of work it is not executing.
        ownerPID: undefined,
        ownerCommandHint: undefined,
        ownerCreationTick: undefined,
        heartbeatAt: now,
        updatedAt: now,
        finalSummary:
          progress.finalSummary ??
          (stale && kill && typeof progress.ownerPID === "number"
            ? `Run owner process ${progress.ownerPID} stopped heartbeating past the hard stale timeout; killed its process tree and changed stale run into ${recoveredStatus} so it can be resumed from the latest safe checkpoint.`
            : stale && typeof progress.ownerPID === "number"
            ? `Run owner process ${progress.ownerPID} stopped heartbeating past the hard stale timeout; changed stale run into ${recoveredStatus} without killing because the PID no longer matched the recorded owner hint.`
            : typeof progress.ownerPID === "number"
            ? `Run owner process ${progress.ownerPID} disappeared; changed stale run into ${recoveredStatus} so it can be resumed from the latest safe checkpoint.`
            : `Run stalled before a stable owner was recorded; changed stale run into ${recoveredStatus} so it can be resumed from the latest safe checkpoint.`),
      } satisfies LongTaskProgressState)
      if (!wroteRun) {
        continue
      }
    }
  }
}

async function findExistingLiveCampaign(input: {
  cwd: string
  title: string
  baseSpecPath: string
  historyContext?: BenchmarkHistoryContext
  taskID?: string
  specHash?: string
}) {
  const campaignsRoot = autoEvolvePath(input.cwd, "runtime-state", "long-task-campaigns")
  if (!(await pathExists(campaignsRoot))) return undefined
  const normalizedBaseSpecPath = path.resolve(input.baseSpecPath)
  const entries = await readdir(campaignsRoot, { withFileTypes: true })
  const candidates: Array<{
    campaignID: string
    campaignPaths: ReturnType<typeof longTaskCampaignPaths>
    state: LongTaskCampaignState
    freshnessMs: number
  }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const campaignID = entry.name
    const campaignPaths = longTaskCampaignPaths(input.cwd, campaignID)
    if (!(await pathExists(campaignPaths.campaignStatePath))) continue
    let state: LongTaskCampaignState
    try {
      state = await readLongTaskCampaignState(campaignPaths)
    } catch {
      continue
    }
    if (!isLiveCampaignStatus(state.status)) continue
    const stateBaseSpecPath = typeof state.baseSpecPath === "string" ? path.resolve(state.baseSpecPath) : ""
    const sameTarget = stateBaseSpecPath === normalizedBaseSpecPath
    if (!sameTarget) continue
    if (input.historyContext && !isCampaignAuthorizedForContext(state, input.historyContext, input.taskID, input.specHash)) {
      continue
    }
    if (!input.historyContext && process.env.AUTO_EVOLVE_ALLOW_LEGACY_CAMPAIGN_RESUME !== "1") continue
    const health = await readCampaignHealth(campaignPaths.root)
    if (
      health &&
      (health.health === "stale_running" || health.health === "stuck_running" || health.health === "recovery_pending")
    ) {
      continue
    }
    if (typeof state.ownerPID === "number" && Number.isFinite(state.ownerPID) && state.ownerPID > 0) {
      if (state.ownerPID === process.pid) continue
      if (
        !(await identifyCampaignOwnerProcess({
          pid: state.ownerPID,
          useCase: "block_recovery",
          commandHint: state.ownerCommandHint,
          expectedCreationTick: state.ownerCreationTick,
          heartbeatAt: state.heartbeatAt,
          updatedAt: state.updatedAt,
          campaignID,
          campaignRoot: campaignPaths.root,
          baseSpecPath: state.baseSpecPath,
        }))
      ) {
        continue
      }
    }
    candidates.push({
      campaignID,
      campaignPaths,
      state,
      freshnessMs:
        parseTimestampMs(state.heartbeatAt) ??
        parseTimestampMs(state.updatedAt) ??
        parseTimestampMs(state.createdAt) ??
        0,
    })
  }
  if (!candidates.length) return undefined
  candidates.sort((left, right) => right.freshnessMs - left.freshnessMs)
  return candidates[0]
}

function isRecoverableCampaignStatus(status: LongTaskCampaignState["status"]) {
  return status === "recovery_pending"
}

function isTerminalLongTaskStatus(status: LongTaskRunStatus) {
  return (
    status === "graph_completed" ||
    status === "verified_success" ||
    status === "exhausted_failure" ||
    status === "stagnation_failure" ||
    status === "blocked_failure" ||
    status === "archived"
  )
}

function expectedCampaignRoundTitle(campaignTitle: string, roundNumber: number) {
  return `${campaignTitle}-${roundID(roundNumber)}`
}

async function findLatestLongTaskRunForCampaignRound(input: {
  cwd: string
  expectedTitle: string
  pendingPackageRoot: string
}) {
  const runsRoot = autoEvolvePath(input.cwd, "runtime-state", "long-task", "runs")
  if (!(await pathExists(runsRoot))) return undefined
  const expectedPendingRoot = resolvePathTruth(input.pendingPackageRoot)
  const entries = await readdir(runsRoot, { withFileTypes: true })
  const candidates: Array<{
    runID: string
    progress: LongTaskProgressState
    freshnessMs: number
  }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const taskPath = path.join(runsRoot, entry.name, "task.json")
    const progressPath = path.join(runsRoot, entry.name, "progress_state.json")
    if (!(await pathExists(taskPath)) || !(await pathExists(progressPath))) continue
    let spec: LongTaskSpec
    let progress: LongTaskProgressState
    try {
      spec = await readJsonFile<LongTaskSpec>(taskPath)
      progress = await readJsonFile<LongTaskProgressState>(progressPath)
    } catch {
      continue
    }
    if (spec.title !== input.expectedTitle) continue
    const specPendingRoot =
      typeof spec.campaignPendingPackageRoot === "string" && spec.campaignPendingPackageRoot.trim().length > 0
        ? resolvePathTruth(spec.campaignPendingPackageRoot)
        : undefined
    if (specPendingRoot !== expectedPendingRoot) continue
    const freshnessMs =
      parseTimestampMs(progress.heartbeatAt) ??
      parseTimestampMs(progress.updatedAt) ??
      parseTimestampMs(progress.createdAt) ??
      0
    candidates.push({
      runID: entry.name,
      progress,
      freshnessMs,
    })
  }
  if (!candidates.length) return undefined
  candidates.sort((left, right) => right.freshnessMs - left.freshnessMs)
  return candidates[0]
}

async function readLongTaskRunProgressByID(input: { cwd: string; runID: string }) {
  const progressPath = autoEvolvePath(input.cwd, "runtime-state", "long-task", "runs", input.runID, "progress_state.json")
  if (!(await pathExists(progressPath))) return undefined
  try {
    return await readJsonFile<LongTaskProgressState>(progressPath)
  } catch {
    return undefined
  }
}

export async function determineCampaignRecoveryDecision(input: {
  cwd: string
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  state: LongTaskCampaignState
  history: LongTaskCampaignRoundRecord[]
}) {
  if (
    input.state.lastGateFailureKind === "infrastructure_failure" &&
    input.state.recovery?.action === "harvest_round_run" &&
    input.state.recovery.runID
  ) {
    return input.state.recovery
  }
  const activeRound = Math.max(1, input.state.currentRound || 1)
  const latestRoundRecord = [...input.history]
    .filter((record) => record.roundNumber === activeRound)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]

  if (latestRoundRecord && !latestRoundRecord.finalAcceptanceSignal) {
    const progress = await readLongTaskRunProgressByID({
      cwd: input.cwd,
      runID: latestRoundRecord.sourceRunID,
    })
    if (!progress) {
      return {
        action: "restart_round",
        roundNumber: activeRound,
        reason: `Round ${roundID(activeRound)} has an incomplete post-run record, but its source run ${latestRoundRecord.sourceRunID} is no longer readable; restart the round from the latest safe checkpoint.`,
        detectedAt: nowISO(),
      } satisfies LongTaskCampaignRecoveryDecision
    }
    const terminal = isTerminalLongTaskStatus(progress.status)
    return {
      action: terminal ? "harvest_round_run" : "resume_round_run",
      roundNumber: activeRound,
      runID: latestRoundRecord.sourceRunID,
      reason: terminal
        ? `Round ${roundID(activeRound)} produced run artifacts but missed final acceptance bookkeeping; resume from the harvested round boundary.`
        : `Round ${roundID(activeRound)} produced a partial round record while the inner run was still ${progress.status}; resume that inner long-task run directly.`,
      detectedAt: nowISO(),
    } satisfies LongTaskCampaignRecoveryDecision
  }

  const completedRound = input.history.reduce((max, item) => Math.max(max, item.roundNumber), 0)
  if (activeRound > completedRound) {
    const latestRun = await findLatestLongTaskRunForCampaignRound({
      cwd: input.cwd,
      expectedTitle: expectedCampaignRoundTitle(input.state.title, activeRound),
      pendingPackageRoot: input.campaignPaths.pendingCurrentRoot,
    })
    if (!latestRun) {
      return {
        action: "restart_round",
        roundNumber: activeRound,
        reason: `Round ${roundID(activeRound)} had no resumable inner run, so the safest recovery point is to restart that round.`,
        detectedAt: nowISO(),
      } satisfies LongTaskCampaignRecoveryDecision
    }
    return {
      action: isTerminalLongTaskStatus(latestRun.progress.status) ? "harvest_round_run" : "resume_round_run",
      roundNumber: activeRound,
      runID: latestRun.runID,
      reason: isTerminalLongTaskStatus(latestRun.progress.status)
        ? `Round ${roundID(activeRound)} already finished the inner long-task run; resume from the harvested round boundary.`
        : `Round ${roundID(activeRound)} was mid-run when the owner died; resume that inner long-task run directly.`,
      detectedAt: nowISO(),
    } satisfies LongTaskCampaignRecoveryDecision
  }

  return undefined
}

async function findRecoverableCampaignForTarget(input: {
  cwd: string
  title: string
  baseSpecPath: string
  historyContext?: BenchmarkHistoryContext
  taskID?: string
  specHash?: string
}) {
  const campaignsRoot = autoEvolvePath(input.cwd, "runtime-state", "long-task-campaigns")
  if (!(await pathExists(campaignsRoot))) return undefined
  const normalizedBaseSpecPath = path.resolve(input.baseSpecPath)
  const entries = await readdir(campaignsRoot, { withFileTypes: true })
  const candidates: Array<{
    campaignID: string
    campaignPaths: ReturnType<typeof longTaskCampaignPaths>
    state: LongTaskCampaignState
    freshnessMs: number
  }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const campaignID = entry.name
    const campaignPaths = longTaskCampaignPaths(input.cwd, campaignID)
    if (!(await pathExists(campaignPaths.campaignStatePath))) continue
    let state: LongTaskCampaignState
    try {
      state = await readLongTaskCampaignState(campaignPaths)
    } catch {
      continue
    }
    if (!isRecoverableCampaignStatus(state.status)) continue
    const stateBaseSpecPath = typeof state.baseSpecPath === "string" ? path.resolve(state.baseSpecPath) : ""
    const sameTarget = stateBaseSpecPath === normalizedBaseSpecPath
    if (!sameTarget) continue
    if (input.historyContext && !isCampaignAuthorizedForContext(state, input.historyContext, input.taskID, input.specHash)) {
      continue
    }
    if (!input.historyContext && process.env.AUTO_EVOLVE_ALLOW_LEGACY_CAMPAIGN_RESUME !== "1") continue
    const freshnessMs =
      parseTimestampMs(state.heartbeatAt) ??
      parseTimestampMs(state.updatedAt) ??
      parseTimestampMs(state.createdAt) ??
      0
    candidates.push({
      campaignID,
      campaignPaths,
      state,
      freshnessMs,
    })
  }
  if (!candidates.length) return undefined
  candidates.sort((left, right) => right.freshnessMs - left.freshnessMs)
  return candidates[0]
}

async function rehydrateExistingLongTaskRunResult(input: { cwd: string; runID: string }) {
  const resolved = resolveExistingLongTaskRun(input.cwd, input.runID)
  let progress: LongTaskProgressState
  let summary: Awaited<ReturnType<typeof runLongTask>>["summary"]
  try {
    ;[progress, summary] = await Promise.all([
      readJsonFile<LongTaskProgressState>(resolved.run.progressStatePath),
      readJsonFile<Awaited<ReturnType<typeof runLongTask>>["summary"]>(resolved.run.summaryJsonPath),
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Failed to rehydrate long-task run ${input.runID}: ${message}. The run state files may be corrupted from a previous crash.`,
    )
  }
  return {
    runID: input.runID,
    runDir: resolved.run.root,
    status: progress.status,
    summaryPath: resolved.run.summaryJsonPath,
    summary,
  } satisfies Awaited<ReturnType<typeof runLongTask>>
}

type LongTaskCampaignRunResult = {
  campaignID: string
  campaignDir: string
  status: LongTaskCampaignState["status"]
  roundsCompleted: number
  lastRunID?: string
  lessonsPath: string
  roundSummaryPath?: string
  attachedLive?: boolean
  terminal?: boolean
}

function toCampaignRunResult(input: {
  campaignID: string
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  state: LongTaskCampaignState
  roundsCompleted?: number
  attachedLive?: boolean
}): LongTaskCampaignRunResult {
  const terminal =
    input.state.status === "verified_success" ||
    input.state.status === "round_limit_reached" ||
    input.state.status === "failed"
  return {
    campaignID: input.campaignID,
    campaignDir: input.campaignPaths.root,
    status: input.state.status,
    roundsCompleted: input.roundsCompleted ?? input.state.currentRound,
    lastRunID: input.state.lastRunID,
    lessonsPath: input.campaignPaths.campaignLessonsPath,
    roundSummaryPath: input.state.lastRoundSummaryPath,
    attachedLive: input.attachedLive,
    terminal,
  }
}

async function updateCampaignStatus(
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>,
  status: LongTaskCampaignState["status"],
  patch: Partial<LongTaskCampaignState> = {},
) {
  const current = await readLongTaskCampaignState(campaignPaths)
  if (current.status === status && Object.keys(patch).length === 0) return
  if (
    current.status === "verified_success" ||
    current.status === "round_limit_reached" ||
    current.status === "failed"
  ) {
    return
  }
  await writeLongTaskCampaignState(campaignPaths, {
    ...current,
    ...patch,
    status,
    heartbeatAt: nowISO(),
    updatedAt: nowISO(),
  })
}

async function pulseCampaignState(campaignPaths: ReturnType<typeof longTaskCampaignPaths>) {
  const state = await readLongTaskCampaignState(campaignPaths)
  if (!isLiveCampaignStatus(state.status)) return
  await writeLongTaskCampaignState(campaignPaths, { ...state, heartbeatAt: nowISO() })
}

function uniqueStrings(items: string[]) {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)))
}

function presentPaths(items: Array<string | undefined>) {
  return items.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

export type CampaignRoleAccessView = {
  referencePaths: string[]
  permissionReadPaths: string[]
  permissionEditPaths: string[]
}

export type CampaignRoleAccessInput = {
  role: string
  basePaths: string[]
  optionalPaths?: Array<string | undefined>
  carryoverFiles?: string[]
  blankAgentEvidenceBundlePath?: string
  blankAgentEvidenceReadPaths?: string[]
  expertOracleBundlePath?: string
  expertOracleReadPaths?: string[]
  editPaths?: string[]
}

export async function buildCampaignRoleAccessView(input: CampaignRoleAccessInput): Promise<CampaignRoleAccessView> {
  const profile = await buildAccessProfile({
    role: input.role,
    mode: "open_book",
    basePaths: input.basePaths,
    readPaths: input.optionalPaths,
    blankAgentEvidenceBundlePath: input.blankAgentEvidenceBundlePath,
    blankAgentEvidenceReadPaths: input.blankAgentEvidenceReadPaths,
    expertOracleBundlePath: input.expertOracleBundlePath,
    expertOracleReadPaths: input.expertOracleReadPaths,
    carryoverFiles: input.carryoverFiles,
    editPaths: input.editPaths,
  })

  return {
    referencePaths: profile.referencePaths,
    permissionReadPaths: profile.permissionReadPaths,
    permissionEditPaths: profile.permissionEditPaths,
  }
}

function normalizeLineContent(raw: string) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function parseJsonLines<T = Record<string, unknown>>(raw: string) {
  const entries: T[] = []
  for (const line of normalizeLineContent(raw)) {
    try {
      entries.push(JSON.parse(line) as T)
    } catch {
      continue
    }
  }
  return entries
}

async function readJsonLinesIfExists<T = Record<string, unknown>>(target: string) {
  if (!(await pathExists(target))) return [] as T[]
  return parseJsonLines<T>(await readTextFile(target))
}

function roundID(roundNumber: number) {
  return `round-${String(roundNumber).padStart(3, "0")}`
}

function campaignOperationalSignature(item: Pick<LongTaskOperationalContextItem, "kind" | "statement">) {
  return `${item.kind}::${item.statement.trim().toLowerCase()}`
}

function mergeCampaignOperationalMemory(
  existing: LongTaskCampaignOperationalMemoryRecord,
  incoming: LongTaskOperationalContextItem,
  roundNumber: number,
  runID: string,
): LongTaskCampaignOperationalMemoryRecord {
  return {
    ...existing,
    updatedAt: nowISO(),
    lastRound: roundNumber,
    occurrenceCount: existing.sourceRunIDs.includes(runID) ? existing.occurrenceCount : existing.occurrenceCount + 1,
    sourceRunIDs: uniqueStrings([...existing.sourceRunIDs, runID]),
    status: existing.status === "confirmed" || incoming.status === "confirmed" ? "confirmed" : "candidate",
    rationale: incoming.rationale ?? existing.rationale,
    refs: uniqueStrings([...existing.refs, ...incoming.refs]),
    tags: uniqueStrings([...existing.tags, ...incoming.tags]),
  }
}

function sortCampaignOperationalMemory(records: LongTaskCampaignOperationalMemoryRecord[]) {
  return [...records].sort((left, right) => {
    if (left.status !== right.status) return left.status === "confirmed" ? -1 : 1
    if (left.occurrenceCount !== right.occurrenceCount) return right.occurrenceCount - left.occurrenceCount
    if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1
    return left.statement.localeCompare(right.statement)
  })
}

function promoteCampaignOperationalMemory(input: {
  existing: LongTaskCampaignOperationalMemoryRecord[]
  incoming: LongTaskOperationalContextItem[]
  roundNumber: number
  runID: string
}): LongTaskCampaignOperationalMemoryRecord[] {
  const merged = new Map<string, LongTaskCampaignOperationalMemoryRecord>()
  for (const item of input.existing) merged.set(campaignOperationalSignature(item), item)
  for (const item of input.incoming) {
    if (hasConcreteAnswerLeakageSurface(item.statement)) continue
    const signature = campaignOperationalSignature(item)
    const current = merged.get(signature)
    if (current) {
      merged.set(signature, mergeCampaignOperationalMemory(current, item, input.roundNumber, input.runID))
      continue
    }
    merged.set(signature, {
      ...item,
      updatedAt: nowISO(),
      roundNumber: input.roundNumber,
      lastRound: input.roundNumber,
      occurrenceCount: 1,
      sourceRunIDs: [input.runID],
    })
  }
  return sortCampaignOperationalMemory(Array.from(merged.values()))
}

function buildCampaignSeedContextMarkdown(input: {
  title: string
  latestRound: number
  operationalMemory: LongTaskCampaignOperationalMemoryRecord[]
  records: LongTaskCampaignRoundRecord[]
}) {
  const latestRecord = input.records[input.records.length - 1]
  const sections: Array<[string, LongTaskCampaignOperationalMemoryRecord["kind"]]> = [
    ["Confirmed Facts", "confirmed_fact"],
    ["Validated Methods", "validated_method"],
    ["Known Blockers", "blocking_issue"],
    ["Failed Paths", "failed_path"],
    ["Tool Entrypoints", "tool_entrypoint"],
    ["Package Gaps", "package_gap"],
  ]
  const lines = [
    "# Campaign Seed Context",
    "",
    "- Purpose: provide promoted cross-run memory to the next generated round.",
    `- title: ${input.title}`,
    `- updated_through: ${roundID(input.latestRound)}`,
    `- latest_status: ${latestRecord?.finalStatus ?? "unknown"}`,
    `- latest_summary: ${latestRecord?.summary ?? "none"}`,
    "",
  ]

  if (!input.operationalMemory.length) {
    lines.push("- no promoted cross-run memory yet", "")
    return lines.join("\n")
  }

  for (const [title, kind] of sections) {
    const matches = input.operationalMemory.filter((item) => item.kind === kind).slice(0, 8)
    if (!matches.length) continue
    lines.push(`## ${title}`, "")
    for (const item of matches) {
      lines.push(`- ${item.statement}`)
      lines.push(`  stability: occurrences=${item.occurrenceCount}, status=${item.status}`)
      if (item.rationale) lines.push(`  rationale: ${short(item.rationale, 180)}`)
    }
    lines.push("")
  }

  return lines.join("\n").trimEnd() + "\n"
}

function compactRefs(refs: string[]) {
  const unique = uniqueStrings(refs)
  if (unique.length <= 2) return unique
  return [unique[0], unique[unique.length - 1]]
}

function normalizeDispatchTicketKey(raw: string) {
  return raw.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 180)
}

function emptyDispatchTicketDocument(updatedThroughRound = 0): LongTaskCampaignDispatchTicketDocument {
  return {
    updatedAt: nowISO(),
    updatedThroughRound,
    tickets: [],
  }
}

function coerceDispatchTicketDocument(
  raw: unknown,
  fallback: LongTaskCampaignDispatchTicketDocument,
): LongTaskCampaignDispatchTicketDocument {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fallback
  const value = raw as Record<string, unknown>
  const tickets = Array.isArray(value.tickets)
    ? value.tickets
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
        .map((item, index) => {
          const key = typeof item.key === "string" && item.key.trim().length > 0 ? item.key.trim() : `ticket-${index + 1}`
          const id =
            typeof item.id === "string" && item.id.trim().length > 0
              ? item.id.trim()
              : `dispatch-${randomUUID().slice(0, 8)}`
          return {
            id,
            key,
            status: item.status === "resolved" ? "resolved" : "open",
            createdAt: typeof item.createdAt === "string" ? item.createdAt : nowISO(),
            updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : nowISO(),
            firstSeenRound: typeof item.firstSeenRound === "number" ? item.firstSeenRound : fallback.updatedThroughRound,
            lastSeenRound: typeof item.lastSeenRound === "number" ? item.lastSeenRound : fallback.updatedThroughRound,
            resolvedRound: typeof item.resolvedRound === "number" ? item.resolvedRound : undefined,
            occurrenceCount: typeof item.occurrenceCount === "number" && item.occurrenceCount > 0 ? item.occurrenceCount : 1,
            validatorID: typeof item.validatorID === "string" ? item.validatorID : undefined,
            title: typeof item.title === "string" && item.title.trim().length > 0 ? item.title.trim() : key,
            issue:
              typeof item.issue === "string" && item.issue.trim().length > 0 ? item.issue.trim() : "Unspecified issue.",
            actionableFix:
              typeof item.actionableFix === "string" && item.actionableFix.trim().length > 0
                ? item.actionableFix.trim()
                : "Apply the latest failed validator feedback and re-run acceptance.",
            evidenceRefs: Array.isArray(item.evidenceRefs)
              ? compactRefs(
                  item.evidenceRefs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0),
                )
              : [],
          } satisfies LongTaskCampaignDispatchTicket
        })
    : fallback.tickets
  return {
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
    updatedThroughRound:
      typeof value.updatedThroughRound === "number" ? value.updatedThroughRound : fallback.updatedThroughRound,
    tickets,
  }
}

async function readDispatchTicketDocument(campaignPaths: ReturnType<typeof longTaskCampaignPaths>, roundNumber: number) {
  if (!(await pathExists(campaignPaths.dispatchTicketsPath))) {
    return emptyDispatchTicketDocument(roundNumber)
  }
  const raw = await readJsonFile<unknown>(campaignPaths.dispatchTicketsPath).catch(() => undefined)
  return coerceDispatchTicketDocument(raw, emptyDispatchTicketDocument(roundNumber))
}

function mergeDispatchTicketsFromFinalAcceptance(input: {
  previous: LongTaskCampaignDispatchTicketDocument
  roundNumber: number
  feedbackPath: string
  finalAcceptance: {
    passed: boolean
    summary: string
    acceptanceMode?: string
    protocolChecks?: ProtocolRepairCheck[]
    validatorResults: Array<{
      validatorID: string
      passed: boolean
      summary: string
      details: string[]
      evidenceRefs: string[]
    }>
  }
}): LongTaskCampaignDispatchTicketDocument {
  const now = nowISO()
  const next = new Map<string, LongTaskCampaignDispatchTicket>()
  for (const ticket of input.previous.tickets) next.set(ticket.key, ticket)

  if (input.finalAcceptance.passed) {
    for (const [key, ticket] of next.entries()) {
      if (ticket.status !== "open") continue
      next.set(key, {
        ...ticket,
        status: "resolved",
        resolvedRound: input.roundNumber,
        updatedAt: now,
        lastSeenRound: input.roundNumber,
      })
    }
  } else {
    const failedResults = input.finalAcceptance.validatorResults.filter((item) => !item.passed)
    for (const failed of failedResults) {
      let directive: ReturnType<typeof protocolRepairDirective>
      if (input.finalAcceptance.acceptanceMode === "protocol_plugins") {
        const check = input.finalAcceptance.protocolChecks?.find(item => item.name === failed.validatorID)
        if (!check) {
          if (failed.validatorID === "protocol-execution") continue
          throw new Error("Protocol repair check identity missing")
        }
        directive = protocolRepairDirective(check)
        if (!directive) continue
      }
      const key = normalizeDispatchTicketKey(directive?.key ?? `validator:${failed.validatorID}`)
      const current = next.get(key)
      const actionableFix =
        directive?.actionableFix ?? failed.details.find((item) => item.trim().length > 0) ??
        failed.summary ??
        "Apply the failed validator feedback and re-run acceptance."
      const issue = failed.summary || input.finalAcceptance.summary
      if (current) {
        next.set(key, {
          ...current,
          status: "open",
          updatedAt: now,
          lastSeenRound: input.roundNumber,
          resolvedRound: undefined,
          occurrenceCount: current.occurrenceCount + 1,
          issue: short(issue, 220),
          actionableFix: short(actionableFix, 220),
          evidenceRefs: compactRefs([...current.evidenceRefs, ...failed.evidenceRefs, input.feedbackPath]),
        })
        continue
      }
      next.set(key, {
        id: `dispatch-${randomUUID().slice(0, 8)}`,
        key,
        status: "open",
        createdAt: now,
        updatedAt: now,
        firstSeenRound: input.roundNumber,
        lastSeenRound: input.roundNumber,
        occurrenceCount: 1,
        validatorID: failed.validatorID,
        title: directive?.title ?? `Repair validator ${failed.validatorID}`,
        issue: short(issue, 220),
        actionableFix: short(actionableFix, 220),
        evidenceRefs: compactRefs([...failed.evidenceRefs, input.feedbackPath]),
      })
    }
  }

  const tickets = Array.from(next.values()).sort((left, right) => {
    if (left.status !== right.status) return left.status === "open" ? -1 : 1
    if (left.lastSeenRound !== right.lastSeenRound) return right.lastSeenRound - left.lastSeenRound
    return left.key.localeCompare(right.key)
  })

  return {
    updatedAt: now,
    updatedThroughRound: input.roundNumber,
    tickets,
  }
}

function dispatchRequiredRegions(document: LongTaskCampaignDispatchTicketDocument) {
  return document.tickets
    .filter((item) => item.status === "open")
    .map((item) => `dispatch-repair:${item.key}`)
}

function normalizeCompactStatement(raw: string) {
  return raw
    .replace(/\s+/g, " ")
    .replace(/[.;:]+$/g, "")
    .trim()
}

function mapOperationalKindToWorkingKind(
  kind: LongTaskCampaignOperationalMemoryRecord["kind"],
): LongTaskCampaignWorkingMemoryKind | undefined {
  switch (kind) {
    case "confirmed_fact":
      return "stable_fact"
    case "validated_method":
    case "tool_entrypoint":
      return "validated_method"
    case "blocking_issue":
      return "real_blocker"
    case "failed_path":
      return "forbidden_path"
    case "package_gap":
      return "package_gap"
    default:
      return undefined
  }
}

function confidenceRank(value: LongTaskCampaignConfidence) {
  switch (value) {
    case "high":
      return 3
    case "medium":
      return 2
    default:
      return 1
  }
}

function deriveWorkingConfidence(record: LongTaskCampaignOperationalMemoryRecord): LongTaskCampaignConfidence {
  if (record.status === "confirmed" && record.occurrenceCount >= 2) return "high"
  if (record.status === "confirmed" || record.occurrenceCount >= 2) return "medium"
  return "low"
}

function isMetaProcessOnlyStatement(statement: string) {
  const lower = statement.toLowerCase()
  const patterns = [
    "do not claim success",
    "say so explicitly",
    "read carefully",
    "before returning",
    "must explicitly acknowledge",
    "ground every",
    "do not leak hidden validator",
  ]
  return patterns.some((pattern) => lower.includes(pattern))
}

function shouldPromoteOperationalRecord(
  record: LongTaskCampaignOperationalMemoryRecord,
  kind: LongTaskCampaignWorkingMemoryKind,
  statement: string,
) {
  if (!statement) return false
  if (isMetaProcessOnlyStatement(statement)) return false
  if (kind === "forbidden_path") return record.status === "confirmed" || record.occurrenceCount >= 2
  if (kind === "stable_fact") return record.status === "confirmed" || record.occurrenceCount >= 2
  if (kind === "validated_method") return record.status === "confirmed" || record.occurrenceCount >= 2
  if (kind === "real_blocker") return record.status === "confirmed" || record.occurrenceCount >= 2
  if (kind === "package_gap") return record.status === "confirmed" || record.occurrenceCount >= 2
  return false
}

function buildWorkingMemoryDocument(input: {
  operationalMemory: LongTaskCampaignOperationalMemoryRecord[]
  updatedThroughRound: number
}): LongTaskCampaignWorkingMemoryDocument {
  const merged = new Map<string, LongTaskCampaignWorkingMemoryDocument["items"][number]>()
  for (const record of input.operationalMemory) {
    const mappedKind = mapOperationalKindToWorkingKind(record.kind)
    if (!mappedKind) continue
    const statement = normalizeCompactStatement(record.statement)
    if (!shouldPromoteOperationalRecord(record, mappedKind, statement)) continue
    const key = `${mappedKind}::${statement.toLowerCase()}`
    const current = merged.get(key)
    const nextRefs = compactRefs(record.refs)
    if (current) {
      merged.set(key, {
        ...current,
        confidence:
          confidenceRank(current.confidence) >= confidenceRank(deriveWorkingConfidence(record))
            ? current.confidence
            : deriveWorkingConfidence(record),
        evidenceCount: Math.max(current.evidenceCount, record.occurrenceCount),
        lastSeenRound: Math.max(current.lastSeenRound, record.lastRound),
        refs: compactRefs([...current.refs, ...nextRefs]),
      })
      continue
    }
    merged.set(key, {
      key,
      kind: mappedKind,
      statement,
      confidence: deriveWorkingConfidence(record),
      evidenceCount: record.occurrenceCount,
      firstSeenRound: record.roundNumber,
      lastSeenRound: record.lastRound,
      refs: nextRefs,
    })
  }

  const items = Array.from(merged.values()).sort((left, right) => {
    if (confidenceRank(left.confidence) !== confidenceRank(right.confidence)) {
      return confidenceRank(right.confidence) - confidenceRank(left.confidence)
    }
    if (left.evidenceCount !== right.evidenceCount) return right.evidenceCount - left.evidenceCount
    if (left.lastSeenRound !== right.lastSeenRound) return right.lastSeenRound - left.lastSeenRound
    return left.statement.localeCompare(right.statement)
  })

  return {
    updatedAt: nowISO(),
    updatedThroughRound: input.updatedThroughRound,
    items,
  }
}

function treeBranchFromRegion(region: string): "solution" | "anti_drift" | "acceptance" {
  const normalized = region.trim().toLowerCase()
  if (normalized.startsWith("anti_drift:")) return "anti_drift"
  if (normalized.startsWith("acceptance:")) return "acceptance"
  return "solution"
}

function defaultTreeBranchSummaries() {
  return [
    { branch: "solution" as const, summary: "No solution-path evidence yet.", focusRegions: [] as string[] },
    { branch: "anti_drift" as const, summary: "No anti-drift evidence yet.", focusRegions: [] as string[] },
    { branch: "acceptance" as const, summary: "No acceptance evidence yet.", focusRegions: [] as string[] },
  ]
}

function defaultTreeRolePositions() {
  return [
    {
      role: "planner" as const,
      branch: "solution" as const,
      focusRegions: [] as string[],
      note: "Read the full tree, then plan from solution branch.",
    },
    {
      role: "executor" as const,
      branch: "solution" as const,
      focusRegions: [] as string[],
      note: "Read the full tree, then execute from solution branch.",
    },
    {
      role: "campaign_worker" as const,
      branch: "solution" as const,
      focusRegions: [] as string[],
      note: "Read the full tree, then follow role-specific focus.",
    },
    {
      role: "campaign_lead" as const,
      branch: "acceptance" as const,
      focusRegions: [] as string[],
      note: "Read full tree and merge updates; only lead rewrites tree.",
    },
    {
      role: "campaign_reviewer" as const,
      branch: "acceptance" as const,
      focusRegions: [] as string[],
      note: "Read full tree and verify readiness alignment.",
    },
    {
      role: "blank_agent" as const,
      branch: "anti_drift" as const,
      focusRegions: [] as string[],
      note: "Read full tree and avoid anti-drift failures.",
    },
  ]
}

function emptyExplorationTreeDocument(roundNumber = 0): LongTaskCampaignExplorationTreeDocument {
  return {
    updatedAt: nowISO(),
    updatedThroughRound: roundNumber,
    currentPhase: "bootstrap",
    globalSummary: "No exploration progress yet.",
    branchSummaries: defaultTreeBranchSummaries(),
    rolePositions: defaultTreeRolePositions(),
    frontierRegions: [],
    requiredNextRegions: [],
    forbiddenRepeatRegions: [],
    nodes: [],
  }
}

function coerceExplorationTreeDocument(
  raw: unknown,
  fallback: LongTaskCampaignExplorationTreeDocument,
): LongTaskCampaignExplorationTreeDocument {
  if (Array.isArray(raw)) {
    return {
      ...fallback,
      nodes: raw
        .filter(
          (item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item),
        )
        .map((item, index) => ({
          nodeID:
            typeof item.nodeID === "string" && item.nodeID.trim().length > 0
              ? item.nodeID
              : `node-${String(index + 1).padStart(3, "0")}`,
          region:
            typeof item.region === "string" && item.region.trim().length > 0
              ? item.region
              : typeof item.hypothesis === "string" && item.hypothesis.trim().length > 0
                ? item.hypothesis
                : `region-${index + 1}`,
          branch:
            item.branch === "solution" || item.branch === "anti_drift" || item.branch === "acceptance"
              ? item.branch
              : treeBranchFromRegion(
                  typeof item.region === "string" && item.region.trim().length > 0 ? item.region : `region-${index + 1}`,
                ),
          parentID: typeof item.parentID === "string" && item.parentID.trim().length > 0 ? item.parentID : undefined,
          summary:
            typeof item.summary === "string" && item.summary.trim().length > 0
              ? item.summary
              : typeof item.hypothesis === "string" && item.hypothesis.trim().length > 0
                ? item.hypothesis
                : "No summary recorded.",
          status:
            item.status === "unexplored" ||
            item.status === "in_progress" ||
            item.status === "weak_fail" ||
            item.status === "strong_fail" ||
            item.status === "promising" ||
            item.status === "validated_success" ||
            item.status === "deprecated"
              ? item.status
              : "unexplored",
          confidence: typeof item.confidence === "number" ? item.confidence : 0.5,
          evidenceRefs: Array.isArray(item.evidenceRefs)
            ? item.evidenceRefs.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            : [],
          lastUpdatedRound:
            typeof item.lastUpdatedRound === "number" ? item.lastUpdatedRound : fallback.updatedThroughRound,
          prerequisites: Array.isArray(item.prerequisites)
            ? item.prerequisites.filter(
                (value): value is string => typeof value === "string" && value.trim().length > 0,
              )
            : [],
          attemptCount: typeof item.attemptCount === "number" ? item.attemptCount : 0,
          successCount: typeof item.successCount === "number" ? item.successCount : 0,
          failCount: typeof item.failCount === "number" ? item.failCount : 0,
          notes: Array.isArray(item.notes)
            ? item.notes.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            : [],
        })),
    }
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fallback
  const value = raw as Record<string, unknown>
  return {
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
    updatedThroughRound:
      typeof value.updatedThroughRound === "number" ? value.updatedThroughRound : fallback.updatedThroughRound,
    currentPhase: typeof value.currentPhase === "string" ? value.currentPhase : fallback.currentPhase,
    globalSummary: typeof value.globalSummary === "string" ? value.globalSummary : fallback.globalSummary,
    branchSummaries: Array.isArray(value.branchSummaries)
      ? value.branchSummaries
          .filter(
            (item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item),
          )
          .map((item) => ({
            branch: item.branch === "solution" || item.branch === "anti_drift" || item.branch === "acceptance"
              ? item.branch
              : "solution",
            summary:
              typeof item.summary === "string" && item.summary.trim().length > 0
                ? item.summary.trim()
                : "No summary recorded.",
            focusRegions: Array.isArray(item.focusRegions)
              ? item.focusRegions.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
              : [],
          }))
      : fallback.branchSummaries,
    rolePositions: Array.isArray(value.rolePositions)
      ? value.rolePositions
          .filter(
            (item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item),
          )
          .map((item) => ({
            role:
              item.role === "planner" ||
              item.role === "executor" ||
              item.role === "campaign_worker" ||
              item.role === "campaign_lead" ||
              item.role === "campaign_reviewer" ||
              item.role === "blank_agent"
                ? item.role
                : "planner",
            branch: item.branch === "solution" || item.branch === "anti_drift" || item.branch === "acceptance"
              ? item.branch
              : "solution",
            focusRegions: Array.isArray(item.focusRegions)
              ? item.focusRegions.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
              : [],
            note: typeof item.note === "string" && item.note.trim().length > 0 ? item.note.trim() : "No note recorded.",
          }))
      : fallback.rolePositions,
    frontierRegions: Array.isArray(value.frontierRegions)
      ? value.frontierRegions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.frontierRegions,
    requiredNextRegions: Array.isArray(value.requiredNextRegions)
      ? value.requiredNextRegions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.requiredNextRegions,
    forbiddenRepeatRegions: Array.isArray(value.forbiddenRepeatRegions)
      ? value.forbiddenRepeatRegions.filter(
          (item): item is string => typeof item === "string" && item.trim().length > 0,
        )
      : fallback.forbiddenRepeatRegions,
    nodes: coerceExplorationTreeDocument(Array.isArray(value.nodes) ? value.nodes : [], fallback).nodes,
  }
}

function buildRunTraceDigest(trace: LongTaskCampaignRunTrace): LongTaskCampaignRunTraceDigest {
  return {
    campaignID: trace.campaignID,
    roundNumber: trace.roundNumber,
    runID: trace.runID,
    createdAt: trace.createdAt,
    finalStatus: trace.finalStatus,
    summary: trace.summary,
    exploredRegions: uniqueStrings(trace.exploredRegions),
    keySuccessPaths: uniqueStrings(trace.keySuccessPaths),
    keyFailurePaths: uniqueStrings(trace.keyFailurePaths),
    blockers: uniqueStrings(trace.blockers),
    pendingPackageImpact: uniqueStrings(trace.pendingPackageImpact),
    runVerificationSignal: trace.runVerificationSignal,
    validatedMethods: uniqueStrings(
      trace.attempts.flatMap((attempt) =>
        attempt.operationalContext
          .filter((item) => item.kind === "validated_method" || item.kind === "tool_entrypoint")
          .map((item) => item.statement),
      ),
    ),
    forbiddenPaths: uniqueStrings(
      trace.attempts.flatMap((attempt) =>
        attempt.operationalContext.filter((item) => item.kind === "failed_path").map((item) => item.statement),
      ),
    ),
    packageGaps: uniqueStrings(
      trace.attempts.flatMap((attempt) =>
        attempt.operationalContext.filter((item) => item.kind === "package_gap").map((item) => item.statement),
      ),
    ),
    commandOutcomes: trace.attempts.map((attempt) => ({
      unitID: attempt.unitID,
      attempt: attempt.attempt,
      successCommands: uniqueStrings(
        attempt.commandRecords
          .filter((item) => item.status === "success")
          .map((item) => item.command ?? item.title ?? item.tool),
      ),
      failedCommands: uniqueStrings(
        attempt.commandRecords
          .filter((item) => item.status === "failure")
          .map((item) => item.command ?? item.title ?? item.tool),
      ),
    })),
    refs: compactRefs(
      trace.attempts.flatMap((attempt) =>
        compactRefs([
          ...(attempt.responsePath ? [attempt.responsePath] : []),
          ...(attempt.failurePacketRefs ?? []),
          ...(attempt.claimRefs ?? []),
        ]),
      ),
    ),
  }
}

function evolveExplorationTreeDocument(input: {
  previous: LongTaskCampaignExplorationTreeDocument
  digest: LongTaskCampaignRunTraceDigest
  roundNumber: number
}): LongTaskCampaignExplorationTreeDocument {
  const nodes = new Map<string, LongTaskCampaignExplorationNode>()
  for (const node of input.previous.nodes) nodes.set(node.region, node)

  const failedRegions = new Set(
    input.digest.commandOutcomes.filter((item) => item.failedCommands.length > 0).map((item) => item.unitID),
  )
  const succeededRegions = new Set(
    input.digest.commandOutcomes.filter((item) => item.successCommands.length > 0).map((item) => item.unitID),
  )

  for (const region of uniqueStrings([
    ...input.digest.exploredRegions,
    ...input.digest.commandOutcomes.map((item) => item.unitID),
  ])) {
    const current = nodes.get(region)
    const fail = failedRegions.has(region)
    const success = succeededRegions.has(region)
    nodes.set(region, {
      nodeID: current?.nodeID ?? `region-${region.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      region,
      branch: current?.branch ?? treeBranchFromRegion(region),
      parentID: current?.parentID,
      summary:
        current?.summary ??
        (success && !fail
          ? `Region ${region} produced successful command outcomes.`
          : fail
            ? `Region ${region} produced failing command outcomes.`
            : `Region ${region} was explored.`),
      status: success && !fail ? "validated_success" : fail ? "strong_fail" : (current?.status ?? "promising"),
      confidence: Math.max(current?.confidence ?? 0.5, success && !fail ? 0.8 : fail ? 0.7 : 0.6),
      evidenceRefs: compactRefs([...(current?.evidenceRefs ?? []), ...input.digest.refs]),
      lastUpdatedRound: input.roundNumber,
      prerequisites: current?.prerequisites ?? [],
      attemptCount: (current?.attemptCount ?? 0) + 1,
      successCount: (current?.successCount ?? 0) + (success ? 1 : 0),
      failCount: (current?.failCount ?? 0) + (fail ? 1 : 0),
      notes: (current?.notes ?? []).slice(0, 3).map((item) => short(item, 140)),
    })
  }

  const blankAgentDriftSignals = extractBlankAgentDriftSignalsFromDigest(input.digest)
  if (blankAgentDriftSignals.length > 0) {
    const region = "anti_drift:blank-agent-repeat-drift"
    const current = nodes.get(region)
    nodes.set(region, {
      nodeID: current?.nodeID ?? "region-anti-drift-blank-agent-repeat-drift",
      region,
      branch: "anti_drift",
      parentID: current?.parentID,
      summary: "Blank-agent execution repeated avoidable drift. Next rounds must follow anti-drift guardrails.",
      status: "weak_fail",
      confidence: Math.max(current?.confidence ?? 0.7, 0.82),
      evidenceRefs: compactRefs([...(current?.evidenceRefs ?? []), ...input.digest.refs]),
      lastUpdatedRound: input.roundNumber,
      prerequisites: uniqueStrings([...(current?.prerequisites ?? []), "follow-anti-drift-guardrails"]),
      attemptCount: (current?.attemptCount ?? 0) + 1,
      successCount: current?.successCount ?? 0,
      failCount: (current?.failCount ?? 0) + 1,
      notes: uniqueStrings([
        ...(current?.notes ?? []),
        ...blankAgentDriftSignals.slice(0, 4).map((item) => `drift: ${short(item, 160)}`),
      ])
        .slice(0, 4)
        .map((item) => short(item, 140)),
    })
  }

  const acceptanceRegion = "acceptance:completion-gate"
  const acceptanceCurrent = nodes.get(acceptanceRegion)
  if (input.digest.runVerificationSignal) {
    const gate = input.digest.runVerificationSignal
    nodes.set(acceptanceRegion, {
      nodeID: acceptanceCurrent?.nodeID ?? "region-acceptance-completion-gate",
      region: acceptanceRegion,
      branch: "acceptance",
      parentID: acceptanceCurrent?.parentID,
      summary: gate.completionGatePassed
        ? "Completion gate passed in this round."
        : "Completion gate did not fully pass in this round.",
      status: gate.completionGatePassed ? "validated_success" : "in_progress",
      confidence: gate.completionGatePassed ? 0.9 : 0.7,
      evidenceRefs: compactRefs([...(acceptanceCurrent?.evidenceRefs ?? []), ...input.digest.refs]),
      lastUpdatedRound: input.roundNumber,
      prerequisites: acceptanceCurrent?.prerequisites ?? [],
      attemptCount: (acceptanceCurrent?.attemptCount ?? 0) + 1,
      successCount: (acceptanceCurrent?.successCount ?? 0) + (gate.completionGatePassed ? 1 : 0),
      failCount: (acceptanceCurrent?.failCount ?? 0) + (gate.completionGatePassed ? 0 : 1),
      notes: [
        `validators_required=${gate.completionValidatorsRequired}, executed=${gate.completionValidatorsExecuted}, passed=${gate.completionValidatorsPassed}, failed=${gate.completionValidatorsFailed}`,
      ].map((item) => short(item, 140)),
    })
  }

  const nodeList = Array.from(nodes.values())
    .map((node) => ({
      ...node,
      branch: node.branch ?? treeBranchFromRegion(node.region),
      notes: (node.notes ?? []).slice(0, 3).map((item) => short(item, 140)),
      evidenceRefs: compactRefs(node.evidenceRefs ?? []),
    }))
    .sort((left, right) => {
      if ((left.lastUpdatedRound ?? 0) !== (right.lastUpdatedRound ?? 0)) {
        return (right.lastUpdatedRound ?? 0) - (left.lastUpdatedRound ?? 0)
      }
      return left.region.localeCompare(right.region)
    })

  const compactByBranch = (branch: "solution" | "anti_drift" | "acceptance", limit: number) =>
    nodeList.filter((node) => (node.branch ?? treeBranchFromRegion(node.region)) === branch).slice(0, limit)
  const compactNodes = [
    ...compactByBranch("solution", 12),
    ...compactByBranch("anti_drift", 8),
    ...compactByBranch("acceptance", 6),
  ].sort((left, right) => left.region.localeCompare(right.region))

  const solutionFocus = compactNodes.filter((node) => node.branch === "solution").map((node) => node.region).slice(0, 4)
  const antiDriftFocus = compactNodes
    .filter((node) => node.branch === "anti_drift")
    .map((node) => node.region)
    .slice(0, 4)
  const acceptanceFocus = compactNodes
    .filter((node) => node.branch === "acceptance")
    .map((node) => node.region)
    .slice(0, 4)

  return {
    updatedAt: nowISO(),
    updatedThroughRound: input.roundNumber,
    currentPhase: input.previous.currentPhase === "bootstrap" ? "iterating" : input.previous.currentPhase,
    globalSummary: short(
      `${input.digest.summary} | solution=${solutionFocus.length}, anti_drift=${antiDriftFocus.length}, acceptance=${acceptanceFocus.length}`,
      200,
    ),
    branchSummaries: [
      {
        branch: "solution",
        summary: short("Solution branch tracks explored and promising solution regions.", 120),
        focusRegions: solutionFocus,
      },
      {
        branch: "anti_drift",
        summary: short("Anti-drift branch tracks repeatable blank-agent drift patterns and guardrails.", 120),
        focusRegions: antiDriftFocus,
      },
      {
        branch: "acceptance",
        summary: short("Acceptance branch tracks current completion-gate progress and readiness.", 120),
        focusRegions: acceptanceFocus,
      },
    ],
    rolePositions: [
      { role: "planner", branch: "solution", focusRegions: solutionFocus, note: "Read full tree, then plan from solution branch." },
      { role: "executor", branch: "solution", focusRegions: [...solutionFocus, ...antiDriftFocus].slice(0, 4), note: "Read full tree, execute while respecting anti-drift branch." },
      { role: "campaign_worker", branch: "anti_drift", focusRegions: [...antiDriftFocus, ...solutionFocus].slice(0, 4), note: "Read full tree and produce role-specific structured suggestions." },
      { role: "campaign_lead", branch: "acceptance", focusRegions: [...acceptanceFocus, ...antiDriftFocus].slice(0, 4), note: "Read full tree; lead is the only tree editor." },
      { role: "campaign_reviewer", branch: "acceptance", focusRegions: [...acceptanceFocus, ...antiDriftFocus].slice(0, 4), note: "Read full tree and verify round readiness against tree evidence." },
      { role: "blank_agent", branch: "anti_drift", focusRegions: [...antiDriftFocus, ...acceptanceFocus].slice(0, 4), note: "Read full tree and avoid anti-drift failures before claiming completion." },
    ],
    frontierRegions: compactNodes
      .filter((node) => node.status === "promising" || node.status === "unexplored")
      .map((node) => node.region),
    requiredNextRegions: input.previous.requiredNextRegions,
    forbiddenRepeatRegions: compactNodes
      .filter((node) => (node.successCount ?? 0) >= 2 || node.status === "deprecated")
      .map((node) => node.region),
    nodes: compactNodes,
  }
}

function coerceRoutingControl(raw: unknown, fallback: LongTaskCampaignRoutingControl): LongTaskCampaignRoutingControl {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fallback
  const value = raw as Record<string, unknown>
  return {
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
    updatedThroughRound:
      typeof value.updatedThroughRound === "number" ? value.updatedThroughRound : fallback.updatedThroughRound,
    currentPhase: typeof value.currentPhase === "string" ? value.currentPhase : fallback.currentPhase,
    requiredNextRegions: Array.isArray(value.requiredNextRegions)
      ? value.requiredNextRegions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.requiredNextRegions,
    forbiddenUnits: Array.isArray(value.forbiddenUnits)
      ? value.forbiddenUnits.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.forbiddenUnits,
    forbiddenRegions: Array.isArray(value.forbiddenRegions)
      ? value.forbiddenRegions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.forbiddenRegions,
    prerequisites: Array.isArray(value.prerequisites)
      ? value.prerequisites.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.prerequisites,
    blockedBy: Array.isArray(value.blockedBy)
      ? value.blockedBy.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.blockedBy,
    readyForFinalAcceptance:
      typeof value.readyForFinalAcceptance === "boolean"
        ? value.readyForFinalAcceptance
        : fallback.readyForFinalAcceptance,
    summary: typeof value.summary === "string" ? value.summary : fallback.summary,
    evidenceRefs: Array.isArray(value.evidenceRefs)
      ? compactRefs(
          value.evidenceRefs.filter((item): item is string => typeof item === "string" && item.trim().length > 0),
        )
      : fallback.evidenceRefs,
    notes: Array.isArray(value.notes)
      ? value.notes.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : fallback.notes,
  }
}

function buildRoutingControl(input: {
  previous: LongTaskCampaignRoutingControl
  tree: LongTaskCampaignExplorationTreeDocument
  digest: LongTaskCampaignRunTraceDigest
  reviewerSuggestion?: LongTaskCampaignReviewSuggestion
  dispatchTickets?: LongTaskCampaignDispatchTicketDocument
  roundNumber: number
}): LongTaskCampaignRoutingControl {
  const infrastructureBlockerKeywords = [
    "timeout",
    "timed out",
    "spawn",
    "no structured signal",
    "access is denied",
    "eperm",
    "exit code",
    "crash",
    "bootstrap failed",
    "infrastructure",
  ]
  const hardBlockerKeywords = [
    "validator",
    "missing",
    "not found",
    "mismatch",
    "placeholder",
    "blocked",
    "failed",
  ]
  const softBlockerHints = ["maybe", "might", "looks like", "seems", "probably", "possibly", "suggest", "guess"]
  const normalizedBlockers = uniqueStrings(input.digest.blockers.map((item) => item.trim()).filter(Boolean))
  const infrastructureBlockers = uniqueStrings(
    normalizedBlockers.filter((item) => {
      const normalized = item.toLowerCase()
      return infrastructureBlockerKeywords.some((keyword) => normalized.includes(keyword))
    }),
  )
  const hardBlockers = uniqueStrings(
    normalizedBlockers.filter((item) => {
      const normalized = item.toLowerCase()
      if (!normalized) return false
      if (softBlockerHints.some((hint) => normalized.includes(hint))) return false
      if (infrastructureBlockerKeywords.some((keyword) => normalized.includes(keyword))) return false
      return hardBlockerKeywords.some((keyword) => normalized.includes(keyword))
    }),
  ).slice(0, 8)

  const repeatedSuccessfulUnits = input.tree.nodes
    .filter((node) => (node.successCount ?? 0) >= 2 && node.region.trim().length > 0)
    .map((node) => node.region)

  return {
    updatedAt: nowISO(),
    updatedThroughRound: input.roundNumber,
    currentPhase:
      input.reviewerSuggestion?.readyForFinalAcceptance === true
        ? "final_acceptance"
        : input.previous.currentPhase === "bootstrap"
          ? "iterating"
          : input.previous.currentPhase,
    requiredNextRegions: uniqueStrings([
      ...input.tree.requiredNextRegions,
      ...(input.reviewerSuggestion?.nextAttentionAreas ?? []),
      ...dispatchRequiredRegions(input.dispatchTickets ?? emptyDispatchTicketDocument(input.roundNumber)),
    ]),
    forbiddenUnits: uniqueStrings([...input.previous.forbiddenUnits, ...repeatedSuccessfulUnits]),
    forbiddenRegions: uniqueStrings([...input.previous.forbiddenRegions, ...input.tree.forbiddenRepeatRegions]),
    prerequisites: uniqueStrings(input.previous.prerequisites),
    blockedBy: hardBlockers,
    readyForFinalAcceptance: input.reviewerSuggestion?.readyForFinalAcceptance === true,
    summary: input.reviewerSuggestion?.summary ?? input.digest.summary,
    evidenceRefs: compactRefs(input.digest.refs),
    notes: uniqueStrings([
      ...(input.previous.notes ?? []),
      ...input.digest.pendingPackageImpact.slice(0, 4),
      ...infrastructureBlockers
        .slice(0, 3)
        .map((item) => `Infrastructure signal (do not route as domain blocker): ${item}`),
      ...(input.dispatchTickets?.tickets ?? [])
        .filter((item) => item.status === "open")
        .slice(0, 4)
        .map((item) => `Open dispatch ticket: ${item.title} -> ${item.actionableFix}`),
    ]),
  }
}

function extractJsonObject(raw: string) {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const attempts = [trimmed]
  const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)```/i)
  if (fencedMatch?.[1]) attempts.push(fencedMatch[1].trim())
  const firstObjectMatch = trimmed.match(/\{[\s\S]*\}/)
  if (firstObjectMatch?.[0]) attempts.push(firstObjectMatch[0].trim())

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as Record<string, unknown>
    } catch {
      continue
    }
  }
  return undefined
}

function normalizeStringArray(input: unknown) {
  if (!Array.isArray(input)) return []
  return input
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
}

function primaryExperienceWorkspaceSeedTarget(seedTargets: LongTaskCampaignSeedTarget[]) {
  return seedTargets.find((item) => (item.kind ?? "experience_workspace") === "experience_workspace")
}

function experienceSnapshotFromRoot(root: string) {
  return experienceWorkspacePathsFromRoot(root, "manifest.md")
}

async function resetPath(target: string) {
  await rm(target, { recursive: true, force: true })
}

function surfaceContractDeclaredPaths(contract: Record<string, unknown> | undefined) {
  if (!contract) return []
  const out: string[] = []
  const add = (value: unknown) => {
    if (typeof value !== "string") return
    const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").trim()
    if (!normalized || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) return
    out.push(normalized)
  }
  add(contract.entry)
  add(contract.changeLog)
  for (const item of Array.isArray(contract.documents) ? contract.documents : []) {
    if (typeof item === "string") add(item)
    else if (item && typeof item === "object") add((item as Record<string, unknown>).path)
  }
  return uniqueStrings(out)
}

async function copySurfaceContractRequiredPaths(sourceRoot: string, targetRoot: string) {
  const contractPath = path.join(sourceRoot, "surface_contract.json")
  if (!(await pathExists(contractPath))) return
  let contract: Record<string, unknown> | undefined
  try {
    contract = await readJsonFile<Record<string, unknown>>(contractPath)
  } catch {
    return
  }
  for (const relative of surfaceContractDeclaredPaths(contract)) {
    const source = path.join(sourceRoot, ...relative.split("/"))
    const target = path.join(targetRoot, ...relative.split("/"))
    if (await pathExists(target)) continue
    if (!(await pathExists(source))) continue
    const stats = await lstat(source)
    if (stats.isDirectory()) {
      await cp(source, target, { recursive: true, force: true })
    } else {
      await ensureParentDirForPath(target)
      await cp(source, target, { force: true })
    }
  }
}

async function copyExperienceWorkspaceRoot(
  sourceRoot: string,
  targetRoot: string,
  options: { includeSurfaceContractRequiredPaths?: boolean; declaredSkill?: SkillBinding } = {},
) {
  if (options.declaredSkill) {
    await copyCandidate(sourceRoot, targetRoot, options.declaredSkill)
    return
  }
  const snapshot = await readExperienceWorkspace(experienceSnapshotFromRoot(sourceRoot))
  await resetPath(targetRoot)
  await writeExperienceWorkspaceSnapshot(targetRoot, snapshot)
  if (options.includeSurfaceContractRequiredPaths) {
    await copySurfaceContractRequiredPaths(sourceRoot, targetRoot)
  }
}

async function copyPathIntoTarget(sourcePath: string, targetPath: string) {
  await resetPath(targetPath)
  if (!(await pathExists(sourcePath))) {
    await ensureDirectory(targetPath)
    return
  }
  const stats = await lstat(sourcePath)
  if (stats.isDirectory()) {
    await cp(sourcePath, targetPath, { recursive: true, force: true })
    return
  }
  await ensureParentDirForPath(targetPath)
  await cp(sourcePath, targetPath, { force: true })
}

function assertCampaignTruthPath(label: string, truthRoot: string, candidate: string) {
  if (isPathWithinTruthRoot(truthRoot, candidate)) return
  const resolvedCandidate = resolvePathTruth(candidate)
  throw new Error(
    `${label} escaped the current campaign truth root. expected_under=${truthRoot} actual=${resolvedCandidate}`,
  )
}

function enforceCampaignTruthPaths(input: {
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  roundPaths?: ReturnType<typeof longTaskCampaignRoundPaths>
}) {
  const truthRoot = resolvePathTruth(input.campaignPaths.root)
  const corePaths = [
    ["campaign root", input.campaignPaths.root],
    ["pending expert package", input.campaignPaths.pendingCurrentRoot],
    ["exploration tree", input.campaignPaths.explorationTreePath],
    ["routing control", input.campaignPaths.campaignRoutingControlPath],
    ["campaign working memory", input.campaignPaths.campaignWorkingMemoryPath],
    ["dispatch tickets", input.campaignPaths.dispatchTicketsPath],
    ["blank-agent acceptance diagnosis", input.campaignPaths.blankAgentAcceptanceDiagnosisPath],
    ["acceptance experience", input.campaignPaths.acceptanceExperienceJsonlPath],
  ] as const
  for (const [label, candidate] of corePaths) {
    assertCampaignTruthPath(label, truthRoot, candidate)
  }
  if (!input.roundPaths) return truthRoot
  const roundPaths = [
    ["round root", input.roundPaths.root],
    ["round pending package snapshot", input.roundPaths.pendingPackageSnapshotRoot],
    ["round tree draft", input.roundPaths.explorationTreeDraftPath],
    ["round routing draft", input.roundPaths.routingControlDraftPath],
    ["round final acceptance root", input.roundPaths.finalAcceptanceRoot],
  ] as const
  for (const [label, candidate] of roundPaths) {
    assertCampaignTruthPath(label, truthRoot, candidate)
  }
  return truthRoot
}

async function seedCampaignCurrentPendingPackage(input: {
  currentRoot: string
  seedTarget: LongTaskCampaignSeedTarget | undefined
  declaredSkill?: SkillBinding
}) {
  if (!input.seedTarget) {
    // 新协议可从零学习；只创建目录，不伪造合格候选。
    if (input.declaredSkill) await ensureDirectory(input.currentRoot)
    return
  }
  if (input.declaredSkill) {
    if (await hasCandidate(input.currentRoot, input.declaredSkill)) return
    await copyCandidate(input.seedTarget.seedPath, input.currentRoot, input.declaredSkill)
    return
  }
  const entryCandidates = ["manifest.md", "INDEX.md", "README.md", "index.md", "ENTRY.md"]
  for (const candidate of entryCandidates) {
    if (await pathExists(path.join(input.currentRoot, candidate))) return
  }
  if ((input.seedTarget.kind ?? "experience_workspace") === "experience_workspace") {
    await copyExperienceWorkspaceRoot(input.seedTarget.seedPath, input.currentRoot)
    return
  }
  await copyPathIntoTarget(input.seedTarget.seedPath, input.currentRoot)
}

function normalizeContextPathForFilter(inputPath: string) {
  return inputPath.replace(/\\/g, "/").toLowerCase()
}

function isStaticBaseContextPath(inputPath: string) {
  const normalized = normalizeContextPathForFilter(inputPath)
  return (
    !normalized.includes("/seed-expert-workspace/") &&
    !normalized.includes("/seed-campaign-evidence/") &&
    !normalized.includes("/runtime-state/long-task-campaigns/") &&
    !normalized.endsWith("aggregated-failure-packets.jsonl") &&
    !normalized.endsWith("aggregated-retry-lessons.jsonl") &&
    !normalized.endsWith("aggregated-learning-units.jsonl") &&
    !normalized.endsWith("carryover-failure-packets.md") &&
    !normalized.endsWith("carryover-retry-lessons.md") &&
    !normalized.endsWith("carryover-learning-units.md") &&
    !normalized.endsWith("campaign-failure-lessons.md") &&
    !normalized.endsWith("campaign-seed-context.md") &&
    !normalized.endsWith("campaign-operational-memory.json")
  )
}

function collectStaticBaseContextPaths(baseSpec: LongTaskSpec) {
  return uniqueStrings((baseSpec.initialExpertContextPaths ?? []).filter(isStaticBaseContextPath))
}

function defaultCampaignWorkerRoles(baseSpec?: LongTaskSpec): LongTaskCampaignWorkerRole[] {
  if (baseSpec && isMultiSkillMergeProfile(baseSpec)) return [...MULTI_SKILL_MERGE_WORKER_ROLES]
  return [
    "blank_acceptance_diagnostician",
    "success_synthesizer",
    "failure_synthesizer",
    "tool_failure_synthesizer",
    "forbidden_path_synthesizer",
    "learning_promoter",
    "exploration_tree_synthesizer",
    "drift_guard_synthesizer",
  ]
}

async function ensureBlankAgentAcceptanceDiagnosis(
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>,
  roundNumber: number,
) {
  if (await pathExists(campaignPaths.blankAgentAcceptanceDiagnosisPath)) return
  await writeJsonFile(campaignPaths.blankAgentAcceptanceDiagnosisPath, {
    id: "blank-agent-acceptance-diagnosis-initial",
    roundNumber: Math.max(0, roundNumber - 1),
    role: "blank_acceptance_diagnostician",
    createdAt: nowISO(),
    summary: "No blank-agent final acceptance diagnosis has been produced yet.",
    findings: [],
    memoryAdvice: [],
    packageAdvice: [],
    explorationAdvice: [],
    refs: [],
  } satisfies LongTaskCampaignWorkerSuggestion)
}

async function readEventsIfExists(target: string) {
  if (!(await pathExists(target))) return [] as Array<Record<string, unknown>>
  try {
    return await readJsonFile<Array<Record<string, unknown>>>(target)
  } catch {
    return [] as Array<Record<string, unknown>>
  }
}

function extractCommandRecordsFromEvents(input: {
  events: Array<Record<string, unknown>>
  eventsPath: string
  sessionExecutionReportPath?: string
}): LongTaskCampaignRunTraceCommandRecord[] {
  const records: LongTaskCampaignRunTraceCommandRecord[] = []
  for (const event of input.events) {
    if (event.type !== "tool_use" || typeof event.part !== "object" || !event.part || Array.isArray(event.part))
      continue
    const part = event.part as Record<string, unknown>
    const tool = typeof part.tool === "string" ? part.tool : "unknown"
    const state =
      typeof part.state === "object" && part.state && !Array.isArray(part.state)
        ? (part.state as Record<string, unknown>)
        : undefined
    const metadata =
      typeof state?.metadata === "object" && state.metadata && !Array.isArray(state.metadata)
        ? (state.metadata as Record<string, unknown>)
        : undefined
    const inputState =
      typeof state?.input === "object" && state.input && !Array.isArray(state.input)
        ? (state.input as Record<string, unknown>)
        : undefined
    const exit = typeof metadata?.exit === "number" ? metadata.exit : undefined
    const status = state?.status === "error" || (typeof exit === "number" && exit !== 0) ? "failure" : "success"
    const command =
      typeof inputState?.command === "string"
        ? inputState.command
        : typeof inputState?.script === "string"
          ? inputState.script
          : undefined
    records.push({
      id: randomUUID().slice(0, 8),
      tool,
      status,
      title: typeof state?.title === "string" ? state.title : undefined,
      command,
      error: typeof state?.error === "string" ? state.error : undefined,
      outputPreview: typeof state?.output === "string" ? short(state.output, 200) : undefined,
      timestamp: typeof event.timestamp === "number" ? event.timestamp : undefined,
      refs: uniqueStrings(
        [input.eventsPath, input.sessionExecutionReportPath].filter((item): item is string => Boolean(item)),
      ),
    })
  }
  return records
}

async function buildCampaignRunTrace(input: {
  campaignID: string
  roundNumber: number
  run: ReturnType<typeof longTaskRunPaths>
  spec: LongTaskSpec
  finalStatus: LongTaskRunStatus
  summary: string
  runVerificationSignal?: LongTaskCampaignRunTrace["runVerificationSignal"]
}): Promise<LongTaskCampaignRunTrace> {
  let graph: LongTaskWorkGraph
  try {
    graph = await readJsonFile<LongTaskWorkGraph>(input.run.workGraphPath)
  } catch {
    graph = { units: [] } as unknown as LongTaskWorkGraph
  }
  const [claims, failures, scratchUnits, learningUnits, retryLessons, operationalContext] = await Promise.all([
    readJsonLinesIfExists<Record<string, unknown>>(input.run.claimsPath),
    readJsonLinesIfExists<Record<string, unknown>>(input.run.failurePacketsPath),
    readJsonLinesIfExists<Record<string, unknown>>(input.run.scratchUnitsPath),
    readJsonLinesIfExists<Record<string, unknown>>(input.run.learningUnitsPath),
    readJsonLinesIfExists<Record<string, unknown>>(input.run.retryLessonsPath),
    readOperationalContext(input.run),
  ])

  const attempts: LongTaskCampaignRunTraceAttemptRecord[] = []
  for (const unit of graph.units) {
    const unitRoot = path.join(input.run.unitsRoot, unit.id)
    if (!(await pathExists(unitRoot))) continue
    const attemptEntries = await readdir(unitRoot, { withFileTypes: true })
    for (const entry of attemptEntries) {
      if (!entry.isDirectory()) continue
      const attemptMatch = entry.name.match(/^attempt-(\d+)$/)
      if (!attemptMatch) continue
      const attemptNumber = Number(attemptMatch[1])
      const attemptRoot = path.join(unitRoot, entry.name)
      const executeDir = path.join(attemptRoot, "execute")
      const retryInputBundlePath = path.join(attemptRoot, "retry_input_bundle.json")
      const eventsPath = path.join(executeDir, "events.json")
      const sessionExecutionReportPath = path.join(executeDir, "session_execution_report.md")
      const responsePath = path.join(executeDir, "response.txt")
      const toolFailuresPath = path.join(executeDir, "tool_failures.json")
      const runJsonPath = path.join(executeDir, "run.json")
      const events = await readEventsIfExists(eventsPath)
      let runJson: Record<string, unknown> | undefined
      if (await pathExists(runJsonPath)) {
        try {
          runJson = await readJsonFile<Record<string, unknown>>(runJsonPath)
        } catch {
          runJson = undefined
        }
      }
      const claim = claims.find((item) => item.unitID === unit.id && item.attempt === attemptNumber)
      const failure = failures.find((item) => item.unitID === unit.id && item.attempt === attemptNumber)
      const scratchStatements = scratchUnits
        .filter((item) => item.unitID === unit.id && item.attempt === attemptNumber)
        .map((item) => extractStringField(item, "statement"))
        .filter((item): item is string => Boolean(item))
      const learningStatements = learningUnits
        .filter((item) => item.unitID === unit.id && item.attempt === attemptNumber)
        .map((item) => extractStringField(item, "statement"))
        .filter((item): item is string => Boolean(item))
      const retrySignals = retryLessons
        .filter((item) => item.unitID === unit.id && item.attempt === attemptNumber)
        .flatMap((item) =>
          [
            extractStringField(item, "whatFailed"),
            ...(Array.isArray(item.nextAttemptStrategy)
              ? item.nextAttemptStrategy.filter((value): value is string => typeof value === "string")
              : []),
          ].filter((value): value is string => Boolean(value)),
        )
      attempts.push({
        unitID: unit.id,
        unitTitle: unit.title,
        attempt: attemptNumber,
        executeDir,
        retryInputBundlePath: (await pathExists(retryInputBundlePath)) ? retryInputBundlePath : undefined,
        responsePath: (await pathExists(responsePath)) ? responsePath : undefined,
        sessionExecutionReportPath: (await pathExists(sessionExecutionReportPath))
          ? sessionExecutionReportPath
          : undefined,
        eventsPath: (await pathExists(eventsPath)) ? eventsPath : undefined,
        toolFailuresPath: (await pathExists(toolFailuresPath)) ? toolFailuresPath : undefined,
        claimID: typeof claim?.id === "string" ? claim.id : undefined,
        claimRefs: Array.isArray(claim?.evidenceRefs)
          ? claim.evidenceRefs.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : [],
        failurePacketID: typeof failure?.id === "string" ? failure.id : undefined,
        failurePacketRefs: Array.isArray(failure?.evidenceRefs)
          ? failure.evidenceRefs.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : [],
        exitCode: typeof runJson?.exitCode === "number" ? runJson.exitCode : undefined,
        claimStatement: typeof claim?.statement === "string" ? claim.statement : undefined,
        claimedSuccess: typeof claim?.claimedSuccess === "boolean" ? claim.claimedSuccess : undefined,
        failureSummary: typeof failure?.mismatchSummary === "string" ? failure.mismatchSummary : undefined,
        scratchUnits: scratchUnits
          .filter((item) => item.unitID === unit.id && item.attempt === attemptNumber)
          .map((item) => ({
            id: typeof item.id === "string" ? item.id : `scratch-${unit.id}-${attemptNumber}`,
            kind: typeof item.kind === "string" ? item.kind : "obs",
            statement: typeof item.statement === "string" ? item.statement : "Unstructured scratch note.",
            refs: Array.isArray(item.refs)
              ? item.refs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
              : [],
          })),
        learningUnits: learningUnits
          .filter((item) => item.unitID === unit.id)
          .map((item) => ({
            id: typeof item.id === "string" ? item.id : `learning-${unit.id}`,
            kind: typeof item.kind === "string" ? item.kind : "obs",
            scope: typeof item.scope === "string" ? item.scope : "local",
            strength: item.strength === 2 || item.strength === 3 ? item.strength : 1,
            statement: typeof item.statement === "string" ? item.statement : "Unstructured learning unit.",
            refs: Array.isArray(item.refs)
              ? item.refs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
              : [],
          })),
        retryLessons: retryLessons
          .filter((item) => item.unitID === unit.id && item.attempt === attemptNumber)
          .map((item) => ({
            id: typeof item.id === "string" ? item.id : `retry-${unit.id}-${attemptNumber}`,
            failureType: typeof item.failureType === "string" ? item.failureType : "validator_failed",
            failureSignature: typeof item.failureSignature === "string" ? item.failureSignature : "unknown",
            whatFailed: typeof item.whatFailed === "string" ? item.whatFailed : "Unknown retry lesson.",
            whyFailed: Array.isArray(item.whyFailed)
              ? item.whyFailed.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
              : [],
            doNotRepeat: Array.isArray(item.doNotRepeat)
              ? item.doNotRepeat.filter(
                  (value): value is string => typeof value === "string" && value.trim().length > 0,
                )
              : [],
            nextAttemptStrategy: Array.isArray(item.nextAttemptStrategy)
              ? item.nextAttemptStrategy.filter(
                  (value): value is string => typeof value === "string" && value.trim().length > 0,
                )
              : [],
            evidenceRefs: Array.isArray(item.evidenceRefs)
              ? item.evidenceRefs.filter(
                  (value): value is string => typeof value === "string" && value.trim().length > 0,
                )
              : [],
          })),
        operationalContext: operationalContext
          .filter((item) => item.sourceUnitID === unit.id && item.sourceAttempt === attemptNumber)
          .map((item) => ({
            id: item.id,
            kind: item.kind,
            status: item.status,
            statement: item.statement,
            rationale: item.rationale,
            refs: item.refs,
            tags: item.tags,
          })),
        attemptFindings: uniqueStrings([
          ...(typeof claim?.statement === "string" ? [claim.statement] : []),
          ...(typeof failure?.mismatchSummary === "string" ? [failure.mismatchSummary] : []),
          ...scratchStatements,
          ...learningStatements,
          ...retrySignals,
        ]).slice(0, 20),
        commandRecords: extractCommandRecordsFromEvents({
          events,
          eventsPath,
          sessionExecutionReportPath: (await pathExists(sessionExecutionReportPath))
            ? sessionExecutionReportPath
            : undefined,
        }),
      })
    }
  }

  return {
    campaignID: input.campaignID,
    roundNumber: input.roundNumber,
    runID: path.basename(input.run.root),
    createdAt: nowISO(),
    finalStatus: input.finalStatus,
    summary: input.summary,
    materials: input.spec.materials.map((item) => item.path),
    capabilityPaths: uniqueStrings((input.spec.capabilities ?? []).flatMap((item) => item.referencePaths ?? [])),
    exploredRegions: graph.units.map((unit) => `${unit.id}: ${short(unit.goal, 140)}`),
    keySuccessPaths: claims
      .filter((item) => item.claimedSuccess === true)
      .map((item) => short(String(item.statement ?? ""), 220))
      .slice(-12),
    keyFailurePaths: failures.map((item) => short(String(item.mismatchSummary ?? ""), 220)).slice(-12),
    blockers: uniqueStrings(
      operationalContext
        .filter((item) => item.kind === "blocking_issue" || item.kind === "failed_path")
        .map((item) => item.statement),
    ).slice(0, 24),
    pendingPackageImpact: uniqueStrings(
      learningUnits
        .map((item) => (typeof item.statement === "string" ? item.statement : ""))
        .filter((item) => item.trim().length > 0),
    ).slice(0, 24),
    runVerificationSignal: input.runVerificationSignal,
    attempts: attempts.sort((left, right) =>
      left.unitID === right.unitID ? left.attempt - right.attempt : left.unitID.localeCompare(right.unitID),
    ),
  }
}

function buildCampaignRunTraceMarkdown(trace: LongTaskCampaignRunTrace) {
  const lines = [
    `# Run Trace ${trace.runID}`,
    "",
    `- round: ${trace.roundNumber}`,
    `- status: ${trace.finalStatus}`,
    `- summary: ${trace.summary}`,
    `- attempts: ${trace.attempts.length}`,
    "",
    "## Key Success Paths",
    "",
    ...(trace.keySuccessPaths.length ? trace.keySuccessPaths.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Key Failure Paths",
    "",
    ...(trace.keyFailurePaths.length ? trace.keyFailurePaths.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Blockers",
    "",
    ...(trace.blockers.length ? trace.blockers.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Attempt Timeline",
    "",
  ]

  if (!trace.attempts.length) {
    lines.push("- no attempts recorded", "")
    return lines.join("\n")
  }

  for (const attempt of trace.attempts) {
    lines.push(`### ${attempt.unitID} / attempt ${attempt.attempt}`, "")
    lines.push(`- title: ${attempt.unitTitle}`)
    if (typeof attempt.exitCode === "number") lines.push(`- exit_code: ${attempt.exitCode}`)
    if (attempt.claimStatement) lines.push(`- claim: ${attempt.claimStatement}`)
    if (attempt.failureSummary) lines.push(`- failure: ${attempt.failureSummary}`)
    lines.push(`- execute_dir: ${attempt.executeDir}`)
    lines.push("- command_outcomes:")
    if (!attempt.commandRecords.length) {
      lines.push("  - none")
    } else {
      for (const record of attempt.commandRecords) {
        const head = record.command ?? record.title ?? record.tool
        lines.push(`  - [${record.status}] ${record.tool}: ${short(head, 180)}`)
        if (record.error) lines.push(`    error: ${short(record.error, 180)}`)
      }
    }
    lines.push("")
  }

  return lines.join("\n")
}

function applyBudgetOverrides(base: LongTaskBudgets, overrides?: Partial<LongTaskBudgets>): LongTaskBudgets {
  return {
    ...base,
    ...overrides,
  }
}

async function ensureParentDirForPath(target: string) {
  await ensureDirectory(path.dirname(target))
}

async function resetGenericPath(target: string) {
  if (await pathExists(target)) {
    await rm(target, { recursive: true, force: true })
  }
  if (!path.extname(path.basename(target))) {
    await ensureDirectory(target)
  } else {
    await ensureParentDirForPath(target)
  }
}

async function snapshotSeedTarget(seed: LongTaskCampaignSeedTarget, snapshotPath: string) {
  if (seed.kind === "path_copy") {
    if (!(await pathExists(seed.targetPath))) {
      await resetGenericPath(snapshotPath)
      return
    }
    await rm(snapshotPath, { recursive: true, force: true })
    const stats = await lstat(seed.targetPath)
    if (stats.isDirectory()) {
      await cp(seed.targetPath, snapshotPath, { recursive: true, force: true })
      return
    }
    await ensureParentDirForPath(snapshotPath)
    await cp(seed.targetPath, snapshotPath, { force: true })
    return
  }

  const livePaths = experienceWorkspacePathsFromRoot(seed.targetPath, "manifest.md")
  const snapshot = await readExperienceWorkspace(livePaths)
  await writeExperienceWorkspaceSnapshot(snapshotPath, snapshot)
}

async function clearNonSeedEditablePaths(input: {
  baseSpec: LongTaskSpec
  baseSpecPath: string
  seedTargets: LongTaskCampaignSeedTarget[]
}) {
  const protectedTargets = new Set(input.seedTargets.map((item) => path.resolve(item.targetPath)))
  for (const editablePath of input.baseSpec.editablePaths ?? []) {
    const resolved = path.resolve(editablePath)
    if (protectedTargets.has(resolved)) continue
    if (isBaseSpecLocalRuntimePath(input.baseSpecPath, resolved)) continue
    await resetGenericPath(resolved)
  }
}

function isBaseSpecLocalRuntimePath(baseSpecPath: string, value: string) {
  const baseDir = path.dirname(path.resolve(baseSpecPath))
  const relative = path.relative(baseDir, path.resolve(value)).replace(/\\/g, "/")
  return (
    relative === "workspace" ||
    relative.startsWith("workspace/") ||
    relative === "expert-workspace" ||
    relative.startsWith("expert-workspace/") ||
    relative === "validation-expert-workspace" ||
    relative.startsWith("validation-expert-workspace/")
  )
}

function baseSpecLocalRuntimeRelativePath(baseSpecPath: string, value: string) {
  const baseDir = path.dirname(path.resolve(baseSpecPath))
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(baseDir, value)
  const relative = path.relative(baseDir, resolved).replace(/\\/g, "/")
  const isLocal =
    relative === "workspace" ||
    relative.startsWith("workspace/") ||
    relative === "expert-workspace" ||
    relative.startsWith("expert-workspace/") ||
    relative === "validation-expert-workspace" ||
    relative.startsWith("validation-expert-workspace/")
  return isLocal ? relative : undefined
}

function isExperienceWorkspaceRuntimeRelativePath(relative: string | undefined) {
  return (
    relative === "expert-workspace" ||
    relative?.startsWith("expert-workspace/") ||
    relative === "validation-expert-workspace" ||
    relative?.startsWith("validation-expert-workspace/")
  )
}

function toBlankEvalRuntimePath(baseSpecPath: string, value: string) {
  const relative = baseSpecLocalRuntimeRelativePath(baseSpecPath, value)
  return relative ? `./${relative}` : value
}

const BLANK_EVAL_RUNTIME_FILE_ARG_FLAGS = new Set([
  "--candidate",
  "--candidate-path",
  "--input",
  "--input-path",
  "--output",
  "--output-path",
])

function rewriteBlankEvalValidatorArgs(baseSpecPath: string, args: string[] | undefined) {
  if (!args?.length) return args
  const out: string[] = []
  let previousFlag: string | undefined
  for (const arg of args) {
    if (previousFlag && BLANK_EVAL_RUNTIME_FILE_ARG_FLAGS.has(previousFlag)) {
      out.push(toBlankEvalRuntimePath(baseSpecPath, arg))
      previousFlag = undefined
      continue
    }
    out.push(arg)
    previousFlag = arg.startsWith("--") ? arg : undefined
  }
  return out
}

function campaignRuntimeSeedTargets(campaignSpec: LongTaskCampaignSpec) {
  return campaignSpec.seedTargets.filter((seed) => !isBaseSpecLocalRuntimePath(campaignSpec.baseSpecPath, seed.targetPath))
}

function candidateManifestPaths(workspaceRoot: string) {
  return {
    manifestPath: path.join(workspaceRoot, "manifest.md"),
    changeLogPath: path.join(workspaceRoot, "change_log.md"),
    lessonsPath: path.join(workspaceRoot, "lessons", "failure_lessons.md"),
  }
}

function completionOnlyValidatorContracts(spec: LongTaskSpec) {
  return spec.validators.filter(
    (validator) => validator.required !== false && validator.placement === "completion_only",
  )
}

function isSurfaceValidatorContract(validator: LongTaskValidatorContract) {
  const descriptor = [
    validator.id,
    validator.title,
    validator.type === "script"
      ? validator.path
      : validator.type === "prompt_json"
        ? validator.prompt
        : `${validator.planPath} ${validator.skillRootPath}`,
  ]
    .join(" ")
    .toLowerCase()
  return (
    descriptor.includes("surface") ||
    descriptor.includes("generalization") ||
    descriptor.includes("workspace-layout") ||
    descriptor.includes("workspace layout") ||
    descriptor.includes("experience-layout") ||
    descriptor.includes("experience layout")
  )
}

function isLegacyBlankAgentValidatorContract(validator: LongTaskValidatorContract) {
  if (validator.id === "blank-agent-deployment") return true
  if (validator.type !== "script") return false
  return validator.path.toLowerCase().includes("run-blank-agent-task-deployment-acceptance")
}

function partitionCampaignFinalAcceptanceValidators(spec: LongTaskSpec) {
  const contracts = completionOnlyValidatorContracts(spec)
  const surfaceValidators = contracts.filter(isSurfaceValidatorContract)
  const legacyBlankAgentValidators = contracts.filter(
    (validator) => !isSurfaceValidatorContract(validator) && isLegacyBlankAgentValidatorContract(validator),
  )
  const productValidators = contracts.filter(
    (validator) => !isSurfaceValidatorContract(validator) && !isLegacyBlankAgentValidatorContract(validator),
  )
  return { contracts, surfaceValidators, legacyBlankAgentValidators, productValidators }
}

function shouldRunCampaignWorkers(roundNumber: number) {
  return roundNumber > 1
}

function shouldRunCampaignReviewer(roundNumber: number) {
  return roundNumber >= 1
}

function normalizeRoundSummaryForSignature(summary: string) {
  return summary.toLowerCase().replace(/\s+/g, " ").trim()
}

function isNoSignalRoundSummary(summary: string) {
  const normalized = normalizeRoundSummaryForSignature(summary)
  if (!normalized) return false
  return (
    normalized.includes("no structured signal") ||
    normalized.includes("no-structured-signal") ||
    normalized.includes("did not return a structured claim") ||
    normalized.includes("did not return structured claim") ||
    normalized.includes("no events/response")
  )
}

function noProgressRoundSignature(record: LongTaskCampaignRoundRecord) {
  if (record.finalStatus !== "stagnation_failure" && record.finalStatus !== "blocked_failure") return undefined
  if (record.failurePacketCount <= 0) return undefined
  if (record.learningUnitCount > 0) return undefined
  return [
    record.finalStatus,
    normalizeRoundSummaryForSignature(record.summary),
    `f:${record.failurePacketCount}`,
    `r:${record.retryLessonCount}`,
    `l:${record.learningUnitCount}`,
  ].join("|")
}

function detectRepeatedNoProgressLoop(records: LongTaskCampaignRoundRecord[], windowSize = 3) {
  if (records.length < windowSize) return undefined
  const recent = records.slice(-windowSize)
  const signature = noProgressRoundSignature(recent[0])
  if (!signature) return undefined
  if (!recent.every((record) => noProgressRoundSignature(record) === signature)) return undefined
  return {
    windowSize,
    signature,
    startRound: recent[0].roundNumber,
    endRound: recent[recent.length - 1].roundNumber,
  }
}

function detectConsecutiveNoSignalRounds(records: LongTaskCampaignRoundRecord[], threshold = 2) {
  if (threshold <= 0 || records.length < threshold) return undefined
  const recent = records.slice(-threshold)
  const allNoSignal = recent.every(
    (record) =>
      (record.finalStatus === "blocked_failure" || record.finalStatus === "stagnation_failure") &&
      isNoSignalRoundSummary(record.summary),
  )
  if (!allNoSignal) return undefined
  return {
    threshold,
    startRound: recent[0].roundNumber,
    endRound: recent[recent.length - 1].roundNumber,
  }
}

function buildCampaignFinalAcceptanceSpec(baseSpec: LongTaskSpec, pendingPackageRoot: string): LongTaskSpec {
  return {
    ...baseSpec,
    disableCompletionValidators: false,
    initialExpertContextPaths: [pendingPackageRoot],
    formalPackageRoots: [pendingPackageRoot],
    targetPaths: [
      {
        path: pendingPackageRoot,
        label: "pending expert package",
        role: "experience-workspace",
      },
    ],
    editablePaths: [],
    initialGraph: undefined,
  }
}

function buildCampaignBlankEvalSpec(input: {
  baseSpec: LongTaskSpec
  baseSpecPath: string
  pendingPackageRoot: string
  productValidators: LongTaskValidatorContract[]
}): LongTaskSpec {
  const productTargetPaths = (input.baseSpec.targetPaths ?? [])
    .filter((ref) => {
      if (ref.role === "experience-workspace") return false
      return !isExperienceWorkspaceRuntimeRelativePath(baseSpecLocalRuntimeRelativePath(input.baseSpecPath, ref.path))
    })
    .map((ref) => ({
      ...ref,
      path: toBlankEvalRuntimePath(input.baseSpecPath, ref.path),
    }))
  const productEditablePaths = (input.baseSpec.editablePaths ?? [])
    .filter((item) => !isExperienceWorkspaceRuntimeRelativePath(baseSpecLocalRuntimeRelativePath(input.baseSpecPath, item)))
    .map((item) => toBlankEvalRuntimePath(input.baseSpecPath, item))
  return {
    ...input.baseSpec,
    disableCompletionValidators: false,
    initialExpertContextPaths: [input.pendingPackageRoot],
    formalPackageRoots: [input.pendingPackageRoot],
    targetPaths: productTargetPaths,
    editablePaths: productEditablePaths.length ? productEditablePaths : productTargetPaths.map((item) => item.path),
    campaignPendingPackageRoot: undefined,
    campaignExplorationTreePath: undefined,
    campaignWorkingMemoryPath: undefined,
    campaignRoutingControlPath: undefined,
    validators: input.productValidators.map((validator) =>
      validator.type === "script"
        ? {
            ...validator,
            placement: "unit",
            args: rewriteBlankEvalValidatorArgs(input.baseSpecPath, validator.args),
          }
        : {
            ...validator,
            placement: "unit",
            inputFiles: validator.inputFiles?.candidatePath
              ? {
                  ...validator.inputFiles,
                  candidatePath: toBlankEvalRuntimePath(input.baseSpecPath, validator.inputFiles.candidatePath),
                }
              : validator.inputFiles,
          },
    ),
    initialGraph: undefined,
  }
}

function blankEvalValidatorResult(input: {
  runID?: string
  unitID?: string
  passed: boolean
  failureKind?: LongTaskValidatorResult["failureKind"]
  summary: string
  details: string[]
  evidenceRefs: string[]
  rawOutputPath?: string
}): LongTaskValidatorResult {
  return {
    id: `validator-${randomUUID().slice(0, 8)}`,
    runID: input.runID ?? "campaign-final-acceptance",
    unitID: input.unitID ?? "campaign-final-acceptance",
    attempt: 1,
    validatorID: "global-blank-agent-acceptance",
    validatorType: "script",
    createdAt: nowISO(),
    passed: input.passed,
    blocking: true,
    failureKind: input.failureKind,
    summary: input.summary,
    details: input.details,
    evidenceRefs: input.evidenceRefs,
    rawOutputPath: input.rawOutputPath,
  }
}

function syntheticCampaignFinalAcceptanceUnit(spec: LongTaskSpec, pendingPackageRoot: string): LongTaskWorkUnit {
  return {
    id: "campaign-final-acceptance",
    title: "Campaign Final Acceptance",
    goal: spec.goal,
    inputs: [pendingPackageRoot, ...spec.materials.map((item) => item.path)],
    dependsOn: [],
    expectedArtifacts: [pendingPackageRoot],
    claim: "The current pending expert package is ready for final blank-agent acceptance.",
    checkPlan: "Run all required completion validators against the current pending expert package.",
    validatorIDs: completionOnlyValidatorContracts(spec).map((validator) => validator.id),
    retryBudget: 1,
    status: "active",
    attemptCount: 1,
  }
}

async function ensureManifestPointsToLessons(workspaceRoot: string, lessonsRelativePath: string) {
  const { manifestPath } = candidateManifestPaths(workspaceRoot)
  if (!(await pathExists(manifestPath))) return
  const content = await readTextFile(manifestPath)
  if (content.includes(lessonsRelativePath)) return
  const marker = [
    "",
    "## Cross-Round Failure Lessons",
    "",
    `- Before execution, read \`${lessonsRelativePath}\` and apply the resolved failure-path guidance there.`,
  ].join("\n")
  await writeTextFile(manifestPath, `${content.trimEnd()}\n${marker}\n`)
}

async function appendCampaignChangeLog(workspaceRoot: string, roundRecord: LongTaskCampaignRoundRecord) {
  const { changeLogPath } = candidateManifestPaths(workspaceRoot)
  const line = `- ${roundRecord.roundID}: ${roundRecord.finalStatus} - ${roundRecord.summary}`
  if (!(await pathExists(changeLogPath))) {
    await writeTextFile(changeLogPath, `<!-- auto-evolve-role: change_log -->\n# Change Log\n\n${line}\n`)
    return
  }
  const content = await readTextFile(changeLogPath)
  if (content.includes(line)) return
  await writeTextFile(changeLogPath, `${content.trimEnd()}\n${line}\n`)
}

function extractStringField(raw: Record<string, unknown>, key: string) {
  return typeof raw[key] === "string" && raw[key].trim().length > 0 ? raw[key].trim() : undefined
}

function summarizeFailures(failures: Record<string, unknown>[]) {
  return failures
    .map((item) => {
      const mismatchSummary = extractStringField(item, "mismatchSummary") ?? "Unknown failure"
      const nextPriorityFix = extractStringField(item, "nextPriorityFix")
      const suspectedCauses = Array.isArray(item.suspectedCauses)
        ? item.suspectedCauses.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : []
      const parts = [`- ${short(mismatchSummary, 240)}`]
      if (suspectedCauses.length) {
        parts.push(
          `  causes: ${suspectedCauses
            .slice(0, 3)
            .map((value) => short(value, 120))
            .join(" | ")}`,
        )
      }
      if (nextPriorityFix) {
        parts.push(`  next_fix: ${short(nextPriorityFix, 180)}`)
      }
      return parts.join("\n")
    })
    .slice(0, 12)
}

function summarizeRetryLessons(lessons: Record<string, unknown>[]) {
  return lessons
    .map((item) => {
      const whatFailed = extractStringField(item, "whatFailed") ?? "Unknown retry lesson"
      const nextAttemptStrategy = Array.isArray(item.nextAttemptStrategy)
        ? item.nextAttemptStrategy.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          )
        : []
      return `- ${short(whatFailed, 220)}${nextAttemptStrategy.length ? ` -> ${short(nextAttemptStrategy[0], 180)}` : ""}`
    })
    .slice(0, 12)
}

function summarizeLearningUnits(units: Record<string, unknown>[]) {
  return units
    .map((item) => extractStringField(item, "statement"))
    .filter((item): item is string => Boolean(item))
    .map((item) => `- ${short(item, 220)}`)
    .slice(0, 12)
}

function summarizeBlankAgentSystemBypasses(input: {
  failures: Record<string, unknown>[]
  retryLessons: Record<string, unknown>[]
  learningUnits: Record<string, unknown>[]
}) {
  const merged = new Map<string, string | undefined>()
  const add = (issueRaw: string | undefined, bypassRaw?: string) => {
    const issue = issueRaw?.trim()
    if (!issue) return
    if (!isBlankAgentExecutionContext(issue) || !isSystemRuntimeSignal(issue)) return
    const key = normalizeCompactStatement(issue).toLowerCase()
    const bypass = bypassRaw?.trim()
    const current = merged.get(key)
    if (current) {
      if (!current && bypass) merged.set(key, normalizeCompactStatement(bypass))
      return
    }
    merged.set(key, bypass ? normalizeCompactStatement(bypass) : undefined)
  }

  for (const item of input.failures) {
    const unitID = extractStringField(item, "unitID") ?? ""
    const mismatchSummary = extractStringField(item, "mismatchSummary")
    const nextPriorityFix = extractStringField(item, "nextPriorityFix")
    const suspectedCauses = Array.isArray(item.suspectedCauses)
      ? item.suspectedCauses.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : []
    const context = [unitID, mismatchSummary ?? "", ...suspectedCauses, nextPriorityFix ?? ""].join(" | ")
    if (!isBlankAgentExecutionContext(context)) continue
    add(mismatchSummary, nextPriorityFix)
    for (const cause of suspectedCauses) add(cause, nextPriorityFix)
  }

  for (const item of input.retryLessons) {
    const whatFailed = extractStringField(item, "whatFailed")
    const whyFailed = Array.isArray(item.whyFailed)
      ? item.whyFailed.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : []
    const doNotRepeat = Array.isArray(item.doNotRepeat)
      ? item.doNotRepeat.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : []
    const nextAttemptStrategy = Array.isArray(item.nextAttemptStrategy)
      ? item.nextAttemptStrategy.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : []
    const context = [whatFailed ?? "", ...whyFailed, ...doNotRepeat, ...nextAttemptStrategy].join(" | ")
    if (!isBlankAgentExecutionContext(context)) continue
    add(whatFailed, nextAttemptStrategy[0])
    for (const reason of whyFailed) add(reason, nextAttemptStrategy[0])
    for (const reason of doNotRepeat) add(reason, nextAttemptStrategy[0])
  }

  for (const item of input.learningUnits) {
    const statement = extractStringField(item, "statement")
    add(statement)
  }

  return Array.from(merged.entries())
    .map(([issue, bypass]) => `- ${short(issue, 220)}${bypass ? ` -> bypass: ${short(bypass, 180)}` : ""}`)
    .slice(0, 12)
}

function buildRoundSummaryMarkdown(input: {
  roundNumber: number
  mode: string
  finalStatus: LongTaskRunStatus
  summary: string
  runVerificationSignal?: LongTaskCampaignRunTrace["runVerificationSignal"]
  roundClosure?: LongTaskCampaignRoundRecord["roundClosure"]
  gateFailureKind?: LongTaskCampaignRoundRecord["gateFailureKind"]
  gateFailureSummary?: string
  finalAcceptanceSignal?: LongTaskCampaignRoundRecord["finalAcceptanceSignal"]
  failures: Record<string, unknown>[]
  retryLessons: Record<string, unknown>[]
  learningUnits: Record<string, unknown>[]
}) {
  const failureLines = summarizeFailures(input.failures)
  const retryLines = summarizeRetryLessons(input.retryLessons)
  const learningLines = summarizeLearningUnits(input.learningUnits)

  return [
    `# ${roundID(input.roundNumber)} Summary`,
    "",
    `- mode: ${input.mode}`,
    `- status: ${input.finalStatus}`,
    `- summary: ${input.summary}`,
    `- units_converged: ${input.runVerificationSignal?.unitsConverged ?? "unknown"}`,
    `- completion_gate_mode: ${input.runVerificationSignal?.completionGateMode ?? "unknown"}`,
    `- completion_gate_passed: ${input.runVerificationSignal?.completionGatePassed ?? "unknown"}`,
    `- round_closure: ${input.roundClosure ?? "unknown"}`,
    `- gate_failure_kind: ${input.gateFailureKind ?? "none"}`,
    `- gate_failure_summary: ${input.gateFailureSummary ?? "none"}`,
    `- final_acceptance_executed: ${input.finalAcceptanceSignal?.executed ?? false}`,
    `- final_acceptance_passed: ${input.finalAcceptanceSignal?.passed ?? false}`,
    `- final_acceptance_failed_validators: ${input.finalAcceptanceSignal?.failedValidatorIDs.join(", ") || "none"}`,
    `- final_acceptance_feedback_path: ${input.finalAcceptanceSignal?.feedbackPath ?? "none"}`,
    `- failure_packets: ${input.failures.length}`,
    `- retry_lessons: ${input.retryLessons.length}`,
    `- learning_units: ${input.learningUnits.length}`,
    "",
    "## Key Failure Paths",
    "",
    ...(failureLines.length ? failureLines : ["- none"]),
    "",
    "## Retry Strategy Carryover",
    "",
    ...(retryLines.length ? retryLines : ["- none"]),
    "",
    "## New Learning Units",
    "",
    ...(learningLines.length ? learningLines : ["- none"]),
    "",
  ].join("\n")
}

function finalizeRoundRecordWithAcceptance(input: {
  roundRecord: LongTaskCampaignRoundRecord
  finalAcceptance?: {
    passed: boolean
  failureKind?: "product_failure" | "infrastructure_failure" | "dataset_failure"
    summary: string
    validatorResults: Array<{
      validatorID: string
      passed: boolean
    }>
  }
  feedbackPath?: string
}) {
  if (!input.finalAcceptance) {
    return {
      ...input.roundRecord,
      finalAcceptanceSignal: {
        executed: false,
        passed: false,
        failedValidatorIDs: [],
        feedbackPath: input.feedbackPath,
      },
    } satisfies LongTaskCampaignRoundRecord
  }
  const failedValidatorIDs = input.finalAcceptance.validatorResults
    .filter((item) => !item.passed)
    .map((item) => item.validatorID)
  const infrastructureFailure = input.finalAcceptance.failureKind === "infrastructure_failure"
  const datasetFailure = input.finalAcceptance.failureKind === "dataset_failure"
  return {
    ...input.roundRecord,
    summary: input.finalAcceptance.summary,
    roundClosure: input.finalAcceptance.passed
      ? "closed_success"
      : infrastructureFailure
        ? "closed_infra_failure"
        : datasetFailure
          ? "closed_dataset_failure"
        : "closed_repairable",
    gateFailureKind: input.finalAcceptance.passed
      ? undefined
      : infrastructureFailure
        ? "infrastructure_failure"
        : datasetFailure
          ? "dataset_failure"
        : "final_acceptance_failed",
    gateFailureSummary: input.finalAcceptance.passed ? undefined : input.finalAcceptance.summary,
    finalAcceptanceSignal: {
      executed: true,
      passed: input.finalAcceptance.passed,
      failureKind: input.finalAcceptance.failureKind,
      failedValidatorIDs,
      feedbackPath: input.feedbackPath,
    },
  } satisfies LongTaskCampaignRoundRecord
}

function buildCampaignLessonsMarkdown(input: {
  title: string
  latestRound: number
  records: LongTaskCampaignRoundRecord[]
  failures: Record<string, unknown>[]
  retryLessons: Record<string, unknown>[]
  learningUnits: Record<string, unknown>[]
}) {
  const latestRecord = input.records[input.records.length - 1]
  const failureLines = summarizeFailures(input.failures)
  const retryLines = summarizeRetryLessons(input.retryLessons)
  const learningLines = summarizeLearningUnits(input.learningUnits)
  const systemBypassLines = summarizeBlankAgentSystemBypasses({
    failures: input.failures,
    retryLessons: input.retryLessons,
    learningUnits: input.learningUnits,
  })

  return [
    "<!-- auto-evolve-role: failure_lessons -->",
    "# Cross-Round Failure Lessons",
    "",
    `Status: updated through ${roundID(input.latestRound)}`,
    "",
    "## Purpose",
    "",
    "- This file accumulates failed paths across campaign rounds.",
    "- A deployment-time blank agent should read this file before following the execution checklist.",
    "- Only stable, task-relevant lessons from actual failed paths should remain here.",
    "",
    "## Latest Campaign State",
    "",
    `- title: ${input.title}`,
    `- rounds_completed: ${input.records.length}`,
    `- latest_status: ${latestRecord?.finalStatus ?? "unknown"}`,
    `- latest_summary: ${latestRecord?.summary ?? "none"}`,
    "",
    "## Stable Failed-Path Lessons",
    "",
    ...(failureLines.length ? failureLines : ["- none yet"]),
    "",
    "## Retry Guidance That Emerged From Failures",
    "",
    ...(retryLines.length ? retryLines : ["- none yet"]),
    "",
    "## Blank-Agent Execution System Blockers and Bypasses",
    "",
    "- Keep only system-level blockers observed during blank-agent execution and concrete bypass guidance for next round.",
    "",
    ...(systemBypassLines.length ? systemBypassLines : ["- none yet"]),
    "",
    "## Generalized Learning That Survived Across Rounds",
    "",
    ...(learningLines.length ? learningLines : ["- none yet"]),
    "",
    "## Round Chronology",
    "",
    ...input.records.map(
      (record) =>
        `- ${record.roundID}: ${record.finalStatus} | closure=${record.roundClosure ?? "unknown"} | ${record.summary} | failures=${record.failurePacketCount} retry_lessons=${record.retryLessonCount} learning_units=${record.learningUnitCount}`,
    ),
    "",
  ].join("\n")
}

function buildFailurePacketsCarryoverMarkdown(input: {
  title: string
  latestRound: number
  records: LongTaskCampaignRoundRecord[]
  failures: Record<string, unknown>[]
}) {
  const latestRecord = input.records[input.records.length - 1]
  const failureLines = summarizeFailures(input.failures)

  return [
    "<!-- auto-evolve-role: carryover_failure_packets -->",
    "# Carryover Failure Packets",
    "",
    `Status: updated through ${roundID(input.latestRound)}`,
    "",
    "## Purpose",
    "",
    "- Use this file only for stable failed-path lessons that should shape the next round plan.",
    "- This carryover excludes retry guidance and generalized learning.",
    "",
    "## Latest Campaign State",
    "",
    `- title: ${input.title}`,
    `- rounds_completed: ${input.records.length}`,
    `- latest_status: ${latestRecord?.finalStatus ?? "unknown"}`,
    `- latest_summary: ${latestRecord?.summary ?? "none"}`,
    "",
    "## Stable Failed-Path Lessons",
    "",
    ...(failureLines.length ? failureLines : ["- none yet"]),
    "",
  ].join("\n")
}

function buildRetryLessonsCarryoverMarkdown(input: {
  title: string
  latestRound: number
  records: LongTaskCampaignRoundRecord[]
  retryLessons: Record<string, unknown>[]
}) {
  const latestRecord = input.records[input.records.length - 1]
  const retryLines = summarizeRetryLessons(input.retryLessons)

  return [
    "<!-- auto-evolve-role: carryover_retry_lessons -->",
    "# Carryover Retry Lessons",
    "",
    `Status: updated through ${roundID(input.latestRound)}`,
    "",
    "## Purpose",
    "",
    "- Use this file only for retry strategy guidance distilled from prior failed attempts.",
    "- This carryover excludes failed-path catalogs and generalized learning.",
    "",
    "## Latest Campaign State",
    "",
    `- title: ${input.title}`,
    `- rounds_completed: ${input.records.length}`,
    `- latest_status: ${latestRecord?.finalStatus ?? "unknown"}`,
    `- latest_summary: ${latestRecord?.summary ?? "none"}`,
    "",
    "## Retry Guidance",
    "",
    ...(retryLines.length ? retryLines : ["- none yet"]),
    "",
  ].join("\n")
}

function buildLearningUnitsCarryoverMarkdown(input: {
  title: string
  latestRound: number
  records: LongTaskCampaignRoundRecord[]
  learningUnits: Record<string, unknown>[]
}) {
  const latestRecord = input.records[input.records.length - 1]
  const learningLines = summarizeLearningUnits(input.learningUnits)

  return [
    "<!-- auto-evolve-role: carryover_learning_units -->",
    "# Carryover Learning Units",
    "",
    `Status: updated through ${roundID(input.latestRound)}`,
    "",
    "## Purpose",
    "",
    "- Use this file only for generalized learning that survived across prior rounds.",
    "- This carryover excludes failed-path catalogs and retry-specific guidance.",
    "",
    "## Latest Campaign State",
    "",
    `- title: ${input.title}`,
    `- rounds_completed: ${input.records.length}`,
    `- latest_status: ${latestRecord?.finalStatus ?? "unknown"}`,
    `- latest_summary: ${latestRecord?.summary ?? "none"}`,
    "",
    "## Generalized Learning",
    "",
    ...(learningLines.length ? learningLines : ["- none yet"]),
    "",
  ].join("\n")
}

async function syncLessonsMirror(input: {
  lessonsContent: string
  workspaceTargetPath: string
  lessonsRelativePath: string
  addManifestPointer: boolean
  roundRecord: LongTaskCampaignRoundRecord
}) {
  const lessonPath = path.join(input.workspaceTargetPath, ...input.lessonsRelativePath.split("/"))
  await writeTextFile(lessonPath, input.lessonsContent)
  if (input.addManifestPointer) {
    await ensureManifestPointsToLessons(input.workspaceTargetPath, input.lessonsRelativePath)
  }
  await appendCampaignChangeLog(input.workspaceTargetPath, input.roundRecord)
}

async function harvestRound(input: {
  cwd: string
  campaignID: string
  campaignSpec: LongTaskCampaignSpec
  baseSpec: LongTaskSpec
  roundNumber: number
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
  runResult: Awaited<ReturnType<typeof runLongTask>>
  seedTargets: LongTaskCampaignSeedTarget[]
}) {
  const runDir = input.runResult.runDir
  const failurePacketsPath = path.join(runDir, "failure_packets.jsonl")
  const retryLessonsPath = path.join(runDir, "retry_lessons.jsonl")
  const learningUnitsPath = path.join(runDir, "learning_units.jsonl")
  const runPaths = resolveExistingLongTaskRun(input.cwd, input.runResult.runID).run

  const failurePackets = await readJsonLinesIfExists<Record<string, unknown>>(failurePacketsPath)
  const retryLessons = await readJsonLinesIfExists<Record<string, unknown>>(retryLessonsPath)
  const learningUnits = await readJsonLinesIfExists<Record<string, unknown>>(learningUnitsPath)
  const operationalContext = await readOperationalContext(runPaths)
  const runTrace = await buildCampaignRunTrace({
    campaignID: input.campaignID,
    roundNumber: input.roundNumber,
    run: runPaths,
    spec: input.baseSpec,
    finalStatus: input.runResult.status,
    summary: input.runResult.summary.summary,
    runVerificationSignal: input.runResult.summary.verificationSignal,
  })
  const runTraceDigest = buildRunTraceDigest(runTrace)

  const roundSummary = buildRoundSummaryMarkdown({
    roundNumber: input.roundNumber,
    mode: input.campaignSpec.mode,
    finalStatus: input.runResult.status,
    summary: input.runResult.summary.summary,
    runVerificationSignal: input.runResult.summary.verificationSignal,
    roundClosure: input.runResult.summary.roundClosure,
    gateFailureKind: input.runResult.summary.gateFailureKind,
    gateFailureSummary: input.runResult.summary.gateFailureSummary,
    failures: failurePackets,
    retryLessons,
    learningUnits,
  })

  await writeTextFile(input.roundPaths.roundSummaryPath, roundSummary)
  await writeJsonFile(input.roundPaths.runTraceJsonPath, runTrace)
  await writeJsonFile(input.roundPaths.runTraceDigestPath, runTraceDigest)
  await writeTextFile(input.roundPaths.runTraceMarkdownPath, buildCampaignRunTraceMarkdown(runTrace))

  const snapshotPaths: LongTaskCampaignRoundRecord["snapshotPaths"] = []
  for (const seed of input.seedTargets) {
    const snapshotPath = path.join(
      input.roundPaths.snapshotsRoot,
      path.basename(seed.targetPath) || `target-${snapshotPaths.length + 1}`,
    )
    await snapshotSeedTarget(seed, snapshotPath)
    snapshotPaths.push({
      targetPath: seed.targetPath,
      snapshotPath,
      kind: seed.kind ?? "experience_workspace",
    })
  }

  return {
    roundRecord: {
      roundNumber: input.roundNumber,
      roundID: roundID(input.roundNumber),
      roundSpecPath: input.roundPaths.generatedSpecPath,
      runTracePath: input.roundPaths.runTraceJsonPath,
      sourceRunID: input.runResult.runID,
      sourceRunDir: input.runResult.runDir,
      finalStatus: input.runResult.status,
      summary: input.runResult.summary.summary,
      failurePacketCount: failurePackets.length,
      retryLessonCount: retryLessons.length,
      learningUnitCount: learningUnits.length,
      runVerificationSignal: input.runResult.summary.verificationSignal,
      roundClosure: input.runResult.summary.roundClosure,
      gateFailureKind: input.runResult.summary.gateFailureKind,
      gateFailureSummary: input.runResult.summary.gateFailureSummary,
      roundSummaryPath: input.roundPaths.roundSummaryPath,
      snapshotPaths,
      createdAt: nowISO(),
    } satisfies LongTaskCampaignRoundRecord,
    failurePackets,
    retryLessons,
    learningUnits,
    operationalContext,
    runTrace,
    runTraceDigest,
  }
}

export function buildGeneratedRoundSpec(input: {
  baseSpec: LongTaskSpec
  campaignSpec: LongTaskCampaignSpec
  roundNumber: number
  pendingPackageRoot: string
  explorationTreePath: string
  workingMemoryPath: string
  routingControlPath: string
  dispatchTicketsPath: string
  blankAgentAcceptanceDiagnosisPath: string
}): LongTaskSpec {
  const isFirstRound = input.roundNumber === 1
  const roundBudgets = applyBudgetOverrides(input.baseSpec.budgets, input.campaignSpec.roundBudgetOverrides)
  // 新配置已冻结训练预算，禁止轮次覆盖悄悄改变执行口径。
  if (input.baseSpec.protocolTraining && Object.keys(input.baseSpec.protocolTraining.budgets).some((key) =>
    roundBudgets[key as keyof LongTaskBudgets] !== input.baseSpec.protocolTraining!.budgets[key as keyof LongTaskBudgets])) {
    throw new Error("Campaign round budget overrides conflict with frozen protocol training")
  }
  const roundValidators = input.baseSpec.validators.map((validator) => {
    const descriptor =
      `${validator.id} ${validator.title} ${validator.type === "script" ? validator.path : ""}`.toLowerCase()
    const isLikelyFinalDeploymentGate =
      descriptor.includes("blank-agent") ||
      descriptor.includes("deployment-acceptance") ||
      descriptor.includes("single-session deployment")
    if (!isLikelyFinalDeploymentGate || validator.required === false) return validator
    return {
      ...validator,
      required: false,
    }
  })
  const staticBaseContext = collectStaticBaseContextPaths(input.baseSpec)
  const preservePreseededEditablePaths = uniqueStrings(
    input.campaignSpec.seedTargets
      .filter((seed) => (seed.kind ?? "experience_workspace") === "experience_workspace")
      .map((seed) => seed.targetPath),
  )

  return {
    ...input.baseSpec,
    // 内层也必须知道验收执行模式，避免修复不存在的工具故障。
    goal: input.baseSpec.protocolAuthorContext
      ? [input.baseSpec.goal, ...protocolAuthorLines(input.baseSpec.protocolAuthorContext, false)].join("\n")
      : input.baseSpec.blankEvalExecutor?.kind === "single_turn_http"
      ? [input.baseSpec.goal, ...blankExecutorProtocolLines("single_turn_http"),
          "Author/planner/executor may use their original tools to derive a solution and revise Skill; the no-tool restriction applies ONLY to blank acceptance.",
          "The host campaign controller launches blank acceptance after candidate preparation. Do not launch a second blank evaluation or repair a zero-tool-call condition yourself.",
          "Earlier routing blockers or memories demanding blank-agent tool calls conflict with this execution contract. Diagnose actual product failures and revise reusable guidance; do not claim a fresh acceptance pass without host evidence.",
        ].join("\n")
      : input.baseSpec.goal,
    title: `${input.campaignSpec.title}-${roundID(input.roundNumber)}`,
    validators: roundValidators,
    disableCompletionValidators: isFirstRound,
    initialExpertContextPaths: uniqueStrings([
      input.pendingPackageRoot,
      input.explorationTreePath,
      input.routingControlPath,
      input.dispatchTicketsPath,
      input.blankAgentAcceptanceDiagnosisPath,
      ...staticBaseContext,
    ]),
    initialGraph:
      isFirstRound && input.baseSpec.initialGraph
        ? {
            ...input.baseSpec.initialGraph,
            completion_validator_ids: [],
          }
        : undefined,
    campaignPendingPackageRoot: input.pendingPackageRoot,
    campaignExplorationTreePath: input.explorationTreePath,
    campaignWorkingMemoryPath: input.workingMemoryPath,
    campaignRoutingControlPath: input.routingControlPath,
    preservePreseededEditablePaths,
    budgets: roundBudgets,
    notes: [
      input.baseSpec.notes,
      `campaign_mode=${input.campaignSpec.mode}`,
      `campaign_round=${input.roundNumber}/${input.campaignSpec.maxRounds}`,
      "This round is generated by the long-task campaign controller. Every round must leave durable learning artifacts and promote stable operational context for later rounds.",
      "Planner must obey routing control and should rebuild the graph from current package/tree/routing after round 1.",
      "Planner must treat blank-agent acceptance diagnosis as the highest-priority input for the final acceptance goal when it contains findings.",
    ]
      .filter(Boolean)
      .join(" "),
  }
}

async function runCampaignSuggestionTask(input: {
  trainingRole?: TrainingRole
  cwd: string
  baseSpec: LongTaskSpec
  title: string
  prompt: string
  selectionPhase: ModelPhase
  execution?: ExecutionSpec
  referencePaths: string[]
  attachedFiles?: string[]
  permissionReadPaths: string[]
  permissionEditPaths?: string[]
  stageDir: string
  phase: string
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
  onPulse?: OpencodeTaskInput["onPulse"]
}) {
  const config = await loadConfig(input.cwd)
  await verifyTraining(input.baseSpec, input.cwd, config)
  if (input.baseSpec.protocolTraining && !input.trainingRole) throw new Error("Explicit campaign training role required")
  const selection = resolveModelSelection(config, input.selectionPhase,
    input.trainingRole ? trainingExecution(input.baseSpec, input.trainingRole, input.execution) : input.execution)
  const task = await runProtocolTrainingTask({ enabled: Boolean(input.baseSpec.protocolPlugins), stageDir: input.stageDir,
    role: input.trainingRole ?? input.phase }, {
    cwd: input.cwd,
    config,
    title: input.title,
    ...(input.baseSpec.protocolTraining && input.trainingRole ? { runtimeBudget: trainingRuntimeBudget(input.baseSpec, input.trainingRole) } : {}),
    prompt: input.prompt,
    // 新协议允许无id/taskFamily；此请求并未接收campaignSpec。
    concurrencyScope: `long-task-campaign:${input.baseSpec.id ?? input.baseSpec.taskFamily ??
      (input.baseSpec.protocolPlugins ? input.baseSpec.title : (input as unknown as { campaignSpec: LongTaskCampaignSpec }).campaignSpec.title)}`,
    referencePaths: uniqueStrings(input.referencePaths),
    attachedFiles: uniqueStrings(input.attachedFiles ?? []),
    permissionReadPaths: uniqueStrings(input.permissionReadPaths),
    permissionEditPaths: uniqueStrings(input.permissionEditPaths ?? []),
    model: selection.model,
    agent: selection.agent,
    variant: selection.variant,
    runtimeScope: input.runtimeScope,
    onSpawn: input.onActivation,
    onPulse: input.onPulse,
    live: {
      stageDir: input.stageDir,
      phase: input.phase,
    },
  }, runOpencodeTask)
  const artifactPaths = await writeTaskArtifacts(input.stageDir, task, {
    phase: input.phase,
  })
  return {
    task,
    artifactPaths,
    parsed: extractJsonObject(task.result.responseText),
  }
}

function normalizeWorkerSuggestion(input: {
  roundNumber: number
  role: LongTaskCampaignWorkerRole
  parsed: Record<string, unknown> | undefined
  responsePath: string
  suggestionPath: string
}): LongTaskCampaignWorkerSuggestion {
  return {
    id: `worker-${randomUUID().slice(0, 8)}`,
    roundNumber: input.roundNumber,
    role: input.role,
    createdAt: nowISO(),
    summary:
      typeof input.parsed?.summary === "string" && input.parsed.summary.trim().length > 0
        ? input.parsed.summary.trim()
        : `${input.role} produced no structured summary.`,
    findings: normalizeStringArray(input.parsed?.findings),
    memoryAdvice: normalizeStringArray(input.parsed?.memory_advice),
    packageAdvice: normalizeStringArray(input.parsed?.package_advice),
    explorationAdvice: normalizeStringArray(input.parsed?.exploration_advice),
    refs: uniqueStrings([input.responsePath, ...normalizeStringArray(input.parsed?.refs)]),
    responsePath: input.responsePath,
    suggestionPath: input.suggestionPath,
  }
}

function normalizeReviewerSuggestion(input: {
  roundNumber: number
  parsed: Record<string, unknown> | undefined
  responsePath: string
}): LongTaskCampaignReviewSuggestion {
  return {
    id: `review-${randomUUID().slice(0, 8)}`,
    roundNumber: input.roundNumber,
    createdAt: nowISO(),
    readyForFinalAcceptance:
      typeof input.parsed?.ready_for_final_acceptance === "boolean" ? input.parsed.ready_for_final_acceptance : false,
    summary:
      typeof input.parsed?.summary === "string" && input.parsed.summary.trim().length > 0
        ? input.parsed.summary.trim()
        : "Reviewer produced no structured summary.",
    reasons: normalizeStringArray(input.parsed?.reasons),
    nextAttentionAreas: normalizeStringArray(input.parsed?.next_attention_areas),
    refs: uniqueStrings([input.responsePath, ...normalizeStringArray(input.parsed?.refs)]),
    responsePath: input.responsePath,
  }
}

async function resolvePendingPackageEntryFile(pendingCurrentRoot: string): Promise<string | null> {
  const contractPath = path.join(pendingCurrentRoot, "surface_contract.json")
  try {
    if (!(await pathExists(contractPath))) return null
    const contract = await readJsonFile<{ entry?: string }>(contractPath)
    if (!contract || typeof contract.entry !== "string" || !contract.entry.trim()) return null
    const entryPath = path.join(pendingCurrentRoot, ...contract.entry.trim().split("/"))
    if (await pathExists(entryPath)) return contract.entry.trim()
    return null
  } catch {
    return null
  }
}

export async function hasEvolvedPendingPackage(pendingCurrentRoot: string, allowReadmeOnly = false, declaredSkill?: SkillBinding): Promise<boolean> {
  if (declaredSkill) return hasCandidate(pendingCurrentRoot, declaredSkill)
  // Check surface_contract.json first to find where the entry file should be
  const entryRel = await resolvePendingPackageEntryFile(pendingCurrentRoot)
  if (entryRel) return true
  // Fallback: old-style package with manifest.md at root
  if (await pathExists(path.join(pendingCurrentRoot, "manifest.md"))) return true
  // 单次HTTP插件接受经表面检查的README包，默认晋级规则不变。
  if (allowReadmeOnly && await pathExists(path.join(pendingCurrentRoot, "README.md"))) return true
  return false
}

async function prepareCampaignRoundState(input: {
  baseSpec: LongTaskSpec
  campaignSpec: LongTaskCampaignSpec
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
}) {
  const runtimeSeedTargets = campaignRuntimeSeedTargets(input.campaignSpec)
  await clearNonSeedEditablePaths({
    baseSpec: input.baseSpec,
    baseSpecPath: input.campaignSpec.baseSpecPath,
    seedTargets: runtimeSeedTargets,
  })
  const primarySeed = primaryExperienceWorkspaceSeedTarget(runtimeSeedTargets)
  for (const seedTarget of runtimeSeedTargets) {
    if (seedTarget.resetOnStart === false) continue
    if (
      primarySeed &&
      seedTarget.targetPath === primarySeed.targetPath &&
      (seedTarget.kind ?? "experience_workspace") === "experience_workspace" &&
      (await hasEvolvedPendingPackage(input.campaignPaths.pendingCurrentRoot, input.baseSpec.blankEvalExecutor?.kind === "single_turn_http", input.baseSpec.protocolAuthorContext?.skill))
    ) {
      await copyExperienceWorkspaceRoot(input.campaignPaths.pendingCurrentRoot, seedTarget.targetPath,
        { declaredSkill: input.baseSpec.protocolAuthorContext?.skill })
      continue
    }
    if ((seedTarget.kind ?? "experience_workspace") === "experience_workspace") {
      await copyExperienceWorkspaceRoot(seedTarget.seedPath, seedTarget.targetPath,
        { declaredSkill: primarySeed?.targetPath === seedTarget.targetPath ? input.baseSpec.protocolAuthorContext?.skill : undefined })
      continue
    }
    await copyPathIntoTarget(seedTarget.seedPath, seedTarget.targetPath)
  }
}

async function collectCarryoverContext(input: {
  baseSpec: LongTaskSpec
  campaignSpec: LongTaskCampaignSpec
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  history: LongTaskCampaignRoundRecord[]
}) {
  const carryover = input.campaignSpec.carryover ?? DEFAULT_LONG_TASK_CAMPAIGN_CARRYOVER
  const candidates: string[] = []

  if (carryover.includeCampaignOperationalMemory) {
    candidates.push(input.campaignPaths.campaignOperationalMemoryPath)
  }

  if (carryover.includeCampaignSeedContext) {
    candidates.push(input.campaignPaths.campaignSeedContextPath)
  }

  if (carryover.includeFailurePackets) {
    candidates.push(input.campaignPaths.carryoverFailurePacketsPath)
    candidates.push(input.campaignPaths.aggregatedFailurePacketsPath)
  }

  if (carryover.includeRetryLessons) {
    candidates.push(input.campaignPaths.carryoverRetryLessonsPath)
    candidates.push(input.campaignPaths.aggregatedRetryLessonsPath)
  }

  if (carryover.includeLearningUnits) {
    candidates.push(input.campaignPaths.carryoverLearningUnitsPath)
    candidates.push(input.campaignPaths.aggregatedLearningUnitsPath)
  }

  if (carryover.includeRoundSummaries) {
    for (const record of input.history.slice(-carryover.recentRoundSummaryCount)) {
      candidates.push(record.roundSummaryPath)
    }
  }

  const resolved: string[] = []
  for (const candidate of uniqueStrings(candidates)) {
    if (await pathExists(candidate)) {
      resolved.push(candidate)
    }
  }

  return resolved
}

async function readLatestReviewerSuggestionPath(campaignPaths: ReturnType<typeof longTaskCampaignPaths>) {
  if (!(await pathExists(campaignPaths.campaignReviewSuggestionsPath))) return undefined
  const raw = (await readTextFile(campaignPaths.campaignReviewSuggestionsPath)).trim()
  if (!raw) return undefined
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) return undefined
  try {
    const last = JSON.parse(lines[lines.length - 1]) as LongTaskCampaignReviewSuggestion
    return last.responsePath
  } catch {
    return undefined
  }
}

async function seedRoundPendingPackageFromCurrent(input: {
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
  allowReadmeOnly?: boolean
  declaredSkill?: SkillBinding
}) {
  if (!(await hasEvolvedPendingPackage(input.campaignPaths.pendingCurrentRoot, input.allowReadmeOnly, input.declaredSkill))) {
    await ensureDirectory(input.roundPaths.pendingPackageSnapshotRoot)
    return
  }
  await copyExperienceWorkspaceRoot(input.campaignPaths.pendingCurrentRoot, input.roundPaths.pendingPackageSnapshotRoot,
    { declaredSkill: input.declaredSkill })
}

async function seedRoundExplorationTreeFromCurrent(input: {
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
}) {
  const currentTree = await readLongTaskCampaignExplorationTree(input.campaignPaths)
  await writeJsonFile(input.roundPaths.explorationTreeDraftPath, currentTree)
}

export async function synchronizeProtocolLeadCandidate(input: {
  enabled: boolean
  currentRoot: string
  draftRoot: string
  skill?: SkillBinding
}) {
  if (!input.enabled) return
  if (!input.skill) throw new Error("Protocol Lead requires declared Skill binding")
  // 只同步Skill，保留本轮新收获的探索树和路由。
  if (await hasCandidate(input.currentRoot, input.skill)) {
    await copyCandidate(input.currentRoot, input.draftRoot, input.skill)
  } else if (await hasCandidate(input.draftRoot, input.skill)) {
    throw new Error("Current candidate missing; stale Lead draft reuse blocked")
  }
}

async function seedRoundRoutingControlFromCurrent(input: {
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
}) {
  const currentRoutingControl = await readLongTaskCampaignRoutingControl(input.campaignPaths)
  await writeJsonFile(input.roundPaths.routingControlDraftPath, currentRoutingControl)
}

async function runCampaignWorkers(input: {
  cwd: string
  campaignID: string
  campaignSpec: LongTaskCampaignSpec
  baseSpec: LongTaskSpec
  roundNumber: number
  runTracePath: string
  runTraceDigestPath: string
  pendingPackageRoot: string
  explorationTreePath: string
  workingMemoryPath: string
  routingControlPath: string
  dispatchTicketsPath: string
  blankAgentAcceptanceDiagnosisPath: string
  acceptanceExperiencePath?: string
  acceptanceExperienceJsonlPath?: string
  finalAcceptanceFeedbackPath?: string
  reviewerSuggestionPath?: string
  blankAgentEvidenceBundlePath?: string
  blankAgentEvidenceReadPaths?: string[]
  expertOracleBundlePath?: string
  /** Exact-file oracle read paths (result.private.json, etc.) for non-Blank workers. */
  expertOracleReadPaths?: string[]
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
  onPulse?: OpencodeTaskInput["onPulse"]
  carryoverFiles?: string[]
}) {
  const workerRoles = defaultCampaignWorkerRoles(input.baseSpec)
  const suggestions = await Promise.all(
    workerRoles.map(async (role) => {
      const stageDir = path.join(input.roundPaths.workersRoot, role)
      const suggestionPath = path.join(stageDir, "suggestion.json")
      const profileAccess = isMultiSkillMergeProfile(input.baseSpec)
        ? await buildMultiSkillMergeRoleAccess({
            role,
            context: {
              stageDir,
              sourceRoots: input.baseSpec.formalPackageRoots ?? [],
              taskDefinitionPaths: input.baseSpec.materials.map((item) => item.path),
              candidateReadRoot: input.pendingPackageRoot,
              tracePaths: [input.runTracePath, input.runTraceDigestPath],
              replayEvidencePaths: [
                ...presentPaths([
                  input.blankAgentAcceptanceDiagnosisPath,
                  input.finalAcceptanceFeedbackPath,
                  input.blankAgentEvidenceBundlePath,
                  ...(input.blankAgentEvidenceReadPaths ?? []),
                ]),
              ],
              internalStatePaths: presentPaths([
                input.explorationTreePath,
                input.workingMemoryPath,
                input.routingControlPath,
                input.dispatchTicketsPath,
                input.acceptanceExperiencePath,
                input.acceptanceExperienceJsonlPath,
                input.reviewerSuggestionPath,
                ...(input.carryoverFiles ?? []),
              ]),
              oraclePaths: presentPaths([input.expertOracleBundlePath, ...(input.expertOracleReadPaths ?? [])]),
            },
          })
        : undefined
      const prompt = profileAccess
        ? buildMultiSkillMergeWorkerPrompt({
            role,
            roundNumber: input.roundNumber,
            accessManifestPath: path.join(stageDir, "access-manifest.json"),
          })
        : buildCampaignWorkerPrompt({
        protocolContext: input.baseSpec.protocolAuthorContext,
        blankEvalExecutorKind: input.baseSpec.blankEvalExecutor?.kind,
        title: input.campaignSpec.title,
        roundNumber: input.roundNumber,
        role,
        runTracePath: input.runTracePath,
        runTraceDigestPath: input.runTraceDigestPath,
        pendingPackageRoot: input.pendingPackageRoot,
        explorationTreePath: input.explorationTreePath,
        workingMemoryPath: input.workingMemoryPath,
        routingControlPath: input.routingControlPath,
        dispatchTicketsPath: input.dispatchTicketsPath,
        blankAgentAcceptanceDiagnosisPath: input.blankAgentAcceptanceDiagnosisPath,
        acceptanceExperiencePath: input.acceptanceExperiencePath,
        finalAcceptanceFeedbackPath: input.finalAcceptanceFeedbackPath,
        reviewerSuggestionPath: input.reviewerSuggestionPath,
        blankAgentEvidenceBundlePath: input.blankAgentEvidenceBundlePath,
        blankAgentEvidenceReadPaths: input.blankAgentEvidenceReadPaths,
        expertOracleBundlePath: input.expertOracleBundlePath,
        expertOracleReadPaths: input.expertOracleReadPaths,
      })
      const access = profileAccess ?? await buildCampaignRoleAccessView({
        role: `worker:${role}`,
        basePaths: [
          // 修订角色需读公开原题；不授予私有标签或整个材料父目录。
          ...(input.baseSpec.protocolPlugins ? (input.baseSpec.protocolAuthorContext?.publicMaterials ?? []).map(file => file.path) : []),
          input.runTracePath,
          input.runTraceDigestPath,
          input.pendingPackageRoot,
          input.explorationTreePath,
          input.workingMemoryPath,
          input.routingControlPath,
          input.dispatchTicketsPath,
          input.blankAgentAcceptanceDiagnosisPath,
        ],
        optionalPaths: [
          input.acceptanceExperiencePath,
          input.acceptanceExperienceJsonlPath,
          input.finalAcceptanceFeedbackPath,
          input.reviewerSuggestionPath,
        ],
        blankAgentEvidenceBundlePath: input.blankAgentEvidenceBundlePath,
        blankAgentEvidenceReadPaths: input.blankAgentEvidenceReadPaths,
        expertOracleBundlePath: input.expertOracleBundlePath,
        expertOracleReadPaths: input.expertOracleReadPaths,
        carryoverFiles: input.carryoverFiles,
      })
      const result = await runCampaignSuggestionTask({
        cwd: input.cwd,
        baseSpec: input.baseSpec,
        title: `Campaign Worker ${role} ${roundID(input.roundNumber)}`,
        prompt,
        selectionPhase: "planning",
        trainingRole: "worker",
        execution: input.baseSpec.planning ?? input.baseSpec.execution,
        referencePaths: access.referencePaths,
        permissionReadPaths: access.permissionReadPaths,
        stageDir,
        phase: "campaign_worker",
        runtimeScope: input.runtimeScope,
        onActivation: input.onActivation,
        onPulse: input.onPulse,
      })
      const suggestion = normalizeWorkerSuggestion({
        roundNumber: input.roundNumber,
        role,
        parsed: result.parsed,
        responsePath: result.artifactPaths.responsePath,
        suggestionPath,
      })
      await writeLongTaskCampaignWorkerSuggestion(suggestionPath, suggestion)
      return suggestion
    }),
  )

  const blankAcceptanceDiagnosis = suggestions.find((item) => item.role === "blank_acceptance_diagnostician")
  if (blankAcceptanceDiagnosis) {
    await writeJsonFile(input.blankAgentAcceptanceDiagnosisPath, blankAcceptanceDiagnosis)
  }

  return suggestions
}

async function runBlankAgentAcceptanceDiagnosisWorker(input: {
  cwd: string
  campaignSpec: LongTaskCampaignSpec
  baseSpec: LongTaskSpec
  roundNumber: number
  passID: string
  runTracePath: string
  runTraceDigestPath: string
  pendingPackageRoot: string
  explorationTreePath: string
  workingMemoryPath: string
  routingControlPath: string
  dispatchTicketsPath: string
  blankAgentAcceptanceDiagnosisPath: string
  acceptanceExperiencePath?: string
  acceptanceExperienceJsonlPath?: string
  finalAcceptanceFeedbackPath: string
  reviewerSuggestionPath?: string
  blankAgentEvidenceBundlePath?: string
  blankAgentEvidenceReadPaths?: string[]
  expertOracleBundlePath?: string
  /** Exact-file oracle read paths (result.private.json, etc.) for non-Blank workers. */
  expertOracleReadPaths?: string[]
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
  onPulse?: OpencodeTaskInput["onPulse"]
}) {
  const role: LongTaskCampaignWorkerRole = "blank_acceptance_diagnostician"
  const stageDir = path.join(input.roundPaths.workersRoot, role, input.passID)
  const suggestionPath = path.join(stageDir, "suggestion.json")
  const config = await loadConfig(input.cwd)
  const blankAcceptanceConfig = config.blankAcceptanceConfig
  if (!blankAcceptanceConfig.enabled) {
    return undefined
  }
  const taskPackName = path.basename(path.dirname(input.campaignSpec.baseSpecPath))
  const profileID =
    blankAcceptanceConfig.taskPackDiagnosisProfiles[taskPackName] ??
    blankAcceptanceConfig.taskPackDiagnosisProfiles[input.baseSpec.taskFamily ?? ""] ??
    blankAcceptanceConfig.defaultDiagnosisProfile
  const blankAcceptanceDiagnosisProfile =
    blankAcceptanceConfig.diagnosisProfiles[profileID] ??
    blankAcceptanceConfig.diagnosisProfiles[blankAcceptanceConfig.defaultDiagnosisProfile] ??
    blankAcceptanceConfig.diagnosisProfiles.auto
  const protocolFeedbackPaths = input.baseSpec.protocolPlugins
    ? await protocolFeedbackEvidence(input.finalAcceptanceFeedbackPath) : []
  const prompt = buildCampaignWorkerPrompt({
    protocolContext: input.baseSpec.protocolAuthorContext,
    blankEvalExecutorKind: input.baseSpec.blankEvalExecutor?.kind,
    title: input.campaignSpec.title,
    roundNumber: input.roundNumber,
    role,
    runTracePath: input.runTracePath,
    runTraceDigestPath: input.runTraceDigestPath,
    pendingPackageRoot: input.pendingPackageRoot,
    explorationTreePath: input.explorationTreePath,
    workingMemoryPath: input.workingMemoryPath,
    routingControlPath: input.routingControlPath,
    dispatchTicketsPath: input.dispatchTicketsPath,
    blankAgentAcceptanceDiagnosisPath: input.blankAgentAcceptanceDiagnosisPath,
    acceptanceExperiencePath: input.acceptanceExperiencePath,
    finalAcceptanceFeedbackPath: input.finalAcceptanceFeedbackPath,
    reviewerSuggestionPath: input.reviewerSuggestionPath,
    blankAgentEvidenceBundlePath: input.blankAgentEvidenceBundlePath,
    blankAgentEvidenceReadPaths: input.blankAgentEvidenceReadPaths,
    blankAcceptanceDiagnosisProfile,
    protocolFeedbackPaths,
    expertOracleBundlePath: input.expertOracleBundlePath,
    expertOracleReadPaths: input.expertOracleReadPaths,
  })
  const access = await buildCampaignRoleAccessView({
    role,
    basePaths: [
      ...(input.baseSpec.protocolPlugins ? (input.baseSpec.protocolAuthorContext?.publicMaterials ?? []).map(file => file.path) : []),
      input.runTracePath,
      input.runTraceDigestPath,
      ...protocolFeedbackPaths,
      input.pendingPackageRoot,
      input.explorationTreePath,
      input.workingMemoryPath,
      input.routingControlPath,
      input.dispatchTicketsPath,
      input.blankAgentAcceptanceDiagnosisPath,
      input.finalAcceptanceFeedbackPath,
    ],
    optionalPaths: [input.acceptanceExperiencePath, input.acceptanceExperienceJsonlPath, input.reviewerSuggestionPath],
    blankAgentEvidenceBundlePath: input.blankAgentEvidenceBundlePath,
    blankAgentEvidenceReadPaths: input.blankAgentEvidenceReadPaths,
    expertOracleBundlePath: input.expertOracleBundlePath,
    expertOracleReadPaths: input.expertOracleReadPaths,
    editPaths: [input.nextPendingPackageRoot, input.nextExplorationTreePath, input.nextRoutingControlPath],
  })
  const result = await runCampaignSuggestionTask({
    cwd: input.cwd,
    baseSpec: input.baseSpec,
    title: `Campaign Worker ${role} ${roundID(input.roundNumber)} ${input.passID}`,
    prompt,
    selectionPhase: "planning",
    trainingRole: "diagnostician",
    execution: input.baseSpec.planning ?? input.baseSpec.execution,
    referencePaths: access.referencePaths,
    permissionReadPaths: access.permissionReadPaths,
    stageDir,
    phase: "campaign_worker",
    runtimeScope: input.runtimeScope,
    onActivation: input.onActivation,
    onPulse: input.onPulse,
  })
  const suggestion = normalizeWorkerSuggestion({
    roundNumber: input.roundNumber,
    role,
    parsed: result.parsed,
    responsePath: result.artifactPaths.responsePath,
    suggestionPath,
  })
  await writeLongTaskCampaignWorkerSuggestion(suggestionPath, suggestion)
  await writeJsonFile(input.blankAgentAcceptanceDiagnosisPath, suggestion)
  return suggestion
}

function buildRepairChecklistFromFinalAcceptance(
  result: Record<string, unknown>,
): string[] {
  const items: string[] = []
  const validatorResults = Array.isArray(result.validatorResults) ? result.validatorResults : []
  for (const vr of validatorResults) {
    if (!vr || typeof vr !== "object") continue
    if (vr.passed !== false && vr.passed !== "false") continue
    const validatorID = typeof vr.validatorID === "string" ? vr.validatorID : "unknown-validator"
    const summary = typeof vr.summary === "string" ? vr.summary : ""
    const details: string[] = Array.isArray(vr.details) ? vr.details.filter((d): d is string => typeof d === "string") : []
    const blocking = vr.blocking === true || vr.blocking === "true"
    const tag = blocking ? "BLOCKING" : "non-blocking"
    items.push(`[${tag}] ${validatorID}: ${summary}`)
    for (const detail of details) {
      items.push(`  -> ${detail}`)
    }
    // 新协议按检查对象修订，不再靠验证器名字推测修复目标。
    const fixHint = result.acceptanceMode === "protocol_plugins" ? "" : validatorRepairHint(validatorID, details)
    if (fixHint) items.push(`  REPAIR_HINT: ${fixHint}`)
  }
  return items
}

function oracleResultsFromValidatorResults(
  validatorResults: Array<Record<string, unknown>>,
): OracleValidatorResult[] {
  return validatorResults.map((vr) => ({
    validatorID: String(vr.validatorID ?? "unknown"),
    passed: Boolean(vr.passed),
    evidenceRefs: Array.isArray(vr.evidenceRefs) ? (vr.evidenceRefs as string[]) : undefined,
    rawOutputPath: typeof vr.rawOutputPath === "string" ? vr.rawOutputPath : undefined,
  }))
}

async function writeExpertOracleBundleFromValidatorResults(input: {
  outPath: string
  campaignID?: string
  roundNumber?: number
  passID?: string
  resultPath?: string
  validatorResults: Array<Record<string, unknown>>
}) {
  const oracle = await collectExpertOracleReadPaths({
    validatorResults: oracleResultsFromValidatorResults(input.validatorResults),
  })
  const written = await writeExpertOracleBundle({
    outPath: input.outPath,
    campaignID: input.campaignID,
    roundNumber: input.roundNumber,
    passID: input.passID,
    resultPath: input.resultPath,
    oracle,
  })
  return {
    bundlePath: written.bundlePath,
    oraclePaths: oracle.paths,
    oracleSources: oracle.sources,
  }
}

function validatorRepairHint(validatorID: string, details: string[]): string {
  if (validatorID === "workspace-layout") {
    if (details.some((d) => d.includes("missing: manifest.md") || d.includes("entry file is missing"))) {
      return "surface_contract.json declares entry and document paths. Ensure those files exist at the declared relative paths inside the pending package. Check surface_contract.json 'entry' and 'documents' fields, then verify each declared file exists on disk."
    }
    if (details.some((d) => d.includes("invalid under the governed profile"))) {
      return "Verify pending package structure matches what surface_contract.json declares. Move any files that are at root but belong inside expert-workspace/, or update the contract."
    }
  }
  if (validatorID === "expert-surface-generalization") {
    if (details.some((d) => d.includes("hardcoded") || d.includes("task-answer"))) {
      return "Search the expert workspace files for hardcoded task-answer literals (e.g. specific numbers, dates, names from source data). Replace them with source-locator descriptions (e.g. 'value from Sheet1!A6' instead of '20,260')."
    }
  }
  if (validatorID === "blank-agent-deployment") {
    if (details.some((d) => d.includes("missing required task values"))) {
      return "The blank agent is not producing correctly filled DOCX files. Check the execution checklist and fill-edit guidance in the expert workspace. Ensure it teaches: (1) which capability to use, (2) exact fill locations in templates, (3) how to verify values were inserted."
    }
    if (details.some((d) => d.includes("placeholder"))) {
      return "DOCX files still contain U+3010/U+3011 placeholder markers. Ensure the expert workspace has clear instructions to use fill-edit (not template-copy-only) and to verify zero placeholders before declaring completion."
    }
  }
  return ""
}

async function runCampaignLead(input: {
  cwd: string
  campaignSpec: LongTaskCampaignSpec
  baseSpec: LongTaskSpec
  roundNumber: number
  runTracePath: string
  runTraceDigestPath: string
  previousPendingPackageRoot: string
  nextPendingPackageRoot: string
  previousExplorationTreePath: string
  nextExplorationTreePath: string
  workingMemoryPath: string
  previousRoutingControlPath: string
  nextRoutingControlPath: string
  dispatchTicketsPath: string
  blankAgentAcceptanceDiagnosisPath: string
  workerSuggestions: LongTaskCampaignWorkerSuggestion[]
  reviewerSuggestionPath?: string
  acceptanceExperiencePath?: string
  acceptanceExperienceJsonlPath?: string
  finalAcceptanceFeedbackPath?: string
  repairChecklist?: string[]
  blankAgentEvidenceBundlePath?: string
  blankAgentEvidenceReadPaths?: string[]
  expertOracleBundlePath?: string
  /** Exact-file oracle read paths (result.private.json, etc.) for non-Blank lead. */
  expertOracleReadPaths?: string[]
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
  onPulse?: OpencodeTaskInput["onPulse"]
}) {
  const workerSuggestionPaths = input.workerSuggestions
    .map((item) => item.suggestionPath ?? item.responsePath)
    .filter((item): item is string => Boolean(item))
  const stageDir = path.join(input.roundPaths.root, "campaign-lead")
  const profileAccess = isMultiSkillMergeProfile(input.baseSpec)
    ? await buildMultiSkillMergeRoleAccess({
        role: "merge_lead",
        context: {
          stageDir,
          sourceRoots: input.baseSpec.formalPackageRoots ?? [],
          taskDefinitionPaths: input.baseSpec.materials.map((item) => item.path),
          candidateReadRoot: input.previousPendingPackageRoot,
          candidateWriteRoots: [
            input.nextPendingPackageRoot,
            input.nextExplorationTreePath,
            input.nextRoutingControlPath,
          ],
          tracePaths: [input.runTracePath, input.runTraceDigestPath],
          workerSuggestionPaths,
          replayEvidencePaths: presentPaths([
            input.blankAgentAcceptanceDiagnosisPath,
            input.finalAcceptanceFeedbackPath,
            input.blankAgentEvidenceBundlePath,
            ...(input.blankAgentEvidenceReadPaths ?? []),
          ]),
          internalStatePaths: presentPaths([
            input.previousExplorationTreePath,
            input.workingMemoryPath,
            input.previousRoutingControlPath,
            input.dispatchTicketsPath,
            input.reviewerSuggestionPath,
            input.acceptanceExperiencePath,
            input.acceptanceExperienceJsonlPath,
          ]),
          oraclePaths: presentPaths([input.expertOracleBundlePath, ...(input.expertOracleReadPaths ?? [])]),
        },
      })
    : undefined
  const protocolFeedbackPaths = input.baseSpec.protocolPlugins
    ? await protocolFeedbackEvidence(input.finalAcceptanceFeedbackPath) : []
  const prompt = profileAccess
    ? buildMultiSkillMergeLeadPrompt({
        roundNumber: input.roundNumber,
        accessManifestPath: path.join(stageDir, "access-manifest.json"),
        nextCandidateRoot: input.nextPendingPackageRoot,
      })
    : buildCampaignLeadPrompt({
    protocolContext: input.baseSpec.protocolAuthorContext,
    blankEvalExecutorKind: input.baseSpec.blankEvalExecutor?.kind,
    title: input.campaignSpec.title,
    roundNumber: input.roundNumber,
    runTracePath: input.runTraceDigestPath,
    previousPendingPackageRoot: input.previousPendingPackageRoot,
    nextPendingPackageRoot: input.nextPendingPackageRoot,
    previousExplorationTreePath: input.previousExplorationTreePath,
    nextExplorationTreePath: input.nextExplorationTreePath,
    workingMemoryPath: input.workingMemoryPath,
    previousRoutingControlPath: input.previousRoutingControlPath,
    nextRoutingControlPath: input.nextRoutingControlPath,
    dispatchTicketsPath: input.dispatchTicketsPath,
    blankAgentAcceptanceDiagnosisPath: input.blankAgentAcceptanceDiagnosisPath,
    workerSuggestionPaths,
    reviewerSuggestionPath: input.reviewerSuggestionPath,
    acceptanceExperiencePath: input.acceptanceExperiencePath,
    finalAcceptanceFeedbackPath: input.finalAcceptanceFeedbackPath,
    repairChecklist: input.repairChecklist,
    protocolFeedbackPaths,
    blankAgentEvidenceBundlePath: input.blankAgentEvidenceBundlePath,
    expertOracleBundlePath: input.expertOracleBundlePath,
    expertOracleReadPaths: input.expertOracleReadPaths,
  })
  const access = profileAccess ?? await buildCampaignRoleAccessView({
    role: "lead",
    editPaths: input.baseSpec.protocolPlugins
      ? [input.nextPendingPackageRoot, input.nextExplorationTreePath, input.nextRoutingControlPath]
      : undefined,
    basePaths: [
      ...(input.baseSpec.protocolPlugins ? (input.baseSpec.protocolAuthorContext?.publicMaterials ?? []).map(file => file.path) : []),
      input.runTraceDigestPath,
      ...protocolFeedbackPaths,
      // 新候选必须可回读核验，写权限不隐式代表读权限。
      ...(input.baseSpec.protocolPlugins ? [input.nextPendingPackageRoot, input.nextExplorationTreePath, input.nextRoutingControlPath] : []),
      input.previousPendingPackageRoot,
      input.previousExplorationTreePath,
      input.workingMemoryPath,
      input.previousRoutingControlPath,
      input.dispatchTicketsPath,
      input.blankAgentAcceptanceDiagnosisPath,
      ...workerSuggestionPaths,
    ],
    optionalPaths: [
      input.reviewerSuggestionPath,
      input.acceptanceExperiencePath,
      input.acceptanceExperienceJsonlPath,
      input.finalAcceptanceFeedbackPath,
    ],
    blankAgentEvidenceBundlePath: input.blankAgentEvidenceBundlePath,
    blankAgentEvidenceReadPaths: input.blankAgentEvidenceReadPaths,
    expertOracleBundlePath: input.expertOracleBundlePath,
    expertOracleReadPaths: input.expertOracleReadPaths,
  })
  return runCampaignSuggestionTask({
    cwd: input.cwd,
    baseSpec: input.baseSpec,
    title: `Campaign Lead ${roundID(input.roundNumber)}`,
    prompt,
    selectionPhase: "solve",
    trainingRole: "lead",
    execution: input.baseSpec.execution,
    referencePaths: access.referencePaths,
    permissionReadPaths: access.permissionReadPaths,
    permissionEditPaths: access.permissionEditPaths,
    stageDir,
    phase: "campaign_lead",
    runtimeScope: input.runtimeScope,
    onActivation: input.onActivation,
    onPulse: input.onPulse,
  })
}

async function runCampaignReviewer(input: {
  cwd: string
  campaignSpec: LongTaskCampaignSpec
  baseSpec: LongTaskSpec
  roundNumber: number
  pendingPackageRoot: string
  runTracePath: string
  explorationTreePath: string
  workingMemoryPath: string
  routingControlPath: string
  dispatchTicketsPath: string
  blankAgentAcceptanceDiagnosisPath: string
  acceptanceExperiencePath?: string
  acceptanceExperienceJsonlPath?: string
  blankAgentEvidenceBundlePath?: string
  blankAgentEvidenceReadPaths?: string[]
  expertOracleBundlePath?: string
  /** Exact-file oracle read paths (result.private.json, etc.) for non-Blank reviewer. */
  expertOracleReadPaths?: string[]
  stageDir?: string
  suggestionPath?: string
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
  onPulse?: OpencodeTaskInput["onPulse"]
}) {
  const stageDir = input.stageDir ?? input.roundPaths.reviewerRoot
  const profileAccess = isMultiSkillMergeProfile(input.baseSpec)
    ? await buildMultiSkillMergeRoleAccess({
        role: "merge_retention_reviewer",
        context: {
          stageDir,
          sourceRoots: input.baseSpec.formalPackageRoots ?? [],
          taskDefinitionPaths: input.baseSpec.materials.map((item) => item.path),
          candidateReadRoot: input.pendingPackageRoot,
          tracePaths: [input.runTracePath],
          replayEvidencePaths: presentPaths([
            input.blankAgentAcceptanceDiagnosisPath,
            input.blankAgentEvidenceBundlePath,
            ...(input.blankAgentEvidenceReadPaths ?? []),
          ]),
          internalStatePaths: presentPaths([
            input.explorationTreePath,
            input.workingMemoryPath,
            input.routingControlPath,
            input.dispatchTicketsPath,
            input.acceptanceExperiencePath,
            input.acceptanceExperienceJsonlPath,
          ]),
          oraclePaths: presentPaths([input.expertOracleBundlePath, ...(input.expertOracleReadPaths ?? [])]),
        },
      })
    : undefined
  const prompt = profileAccess
    ? buildMultiSkillMergeReviewerPrompt({
        roundNumber: input.roundNumber,
        accessManifestPath: path.join(stageDir, "access-manifest.json"),
      })
    : buildCampaignReviewerPrompt({
    protocolContext: input.baseSpec.protocolAuthorContext,
    blankEvalExecutorKind: input.baseSpec.blankEvalExecutor?.kind,
    title: input.campaignSpec.title,
    roundNumber: input.roundNumber,
    pendingPackageRoot: input.pendingPackageRoot,
    runTracePath: input.runTracePath,
    explorationTreePath: input.explorationTreePath,
    workingMemoryPath: input.workingMemoryPath,
    routingControlPath: input.routingControlPath,
    dispatchTicketsPath: input.dispatchTicketsPath,
    blankAgentAcceptanceDiagnosisPath: input.blankAgentAcceptanceDiagnosisPath,
    acceptanceExperiencePath: input.acceptanceExperiencePath,
    blankAgentEvidenceBundlePath: input.blankAgentEvidenceBundlePath,
    expertOracleBundlePath: input.expertOracleBundlePath,
    expertOracleReadPaths: input.expertOracleReadPaths,
  })
  const access = profileAccess ?? await buildCampaignRoleAccessView({
    role: "reviewer",
    basePaths: [
      ...(input.baseSpec.protocolPlugins ? (input.baseSpec.protocolAuthorContext?.publicMaterials ?? []).map(file => file.path) : []),
      input.pendingPackageRoot,
      input.runTracePath,
      input.explorationTreePath,
      input.workingMemoryPath,
      input.routingControlPath,
      input.dispatchTicketsPath,
      input.blankAgentAcceptanceDiagnosisPath,
    ],
    optionalPaths: [input.acceptanceExperiencePath, input.acceptanceExperienceJsonlPath],
    blankAgentEvidenceBundlePath: input.blankAgentEvidenceBundlePath,
    blankAgentEvidenceReadPaths: input.blankAgentEvidenceReadPaths,
    expertOracleBundlePath: input.expertOracleBundlePath,
    expertOracleReadPaths: input.expertOracleReadPaths,
  })
  const result = await runCampaignSuggestionTask({
    cwd: input.cwd,
    baseSpec: input.baseSpec,
    title: `Campaign Reviewer ${roundID(input.roundNumber)}`,
    prompt,
    selectionPhase: "validation",
    trainingRole: "reviewer",
    execution: input.baseSpec.validation ?? input.baseSpec.execution,
    referencePaths: access.referencePaths,
    permissionReadPaths: access.permissionReadPaths,
    stageDir,
    phase: "campaign_review",
    runtimeScope: input.runtimeScope,
    onActivation: input.onActivation,
    onPulse: input.onPulse,
  })
  const suggestion = normalizeReviewerSuggestion({
    roundNumber: input.roundNumber,
    parsed: result.parsed,
    responsePath: result.artifactPaths.responsePath,
  })
  await writeJsonFile(input.suggestionPath ?? input.roundPaths.reviewerSuggestionPath, suggestion)
  return suggestion
}

async function runSurfaceGeneralizationPrecheck(input: {
  cwd: string
  campaignSpec: LongTaskCampaignSpec
  baseSpec: LongTaskSpec
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
  roundNumber: number
  passID: string
  runID?: string
  runtimeScope: string
  onActivation?: (signal: { kind: string; scope: string; pid: number }) => void
  onPulse?: () => Promise<void>
}) {
  const cfg = input.campaignSpec.surfaceGeneralization
  // 新链路的必检由冻结协议组织，不额外运行旧默认表面检查。
  if (input.baseSpec.protocolPlugins) return
  if (!cfg?.enabled) return
  const dir = path.join(input.roundPaths.root, "surface-precheck")
  const id = `surface-precheck-${input.passID}`
  const out = path.join(dir, "result.json")
  await ensureDirectory(dir)
  try {
    const contract: LongTaskValidatorContract = {
      id,
      type: "script",
      title: "Surface Generalization Pre-Check",
      path: cfg.validatorPath,
      runner: "python",
      args: [cfg.configPath],
      timeoutMs: cfg.timeoutMs,
      validation: {
        target: "surface",
        stage: "pre_blank",
        answerAccess: "full_training",
        allowedAudiences: ["worker", "lead", "reviewer", "dashboard", "memory", "audit"],
      },
    }
    const unit: LongTaskWorkUnit = {
      id,
      title: "Surface Generalization Pre-Check",
      goal: "Verify pending package avoids hardcoded task-answer literals",
      inputs: [],
      dependsOn: [],
      expectedArtifacts: [],
      claim: "Surface generalization pre-check",
      checkPlan: "Run surface generalization validator",
      validatorIDs: [],
      retryBudget: 0,
      status: "active",
      attemptCount: 1,
    }
    const result = await runLongTaskValidator({
      cwd: input.cwd,
      config: await loadConfig(input.cwd),
      contract,
      spec: input.baseSpec,
      unit,
      runID: input.runID ?? input.roundPaths.runTraceJsonPath,
      attempt: 1,
      validatorDir: dir,
      bundlePath: out,
      payload: {
        targetPaths: [{ path: input.roundPaths.pendingPackageSnapshotRoot, role: "experience-workspace" }],
      },
      runtimeScope: input.runtimeScope,
      onActivation: input.onActivation,
      onPulse: input.onPulse,
    })
    if (result.passed) return
    const items = await readLongTaskCampaignOperationalMemory(input.campaignPaths)
    items.push({
      id: `surface-fail-${input.roundNumber}-${input.passID}`,
      runID: input.runID ?? "",
      createdAt: nowISO(),
      updatedAt: nowISO(),
      kind: "blocking_issue",
      status: "confirmed",
      statement: `Lead pending package (${input.passID}) failed surface-generalization pre-check.`,
      rationale: "Validator detected forbidden literals or non-generalized surface content.",
      refs: [out],
      tags: ["surface-generalization-fail"],
      roundNumber: input.roundNumber,
      lastRound: input.roundNumber,
      occurrenceCount: 1,
      sourceRunIDs: input.runID ? [input.runID] : [],
    })
    await writeLongTaskCampaignOperationalMemory(input.campaignPaths, items)
    if (cfg.blocking) {
      throw new Error(`Surface generalization pre-check failed (${input.passID}).`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const items = await readLongTaskCampaignOperationalMemory(input.campaignPaths)
    items.push({
      id: `surface-skip-${input.roundNumber}-${input.passID}`,
      runID: input.runID ?? "",
      createdAt: nowISO(),
      updatedAt: nowISO(),
      kind: "package_gap",
      status: "candidate",
      statement: `Surface generalization pre-check could not run: ${message}`,
      rationale: "Pre-check script/config/runtime issue.",
      refs: [],
      tags: ["surface-precheck-error"],
      roundNumber: input.roundNumber,
      lastRound: input.roundNumber,
      occurrenceCount: 1,
      sourceRunIDs: input.runID ? [input.runID] : [],
    })
    await writeLongTaskCampaignOperationalMemory(input.campaignPaths, items)
    if (cfg.blocking) throw error
  }
}

async function prepareCampaignProtocol(root: string, spec: LongTaskSpec, existing: boolean, cwd: string) {
  const prepared = await pathExists(path.join(root, "protocol-plugins"))
  if (!spec.protocolPlugins && !prepared) return
  // 已存在的旧campaign不能因后来加配置被接管或自动迁移。
  if (existing && spec.protocolPlugins && !prepared) throw new Error("Cannot enable protocol plugins on existing legacy campaign")
  if (!spec.protocolPlugins) throw new Error("Protocol entry removed from existing plugin campaign")
  const binding = await prepareEntry(root, spec.protocolPlugins,
    await selectedRuntime(path.join(root, "protocol-backends"), cwd, spec.protocolPlugins))
  if (binding) spec.protocolAuthorContext = authorContext(binding.entry, binding.protocol, binding.project)
  if (existing && spec.protocolTraining && !await pathExists(path.join(root, "protocol-training"))) {
    throw new Error("Cannot enable training config on an existing unconfigured Campaign")
  }
  spec.protocolTrainingRoot = await freezeTraining(root, spec.protocolTraining, cwd)
}

async function runCampaignFinalAcceptance(input: {
  cwd: string
  campaignID: string
  campaignSpec: LongTaskCampaignSpec
  baseSpec: LongTaskSpec
  baseSpecPath: string
  roundNumber: number
  sourceRunID: string
  pendingPackageRoot: string
  runTracePath: string
  reviewerSuggestionPath: string
  finalAcceptanceRoot?: string
  finalAcceptanceResultPath?: string
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  passID: string
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
  onPulse?: OpencodeTaskInput["onPulse"]
}) {
  const acceptanceRoot = input.finalAcceptanceRoot ?? input.roundPaths.finalAcceptanceRoot
  const acceptanceResultPath = input.finalAcceptanceResultPath ?? input.roundPaths.finalAcceptanceResultPath
  if (input.baseSpec.protocolPlugins) {
    return campaignAcceptance({ campaignRoot: input.campaignPaths.root, cwd: input.cwd, campaignID: input.campaignID,
      roundNumber: input.roundNumber, runID: input.sourceRunID, entry: input.baseSpec.protocolPlugins,
      candidateRoot: input.pendingPackageRoot, attemptRoot: acceptanceRoot, resultPath: acceptanceResultPath })
  }
  const validatorPartitions = partitionCampaignFinalAcceptanceValidators(input.baseSpec)
  const acceptanceMode = input.baseSpec.campaignFinalAcceptanceMode ?? "blank_agent"
  if (!validatorPartitions.contracts.length) {
    const emptyResult = {
      campaignID: input.campaignID,
      roundNumber: input.roundNumber,
      runID: input.sourceRunID,
      passed: false,
      summary: "Campaign final acceptance is not configured: no completion-only validators were found.",
      validatorResults: [] as LongTaskValidatorResult[],
      createdAt: nowISO(),
    }
    await ensureDirectory(acceptanceRoot)
    await writeJsonFile(acceptanceResultPath, emptyResult)
    return emptyResult
  }
  if (acceptanceMode === "validators_only" && !validatorPartitions.surfaceValidators.length) {
    const missingSurfaceResult = {
      campaignID: input.campaignID,
      roundNumber: input.roundNumber,
      runID: input.sourceRunID,
      passed: false,
      failureKind: "infrastructure_failure" as const,
      summary:
        "Campaign validators-only final acceptance is not configured: no surface validators were found.",
      validatorResults: [] as LongTaskValidatorResult[],
      acceptanceMode,
      createdAt: nowISO(),
    }
    await ensureDirectory(acceptanceRoot)
    await writeJsonFile(acceptanceResultPath, missingSurfaceResult)
    return missingSurfaceResult
  }

  await ensureDirectory(acceptanceRoot)
  const validationPackageRoot = path.join(acceptanceRoot, "validation-expert-workspace")
  await copyExperienceWorkspaceRoot(input.pendingPackageRoot, validationPackageRoot, {
    includeSurfaceContractRequiredPaths: true,
  })
  const acceptanceSpec = buildCampaignFinalAcceptanceSpec(input.baseSpec, validationPackageRoot)
  const syntheticUnit = syntheticCampaignFinalAcceptanceUnit(input.baseSpec, validationPackageRoot)
  const bundlePath = path.join(acceptanceRoot, "final-acceptance-bundle.json")
  await writeJsonFile(bundlePath, {
    id: `campaign-final-${randomUUID().slice(0, 8)}`,
    campaignID: input.campaignID,
    roundNumber: input.roundNumber,
    sourceRunID: input.sourceRunID,
    pendingPackageRoot: input.pendingPackageRoot,
    validationPackageRoot,
    runTracePath: input.runTracePath,
    reviewerSuggestionPath: input.reviewerSuggestionPath,
    validatorPartitions: {
      surfaceValidatorIDs: validatorPartitions.surfaceValidators.map((item) => item.id),
      legacyBlankAgentValidatorIDs: validatorPartitions.legacyBlankAgentValidators.map((item) => item.id),
      productValidatorIDs: validatorPartitions.productValidators.map((item) => item.id),
    },
    acceptanceMode,
    createdAt: nowISO(),
  })

  const config = await loadConfig(input.cwd)
  const validatorResults: LongTaskValidatorResult[] = []
  let preBlankValidationStageResultPath: string | undefined
  if (validatorPartitions.surfaceValidators.length) {
    const preBlankValidators = validatorPartitions.surfaceValidators.map((validator) => ({
      ...validator,
      validation: {
        ...validator.validation,
        stage: validator.validation?.stage ?? "pre_blank",
      },
    }))
    const preBlankStage = await runValidationStage({
      cwd: input.cwd,
      config,
      spec: acceptanceSpec,
      unit: syntheticUnit,
      stage: "pre_blank",
      targets: ["surface", "layout", "behavior"],
      runID: input.sourceRunID,
      attempt: 1,
      stageDir: path.join(acceptanceRoot, "pre-blank-validation"),
      bundlePath,
      runtimeScope: input.runtimeScope,
      onActivation: input.onActivation,
      onPulse: input.onPulse,
      validators: preBlankValidators,
      payload: {
        runID: input.sourceRunID,
        unitID: syntheticUnit.id,
        attempt: 1,
        goal: acceptanceSpec.goal,
        claim: syntheticUnit.claim,
        checkPlan: syntheticUnit.checkPlan,
        materials: acceptanceSpec.materials,
        targetPaths: acceptanceSpec.targetPaths ?? [],
        expectedArtifacts: syntheticUnit.expectedArtifacts,
        editablePaths: acceptanceSpec.editablePaths ?? [],
        bundlePath,
      },
    })
    validatorResults.push(...preBlankStage.validatorResults)
    preBlankValidationStageResultPath = preBlankStage.resultPath
  }

  const surfacePassed = validatorResults.every((result) => result.passed)
  let blankEvalResultPath: string | undefined
  let blankEvalRunDir: string | undefined
  if (surfacePassed) {
    if (acceptanceMode === "validators_only") {
      // Product replay is owned by the outer merge supervisor. Intermediate
      // merge campaigns only prove that their skill package is structurally
      // valid and generalized enough to move upward.
    } else if (validatorPartitions.legacyBlankAgentValidators.length) {
      for (const validator of validatorPartitions.legacyBlankAgentValidators) {
        const result = await runLongTaskValidator({
          cwd: input.cwd,
          config,
          contract: validator,
          spec: acceptanceSpec,
          unit: syntheticUnit,
          runID: input.sourceRunID,
          attempt: 1,
          validatorDir: path.join(acceptanceRoot, validator.id),
          bundlePath,
          runtimeScope: input.runtimeScope,
          onActivation: input.onActivation,
          onPulse: input.onPulse,
          payload: {
            runID: input.sourceRunID,
            unitID: syntheticUnit.id,
            attempt: 1,
            goal: acceptanceSpec.goal,
            claim: syntheticUnit.claim,
            checkPlan: syntheticUnit.checkPlan,
            materials: acceptanceSpec.materials,
            targetPaths: acceptanceSpec.targetPaths ?? [],
            expectedArtifacts: syntheticUnit.expectedArtifacts,
            editablePaths: acceptanceSpec.editablePaths ?? [],
            bundlePath,
          },
        })
        validatorResults.push(result)
      }
    } else if (!validatorPartitions.productValidators.length) {
      validatorResults.push(
          blankEvalValidatorResult({
            passed: false,
            failureKind: "validator_infrastructure",
            summary:
            "Blank-agent acceptance is not configured: no product validators were found for the blank agent output.",
          details: [
            "Each campaign round must validate the skill by running a clean blank agent and checking its product.",
            "Add at least one completion/product validator, or provide an existing blank-agent deployment validator wrapper.",
          ],
          evidenceRefs: [bundlePath, validationPackageRoot],
        }),
      )
    } else {
      try {
        const blankEvalSpec = buildCampaignBlankEvalSpec({
          baseSpec: input.baseSpec,
          baseSpecPath: input.baseSpecPath,
          pendingPackageRoot: validationPackageRoot,
          productValidators: validatorPartitions.productValidators,
        })
        const blankEvalSpecPath = path.join(acceptanceRoot, "blank-eval-spec.json")
        await writeJsonFile(blankEvalSpecPath, blankEvalSpec)
        const blankEval = await runBlankEval({
          cwd: input.cwd,
          specPath: blankEvalSpecPath,
          skillRoots: [validationPackageRoot],
          runRoot: path.join(acceptanceRoot, "blank-eval-runs"),
          sourceID: `${input.campaignID}:${roundID(input.roundNumber)}`,
          mode: "deployment",
          runtimeScope: input.runtimeScope ? `${input.runtimeScope}:blank-eval` : undefined,
          concurrencyScope: `campaign-final-acceptance:${input.campaignID}`,
        })
        blankEvalResultPath = blankEval.resultPath
        blankEvalRunDir = blankEval.runDir
        validatorResults.push(
          blankEvalValidatorResult({
            passed: blankEval.passed,
            failureKind: blankEval.failureKind,
            summary: blankEval.passed
              ? "Blank-agent acceptance passed: the current skill taught a clean agent to produce a valid product."
              : `Blank-agent acceptance failed: ${blankEval.summary}`,
            details: blankEval.validatorResults
              .filter((result) => !result.passed)
              .map((result) => `${result.validatorID}: ${result.summary}`),
            evidenceRefs: [
              blankEval.runDir,
              blankEval.resultPath,
              ...(blankEval.validationStageResultPath ? [blankEval.validationStageResultPath] : []),
              blankEval.sessionExecutionReportPath,
              ...blankEval.validatorResults.flatMap((result) => result.evidenceRefs ?? []),
            ],
            rawOutputPath: blankEval.resultPath,
          }),
        )
        validatorResults.push(...blankEval.validatorResults)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        validatorResults.push(
          blankEvalValidatorResult({
            passed: false,
            failureKind: "validator_infrastructure",
            summary: `Blank-agent acceptance crashed before completion: ${message}`,
            details: [message],
            evidenceRefs: [bundlePath, validationPackageRoot],
          }),
        )
      }
    }
  } else {
    if (acceptanceMode === "blank_agent") {
      validatorResults.push(
        blankEvalValidatorResult({
          passed: false,
          failureKind: "product_failure",
          summary: "Blank-agent acceptance was skipped because the pending skill failed surface validation.",
          details: validatorResults.filter((result) => !result.passed).map((result) => result.summary),
          evidenceRefs: [bundlePath, validationPackageRoot],
        }),
      )
    }
  }

  const passed = validatorResults.every((result) => result.passed)
  const hasDatasetFailure = validatorResults.some((result) => !result.passed && result.failureKind === "dataset_failure")
  const hasProductFailure = validatorResults.some((result) => !result.passed && result.failureKind === "product_failure")
  const hasInfrastructureFailure = validatorResults.some(
    (result) => !result.passed && result.failureKind === "validator_infrastructure",
  )
  const failureKind = passed
    ? undefined
    : hasDatasetFailure
      ? ("dataset_failure" as const)
    : hasProductFailure
      ? ("product_failure" as const)
    : hasInfrastructureFailure
      ? ("infrastructure_failure" as const)
      : ("product_failure" as const)
  const summary = passed
    ? acceptanceMode === "validators_only"
      ? "Campaign intermediate acceptance passed: surface validators passed; product replay is deferred to the external merge supervisor."
      : "Campaign final acceptance passed: surface checks and blank-agent product validation both passed."
    : validatorResults
        .filter((result) => !result.passed)
        .map((result) => result.summary)
        .join(" | ") || "Campaign final acceptance failed."

  const finalAcceptance = {
    campaignID: input.campaignID,
    roundNumber: input.roundNumber,
    runID: input.sourceRunID,
    passed,
    failureKind,
    summary,
    validatorResults,
    bundlePath,
    validationPackageRoot,
    preBlankValidationStageResultPath,
    blankEvalResultPath,
    blankEvalRunDir,
    acceptanceMode,
    blankEvalSkipped: acceptanceMode === "validators_only",
    validatorPartitions: {
      surfaceValidatorIDs: validatorPartitions.surfaceValidators.map((item) => item.id),
      legacyBlankAgentValidatorIDs: validatorPartitions.legacyBlankAgentValidators.map((item) => item.id),
      productValidatorIDs: validatorPartitions.productValidators.map((item) => item.id),
    },
    createdAt: nowISO(),
  }

  try {
    const oracleBundle = await writeExpertOracleBundleFromValidatorResults({
      outPath: path.join(acceptanceRoot, "expert-oracle-bundle.json"),
      campaignID: input.campaignID,
      roundNumber: input.roundNumber,
      passID: input.passID,
      resultPath: acceptanceResultPath,
      validatorResults: validatorResults as unknown as Array<Record<string, unknown>>,
    })
    ;(finalAcceptance as Record<string, unknown>).expertOracleBundlePath = oracleBundle.bundlePath
    ;(finalAcceptance as Record<string, unknown>).expertOracleReadPaths = oracleBundle.oraclePaths
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[runCampaignFinalAcceptance] expert oracle bundle generation failed:", message)
  }

  // Step 8: generate blank agent evidence bundle (for downstream workers/lead/reviewer/diagnosis)
  // and persist it to campaign-level blank-agent-evidence/ so the next round can read it.
  if (blankEvalRunDir) {
    const blankEvalSessionExecutionReportPath = validatorResults
      .map((vr) => vr.rawOutputPath)
      .find((p): p is string => Boolean(p && p.includes("session_execution_report")))
      ?? path.join(blankEvalRunDir, "session", "session_execution_report.md")
    const blankEvalSessionDir = path.dirname(blankEvalSessionExecutionReportPath)
    const blankEvalValidationStageResultPath = validatorResults
      .flatMap((vr) => vr.evidenceRefs ?? [])
      .find((p): p is string => Boolean(p && p.endsWith("stage-result.json")))

    try {
      const evidence = await writeBlankAgentEvidenceBundle({
        cwd: input.cwd,
        campaignID: input.campaignID,
        campaignRoot: input.campaignPaths.root,
        roundNumber: input.roundNumber,
        passID: input.passID,
        sourceRunID: input.sourceRunID,
        baseSpec: input.baseSpec,
        acceptanceRoot,
        acceptanceResultPath,
        finalAcceptance: {
          passed: finalAcceptance.passed,
          summary: finalAcceptance.summary,
          validatorResults: finalAcceptance.validatorResults.map((vr) => ({
            validatorID: vr.validatorID,
            passed: vr.passed,
            evidenceRefs: vr.evidenceRefs,
            rawOutputPath: vr.rawOutputPath,
          })),
          blankEvalRunDir: finalAcceptance.blankEvalRunDir,
          blankEvalResultPath: finalAcceptance.blankEvalResultPath,
          blankEvalValidationStageResultPath,
          blankEvalSessionDir,
          blankEvalSessionExecutionReportPath,
        },
      })
      ;(finalAcceptance as Record<string, unknown>).blankAgentEvidenceBundlePath = evidence.bundlePath
      ;(finalAcceptance as Record<string, unknown>).blankAgentEvidenceReadPaths = (await readBlankAgentEvidenceReadablePaths(evidence.bundlePath))
    } catch (error) {
      // Evidence bundle is best-effort: never block acceptance write on its failure
      const message = error instanceof Error ? error.message : String(error)
      console.error("[runCampaignFinalAcceptance] evidence bundle generation failed:", message)
    }
  }

  await writeJsonFile(acceptanceResultPath, finalAcceptance)
  return finalAcceptance
}

function summarizeFailedValidators(
  validatorResults: Array<{ validatorID: string; passed: boolean; summary: string }>,
  limit = 3,
) {
  const failed = validatorResults.filter((item) => item.passed === false).slice(0, limit)
  if (!failed.length) return "全部通过"
  return failed.map((item) => `${item.validatorID}: ${short(item.summary, 90)}`).join(" | ")
}

async function appendAcceptanceExperience(input: {
  path: string
  roundNumber: number
  passIndex: number
  runID: string
  result: {
    passed: boolean
    summary: string
    validatorResults: Array<{ validatorID: string; passed: boolean; summary: string }>
  }
  resultPath: string
}) {
  const entry = [
    `- round-${String(input.roundNumber).padStart(3, "0")} pass-${String(input.passIndex).padStart(2, "0")} | ${
      input.result.passed ? "通过" : "失败"
    } | ${short(input.result.summary, 200)}`,
    `  - 失败点: ${summarizeFailedValidators(input.result.validatorResults)}`,
    `  - run: ${input.runID}`,
    `  - result: ${input.resultPath}`,
  ].join("\n")
  if (!(await pathExists(input.path))) {
    await writeTextFile(
      input.path,
      "<!-- auto-evolve-role: acceptance_experience -->\n# 验收经验\n\n- 尚无验收记录\n",
    )
  }
  const raw = await readTextFile(input.path)
  const cleaned = raw.includes("- 尚无验收记录")
    ? raw.replace(/- 尚无验收记录\s*/g, "").trimEnd()
    : raw.trimEnd()
  await writeTextFile(input.path, `${cleaned}\n${entry}\n`)
}

function summarizeFailedValidatorsV2(
  validatorResults: Array<{ validatorID: string; passed: boolean; summary: string }>,
  limit = 3,
) {
  const failed = validatorResults.filter((item) => item.passed === false).slice(0, limit)
  if (!failed.length) return "all passed"
  return failed.map((item) => `${item.validatorID}: ${short(item.summary, 90)}`).join(" | ")
}

async function appendAcceptanceExperienceV2(input: {
  markdownPath: string
  jsonlPath: string
  roundNumber: number
  passIndex: number
  runID: string
  result: {
    passed: boolean
    summary: string
    validatorResults: Array<{ validatorID: string; passed: boolean; summary: string }>
  }
  resultPath: string
}) {
  const jsonEntry = {
    roundNumber: input.roundNumber,
    passIndex: input.passIndex,
    runID: input.runID,
    passed: input.result.passed,
    summary: input.result.summary,
    failedValidators: input.result.validatorResults.filter((item) => !item.passed).map((item) => item.validatorID),
    resultPath: input.resultPath,
    createdAt: nowISO(),
  }
  await appendJsonlLocked(input.jsonlPath, jsonEntry)

  const entry = [
    `- round-${String(input.roundNumber).padStart(3, "0")} pass-${String(input.passIndex).padStart(2, "0")} | ${
      input.result.passed ? "passed" : "failed"
    } | ${short(input.result.summary, 200)}`,
    `  - failed validators: ${summarizeFailedValidatorsV2(input.result.validatorResults)}`,
    `  - run: ${input.runID}`,
    `  - result: ${input.resultPath}`,
  ].join("\n")

  if (!(await pathExists(input.markdownPath))) {
    await writeTextFile(
      input.markdownPath,
      "<!-- auto-evolve-role: acceptance_experience -->\n# Acceptance Experience\n\n- no acceptance records yet\n",
    )
  }
  const raw = await readTextFile(input.markdownPath)
  const cleaned = raw.includes("- no acceptance records yet")
    ? raw.replace(/- no acceptance records yet\s*/g, "").trimEnd()
    : raw.trimEnd()
  await writeTextFile(input.markdownPath, `${cleaned}\n${entry}\n`)
}

async function promoteRoundPendingAndTreeToCurrent(input: {
  campaignPaths: ReturnType<typeof longTaskCampaignPaths>
  roundPaths: ReturnType<typeof longTaskCampaignRoundPaths>
  allowReadmeOnly?: boolean
  declaredSkill?: SkillBinding
}) {
  if (await hasEvolvedPendingPackage(input.roundPaths.pendingPackageSnapshotRoot, input.allowReadmeOnly, input.declaredSkill)) {
    await copyExperienceWorkspaceRoot(
      input.roundPaths.pendingPackageSnapshotRoot,
      input.campaignPaths.pendingCurrentRoot,
      { includeSurfaceContractRequiredPaths: true, declaredSkill: input.declaredSkill },
    )
  }
  const currentTree = await readLongTaskCampaignExplorationTree(input.campaignPaths)
  const currentRoutingControl = await readLongTaskCampaignRoutingControl(input.campaignPaths)
  let rawExplorationTree: unknown = currentTree
  if (await pathExists(input.roundPaths.explorationTreeDraftPath)) {
    try {
      rawExplorationTree = await readJsonFile<unknown>(input.roundPaths.explorationTreeDraftPath, {
        salvage: "extract-object",
      })
    } catch {
      // Agent-written JSON may have unescaped Windows backslashes; fall back to current
    }
  }
  const explorationTree = coerceExplorationTreeDocument(rawExplorationTree, currentTree)
  await writeLongTaskCampaignExplorationTree(input.campaignPaths, explorationTree)
  let rawRoutingControl: unknown = currentRoutingControl
  if (await pathExists(input.roundPaths.routingControlDraftPath)) {
    try {
      rawRoutingControl = await readJsonFile<unknown>(input.roundPaths.routingControlDraftPath, {
        salvage: "extract-object",
      })
    } catch {
      // Agent-written JSON may have unescaped Windows backslashes; fall back to current
    }
  }
  const routingControl = coerceRoutingControl(rawRoutingControl, currentRoutingControl)
  await writeLongTaskCampaignRoutingControl(input.campaignPaths, routingControl)
}

export async function runLongTaskCampaign(input: {
  cwd: string
  specPath: string
  forceNew?: boolean
  historyContext?: BenchmarkHistoryContext
  taskID?: string
  attemptID?: string
  specHash?: string
}): Promise<LongTaskCampaignRunResult> {
  if (process.env.AUTO_EVOLVE_SKIP_STALE_HEAL !== "1") await healStaleRuntimeStates(input.cwd)
  const { spec: campaignSpec } = await loadLongTaskCampaignSpec(input.specPath)
  const { spec: baseSpec } = await loadLongTaskSpec(campaignSpec.baseSpecPath)
  const expectedSpecHash = input.specHash ?? (await hashFileIfExists(campaignSpec.baseSpecPath))
  if (!input.forceNew) {
    const existingLiveCampaign = await findExistingLiveCampaign({
      cwd: input.cwd,
      title: campaignSpec.title,
      baseSpecPath: campaignSpec.baseSpecPath,
      historyContext: input.historyContext,
      taskID: input.taskID,
      specHash: expectedSpecHash,
    })
    if (existingLiveCampaign) {
      await prepareCampaignProtocol(existingLiveCampaign.campaignPaths.root, baseSpec, true, input.cwd)
      return toCampaignRunResult({
        campaignID: existingLiveCampaign.campaignID,
        campaignPaths: existingLiveCampaign.campaignPaths,
        state: existingLiveCampaign.state,
        attachedLive: true,
      })
    }
    const recoverableCampaign = await findRecoverableCampaignForTarget({
      cwd: input.cwd,
      title: campaignSpec.title,
      baseSpecPath: campaignSpec.baseSpecPath,
      historyContext: input.historyContext,
      taskID: input.taskID,
      specHash: expectedSpecHash,
    })
    if (recoverableCampaign) {
      return resumeLongTaskCampaign({
        cwd: input.cwd,
        campaignID: recoverableCampaign.campaignID,
        specPath: input.specPath,
        historyContext: input.historyContext,
        taskID: input.taskID,
      })
    }
  }
  const campaignID = createLongTaskCampaignID(campaignSpec.title)
  const campaignPaths = longTaskCampaignPaths(input.cwd, campaignID)

  const initialState: LongTaskCampaignState = {
    id: campaignID,
    title: campaignSpec.title,
    taskFamily: campaignSpec.taskFamily ?? baseSpec.taskFamily,
    mode: campaignSpec.mode,
    baseSpecPath: campaignSpec.baseSpecPath,
    maxRounds: campaignSpec.maxRounds,
    currentRound: 0,
    status: "bootstrapping",
    createdAt: nowISO(),
    updatedAt: nowISO(),
    notes: campaignSpec.notes,
    runLineage:
      input.historyContext && input.taskID && input.attemptID
        ? lineageForAttempt({
            context: input.historyContext,
            taskID: input.taskID,
            attemptID: input.attemptID,
            specHash: input.specHash,
          })
        : undefined,
    reuse: input.historyContext ? defaultReuseForPolicy(input.historyContext.historyPolicy) : undefined,
    recovery: undefined,
  }

  await initializeLongTaskCampaign(campaignPaths, initialState)
  await prepareCampaignProtocol(campaignPaths.root, baseSpec, false, input.cwd)
  if (input.historyContext && input.taskID && input.attemptID) {
    await registerCampaignAttempt({
      outDir: input.historyContext.outDir,
      taskID: input.taskID,
      attemptID: input.attemptID,
      campaignID,
      campaignDir: campaignPaths.root,
    })
  }
  enforceCampaignTruthPaths({ campaignPaths })
  await seedCampaignCurrentPendingPackage({
    declaredSkill: baseSpec.protocolAuthorContext?.skill,
    currentRoot: campaignPaths.pendingCurrentRoot,
    seedTarget: primaryExperienceWorkspaceSeedTarget(campaignSpec.seedTargets),
  })

  const history: LongTaskCampaignRoundRecord[] = []
  let lastRoundNumber = 0
  let lastRunID: string | undefined
  let lastRoundSummaryPath: string | undefined
  const startRound = 1

  try {
    for (let roundNumber = startRound; roundNumber <= campaignSpec.maxRounds; roundNumber += 1) {
      lastRoundNumber = roundNumber
      const roundRuntimeScope = campaignRoundRuntimeScope(campaignID, roundNumber)
      const roundPaths = longTaskCampaignRoundPaths(campaignPaths, roundNumber)
      const activateCampaignRound = onceActivationCallback(async () => {
        await updateCampaignStatus(campaignPaths, "running", {
          currentRound: roundNumber,
          lastSummary: history[history.length - 1]?.summary,
          lastRunID: history[history.length - 1]?.sourceRunID,
          lastRoundSummaryPath: history[history.length - 1]?.roundSummaryPath,
        })
      })
      const pulseCampaignRound = async () => {
        await pulseCampaignState(campaignPaths)
      }
      try {
        await ensureDirectory(roundPaths.root)
        await ensureDirectory(roundPaths.harvestedRoot)
        await ensureDirectory(roundPaths.snapshotsRoot)
        await ensureDirectory(roundPaths.workersRoot)
        await ensureDirectory(roundPaths.reviewerRoot)
        await ensureDirectory(roundPaths.finalAcceptanceRoot)
        enforceCampaignTruthPaths({ campaignPaths, roundPaths })
        await ensureBlankAgentAcceptanceDiagnosis(campaignPaths, roundNumber)

        await prepareCampaignRoundState({
          baseSpec,
          campaignSpec,
          campaignPaths,
        })
        await seedRoundPendingPackageFromCurrent({
          campaignPaths,
          roundPaths,
          declaredSkill: baseSpec.protocolAuthorContext?.skill,
          allowReadmeOnly: baseSpec.blankEvalExecutor?.kind === "single_turn_http",
        })
        await seedRoundExplorationTreeFromCurrent({
          campaignPaths,
          roundPaths,
        })
        await seedRoundRoutingControlFromCurrent({
          campaignPaths,
          roundPaths,
        })
        let dispatchTickets = await readDispatchTicketDocument(campaignPaths, roundNumber)

        const generatedSpec = buildGeneratedRoundSpec({
          baseSpec,
          campaignSpec,
          roundNumber,
          pendingPackageRoot: campaignPaths.pendingCurrentRoot,
          explorationTreePath: campaignPaths.explorationTreePath,
          workingMemoryPath: campaignPaths.campaignWorkingMemoryPath,
          routingControlPath: campaignPaths.campaignRoutingControlPath,
          dispatchTicketsPath: campaignPaths.dispatchTicketsPath,
          blankAgentAcceptanceDiagnosisPath: campaignPaths.blankAgentAcceptanceDiagnosisPath,
        })
        await writeJsonFile(roundPaths.generatedSpecPath, generatedSpec)

        await writeLongTaskCampaignState(campaignPaths, {
          ...initialState,
          currentRound: roundNumber,
          status: "bootstrapping",
          updatedAt: nowISO(),
          lastSummary: history[history.length - 1]?.summary,
          lastRunID: history[history.length - 1]?.sourceRunID,
          lastRoundSummaryPath: history[history.length - 1]?.roundSummaryPath,
        })

        const runResult = await runLongTask({
          cwd: input.cwd,
          specPath: roundPaths.generatedSpecPath,
          runtimeScope: roundRuntimeScope,
          onRuntimeActivated: activateCampaignRound,
          onRuntimePulse: pulseCampaignRound,
        })
        lastRunID = runResult.runID

        const harvested = await harvestRound({
          cwd: input.cwd,
          campaignID,
          campaignSpec,
          baseSpec,
          roundNumber,
          roundPaths,
          runResult,
          seedTargets: campaignRuntimeSeedTargets(campaignSpec),
        })
        history.push(harvested.roundRecord)
        lastRoundSummaryPath = harvested.roundRecord.roundSummaryPath
        await appendLongTaskCampaignHistory(campaignPaths, harvested.roundRecord)

        const noSignalDetection = detectConsecutiveNoSignalRounds(history, 2)
        if (noSignalDetection) {
          const nextState: LongTaskCampaignState = {
            ...initialState,
            currentRound: roundNumber,
            status: "failed",
            updatedAt: nowISO(),
            lastRunID: runResult.runID,
            lastSummary: `Detected repeated no-structured-signal failures (${noSignalDetection.threshold} consecutive rounds: ${noSignalDetection.startRound}-${noSignalDetection.endRound}); stopped campaign early.`,
            lastRoundSummaryPath: harvested.roundRecord.roundSummaryPath,
          }
          await writeLongTaskCampaignState(campaignPaths, nextState)
          return toCampaignRunResult({
            campaignID,
            campaignPaths,
            state: nextState,
            roundsCompleted: roundNumber,
          })
        }

        const loopDetection = detectRepeatedNoProgressLoop(history)
        if (loopDetection) {
          const nextState: LongTaskCampaignState = {
            ...initialState,
            currentRound: roundNumber,
            status: "failed",
            updatedAt: nowISO(),
            lastRunID: runResult.runID,
            lastSummary: `Detected repeated no-progress loop (${loopDetection.windowSize} rounds: ${loopDetection.startRound}-${loopDetection.endRound}); stopped campaign early.`,
            lastRoundSummaryPath: harvested.roundRecord.roundSummaryPath,
          }
          await writeLongTaskCampaignState(campaignPaths, nextState)
          return toCampaignRunResult({
            campaignID,
            campaignPaths,
            state: nextState,
            roundsCompleted: roundNumber,
          })
        }

        await appendLinesToAggregate(
          campaignPaths.aggregatedFailurePacketsPath,
          harvested.failurePackets.map((item) => JSON.stringify(item)),
        )
        await appendLinesToAggregate(
          campaignPaths.aggregatedRetryLessonsPath,
          harvested.retryLessons.map((item) => JSON.stringify(item)),
        )
        await appendLinesToAggregate(
          campaignPaths.aggregatedLearningUnitsPath,
          harvested.learningUnits.map((item) => JSON.stringify(item)),
        )

        const existingOperationalMemory = await readLongTaskCampaignOperationalMemory(campaignPaths)
        const promotedOperationalMemory = promoteCampaignOperationalMemory({
          existing: existingOperationalMemory,
          incoming: harvested.operationalContext,
          roundNumber,
          runID: runResult.runID,
        })
        await writeLongTaskCampaignOperationalMemory(campaignPaths, promotedOperationalMemory)
        const workingMemory = buildWorkingMemoryDocument({
          operationalMemory: promotedOperationalMemory,
          updatedThroughRound: roundNumber,
        })
        await writeLongTaskCampaignWorkingMemory(campaignPaths, workingMemory)

        const currentExplorationTree = await readLongTaskCampaignExplorationTree(campaignPaths)
        const evolvedExplorationTree = evolveExplorationTreeDocument({
          previous: currentExplorationTree,
          digest: harvested.runTraceDigest,
          roundNumber,
        })
        await writeJsonFile(roundPaths.explorationTreeDraftPath, evolvedExplorationTree)

        const currentRoutingControl = await readLongTaskCampaignRoutingControl(campaignPaths)
        const evolvedRoutingControl = buildRoutingControl({
          previous: currentRoutingControl,
          tree: evolvedExplorationTree,
          digest: harvested.runTraceDigest,
          dispatchTickets,
          roundNumber,
        })
        await writeJsonFile(roundPaths.routingControlDraftPath, evolvedRoutingControl)

        const allFailures = await readJsonLinesIfExists<Record<string, unknown>>(
          campaignPaths.aggregatedFailurePacketsPath,
        )
        const allRetryLessons = await readJsonLinesIfExists<Record<string, unknown>>(
          campaignPaths.aggregatedRetryLessonsPath,
        )
        const allLearningUnits = await readJsonLinesIfExists<Record<string, unknown>>(
          campaignPaths.aggregatedLearningUnitsPath,
        )
        const campaignLessons = buildCampaignLessonsMarkdown({
          title: campaignSpec.title,
          latestRound: roundNumber,
          records: history,
          failures: allFailures,
          retryLessons: allRetryLessons,
          learningUnits: allLearningUnits,
        })
        await writeLongTaskCampaignLessons(campaignPaths, campaignLessons)
        const lessonMirrors: Array<{ root: string; relativePath: string; addManifestPointer: boolean }> = []
        if (await pathExists(path.join(campaignPaths.pendingCurrentRoot, "manifest.md"))) {
          lessonMirrors.push({
            root: campaignPaths.pendingCurrentRoot,
            relativePath: "lessons/failure_lessons.md",
            addManifestPointer: true,
          })
        }
        if (campaignSpec.lessonsMirror) {
          lessonMirrors.push({
            root: path.resolve(campaignSpec.lessonsMirror.workspaceTargetPath),
            relativePath: campaignSpec.lessonsMirror.relativePath,
            addManifestPointer: campaignSpec.lessonsMirror.addManifestPointer !== false,
          })
        }
        const mirroredRoots = new Set<string>()
        for (const mirror of lessonMirrors) {
          const dedupeKey = `${mirror.root}::${mirror.relativePath}`
          if (mirroredRoots.has(dedupeKey)) continue
          mirroredRoots.add(dedupeKey)
          await syncLessonsMirror({
            lessonsContent: campaignLessons,
            workspaceTargetPath: mirror.root,
            lessonsRelativePath: mirror.relativePath,
            addManifestPointer: mirror.addManifestPointer,
            roundRecord: harvested.roundRecord,
          })
        }
        await writeTextFile(
          campaignPaths.carryoverFailurePacketsPath,
          buildFailurePacketsCarryoverMarkdown({
            title: campaignSpec.title,
            latestRound: roundNumber,
            records: history,
            failures: allFailures,
          }),
        )
        await writeTextFile(
          campaignPaths.carryoverRetryLessonsPath,
          buildRetryLessonsCarryoverMarkdown({
            title: campaignSpec.title,
            latestRound: roundNumber,
            records: history,
            retryLessons: allRetryLessons,
          }),
        )
        await writeTextFile(
          campaignPaths.carryoverLearningUnitsPath,
          buildLearningUnitsCarryoverMarkdown({
            title: campaignSpec.title,
            latestRound: roundNumber,
            records: history,
            learningUnits: allLearningUnits,
          }),
        )
        await writeLongTaskCampaignSeedContext(
          campaignPaths,
          buildCampaignSeedContextMarkdown({
            title: campaignSpec.title,
            latestRound: roundNumber,
            operationalMemory: promotedOperationalMemory,
            records: history,
          }),
        )

        const latestReviewerSuggestionPath = await readLatestReviewerSuggestionPath(campaignPaths)
        // Step 10: workers need the latest blank-agent evidence from previous round's failure.
        const priorProtocolFeedback = baseSpec.protocolPlugins
          ? await previousProtocolFeedback(campaignPaths.root, roundNumber, baseSpec.protocolPlugins.taskID, baseSpec.protocolPlugins.phase) : undefined
        const latestBlankEvidence = baseSpec.protocolPlugins
          ? priorProtocolFeedback ? path.join(path.dirname(priorProtocolFeedback), "protocol.training-feedback.json") : undefined
          : await readLatestBlankAgentEvidenceBundlePath(campaignPaths.root)
        const latestBlankEvidenceReadPaths = baseSpec.protocolPlugins
          ? await protocolFeedbackEvidence(priorProtocolFeedback) : latestBlankEvidence
          ? await readBlankAgentEvidenceReadablePaths(latestBlankEvidence)
          : []
        // Step 10b: workers may also read oracle paths from the latest final acceptance.
        // Read directly from round paths to get exact private view files etc.
        let latestFinalAcceptanceOraclePaths: string[] = []
        let latestFinalAcceptanceOracleBundlePath: string | undefined
        const latestFinalAcceptancePath = path.join(
          campaignPaths.root,
          "rounds",
          `round-${String(roundNumber - 1).padStart(3, "0")}`,
          "final-acceptance",
          "result.json",
        )
        if (!baseSpec.protocolPlugins && await pathExists(latestFinalAcceptancePath)) {
          try {
            const prev = await readJsonFile<Record<string, unknown>>(latestFinalAcceptancePath)
            if (typeof prev.expertOracleBundlePath === "string") {
              latestFinalAcceptanceOracleBundlePath = prev.expertOracleBundlePath
            }
            if (Array.isArray(prev.expertOracleReadPaths)) {
              latestFinalAcceptanceOraclePaths = prev.expertOracleReadPaths as string[]
            }
            const vrs = Array.isArray(prev.validatorResults) ? (prev.validatorResults as Array<Record<string, unknown>>) : []
            if ((!latestFinalAcceptanceOracleBundlePath || latestFinalAcceptanceOraclePaths.length === 0) && vrs.length) {
              const oracleBundle = await writeExpertOracleBundleFromValidatorResults({
                outPath: path.join(path.dirname(latestFinalAcceptancePath), "expert-oracle-bundle.json"),
                campaignID,
                roundNumber: roundNumber - 1,
                passID: "latest",
                resultPath: latestFinalAcceptancePath,
                validatorResults: vrs,
              })
              latestFinalAcceptanceOracleBundlePath = oracleBundle.bundlePath
              latestFinalAcceptanceOraclePaths = oracleBundle.oraclePaths
            }
          } catch {
            // ignore: previous round may not have final-acceptance yet
          }
        }
        // Step 11: collect carryover context from prior rounds so workers
        // can learn from past failures instead of repeating the same mistakes.
        const carryoverFiles = await collectCarryoverContext({
          baseSpec,
          campaignSpec,
          campaignPaths,
          history,
        })
        const workerSuggestions = shouldRunCampaignWorkers(roundNumber)
          ? await runCampaignWorkers({
              cwd: input.cwd,
              campaignID,
              campaignSpec,
              baseSpec,
              roundNumber,
              runTracePath: roundPaths.runTraceJsonPath,
              runTraceDigestPath: roundPaths.runTraceDigestPath,
              pendingPackageRoot: campaignPaths.pendingCurrentRoot,
              explorationTreePath: campaignPaths.explorationTreePath,
              workingMemoryPath: campaignPaths.campaignWorkingMemoryPath,
              routingControlPath: campaignPaths.campaignRoutingControlPath,
              dispatchTicketsPath: campaignPaths.dispatchTicketsPath,
              blankAgentAcceptanceDiagnosisPath: campaignPaths.blankAgentAcceptanceDiagnosisPath,
              acceptanceExperiencePath: campaignPaths.acceptanceExperiencePath,
              acceptanceExperienceJsonlPath: campaignPaths.acceptanceExperienceJsonlPath,
              reviewerSuggestionPath: latestReviewerSuggestionPath,
              blankAgentEvidenceBundlePath: latestBlankEvidence,
              blankAgentEvidenceReadPaths: latestBlankEvidenceReadPaths,
              expertOracleBundlePath: latestFinalAcceptanceOracleBundlePath,
              expertOracleReadPaths: latestFinalAcceptanceOraclePaths,
              campaignPaths,
              roundPaths,
              runtimeScope: roundRuntimeScope,
              onActivation: activateCampaignRound,
              onPulse: pulseCampaignRound,
              carryoverFiles,
            })
          : []

        let reviewerSuggestion: LongTaskCampaignReviewSuggestion | undefined
        let finalAcceptance: Awaited<ReturnType<typeof runCampaignFinalAcceptance>> | undefined
        let reviewerInputPath = latestReviewerSuggestionPath
        let finalAcceptanceFeedbackPath: string | undefined = priorProtocolFeedback
        const maxAcceptancePassesPerRound = 2

        for (let passIndex = 1; passIndex <= maxAcceptancePassesPerRound; passIndex += 1) {
          const passID = `pass-${String(passIndex).padStart(2, "0")}`
          const reviewerPassRoot = path.join(roundPaths.reviewerRoot, passID)
          const reviewerPassSuggestionPath = path.join(reviewerPassRoot, "review-suggestion.json")
          const acceptancePassRoot = path.join(roundPaths.finalAcceptanceRoot, passID)
          const acceptancePassResultPath = path.join(acceptancePassRoot, "result.json")

          // Dynamically resolve the current pass's evidence bundle:
          //   - If a previous pass in this round produced finalAcceptance with a
          //     fresh evidence bundle, prefer THAT (it reflects the most recent
          //     failure that this Lead/Reviewer is supposed to act on).
          //   - Otherwise, fall back to the round-start "latest" bundle (from
          //     a prior round's failure).
          // Without this override, Pass-02 Lead/Reviewer would still see the
          // stale Round-N-1 evidence while diagnosing Pass-01 failures.
          let currentEvidenceBundlePath: string | undefined = latestBlankEvidence
          let currentEvidenceReadPaths: string[] = latestBlankEvidenceReadPaths
          let currentOracleReadPaths: string[] = []
          let currentOracleBundlePath: string | undefined = latestFinalAcceptanceOracleBundlePath
          if (finalAcceptance) {
            const fa = finalAcceptance as Record<string, unknown>
            if (typeof fa.blankAgentEvidenceBundlePath === "string") {
              currentEvidenceBundlePath = fa.blankAgentEvidenceBundlePath
            }
            if (Array.isArray(fa.blankAgentEvidenceReadPaths)) {
              currentEvidenceReadPaths = fa.blankAgentEvidenceReadPaths as string[]
            } else if (currentEvidenceBundlePath) {
              currentEvidenceReadPaths = await readBlankAgentEvidenceReadablePaths(
                currentEvidenceBundlePath,
              )
            }

            // Compute expert oracle read paths from the current finalAcceptance.
            // These are exact-file oracle paths (result.private.json, etc.) and
            // are only granted to non-Blank working nodes (worker/lead/reviewer).
            if (typeof fa.expertOracleBundlePath === "string") {
              currentOracleBundlePath = fa.expertOracleBundlePath
            }
            if (Array.isArray(fa.expertOracleReadPaths)) {
              currentOracleReadPaths = fa.expertOracleReadPaths as string[]
            }
            if (!baseSpec.protocolPlugins && Array.isArray(fa.validatorResults)) {
              const vrs = fa.validatorResults as Array<Record<string, unknown>>
              if (!currentOracleBundlePath || currentOracleReadPaths.length === 0) {
                const oracleBundle = await writeExpertOracleBundleFromValidatorResults({
                  outPath: path.join(acceptancePassRoot, "expert-oracle-bundle.json"),
                  campaignID,
                  roundNumber,
                  passID,
                  resultPath: finalAcceptanceFeedbackPath,
                  validatorResults: vrs,
                })
                currentOracleBundlePath = oracleBundle.bundlePath
                currentOracleReadPaths = oracleBundle.oraclePaths
              }
            }
          }

          // Build repair checklist from previous pass failure for pass-02 lead
          let repairChecklist: string[] | undefined
          if ((passIndex >= 2 || baseSpec.protocolPlugins) && finalAcceptanceFeedbackPath) {
            try {
              const prevResult = await readJsonFile<Record<string, unknown>>(finalAcceptanceFeedbackPath)
              repairChecklist = buildRepairChecklistFromFinalAcceptance(prevResult)
            } catch {
              // If previous result is unreadable, lead will still get finalAcceptanceFeedbackPath
            }
          }

          await synchronizeProtocolLeadCandidate({
            enabled: Boolean(baseSpec.protocolPlugins),
            currentRoot: campaignPaths.pendingCurrentRoot,
            draftRoot: roundPaths.pendingPackageSnapshotRoot,
            skill: baseSpec.protocolAuthorContext?.skill,
          })
          const leadResult = await runCampaignLead({
            cwd: input.cwd,
            campaignSpec,
            baseSpec,
            roundNumber,
            runTracePath: roundPaths.runTraceJsonPath,
            runTraceDigestPath: roundPaths.runTraceDigestPath,
            previousPendingPackageRoot: campaignPaths.pendingCurrentRoot,
            nextPendingPackageRoot: roundPaths.pendingPackageSnapshotRoot,
            previousExplorationTreePath: campaignPaths.explorationTreePath,
            nextExplorationTreePath: roundPaths.explorationTreeDraftPath,
            workingMemoryPath: campaignPaths.campaignWorkingMemoryPath,
            previousRoutingControlPath: campaignPaths.campaignRoutingControlPath,
            nextRoutingControlPath: roundPaths.routingControlDraftPath,
            dispatchTicketsPath: campaignPaths.dispatchTicketsPath,
            blankAgentAcceptanceDiagnosisPath: campaignPaths.blankAgentAcceptanceDiagnosisPath,
            workerSuggestions,
            reviewerSuggestionPath: reviewerInputPath,
            acceptanceExperiencePath: campaignPaths.acceptanceExperiencePath,
            acceptanceExperienceJsonlPath: campaignPaths.acceptanceExperienceJsonlPath,
            finalAcceptanceFeedbackPath,
            repairChecklist,
            blankAgentEvidenceBundlePath: currentEvidenceBundlePath,
            blankAgentEvidenceReadPaths: currentEvidenceReadPaths,
            expertOracleBundlePath: currentOracleBundlePath,
            expertOracleReadPaths: currentOracleReadPaths,
            campaignPaths,
            roundPaths,
            runtimeScope: roundRuntimeScope,
            onActivation: activateCampaignRound,
            onPulse: pulseCampaignRound,
          })

          // Guard: if pass-02 lead had a repair checklist but updated no files, record it
          const leadUpdatedFiles: unknown[] = Array.isArray(leadResult.parsed?.updated_files)
            ? (leadResult.parsed!.updated_files as unknown[])
            : []
          const hadRepairChecklist = Boolean(repairChecklist && repairChecklist.length)
          if (passIndex >= 2 && hadRepairChecklist && leadUpdatedFiles.length === 0) {
            const existingOpMemory = await readLongTaskCampaignOperationalMemory(campaignPaths)
            existingOpMemory.push({
              id: `sys-warning-${roundNumber}-pass02-no-repair`,
              runID: runResult.runID,
              createdAt: nowISO(),
              updatedAt: nowISO(),
              kind: "failed_path",
              status: "candidate",
              statement: `Round ${roundNumber} pass-02 lead returned updated_files: [] despite ${repairChecklist!.length} repair items.`,
              rationale: "Lead did not act on pass-01 validation failures.",
              refs: [finalAcceptanceFeedbackPath].filter((p): p is string => Boolean(p)),
              tags: ["lead-pass02-no-repair"],
              roundNumber,
              lastRound: roundNumber,
              occurrenceCount: 1,
              sourceRunIDs: [runResult.runID],
            })
            await writeLongTaskCampaignOperationalMemory(campaignPaths, existingOpMemory)
          }

          await runSurfaceGeneralizationPrecheck({
            cwd: input.cwd,
            campaignSpec,
            baseSpec,
            campaignPaths,
            roundPaths,
            roundNumber,
            passID,
            runID: runResult.runID,
            runtimeScope: roundRuntimeScope,
            onActivation: activateCampaignRound,
            onPulse: pulseCampaignRound,
          })

          await promoteRoundPendingAndTreeToCurrent({
            campaignPaths,
            roundPaths,
            declaredSkill: baseSpec.protocolAuthorContext?.skill,
            allowReadmeOnly: baseSpec.blankEvalExecutor?.kind === "single_turn_http",
          })

          reviewerSuggestion = shouldRunCampaignReviewer(roundNumber)
            ? await runCampaignReviewer({
                cwd: input.cwd,
                campaignSpec,
                baseSpec,
                roundNumber,
                pendingPackageRoot: campaignPaths.pendingCurrentRoot,
                runTracePath: roundPaths.runTraceDigestPath,
                explorationTreePath: campaignPaths.explorationTreePath,
                workingMemoryPath: campaignPaths.campaignWorkingMemoryPath,
                routingControlPath: campaignPaths.campaignRoutingControlPath,
                dispatchTicketsPath: campaignPaths.dispatchTicketsPath,
                blankAgentAcceptanceDiagnosisPath: campaignPaths.blankAgentAcceptanceDiagnosisPath,
                acceptanceExperiencePath: campaignPaths.acceptanceExperiencePath,
                acceptanceExperienceJsonlPath: campaignPaths.acceptanceExperienceJsonlPath,
                blankAgentEvidenceBundlePath: currentEvidenceBundlePath,
                blankAgentEvidenceReadPaths: currentEvidenceReadPaths,
                expertOracleBundlePath: currentOracleBundlePath,
                expertOracleReadPaths: currentOracleReadPaths,
                stageDir: reviewerPassRoot,
                suggestionPath: reviewerPassSuggestionPath,
                roundPaths,
                runtimeScope: roundRuntimeScope,
                onActivation: activateCampaignRound,
                onPulse: pulseCampaignRound,
              })
            : undefined
          if (reviewerSuggestion) {
            await writeLongTaskCampaignReviewerSuggestion(campaignPaths, reviewerSuggestion)
            reviewerInputPath = reviewerPassSuggestionPath
            const currentRoutingControl = await readLongTaskCampaignRoutingControl(campaignPaths)
            await writeLongTaskCampaignRoutingControl(
              campaignPaths,
              buildRoutingControl({
                previous: currentRoutingControl,
                tree: await readLongTaskCampaignExplorationTree(campaignPaths),
                digest: harvested.runTraceDigest,
                reviewerSuggestion,
                dispatchTickets,
                roundNumber,
              }),
            )
          }

          if (!shouldRunCampaignReviewer(roundNumber)) break

          finalAcceptance = await runCampaignFinalAcceptance({
            cwd: input.cwd,
            campaignID,
            campaignSpec,
            baseSpec,
            baseSpecPath: campaignSpec.baseSpecPath,
            roundNumber,
            sourceRunID: runResult.runID,
            pendingPackageRoot: campaignPaths.pendingCurrentRoot,
            runTracePath: roundPaths.runTraceJsonPath,
            reviewerSuggestionPath: reviewerPassSuggestionPath,
            finalAcceptanceRoot: acceptancePassRoot,
            finalAcceptanceResultPath: acceptancePassResultPath,
            roundPaths,
            campaignPaths,
            passID,
            runtimeScope: roundRuntimeScope,
            onActivation: activateCampaignRound,
            onPulse: pulseCampaignRound,
          })
          await writeJsonFile(roundPaths.finalAcceptanceResultPath, finalAcceptance)
          // 训练反馈与审计恢复分开，避免回执路径进入修订工单。
          const trainingFeedbackPath = baseSpec.protocolPlugins
            ? String((finalAcceptance as Record<string, unknown>).protocolTrainingResultPath)
            : acceptancePassResultPath
          await appendAcceptanceExperienceV2({
            markdownPath: campaignPaths.acceptanceExperiencePath,
            jsonlPath: campaignPaths.acceptanceExperienceJsonlPath,
            roundNumber,
            passIndex,
            runID: runResult.runID,
            result: finalAcceptance,
            resultPath: trainingFeedbackPath,
          })
          dispatchTickets = mergeDispatchTicketsFromFinalAcceptance({
            previous: dispatchTickets,
            roundNumber,
            feedbackPath: trainingFeedbackPath,
            finalAcceptance,
          })
          await writeJsonFile(campaignPaths.dispatchTicketsPath, dispatchTickets)
          const routingAfterAcceptance = buildRoutingControl({
            previous: await readLongTaskCampaignRoutingControl(campaignPaths),
            tree: await readLongTaskCampaignExplorationTree(campaignPaths),
            digest: harvested.runTraceDigest,
            reviewerSuggestion,
            dispatchTickets,
            roundNumber,
          })
          await writeLongTaskCampaignRoutingControl(campaignPaths, routingAfterAcceptance)
          finalAcceptanceFeedbackPath = trainingFeedbackPath
          const acceptanceInfrastructureFailure = finalAcceptance.failureKind === "infrastructure_failure"
          const acceptanceDatasetFailure = finalAcceptance.failureKind === "dataset_failure"
          if (!finalAcceptance.passed && !acceptanceInfrastructureFailure && !acceptanceDatasetFailure) {
            await runBlankAgentAcceptanceDiagnosisWorker({
              cwd: input.cwd,
              campaignSpec,
              baseSpec,
              roundNumber,
              passID,
              runTracePath: roundPaths.runTraceJsonPath,
              runTraceDigestPath: roundPaths.runTraceDigestPath,
              pendingPackageRoot: campaignPaths.pendingCurrentRoot,
              explorationTreePath: campaignPaths.explorationTreePath,
              workingMemoryPath: campaignPaths.campaignWorkingMemoryPath,
              routingControlPath: campaignPaths.campaignRoutingControlPath,
              dispatchTicketsPath: campaignPaths.dispatchTicketsPath,
              blankAgentAcceptanceDiagnosisPath: campaignPaths.blankAgentAcceptanceDiagnosisPath,
              acceptanceExperiencePath: campaignPaths.acceptanceExperiencePath,
              acceptanceExperienceJsonlPath: campaignPaths.acceptanceExperienceJsonlPath,
              finalAcceptanceFeedbackPath,
              reviewerSuggestionPath: reviewerPassSuggestionPath,
              blankAgentEvidenceBundlePath: (finalAcceptance as Record<string, unknown>).blankAgentEvidenceBundlePath as string | undefined,
              blankAgentEvidenceReadPaths: (finalAcceptance as Record<string, unknown>).blankAgentEvidenceReadPaths as string[] | undefined,
              expertOracleBundlePath: (finalAcceptance as Record<string, unknown>).expertOracleBundlePath as string | undefined,
              expertOracleReadPaths: (finalAcceptance as Record<string, unknown>).expertOracleReadPaths as string[] | undefined,
              roundPaths,
              runtimeScope: roundRuntimeScope,
              onActivation: activateCampaignRound,
              onPulse: pulseCampaignRound,
            })
          }
          if (finalAcceptance.passed || acceptanceInfrastructureFailure || acceptanceDatasetFailure) break
        }

        const finalizedRoundRecord = finalizeRoundRecordWithAcceptance({
          roundRecord: harvested.roundRecord,
          finalAcceptance,
          feedbackPath: finalAcceptanceFeedbackPath,
        })
        harvested.roundRecord = finalizedRoundRecord
        history[history.length - 1] = finalizedRoundRecord
        await rewriteLongTaskCampaignHistoryRecord(campaignPaths, roundNumber, () => finalizedRoundRecord)
        await writeTextFile(
          roundPaths.roundSummaryPath,
          buildRoundSummaryMarkdown({
            roundNumber,
            mode: campaignSpec.mode,
            finalStatus: finalizedRoundRecord.finalStatus,
            summary: finalizedRoundRecord.summary,
            runVerificationSignal: finalizedRoundRecord.runVerificationSignal,
            roundClosure: finalizedRoundRecord.roundClosure,
            gateFailureKind: finalizedRoundRecord.gateFailureKind,
            gateFailureSummary: finalizedRoundRecord.gateFailureSummary,
            finalAcceptanceSignal: finalizedRoundRecord.finalAcceptanceSignal,
            failures: harvested.failurePackets,
            retryLessons: harvested.retryLessons,
            learningUnits: harvested.learningUnits,
          }),
        )

        const acceptanceInfrastructureFailure = finalAcceptance?.failureKind === "infrastructure_failure"
        const acceptanceDatasetFailure = finalAcceptance?.failureKind === "dataset_failure"
        const nextStatus =
          acceptanceInfrastructureFailure || acceptanceDatasetFailure
            ? "failed"
            : finalAcceptance?.passed === true
            ? "verified_success"
            : roundNumber >= campaignSpec.maxRounds
              ? "round_limit_reached"
              : "running"
        const lastRoundClosure =
          acceptanceInfrastructureFailure
            ? "closed_infra_failure"
            : acceptanceDatasetFailure
            ? "closed_dataset_failure"
            : finalAcceptance?.passed === true
            ? "closed_success"
            : finalAcceptance
              ? "closed_repairable"
              : (finalizedRoundRecord.roundClosure ?? "closed_blocked")
        const lastGateFailureKind =
          acceptanceInfrastructureFailure
            ? "infrastructure_failure"
            : acceptanceDatasetFailure
            ? "dataset_failure"
            : finalAcceptance && !finalAcceptance.passed
            ? "final_acceptance_failed"
            : finalizedRoundRecord.gateFailureKind
        const lastGateFailureSummary =
          finalAcceptance && !finalAcceptance.passed
            ? finalAcceptance.summary
            : finalizedRoundRecord.gateFailureSummary
        const lastRunHardVerified =
          finalizedRoundRecord.runVerificationSignal?.completionGateMode === "required" &&
          finalizedRoundRecord.runVerificationSignal?.completionGatePassed === true

        const state: LongTaskCampaignState = {
          ...initialState,
          currentRound: roundNumber,
          status: nextStatus,
          updatedAt: nowISO(),
          lastRunID: runResult.runID,
          lastSummary: finalAcceptance?.summary ?? finalizedRoundRecord.summary,
          lastRoundSummaryPath: finalizedRoundRecord.roundSummaryPath,
          lastRunHardVerified,
          lastFinalAcceptancePassed: finalAcceptance?.passed === true,
          lastFinalAcceptanceResultPath: baseSpec.protocolPlugins && finalAcceptance
            ? String((finalAcceptance as Record<string, unknown>).protocolAuditResultPath)
            : finalAcceptanceFeedbackPath,
          lastRoundClosure,
          lastGateFailureKind,
          lastGateFailureSummary,
          recovery: acceptanceInfrastructureFailure
            ? {
                action: "harvest_round_run",
                roundNumber,
                runID: runResult.runID,
                reason: `Round ${roundID(roundNumber)} stopped at final acceptance because validator infrastructure failed. Resume only after the platform fix; reuse the completed inner run instead of starting a new learning round.`,
                detectedAt: nowISO(),
              }
            : undefined,
        }
        await writeLongTaskCampaignState(campaignPaths, state)

        if (nextStatus === "verified_success") {
          return toCampaignRunResult({
            campaignID,
            campaignPaths,
            state,
            roundsCompleted: roundNumber,
          })
        }
        if (nextStatus === "failed") {
          return toCampaignRunResult({
            campaignID,
            campaignPaths,
            state,
            roundsCompleted: roundNumber,
          })
        }
      } finally {
        await cleanupRuntimeScopeWithRetry(roundRuntimeScope)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failureState: LongTaskCampaignState = {
      ...initialState,
      currentRound: lastRoundNumber,
      status: "failed",
      updatedAt: nowISO(),
      lastRunID,
      lastSummary: `Campaign aborted unexpectedly: ${short(message, 240)}`,
      lastRoundSummaryPath,
    }
    await writeLongTaskCampaignState(campaignPaths, failureState)
    return toCampaignRunResult({
      campaignID,
      campaignPaths,
      state: failureState,
      roundsCompleted: history.length,
    })
  }

  const finalState: LongTaskCampaignState = {
    ...initialState,
    currentRound: campaignSpec.maxRounds,
    status: "round_limit_reached",
    updatedAt: nowISO(),
    lastRunID: history[history.length - 1]?.sourceRunID,
    lastSummary: history[history.length - 1]?.summary,
    lastRoundSummaryPath: history[history.length - 1]?.roundSummaryPath,
  }
  await writeLongTaskCampaignState(campaignPaths, finalState)

  return toCampaignRunResult({
    campaignID,
    campaignPaths,
    state: finalState,
    roundsCompleted: campaignSpec.maxRounds,
  })
}

export async function resumeLongTaskCampaign(input: {
  cwd: string
  campaignID: string
  specPath: string
  historyContext?: BenchmarkHistoryContext
  taskID?: string
}): Promise<LongTaskCampaignRunResult> {
  if (process.env.AUTO_EVOLVE_SKIP_STALE_HEAL !== "1") await healStaleRuntimeStates(input.cwd)
  const { spec: campaignSpec } = await loadLongTaskCampaignSpec(input.specPath)
  const { spec: baseSpec } = await loadLongTaskSpec(campaignSpec.baseSpecPath)
  const campaignPaths = longTaskCampaignPaths(input.cwd, input.campaignID)
  if (!(await pathExists(campaignPaths.campaignStatePath))) {
    throw new Error(`Campaign not found: ${input.campaignID}`)
  }
  enforceCampaignTruthPaths({ campaignPaths })
  let existingState = await readLongTaskCampaignState(campaignPaths)
  await prepareCampaignProtocol(campaignPaths.root, baseSpec, true, input.cwd)
  const expectedSpecHash = await hashFileIfExists(campaignSpec.baseSpecPath)
  if (input.historyContext && !isCampaignAuthorizedForContext(existingState, input.historyContext, input.taskID, expectedSpecHash)) {
    throw new Error(
      `Resume blocked by history scope: campaign ${input.campaignID} is not authorized for run ${input.historyContext.runID}/${input.historyContext.generationID}.`,
    )
  }
  const specBaseResolved = path.resolve(campaignSpec.baseSpecPath)
  const stateBaseResolved = path.resolve(existingState.baseSpecPath)
  if (specBaseResolved !== stateBaseResolved) {
    throw new Error(
      `Resume spec mismatch: campaign base spec is ${existingState.baseSpecPath}, but provided spec points to ${campaignSpec.baseSpecPath}.`,
    )
  }
  if (existingState.mode !== campaignSpec.mode) {
    throw new Error(
      `Resume spec mismatch: campaign mode is ${existingState.mode}, but provided spec mode is ${campaignSpec.mode}.`,
    )
  }

  if (existingState.status === "verified_success" || existingState.status === "round_limit_reached") {
    if (baseSpec.protocolPlugins && existingState.status === "verified_success") {
      if (!existingState.lastFinalAcceptanceResultPath || !existingState.lastRunID) throw new Error("Completed Campaign acceptance identity missing")
      await verifyCompletedCampaignAcceptance({ campaignRoot: campaignPaths.root, cwd: input.cwd,
        campaignID: input.campaignID, roundNumber: existingState.currentRound, runID: existingState.lastRunID,
        entry: baseSpec.protocolPlugins, candidateRoot: campaignPaths.pendingCurrentRoot,
        resultPath: existingState.lastFinalAcceptanceResultPath })
    }
    return toCampaignRunResult({
      campaignID: input.campaignID,
      campaignPaths,
      state: existingState,
    })
  }

  let history = await readJsonLinesIfExists<LongTaskCampaignRoundRecord>(campaignPaths.historyPath)
  const targetHealth = await readCampaignHealth(campaignPaths.root)
  if (targetHealth?.suggestedAction === "takeover") {
    const takeoverAt = nowISO()
    const ownerPID =
      typeof existingState.ownerPID === "number" && Number.isFinite(existingState.ownerPID) && existingState.ownerPID > 0
        ? existingState.ownerPID
        : undefined
    const owned =
      typeof ownerPID === "number" && ownerPID !== process.pid
        ? await identifyCampaignOwnerProcess({
            pid: ownerPID,
            useCase: "kill",
            commandHint: existingState.ownerCommandHint,
            expectedCreationTick: existingState.ownerCreationTick,
            heartbeatAt: existingState.heartbeatAt,
            updatedAt: existingState.updatedAt,
            campaignID: input.campaignID,
            campaignRoot: campaignPaths.root,
            baseSpecPath: existingState.baseSpecPath,
          })
        : false
    if (owned && typeof ownerPID === "number") {
      await terminateProcessTree(ownerPID)
    }
    const recovery =
      (await determineCampaignRecoveryDecision({
        cwd: input.cwd,
        campaignPaths,
        state: existingState,
        history,
      })) ??
      ({
        action: "restart_round",
        roundNumber: Math.max(1, existingState.currentRound || 1),
        reason:
          owned && typeof ownerPID === "number"
            ? `Campaign owner process ${ownerPID} was alive but had stale heartbeat/artifacts; terminated its process tree and marked the campaign for takeover recovery.`
            : "Campaign owner appeared stuck by shared health policy; marked the campaign for takeover recovery without terminating because ownership could not be confirmed.",
        detectedAt: takeoverAt,
      } satisfies LongTaskCampaignRecoveryDecision)
    await writeLongTaskCampaignState(campaignPaths, {
      ...existingState,
      status: "recovery_pending",
      // Recovery markers are queue state, not live ownership. Clear owner
      // fields so health checks do not attribute this campaign to the
      // supervisor/resume process that merely detected the issue.
      ownerPID: undefined,
      ownerCommandHint: undefined,
      ownerCreationTick: undefined,
      heartbeatAt: takeoverAt,
      updatedAt: takeoverAt,
      lastSummary: recovery.reason,
      recovery,
    })
    existingState = await readLongTaskCampaignState(campaignPaths)
    history = await readJsonLinesIfExists<LongTaskCampaignRoundRecord>(campaignPaths.historyPath)
  }

  const existingLiveCampaign = await findExistingLiveCampaign({
    cwd: input.cwd,
    title: existingState.title,
    baseSpecPath: existingState.baseSpecPath,
    historyContext: input.historyContext,
    taskID: input.taskID,
  })
  if (existingLiveCampaign && existingLiveCampaign.campaignID === input.campaignID) {
    return toCampaignRunResult({
      campaignID: existingLiveCampaign.campaignID,
      campaignPaths: existingLiveCampaign.campaignPaths,
      state: existingLiveCampaign.state,
      attachedLive: true,
    })
  }

  const recoveryPlan = await determineCampaignRecoveryDecision({
    cwd: input.cwd,
    campaignPaths,
    state: existingState,
    history,
  })
  if (recoveryPlan && hasLegacyCampaignRecoveryAction(existingState)) {
    await writeLongTaskCampaignState(campaignPaths, {
      ...existingState,
      ownerPID: undefined,
      ownerCommandHint: undefined,
      ownerCreationTick: undefined,
      heartbeatAt: undefined,
      updatedAt: nowISO(),
      lastSummary: `Normalized legacy recovery marker: ${recoveryPlan.reason}`,
      recovery: recoveryPlan,
    })
  }
  const completedRound = history.reduce((max, item) => Math.max(max, item.roundNumber), 0)
  const startRound = recoveryPlan
    ? recoveryPlan.roundNumber
    : Math.max(existingState.currentRound, completedRound + 1)
  if (startRound > campaignSpec.maxRounds) {
    const cappedState: LongTaskCampaignState = {
      ...existingState,
      maxRounds: campaignSpec.maxRounds,
      status: "round_limit_reached",
      currentRound: campaignSpec.maxRounds,
      updatedAt: nowISO(),
      lastSummary: existingState.lastSummary ?? "Campaign reached maxRounds before resume.",
    }
    await writeLongTaskCampaignState(campaignPaths, cappedState)
    return toCampaignRunResult({
      campaignID: input.campaignID,
      campaignPaths,
      state: cappedState,
      roundsCompleted: campaignSpec.maxRounds,
    })
  }

  const initialState: LongTaskCampaignState = {
    ...existingState,
    mode: campaignSpec.mode,
    taskFamily: campaignSpec.taskFamily ?? baseSpec.taskFamily ?? existingState.taskFamily,
    maxRounds: campaignSpec.maxRounds,
    currentRound: Math.max(0, startRound - 1),
    status: "bootstrapping",
    ownerPID: undefined,
    ownerCommandHint: undefined,
    ownerCreationTick: undefined,
    heartbeatAt: undefined,
    updatedAt: nowISO(),
    notes: campaignSpec.notes ?? existingState.notes,
    recovery: undefined,
  }

  let lastRoundNumber = initialState.currentRound
  let lastRunID = existingState.lastRunID
  let lastRoundSummaryPath = existingState.lastRoundSummaryPath

  try {
    for (let roundNumber = startRound; roundNumber <= campaignSpec.maxRounds; roundNumber += 1) {
      lastRoundNumber = roundNumber
      const activeRecoveryPlan = recoveryPlan && recoveryPlan.roundNumber === roundNumber ? recoveryPlan : undefined
      const roundRuntimeScope = campaignRoundRuntimeScope(input.campaignID, roundNumber)
      const roundPaths = longTaskCampaignRoundPaths(campaignPaths, roundNumber)
      const activateCampaignRound = onceActivationCallback(async () => {
        await updateCampaignStatus(campaignPaths, "running", {
          currentRound: roundNumber,
          lastSummary: history[history.length - 1]?.summary,
          lastRunID: history[history.length - 1]?.sourceRunID,
          lastRoundSummaryPath: history[history.length - 1]?.roundSummaryPath,
        })
      })
      const pulseCampaignRound = async () => {
        await pulseCampaignState(campaignPaths)
      }
      try {
        await ensureDirectory(roundPaths.root)
        await ensureDirectory(roundPaths.harvestedRoot)
        await ensureDirectory(roundPaths.snapshotsRoot)
        await ensureDirectory(roundPaths.workersRoot)
        await ensureDirectory(roundPaths.reviewerRoot)
        await ensureDirectory(roundPaths.finalAcceptanceRoot)
        enforceCampaignTruthPaths({ campaignPaths, roundPaths })
        await ensureBlankAgentAcceptanceDiagnosis(campaignPaths, roundNumber)

        await prepareCampaignRoundState({
          baseSpec,
          campaignSpec,
          campaignPaths,
        })
        await seedRoundPendingPackageFromCurrent({
          campaignPaths,
          roundPaths,
          declaredSkill: baseSpec.protocolAuthorContext?.skill,
          allowReadmeOnly: baseSpec.blankEvalExecutor?.kind === "single_turn_http",
        })
        await seedRoundExplorationTreeFromCurrent({
          campaignPaths,
          roundPaths,
        })
        await seedRoundRoutingControlFromCurrent({
          campaignPaths,
          roundPaths,
        })
        let dispatchTickets = await readDispatchTicketDocument(campaignPaths, roundNumber)

        const generatedSpec = buildGeneratedRoundSpec({
          baseSpec,
          campaignSpec,
          roundNumber,
          pendingPackageRoot: campaignPaths.pendingCurrentRoot,
          explorationTreePath: campaignPaths.explorationTreePath,
          workingMemoryPath: campaignPaths.campaignWorkingMemoryPath,
          routingControlPath: campaignPaths.campaignRoutingControlPath,
          dispatchTicketsPath: campaignPaths.dispatchTicketsPath,
          blankAgentAcceptanceDiagnosisPath: campaignPaths.blankAgentAcceptanceDiagnosisPath,
        })
        await writeJsonFile(roundPaths.generatedSpecPath, generatedSpec)

        await writeLongTaskCampaignState(campaignPaths, {
          ...initialState,
          currentRound: roundNumber,
          status: "bootstrapping",
          updatedAt: nowISO(),
          lastSummary: activeRecoveryPlan?.reason ?? history[history.length - 1]?.summary,
          lastRunID: history[history.length - 1]?.sourceRunID,
          lastRoundSummaryPath: history[history.length - 1]?.roundSummaryPath,
        })

        const runResult =
          activeRecoveryPlan?.action === "resume_round_run" && activeRecoveryPlan.runID
            ? await resumeLongTask({
                cwd: input.cwd,
                runID: activeRecoveryPlan.runID,
                runtimeScope: roundRuntimeScope,
                onRuntimeActivated: activateCampaignRound,
                onRuntimePulse: pulseCampaignRound,
              })
            : activeRecoveryPlan?.action === "harvest_round_run" && activeRecoveryPlan.runID
              ? await rehydrateExistingLongTaskRunResult({
                  cwd: input.cwd,
                  runID: activeRecoveryPlan.runID,
                })
                : await runLongTask({
                    cwd: input.cwd,
                    specPath: roundPaths.generatedSpecPath,
                    runtimeScope: roundRuntimeScope,
                    onRuntimeActivated: activateCampaignRound,
                    onRuntimePulse: pulseCampaignRound,
                  })
        lastRunID = runResult.runID

        const harvested = await harvestRound({
          cwd: input.cwd,
          campaignID: input.campaignID,
          campaignSpec,
          baseSpec,
          roundNumber,
          roundPaths,
          runResult,
          seedTargets: campaignRuntimeSeedTargets(campaignSpec),
        })
        const existingRoundIndex = history.findIndex((record) => record.roundNumber === roundNumber)
        if (existingRoundIndex >= 0) {
          history[existingRoundIndex] = harvested.roundRecord
        } else {
          history.push(harvested.roundRecord)
        }
        lastRoundSummaryPath = harvested.roundRecord.roundSummaryPath
        if (existingRoundIndex < 0) {
          await appendLongTaskCampaignHistory(campaignPaths, harvested.roundRecord)
        }

        const noSignalDetection = detectConsecutiveNoSignalRounds(history, 2)
        if (noSignalDetection) {
          const nextState: LongTaskCampaignState = {
            ...initialState,
            currentRound: roundNumber,
            status: "failed",
            updatedAt: nowISO(),
            lastRunID: runResult.runID,
            lastSummary: `Detected repeated no-structured-signal failures (${noSignalDetection.threshold} consecutive rounds: ${noSignalDetection.startRound}-${noSignalDetection.endRound}); stopped campaign early.`,
            lastRoundSummaryPath: harvested.roundRecord.roundSummaryPath,
          }
          await writeLongTaskCampaignState(campaignPaths, nextState)
          return toCampaignRunResult({
            campaignID: input.campaignID,
            campaignPaths,
            state: nextState,
            roundsCompleted: roundNumber,
          })
        }

        const loopDetection = detectRepeatedNoProgressLoop(history)
        if (loopDetection) {
          const nextState: LongTaskCampaignState = {
            ...initialState,
            currentRound: roundNumber,
            status: "failed",
            updatedAt: nowISO(),
            lastRunID: runResult.runID,
            lastSummary: `Detected repeated no-progress loop (${loopDetection.windowSize} rounds: ${loopDetection.startRound}-${loopDetection.endRound}); stopped campaign early.`,
            lastRoundSummaryPath: harvested.roundRecord.roundSummaryPath,
          }
          await writeLongTaskCampaignState(campaignPaths, nextState)
          return toCampaignRunResult({
            campaignID: input.campaignID,
            campaignPaths,
            state: nextState,
            roundsCompleted: roundNumber,
          })
        }

        await appendLinesToAggregate(
          campaignPaths.aggregatedFailurePacketsPath,
          harvested.failurePackets.map((item) => JSON.stringify(item)),
        )
        await appendLinesToAggregate(
          campaignPaths.aggregatedRetryLessonsPath,
          harvested.retryLessons.map((item) => JSON.stringify(item)),
        )
        await appendLinesToAggregate(
          campaignPaths.aggregatedLearningUnitsPath,
          harvested.learningUnits.map((item) => JSON.stringify(item)),
        )

        const existingOperationalMemory = await readLongTaskCampaignOperationalMemory(campaignPaths)
        const promotedOperationalMemory = promoteCampaignOperationalMemory({
          existing: existingOperationalMemory,
          incoming: harvested.operationalContext,
          roundNumber,
          runID: runResult.runID,
        })
        await writeLongTaskCampaignOperationalMemory(campaignPaths, promotedOperationalMemory)
        const workingMemory = buildWorkingMemoryDocument({
          operationalMemory: promotedOperationalMemory,
          updatedThroughRound: roundNumber,
        })
        await writeLongTaskCampaignWorkingMemory(campaignPaths, workingMemory)

        const currentExplorationTree = await readLongTaskCampaignExplorationTree(campaignPaths)
        const evolvedExplorationTree = evolveExplorationTreeDocument({
          previous: currentExplorationTree,
          digest: harvested.runTraceDigest,
          roundNumber,
        })
        await writeJsonFile(roundPaths.explorationTreeDraftPath, evolvedExplorationTree)

        const currentRoutingControl = await readLongTaskCampaignRoutingControl(campaignPaths)
        const evolvedRoutingControl = buildRoutingControl({
          previous: currentRoutingControl,
          tree: evolvedExplorationTree,
          digest: harvested.runTraceDigest,
          dispatchTickets,
          roundNumber,
        })
        await writeJsonFile(roundPaths.routingControlDraftPath, evolvedRoutingControl)

        const allFailures = await readJsonLinesIfExists<Record<string, unknown>>(
          campaignPaths.aggregatedFailurePacketsPath,
        )
        const allRetryLessons = await readJsonLinesIfExists<Record<string, unknown>>(
          campaignPaths.aggregatedRetryLessonsPath,
        )
        const allLearningUnits = await readJsonLinesIfExists<Record<string, unknown>>(
          campaignPaths.aggregatedLearningUnitsPath,
        )
        const campaignLessons = buildCampaignLessonsMarkdown({
          title: campaignSpec.title,
          latestRound: roundNumber,
          records: history,
          failures: allFailures,
          retryLessons: allRetryLessons,
          learningUnits: allLearningUnits,
        })
        await writeLongTaskCampaignLessons(campaignPaths, campaignLessons)
        const lessonMirrors: Array<{ root: string; relativePath: string; addManifestPointer: boolean }> = []
        if (await pathExists(path.join(campaignPaths.pendingCurrentRoot, "manifest.md"))) {
          lessonMirrors.push({
            root: campaignPaths.pendingCurrentRoot,
            relativePath: "lessons/failure_lessons.md",
            addManifestPointer: true,
          })
        }
        if (campaignSpec.lessonsMirror) {
          lessonMirrors.push({
            root: path.resolve(campaignSpec.lessonsMirror.workspaceTargetPath),
            relativePath: campaignSpec.lessonsMirror.relativePath,
            addManifestPointer: campaignSpec.lessonsMirror.addManifestPointer !== false,
          })
        }
        const mirroredRoots = new Set<string>()
        for (const mirror of lessonMirrors) {
          const dedupeKey = `${mirror.root}::${mirror.relativePath}`
          if (mirroredRoots.has(dedupeKey)) continue
          mirroredRoots.add(dedupeKey)
          await syncLessonsMirror({
            lessonsContent: campaignLessons,
            workspaceTargetPath: mirror.root,
            lessonsRelativePath: mirror.relativePath,
            addManifestPointer: mirror.addManifestPointer,
            roundRecord: harvested.roundRecord,
          })
        }
        await writeTextFile(
          campaignPaths.carryoverFailurePacketsPath,
          buildFailurePacketsCarryoverMarkdown({
            title: campaignSpec.title,
            latestRound: roundNumber,
            records: history,
            failures: allFailures,
          }),
        )
        await writeTextFile(
          campaignPaths.carryoverRetryLessonsPath,
          buildRetryLessonsCarryoverMarkdown({
            title: campaignSpec.title,
            latestRound: roundNumber,
            records: history,
            retryLessons: allRetryLessons,
          }),
        )
        await writeTextFile(
          campaignPaths.carryoverLearningUnitsPath,
          buildLearningUnitsCarryoverMarkdown({
            title: campaignSpec.title,
            latestRound: roundNumber,
            records: history,
            learningUnits: allLearningUnits,
          }),
        )
        await writeLongTaskCampaignSeedContext(
          campaignPaths,
          buildCampaignSeedContextMarkdown({
            title: campaignSpec.title,
            latestRound: roundNumber,
            operationalMemory: promotedOperationalMemory,
            records: history,
          }),
        )

        const latestReviewerSuggestionPath = await readLatestReviewerSuggestionPath(campaignPaths)
        const priorProtocolFeedback = baseSpec.protocolPlugins
          ? await previousProtocolFeedback(campaignPaths.root, roundNumber, baseSpec.protocolPlugins.taskID, baseSpec.protocolPlugins.phase) : undefined
        const latestBlankEvidence = baseSpec.protocolPlugins
          ? priorProtocolFeedback ? path.join(path.dirname(priorProtocolFeedback), "protocol.training-feedback.json") : undefined
          : await readLatestBlankAgentEvidenceBundlePath(campaignPaths.root)
        const latestBlankEvidenceReadPaths = baseSpec.protocolPlugins
          ? await protocolFeedbackEvidence(priorProtocolFeedback) : latestBlankEvidence
          ? await readBlankAgentEvidenceReadablePaths(latestBlankEvidence)
          : []
        // Collect oracle read paths from the latest final acceptance (replay-style campaign).
        let latestFinalAcceptanceOraclePaths: string[] = []
        let latestFinalAcceptanceOracleBundlePath: string | undefined
        const latestFinalAcceptancePath = path.join(
          campaignPaths.root,
          "rounds",
          `round-${String(roundNumber - 1).padStart(3, "0")}`,
          "final-acceptance",
          "result.json",
        )
        if (!baseSpec.protocolPlugins && await pathExists(latestFinalAcceptancePath)) {
          try {
            const prev = await readJsonFile<Record<string, unknown>>(latestFinalAcceptancePath)
            if (typeof prev.expertOracleBundlePath === "string") {
              latestFinalAcceptanceOracleBundlePath = prev.expertOracleBundlePath
            }
            if (Array.isArray(prev.expertOracleReadPaths)) {
              latestFinalAcceptanceOraclePaths = prev.expertOracleReadPaths as string[]
            }
            const vrs = Array.isArray(prev.validatorResults) ? (prev.validatorResults as Array<Record<string, unknown>>) : []
            if ((!latestFinalAcceptanceOracleBundlePath || latestFinalAcceptanceOraclePaths.length === 0) && vrs.length) {
              const oracleBundle = await writeExpertOracleBundleFromValidatorResults({
                outPath: path.join(path.dirname(latestFinalAcceptancePath), "expert-oracle-bundle.json"),
                campaignID: input.campaignID,
                roundNumber: roundNumber - 1,
                passID: "latest",
                resultPath: latestFinalAcceptancePath,
                validatorResults: vrs,
              })
              latestFinalAcceptanceOracleBundlePath = oracleBundle.bundlePath
              latestFinalAcceptanceOraclePaths = oracleBundle.oraclePaths
            }
          } catch {
            // ignore: previous round may not have final-acceptance yet
          }
        }
        // Collect carryover context from prior rounds so workers can learn
        // from past failures instead of repeating the same mistakes.
        const carryoverFiles = await collectCarryoverContext({
          baseSpec,
          campaignSpec,
          campaignPaths,
          history,
        })
        const workerSuggestions = shouldRunCampaignWorkers(roundNumber)
          ? await runCampaignWorkers({
              cwd: input.cwd,
              campaignID: input.campaignID,
              campaignSpec,
              baseSpec,
              roundNumber,
              runTracePath: roundPaths.runTraceJsonPath,
              runTraceDigestPath: roundPaths.runTraceDigestPath,
              pendingPackageRoot: campaignPaths.pendingCurrentRoot,
              explorationTreePath: campaignPaths.explorationTreePath,
              workingMemoryPath: campaignPaths.campaignWorkingMemoryPath,
              routingControlPath: campaignPaths.campaignRoutingControlPath,
              dispatchTicketsPath: campaignPaths.dispatchTicketsPath,
              blankAgentAcceptanceDiagnosisPath: campaignPaths.blankAgentAcceptanceDiagnosisPath,
              acceptanceExperiencePath: campaignPaths.acceptanceExperiencePath,
              acceptanceExperienceJsonlPath: campaignPaths.acceptanceExperienceJsonlPath,
              reviewerSuggestionPath: latestReviewerSuggestionPath,
              blankAgentEvidenceBundlePath: latestBlankEvidence,
              blankAgentEvidenceReadPaths: latestBlankEvidenceReadPaths,
              expertOracleBundlePath: latestFinalAcceptanceOracleBundlePath,
              expertOracleReadPaths: latestFinalAcceptanceOraclePaths,
              campaignPaths,
              roundPaths,
              runtimeScope: roundRuntimeScope,
              onActivation: activateCampaignRound,
              onPulse: pulseCampaignRound,
              carryoverFiles,
            })
          : []

        let reviewerSuggestion: LongTaskCampaignReviewSuggestion | undefined
        let finalAcceptance: Awaited<ReturnType<typeof runCampaignFinalAcceptance>> | undefined
        let reviewerInputPath = latestReviewerSuggestionPath
        let finalAcceptanceFeedbackPath: string | undefined = priorProtocolFeedback
        const maxAcceptancePassesPerRound = 2

        for (let passIndex = 1; passIndex <= maxAcceptancePassesPerRound; passIndex += 1) {
          const passID = `pass-${String(passIndex).padStart(2, "0")}`
          const reviewerPassRoot = path.join(roundPaths.reviewerRoot, passID)
          const reviewerPassSuggestionPath = path.join(reviewerPassRoot, "review-suggestion.json")
          const acceptancePassRoot = path.join(roundPaths.finalAcceptanceRoot, passID)
          const acceptancePassResultPath = path.join(acceptancePassRoot, "result.json")

          // 已完成拒绝只复用反馈；不得重做作者或覆盖旧验收。
          if (baseSpec.protocolPlugins && await pathExists(acceptancePassResultPath)) {
            const saved = await readCompletedRejectedCampaignPass({ campaignRoot: campaignPaths.root,
              cwd: input.cwd, campaignID: input.campaignID, roundNumber, runID: runResult.runID,
              entry: baseSpec.protocolPlugins, resultPath: acceptancePassResultPath })
            finalAcceptance = saved
            finalAcceptanceFeedbackPath = saved.protocolTrainingResultPath
            if (await pathExists(reviewerPassSuggestionPath)) {
              reviewerSuggestion = await readJsonFile<LongTaskCampaignReviewSuggestion>(reviewerPassSuggestionPath)
              reviewerInputPath = reviewerPassSuggestionPath
            }
            continue
          }

          // Dynamically resolve the current pass's evidence bundle.
          // IMPORTANT:
          // - pass-01 should use the latest evidence from previous rounds.
          // - pass-02 should prefer the fresh evidence produced by pass-01 final acceptance.
          // - This must exist in resumeLongTaskCampaign too, not only in runLongTaskCampaign.
          // Without these variables, resume can crash with:
          //   currentEvidenceBundlePath is not defined
          let currentEvidenceBundlePath: string | undefined = latestBlankEvidence
          let currentEvidenceReadPaths: string[] = latestBlankEvidenceReadPaths
          let currentOracleReadPaths: string[] = []
          let currentOracleBundlePath: string | undefined = latestFinalAcceptanceOracleBundlePath

          if (finalAcceptance) {
            const fa = finalAcceptance as Record<string, unknown>

            if (typeof fa.blankAgentEvidenceBundlePath === "string") {
              currentEvidenceBundlePath = fa.blankAgentEvidenceBundlePath
            }

            if (Array.isArray(fa.blankAgentEvidenceReadPaths)) {
              currentEvidenceReadPaths = fa.blankAgentEvidenceReadPaths as string[]
            } else if (currentEvidenceBundlePath) {
              currentEvidenceReadPaths = await readBlankAgentEvidenceReadablePaths(
                currentEvidenceBundlePath,
              )
            }

            // Collect expert oracle read paths from this pass's final acceptance.
            if (typeof fa.expertOracleBundlePath === "string") {
              currentOracleBundlePath = fa.expertOracleBundlePath
            }
            if (Array.isArray(fa.expertOracleReadPaths)) {
              currentOracleReadPaths = fa.expertOracleReadPaths as string[]
            }
            if (!baseSpec.protocolPlugins && Array.isArray(fa.validatorResults)) {
              const vrs = fa.validatorResults as Array<Record<string, unknown>>
              if (!currentOracleBundlePath || currentOracleReadPaths.length === 0) {
                const oracleBundle = await writeExpertOracleBundleFromValidatorResults({
                  outPath: path.join(acceptancePassRoot, "expert-oracle-bundle.json"),
                  campaignID: input.campaignID,
                  roundNumber,
                  passID,
                  resultPath: finalAcceptanceFeedbackPath,
                  validatorResults: vrs,
                })
                currentOracleBundlePath = oracleBundle.bundlePath
                currentOracleReadPaths = oracleBundle.oraclePaths
              }
            }
          }

          // Build repair checklist from previous pass failure for pass-02 lead
          let repairChecklist: string[] | undefined
          if ((passIndex >= 2 || baseSpec.protocolPlugins) && finalAcceptanceFeedbackPath) {
            try {
              const prevResult = await readJsonFile<Record<string, unknown>>(finalAcceptanceFeedbackPath)
              repairChecklist = buildRepairChecklistFromFinalAcceptance(prevResult)
            } catch {
              // If previous result is unreadable, lead will still get finalAcceptanceFeedbackPath
            }
          }

          await synchronizeProtocolLeadCandidate({
            enabled: Boolean(baseSpec.protocolPlugins),
            currentRoot: campaignPaths.pendingCurrentRoot,
            draftRoot: roundPaths.pendingPackageSnapshotRoot,
            skill: baseSpec.protocolAuthorContext?.skill,
          })
          await runCampaignLead({
            cwd: input.cwd,
            campaignSpec,
            baseSpec,
            roundNumber,
            runTracePath: roundPaths.runTraceJsonPath,
            runTraceDigestPath: roundPaths.runTraceDigestPath,
            previousPendingPackageRoot: campaignPaths.pendingCurrentRoot,
            nextPendingPackageRoot: roundPaths.pendingPackageSnapshotRoot,
            previousExplorationTreePath: campaignPaths.explorationTreePath,
            nextExplorationTreePath: roundPaths.explorationTreeDraftPath,
            workingMemoryPath: campaignPaths.campaignWorkingMemoryPath,
            previousRoutingControlPath: campaignPaths.campaignRoutingControlPath,
            nextRoutingControlPath: roundPaths.routingControlDraftPath,
            dispatchTicketsPath: campaignPaths.dispatchTicketsPath,
            blankAgentAcceptanceDiagnosisPath: campaignPaths.blankAgentAcceptanceDiagnosisPath,
            workerSuggestions,
            reviewerSuggestionPath: reviewerInputPath,
            acceptanceExperiencePath: campaignPaths.acceptanceExperiencePath,
            acceptanceExperienceJsonlPath: campaignPaths.acceptanceExperienceJsonlPath,
            finalAcceptanceFeedbackPath,
            repairChecklist,
            blankAgentEvidenceBundlePath: currentEvidenceBundlePath,
            blankAgentEvidenceReadPaths: currentEvidenceReadPaths,
            expertOracleBundlePath: currentOracleBundlePath,
            expertOracleReadPaths: currentOracleReadPaths,
            campaignPaths,
            roundPaths,
            runtimeScope: roundRuntimeScope,
            onActivation: activateCampaignRound,
            onPulse: pulseCampaignRound,
          })

          await runSurfaceGeneralizationPrecheck({
            cwd: input.cwd,
            campaignSpec,
            baseSpec,
            campaignPaths,
            roundPaths,
            roundNumber,
            passID,
            runID: runResult.runID,
            runtimeScope: roundRuntimeScope,
            onActivation: activateCampaignRound,
            onPulse: pulseCampaignRound,
          })

          await promoteRoundPendingAndTreeToCurrent({
            campaignPaths,
            roundPaths,
            declaredSkill: baseSpec.protocolAuthorContext?.skill,
            allowReadmeOnly: baseSpec.blankEvalExecutor?.kind === "single_turn_http",
          })

          reviewerSuggestion = shouldRunCampaignReviewer(roundNumber)
            ? await runCampaignReviewer({
                cwd: input.cwd,
                campaignSpec,
                baseSpec,
                roundNumber,
                pendingPackageRoot: campaignPaths.pendingCurrentRoot,
                runTracePath: roundPaths.runTraceDigestPath,
                explorationTreePath: campaignPaths.explorationTreePath,
                workingMemoryPath: campaignPaths.campaignWorkingMemoryPath,
                routingControlPath: campaignPaths.campaignRoutingControlPath,
                dispatchTicketsPath: campaignPaths.dispatchTicketsPath,
                blankAgentAcceptanceDiagnosisPath: campaignPaths.blankAgentAcceptanceDiagnosisPath,
                acceptanceExperiencePath: campaignPaths.acceptanceExperiencePath,
                acceptanceExperienceJsonlPath: campaignPaths.acceptanceExperienceJsonlPath,
                blankAgentEvidenceBundlePath: currentEvidenceBundlePath,
                blankAgentEvidenceReadPaths: currentEvidenceReadPaths,
                expertOracleBundlePath: currentOracleBundlePath,
                expertOracleReadPaths: currentOracleReadPaths,
                stageDir: reviewerPassRoot,
                suggestionPath: reviewerPassSuggestionPath,
                roundPaths,
                runtimeScope: roundRuntimeScope,
                onActivation: activateCampaignRound,
                onPulse: pulseCampaignRound,
              })
            : undefined
          if (reviewerSuggestion) {
            await writeLongTaskCampaignReviewerSuggestion(campaignPaths, reviewerSuggestion)
            reviewerInputPath = reviewerPassSuggestionPath
            const currentRoutingControl = await readLongTaskCampaignRoutingControl(campaignPaths)
            await writeLongTaskCampaignRoutingControl(
              campaignPaths,
              buildRoutingControl({
                previous: currentRoutingControl,
                tree: await readLongTaskCampaignExplorationTree(campaignPaths),
                digest: harvested.runTraceDigest,
                reviewerSuggestion,
                dispatchTickets,
                roundNumber,
              }),
            )
          }

          if (!shouldRunCampaignReviewer(roundNumber)) break

          finalAcceptance = await runCampaignFinalAcceptance({
            cwd: input.cwd,
            campaignID: input.campaignID,
            campaignSpec,
            baseSpec,
            baseSpecPath: campaignSpec.baseSpecPath,
            roundNumber,
            sourceRunID: runResult.runID,
            pendingPackageRoot: campaignPaths.pendingCurrentRoot,
            runTracePath: roundPaths.runTraceJsonPath,
            reviewerSuggestionPath: reviewerPassSuggestionPath,
            finalAcceptanceRoot: acceptancePassRoot,
            finalAcceptanceResultPath: acceptancePassResultPath,
            roundPaths,
            campaignPaths,
            passID,
            runtimeScope: roundRuntimeScope,
            onActivation: activateCampaignRound,
            onPulse: pulseCampaignRound,
          })
          await writeJsonFile(roundPaths.finalAcceptanceResultPath, finalAcceptance)
          // 训练反馈与审计恢复分开，避免回执路径进入修订工单。
          const trainingFeedbackPath = baseSpec.protocolPlugins
            ? String((finalAcceptance as Record<string, unknown>).protocolTrainingResultPath)
            : acceptancePassResultPath
          await appendAcceptanceExperienceV2({
            markdownPath: campaignPaths.acceptanceExperiencePath,
            jsonlPath: campaignPaths.acceptanceExperienceJsonlPath,
            roundNumber,
            passIndex,
            runID: runResult.runID,
            result: finalAcceptance,
            resultPath: trainingFeedbackPath,
          })
          dispatchTickets = mergeDispatchTicketsFromFinalAcceptance({
            previous: dispatchTickets,
            roundNumber,
            feedbackPath: trainingFeedbackPath,
            finalAcceptance,
          })
          await writeJsonFile(campaignPaths.dispatchTicketsPath, dispatchTickets)
          const routingAfterAcceptance = buildRoutingControl({
            previous: await readLongTaskCampaignRoutingControl(campaignPaths),
            tree: await readLongTaskCampaignExplorationTree(campaignPaths),
            digest: harvested.runTraceDigest,
            reviewerSuggestion,
            dispatchTickets,
            roundNumber,
          })
          await writeLongTaskCampaignRoutingControl(campaignPaths, routingAfterAcceptance)
          finalAcceptanceFeedbackPath = trainingFeedbackPath
          const acceptanceInfrastructureFailure = finalAcceptance.failureKind === "infrastructure_failure"
          const acceptanceDatasetFailure = finalAcceptance.failureKind === "dataset_failure"
          if (!finalAcceptance.passed && !acceptanceInfrastructureFailure && !acceptanceDatasetFailure) {
            await runBlankAgentAcceptanceDiagnosisWorker({
              cwd: input.cwd,
              campaignSpec,
              baseSpec,
              roundNumber,
              passID,
              runTracePath: roundPaths.runTraceJsonPath,
              runTraceDigestPath: roundPaths.runTraceDigestPath,
              pendingPackageRoot: campaignPaths.pendingCurrentRoot,
              explorationTreePath: campaignPaths.explorationTreePath,
              workingMemoryPath: campaignPaths.campaignWorkingMemoryPath,
              routingControlPath: campaignPaths.campaignRoutingControlPath,
              dispatchTicketsPath: campaignPaths.dispatchTicketsPath,
              blankAgentAcceptanceDiagnosisPath: campaignPaths.blankAgentAcceptanceDiagnosisPath,
              acceptanceExperiencePath: campaignPaths.acceptanceExperiencePath,
              acceptanceExperienceJsonlPath: campaignPaths.acceptanceExperienceJsonlPath,
              finalAcceptanceFeedbackPath,
              reviewerSuggestionPath: reviewerPassSuggestionPath,
              blankAgentEvidenceBundlePath: (finalAcceptance as Record<string, unknown>).blankAgentEvidenceBundlePath as string | undefined,
              blankAgentEvidenceReadPaths: (finalAcceptance as Record<string, unknown>).blankAgentEvidenceReadPaths as string[] | undefined,
              expertOracleBundlePath: (finalAcceptance as Record<string, unknown>).expertOracleBundlePath as string | undefined,
              expertOracleReadPaths: (finalAcceptance as Record<string, unknown>).expertOracleReadPaths as string[] | undefined,
              roundPaths,
              runtimeScope: roundRuntimeScope,
              onActivation: activateCampaignRound,
              onPulse: pulseCampaignRound,
            })
          }
          if (finalAcceptance.passed || acceptanceInfrastructureFailure || acceptanceDatasetFailure) break
        }

        const finalizedRoundRecord = finalizeRoundRecordWithAcceptance({
          roundRecord: harvested.roundRecord,
          finalAcceptance,
          feedbackPath: finalAcceptanceFeedbackPath,
        })
        harvested.roundRecord = finalizedRoundRecord
        history[history.length - 1] = finalizedRoundRecord
        await rewriteLongTaskCampaignHistoryRecord(campaignPaths, roundNumber, () => finalizedRoundRecord)
        await writeTextFile(
          roundPaths.roundSummaryPath,
          buildRoundSummaryMarkdown({
            roundNumber,
            mode: campaignSpec.mode,
            finalStatus: finalizedRoundRecord.finalStatus,
            summary: finalizedRoundRecord.summary,
            runVerificationSignal: finalizedRoundRecord.runVerificationSignal,
            roundClosure: finalizedRoundRecord.roundClosure,
            gateFailureKind: finalizedRoundRecord.gateFailureKind,
            gateFailureSummary: finalizedRoundRecord.gateFailureSummary,
            finalAcceptanceSignal: finalizedRoundRecord.finalAcceptanceSignal,
            failures: harvested.failurePackets,
            retryLessons: harvested.retryLessons,
            learningUnits: harvested.learningUnits,
          }),
        )

        const acceptanceInfrastructureFailure = finalAcceptance?.failureKind === "infrastructure_failure"
        const acceptanceDatasetFailure = finalAcceptance?.failureKind === "dataset_failure"
        const nextStatus =
          acceptanceInfrastructureFailure || acceptanceDatasetFailure
            ? "failed"
            : finalAcceptance?.passed === true
            ? "verified_success"
            : roundNumber >= campaignSpec.maxRounds
              ? "round_limit_reached"
              : "running"
        const lastRoundClosure =
          acceptanceInfrastructureFailure
            ? "closed_infra_failure"
            : acceptanceDatasetFailure
            ? "closed_dataset_failure"
            : finalAcceptance?.passed === true
            ? "closed_success"
            : finalAcceptance
              ? "closed_repairable"
              : (finalizedRoundRecord.roundClosure ?? "closed_blocked")
        const lastGateFailureKind =
          acceptanceInfrastructureFailure
            ? "infrastructure_failure"
            : acceptanceDatasetFailure
            ? "dataset_failure"
            : finalAcceptance && !finalAcceptance.passed
            ? "final_acceptance_failed"
            : finalizedRoundRecord.gateFailureKind
        const lastGateFailureSummary =
          finalAcceptance && !finalAcceptance.passed
            ? finalAcceptance.summary
            : finalizedRoundRecord.gateFailureSummary
        const lastRunHardVerified =
          finalizedRoundRecord.runVerificationSignal?.completionGateMode === "required" &&
          finalizedRoundRecord.runVerificationSignal?.completionGatePassed === true

        const state: LongTaskCampaignState = {
          ...initialState,
          currentRound: roundNumber,
          status: nextStatus,
          updatedAt: nowISO(),
          lastRunID: runResult.runID,
          lastSummary: finalAcceptance?.summary ?? finalizedRoundRecord.summary,
          lastRoundSummaryPath: finalizedRoundRecord.roundSummaryPath,
          lastRunHardVerified,
          lastFinalAcceptancePassed: finalAcceptance?.passed === true,
          lastFinalAcceptanceResultPath: baseSpec.protocolPlugins && finalAcceptance
            ? String((finalAcceptance as Record<string, unknown>).protocolAuditResultPath)
            : finalAcceptanceFeedbackPath,
          lastRoundClosure,
          lastGateFailureKind,
          lastGateFailureSummary,
          recovery: acceptanceInfrastructureFailure
            ? {
                action: "harvest_round_run",
                roundNumber,
                runID: runResult.runID,
                reason: `Round ${roundID(roundNumber)} stopped at final acceptance because validator infrastructure failed. Resume only after the platform fix; reuse the completed inner run instead of starting a new learning round.`,
                detectedAt: nowISO(),
              }
            : undefined,
        }
        await writeLongTaskCampaignState(campaignPaths, state)

        if (nextStatus === "verified_success") {
          return toCampaignRunResult({
            campaignID: input.campaignID,
            campaignPaths,
            state,
            roundsCompleted: roundNumber,
          })
        }
        if (nextStatus === "failed") {
          return toCampaignRunResult({
            campaignID: input.campaignID,
            campaignPaths,
            state,
            roundsCompleted: roundNumber,
          })
        }
      } finally {
        await cleanupRuntimeScopeWithRetry(roundRuntimeScope)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failureState: LongTaskCampaignState = {
      ...initialState,
      currentRound: lastRoundNumber,
      status: "failed",
      updatedAt: nowISO(),
      lastRunID,
      lastSummary: `Campaign aborted unexpectedly: ${short(message, 240)}`,
      lastRoundSummaryPath,
    }
    await writeLongTaskCampaignState(campaignPaths, failureState)
    return toCampaignRunResult({
      campaignID: input.campaignID,
      campaignPaths,
      state: failureState,
      roundsCompleted: history.length,
    })
  }

  const finalState: LongTaskCampaignState = {
    ...initialState,
    currentRound: campaignSpec.maxRounds,
    status: "round_limit_reached",
    updatedAt: nowISO(),
    lastRunID: history[history.length - 1]?.sourceRunID,
    lastSummary: history[history.length - 1]?.summary,
    lastRoundSummaryPath: history[history.length - 1]?.roundSummaryPath,
  }
  await writeLongTaskCampaignState(campaignPaths, finalState)

  return toCampaignRunResult({
    campaignID: input.campaignID,
    campaignPaths,
    state: finalState,
    roundsCompleted: campaignSpec.maxRounds,
  })
}
