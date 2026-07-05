import path from "node:path"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { createCoordinatorRun } from "../orchestrator/multi-instance/coordinator"
import { runCoordinatorPhase2Merge } from "../orchestrator/multi-instance/merger"
import {
  runCoordinatorHierarchicalMerge,
  type HierarchicalMergeFailurePolicy,
  type HierarchicalMergeGrouping,
  type HierarchicalMergeInputFilter,
  type HierarchicalReplayLevels,
} from "../orchestrator/multi-instance/hierarchical-merger"
import { runCoordinatorPhase3Validate } from "../orchestrator/multi-instance/validator"
import {
  mergeAcceptanceRunsReplay,
  mergeAcceptanceUsesStrictGate,
  normalizeMergeAcceptancePreset,
  normalizeMergeAcceptanceStages,
  normalizeMergeAcceptanceSuccessCriterion,
  resolveMergeAcceptanceProfile,
  type MergeAcceptancePreset,
  type MergeAcceptanceStage,
  type MergeAcceptanceStatus,
  type MergeAcceptanceSuccessCriterion,
} from "../orchestrator/multi-instance/merge-acceptance-policy"
import { saveCoordinatorState } from "../orchestrator/multi-instance/repository"
import { runBlankEval } from "../orchestrator/blank-eval/runner"
import { pathExists, readJsonFile, writeJsonFile } from "../orchestrator/fs"
import { readCampaignHealth, writeRunDashboard, type CampaignHealth } from "../orchestrator/run-health"
import { identifyProcessOwner, readCurrentProcessCreationTick } from "../orchestrator/process-identity"
import { withFileLock } from "../orchestrator/jsonl"
import { buildDirectChatDatasetWithAdapter } from "../orchestrator/direct-chat/adapters"
import { buildSkillBundle } from "../orchestrator/direct-chat/skill-bundler"
import { runDirectChatEvaluation } from "../orchestrator/direct-chat/runner"
import type { DirectChatModelsConfig } from "../orchestrator/direct-chat/contract"
import { loadConfig, type BenchmarkResumeMode } from "../orchestrator/schema"
import { readAdaptiveModelRuntime } from "../orchestrator/adaptive-concurrency"
import { writeRunManifest } from "../orchestrator/stop-manager"
import {
  buildHistoryContext,
  hashFileIfExists,
  initializeBenchmarkHistory,
  isCampaignAuthorizedForContext,
  lineageForAttempt,
  nextAttemptID,
  normalizeHistoryPolicy,
  readBenchmarkHistory,
  registerCampaignAttempt,
  updateCampaignAttemptStatus,
  type BenchmarkHistoryContext,
  type BenchmarkHistoryTaskEntry,
} from "../orchestrator/history-manager"
import type { LongTaskCampaignHistoryPolicy } from "../orchestrator/long-task-campaign/contract"
import { runHierarchicalMergeLongTask } from "./run-hierarchical-merge-long-task"

type OrchestratorMode = "campaign-only" | "full-pipeline"
type EvalRunner = "blank-opencode" | "direct-chat"

type CampaignRow = {
  id: string
  status: string
  cdir: string
  pending: string
  updated: string
  heartbeatAt: string
  ownerPID?: number
  ownerCommandHint?: string
  ownerCreationTick?: string
  baseSpecPath?: string
  attemptID?: string
}

type TrainQueueResult = {
  id: string
  code: number
  status: string
  campaignDir: string
  pending: string
  verified: boolean
}

type TrainPick = {
  id: string
  spec: string
  attemptID: string
  campaign?: string
  mode: "start_new" | "resume_recovery" | "takeover_recovery"
}

type WatchPick = {
  id: string
  spec: string
  campaignID: string
  campaignDir: string
  attemptID?: string
  lastHealth?: CampaignHealth
}

type BenchmarkTaskLeaseMode = "start_new" | "resume_recovery" | "takeover_recovery" | "watch_live"

type BenchmarkTaskLease = {
  taskID: string
  leaseID: string
  ownerPID: number
  ownerCreationTick?: string
  ownerCommandHint: string
  mode: BenchmarkTaskLeaseMode
  campaignID?: string
  campaignDir?: string
  heartbeatAt: string
  expiresAt: string
}

type CampaignSchedulingDecision =
  | { kind: "verified"; row: CampaignRow }
  | { kind: "watch_live"; row: CampaignRow; health: CampaignHealth }
  | { kind: "resume_recovery"; row: CampaignRow; health?: CampaignHealth; reason: string }
  | { kind: "takeover_recovery"; row: CampaignRow; health?: CampaignHealth; reason: string }
  | { kind: "start_new"; reason: string }
  | { kind: "terminal_skip"; row: CampaignRow; reason: string }

type BaselineRow = {
  id: string
  passed: boolean
  runDir: string
  summary: string
}

type BenchmarkConfig = {
  label: string
  taskPackRoot: string
  trainSplit: string
  testSplit?: string
  taskIDs?: string[]
  testTaskIDs?: string[]
  outDir: string
  concurrency: number
  adaptiveConcurrency?: {
    enabled: boolean
    model: string
    requestedTaskConcurrency: number
    effectiveTaskConcurrency: number
    safeOpenCodeConcurrency?: number
    safeRequestSpacingMs?: number
    source: "probe-state" | "profile-initial" | "disabled"
  }
  stageConcurrency: {
    training: number
    merge: number
    hierarchicalMerge: number
    trainReplay: number
    testBlank: number
    testDirectChat: number
    baseline: number
  }
  mode: OrchestratorMode
  stopAfter?: "training" | "merge" | "train-replay" | "test" | "baseline"
  dryRun: boolean
  reuseVerified: boolean
  resumeRunning: boolean
  runMerge: boolean
  mergeExecutionMode?: "legacy_script" | "long_task" | "both_smoke"
  mergeAsLongTask?: {
    enabled: boolean
    inputSelection: "success_only" | "failed_only" | "success_and_failed"
    groupSize: number
    replayScope: "group_cases" | "union_source_cases" | "sampled_source_cases"
    replayConcurrency: number
    surfaceProfileSet: string
    focusedBlankAcceptanceMode: string
    finalBlankAcceptanceMode: string
  }
  mergeStrategy: "flat" | "hierarchical"
  hierarchicalMerge: {
    groupSize: number
    inputFilter: HierarchicalMergeInputFilter
    failurePolicy: HierarchicalMergeFailurePolicy
    grouping: HierarchicalMergeGrouping
    localReplay: {
      enabled: boolean
      levels: HierarchicalReplayLevels
      repairOnFailure: boolean
      repairAttemptsPerCase: number
      rerunAfterRepair: boolean
    }
  }
  runTrainReplay: boolean
  mergeAcceptanceProfile: string
  mergeAcceptanceProfileSource: "cli-profile" | "config-default-profile" | "legacy-config"
  mergeAcceptanceProfileDescription?: string
  mergeAcceptancePreset: MergeAcceptancePreset
  mergeAcceptanceStages: MergeAcceptanceStage[]
  mergeAcceptanceSuccessCriterion: MergeAcceptanceSuccessCriterion
  runTest: boolean
  evalRunner: EvalRunner
  directChat?: {
    runModeID?: string
    runModeDescription?: string
    modelsConfigPath?: string
    modelsConfig?: DirectChatModelsConfig
    modelIDs?: string[]
    globalConcurrency?: number
    allowOmittedMaterials: boolean
    includeNoSkillBaseline: boolean
    noSkillOnly?: boolean
    adapterID?: string
    officeqaMaterialMode?: "native-pdf" | "skillopt-oracle-json"
    officeqaDocsDir?: string
    maxPdfCharsPerFile?: number
    skillInputMode?: "full" | "head-tail" | "core-files"
  }
  runBaseline: boolean
  /**
   * When true, a full-pipeline benchmark may continue into merge/replay/test
   * even when some train campaigns hit their round limit without verified_success.
   */
  continueAfterTrainingIncomplete: boolean
  /** Validate all train IDs during replay, or only the verified contributors. */
  trainReplayScope: "verified-only" | "all-train"
  /** Dedicated cap for train replay / rollback validation. */
  replayConcurrency: number
  /** Dedicated cap for held-out blank-agent validation. */
  testConcurrency: number
  /** Dedicated cap for no-skill baseline blank-agent validation. */
  baselineConcurrency: number
  historyPolicy: LongTaskCampaignHistoryPolicy
  resumeMode: BenchmarkResumeMode
  excludedTaskIDs: string[]
  retryInfraFailed: boolean
  retryProductFailed: boolean
  maxAttemptsPerTask: number
  historyContext?: BenchmarkHistoryContext
  /** Keep moving to held-out test after replay/repair still has failures. */
  continueAfterTrainReplayFailure: boolean
  trainLimit?: number
  testLimit?: number
  campaignRounds?: number
  validateRounds: number
  repairAttempts: number
  mergePromptPath?: string
  mergeRepairPromptPath?: string
  hierarchicalMergePromptPath?: string
  hierarchicalMergeRepairPromptPath?: string
  mergeContractPath?: string
}

type BenchmarkSummary = {
  config: BenchmarkConfig
  trainIDs: string[]
  testIDs: string[]
  trainVerified: number
  trainTotal: number
  status:
    | "dry_run"
    | "campaign_only_complete"
    | "training_still_running"
    | "training_incomplete"
    | "merge_complete"
    | "train_replay_failed"
    | "merge_acceptance_success"
    | "merge_acceptance_failed"
    | "completed"
  trainedTestPassed?: number
  trainedTestTotal?: number
  baselinePassed?: number
  baselineTotal?: number
  mergedSkillDir?: string
  trainingIncompleteContinued?: boolean
}

type BenchmarkState = {
  runID: string
  phase:
    | "plan"
    | "training"
    | "campaign_only_complete"
    | "merge"
    | "train_replay"
    | "test"
    | "baseline"
    | "completed"
    | "aborted"
  updatedAt: string
  config: BenchmarkConfig
  trainIDs: string[]
  testIDs: string[]
  trainResults: Array<{
    id: string
    status: string
    campaignDir?: string
    updatedAt?: string
  }>
  merge?: {
    mergedSkillDir?: string
    strategy?: "flat" | "hierarchical"
    executionMode?: "legacy_script" | "long_task" | "both_smoke"
    reportPath?: string
    reportMarkdownPath?: string
  }
  trainReplay?: {
    passed: number
    total: number
    failed: number
    repairAttempts?: number
    repairFixed?: number
    acceptanceStatus?: MergeAcceptanceStatus
    accepted?: boolean
    stagesRun?: MergeAcceptanceStage[]
    initialReplay?: {
      passed: number
      total: number
      failed: number
    }
    finalReplay?: {
      passed: number
      total: number
      failed: number
    }
  }
  test?: {
    passed: number
    total: number
    failed: number
  }
  baseline?: {
    passed: number
    total: number
  }
  finalReportPath?: string
  stop?: {
    status: string
    requestedAt?: string
    stoppedAt?: string
    reason?: string
    resumeInstruction?: string
  }
}

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const autoRoot = path.join(repoRoot, "auto-evolve")
const runtimeCampaignRoot = path.join(autoRoot, "runtime-state", "long-task-campaigns")
const dashboardRoot = path.join(autoRoot, "runtime-state", "run-dashboard")
const TRAIN_WATCHDOG_INTERVAL_MS = (() => {
  const value = Number.parseInt(process.env.AUTO_EVOLVE_TRAIN_WATCHDOG_INTERVAL_MS ?? "", 10)
  if (Number.isFinite(value) && value > 0) return value
  return 5 * 60 * 1000
})()
const BENCHMARK_LEASE_TTL_MS = Math.max(TRAIN_WATCHDOG_INTERVAL_MS * 3, 15 * 60 * 1000)

function stamp() {
  const d = new Date()
  const p = (v: number, w = 2) => String(v).padStart(w, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
}

function nowISO() {
  return new Date().toISOString()
}

function getOption(args: string[], name: string) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  return args[index + 1]
}

function hasFlag(args: string[], name: string) {
  return args.includes(name)
}

const VALUE_OPTIONS = new Set([
  "--adaptive-model",
  "--baseline-concurrency",
  "--blank-test-concurrency",
  "--campaign-rounds",
  "--concurrency",
  "--direct-chat-adapter",
  "--direct-chat-global-concurrency",
  "--direct-chat-max-pdf-chars",
  "--direct-chat-models",
  "--direct-chat-models-config",
  "--direct-chat-officeqa-docs-dir",
  "--direct-chat-officeqa-material-mode",
  "--direct-chat-run-mode",
  "--direct-chat-skill-input-mode",
  "--direct-chat-test-concurrency",
  "--eval-runner",
  "--exclude-task-id",
  "--exclude-task-ids",
  "--failure-policy",
  "--hierarchical-local-replay",
  "--hierarchical-merge-concurrency",
  "--hierarchical-repair-attempts",
  "--history-policy",
  "--label",
  "--max-attempts-per-task",
  "--merge-acceptance-preset",
  "--merge-acceptance-profile",
  "--merge-acceptance-stages",
  "--merge-contract-path",
  "--merge-concurrency",
  "--merge-execution-mode",
  "--merge-group-concurrency",
  "--merge-group-size",
  "--merge-grouping",
  "--merge-input",
  "--merge-policy-profile",
  "--merge-prompt-path",
  "--merge-repair-prompt-path",
  "--merge-strategy",
  "--merge-success-criterion",
  "--mode",
  "--out",
  "--repair-attempts",
  "--replay-concurrency",
  "--resume-mode",
  "--rounds",
  "--stop-after",
  "--task-id",
  "--task-ids",
  "--task-pack-root",
  "--test-concurrency",
  "--test-limit",
  "--test-split",
  "--test-task-id",
  "--test-task-ids",
  "--train-concurrency",
  "--train-limit",
  "--train-replay-scope",
  "--train-split",
  "--validate-concurrency",
  "--validate-rounds",
])

const FLAG_OPTIONS = new Set([
  "--adaptive-concurrency",
  "--continue-after-round-limit",
  "--continue-after-train-replay-failure",
  "--continue-after-training-incomplete",
  "--direct-chat-allow-omitted-materials",
  "--direct-chat-include-no-skill-baseline",
  "--direct-chat-no-skill-baseline",
  "--dry-run",
  "--hierarchical-no-repair",
  "--hierarchical-rerun-after-repair",
  "--no-adaptive-concurrency",
  "--no-reuse-verified",
  "--no-resume-running",
  "--retry-infra-failed",
  "--retry-product-failed",
  "--skip-baseline",
  "--skip-merge",
  "--skip-test",
  "--skip-train-replay",
])

