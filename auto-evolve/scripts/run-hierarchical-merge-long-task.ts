import path from "node:path"
import { readdir, readFile } from "node:fs/promises"
import { autoEvolvePath, ensureDirectory, pathExists, readJsonFile, writeJsonFile } from "../orchestrator/fs"
import { readCampaignHealth, type CampaignHealth } from "../orchestrator/run-health"
import { loadConfig } from "../orchestrator/schema"
import {
  fingerprintMergeSkillRoot,
  runMergeLongTaskReplay,
  writeMergeLongTaskRepairTargets,
  type MergeReplayCaseResult,
} from "../orchestrator/merge-long-task-replay"
import { createMergeLongTaskPack } from "./create-merge-long-task-pack"
import {
  buildNextLevelRows,
  type HierarchicalMergeLevelOverride,
} from "./create-hierarchical-merge-long-task-pack"

type ReplayCase = {
  id: string
  title?: string
  specPath: string
  sourceID?: string
  mode?: string
}

type GeneratedGroup = {
  groupID: string
  specPath: string
  caseCount: number
  replayCaseCount?: number
  outputSkillPath?: string
}

export type HierarchicalGroupRunnerInput = {
  cwd: string
  level: number
  group: GeneratedGroup
  campaignPath: string
  campaignID?: string
  logDir: string
  resume: boolean
}

export type HierarchicalGroupRunnerResult = {
  ok: boolean
  exitCode?: number
  summary?: string
  campaignID?: string
  campaignDir?: string
  status?: string
  outputSkillPath?: string
  health?: CampaignHealth
  replay?: {
    passed: boolean
    reportPath: string
    repairTargetsPath: string
    failedCaseIDs: string[]
    missingResults: string[]
    repairAttempts?: Array<Record<string, unknown>>
    acceptanceStatus?: string
    initialReplay?: { passed: number; total: number; failed: number }
    finalReplay?: { passed: number; total: number; failed: number }
  }
}

export type HierarchicalGroupRunner = (input: HierarchicalGroupRunnerInput) => Promise<HierarchicalGroupRunnerResult>

export type ExternalMergeAcceptanceResult = {
  passed: number
  total: number
  failed: number
  skipped?: number
  durationMs?: number
  cases: MergeReplayCaseResult[]
  infrastructureFailures?: Array<{ id?: string; summary?: string }>
  resultPath?: string
  raw?: unknown
}

export type MergeAcceptancePhase =
  | "initial_replay"
  | "focused_replay"
  | "protected_replay"
  | "final_full_replay"

export type ExternalMergeAcceptanceRunner = (input: {
  candidateSkillRoot: string
  caseIDs: string[]
  outDir: string
  phase: MergeAcceptancePhase
  repairAttempt: number
}) => Promise<ExternalMergeAcceptanceResult>

export type MergeClosedLoopAcceptanceConfig = {
  stages: Array<"initial_replay" | "repair_promote" | "final_full_replay" | "strict_acceptance_gate">
  successCriterion: "all_pass" | "allow_partial" | "report_only"
  maxRepairAttempts?: number
  runner: ExternalMergeAcceptanceRunner
}

export type RunHierarchicalMergeLongTaskInput = {
  cwd: string
  taskPackRoot: string
  splitPath: string
  campaignManifestPath: string
  outRoot: string
  label?: string
  taskProfile?: "legacy" | "multi_skill_merge_v2"
  accessSystem?: "legacy" | "profile_v2"
  maxInputs?: number
  maxLevels?: number
  groupSize?: number
  groupConcurrency?: number
  replayConcurrency?: number
  watchPollMs?: number
  watchMaxPolls?: number
  maxReplayRepairAttempts?: number
  levelPlanningMode?: "until_one" | "configured_levels"
  finalizationMode?: "require_single_final" | "merge_remaining_to_one" | "promote_best_effort"
  levels?: HierarchicalMergeLevelOverride[]
  /** False defers product replay until the outer benchmark validates the final merged skill. */
  mountBlankReplay?: boolean
  dryRun?: boolean
  runner?: HierarchicalGroupRunner
  replayRunner?: typeof runMergeLongTaskReplay
  /** Optional external product runner applied to every hierarchy group. */
  perGroupAcceptance?: MergeClosedLoopAcceptanceConfig
  externalFinalAcceptance?: {
    caseIDs: string[]
  } & MergeClosedLoopAcceptanceConfig
}

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function padLevel(input: number) {
  return String(input).padStart(2, "0")
}

function readArg(flag: string) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function positiveInteger(input: unknown, label: string, fallback?: number) {
  if (input === undefined || input === null || input === "") return fallback
  const parsed = typeof input === "number" ? input : Number.parseInt(String(input), 10)
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`Invalid ${label}: ${input}`)
  return Math.floor(parsed)
}

async function readSplitIDs(splitPath: string) {
  const raw = await readJsonFile<any>(splitPath)
  let ids: string[] | undefined
  if (Array.isArray(raw)) ids = raw.map((item) => (typeof item === "string" ? item : item?.id)).filter(Boolean).map(String)
  if (!ids && Array.isArray(raw.ids)) ids = raw.ids.map(String)
  if (!ids && Array.isArray(raw.train)) {
    ids = raw.train.map((item: any) => (typeof item === "string" ? item : item?.id)).filter(Boolean).map(String)
  }
  if (!ids && Array.isArray(raw.items)) {
    ids = raw.items.map((item: any) => (typeof item === "string" ? item : item?.id)).filter(Boolean).map(String)
  }
  if (!ids) throw new Error(`Cannot read split IDs from ${splitPath}`)
  return ids.map((id) => id.trim()).filter(Boolean)
}

function sourceCasesFromManifest(items: any[]) {
  const out: string[] = []
  for (const item of items) {
    if (Array.isArray(item?.sourceCases)) {
      out.push(...item.sourceCases.map(String).map((id: string) => id.trim()).filter(Boolean))
      continue
    }
    if (typeof item?.id === "string" && item.id.trim()) out.push(item.id.trim())
  }
  return Array.from(new Set(out))
}

async function buildNextLevelRowsFromSuccessfulGroups(level: number, groups: GeneratedGroup[]) {
  const rows = await buildNextLevelRows(level, groups)
  return rows.map((row: any) => ({
    ...row,
    replayCases: Array.isArray(row.replayCases)
      ? row.replayCases.map((item: ReplayCase) => ({ ...item, specPath: path.resolve(item.specPath) }))
      : undefined,
  }))
}

function levelOverrideFor(levels: HierarchicalMergeLevelOverride[], level: number) {
  return levels.find((item) => item.level === level)
}

function sortedLevels(levels: HierarchicalMergeLevelOverride[] | undefined) {
  const seen = new Set<number>()
  const out: HierarchicalMergeLevelOverride[] = []
  for (const item of [...(levels ?? [])].sort((a, b) => a.level - b.level)) {
    if (!Number.isFinite(item.level) || item.level < 1 || seen.has(item.level)) continue
    seen.add(item.level)
    out.push(item)
  }
  return out
}

async function defaultRunner(input: HierarchicalGroupRunnerInput): Promise<HierarchicalGroupRunnerResult> {
  await ensureDirectory(input.logDir)
  const command = input.resume ? "resume-long-task-campaign" : "run-long-task-campaign"
  const args = input.resume
    ? ["run", "auto-evolve/cli.ts", command, "--campaign", input.campaignID ?? "", "--spec", input.campaignPath]
    : ["run", "auto-evolve/cli.ts", command, "--spec", input.campaignPath]
  if (input.resume && !input.campaignID) throw new Error(`Cannot resume merge group without campaignID: ${input.group.groupID}`)
  const child = Bun.spawn(["bun", ...args], {
    cwd: input.cwd,
    stdout: Bun.file(path.join(input.logDir, "stdout.log")),
    stderr: Bun.file(path.join(input.logDir, "stderr.log")),
    windowsHide: true,
  })
  const exitCode = await child.exited
  return {
    ok: exitCode === 0,
    exitCode,
    summary: `campaign ${path.basename(path.dirname(input.campaignPath))} exited ${exitCode}`,
  }
}