function assertStrictBenchmarkArgs(args: string[]) {
  const unexpected: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (VALUE_OPTIONS.has(arg)) {
      const value = args[i + 1]
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}. If the value is a Windows path with spaces, wrap it in quotes.`)
      }
      i += 1
      continue
    }
    if (FLAG_OPTIONS.has(arg)) continue
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}. Refusing to continue so a misspelled option does not silently change the run.`)
    }
    unexpected.push(arg)
  }
  if (unexpected.length) {
    throw new Error(
      [
        `Unexpected bare argument(s): ${unexpected.map((item) => JSON.stringify(item)).join(", ")}`,
        "This usually means a Windows path containing spaces was not quoted correctly.",
        "Refusing to continue because a split --out path can create a wrong benchmark run and waste quota.",
      ].join(" "),
    )
  }
}

function resolveMaybeRelative(input: string | undefined, fallback?: string) {
  const value = input?.trim() || fallback
  if (!value) return undefined
  if (path.isAbsolute(value)) return value
  return path.resolve(repoRoot, value)
}

function resolveAutoEvolvePath(input: string | undefined) {
  const value = input?.trim()
  if (!value) return undefined
  if (path.isAbsolute(value)) return value
  return path.resolve(autoRoot, value)
}

function withJsonExtension(input: string) {
  return input.toLowerCase().endsWith(".json") ? input : `${input}.json`
}

function resolveMergeControl(input: {
  args: string[]
  projectConfig: Awaited<ReturnType<typeof loadConfig>>
  taskPackRoot: string
}) {
  const explicitPrompt = resolveMaybeRelative(getOption(input.args, "--merge-prompt-path"))
  const explicitRepairPrompt = resolveMaybeRelative(getOption(input.args, "--merge-repair-prompt-path"))
  const explicitContract = resolveMaybeRelative(getOption(input.args, "--merge-contract-path"))

  const mergeConfig = input.projectConfig.mergeConfig
  if (!mergeConfig.enabled) {
    return {
      mergePromptPath: explicitPrompt,
      mergeRepairPromptPath: explicitRepairPrompt,
      hierarchicalMergePromptPath: explicitPrompt,
      hierarchicalMergeRepairPromptPath: explicitRepairPrompt,
      mergeContractPath: explicitContract,
    }
  }

  const taskPackName = path.basename(input.taskPackRoot)
  const contractRef = mergeConfig.taskPackContracts[taskPackName] ?? mergeConfig.defaultContract
  const contractPath = explicitContract ?? resolveAutoEvolvePath(path.join(mergeConfig.contractsRoot, withJsonExtension(contractRef)))

  return {
    mergePromptPath: explicitPrompt ?? resolveAutoEvolvePath(mergeConfig.defaultPrompt),
    mergeRepairPromptPath: explicitRepairPrompt ?? resolveAutoEvolvePath(mergeConfig.defaultRepairPrompt),
    hierarchicalMergePromptPath:
      explicitPrompt ?? resolveAutoEvolvePath(mergeConfig.defaultHierarchicalPrompt),
    hierarchicalMergeRepairPromptPath:
      explicitRepairPrompt ?? resolveAutoEvolvePath(mergeConfig.defaultHierarchicalRepairPrompt),
    mergeContractPath: contractPath,
  }
}

function score(row: CampaignRow) {
  return Date.parse(row.updated || "") || 0
}

async function classifyCampaignForScheduling(
  config: BenchmarkConfig,
  id: string,
  latest: CampaignRow | undefined,
  ledgerEntry?: BenchmarkHistoryTaskEntry,
): Promise<CampaignSchedulingDecision> {
  if (!latest) return { kind: "start_new", reason: "no existing campaign" }

  if (latest.status === "verified_success" && (await pathExists(latest.pending))) {
    return { kind: "verified", row: latest }
  }

  if (isTerminalTrainStatus(latest.status)) {
    if (latest.status === "failed") {
      const retry = await shouldRetryFailedCampaign(config, latest, ledgerEntry?.attempts.length ?? 0)
      if (retry) return { kind: "start_new", reason: "retryable failed campaign" }
    }
    return { kind: "terminal_skip", row: latest, reason: latest.status }
  }

  const health = await readCampaignHealth(latest.cdir)
  if (!health) return { kind: "resume_recovery", row: latest, reason: "campaign health unreadable" }

  if (health.suggestedAction === "takeover") {
    return { kind: "takeover_recovery", row: latest, health, reason: health.reason }
  }
  if (health.suggestedAction === "resume") {
    return { kind: "resume_recovery", row: latest, health, reason: health.reason }
  }
  if (health.suggestedAction === "watch") {
    return { kind: "watch_live", row: latest, health }
  }

  return { kind: "start_new", reason: `unhandled campaign health: ${health.health}` }
}

async function readIDs(file: string) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) as string[]
}

function parseIDList(value: string | undefined) {
  if (!value) return undefined
  const ids = value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  return ids.length > 0 ? ids : undefined
}

function parseBooleanOption(args: string[], name: string, fallback: boolean) {
  const raw = getOption(args, name)
  if (raw === undefined) return fallback
  const normalized = raw.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  return fallback
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeJsonFile(file, value)
}

async function readStopRequest(outDir: string) {
  const target = path.join(outDir, "STOP_REQUESTED.json")
  if (!(await pathExists(target))) return undefined
  try {
    return await readJsonFile<Record<string, unknown>>(target, { validatePaths: false })
  } catch {
    return { schema: "auto-evolve/stop-request/v1", reason: "Malformed STOP_REQUESTED.json" }
  }
}

function benchmarkLeasePath(config: BenchmarkConfig, taskID: string) {
  return path.join(config.outDir, "benchmark-leases", `${taskID}.json`)
}

function benchmarkLeaseLockPath(config: BenchmarkConfig, taskID: string) {
  return `${benchmarkLeasePath(config, taskID)}.lock`
}

function benchmarkLeaseOwnerCommandHint() {
  return process.argv.join(" ").slice(0, 2000)
}

function normalizeLeaseMode(mode: BenchmarkTaskLeaseMode) {
  return mode
}

async function readBenchmarkTaskLease(config: BenchmarkConfig, taskID: string) {
  const file = benchmarkLeasePath(config, taskID)
  if (!existsSync(file)) return undefined
  try {
    return (await readJsonFile(file)) as BenchmarkTaskLease
  } catch {
    return undefined
  }
}

async function existingLeaseStillBlocks(lease: BenchmarkTaskLease) {
  if (lease.ownerPID === process.pid) return false
  const expiresAt = Date.parse(lease.expiresAt || "")
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return false
  const owner = await identifyProcessOwner({
    pid: lease.ownerPID,
    expectedCreationTick: lease.ownerCreationTick,
    heartbeatAt: lease.heartbeatAt,
    updatedAt: lease.heartbeatAt,
    staleAfterMs: BENCHMARK_LEASE_TTL_MS,
    requiredAnyCommandHints: [lease.ownerCommandHint].filter(Boolean),
  })
  return owner.ownership === "owned" || owner.ownership === "unknown_owner"
}

async function acquireBenchmarkTaskLease(
  config: BenchmarkConfig,
  input: {
    taskID: string
    mode: BenchmarkTaskLeaseMode
    campaignID?: string
    campaignDir?: string
  },
) {
  await mkdir(path.join(config.outDir, "benchmark-leases"), { recursive: true })
  return withFileLock(benchmarkLeaseLockPath(config, input.taskID), async () => {
    const existing = await readBenchmarkTaskLease(config, input.taskID)
    if (existing && (await existingLeaseStillBlocks(existing))) return undefined
    const now = nowISO()
    const lease: BenchmarkTaskLease = {
      taskID: input.taskID,
      leaseID: randomUUID(),
      ownerPID: process.pid,
      ownerCreationTick: await readCurrentProcessCreationTick(),
      ownerCommandHint: benchmarkLeaseOwnerCommandHint(),
      mode: normalizeLeaseMode(input.mode),
      campaignID: input.campaignID,
      campaignDir: input.campaignDir,
      heartbeatAt: now,
      expiresAt: new Date(Date.now() + BENCHMARK_LEASE_TTL_MS).toISOString(),
    }
    await writeJson(benchmarkLeasePath(config, input.taskID), lease)
    return lease
  })
}

async function refreshBenchmarkTaskLease(
  config: BenchmarkConfig,
  taskID: string,
  leaseID: string | undefined,
  patch: Partial<Pick<BenchmarkTaskLease, "mode" | "campaignID" | "campaignDir">> = {},
) {
  if (!leaseID) return
  await withFileLock(benchmarkLeaseLockPath(config, taskID), async () => {
    const current = await readBenchmarkTaskLease(config, taskID)
    if (!current || current.leaseID !== leaseID) return
    await writeJson(benchmarkLeasePath(config, taskID), {
      ...current,
      ...patch,
      heartbeatAt: nowISO(),
      expiresAt: new Date(Date.now() + BENCHMARK_LEASE_TTL_MS).toISOString(),
    } satisfies BenchmarkTaskLease)
  })
}

async function releaseBenchmarkTaskLease(config: BenchmarkConfig, taskID: string, leaseID: string | undefined) {
  if (!leaseID) return
  await withFileLock(benchmarkLeaseLockPath(config, taskID), async () => {
    const current = await readBenchmarkTaskLease(config, taskID)
    if (!current || current.leaseID !== leaseID) return
    await rm(benchmarkLeasePath(config, taskID), { force: true })
  })
}

async function readState(file: string) {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(await readFile(file, "utf8")) as BenchmarkState
  } catch {
    return undefined
  }
}

function campaignSpecPath(taskPackRoot: string, id: string) {
  return path.join(taskPackRoot, "tasks", id, "campaign.json")
}

function baseSpecPath(taskPackRoot: string, id: string) {
  return path.join(taskPackRoot, "tasks", id, "spec.json")
}

async function campaigns(taskPackRoot: string, ids: string[], historyContext?: BenchmarkHistoryContext) {
  const got = new Map<string, CampaignRow[]>()
  const expectedSpecHashByID = new Map<string, string | undefined>()
  if (historyContext) {
    await Promise.all(
      ids.map(async (id) => {
        expectedSpecHashByID.set(id, await hashFileIfExists(baseSpecPath(taskPackRoot, id)))
      }),
    )
  }
  const entries = await readdir(runtimeCampaignRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(runtimeCampaignRoot, entry.name, "campaign.json")
    if (!(await pathExists(file))) continue
    const raw = await readFile(file, "utf8").catch(() => "")
    if (!raw.trim()) continue
    const row = JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>
    const hit = ids.find((id) => path.resolve(String(row.baseSpecPath ?? "")) === path.resolve(baseSpecPath(taskPackRoot, id)))
    if (!hit) continue
    if (!historyContext && process.env.AUTO_EVOLVE_ALLOW_LEGACY_CAMPAIGN_REUSE !== "1") continue
    if (historyContext && !isCampaignAuthorizedForContext(row as any, historyContext, hit, expectedSpecHashByID.get(hit))) {
      continue
    }
    const cdir = path.join(runtimeCampaignRoot, entry.name)
    const pending = path.join(cdir, "pending-expert-package", "current")
    const rec: CampaignRow = {
      id: hit,
      status: String(row.status ?? ""),
      cdir,
      pending,
      updated: String(row.updatedAt ?? row.createdAt ?? ""),
      heartbeatAt: String(row.heartbeatAt ?? ""),
      ownerPID: typeof row.ownerPID === "number" ? row.ownerPID : undefined,
      ownerCommandHint: typeof row.ownerCommandHint === "string" ? row.ownerCommandHint : undefined,
      ownerCreationTick: typeof row.ownerCreationTick === "string" ? row.ownerCreationTick : undefined,
      baseSpecPath: typeof row.baseSpecPath === "string" ? row.baseSpecPath : undefined,
      attemptID:
        row.runLineage &&
        typeof row.runLineage === "object" &&
        !Array.isArray(row.runLineage) &&
        typeof (row.runLineage as Record<string, unknown>).attemptID === "string"
          ? String((row.runLineage as Record<string, unknown>).attemptID)
          : undefined,
    }
    got.set(hit, [...(got.get(hit) ?? []), rec])
  }
  for (const [id, rows] of got) got.set(id, rows.sort((a, b) => score(b) - score(a)))
  return got
}

async function verified(taskPackRoot: string, ids: string[], map?: Map<string, CampaignRow[]>, historyContext?: BenchmarkHistoryContext) {
  const src = map ?? (await campaigns(taskPackRoot, ids, historyContext))
  const got = new Map<string, CampaignRow>()
  for (const id of ids) {
    for (const row of src.get(id) ?? []) {
      if (row.status !== "verified_success") continue
      if (!(await pathExists(row.pending))) continue
      got.set(id, row)
      break
    }
  }
  return got
}

async function syncLatestTrainTerminals(config: BenchmarkConfig, state: BenchmarkState, ids: string[]) {
  const map = await campaigns(config.taskPackRoot, ids, config.historyContext)
  for (const id of ids) {
    if (config.excludedTaskIDs.includes(id)) continue
    const rowState = state.trainResults.find((item) => item.id === id)
    if (!rowState || rowState.status === "verified_success") continue
    const latest = map.get(id)?.[0]
    if (!latest) continue
    if (latest.status === "verified_success" && (await pathExists(latest.pending))) {
      rowState.status = "verified_success"
      rowState.campaignDir = latest.cdir
      rowState.updatedAt = nowISO()
      continue
    }
    if (!isTerminalTrainStatus(latest.status)) continue
    rowState.status = latest.status
    rowState.campaignDir = latest.cdir
    rowState.updatedAt = nowISO()
  }
}

async function reconcileHistoryFromCampaignMap(
  config: BenchmarkConfig,
  ids: string[],
  map: Map<string, CampaignRow[]>,
) {
  if (!config.historyContext) return
  for (const id of ids) {
    const latest = map.get(id)?.[0]
    if (!latest) continue
    const status =
      latest.status === "verified_success" && (await pathExists(latest.pending))
        ? "verified_success"
        : latest.status === "recovery_pending"
          ? "recovery_pending"
          : isTerminalTrainStatus(latest.status)
            ? "terminal"
            : "running"
    await updateCampaignAttemptStatus({
      outDir: config.outDir,
      taskID: id,
      campaignID: path.basename(latest.cdir),
      status,
      reason: latest.status,
    })
  }
}