type GroupCampaignRow = {
  campaignID: string
  campaignDir: string
  status: string
  baseSpecPath?: string
  updatedAt?: string
  heartbeatAt?: string
  pendingSkillPath: string
  taskWorkspaceSkillPath: string
  health?: CampaignHealth
}

function parseDateRank(input: string | undefined) {
  const parsed = typeof input === "string" ? Date.parse(input) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

async function readJsonLenient(file: string) {
  try {
    const raw = await readFile(file, "utf8")
    if (!raw.trim()) return undefined
    return JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>
  } catch {
    return undefined
  }
}

async function findCampaignForGroup(cwd: string, group: GeneratedGroup): Promise<GroupCampaignRow | undefined> {
  const specPath = path.resolve(group.specPath)
  const taskWorkspaceSkillPath = path.join(path.dirname(specPath), "workspace", "merged-skill")
  const campaignRoot = autoEvolvePath(cwd, "runtime-state", "long-task-campaigns")
  const entries = await readdir(campaignRoot, { withFileTypes: true }).catch(() => [])
  const matches: GroupCampaignRow[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const campaignDir = path.join(campaignRoot, entry.name)
    const state = await readJsonLenient(path.join(campaignDir, "campaign.json"))
    if (!state) continue
    const baseSpecPath = typeof state.baseSpecPath === "string" ? path.resolve(state.baseSpecPath) : ""
    if (baseSpecPath !== specPath) continue
    const health = await readCampaignHealth(campaignDir)
    matches.push({
      campaignID: String(state.id ?? entry.name),
      campaignDir,
      status: String(state.status ?? ""),
      baseSpecPath: typeof state.baseSpecPath === "string" ? state.baseSpecPath : undefined,
      updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : undefined,
      heartbeatAt: typeof state.heartbeatAt === "string" ? state.heartbeatAt : undefined,
      pendingSkillPath: path.join(campaignDir, "pending-expert-package", "current"),
      taskWorkspaceSkillPath,
      health,
    })
  }
  return matches.sort((left, right) => {
    const byScore = campaignStatusScore(right.status) - campaignStatusScore(left.status)
    if (byScore !== 0) return byScore
    return parseDateRank(right.updatedAt ?? right.heartbeatAt) - parseDateRank(left.updatedAt ?? left.heartbeatAt)
  })[0]
}

function campaignStatusScore(status: string) {
  if (status === "verified_success") return 100
  if (status === "running" || status === "bootstrapping") return 80
  if (status === "recovery_pending") return 70
  if (status === "round_limit_reached" || status === "failed" || status === "blocked_failure" || status === "stagnation_failure") {
    return 50
  }
  return 0
}

function isTerminalFailureStatus(status: string) {
  return (
    status === "round_limit_reached" ||
    status === "failed" ||
    status === "blocked_failure" ||
    status === "stagnation_failure" ||
    status === "aborted" ||
    status === "exhausted_failure"
  )
}

async function outputSkillPath(row: GroupCampaignRow | undefined, group: GeneratedGroup) {
  if (row && (await pathExists(row.pendingSkillPath))) return row.pendingSkillPath
  const taskWorkspaceSkillPath = path.join(path.dirname(path.resolve(group.specPath)), "workspace", "merged-skill")
  if (await pathExists(taskWorkspaceSkillPath)) return taskWorkspaceSkillPath
  return undefined
}

async function runOneGroupWithSupervisor(input: {
  cwd: string
  level: number
  group: GeneratedGroup
  campaignPath: string
  logDir: string
  runner: HierarchicalGroupRunner
  pollMs?: number
  maxPolls?: number
}): Promise<HierarchicalGroupRunnerResult> {
  const pollMs = input.pollMs ?? 10_000
  const maxPolls = input.maxPolls ?? 720
  let polls = 0
  let lastSummary = ""

  while (true) {
    const row = await findCampaignForGroup(input.cwd, input.group)
    const health = row?.health
    const skillPath = await outputSkillPath(row, input.group)
    if (row?.status === "verified_success" && skillPath) {
      return {
        ok: true,
        campaignID: row.campaignID,
        campaignDir: row.campaignDir,
        status: row.status,
        outputSkillPath: skillPath,
        health,
        summary: `group ${input.group.groupID} verified_success`,
      }
    }
    if (row && isTerminalFailureStatus(row.status)) {
      return {
        ok: false,
        campaignID: row.campaignID,
        campaignDir: row.campaignDir,
        status: row.status,
        outputSkillPath: skillPath,
        health,
        summary: `group ${input.group.groupID} terminal ${row.status}`,
      }
    }
    if (health?.suggestedAction === "watch") {
      if (polls++ >= maxPolls) {
        return {
          ok: false,
          campaignID: row?.campaignID,
          campaignDir: row?.campaignDir,
          status: row?.status ?? "watch_timeout",
          health,
          summary: `group ${input.group.groupID} remained watch_live after ${maxPolls} polls`,
        }
      }
      lastSummary = `watch ${input.group.groupID}: ${health.health} ${health.currentRound ?? ""}/${health.maxRounds ?? ""}`
      await new Promise((resolve) => setTimeout(resolve, pollMs))
      continue
    }

    const resume = Boolean(row && (health?.suggestedAction === "resume" || health?.suggestedAction === "takeover"))
    const runResult = await input.runner({
      cwd: input.cwd,
      level: input.level,
      group: input.group,
      campaignPath: input.campaignPath,
      campaignID: row?.campaignID,
      logDir: input.logDir,
      resume,
    })
    const after = await findCampaignForGroup(input.cwd, input.group)
    const afterSkillPath = await outputSkillPath(after, input.group)
    if (after?.status === "verified_success" && afterSkillPath) {
      return {
        ...runResult,
        ok: true,
        campaignID: after.campaignID,
        campaignDir: after.campaignDir,
        status: after.status,
        outputSkillPath: afterSkillPath,
        health: after.health,
        summary: runResult.summary ?? `group ${input.group.groupID} verified_success`,
      }
    }
    if (after && after.health?.suggestedAction === "watch") {
      lastSummary = runResult.summary ?? lastSummary
      await new Promise((resolve) => setTimeout(resolve, pollMs))
      continue
    }
    if (after && (after.health?.suggestedAction === "resume" || after.health?.suggestedAction === "takeover")) {
      lastSummary = runResult.summary ?? lastSummary
      continue
    }
    if (after && isTerminalFailureStatus(after.status)) {
      return {
        ...runResult,
        ok: false,
        campaignID: after.campaignID,
        campaignDir: after.campaignDir,
        status: after.status,
        outputSkillPath: afterSkillPath,
        health: after.health,
        summary: runResult.summary ?? `group ${input.group.groupID} terminal ${after.status}`,
      }
    }
    if (!runResult.ok) return { ...runResult, summary: runResult.summary ?? lastSummary }
    if (!after) return runResult
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  shouldStopScheduling?: (result: R) => boolean,
) {
  const results: Array<R | undefined> = new Array(items.length)
  let next = 0
  let stopScheduling = false
  async function runWorker() {
    while (!stopScheduling && next < items.length) {
      const index = next++
      const result = await worker(items[index]!, index)
      results[index] = result
      if (shouldStopScheduling?.(result)) stopScheduling = true
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runWorker())
  await Promise.all(workers)
  return results
}

async function writeLevelInputs(inputDir: string, level: number, rows: any[]) {
  const nextInputDir = path.join(inputDir, `level-${padLevel(level)}`)
  await ensureDirectory(nextInputDir)
  const manifestPath = path.join(nextInputDir, "campaign-manifest.json")
  const splitPath = path.join(nextInputDir, "split.json")
  await writeJsonFile(manifestPath, {
    schema: "hierarchical-merge-input-manifest/v1",
    sourceLevel: level - 1,
    items: rows,
  })
  await writeJsonFile(splitPath, { ids: rows.map((row) => row.id) })
  return { manifestPath, splitPath }
}

async function createRepairGroup(input: {
  cwd: string
  taskPackRoot: string
  originalGroup: GeneratedGroup
  candidateSkillRoot: string
  repairTargetsPath: string
  outRoot: string
  level: number
  attempt: number
  label: string
  taskProfile: "legacy" | "multi_skill_merge_v2"
  accessSystem: "legacy" | "profile_v2"
  replayConcurrency: number
  surfaceProfileSet?: string
  surfaceValidatorProfiles?: string[]
  blankAcceptanceScenario: string
}) {
  const originalTaskDir = path.dirname(path.resolve(input.originalGroup.specPath))
  const originalMaterialsDir = path.join(originalTaskDir, "materials")
  const sourceSkillIndexPath = path.join(originalMaterialsDir, "source-skill-index.json")
  const sourceIndex = await readJsonFile<any>(sourceSkillIndexPath)
  const sourceCases = Array.isArray(sourceIndex.entries)
    ? sourceIndex.entries.map((item: any) => String(item?.sourceCaseID ?? "").trim()).filter(Boolean)
    : []
  if (!sourceCases.length) throw new Error(`MSL repair cannot read source cases from ${sourceSkillIndexPath}`)
  const replayPlan = await readJsonFile<any>(path.join(originalMaterialsDir, "replay-plan.json"))
  const replayCases = (Array.isArray(replayPlan.cases) ? replayPlan.cases : []).map((item: any) => {
    const id = String(item?.id ?? "").trim()
    const specPath = String(item?.specPath ?? "").trim()
    if (!id || !specPath) throw new Error(`MSL repair replay plan contains an invalid case in ${originalMaterialsDir}`)
    return {
      ...item,
      id,
      specPath: path.resolve(originalMaterialsDir, specPath),
    }
  })
  const repairID = `repair-baseline-${String(input.attempt).padStart(2, "0")}`
  const repairRoot = path.join(
    input.outRoot,
    "repairs",
    `level-${padLevel(input.level)}`,
    input.originalGroup.groupID,
    `attempt-${String(input.attempt).padStart(2, "0")}`,
  )
  const manifestPath = path.join(repairRoot, "repair-manifest.json")
  const splitPath = path.join(repairRoot, "repair-split.json")
  await ensureDirectory(repairRoot)
  await writeJsonFile(manifestPath, {
    schema: "merge-long-task-repair-manifest/v1",
    items: [
      {
        id: repairID,
        sourceKind: "repair_baseline",
        status: "verified_success",
        verified: true,
        skillRoot: path.resolve(input.candidateSkillRoot),
        sourceCases,
        replayCases,
        sourceSkillIndexPath,
        repairTargetsPath: path.resolve(input.repairTargetsPath),
      },
    ],
  })
  await writeJsonFile(splitPath, { ids: [repairID] })
  const generated = await createMergeLongTaskPack({
    cwd: input.cwd,
    taskPackRoot: input.taskPackRoot,
    splitPath,
    campaignManifestPath: manifestPath,
    outTaskPack: path.join(repairRoot, "task-pack"),
    label: `${input.label}-repair-${input.attempt}`,
    taskProfile: input.taskProfile,
    accessSystem: input.accessSystem,
    groupSize: 1,
    replayConcurrency: input.replayConcurrency,
    surfaceProfileSet: input.surfaceProfileSet,
    surfaceValidatorProfiles: input.surfaceValidatorProfiles,
    blankAcceptanceScenario: input.blankAcceptanceScenario,
    mountBlankReplay: false,
    inputSelection: "success_only",
  })
  const group = generated.groups[0]
  if (!group) throw new Error(`MSL repair pack did not generate a group at ${repairRoot}`)
  return { group, repairRoot }
}

function validateExternalAcceptanceResult(caseIDs: string[], result: ExternalMergeAcceptanceResult) {
  if (result.infrastructureFailures?.length) {
    const preview = result.infrastructureFailures
      .slice(0, 5)
      .map((item) => `${item.id ?? "unknown"}: ${item.summary ?? "infrastructure failure"}`)
      .join("; ")
    throw new Error(
      `External MSL acceptance returned ${result.infrastructureFailures.length} infrastructure failure(s); ` +
        `refusing to start Skill repair. ${preview}`,
    )
  }
  const expected = new Set(caseIDs)
  const seen = new Set<string>()
  for (const item of result.cases) {
    if (!expected.has(item.id)) throw new Error(`External MSL acceptance returned unexpected case: ${item.id}`)
    if (seen.has(item.id)) throw new Error(`External MSL acceptance returned duplicate case: ${item.id}`)
    seen.add(item.id)
  }
  const missing = caseIDs.filter((id) => !seen.has(id))
  if (missing.length) throw new Error(`External MSL acceptance omitted case(s): ${missing.join(", ")}`)
  const passed = result.cases.filter((item) => item.passed).length
  if (result.total !== caseIDs.length || result.passed !== passed || result.failed !== caseIDs.length - passed) {
    throw new Error(
      `External MSL acceptance summary mismatch: expected total=${caseIDs.length}, passed=${passed}; ` +
        `got total=${result.total}, passed=${result.passed}, failed=${result.failed}`,
    )
  }
}

async function readGroupReplayCaseIDs(group: GeneratedGroup) {
  const planPath = path.join(path.dirname(path.resolve(group.specPath)), "materials", "replay-plan.json")
  const plan = await readJsonFile<{ cases?: Array<{ id?: string }> }>(planPath)
  const caseIDs = (plan.cases ?? []).map((item) => String(item.id ?? "").trim()).filter(Boolean)
  if (!caseIDs.length) throw new Error(`MSL group replay plan has no cases: ${planPath}`)
  if (new Set(caseIDs).size !== caseIDs.length) throw new Error(`MSL group replay plan contains duplicate cases: ${planPath}`)
  return caseIDs
}

async function runExternalFinalAcceptance(input: {
  cwd: string
  taskPackRoot: string
  outRoot: string
  label: string
  level: number
  finalGroup: GeneratedGroup
  initialSkillRoot: string
  taskProfile: "legacy" | "multi_skill_merge_v2"
  accessSystem: "legacy" | "profile_v2"
  replayConcurrency: number
  watchPollMs: number
  watchMaxPolls: number
  maxReplayRepairAttempts: number
  surfaceProfileSet?: string
  surfaceValidatorProfiles?: string[]
  blankAcceptanceScenario: string
  config: MergeClosedLoopAcceptanceConfig
  groupRunner: HierarchicalGroupRunner
  caseIDs: string[]
  rootDir?: string
  reportSchema?: string
}) {
  const root = path.resolve(input.rootDir ?? path.join(input.outRoot, "external-final-acceptance"))
  const allCaseIDs = [...new Set(input.caseIDs.map((id) => id.trim()).filter(Boolean))]
  if (!allCaseIDs.length) throw new Error("External MSL acceptance requires at least one case ID")
  await ensureDirectory(root)
  const reportPath = path.join(root, "report.json")
  const statePath = path.join(root, "closed-loop-state.json")
  const maxRepairs = input.config.maxRepairAttempts ?? input.maxReplayRepairAttempts
  let resumableReport: any | undefined
  if (await pathExists(reportPath)) {
    const persisted = await readJsonFile<any>(reportPath)
    const sameCases =
      Array.isArray(persisted.caseIDs) &&
      persisted.caseIDs.length === allCaseIDs.length &&
      persisted.caseIDs.every((id: unknown, index: number) => String(id) === allCaseIDs[index])
    const sameStages =
      Array.isArray(persisted.stagesRun) &&
      persisted.stagesRun.length === input.config.stages.length &&
      persisted.stagesRun.every((stage: unknown, index: number) => String(stage) === input.config.stages[index])
    const terminalStatus = new Set([
      "replay_passed",
      "repair_promoted",
      "final_replay_passed",
      "replay_failed",
      "acceptance_exhausted",
      "final_replay_failed",
    ]).has(String(persisted.acceptanceStatus ?? ""))
    const persistedRepairBudget = Number.isFinite(Number(persisted.maxRepairAttempts))
      ? Number(persisted.maxRepairAttempts)
      : Number(persisted.repairAttempts ?? 0)
    const repairBudgetCompatible =
      persisted.acceptanceStatus !== "acceptance_exhausted" || persistedRepairBudget >= maxRepairs
    const sameRunContract =
      persisted.schema === (input.reportSchema ?? "merge-long-task-external-final-acceptance/v1") &&
      typeof persisted.accepted === "boolean" &&
      path.resolve(String(persisted.initialSkillPath ?? "")) === path.resolve(input.initialSkillRoot) &&
      persisted.successCriterion === input.config.successCriterion &&
      sameCases &&
      sameStages &&
      typeof persisted.finalSkillPath === "string" &&
      (await pathExists(path.resolve(persisted.finalSkillPath)))
    const lastRepair = Array.isArray(persisted.repairs) ? persisted.repairs.at(-1) : undefined
    const lastEvaluation = Array.isArray(persisted.evaluations) ? persisted.evaluations.at(-1) : undefined
    const interruptedBeforeBudget =
      sameRunContract &&
      persisted.acceptanceStatus === "replay_failed" &&
      Number(persisted.repairAttempts ?? 0) < maxRepairs &&
      lastRepair?.ok === false &&
      typeof lastEvaluation?.resultPath === "string" &&
      (await pathExists(path.resolve(lastEvaluation.resultPath)))
    const reusable = sameRunContract && terminalStatus && repairBudgetCompatible && !interruptedBeforeBudget
    if (reusable) return { ...persisted, reportPath: normalizeSlash(reportPath), reused: true }
    if (interruptedBeforeBudget) resumableReport = persisted
  }
  if (!resumableReport && (await pathExists(statePath))) {
    const persistedState = await readJsonFile<any>(statePath)
    const sameCases =
      Array.isArray(persistedState.scopeCaseIDs) &&
      persistedState.scopeCaseIDs.length === allCaseIDs.length &&
      persistedState.scopeCaseIDs.every((id: unknown, index: number) => String(id) === allCaseIDs[index])
    const repairAttempt = Number(persistedState.repairAttempt ?? 0)
    const candidateSkillRoot = path.resolve(String(persistedState.candidateSkillRoot ?? ""))
    const evaluations = Array.isArray(persistedState.evaluations) ? persistedState.evaluations : []
    const pendingFailureCaseIDs = Array.isArray(persistedState.pendingFailureCaseIDs)
      ? persistedState.pendingFailureCaseIDs.map(String)
      : []
    const resumableState =
      persistedState.schema === "merge-long-task-closed-loop-state/v1" &&
      sameCases &&
      repairAttempt < maxRepairs &&
      evaluations.length > 0 &&
      pendingFailureCaseIDs.length > 0 &&
      (await pathExists(candidateSkillRoot))
    if (resumableState) {
      const initialEvaluation = evaluations[0]
      resumableReport = {
        evaluations,
        repairs: Array.isArray(persistedState.repairs) ? persistedState.repairs : [],
        finalSkillPath: candidateSkillRoot,
        repairAttempts: repairAttempt,
        failedCaseIDs: pendingFailureCaseIDs,
        initialReplay: {
          passed: Number(initialEvaluation.passed ?? 0),
          total: Number(initialEvaluation.total ?? allCaseIDs.length),
          failed: Number(initialEvaluation.failed ?? pendingFailureCaseIDs.length),
        },
      }
    }
  }
  const evaluations: Array<Record<string, unknown>> = Array.isArray(resumableReport?.evaluations)
    ? [...resumableReport.evaluations]
    : []
  const repairs: Array<Record<string, unknown>> = Array.isArray(resumableReport?.repairs)
    ? [...resumableReport.repairs]
    : []
  let candidateSkillRoot = path.resolve(resumableReport?.finalSkillPath ?? input.initialSkillRoot)
  let repairAttempt = Number(resumableReport?.repairAttempts ?? 0)

  const evaluate = async (
    caseIDs: string[],
    phase: MergeAcceptancePhase,
  ) => {
    const sequence = evaluations.length + 1
    const outDir = path.join(root, `evaluation-${String(sequence).padStart(2, "0")}-${phase}`)
    const candidateSkillFingerprint = await fingerprintMergeSkillRoot(candidateSkillRoot)
    const result = await input.config.runner({
      candidateSkillRoot,
      caseIDs,
      outDir,
      phase,
      repairAttempt,
    })
    validateExternalAcceptanceResult(caseIDs, result)
    evaluations.push({
      sequence,
      phase,
      repairAttempt,
      candidateSkillRoot: normalizeSlash(candidateSkillRoot),
      candidateSkillFingerprint,
      caseIDs,
      passed: result.passed,
      total: result.total,
      failed: result.failed,
      resultPath: result.resultPath ? normalizeSlash(result.resultPath) : undefined,
    })
    await writeJsonFile(statePath, {
      schema: "merge-long-task-closed-loop-state/v1",
      updatedAt: new Date().toISOString(),
      phase,
      repairAttempt,
      scopeCaseIDs: allCaseIDs,
      candidateSkillRoot: normalizeSlash(candidateSkillRoot),
      candidateSkillFingerprint,
      stableCaseIDs: allCaseIDs.filter((id) => result.cases.some((item) => item.id === id && item.passed)),
      pendingFailureCaseIDs: result.cases.filter((item) => !item.passed).map((item) => item.id),
      evaluations,
      repairs,
    })
    return { result, outDir }
  }

  let latest: { result: ExternalMergeAcceptanceResult; outDir: string }
  let initialReplay: { passed: number; total: number; failed: number }
  let failedCaseIDs: string[]
  if (resumableReport) {
    const lastEvaluation = evaluations.at(-1) as Record<string, unknown>
    const sequence = Number(lastEvaluation.sequence)
    const phase = String(lastEvaluation.phase)
    const evaluationDir = path.join(root, `evaluation-${String(sequence).padStart(2, "0")}-${phase}`)
    const resultCandidates = [
      path.join(evaluationDir, "result.json"),
      typeof lastEvaluation.resultPath === "string" ? path.resolve(lastEvaluation.resultPath) : "",
    ].filter(Boolean)
    let result: ExternalMergeAcceptanceResult | undefined
    let resultPath = ""
    for (const candidate of resultCandidates) {
      if (!(await pathExists(candidate))) continue
      const parsed = await readJsonFile<ExternalMergeAcceptanceResult>(candidate)
      if (!Array.isArray(parsed.cases)) continue
      result = parsed
      resultPath = candidate
      break
    }
    if (!result) {
      throw new Error(
        `Cannot resume MSL acceptance: no case-level result found for evaluation ${sequence} (${phase}) under ${evaluationDir}`,
      )
    }
    validateExternalAcceptanceResult(
      Array.isArray(lastEvaluation.caseIDs) ? lastEvaluation.caseIDs.map(String) : result.cases.map((item) => item.id),
      result,
    )
    latest = { result, outDir: path.dirname(resultPath) }
    initialReplay = resumableReport.initialReplay
    failedCaseIDs = Array.isArray(resumableReport.failedCaseIDs)
      ? resumableReport.failedCaseIDs.map(String)
      : result.cases.filter((item) => !item.passed).map((item) => item.id)
  } else {
    latest = await evaluate(allCaseIDs, "initial_replay")
    initialReplay = { passed: latest.result.passed, total: latest.result.total, failed: latest.result.failed }
    failedCaseIDs = latest.result.cases.filter((item) => !item.passed).map((item) => item.id)
  }
  let stabilized = failedCaseIDs.length === 0
  const repairEnabled = input.config.stages.includes("repair_promote")

  while (!stabilized && repairEnabled && repairAttempt < maxRepairs) {
    repairAttempt += 1
    const repairTargets = await writeMergeLongTaskRepairTargets({
      mergeSpecPath: input.finalGroup.specPath,
      candidateSkillRoot,
      outDir: path.join(root, "repair-targets", `attempt-${String(repairAttempt).padStart(2, "0")}`),
      caseIDs: failedCaseIDs,
      protectedCaseIDs: allCaseIDs.filter((id) => !failedCaseIDs.includes(id)),
      caseResults: latest.result.cases,
    })
    const repairPack = await createRepairGroup({
      cwd: input.cwd,
      taskPackRoot: input.taskPackRoot,
      originalGroup: input.finalGroup,
      candidateSkillRoot,
      repairTargetsPath: repairTargets.repairTargetsPath,
      outRoot: input.outRoot,
      level: input.level,
      attempt: repairAttempt,
      label: `${input.label}-external-final`,
      taskProfile: input.taskProfile,
      accessSystem: input.accessSystem,
      replayConcurrency: input.replayConcurrency,
      surfaceProfileSet: input.surfaceProfileSet,
      surfaceValidatorProfiles: input.surfaceValidatorProfiles,
      blankAcceptanceScenario: input.blankAcceptanceScenario,
    })
    const repairTaskDir = path.dirname(path.resolve(repairPack.group.specPath))
    const repairRun = await runOneGroupWithSupervisor({
      cwd: input.cwd,
      level: input.level,
      group: repairPack.group,
      campaignPath: path.join(repairTaskDir, "campaign.json"),
      logDir: path.join(root, "repair-logs", `attempt-${String(repairAttempt).padStart(2, "0")}`),
      runner: input.groupRunner,
      pollMs: input.watchPollMs,
      maxPolls: input.watchMaxPolls,
    })
    repairs.push({
      attempt: repairAttempt,
      failedCaseIDs,
      repairTargetsPath: normalizeSlash(repairTargets.repairTargetsPath),
      campaignID: repairRun.campaignID,
      campaignDir: repairRun.campaignDir,
      status: repairRun.status,
      ok: repairRun.ok,
      outputSkillPath: repairRun.outputSkillPath,
    })
    await writeJsonFile(statePath, {
      schema: "merge-long-task-closed-loop-state/v1",
      updatedAt: new Date().toISOString(),
      phase: repairRun.ok ? "repair_completed" : "repair_failed",
      repairAttempt,
      scopeCaseIDs: allCaseIDs,
      candidateSkillRoot: normalizeSlash(candidateSkillRoot),
      stableCaseIDs: allCaseIDs.filter((id) => !failedCaseIDs.includes(id)),
      pendingFailureCaseIDs: failedCaseIDs,
      evaluations,
      repairs,
    })
    // A failed repair campaign consumes one outer attempt but must not truncate
    // the configured closed-loop budget. Keep the last accepted candidate and retry.
    if (!repairRun.ok || !repairRun.outputSkillPath) continue
    candidateSkillRoot = path.resolve(repairRun.outputSkillPath)

    const focusedIDs = [...failedCaseIDs]
    latest = await evaluate(focusedIDs, "focused_replay")
    failedCaseIDs = latest.result.cases.filter((item) => !item.passed).map((item) => item.id)
    if (failedCaseIDs.length) continue

    const protectedIDs = allCaseIDs.filter((id) => !focusedIDs.includes(id))
    if (protectedIDs.length) {
      latest = await evaluate(protectedIDs, "protected_replay")
      failedCaseIDs = latest.result.cases.filter((item) => !item.passed).map((item) => item.id)
      if (failedCaseIDs.length) continue
    }
    stabilized = true
  }

  let finalReplay: { passed: number; total: number; failed: number } | undefined
  if (stabilized && input.config.stages.includes("final_full_replay")) {
    latest = await evaluate(allCaseIDs, "final_full_replay")
    finalReplay = { passed: latest.result.passed, total: latest.result.total, failed: latest.result.failed }
    failedCaseIDs = latest.result.cases.filter((item) => !item.passed).map((item) => item.id)
    stabilized = failedCaseIDs.length === 0
  }

  const decisivePassed = stabilized ? allCaseIDs.length : allCaseIDs.length - failedCaseIDs.length
  const accepted =
    input.config.successCriterion === "report_only"
      ? true
      : input.config.successCriterion === "allow_partial"
        ? decisivePassed > 0
        : stabilized
  const acceptanceStatus =
    finalReplay
      ? stabilized
        ? "final_replay_passed"
        : "final_replay_failed"
      : stabilized
        ? repairAttempt > 0
          ? "repair_promoted"
          : "replay_passed"
        : repairEnabled && repairAttempt >= maxRepairs
          ? "acceptance_exhausted"
          : "replay_failed"
  const report = {
    schema: input.reportSchema ?? "merge-long-task-external-final-acceptance/v1",
    generatedAt: new Date().toISOString(),
    runner: "external",
    initialSkillPath: normalizeSlash(path.resolve(input.initialSkillRoot)),
    caseIDs: allCaseIDs,
    stagesRun: input.config.stages,
    successCriterion: input.config.successCriterion,
    maxRepairAttempts: maxRepairs,
    acceptanceStatus,
    accepted,
    initialReplay,
    finalReplay,
    passed: decisivePassed,
    total: allCaseIDs.length,
    failed: allCaseIDs.length - decisivePassed,
    failedCaseIDs,
    repairAttempts: repairAttempt,
    repairs,
    evaluations,
    finalSkillPath: normalizeSlash(candidateSkillRoot),
    finalSkillFingerprint: await fingerprintMergeSkillRoot(candidateSkillRoot),
  }
  await writeJsonFile(reportPath, report)
  await writeJsonFile(statePath, {
    schema: "merge-long-task-closed-loop-state/v1",
    updatedAt: new Date().toISOString(),
    phase: accepted ? "accepted" : acceptanceStatus,
    repairAttempt,
    scopeCaseIDs: allCaseIDs,
    candidateSkillRoot: normalizeSlash(candidateSkillRoot),
    candidateSkillFingerprint: report.finalSkillFingerprint,
    acceptedSkillRoot: accepted ? normalizeSlash(candidateSkillRoot) : undefined,
    stableCaseIDs: accepted ? allCaseIDs : allCaseIDs.filter((id) => !failedCaseIDs.includes(id)),
    pendingFailureCaseIDs: failedCaseIDs,
    evaluations,
    repairs,
  })
  return { ...report, reportPath: normalizeSlash(reportPath) }
}

function groupStateRow(group: GeneratedGroup, result: any) {
  if (!result) {
    return {
      groupID: group.groupID,
      status: "not_started",
      ok: false,
      skipped: false,
      specPath: normalizeSlash(path.resolve(group.specPath)),
      caseCount: group.caseCount,
      replayCaseCount: group.replayCaseCount,
      summary: "Not started because an earlier group failed closed.",
    }
  }
  const health = result?.health as CampaignHealth | undefined
  const status = result?.skipped
    ? "dry_run"
    : result?.ok
      ? "verified_success"
      : health?.suggestedAction === "watch"
        ? "watch_live"
        : result?.status ?? "failed"
  return {
    groupID: group.groupID,
    status,
    ok: Boolean(result?.ok),
    skipped: Boolean(result?.skipped),
    specPath: normalizeSlash(path.resolve(group.specPath)),
    caseCount: group.caseCount,
    replayCaseCount: group.replayCaseCount,
    campaignID: result?.campaignID,
    campaignDir: result?.campaignDir ? normalizeSlash(result.campaignDir) : undefined,
    outputSkillPath: result?.outputSkillPath ? normalizeSlash(result.outputSkillPath) : undefined,
    health: health
      ? {
          health: health.health,
          suggestedAction: health.suggestedAction,
          currentRound: health.currentRound,
          maxRounds: health.maxRounds,
          ownerPID: health.ownerPID,
          reason: health.reason,
        }
      : undefined,
    summary: result?.summary,
    replay: result?.replay,
  }
}

export async function runHierarchicalMergeLongTask(input: RunHierarchicalMergeLongTaskInput) {
  const cwd = path.resolve(input.cwd)
  const config = await loadConfig(cwd)
  const hierarchical = config.mergeConfig.asLongTask.hierarchical
  const taskPackRoot = path.resolve(input.taskPackRoot)
  const outRoot = path.resolve(input.outRoot)
  const inputDir = path.join(outRoot, "_live-inputs")
  const statePath = path.join(outRoot, "hierarchical-live-state.json")
  const runner = input.runner ?? defaultRunner
  const replayRunner = input.replayRunner ?? runMergeLongTaskReplay
  const maxLevels = positiveInteger(input.maxLevels, "hierarchical max levels", hierarchical.maxLevels)!
  const defaultGroupSize = positiveInteger(input.groupSize, "hierarchical group size", hierarchical.groupSize)!
  const defaultGroupConcurrency = positiveInteger(input.groupConcurrency, "hierarchical group concurrency", hierarchical.groupConcurrency)!
  const defaultReplayConcurrency = positiveInteger(input.replayConcurrency, "hierarchical replay concurrency", hierarchical.blankReplayConcurrency)!
  const watchPollMs = positiveInteger(input.watchPollMs, "hierarchical watch poll ms", hierarchical.watchPollMs)!
  const watchMaxPolls = positiveInteger(input.watchMaxPolls, "hierarchical watch max polls", hierarchical.watchMaxPolls)!
  const maxReplayRepairAttempts = positiveInteger(
    input.maxReplayRepairAttempts,
    "hierarchical replay repair attempts",
    hierarchical.maxReplayRepairAttempts,
  )!
  const levelPlanningMode = input.levelPlanningMode ?? hierarchical.levelPlanningMode
  const finalizationMode = input.finalizationMode ?? hierarchical.finalizationMode
  const levelOverrides = sortedLevels(input.levels ?? hierarchical.levels)
  const runPerGroupReplay = input.mountBlankReplay !== false || Boolean(input.perGroupAcceptance)
  const taskProfile = input.taskProfile ?? config.mergeConfig.asLongTask.taskProfile
  const accessSystem = input.accessSystem ?? config.mergeConfig.asLongTask.accessSystem

  await ensureDirectory(outRoot)
  await ensureDirectory(inputDir)

  let currentSplitPath = path.resolve(input.splitPath)
  let currentManifestPath = path.resolve(input.campaignManifestPath)
  let currentIDs = await readSplitIDs(currentSplitPath)
  const maxInputs = positiveInteger(input.maxInputs, "hierarchical max inputs")
  if (maxInputs && currentIDs.length > maxInputs) {
    currentIDs = currentIDs.slice(0, maxInputs)
    const firstSplitPath = path.join(inputDir, "level-01-split.json")
    await writeJsonFile(firstSplitPath, { ids: currentIDs })
    currentSplitPath = firstSplitPath
  }
  let level = 1
  const levels: any[] = []
  let finalSkillPath: string | undefined
  let finalGroup: GeneratedGroup | undefined
  let hierarchyFailure:
    | {
        level: number
        failedGroupCount: number
        notStartedGroupCount: number
        acceptanceExhausted: boolean
        summary: string
      }
    | undefined

  while (currentIDs.length > 1) {
    if (level > maxLevels) throw new Error(`Live hierarchical merge exceeded maxLevels=${maxLevels}`)
    const override = levelOverrideFor(levelOverrides, level)
    if (levelPlanningMode === "configured_levels" && !override) {
      if (finalizationMode === "merge_remaining_to_one") {
        // fall through with one forced final group that consumes all remaining skills
      } else {
        throw new Error(`Configured live hierarchy ended before one skill remained at level ${level}`)
      }
    }
    const groupSize = positiveInteger(override?.groupSize, `level ${level} group size`, override ? defaultGroupSize : defaultGroupSize)!
    const forcedFinal = levelPlanningMode === "configured_levels" && !override && finalizationMode === "merge_remaining_to_one"
    const actualGroupSize = forcedFinal ? currentIDs.length : groupSize
    if (currentIDs.length > 1 && actualGroupSize < 2) throw new Error(`Level ${level} groupSize must be >= 2`)
    const groupCount = Math.ceil(currentIDs.length / actualGroupSize)
    const isFinalLevel = groupCount <= 1
    const outTaskPack = path.join(outRoot, `level-${padLevel(level)}`, "task-pack")
    const result = await createMergeLongTaskPack({
      cwd,
      taskPackRoot,
      splitPath: currentSplitPath,
      campaignManifestPath: currentManifestPath,
      outTaskPack,
      label: `${input.label ?? path.basename(outRoot)}-level-${padLevel(level)}`,
      taskProfile,
      accessSystem,
      groupSize: actualGroupSize,
      replayConcurrency: positiveInteger(override?.blankReplayConcurrency, `level ${level} replay concurrency`, defaultReplayConcurrency)!,
      surfaceProfileSet: override?.surfaceProfileSet ?? hierarchical.surfaceProfileSet,
      surfaceValidatorProfiles: override?.surfaceValidatorProfiles ?? hierarchical.surfaceValidatorProfiles,
      blankAcceptanceScenario:
        override?.blankAcceptanceScenario ??
        (isFinalLevel ? hierarchical.finalBlankAcceptanceScenario : hierarchical.intermediateBlankAcceptanceScenario),
      // Product replay is owned by this MSL supervisor. Keeping it out of the
      // Campaign prevents source Skill permissions from entering Blank Eval.
      mountBlankReplay: false,
      inputSelection: level === 1 ? hierarchical.inputSelection : "success_only",
      dryRun: input.dryRun,
    })
    const groupConcurrency = positiveInteger(override?.groupConcurrency, `level ${level} group concurrency`, defaultGroupConcurrency)!
    const groupResults = input.dryRun
      ? result.groups.map((group) => ({ groupID: group.groupID, ok: true, skipped: true }))
      : await runWithConcurrency(result.groups, groupConcurrency, async (group) => {
          const taskDir = path.dirname(path.resolve(group.specPath))
          const campaignPath = path.join(taskDir, "campaign.json")
          const runResult = await runOneGroupWithSupervisor({
            cwd,
            level,
            group,
            campaignPath,
            logDir: path.join(outRoot, "logs", `level-${padLevel(level)}`, group.groupID),
            runner,
            pollMs: watchPollMs,
            maxPolls: watchMaxPolls,
          })
          if (!runResult.ok || !runPerGroupReplay || !runResult.outputSkillPath) {
            return { groupID: group.groupID, ...runResult }
          }
          const acceptanceRoot = path.join(outRoot, "acceptance", `level-${padLevel(level)}`, group.groupID)
          if (input.perGroupAcceptance) {
            const caseIDs = await readGroupReplayCaseIDs(group)
            const acceptance = await runExternalFinalAcceptance({
              cwd,
              taskPackRoot,
              outRoot,
              rootDir: acceptanceRoot,
              reportSchema: "merge-long-task-group-closed-loop-acceptance/v1",
              label: `${input.label ?? path.basename(outRoot)}-${group.groupID}`,
              level,
              finalGroup: group,
              initialSkillRoot: runResult.outputSkillPath,
              taskProfile,
              accessSystem,
              replayConcurrency: positiveInteger(
                override?.blankReplayConcurrency,
                `level ${level} replay concurrency`,
                defaultReplayConcurrency,
              )!,
              watchPollMs,
              watchMaxPolls,
              maxReplayRepairAttempts,
              surfaceProfileSet: override?.surfaceProfileSet ?? hierarchical.surfaceProfileSet,
              surfaceValidatorProfiles: override?.surfaceValidatorProfiles ?? hierarchical.surfaceValidatorProfiles,
              blankAcceptanceScenario:
                override?.blankAcceptanceScenario ??
                (isFinalLevel ? hierarchical.finalBlankAcceptanceScenario : hierarchical.intermediateBlankAcceptanceScenario),
              config: input.perGroupAcceptance,
              groupRunner: runner,
              caseIDs,
            })
            return {
              groupID: group.groupID,
              ...runResult,
              ok: acceptance.accepted,
              status: acceptance.accepted ? "verified_success" : acceptance.acceptanceStatus,
              outputSkillPath: acceptance.finalSkillPath,
              summary: acceptance.accepted
                ? `${runResult.summary ?? group.groupID}; per-group closed-loop acceptance passed ${acceptance.passed}/${acceptance.total}`
                : `${runResult.summary ?? group.groupID}; per-group closed-loop acceptance failed ${acceptance.passed}/${acceptance.total}`,
              replay: {
                passed: acceptance.accepted,
                reportPath: acceptance.reportPath,
                repairTargetsPath: "",
                failedCaseIDs: acceptance.failedCaseIDs,
                missingResults: [],
                repairAttempts: acceptance.repairs,
                acceptanceStatus: acceptance.acceptanceStatus,
                initialReplay: acceptance.initialReplay,
                finalReplay: acceptance.finalReplay,
              },
            }
          }
          let candidateSkillRoot = runResult.outputSkillPath
          let replay = await replayRunner({
            cwd,
            mergeSpecPath: group.specPath,
            candidateSkillRoot,
            outDir: acceptanceRoot,
            concurrency: positiveInteger(
              override?.blankReplayConcurrency,
              `level ${level} replay concurrency`,
              defaultReplayConcurrency,
            )!,
            runtimeScope: `merge-as-long-task:${input.label ?? path.basename(outRoot)}:level-${level}:${group.groupID}`,
          })
          const repairAttempts: Array<Record<string, unknown>> = []
          for (
            let repairAttempt = 1;
            !replay.passed &&
            replay.missingResults.length === 0 &&
            replay.failedCaseIDs.length > 0 &&
            repairAttempt <= maxReplayRepairAttempts;
            repairAttempt += 1
          ) {
            const repairPack = await createRepairGroup({
              cwd,
              taskPackRoot,
              originalGroup: group,
              candidateSkillRoot,
              repairTargetsPath: replay.repairTargetsPath,
              outRoot,
              level,
              attempt: repairAttempt,
              label: `${input.label ?? path.basename(outRoot)}-${group.groupID}`,
              taskProfile,
              accessSystem,
              replayConcurrency: positiveInteger(
                override?.blankReplayConcurrency,
                `level ${level} replay concurrency`,
                defaultReplayConcurrency,
              )!,
              surfaceProfileSet: override?.surfaceProfileSet ?? hierarchical.surfaceProfileSet,
              surfaceValidatorProfiles: override?.surfaceValidatorProfiles ?? hierarchical.surfaceValidatorProfiles,
              blankAcceptanceScenario:
                override?.blankAcceptanceScenario ??
                (isFinalLevel ? hierarchical.finalBlankAcceptanceScenario : hierarchical.intermediateBlankAcceptanceScenario),
            })
            const repairTaskDir = path.dirname(path.resolve(repairPack.group.specPath))
            const repairRun = await runOneGroupWithSupervisor({
              cwd,
              level,
              group: repairPack.group,
              campaignPath: path.join(repairTaskDir, "campaign.json"),
              logDir: path.join(
                outRoot,
                "logs",
                `level-${padLevel(level)}`,
                group.groupID,
                `repair-${String(repairAttempt).padStart(2, "0")}`,
              ),
              runner,
              pollMs: watchPollMs,
              maxPolls: watchMaxPolls,
            })
            repairAttempts.push({
              attempt: repairAttempt,
              campaignID: repairRun.campaignID,
              campaignDir: repairRun.campaignDir,
              status: repairRun.status,
              ok: repairRun.ok,
              outputSkillPath: repairRun.outputSkillPath,
              repairTargetsPath: replay.repairTargetsPath,
            })
            if (!repairRun.ok || !repairRun.outputSkillPath) break
            candidateSkillRoot = repairRun.outputSkillPath
            replay = await replayRunner({
              cwd,
              mergeSpecPath: repairPack.group.specPath,
              candidateSkillRoot,
              outDir: path.join(
                outRoot,
                "acceptance",
                `level-${padLevel(level)}`,
                group.groupID,
                `repair-${String(repairAttempt).padStart(2, "0")}`,
              ),
              concurrency: positiveInteger(
                override?.blankReplayConcurrency,
                `level ${level} replay concurrency`,
                defaultReplayConcurrency,
              )!,
              runtimeScope: `merge-as-long-task:${input.label ?? path.basename(outRoot)}:level-${level}:${group.groupID}:repair-${repairAttempt}`,
            })
          }
          return {
            groupID: group.groupID,
            ...runResult,
            ok: replay.passed,
            status: replay.passed ? runResult.status : "replay_failed",
            outputSkillPath: candidateSkillRoot,
            summary: replay.passed
              ? `${runResult.summary ?? group.groupID}; MSL supervisor replay passed`
              : `${runResult.summary ?? group.groupID}; MSL supervisor replay failed: ${replay.failedCaseIDs.join(", ") || "missing results"}`,
            replay: {
              passed: replay.passed,
              reportPath: normalizeSlash(replay.reportPath),
              repairTargetsPath: normalizeSlash(replay.repairTargetsPath),
              failedCaseIDs: replay.failedCaseIDs,
              missingResults: replay.missingResults,
              repairAttempts,
            },
          }
        }, (groupResult) => !groupResult.ok)
    const successfulGroups = result.groups
      .filter((group) => groupResults.some((item: any) => item?.groupID === group.groupID && item.ok))
      .map((group) => {
        const hit = groupResults.find((item: any) => item?.groupID === group.groupID) as any
        return { ...group, outputSkillPath: hit?.outputSkillPath }
      })
    const failedGroups = result.groups.filter((group) =>
      groupResults.some((item: any) => item?.groupID === group.groupID && !item.ok),
    )
    const notStartedGroups = result.groups.filter(
      (group) => !groupResults.some((item: any) => item?.groupID === group.groupID),
    )
    const groupStateRows = result.groups.map((group) => {
      const hit = groupResults.find((item: any) => item?.groupID === group.groupID)
      return groupStateRow(group, hit)
    })
    levels.push({
      level,
      inputCount: currentIDs.length,
      groupSize: actualGroupSize,
      groupConcurrency,
      groupCount: result.groups.length,
      successCount: successfulGroups.length,
      failedCount: failedGroups.length,
      notStartedCount: notStartedGroups.length,
      outTaskPack: normalizeSlash(outTaskPack),
      groups: groupStateRows,
    })
    await writeJsonFile(statePath, {
      schema: "hierarchical-merge-long-task-live-state/v1",
      label: input.label ?? path.basename(outRoot),
      taskProfile,
      accessSystem,
      updatedAt: new Date().toISOString(),
      currentLevel: level,
      levels,
    })
    if (failedGroups.length || notStartedGroups.length) {
      const acceptanceExhausted = failedGroups.some((group) => {
        const hit = groupResults.find((item: any) => item?.groupID === group.groupID)
        return hit?.status === "acceptance_exhausted"
      })
      hierarchyFailure = {
        level,
        failedGroupCount: failedGroups.length,
        notStartedGroupCount: notStartedGroups.length,
        acceptanceExhausted,
        summary: `Level ${level} has ${failedGroups.length} failed group(s) and ${notStartedGroups.length} not-started group(s); live hierarchy stopped fail-closed.`,
      }
      break
    }
    if (successfulGroups.length <= 1) {
      const finalCandidateGroup = successfulGroups[0]
      if (finalCandidateGroup) {
        finalGroup = { ...finalCandidateGroup }
        finalSkillPath =
          finalCandidateGroup.outputSkillPath ??
          path.join(path.dirname(path.resolve(finalCandidateGroup.specPath)), "workspace", "merged-skill")
      }
      break
    }
    const rows = await buildNextLevelRowsFromSuccessfulGroups(level, successfulGroups)
    const nextInput = await writeLevelInputs(inputDir, level + 1, rows)
    currentManifestPath = nextInput.manifestPath
    currentSplitPath = nextInput.splitPath
    currentIDs = rows.map((row) => row.id)
    level += 1
  }

  let externalFinalAcceptance
  if (input.externalFinalAcceptance && !hierarchyFailure) {
    if (!finalGroup || !finalSkillPath) {
      throw new Error("External final acceptance cannot run without a final MSL group and Skill")
    }
    externalFinalAcceptance = await runExternalFinalAcceptance({
      cwd,
      taskPackRoot,
      outRoot,
      label: input.label ?? path.basename(outRoot),
      level,
      finalGroup,
      initialSkillRoot: finalSkillPath,
      taskProfile,
      accessSystem,
      replayConcurrency: defaultReplayConcurrency,
      watchPollMs,
      watchMaxPolls,
      maxReplayRepairAttempts,
      surfaceProfileSet: hierarchical.surfaceProfileSet,
      surfaceValidatorProfiles: hierarchical.surfaceValidatorProfiles,
      blankAcceptanceScenario: hierarchical.finalBlankAcceptanceScenario,
      config: input.externalFinalAcceptance,
      groupRunner: runner,
      caseIDs: input.externalFinalAcceptance.caseIDs,
    })
    finalSkillPath = externalFinalAcceptance.finalSkillPath
  }

  const report = {
    schema: "hierarchical-merge-long-task-live-report/v1",
    label: input.label ?? path.basename(outRoot),
    taskPackRoot: normalizeSlash(taskPackRoot),
    sourceSplitPath: normalizeSlash(path.resolve(input.splitPath)),
    sourceCampaignManifestPath: normalizeSlash(path.resolve(input.campaignManifestPath)),
    taskProfile,
    accessSystem,
    levelPlanningMode,
    finalizationMode,
    acceptanceOwner: input.perGroupAcceptance
      ? "merge-as-long-task-per-group-external"
      : runPerGroupReplay
        ? "merge-as-long-task-supervisor"
        : "outer-final-only",
    watchPollMs,
    watchMaxPolls,
    maxReplayRepairAttempts,
    levels,
    hierarchyFailure,
    externalFinalAcceptance,
    finalSkillPath: finalSkillPath ? normalizeSlash(finalSkillPath) : undefined,
    hierarchyBuilt: Boolean(finalSkillPath),
    acceptanceCompleted: hierarchyFailure
      ? true
      : input.externalFinalAcceptance
        ? Boolean(externalFinalAcceptance)
        : runPerGroupReplay
          ? levels.every((item) => item.failedCount === 0)
          : false,
    accepted: input.externalFinalAcceptance
      ? externalFinalAcceptance?.accepted === true
      : runPerGroupReplay
        ? Boolean(finalSkillPath) && levels.every((item) => item.failedCount === 0)
        : false,
    status:
      hierarchyFailure
        ? hierarchyFailure.acceptanceExhausted
          ? "acceptance_exhausted"
          : "hierarchy_failed"
        : externalFinalAcceptance && !externalFinalAcceptance.accepted
        ? externalFinalAcceptance.acceptanceStatus === "acceptance_exhausted"
          ? "acceptance_exhausted"
          : "acceptance_failed"
        : finalSkillPath
          ? "complete"
          : "no_final_skill",
  }
  await writeJsonFile(path.join(outRoot, "hierarchical-live-report.json"), report)
  return report
}

async function main() {
  const cwd = path.resolve(import.meta.dir, "..", "..")
  const taskPackRoot = readArg("--task-pack-root")
  const splitPath = readArg("--split")
  const campaignManifestPath = readArg("--campaign-manifest")
  const outRoot = readArg("--out-root")
  if (!taskPackRoot || !splitPath || !campaignManifestPath || !outRoot) {
    throw new Error("--task-pack-root, --split, --campaign-manifest and --out-root are required")
  }
  const levelsPath = readArg("--levels-path")
  const levels = levelsPath ? await readJsonFile<HierarchicalMergeLevelOverride[]>(path.resolve(levelsPath)) : undefined
  const result = await runHierarchicalMergeLongTask({
    cwd,
    taskPackRoot,
    splitPath,
    campaignManifestPath,
    outRoot,
    label: readArg("--label"),
    maxInputs: readArg("--max-inputs") ? Number(readArg("--max-inputs")) : undefined,
    maxLevels: readArg("--max-levels") ? Number(readArg("--max-levels")) : undefined,
    groupSize: readArg("--group-size") ? Number(readArg("--group-size")) : undefined,
    groupConcurrency: readArg("--group-concurrency") ? Number(readArg("--group-concurrency")) : undefined,
    replayConcurrency: readArg("--replay-concurrency") ? Number(readArg("--replay-concurrency")) : undefined,
    watchPollMs: readArg("--watch-poll-ms") ? Number(readArg("--watch-poll-ms")) : undefined,
    watchMaxPolls: readArg("--watch-max-polls") ? Number(readArg("--watch-max-polls")) : undefined,
    maxReplayRepairAttempts: readArg("--max-replay-repair-attempts")
      ? Number(readArg("--max-replay-repair-attempts"))
      : undefined,
    levelPlanningMode: readArg("--level-planning-mode") as RunHierarchicalMergeLongTaskInput["levelPlanningMode"],
    finalizationMode: readArg("--finalization-mode") as RunHierarchicalMergeLongTaskInput["finalizationMode"],
    levels,
    dryRun: process.argv.includes("--dry-run"),
  })
  console.log(JSON.stringify(result, null, 2))
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}