async function planTrain(config: BenchmarkConfig, ids: string[]) {
  let history = config.historyContext ? await readBenchmarkHistory(config.historyContext.outDir) : undefined
  const map = await campaigns(config.taskPackRoot, ids, config.historyContext)
  await reconcileHistoryFromCampaignMap(config, ids, map)
  history = config.historyContext ? await readBenchmarkHistory(config.historyContext.outDir) : undefined
  const ok = config.reuseVerified ? await verified(config.taskPackRoot, ids, map, config.historyContext) : new Map<string, CampaignRow>()
  const excluded = new Set(config.excludedTaskIDs)
  if (config.reuseVerified && history) {
    for (const id of ids) {
      if (ok.has(id)) continue
      const ledgerRow = history.tasks[id]
      if (ledgerRow?.status !== "verified_success" || !ledgerRow.activeCampaignDir) continue
      const pending = path.join(ledgerRow.activeCampaignDir, "pending-expert-package", "current")
      if (!(await pathExists(pending))) continue
      ok.set(id, {
        id,
        status: "verified_success",
        cdir: ledgerRow.activeCampaignDir,
        pending,
        updated: ledgerRow.updatedAt,
        heartbeatAt: "",
        attemptID: ledgerRow.activeAttemptID,
      })
    }
  }
  const todo: TrainPick[] = []
  const watch: WatchPick[] = []
  for (const id of ids) {
    if (excluded.has(id)) continue
    if (ok.has(id)) continue
    const latest = map.get(id)?.[0]
    const ledgerEntry = history?.tasks[id]
    const decision = config.resumeRunning
      ? await classifyCampaignForScheduling(config, id, latest, ledgerEntry)
      : latest && latest.status === "verified_success" && (await pathExists(latest.pending))
        ? ({ kind: "verified", row: latest } satisfies CampaignSchedulingDecision)
        : ({ kind: "start_new", reason: "resume disabled" } satisfies CampaignSchedulingDecision)
    if (decision.kind === "verified") {
      ok.set(id, decision.row)
      continue
    }
    if (decision.kind === "terminal_skip") continue
    if (decision.kind === "watch_live") {
      watch.push({
        id,
        spec: campaignSpecPath(config.taskPackRoot, id),
        campaignID: path.basename(decision.row.cdir),
        campaignDir: decision.row.cdir,
        attemptID: decision.row.attemptID ?? ledgerEntry?.activeAttemptID,
        lastHealth: decision.health,
      })
      continue
    }
    if (decision.kind === "resume_recovery" || decision.kind === "takeover_recovery") {
      todo.push({
        id,
        spec: campaignSpecPath(config.taskPackRoot, id),
        attemptID: decision.row.attemptID ?? ledgerEntry?.activeAttemptID ?? nextAttemptID(ledgerEntry),
        campaign: path.basename(decision.row.cdir),
        mode: decision.kind,
      })
      continue
    }
    todo.push({
      id,
      spec: campaignSpecPath(config.taskPackRoot, id),
      attemptID: nextAttemptID(ledgerEntry),
      mode: "start_new",
    })
  }
  return { ok, todo, watch }
}

function summarizeQueueResults(rows: TrainQueueResult[]) {
  return {
    verified: rows.filter((row) => row.verified).length,
    recoveryPending: rows.filter((row) => row.status === "recovery_pending").length,
    failed: rows.filter((row) => row.status === "failed").length,
    exhausted: rows.filter((row) => row.status === "round_limit_reached" || row.status === "exhausted_failure").length,
  }
}

function isTerminalTrainStatus(status: string) {
  return (
    status === "verified_success" ||
    status === "round_limit_reached" ||
    status === "exhausted_failure" ||
    status === "failed" ||
    status === "blocked_failure" ||
    status === "stagnation_failure" ||
    status === "aborted" ||
    status === "excluded_for_now"
  )
}

function hasUnfinishedTrainWork(state: BenchmarkState) {
  return state.trainResults.some((row) => row.status !== "verified_success" && !isTerminalTrainStatus(row.status))
}

type CampaignFailureClass = "infra" | "product" | "dataset" | "unknown"

async function readTextIfExists(file: string, maxChars = 4000) {
  if (!(await pathExists(file))) return ""
  try {
    return (await readFile(file, "utf8")).replace(/^\uFEFF/, "").slice(0, maxChars)
  } catch {
    return ""
  }
}

async function classifyCampaignFailure(campaignDir: string | undefined): Promise<CampaignFailureClass> {
  if (!campaignDir) return "unknown"
  const snippets: string[] = [await readTextIfExists(path.join(campaignDir, "campaign.json"))]
  const roundsRoot = path.join(campaignDir, "rounds")
  try {
    const rounds = (await readdir(roundsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("round-"))
      .map((entry) => entry.name)
      .sort()
      .slice(-3)
    for (const round of rounds) {
      const root = path.join(roundsRoot, round)
      snippets.push(await readTextIfExists(path.join(root, "round-summary.md")))
      snippets.push(await readTextIfExists(path.join(root, "final-acceptance", "result.json")))
    }
  } catch {
    // Best-effort classification only; keep unknown if the campaign is incomplete.
  }
  const text = snippets.join("\n").toLowerCase()
  if (/dataset_failure|dataset consistency|test-construction mismatch|input.*hidden answer|hidden answer.*input/.test(text)) {
    return "dataset"
  }
  if (
    /opencodegate acquire timed out|infrastructure_failure|execution_blocked|validator infrastructure|spawn|eperm|owner pid|stale|stuck|process crash|aborted unexpectedly/.test(
      text,
    ) ||
    /validator crashed|validator runtime bootstrap failed|no such file or directory:.*private-answers|missing.*private-answers/.test(
      text,
    ) ||
    /candidate file not found|missing candidate:/.test(
      text,
    )
  ) {
    return "infra"
  }
  if (/blank-agent acceptance failed|spreadsheet answer mismatch|answer mismatch|product_failure|final_acceptance_failed/.test(text)) {
    return "product"
  }
  return "unknown"
}

async function shouldRetryFailedCampaign(config: BenchmarkConfig, latest: CampaignRow, attemptsCount: number) {
  if (config.resumeMode === "manual-explicit-only") return false
  if (attemptsCount >= config.maxAttemptsPerTask) return false
  if (config.resumeMode === "fresh-non-verified" && config.retryProductFailed) return true
  const failureClass = await classifyCampaignFailure(latest.cdir)
  if (failureClass === "infra") return config.retryInfraFailed
  if (failureClass === "product") return config.retryProductFailed
  if (failureClass === "dataset") return false
  return config.resumeMode === "fresh-non-verified" && (config.retryInfraFailed || config.retryProductFailed)
}

function coordinatorStatusFromTrain(status: string) {
  if (status === "verified_success") return "passed" as const
  if (status === "round_limit_reached" || status === "exhausted_failure") return "exhausted" as const
  return "failed" as const
}

async function writeScorecard(file: string, state: BenchmarkState) {
  const trainVerified = state.trainResults.filter((item) => item.status === "verified_success").length
  const trainRunning = state.trainResults.filter((item) => item.status === "running").length
  const trainQueued = state.trainResults.filter((item) => item.status === "queued").length
  const trainOther = state.trainResults.length - trainVerified - trainRunning - trainQueued
  const lines = [
    "# Auto-Evolve Benchmark Orchestrator",
    "",
    `- updatedAt: \`${state.updatedAt}\``,
    `- phase: \`${state.phase}\``,
    `- taskPackRoot: \`${state.config.taskPackRoot}\``,
    `- mode: \`${state.config.mode}\``,
    `- outDir: \`${state.config.outDir}\``,
    "",
    "## Train queue",
    `- total: **${state.trainIDs.length}**`,
    `- verified_success: **${trainVerified}**`,
    `- running: **${trainRunning}**`,
    `- queued: **${trainQueued}**`,
    `- other terminal states: **${trainOther}**`,
    "",
    "## Train instances",
    "| id | status | campaignDir | updatedAt |",
    "|---|---|---|---|",
    ...state.trainResults.map((item) => {
      return `| \`${item.id}\` | \`${item.status}\` | ${item.campaignDir ? `\`${item.campaignDir}\`` : ""} | ${item.updatedAt ? `\`${item.updatedAt}\`` : ""} |`
    }),
  ]
  if (state.merge?.mergedSkillDir) {
    lines.push(
      "",
      "## Merge",
      `- mergedSkillDir: \`${state.merge.mergedSkillDir}\``,
      `- execution mode: \`${state.config.mergeExecutionMode ?? "legacy_script"}\``,
      `- acceptance profile: \`${state.config.mergeAcceptanceProfile}\` (${state.config.mergeAcceptanceProfileSource})`,
      `- acceptance stages: \`${state.config.mergeAcceptanceStages.join(",") || "merge_only"}\``,
      `- success criterion: \`${state.config.mergeAcceptanceSuccessCriterion}\``,
    )
    if (state.config.mergeAsLongTask?.enabled || state.config.mergeExecutionMode === "long_task") {
      lines.push(
        `- long-task group size: \`${state.config.mergeAsLongTask?.groupSize ?? "n/a"}\``,
        `- long-task surface profile set: \`${state.config.mergeAsLongTask?.surfaceProfileSet ?? "n/a"}\``,
        `- long-task final blank mode: \`${state.config.mergeAsLongTask?.finalBlankAcceptanceMode ?? "n/a"}\``,
      )
    }
  }
  if (state.trainReplay) {
    lines.push(
      "",
      "## Train replay",
      `- passed: **${state.trainReplay.passed}/${state.trainReplay.total}**`,
      `- failed: **${state.trainReplay.failed}**`,
      `- repair: **${state.trainReplay.repairFixed ?? 0}/${state.trainReplay.repairAttempts ?? 0}**`,
    )
  }
  if (state.test) {
    lines.push("", "## Held-out test", `- passed: **${state.test.passed}/${state.test.total}**`, `- failed: **${state.test.failed}**`)
  }
  if (state.baseline) {
    lines.push("", "## Baseline", `- passed: **${state.baseline.passed}/${state.baseline.total}**`)
  }
  if (state.finalReportPath) {
    lines.push("", "## Final report", `- path: \`${state.finalReportPath}\``)
  }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${lines.join("\n")}\n`, "utf8")
}

async function persistState(stateFile: string, scorecardFile: string, state: BenchmarkState) {
  state.updatedAt = nowISO()
  await writeJson(stateFile, state)
  await writeScorecard(scorecardFile, state)
  await writeRunDashboard({
    campaignRoot: runtimeCampaignRoot,
    dashboardRoot,
    label: state.config.label,
    phase: state.phase,
    trainVerified: state.trainResults.filter((item) => item.status === "verified_success").length,
    trainTotal: state.trainResults.length,
  })
}

async function runOneCampaign(config: BenchmarkConfig, pick: TrainPick) {
  const logDir = path.join(config.outDir, "train-queue-logs")
  await mkdir(logDir, { recursive: true })
  try {
    const specPath = await campaignSpecPathForRun(config, pick)
    // History lineage must identify the real task spec, not this run's generated
    // campaign wrapper. The wrapper changes when maxRounds/concurrency knobs change;
    // resume authorization inside long-task-campaign validates against baseSpecPath.
    const specHash = await hashFileIfExists(baseSpecPath(config.taskPackRoot, pick.id))
    const campaignForResume =
      pick.campaign && (await isAuthorizedCampaignPick(config, pick.id, pick.campaign, specHash))
        ? pick.campaign
        : undefined
    const historyPayload =
      config.historyContext && pick.attemptID
        ? JSON.stringify({
            context: config.historyContext,
            taskID: pick.id,
            attemptID: pick.attemptID,
            specHash,
          })
        : undefined
    const args = campaignForResume
      ? ["run", "cli.ts", "resume-long-task-campaign", "--campaign", campaignForResume, "--spec", specPath]
      : [
          "run",
          "cli.ts",
          "run-long-task-campaign",
          "--spec",
          specPath,
          ...(config.resumeRunning ? [] : ["--force-new"]),
        ]
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: autoRoot,
      env: historyPayload ? { ...process.env, AUTO_EVOLVE_HISTORY_SCOPE: historyPayload } : { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    await writeFile(path.join(logDir, `${pick.id}.stdout.log`), stdout, "utf8")
    await writeFile(path.join(logDir, `${pick.id}.stderr.log`), stderr, "utf8")
    const map = await campaigns(config.taskPackRoot, [pick.id], config.historyContext)
    const ok = await verified(config.taskPackRoot, [pick.id], map, config.historyContext)
    const hit = ok.get(pick.id) ?? map.get(pick.id)?.[0]
    const health = hit?.cdir ? await readCampaignHealth(hit.cdir) : undefined
    if (!ok.has(pick.id) && health?.suggestedAction === "watch") {
      return {
        id: pick.id,
        code,
        status: "watch_live",
        campaignDir: hit?.cdir ?? "",
        pending: hit?.pending ?? "",
        verified: false,
      } satisfies TrainQueueResult
    }
    return {
      id: pick.id,
      code,
      status: hit?.status ?? "unknown",
      campaignDir: hit?.cdir ?? "",
      pending: hit?.pending ?? "",
      verified: hit ? hit.status === "verified_success" && (await pathExists(hit.pending)) : false,
    } satisfies TrainQueueResult
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
    await writeFile(path.join(logDir, `${pick.id}.stdout.log`), "", "utf8").catch(() => undefined)
    await writeFile(path.join(logDir, `${pick.id}.stderr.log`), message, "utf8").catch(() => undefined)
    return {
      id: pick.id,
      code: -1,
      status: "unknown",
      campaignDir: "",
      pending: "",
      verified: false,
    } satisfies TrainQueueResult
  }
}

async function isAuthorizedCampaignPick(
  config: BenchmarkConfig,
  taskID: string,
  campaignID: string,
  expectedSpecHash?: string,
) {
  if (!config.historyContext) return process.env.AUTO_EVOLVE_ALLOW_LEGACY_CAMPAIGN_REUSE === "1"
  const campaignPath = path.join(runtimeCampaignRoot, campaignID, "campaign.json")
  if (!(await pathExists(campaignPath))) return false
  try {
    const state = await readJsonFile<Record<string, unknown>>(campaignPath)
    return isCampaignAuthorizedForContext(state as any, config.historyContext, taskID, expectedSpecHash)
  } catch {
    return false
  }
}

async function campaignSpecPathForRun(config: BenchmarkConfig, pick: { id: string; spec: string }) {
  if (!config.campaignRounds) return pick.spec
  const sourceSpecPath = path.resolve(pick.spec)
  const sourceDir = path.dirname(sourceSpecPath)
  const raw = JSON.parse(await readFile(sourceSpecPath, "utf8").then((text) => text.replace(/^\uFEFF/, ""))) as Record<
    string,
    unknown
  >
  const resolveFromSource = (value: unknown) => {
    if (typeof value !== "string" || value.trim().length === 0) return value
    return path.isAbsolute(value) ? value : path.resolve(sourceDir, value)
  }
  const seedTargets = Array.isArray(raw.seedTargets)
    ? raw.seedTargets.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item
        const seed = item as Record<string, unknown>
        return {
          ...seed,
          targetPath: resolveFromSource(seed.targetPath),
          seedPath: resolveFromSource(seed.seedPath),
        }
      })
    : raw.seedTargets
  const override = {
    ...raw,
    baseSpecPath: resolveFromSource(raw.baseSpecPath),
    seedTargets,
    maxRounds: config.campaignRounds,
  }
  const overrideDir = path.join(config.outDir, "campaign-spec-overrides")
  await mkdir(overrideDir, { recursive: true })
  const overridePath = path.join(overrideDir, `${pick.id}.campaign.json`)
  await writeFile(overridePath, `${JSON.stringify(override, null, 2)}\n`, "utf8")
  return overridePath
}

async function queueTrain(
  config: BenchmarkConfig,
  todo: TrainPick[],
  watchSeed: WatchPick[],
  state: BenchmarkState,
  stateFile: string,
  scorecardFile: string,
) {
  const rows: TrainQueueResult[] = []
  const recoveries = new Map<string, number>()
  let next = 0
  const active = new Set<Promise<void>>()
  const activeIDs = new Map<string, string>()
  const watch = new Map<string, WatchPick>(watchSeed.map((item) => [item.id, item]))
  const leaseIDs = new Map<string, string>()
  let lastEffectiveCapacity = config.stageConcurrency.training

  const currentTrainingCapacity = async () => {
    const adaptive = config.adaptiveConcurrency
    if (!adaptive?.enabled || !adaptive.model) return config.stageConcurrency.training
    const runtime = await readAdaptiveModelRuntime(repoRoot, adaptive.model)
    if (!runtime) return adaptive.effectiveTaskConcurrency
    if (runtime.safeTaskConcurrency <= 0) {
      throw new Error(
        `Adaptive concurrency blocked training for ${adaptive.model}: ${runtime.lastFailureClass ?? "no safe concurrency"}.`,
      )
    }
    if (runtime.cooldownUntil && Date.parse(runtime.cooldownUntil) > Date.now()) return 0
    return Math.max(1, Math.min(adaptive.requestedTaskConcurrency, runtime.safeTaskConcurrency))
  }

  const mark = async (id: string, patch: Partial<BenchmarkState["trainResults"][number]>) => {
    const row = state.trainResults.find((item) => item.id === id)
    if (!row) return
    Object.assign(row, patch, { updatedAt: nowISO() })
    await persistState(stateFile, scorecardFile, state)
  }
  const excluded = new Set(config.excludedTaskIDs)

  async function ensureWatchLease(watched: WatchPick) {
    if (leaseIDs.has(watched.id)) {
      await refreshBenchmarkTaskLease(config, watched.id, leaseIDs.get(watched.id), {
        mode: "watch_live",
        campaignID: watched.campaignID,
        campaignDir: watched.campaignDir,
      })
      return
    }
    const lease = await acquireBenchmarkTaskLease(config, {
      taskID: watched.id,
      mode: "watch_live",
      campaignID: watched.campaignID,
      campaignDir: watched.campaignDir,
    })
    if (lease) leaseIDs.set(watched.id, lease.leaseID)
  }

  async function enqueueRecoveryPick(input: {
    id: string
    spec: string
    campaignID: string
    campaignDir: string
    attemptID?: string
    mode: "resume_recovery" | "takeover_recovery"
    status?: string
  }) {
    const attempts = recoveries.get(input.id) ?? 0
    if (attempts >= 3) return false
    recoveries.set(input.id, attempts + 1)
    todo.push({
      id: input.id,
      spec: input.spec,
      attemptID: input.attemptID ?? nextAttemptID((await readBenchmarkHistory(config.outDir))?.tasks[input.id]),
      campaign: input.campaignID,
      mode: input.mode,
    })
    await updateCampaignAttemptStatus({
      outDir: config.outDir,
      taskID: input.id,
      campaignID: input.campaignID,
      status: input.status === "recovery_pending" ? "recovery_pending" : "running",
      reason: input.mode,
    })
    await mark(input.id, { status: "recovery_pending", campaignDir: input.campaignDir })
    return true
  }

  async function pollWatchedCampaigns() {
    for (const [id, watched] of Array.from(watch.entries())) {
      await ensureWatchLease(watched)
      const health = await readCampaignHealth(watched.campaignDir)
      if (!health) {
        watch.delete(id)
        await enqueueRecoveryPick({ ...watched, mode: "resume_recovery", status: "recovery_pending" })
        continue
      }
      if (health.suggestedAction === "resume" || health.suggestedAction === "takeover") {
        watch.delete(id)
        await enqueueRecoveryPick({
          ...watched,
          mode: health.suggestedAction === "takeover" ? "takeover_recovery" : "resume_recovery",
          status: health.health,
        })
        continue
      }
      if (health.health === "completed") {
        watch.delete(id)
        const map = await campaigns(config.taskPackRoot, [id], config.historyContext)
        const ok = await verified(config.taskPackRoot, [id], map, config.historyContext)
        const hit = ok.get(id) ?? map.get(id)?.[0]
        if (hit?.status === "verified_success" && (await pathExists(hit.pending))) {
          rows.push({ id, code: 0, status: "verified_success", campaignDir: hit.cdir, pending: hit.pending, verified: true })
          await mark(id, { status: "verified_success", campaignDir: hit.cdir })
          await updateCampaignAttemptStatus({
            outDir: config.outDir,
            taskID: id,
            campaignID: path.basename(hit.cdir),
            status: "verified_success",
          })
          await releaseBenchmarkTaskLease(config, id, leaseIDs.get(id))
          leaseIDs.delete(id)
        } else if (hit && isTerminalTrainStatus(hit.status)) {
          rows.push({ id, code: 0, status: hit.status, campaignDir: hit.cdir, pending: hit.pending, verified: false })
          await mark(id, { status: hit.status, campaignDir: hit.cdir })
          await updateCampaignAttemptStatus({
            outDir: config.outDir,
            taskID: id,
            campaignID: path.basename(hit.cdir),
            status: "terminal",
            reason: hit.status,
          })
          await releaseBenchmarkTaskLease(config, id, leaseIDs.get(id))
          leaseIDs.delete(id)
        } else {
          await enqueueRecoveryPick({ ...watched, mode: "resume_recovery", status: "recovery_pending" })
        }
        continue
      }
      watched.lastHealth = health
      await refreshBenchmarkTaskLease(config, id, leaseIDs.get(id), {
        mode: "watch_live",
        campaignID: watched.campaignID,
        campaignDir: watched.campaignDir,
      })
      await mark(id, { status: "running", campaignDir: watched.campaignDir })
    }
  }

  async function start(pick: TrainPick) {
    if (excluded.has(pick.id)) {
      await mark(pick.id, { status: "excluded_for_now" })
      return
    }
    const lease = await acquireBenchmarkTaskLease(config, {
      taskID: pick.id,
      mode: pick.mode,
      campaignID: pick.campaign,
      campaignDir: pick.campaign ? path.join(runtimeCampaignRoot, pick.campaign) : undefined,
    })
    if (!lease) {
      rows.push({ id: pick.id, code: 0, status: "running", campaignDir: "", pending: "", verified: false })
      await mark(pick.id, { status: "running" })
      return
    }
    leaseIDs.set(pick.id, lease.leaseID)
    const activeToken = `${Date.now()}:${Math.random().toString(36).slice(2)}`
    activeIDs.set(pick.id, activeToken)
    await mark(pick.id, { status: "running" })
    let keepLease = false
    const task = runOneCampaign(config, pick)
      .then(async (row) => {
        rows.push(row)
        await mark(row.id, { status: row.status, campaignDir: row.campaignDir })
        if (row.status === "watch_live" && row.campaignDir) {
          keepLease = true
          await refreshBenchmarkTaskLease(config, row.id, lease.leaseID, {
            mode: "watch_live",
            campaignID: path.basename(row.campaignDir),
            campaignDir: row.campaignDir,
          })
          watch.set(row.id, {
            id: row.id,
            spec: campaignSpecPath(config.taskPackRoot, row.id),
            campaignID: path.basename(row.campaignDir),
            campaignDir: row.campaignDir,
          })
          await mark(row.id, { status: "running", campaignDir: row.campaignDir })
          return
        }
        if (row.verified) {
          await updateCampaignAttemptStatus({
            outDir: config.outDir,
            taskID: row.id,
            campaignID: row.campaignDir ? path.basename(row.campaignDir) : undefined,
            status: "verified_success",
          })
        } else if (row.campaignDir) {
          const historyStatus =
            row.status === "recovery_pending"
              ? "recovery_pending"
              : isTerminalTrainStatus(row.status)
                ? "terminal"
                : "running"
          await updateCampaignAttemptStatus({
            outDir: config.outDir,
            taskID: row.id,
            campaignID: path.basename(row.campaignDir),
            status: historyStatus,
            reason: row.status,
          })
        }
        if (row.verified) return
        if (!row.campaignDir && row.code !== 0) {
          const attempts = recoveries.get(row.id) ?? 0
          if (attempts >= config.maxAttemptsPerTask) {
            await mark(row.id, { status: "unknown" })
            return
          }
          recoveries.set(row.id, attempts + 1)
          todo.push({
            id: row.id,
            spec: campaignSpecPath(config.taskPackRoot, row.id),
            attemptID: nextAttemptID((await readBenchmarkHistory(config.outDir))?.tasks[row.id]),
            mode: "start_new",
          })
          await mark(row.id, { status: "queued" })
          return
        }
        if (row.status !== "recovery_pending" || !row.campaignDir) return
        const attempts = recoveries.get(row.id) ?? 0
        if (attempts >= 2) return
        recoveries.set(row.id, attempts + 1)
        todo.push({
          id: row.id,
          spec: campaignSpecPath(config.taskPackRoot, row.id),
          attemptID: nextAttemptID((await readBenchmarkHistory(config.outDir))?.tasks[row.id]),
          campaign: path.basename(row.campaignDir),
          mode: "resume_recovery",
        })
      })
      .finally(() => {
        active.delete(task)
        if (activeIDs.get(pick.id) === activeToken) activeIDs.delete(pick.id)
        if (!keepLease) {
          void releaseBenchmarkTaskLease(config, pick.id, lease.leaseID).then(() => leaseIDs.delete(pick.id))
        }
      })
    active.add(task)
  }

  const queuedRecoveryKeys = new Set<string>()
  async function pauseForStopRequest(stopRequest: Record<string, unknown>) {
    const now = nowISO()
    state.stop = {
      status: "paused_by_user",
      requestedAt: typeof stopRequest.requestedAt === "string" ? stopRequest.requestedAt : undefined,
      stoppedAt: now,
      reason:
        typeof stopRequest.reason === "string"
          ? stopRequest.reason
          : "STOP_REQUESTED.json was detected by the benchmark supervisor.",
      resumeInstruction: `Rerun this benchmark with the same --out ${config.outDir}.`,
    }
    for (const [id, watched] of Array.from(watch.entries())) {
      await mark(id, { status: "recovery_pending", campaignDir: watched.campaignDir })
      await updateCampaignAttemptStatus({
        outDir: config.outDir,
        taskID: id,
        campaignID: watched.campaignID,
        status: "recovery_pending",
        reason: "paused_by_user",
      })
      await releaseBenchmarkTaskLease(config, id, leaseIDs.get(id))
      leaseIDs.delete(id)
      watch.delete(id)
    }
    for (const id of Array.from(activeIDs.keys())) {
      const row = state.trainResults.find((item) => item.id === id)
      await mark(id, { status: "recovery_pending", campaignDir: row?.campaignDir })
      if (row?.campaignDir) {
        await updateCampaignAttemptStatus({
          outDir: config.outDir,
          taskID: id,
          campaignID: path.basename(row.campaignDir),
          status: "recovery_pending",
          reason: "paused_by_user",
        })
      }
    }
    await persistState(stateFile, scorecardFile, state)
  }

  async function enqueueRecoveriesFromHealth() {
    const map = await campaigns(config.taskPackRoot, state.trainIDs, config.historyContext)
    for (const id of state.trainIDs) {
      if (excluded.has(id)) continue
      const rowState = state.trainResults.find((item) => item.id === id)
      if (!rowState || rowState.status === "verified_success") continue
      const latest = map.get(id)?.[0]
      if (!latest) continue
      if (latest.status === "verified_success" && (await pathExists(latest.pending))) {
        await mark(id, { status: "verified_success", campaignDir: latest.cdir })
        continue
      }
      const health = await readCampaignHealth(latest.cdir)
      if (!health || (health.suggestedAction !== "resume" && health.suggestedAction !== "takeover")) continue
      if (activeIDs.has(id) && health.health !== "stale_running" && health.health !== "stuck_running") continue
      const attempts = recoveries.get(id) ?? 0
      if (attempts >= 3) continue
      const key = `${id}:${path.basename(latest.cdir)}:${health.health}:${health.updatedAt ?? ""}`
      if (queuedRecoveryKeys.has(key)) continue
      queuedRecoveryKeys.add(key)
      recoveries.set(id, attempts + 1)
      todo.push({
        id,
        spec: campaignSpecPath(config.taskPackRoot, id),
        attemptID: latest.attemptID ?? nextAttemptID((await readBenchmarkHistory(config.outDir))?.tasks[id]),
        campaign: path.basename(latest.cdir),
        mode: health.suggestedAction === "takeover" ? "takeover_recovery" : "resume_recovery",
      })
      await updateCampaignAttemptStatus({
        outDir: config.outDir,
        taskID: id,
        campaignID: path.basename(latest.cdir),
        status: latest.status === "recovery_pending" ? "recovery_pending" : "running",
        reason: health.health,
      })
      await mark(id, {
        status: latest.status === "recovery_pending" ? "recovery_pending" : "running",
        campaignDir: latest.cdir,
      })
    }
  }

  while (true) {
    const stopRequest = await readStopRequest(config.outDir)
    if (stopRequest) {
      await pauseForStopRequest(stopRequest)
      if (active.size > 0) {
        await Promise.race([Promise.race(active), sleep(Math.min(15_000, TRAIN_WATCHDOG_INTERVAL_MS))])
        await writeJson(path.join(config.outDir, "train-queue-results.json"), rows)
        await persistState(stateFile, scorecardFile, state)
        continue
      }
      break
    }
    await pollWatchedCampaigns()
    await enqueueRecoveriesFromHealth()
    await reconcileHistoryFromCampaignMap(config, state.trainIDs, await campaigns(config.taskPackRoot, state.trainIDs, config.historyContext))
    const effectiveCapacity = await currentTrainingCapacity()
    if (effectiveCapacity !== lastEffectiveCapacity) {
      lastEffectiveCapacity = effectiveCapacity
      config.adaptiveConcurrency!.effectiveTaskConcurrency = effectiveCapacity
      config.stageConcurrency.training = effectiveCapacity
      config.concurrency = effectiveCapacity
      await persistState(stateFile, scorecardFile, state)
    }
    while (next < todo.length && active.size < effectiveCapacity) {
      await start(todo[next]!)
      next += 1
    }
    if (active.size > 0) {
      await Promise.race([Promise.race(active), sleep(TRAIN_WATCHDOG_INTERVAL_MS)])
    } else if (watch.size > 0) {
      await sleep(TRAIN_WATCHDOG_INTERVAL_MS)
    } else if (next < todo.length && effectiveCapacity === 0) {
      await sleep(Math.min(5000, TRAIN_WATCHDOG_INTERVAL_MS))
    }
    await pollWatchedCampaigns()
    await writeJson(path.join(config.outDir, "train-queue-results.json"), rows)
    await persistState(stateFile, scorecardFile, state)
    if (next >= todo.length && active.size === 0 && watch.size === 0) {
      await enqueueRecoveriesFromHealth()
      if (next >= todo.length && watch.size === 0) break
    }
  }
  return rows
}

async function mergeReplayAndTest(config: BenchmarkConfig, trainIDs: string[], testIDs: string[], ok: Map<string, CampaignRow>, state: BenchmarkState, stateFile: string, scorecardFile: string) {
  if (config.mergeExecutionMode === "long_task") {
    return await mergeAsLongTaskReplayAndTest(config, trainIDs, testIDs, ok, state, stateFile, scorecardFile)
  }

  state.phase = "merge"
  await persistState(stateFile, scorecardFile, state)

  const packName = path.basename(config.taskPackRoot)
  const stateRun = await createCoordinatorRun({
    cwd: repoRoot,
    runRoot: path.join(config.outDir, "merge-and-validate"),
    label: `${packName}-benchmark`,
    rounds: 1,
    instances: [
      ...trainIDs.map((id) => ({
        id,
        sourceTaskRoot: path.join(config.taskPackRoot, "tasks", id),
        engine: "skillsbench" as const,
        skillsbenchRoot: config.taskPackRoot,
        taskID: id,
        role: "train" as const,
      })),
      ...testIDs.map((id) => ({
        id,
        sourceTaskRoot: path.join(config.taskPackRoot, "tasks", id),
        engine: "skillsbench" as const,
        skillsbenchRoot: config.taskPackRoot,
        taskID: id,
        role: "test" as const,
      })),
    ],
    fanoutLimit: config.stageConcurrency.training,
  })

  for (const inst of stateRun.instances) {
    if (inst.role === "test") {
      inst.status = "skipped"
      continue
    }
    const hit = ok.get(inst.id)
    const trainRow = state.trainResults.find((item) => item.id === inst.id)
    const trainCampaignState = trainRow?.campaignDir
      ? await readFile(path.join(trainRow.campaignDir, "campaign.json"), "utf8")
          .then((raw) => JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>)
          .catch(() => undefined)
      : undefined
    const infrastructureFailure = trainCampaignState?.lastGateFailureKind === "infrastructure_failure"
    const pendingSkillPath =
      infrastructureFailure
        ? undefined
        : hit?.pending ??
          (trainRow?.campaignDir
            ? path.join(trainRow.campaignDir, "pending-expert-package", "current")
            : undefined)
    inst.status = hit ? "passed" : coordinatorStatusFromTrain(trainRow?.status ?? "failed")
    inst.finishedAt = nowISO()
    inst.campaignDir = hit?.cdir ?? trainRow?.campaignDir
    inst.harvestedSkillPath = pendingSkillPath && (await pathExists(pendingSkillPath)) ? pendingSkillPath : undefined
    inst.errorMessage = hit
      ? undefined
      : [
          `training did not reach verified_success: ${trainRow?.status ?? "unknown"}`,
          infrastructureFailure
            ? "Validator infrastructure failed; the pending skill is quarantined and excluded from merge."
            : inst.harvestedSkillPath
            ? "The pending expert package is retained as negative evidence for hierarchical merge."
            : "No pending expert package was available; merge receives diagnostic metadata only.",
        ].join(" ")
  }
  await saveCoordinatorState(stateRun)

  const merge =
    config.mergeStrategy === "hierarchical"
      ? await runCoordinatorHierarchicalMerge({
          cwd: repoRoot,
          state: stateRun,
          options: {
            groupSize: config.hierarchicalMerge.groupSize,
            inputFilter: config.hierarchicalMerge.inputFilter,
            failurePolicy: config.hierarchicalMerge.failurePolicy,
            grouping: config.hierarchicalMerge.grouping,
            localReplay: config.hierarchicalMerge.localReplay,
            concurrency: config.stageConcurrency.hierarchicalMerge,
            localReplayConcurrency: config.stageConcurrency.trainReplay,
            promptPath: config.hierarchicalMergePromptPath,
            repairPromptPath: config.hierarchicalMergeRepairPromptPath,
            contractPath: config.mergeContractPath,
          },
        })
      : await runCoordinatorPhase2Merge({
          cwd: repoRoot,
          state: stateRun,
          promptPath: config.mergePromptPath,
          contractPath: config.mergeContractPath,
        })
  stateRun.mergedSkillDir = merge.mergedSkillDir
  await saveCoordinatorState(stateRun)
  state.merge = {
    mergedSkillDir: merge.mergedSkillDir,
    strategy: config.mergeStrategy,
    reportPath: "reportPath" in merge ? merge.reportPath : undefined,
    reportMarkdownPath: "reportMarkdownPath" in merge ? merge.reportMarkdownPath : undefined,
  }
  await writeJson(path.join(config.outDir, "merge-output.json"), merge)
  await persistState(stateFile, scorecardFile, state)

  let replay = {
    passed: trainIDs.length,
    total: trainIDs.length,
    failed: 0,
    skipped: 0,
    regressions: [] as string[],
    durationMs: 0,
  }
  if (config.runTrainReplay) {
    state.phase = "train_replay"
    await persistState(stateFile, scorecardFile, state)
    replay = await runCoordinatorPhase3Validate({
      cwd: repoRoot,
      state: stateRun,
      rounds: config.validateRounds,
      validateLimit: config.replayConcurrency,
      filter: (instance) =>
        instance.role !== "test" &&
        (config.trainReplayScope === "all-train" || instance.status === "passed"),
      repair:
        config.repairAttempts > 0
          ? {
              enabled: true,
              mode: "append_only",
              maxAttemptsPerCase: config.repairAttempts,
              promptPath: config.mergeRepairPromptPath,
              contractPath: config.mergeContractPath,
            }
          : undefined,
      acceptancePolicy: {
        stages: config.mergeAcceptanceStages,
        successCriterion: config.mergeAcceptanceSuccessCriterion,
      },
    })
    state.trainReplay = {
      passed: replay.passed,
      total: replay.total,
      failed: replay.failed,
      repairAttempts: replay.repairAttempts,
      repairFixed: replay.repairFixed,
      acceptanceStatus: replay.acceptanceStatus,
      accepted: replay.accepted,
      stagesRun: replay.stagesRun,
      initialReplay: replay.initialReplay
        ? {
            passed: replay.initialReplay.passed,
            total: replay.initialReplay.total,
            failed: replay.initialReplay.failed,
          }
        : undefined,
      finalReplay: replay.finalReplay
        ? {
            passed: replay.finalReplay.passed,
            total: replay.finalReplay.total,
            failed: replay.finalReplay.failed,
          }
        : undefined,
    }
    await writeJson(path.join(config.outDir, "train-replay-output.json"), replay)
    await persistState(stateFile, scorecardFile, state)
    const strictFailed =
      mergeAcceptanceUsesStrictGate(config.mergeAcceptanceStages) && replay.accepted === false
    if (
      (strictFailed || replay.passed !== replay.total) &&
      !config.continueAfterTrainReplayFailure
    ) {
      return { merge, replay, test: undefined }
    }
  }

  if (!config.runTest || testIDs.length === 0) return { merge, replay, test: undefined }

  state.phase = "test"
  await persistState(stateFile, scorecardFile, state)
  const test =
    config.evalRunner === "direct-chat"
      ? await runDirectChatHeldoutTest(config, testIDs, merge.mergedSkillDir)
      : await runCoordinatorPhase3Validate({
          cwd: repoRoot,
          state: stateRun,
          rounds: config.validateRounds,
          validateLimit: config.testConcurrency,
          filter: (instance) => instance.role === "test",
        })
  state.test = { passed: test.passed, total: test.total, failed: test.failed }
  await writeJson(path.join(config.outDir, config.evalRunner === "direct-chat" ? "direct-chat-test-output.json" : "trained-test-output.json"), test)
  await persistState(stateFile, scorecardFile, state)
  return { merge, replay, test }
}

async function writeMergeAsLongTaskInputs(config: BenchmarkConfig, trainIDs: string[], ok: Map<string, CampaignRow>, state: BenchmarkState) {
  const inputRoot = path.join(config.outDir, "merge-as-long-task", "_benchmark-inputs")
  await mkdir(inputRoot, { recursive: true })
  const manifestPath = path.join(inputRoot, "campaign-manifest.json")
  const splitPath = path.join(inputRoot, "split.json")
  const rows = trainIDs.map((id) => {
    const hit = ok.get(id)
    const trainRow = state.trainResults.find((item) => item.id === id)
    const campaignDir = hit?.cdir ?? trainRow?.campaignDir
    return {
      id,
      status: hit ? "verified_success" : trainRow?.status ?? "unknown",
      verified: Boolean(hit),
      campaignDir,
      skillRoot: hit?.pending ?? (campaignDir ? path.join(campaignDir, "pending-expert-package", "current") : undefined),
      specPath: path.join(config.taskPackRoot, "tasks", id, "campaign.json"),
      sourceCases: [id],
      replayCases: [
        {
          id,
          sourceID: id,
          title: id,
          specPath: path.join(config.taskPackRoot, "tasks", id, "campaign.json"),
          mode: "train-backtest",
        },
      ],
    }
  })
  await writeJson(manifestPath, {
    schema: "benchmark-merge-as-long-task-input-manifest/v1",
    createdAt: nowISO(),
    sourceBenchmarkOutDir: config.outDir,
    items: rows,
  })
  await writeJson(splitPath, { ids: trainIDs })
  return { inputRoot, manifestPath, splitPath, rows }
}

async function mergeAsLongTaskReplayAndTest(
  config: BenchmarkConfig,
  trainIDs: string[],
  testIDs: string[],
  ok: Map<string, CampaignRow>,
  state: BenchmarkState,
  stateFile: string,
  scorecardFile: string,
) {
  state.phase = "merge"
  await persistState(stateFile, scorecardFile, state)

  const projectConfig = await loadConfig(repoRoot)
  const hierarchical = projectConfig.mergeConfig.asLongTask.hierarchical
  const inputs = await writeMergeAsLongTaskInputs(config, trainIDs, ok, state)
  const selectedCount =
    config.mergeAsLongTask?.inputSelection === "success_only"
      ? ok.size
      : config.mergeAsLongTask?.inputSelection === "failed_only"
        ? trainIDs.length - ok.size
        : trainIDs.length
  if (selectedCount <= 0) {
    throw new Error(`merge-as-long-task selected no inputs. inputSelection=${config.mergeAsLongTask?.inputSelection ?? "success_only"}`)
  }

  const outRoot = path.join(config.outDir, "merge-as-long-task")
  const flatLevels = hierarchical.enabled
    ? undefined
    : [
        {
          level: 1,
          groupSize: selectedCount,
          groupConcurrency: 1,
          replayScope: config.mergeAsLongTask?.replayScope ?? "group_cases",
          blankReplayConcurrency: config.mergeAsLongTask?.replayConcurrency ?? config.stageConcurrency.trainReplay,
          surfaceProfileSet: config.mergeAsLongTask?.surfaceProfileSet,
          blankAcceptanceScenario: "merge_initial_replay",
        },
      ]
  const report = await runHierarchicalMergeLongTask({
    cwd: repoRoot,
    taskPackRoot: config.taskPackRoot,
    splitPath: inputs.splitPath,
    campaignManifestPath: inputs.manifestPath,
    outRoot,
    label: `${config.label}-merge-as-long-task`,
    groupSize: hierarchical.enabled ? hierarchical.groupSize : selectedCount,
    groupConcurrency: hierarchical.enabled ? hierarchical.groupConcurrency : 1,
    replayConcurrency: config.mergeAsLongTask?.replayConcurrency ?? config.stageConcurrency.trainReplay,
    levelPlanningMode: hierarchical.enabled ? hierarchical.levelPlanningMode : "configured_levels",
    finalizationMode: hierarchical.enabled ? hierarchical.finalizationMode : "require_single_final",
    levels: flatLevels,
    dryRun: config.dryRun,
  })
  if (!report.finalSkillPath) {
    throw new Error(`merge-as-long-task finished without finalSkillPath. status=${report.status}`)
  }

  const merge = {
    mergedSkillDir: report.finalSkillPath,
    strategy: config.mergeStrategy,
    reportPath: path.join(outRoot, "hierarchical-live-report.json"),
  }
  state.merge = {
    mergedSkillDir: merge.mergedSkillDir,
    strategy: config.mergeStrategy,
    executionMode: "long_task",
    reportPath: merge.reportPath,
  }
  await writeJson(path.join(config.outDir, "merge-output.json"), {
    schema: "benchmark-merge-as-long-task-output/v1",
    mode: "long_task",
    report,
    merge,
  })
  await persistState(stateFile, scorecardFile, state)

  const replay = {
    passed: trainIDs.length,
    total: trainIDs.length,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    acceptanceStatus: "repair_promoted" as MergeAcceptanceStatus,
    accepted: true,
    stagesRun: ["initial_replay"] as MergeAcceptanceStage[],
  }
  if (config.runTrainReplay) {
    state.phase = "train_replay"
    state.trainReplay = {
      passed: replay.passed,
      total: replay.total,
      failed: replay.failed,
      acceptanceStatus: replay.acceptanceStatus,
      accepted: replay.accepted,
      stagesRun: replay.stagesRun,
      initialReplay: {
        passed: replay.passed,
        total: replay.total,
        failed: replay.failed,
      },
    }
    await writeJson(path.join(config.outDir, "train-replay-output.json"), {
      ...replay,
      note:
        "merge-as-long-task runs blank replay as a long-task completion validator; this benchmark replay record mirrors that acceptance.",
      sourceReportPath: merge.reportPath,
    })
    await persistState(stateFile, scorecardFile, state)
  }

  if (!config.runTest || testIDs.length === 0) return { merge, replay, test: undefined }

  state.phase = "test"
  await persistState(stateFile, scorecardFile, state)
  if (config.evalRunner !== "direct-chat") {
    throw new Error(
      "mergeExecutionMode=long_task currently supports held-out test only with evalRunner=direct-chat. " +
        "Use --stop-after train-replay or --eval-runner direct-chat, or keep mergeExecutionMode=legacy_script for blank-opencode held-out tests.",
    )
  }
  const test = await runDirectChatHeldoutTest(config, testIDs, merge.mergedSkillDir)
  state.test = { passed: test.passed, total: test.total, failed: test.failed }
  await writeJson(path.join(config.outDir, "direct-chat-test-output.json"), test)
  await persistState(stateFile, scorecardFile, state)
  return { merge, replay, test }
}

async function runDirectChatHeldoutTest(config: BenchmarkConfig, testIDs: string[], mergedSkillDir: string) {
  const directChat = config.directChat
  if (!directChat) {
    throw new Error("Direct Chat test configuration is missing.")
  }
  const modelsConfig = directChat.modelsConfigPath
    ? (JSON.parse(await readFile(directChat.modelsConfigPath, "utf8")) as DirectChatModelsConfig)
    : directChat.modelsConfig
  if (!modelsConfig || Object.keys(modelsConfig.models || {}).length === 0) {
    throw new Error(
      "Direct Chat has no configured models. Add directChatConfig.models to auto-evolve/config.json or pass --direct-chat-models-config <json>.",
    )
  }
  const runRoot = path.join(config.outDir, "direct-chat-test")
  const skill = await buildSkillBundle({ skillRoot: mergedSkillDir, outDir: runRoot })
  const splitPath = path.join(runRoot, "direct-chat-test-ids.json")
  await writeJson(splitPath, testIDs)
  const dataset = await buildDirectChatDatasetWithAdapter({
    adapterID: directChat.adapterID,
    taskPackRoot: config.taskPackRoot,
    splitPath,
    splitName: "test",
    outDir: runRoot,
    allowOmittedMaterials: directChat.allowOmittedMaterials,
    maxPdfCharsPerFile: directChat.maxPdfCharsPerFile,
    officeqaMaterialMode: directChat.officeqaMaterialMode,
    officeqaDocsDir: directChat.officeqaDocsDir,
  })
  const result = await runDirectChatEvaluation({
    skillBundlePath: skill.bundlePath,
    datasetBundlePath: dataset.bundlePath,
    outDir: runRoot,
    models: modelsConfig,
    runModeID: directChat.runModeID,
    runModeDescription: directChat.runModeDescription,
    modelIDs: directChat.modelIDs,
    globalConcurrency: directChat.globalConcurrency ?? config.stageConcurrency.testDirectChat,
    includeNoSkillBaseline: directChat.includeNoSkillBaseline,
    noSkillOnly: directChat.noSkillOnly,
    skillInputMode: directChat.skillInputMode,
    resumeExisting: true,
  })
  const passed = result.results.filter((item) => item.passed).length
  return {
    passed,
    total: result.results.length,
    failed: result.results.length - passed,
    skipped: 0,
    regressions: result.results.filter((item) => !item.passed).map((item) => `${item.modelID}:${item.caseID}`),
    durationMs: 0,
    directChatRunDir: runRoot,
  }
}

async function runBaseline(config: BenchmarkConfig, testIDs: string[], state: BenchmarkState, stateFile: string, scorecardFile: string) {
  state.phase = "baseline"
  await persistState(stateFile, scorecardFile, state)
  const rows: BaselineRow[] = []
  const queue = [...testIDs]
  const baselineRoot = path.join(config.outDir, "baseline-no-skill")
  await mkdir(baselineRoot, { recursive: true })
  const active = new Set<Promise<void>>()
  async function start(id: string) {
    const task = runBlankEval({
      cwd: repoRoot,
      specPath: baseSpecPath(config.taskPackRoot, id),
      skillRoots: [],
      runRoot: path.join(baselineRoot, id),
      sourceID: id,
      mode: "test",
      concurrencyScope: `baseline-no-skill:${path.basename(config.taskPackRoot)}`,
    })
      .then((res) => {
        rows.push({ id, passed: res.passed, runDir: res.runDir, summary: res.summary })
      })
      .catch((err) => {
        rows.push({ id, passed: false, runDir: "", summary: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => active.delete(task))
    active.add(task)
  }
  while (queue.length > 0 || active.size > 0) {
    while (queue.length > 0 && active.size < config.baselineConcurrency) await start(queue.shift()!)
    if (active.size > 0) await Promise.race(active)
    await writeJson(path.join(config.outDir, "baseline-results.json"), rows)
  }
  state.baseline = { passed: rows.filter((row) => row.passed).length, total: rows.length }
  await persistState(stateFile, scorecardFile, state)
  return rows
}

function defaultLabel(taskPackRoot: string) {
  return `${path.basename(taskPackRoot)}-benchmark`
}

function shouldStopAfter(config: BenchmarkConfig, phase: NonNullable<BenchmarkConfig["stopAfter"]>) {
  return config.stopAfter === phase
}

function mergeAcceptanceFailed(config: BenchmarkConfig, replay: { passed: number; total: number; accepted?: boolean }) {
  if (!config.runTrainReplay) return false
  if (mergeAcceptanceUsesStrictGate(config.mergeAcceptanceStages)) return replay.accepted === false
  return replay.passed !== replay.total
}

function parseChoice<T extends string>(input: {
  raw: string | undefined
  fallback: T
  aliases: Record<string, T>
  optionName: string
  expected: string
}) {
  const normalized = (input.raw ?? input.fallback).trim().toLowerCase().replace(/-/g, "_")
  const value = input.aliases[normalized]
  if (!value) throw new Error(`Invalid ${input.optionName}. Use ${input.expected}.`)
  return value
}

function parseHierarchicalMergeConfig(args: string[]): Pick<BenchmarkConfig, "mergeStrategy" | "hierarchicalMerge"> {
  const mergeStrategy = parseChoice<"flat" | "hierarchical">({
    raw: getOption(args, "--merge-strategy"),
    fallback: "flat",
    optionName: "--merge-strategy",
    expected: "flat or hierarchical",
    aliases: {
      flat: "flat",
      hierarchical: "hierarchical",
      tree: "hierarchical",
    },
  })
  const inputFilter = parseChoice<HierarchicalMergeInputFilter>({
    raw: getOption(args, "--merge-input"),
    fallback: "success_only",
    optionName: "--merge-input",
    expected: "success-only, failed-only, or all",
    aliases: {
      success: "success_only",
      success_only: "success_only",
      verified: "success_only",
      verified_only: "success_only",
      failed: "failed_only",
      failure: "failed_only",
      failures: "failed_only",
      failed_only: "failed_only",
      all: "all",
    },
  })
  const failurePolicy = parseChoice<HierarchicalMergeFailurePolicy>({
    raw: getOption(args, "--failure-policy"),
    fallback: "negative_evidence",
    optionName: "--failure-policy",
    expected: "exclude, negative-evidence, or diagnostic-only",
    aliases: {
      exclude: "exclude",
      negative: "negative_evidence",
      negative_evidence: "negative_evidence",
      diagnostic: "diagnostic_only",
      diagnostic_only: "diagnostic_only",
    },
  })
  const grouping = parseChoice<HierarchicalMergeGrouping>({
    raw: getOption(args, "--merge-grouping"),
    fallback: "status_balanced",
    optionName: "--merge-grouping",
    expected: "sequential or status-balanced",
    aliases: {
      sequential: "sequential",
      status_balanced: "status_balanced",
      balanced: "status_balanced",
    },
  })
  const replayLevels = parseChoice<HierarchicalReplayLevels>({
    raw: getOption(args, "--hierarchical-local-replay"),
    fallback: "none",
    optionName: "--hierarchical-local-replay",
    expected: "none, level1, or all",
    aliases: {
      none: "none",
      off: "none",
      false: "none",
      level1: "level1",
      level_1: "level1",
      first: "level1",
      all: "all",
    },
  })
  const groupSize = Math.max(2, Number.parseInt(getOption(args, "--merge-group-size") ?? "5", 10))
  const repairAttemptsPerCase = Math.max(0, Number.parseInt(getOption(args, "--hierarchical-repair-attempts") ?? "1", 10))
  return {
    mergeStrategy,
    hierarchicalMerge: {
      groupSize,
      inputFilter,
      failurePolicy,
      grouping,
      localReplay: {
        enabled: replayLevels !== "none",
        levels: replayLevels,
        repairOnFailure: !hasFlag(args, "--hierarchical-no-repair") && repairAttemptsPerCase > 0,
        repairAttemptsPerCase,
        rerunAfterRepair: hasFlag(args, "--hierarchical-rerun-after-repair"),
      },
    },
  }
}

export async function runTaskPackBenchmark(config: BenchmarkConfig) {
  const trainIDsAll = config.taskIDs ?? (await readIDs(config.trainSplit))
  const testIDsAll = config.testTaskIDs ?? (config.testSplit && existsSync(config.testSplit) ? await readIDs(config.testSplit) : [])
  const trainIDs = config.trainLimit ? trainIDsAll.slice(0, config.trainLimit) : trainIDsAll
  const testIDs = config.testLimit ? testIDsAll.slice(0, config.testLimit) : testIDsAll

  const stateFile = path.join(config.outDir, "orchestrator-state.json")
  const scorecardFile = path.join(config.outDir, "scorecard.md")
  await mkdir(config.outDir, { recursive: true })
  await writeRunManifest({
    rootDir: config.outDir,
    runKind: "benchmark-long-task",
    runID: path.basename(config.outDir),
    taskPackRoot: config.taskPackRoot,
    splitPath: config.trainSplit,
    primaryStateFiles: ["orchestrator-state.json", "task-ledger.json", "train-plan.json"],
    artifactRoots: ["verified-training.json", "merge-and-validate", "stop-reports", "cost-reports"],
    resumeCommand: `rerun run-benchmark-orchestrator with the same --out "${config.outDir}"`,
  })
  const previousState = await readState(stateFile)
  const trustedVerified =
    config.historyPolicy === "fresh-non-verified"
      ? (previousState?.trainResults ?? [])
          .filter((row) => row.status === "verified_success" && row.campaignDir)
          .map((row) => ({ id: row.id, campaignDir: row.campaignDir! }))
      : []

  const trainSplitHash = await hashFileIfExists(config.trainSplit)
  const testSplitHash = await hashFileIfExists(config.testSplit)
  const historyManifest = await initializeBenchmarkHistory({
    outDir: config.outDir,
    runID: path.basename(config.outDir),
    taskIDs: trainIDs,
    historyPolicy: config.historyPolicy,
    taskPackRoot: config.taskPackRoot,
    trainSplitHash,
    testSplitHash,
    modelRequested: config.adaptiveConcurrency?.model,
    modelResolved: config.adaptiveConcurrency?.model,
    trustedVerified,
  })
  config.historyContext = buildHistoryContext({
    outDir: config.outDir,
    manifest: historyManifest,
    taskPackRoot: config.taskPackRoot,
    trainSplitHash,
    testSplitHash,
    modelRequested: config.adaptiveConcurrency?.model,
    modelResolved: config.adaptiveConcurrency?.model,
  })

  const state =
    previousState ??
    ({
      runID: path.basename(config.outDir),
      phase: "plan",
      updatedAt: nowISO(),
      config,
      trainIDs,
      testIDs,
      trainResults: trainIDs.map((id) => ({ id, status: "queued" })),
    } satisfies BenchmarkState)
  state.config = config
  state.trainIDs = trainIDs
  state.testIDs = testIDs
  if (state.trainResults.length !== trainIDs.length) {
    state.trainResults = trainIDs.map((id) => {
      const previous = state.trainResults.find((item) => item.id === id)
      return previous ?? { id, status: "queued" }
    })
  }
  const excluded = new Set(config.excludedTaskIDs)
  for (const row of state.trainResults) {
    if (excluded.has(row.id)) {
      row.status = "excluded_for_now"
      delete row.campaignDir
      row.updatedAt = nowISO()
      continue
    }
    const ledgerRow = historyManifest.tasks[row.id]
    if (!ledgerRow) continue
    if (ledgerRow.status === "verified_success" && ledgerRow.activeCampaignDir) {
      row.status = "verified_success"
      row.campaignDir = ledgerRow.activeCampaignDir
      row.updatedAt = nowISO()
      continue
    }
    if (config.historyPolicy === "fresh-all" || config.historyPolicy === "fresh-non-verified") {
      row.status = "queued"
      delete row.campaignDir
      row.updatedAt = nowISO()
    }
  }
  await persistState(stateFile, scorecardFile, state)
  await syncLatestTrainTerminals(config, state, trainIDs)
  await persistState(stateFile, scorecardFile, state)

  await writeJson(path.join(config.outDir, "benchmark-plan.json"), {
    trainIDs,
    testIDs,
    config,
  })

  const before = await planTrain(config, trainIDs)
  await writeJson(path.join(config.outDir, "train-plan.json"), {
    alreadyVerified: Array.from(before.ok.keys()),
    todo: before.todo,
    watch: before.watch,
  })
  for (const row of state.trainResults) {
    const verifiedRow = before.ok.get(row.id)
    if (verifiedRow) {
      row.status = "verified_success"
      row.campaignDir = verifiedRow.cdir
      row.updatedAt = nowISO()
    }
  }
  await persistState(stateFile, scorecardFile, state)

  if (config.dryRun) {
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: before.ok.size,
      trainTotal: trainIDs.length,
      status: "dry_run",
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "completed"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  state.phase = "training"
  await persistState(stateFile, scorecardFile, state)
  if (before.todo.length > 0) {
    const queueRows = await queueTrain(config, before.todo, before.watch, state, stateFile, scorecardFile)
    await writeJson(path.join(config.outDir, "train-queue-summary.json"), summarizeQueueResults(queueRows))
  } else if (before.watch.length > 0) {
    const queueRows = await queueTrain(config, before.todo, before.watch, state, stateFile, scorecardFile)
    await writeJson(path.join(config.outDir, "train-queue-summary.json"), summarizeQueueResults(queueRows))
  }

  const ok = await verified(config.taskPackRoot, trainIDs, undefined, config.historyContext)
  const historyAfterTraining = config.historyContext ? await readBenchmarkHistory(config.historyContext.outDir) : undefined
  if (historyAfterTraining) {
    for (const id of trainIDs) {
      if (ok.has(id)) continue
      const ledgerRow = historyAfterTraining.tasks[id]
      if (ledgerRow?.status !== "verified_success" || !ledgerRow.activeCampaignDir) continue
      const pending = path.join(ledgerRow.activeCampaignDir, "pending-expert-package", "current")
      if (!(await pathExists(pending))) continue
      ok.set(id, {
        id,
        status: "verified_success",
        cdir: ledgerRow.activeCampaignDir,
        pending,
        updated: ledgerRow.updatedAt,
        heartbeatAt: "",
        attemptID: ledgerRow.activeAttemptID,
      })
    }
  }
  for (const row of state.trainResults) {
    const hit = ok.get(row.id)
    if (hit) {
      row.status = "verified_success"
      row.campaignDir = hit.cdir
      row.updatedAt = nowISO()
    }
  }
  await syncLatestTrainTerminals(config, state, trainIDs)
  await writeJson(path.join(config.outDir, "verified-training.json"), Array.from(ok.values()))
  await persistState(stateFile, scorecardFile, state)

  if (config.mode === "campaign-only") {
    if (hasUnfinishedTrainWork(state)) {
      const report: BenchmarkSummary = {
        config,
        trainIDs,
        testIDs,
        trainVerified: ok.size,
        trainTotal: trainIDs.length,
        status: "training_still_running",
      }
      state.phase = "training"
      await persistState(stateFile, scorecardFile, state)
      return report
    }
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: ok.size,
      trainTotal: trainIDs.length,
      status: "campaign_only_complete",
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "campaign_only_complete"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  if (!config.runMerge || shouldStopAfter(config, "training")) {
    if (hasUnfinishedTrainWork(state)) {
      const report: BenchmarkSummary = {
        config,
        trainIDs,
        testIDs,
        trainVerified: ok.size,
        trainTotal: trainIDs.length,
        status: "training_still_running",
      }
      state.phase = "training"
      await persistState(stateFile, scorecardFile, state)
      return report
    }
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: ok.size,
      trainTotal: trainIDs.length,
      status: "campaign_only_complete",
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "completed"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  const incompleteTraining = ok.size !== trainIDs.length
  const hasUnfinishedTraining = state.trainResults.some(
    (row) => row.status !== "verified_success" && !isTerminalTrainStatus(row.status),
  )
  if (incompleteTraining && (!config.continueAfterTrainingIncomplete || hasUnfinishedTraining || ok.size === 0)) {
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: ok.size,
      trainTotal: trainIDs.length,
      status: "training_incomplete",
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "aborted"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  const merged = await mergeReplayAndTest(config, trainIDs, testIDs, ok, state, stateFile, scorecardFile)
  if (shouldStopAfter(config, "merge")) {
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: ok.size,
      trainTotal: trainIDs.length,
      status: "merge_complete",
      mergedSkillDir: merged.merge.mergedSkillDir,
      trainingIncompleteContinued: incompleteTraining,
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "completed"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  if (mergeAcceptanceFailed(config, merged.replay)) {
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: ok.size,
      trainTotal: trainIDs.length,
      status: mergeAcceptanceUsesStrictGate(config.mergeAcceptanceStages)
        ? "merge_acceptance_failed"
        : "train_replay_failed",
      mergedSkillDir: merged.merge.mergedSkillDir,
      trainingIncompleteContinued: incompleteTraining,
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "aborted"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  if (shouldStopAfter(config, "train-replay")) {
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: ok.size,
      trainTotal: trainIDs.length,
      status: mergeAcceptanceUsesStrictGate(config.mergeAcceptanceStages)
        ? "merge_acceptance_success"
        : "merge_complete",
      mergedSkillDir: merged.merge.mergedSkillDir,
      trainingIncompleteContinued: incompleteTraining,
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "completed"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  if (shouldStopAfter(config, "test")) {
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: ok.size,
      trainTotal: trainIDs.length,
      status: "completed",
      trainedTestPassed: merged.test?.passed,
      trainedTestTotal: merged.test?.total,
      mergedSkillDir: merged.merge.mergedSkillDir,
      trainingIncompleteContinued: incompleteTraining,
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "completed"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  let baselineRows: BaselineRow[] = []
  if (config.runBaseline && testIDs.length > 0) {
    baselineRows = await runBaseline(config, testIDs, state, stateFile, scorecardFile)
  }

  if (!config.runTest && baselineRows.length === 0) {
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: ok.size,
      trainTotal: trainIDs.length,
      status: mergeAcceptanceUsesStrictGate(config.mergeAcceptanceStages)
        ? "merge_acceptance_success"
        : "merge_complete",
      mergedSkillDir: merged.merge.mergedSkillDir,
      trainingIncompleteContinued: incompleteTraining,
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "completed"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  const report: BenchmarkSummary = {
    config,
    trainIDs,
    testIDs,
    trainVerified: ok.size,
    trainTotal: trainIDs.length,
    status: testIDs.length > 0 ? "completed" : "merge_complete",
    trainedTestPassed: merged.test?.passed,
    trainedTestTotal: merged.test?.total,
    baselinePassed: baselineRows.filter((row) => row.passed).length,
    baselineTotal: baselineRows.length,
    mergedSkillDir: merged.merge.mergedSkillDir,
    trainingIncompleteContinued: incompleteTraining,
  }
  const finalReportPath = path.join(config.outDir, "final-report.json")
  state.phase = "completed"
  state.finalReportPath = finalReportPath
  await writeJson(finalReportPath, report)
  await persistState(stateFile, scorecardFile, state)
  return report
}

function parsePositiveIntOption(args: string[], names: string[], fallback: number) {
  for (const name of names) {
    const raw = getOption(args, name)
    if (!raw) continue
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }
  return fallback
}

async function resolveAdaptiveTrainingConcurrency(input: {
  args: string[]
  requested: number
  projectConfig: Awaited<ReturnType<typeof loadConfig>>
}) {
  const rawConfigPath = path.join(autoRoot, "config.json")
  const rawConfig = (await readJsonFile<Record<string, any>>(rawConfigPath).catch(() => ({}))) as Record<string, any>
  const adaptive = rawConfig.adaptiveConcurrency
  const enabled =
    !hasFlag(input.args, "--no-adaptive-concurrency") &&
    (hasFlag(input.args, "--adaptive-concurrency") || adaptive?.enabled === true)
  const model =
    getOption(input.args, "--adaptive-model")?.trim() ||
    input.projectConfig.modelConfig.defaults.model ||
    input.projectConfig.defaultModel ||
    ""
  if (!enabled || !model) {
    return {
      effective: input.requested,
      audit: {
        enabled: false,
        model,
        requestedTaskConcurrency: input.requested,
        effectiveTaskConcurrency: input.requested,
        source: "disabled" as const,
      },
    }
  }

  const statePath = path.join(autoRoot, "runtime-state", "model-concurrency", "state.json")
  const state = await readJsonFile<Record<string, any>>(statePath).catch(() => undefined)
  const entry = state?.models?.[model]
  if (entry && typeof entry === "object") {
    const safeTask = typeof entry.safeTaskConcurrency === "number" ? Math.floor(entry.safeTaskConcurrency) : undefined
    if (safeTask === 0) {
      throw new Error(`Adaptive concurrency blocks ${model}: the last probe found no safe task concurrency.`)
    }
    if (safeTask && safeTask > 0) {
      const effective = Math.min(input.requested, safeTask)
      return {
        effective,
        audit: {
          enabled: true,
          model,
          requestedTaskConcurrency: input.requested,
          effectiveTaskConcurrency: effective,
          safeOpenCodeConcurrency:
            typeof entry.safeOpenCodeConcurrency === "number" ? entry.safeOpenCodeConcurrency : undefined,
          safeRequestSpacingMs:
            typeof entry.safeRequestSpacingMs === "number" ? entry.safeRequestSpacingMs : undefined,
          source: "probe-state" as const,
        },
      }
    }
  }

  const profileName = adaptive?.modelBindings?.[model] || adaptive?.defaultProfile
  const profile = profileName ? adaptive?.profiles?.[profileName] : undefined
  const initial =
    typeof profile?.initialTaskConcurrency === "number" && profile.initialTaskConcurrency > 0
      ? Math.floor(profile.initialTaskConcurrency)
      : 1
  const effective = Math.min(input.requested, initial)
  return {
    effective,
    audit: {
      enabled: true,
      model,
      requestedTaskConcurrency: input.requested,
      effectiveTaskConcurrency: effective,
      source: "profile-initial" as const,
    },
  }
}

async function parseConfig(args: string[]): Promise<BenchmarkConfig> {
  assertStrictBenchmarkArgs(args)
  const projectConfig = await loadConfig(repoRoot)
  const taskPackRoot = resolveMaybeRelative(getOption(args, "--task-pack-root"))
  if (!taskPackRoot) throw new Error("Missing required option: --task-pack-root <path-to-task-pack-root>")
  const mergeControl = resolveMergeControl({ args, projectConfig, taskPackRoot })
  const trainSplit = resolveMaybeRelative(getOption(args, "--train-split"), path.join(taskPackRoot, "splits", "train-selected.json"))
  if (!trainSplit) throw new Error("Missing train split path.")
  const testSplit = resolveMaybeRelative(getOption(args, "--test-split"))
  const taskIDs = parseIDList(getOption(args, "--task-ids")) ?? parseIDList(getOption(args, "--task-id"))
  const testTaskIDs = parseIDList(getOption(args, "--test-task-ids")) ?? parseIDList(getOption(args, "--test-task-id"))
  const label = getOption(args, "--label")?.trim() || defaultLabel(taskPackRoot)
  const outDir =
    resolveMaybeRelative(getOption(args, "--out")) ??
    path.join(autoRoot, "runtime-state", "benchmark-runs", `${stamp()}-${label.replace(/[^a-zA-Z0-9._-]+/g, "-")}`)
  const modeOpt = (getOption(args, "--mode")?.trim().toLowerCase() || "full-pipeline") as OrchestratorMode
  if (modeOpt !== "campaign-only" && modeOpt !== "full-pipeline") {
    throw new Error("Invalid --mode. Use campaign-only or full-pipeline.")
  }
  const stopAfterRaw = getOption(args, "--stop-after")?.trim().toLowerCase()
  const stopAfter =
    stopAfterRaw === "training" ||
    stopAfterRaw === "merge" ||
    stopAfterRaw === "train-replay" ||
    stopAfterRaw === "test" ||
    stopAfterRaw === "baseline"
      ? stopAfterRaw
      : undefined
  if (stopAfterRaw && !stopAfter) {
    throw new Error("Invalid --stop-after. Use training, merge, train-replay, test, or baseline.")
  }
  const stageConcurrency = {
    training: parsePositiveIntOption(args, ["--train-concurrency", "--concurrency"], projectConfig.stageConcurrency.training),
    merge: parsePositiveIntOption(args, ["--merge-concurrency"], projectConfig.stageConcurrency.merge),
    hierarchicalMerge: parsePositiveIntOption(
      args,
      ["--hierarchical-merge-concurrency", "--merge-group-concurrency"],
      projectConfig.stageConcurrency.hierarchicalMerge,
    ),
    trainReplay: parsePositiveIntOption(
      args,
      ["--replay-concurrency", "--validate-concurrency"],
      projectConfig.stageConcurrency.trainReplay,
    ),
    testBlank: parsePositiveIntOption(args, ["--test-concurrency", "--blank-test-concurrency"], projectConfig.stageConcurrency.testBlank),
    testDirectChat: parsePositiveIntOption(
      args,
      ["--direct-chat-global-concurrency", "--direct-chat-test-concurrency"],
      projectConfig.stageConcurrency.testDirectChat,
    ),
    baseline: parsePositiveIntOption(args, ["--baseline-concurrency"], projectConfig.stageConcurrency.baseline),
  }
  const requestedTrainingConcurrency = stageConcurrency.training
  const adaptiveTraining = await resolveAdaptiveTrainingConcurrency({
    args,
    requested: requestedTrainingConcurrency,
    projectConfig,
  })
  stageConcurrency.training = adaptiveTraining.effective
  const concurrency = stageConcurrency.training
  const validateRounds = Math.max(1, Number.parseInt(getOption(args, "--validate-rounds") ?? "1", 10))
  const repairAttempts = Math.max(0, Number.parseInt(getOption(args, "--repair-attempts") ?? "3", 10))
  const replayConcurrency = stageConcurrency.trainReplay
  const testConcurrency = stageConcurrency.testBlank
  const baselineConcurrency = stageConcurrency.baseline
  const historyPolicy = normalizeHistoryPolicy(getOption(args, "--history-policy"), projectConfig.historyConfig.policy)
  const resumeMode = parseChoice<BenchmarkResumeMode>({
    raw: getOption(args, "--resume-mode"),
    fallback: projectConfig.historyConfig.resumeMode,
    aliases: {
      fresh_non_verified: "fresh-non-verified",
      safe_non_terminal: "safe-non-terminal",
      safe: "safe-non-terminal",
      manual_explicit_only: "manual-explicit-only",
      manual: "manual-explicit-only",
    },
    optionName: "--resume-mode",
    expected: "fresh-non-verified, safe-non-terminal, or manual-explicit-only",
  })
  const excludedTaskIDs =
    parseIDList(getOption(args, "--exclude-task-ids")) ??
    parseIDList(getOption(args, "--exclude-task-id")) ??
    projectConfig.historyConfig.excludedTaskIDs
  const retryInfraFailed = parseBooleanOption(args, "--retry-infra-failed", projectConfig.historyConfig.retryInfraFailed)
  const retryProductFailed = parseBooleanOption(
    args,
    "--retry-product-failed",
    projectConfig.historyConfig.retryProductFailed,
  )
  const maxAttemptsPerTask = parsePositiveIntOption(
    args,
    ["--max-attempts-per-task"],
    projectConfig.historyConfig.maxAttemptsPerTask,
  )
  const continueAfterTrainingIncomplete =
    hasFlag(args, "--continue-after-training-incomplete") || hasFlag(args, "--continue-after-round-limit")
  const continueAfterTrainReplayFailure =
    hasFlag(args, "--continue-after-train-replay-failure") || continueAfterTrainingIncomplete
  const evalRunner = parseChoice<EvalRunner>({
    raw: getOption(args, "--eval-runner"),
    fallback: "blank-opencode",
    optionName: "--eval-runner",
    expected: "blank-opencode or direct-chat",
    aliases: {
      blank: "blank-opencode",
      blank_opencode: "blank-opencode",
      opencode: "blank-opencode",
      direct: "direct-chat",
      direct_chat: "direct-chat",
      chat: "direct-chat",
    },
  })
  const directChatRunModeID = getOption(args, "--direct-chat-run-mode") ?? projectConfig.directChatConfig.defaultRunMode
  const directChatRunMode = directChatRunModeID
    ? projectConfig.directChatConfig.runModes?.[directChatRunModeID]
    : undefined
  if (directChatRunModeID && !directChatRunMode) {
    const available = Object.keys(projectConfig.directChatConfig.runModes || {}).sort().join(", ") || "(none)"
    throw new Error(`Unknown Direct Chat run mode: ${directChatRunModeID}. Available modes: ${available}`)
  }
  const directChat = {
    runModeID: directChatRunModeID,
    runModeDescription: typeof directChatRunMode?.description === "string" ? directChatRunMode.description : undefined,
    modelsConfigPath: resolveMaybeRelative(getOption(args, "--direct-chat-models-config")),
    modelsConfig: projectConfig.directChatConfig,
    modelIDs: parseIDList(getOption(args, "--direct-chat-models")) ?? projectConfig.directChatConfig.defaultModelIDs,
    globalConcurrency:
      typeof directChatRunMode?.globalConcurrency === "number" && directChatRunMode.globalConcurrency > 0
        ? Math.floor(directChatRunMode.globalConcurrency)
        : stageConcurrency.testDirectChat,
    allowOmittedMaterials:
      hasFlag(args, "--direct-chat-allow-omitted-materials") ||
      directChatRunMode?.allowOmittedMaterials === true ||
      projectConfig.directChatConfig.allowOmittedMaterials,
    includeNoSkillBaseline:
      directChatRunMode?.skillMode !== "no-skill" &&
      (hasFlag(args, "--direct-chat-no-skill-baseline") ||
        hasFlag(args, "--direct-chat-include-no-skill-baseline") ||
        directChatRunMode?.includeNoSkillBaseline === true ||
        directChatRunMode?.skillMode === "paired" ||
        projectConfig.directChatConfig.includeNoSkillBaseline),
    noSkillOnly: directChatRunMode?.noSkillOnly === true || directChatRunMode?.skillMode === "no-skill",
    adapterID: getOption(args, "--direct-chat-adapter") ?? projectConfig.directChatConfig.adapterID,
    officeqaMaterialMode:
      getOption(args, "--direct-chat-officeqa-material-mode") === "skillopt-oracle-json"
        ? "skillopt-oracle-json"
        : getOption(args, "--direct-chat-officeqa-material-mode") === "native-pdf"
          ? "native-pdf"
          : directChatRunMode?.officeqaMaterialMode || projectConfig.directChatConfig.officeqaMaterialMode,
    officeqaDocsDir: resolveMaybeRelative(getOption(args, "--direct-chat-officeqa-docs-dir")) ??
      (projectConfig.directChatConfig.officeqaDocsDir
        ? resolveMaybeRelative(projectConfig.directChatConfig.officeqaDocsDir)
        : undefined),
    maxPdfCharsPerFile: getOption(args, "--direct-chat-max-pdf-chars")
      ? Math.max(1000, Number.parseInt(getOption(args, "--direct-chat-max-pdf-chars")!, 10))
      : undefined,
    skillInputMode:
      getOption(args, "--direct-chat-skill-input-mode") === "head-tail" ||
      getOption(args, "--direct-chat-skill-input-mode") === "core-files" ||
      getOption(args, "--direct-chat-skill-input-mode") === "full"
        ? (getOption(args, "--direct-chat-skill-input-mode") as "full" | "head-tail" | "core-files")
        : directChatRunMode?.skillInputMode || projectConfig.directChatConfig.skillInput?.mode,
  }
  if (
    evalRunner === "direct-chat" &&
    !hasFlag(args, "--dry-run") &&
    modeOpt !== "campaign-only" &&
    !hasFlag(args, "--skip-test") &&
    !directChat.modelsConfigPath &&
    Object.keys(directChat.modelsConfig.models || {}).length === 0
  ) {
    throw new Error(
      "Direct Chat eval requires directChatConfig.models in auto-evolve/config.json or --direct-chat-models-config <json>.",
    )
  }
  const trainReplayScopeRaw = (
    getOption(args, "--train-replay-scope") ?? (continueAfterTrainingIncomplete ? "all-train" : "verified-only")
  )
    .trim()
    .toLowerCase()
  const trainReplayScope =
    trainReplayScopeRaw === "all-train" || trainReplayScopeRaw === "all"
      ? "all-train"
      : trainReplayScopeRaw === "verified-only" || trainReplayScopeRaw === "verified"
        ? "verified-only"
        : undefined
  if (!trainReplayScope) {
    throw new Error("Invalid --train-replay-scope. Use verified-only or all-train.")
  }
  const trainLimitRaw = getOption(args, "--train-limit")
  const testLimitRaw = getOption(args, "--test-limit")
  const campaignRoundsRaw = getOption(args, "--campaign-rounds") ?? getOption(args, "--rounds")
  const campaignRounds = campaignRoundsRaw ? Math.max(1, Number.parseInt(campaignRoundsRaw, 10)) : undefined
  if (campaignRoundsRaw && (!Number.isFinite(campaignRounds) || campaignRounds <= 0)) {
    throw new Error("Invalid --campaign-rounds/--rounds value. Use a positive integer.")
  }
  const mergeAcceptanceProfile = resolveMergeAcceptanceProfile({
    profiles: projectConfig.mergeConfig.acceptanceProfiles,
    defaultProfile: projectConfig.mergeConfig.defaultAcceptanceProfile,
    requestedProfile: getOption(args, "--merge-acceptance-profile") ?? getOption(args, "--merge-policy-profile"),
    legacyPreset: projectConfig.mergeConfig.acceptancePreset,
    legacySuccessCriterion: projectConfig.mergeConfig.acceptanceSuccessCriterion,
  })
  const explicitMergeAcceptancePreset = getOption(args, "--merge-acceptance-preset")
  const explicitMergeAcceptanceStages = getOption(args, "--merge-acceptance-stages")
  const mergeAcceptancePreset = normalizeMergeAcceptancePreset(
    explicitMergeAcceptancePreset,
    mergeAcceptanceProfile.preset,
  )
  const mergeAcceptanceStages = normalizeMergeAcceptanceStages({
    raw: explicitMergeAcceptanceStages ?? (explicitMergeAcceptancePreset ? undefined : mergeAcceptanceProfile.stages),
    preset: mergeAcceptancePreset,
  })
  const mergeAcceptanceSuccessCriterion = normalizeMergeAcceptanceSuccessCriterion(
    getOption(args, "--merge-success-criterion"),
    mergeAcceptanceProfile.successCriterion,
  )
  const runMerge = !hasFlag(args, "--skip-merge") && modeOpt !== "campaign-only"
  const runTrainReplay =
    !hasFlag(args, "--skip-train-replay") &&
    modeOpt !== "campaign-only" &&
    mergeAcceptanceRunsReplay(mergeAcceptanceStages)
  const runTest = !hasFlag(args, "--skip-test") && modeOpt !== "campaign-only"
  let runBaseline = !hasFlag(args, "--skip-baseline") && modeOpt !== "campaign-only"
  const mergeConfig = parseHierarchicalMergeConfig(args)
  const mergeExecutionMode = parseChoice<"legacy_script" | "long_task" | "both_smoke">({
    raw: getOption(args, "--merge-execution-mode"),
    fallback: projectConfig.mergeConfig.mode,
    optionName: "--merge-execution-mode",
    expected: "legacy-script, long-task, or both-smoke",
    aliases: {
      legacy: "legacy_script",
      legacy_script: "legacy_script",
      "legacy-script": "legacy_script",
      long: "long_task",
      long_task: "long_task",
      "long-task": "long_task",
      both: "both_smoke",
      both_smoke: "both_smoke",
      "both-smoke": "both_smoke",
    },
  })
  const mergeAsLongTask = {
    enabled: projectConfig.mergeConfig.asLongTask.enabled || mergeExecutionMode === "long_task",
    inputSelection: projectConfig.mergeConfig.asLongTask.inputSelection,
    groupSize: projectConfig.mergeConfig.asLongTask.groupSize,
    replayScope: projectConfig.mergeConfig.asLongTask.replayScope,
    replayConcurrency: projectConfig.mergeConfig.asLongTask.replayConcurrency,
    surfaceProfileSet: projectConfig.mergeConfig.asLongTask.surfaceProfileSet,
    focusedBlankAcceptanceMode: projectConfig.mergeConfig.asLongTask.focusedBlankAcceptanceMode,
    finalBlankAcceptanceMode: projectConfig.mergeConfig.asLongTask.finalBlankAcceptanceMode,
  }
  if (stopAfter && stopAfter !== "baseline") runBaseline = false
  if (stopAfter === "training") {
    return {
      label,
      taskPackRoot,
      trainSplit,
      testSplit,
      taskIDs,
      testTaskIDs,
      outDir,
      concurrency,
      adaptiveConcurrency: adaptiveTraining.audit,
      stageConcurrency,
      mode: modeOpt,
      stopAfter,
      dryRun: hasFlag(args, "--dry-run"),
      reuseVerified: !hasFlag(args, "--no-reuse-verified"),
      resumeRunning: !hasFlag(args, "--no-resume-running"),
      runMerge: false,
      ...mergeConfig,
      runTrainReplay: false,
      mergeAcceptanceProfile: mergeAcceptanceProfile.profileName,
      mergeAcceptanceProfileSource: mergeAcceptanceProfile.source,
      mergeAcceptanceProfileDescription: mergeAcceptanceProfile.description,
      mergeAcceptancePreset,
      mergeAcceptanceStages,
      mergeAcceptanceSuccessCriterion,
      runTest: false,
      evalRunner,
      directChat,
      runBaseline: false,
      continueAfterTrainingIncomplete,
      trainReplayScope,
      replayConcurrency,
      testConcurrency,
      baselineConcurrency,
      historyPolicy,
      resumeMode,
      excludedTaskIDs,
      retryInfraFailed,
      retryProductFailed,
      maxAttemptsPerTask,
      continueAfterTrainReplayFailure,
      trainLimit: trainLimitRaw ? Math.max(1, Number.parseInt(trainLimitRaw, 10)) : undefined,
      testLimit: testLimitRaw ? Math.max(1, Number.parseInt(testLimitRaw, 10)) : undefined,
      campaignRounds,
      validateRounds,
      repairAttempts,
      mergePromptPath: mergeControl.mergePromptPath,
      mergeRepairPromptPath: mergeControl.mergeRepairPromptPath,
      hierarchicalMergePromptPath: mergeControl.hierarchicalMergePromptPath,
      hierarchicalMergeRepairPromptPath: mergeControl.hierarchicalMergeRepairPromptPath,
      mergeContractPath: mergeControl.mergeContractPath,
    }
  }
  if (stopAfter === "merge") {
    return {
      label,
      taskPackRoot,
      trainSplit,
      testSplit,
      taskIDs,
      testTaskIDs,
      outDir,
      concurrency,
      adaptiveConcurrency: adaptiveTraining.audit,
      stageConcurrency,
      mode: modeOpt,
      stopAfter,
      dryRun: hasFlag(args, "--dry-run"),
      reuseVerified: !hasFlag(args, "--no-reuse-verified"),
      resumeRunning: !hasFlag(args, "--no-resume-running"),
      runMerge: true,
      ...mergeConfig,
      runTrainReplay: false,
      mergeAcceptanceProfile: mergeAcceptanceProfile.profileName,
      mergeAcceptanceProfileSource: mergeAcceptanceProfile.source,
      mergeAcceptanceProfileDescription: mergeAcceptanceProfile.description,
      mergeAcceptancePreset,
      mergeAcceptanceStages,
      mergeAcceptanceSuccessCriterion,
      runTest: false,
      evalRunner,
      directChat,
      runBaseline: false,
      continueAfterTrainingIncomplete,
      trainReplayScope,
      replayConcurrency,
      testConcurrency,
      baselineConcurrency,
      historyPolicy,
      resumeMode,
      excludedTaskIDs,
      retryInfraFailed,
      retryProductFailed,
      maxAttemptsPerTask,
      continueAfterTrainReplayFailure,
      trainLimit: trainLimitRaw ? Math.max(1, Number.parseInt(trainLimitRaw, 10)) : undefined,
      testLimit: testLimitRaw ? Math.max(1, Number.parseInt(testLimitRaw, 10)) : undefined,
      campaignRounds,
      validateRounds,
      repairAttempts,
      mergePromptPath: mergeControl.mergePromptPath,
      mergeRepairPromptPath: mergeControl.mergeRepairPromptPath,
      hierarchicalMergePromptPath: mergeControl.hierarchicalMergePromptPath,
      hierarchicalMergeRepairPromptPath: mergeControl.hierarchicalMergeRepairPromptPath,
      mergeContractPath: mergeControl.mergeContractPath,
    }
  }
  if (stopAfter === "train-replay") {
    return {
      label,
      taskPackRoot,
      trainSplit,
      testSplit,
      taskIDs,
      testTaskIDs,
      outDir,
      concurrency,
      adaptiveConcurrency: adaptiveTraining.audit,
      stageConcurrency,
      mode: modeOpt,
      stopAfter,
      dryRun: hasFlag(args, "--dry-run"),
      reuseVerified: !hasFlag(args, "--no-reuse-verified"),
      resumeRunning: !hasFlag(args, "--no-resume-running"),
      runMerge: true,
      ...mergeConfig,
      runTrainReplay: mergeAcceptanceRunsReplay(mergeAcceptanceStages),
      mergeAcceptanceProfile: mergeAcceptanceProfile.profileName,
      mergeAcceptanceProfileSource: mergeAcceptanceProfile.source,
      mergeAcceptanceProfileDescription: mergeAcceptanceProfile.description,
      mergeAcceptancePreset,
      mergeAcceptanceStages,
      mergeAcceptanceSuccessCriterion,
      runTest: false,
      evalRunner,
      directChat,
      runBaseline: false,
      continueAfterTrainingIncomplete,
      trainReplayScope,
      replayConcurrency,
      testConcurrency,
      baselineConcurrency,
      historyPolicy,
      resumeMode,
      excludedTaskIDs,
      retryInfraFailed,
      retryProductFailed,
      maxAttemptsPerTask,
      continueAfterTrainReplayFailure,
      trainLimit: trainLimitRaw ? Math.max(1, Number.parseInt(trainLimitRaw, 10)) : undefined,
      testLimit: testLimitRaw ? Math.max(1, Number.parseInt(testLimitRaw, 10)) : undefined,
      campaignRounds,
      validateRounds,
      repairAttempts,
      mergePromptPath: mergeControl.mergePromptPath,
      mergeRepairPromptPath: mergeControl.mergeRepairPromptPath,
      hierarchicalMergePromptPath: mergeControl.hierarchicalMergePromptPath,
      hierarchicalMergeRepairPromptPath: mergeControl.hierarchicalMergeRepairPromptPath,
      mergeContractPath: mergeControl.mergeContractPath,
    }
  }
  if (stopAfter === "test") {
    runBaseline = false
  }
  return {
    label,
    taskPackRoot,
    trainSplit,
    testSplit,
    taskIDs,
    testTaskIDs,
    outDir,
    concurrency,
    adaptiveConcurrency: adaptiveTraining.audit,
    stageConcurrency,
    mode: modeOpt,
    stopAfter,
    dryRun: hasFlag(args, "--dry-run"),
    reuseVerified: !hasFlag(args, "--no-reuse-verified"),
    resumeRunning: !hasFlag(args, "--no-resume-running"),
    runMerge,
    mergeExecutionMode,
    mergeAsLongTask,
    ...mergeConfig,
    runTrainReplay,
    mergeAcceptanceProfile: mergeAcceptanceProfile.profileName,
    mergeAcceptanceProfileSource: mergeAcceptanceProfile.source,
    mergeAcceptanceProfileDescription: mergeAcceptanceProfile.description,
    mergeAcceptancePreset,
    mergeAcceptanceStages,
    mergeAcceptanceSuccessCriterion,
    runTest,
    evalRunner,
    directChat,
    runBaseline,
    continueAfterTrainingIncomplete,
    trainReplayScope,
    replayConcurrency,
    testConcurrency,
    baselineConcurrency,
    historyPolicy,
    resumeMode,
    excludedTaskIDs,
    retryInfraFailed,
    retryProductFailed,
    maxAttemptsPerTask,
    continueAfterTrainReplayFailure,
    trainLimit: trainLimitRaw ? Math.max(1, Number.parseInt(trainLimitRaw, 10)) : undefined,
    testLimit: testLimitRaw ? Math.max(1, Number.parseInt(testLimitRaw, 10)) : undefined,
    campaignRounds,
    validateRounds,
    repairAttempts,
    mergePromptPath: mergeControl.mergePromptPath,
    mergeRepairPromptPath: mergeControl.mergeRepairPromptPath,
    hierarchicalMergePromptPath: mergeControl.hierarchicalMergePromptPath,
    hierarchicalMergeRepairPromptPath: mergeControl.hierarchicalMergeRepairPromptPath,
    mergeContractPath: mergeControl.mergeContractPath,
  }
}

async function main() {
  const config = await parseConfig(process.argv.slice(2))
  const report = await runTaskPackBenchmark(config)
  console.log(JSON.stringify(report, null, 2))
}

if (import.meta.main && !process.execArgv.includes("--check")) {
  await main()
}
