import path from "node:path"
import { copyFile, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { campaignRoundRuntimeScope, cleanupRuntimeProcessScope, terminateProcessTree } from "./runtime-process-registry"
import { ensureDirectory, pathExists, readJsonFile, runtimePath, writeJsonFile } from "./fs"
import { identifyProcessOwner, optionalProcessOwnerHints, strongProcessOwnerHints } from "./process-identity"

const execFileAsync = promisify(execFile)

export type StopMode = "pause" | "drain" | "kill-only" | "abort" | "snapshot-only"
export type StopTargetKind = "benchmark-long-task" | "single-campaign" | "direct-chat-eval" | "generic-process"

export type StopManagerInput = {
  cwd: string
  outDir?: string
  campaignID?: string
  mode?: StopMode
  reason?: string
  dryRun?: boolean
  force?: boolean
}

type StopWarning = {
  code: string
  message: string
  path?: string
}

type ProcessAction = {
  pid: number
  kind: string
  ownership: string
  action: "killed" | "skipped" | "dry-run"
  reason: string
}

type CampaignTarget = {
  campaignID: string
  campaignDir: string
  statePath: string
  before?: Record<string, any>
}

type StopTarget = {
  kind: StopTargetKind
  rootDir: string
  runID: string
  outDir?: string
  campaign?: CampaignTarget
  campaigns: CampaignTarget[]
  warnings: StopWarning[]
}

export type StopManagerResult = {
  schema: "auto-evolve/stop-report/v1"
  mode: StopMode
  dryRun: boolean
  stoppedAt: string
  target: {
    kind: StopTargetKind
    rootDir: string
    runID: string
  }
  summary: {
    verified: number
    queued: number
    markedRecoveryPending: number
    terminal: number
    killedProcesses: number
    skippedProcesses: number
    warnings: number
  }
  resume: {
    command?: string
    mustUseSameOut: boolean
    notes: string[]
  }
  affectedTasks: Array<Record<string, unknown>>
  processes: ProcessAction[]
  warnings: StopWarning[]
  snapshotDir?: string
  transactionDir?: string
  reportPath?: string
  markdownPath?: string
  resumable: boolean
}

type BenchmarkState = {
  runID?: string
  phase?: string
  trainResults?: Array<{ id: string; status: string; campaignDir?: string; updatedAt?: string }>
  config?: Record<string, any>
  stop?: Record<string, any>
  [key: string]: unknown
}

type BenchmarkLedger = {
  tasks?: Record<
    string,
    {
      status?: string
      allowResume?: boolean
      activeCampaignID?: string
      activeCampaignDir?: string
      updatedAt?: string
      attempts?: Array<{ campaignID?: string; campaignDir?: string; status?: string; updatedAt?: string; reason?: string }>
    }
  >
  [key: string]: unknown
}

type Manifest = {
  schema: "auto-evolve/run-manifest/v1"
  runID: string
  runKind: StopTargetKind
  createdAt: string
  updatedAt: string
  rootDir: string
  taskPackRoot?: string
  splitPath?: string
  primaryStateFiles: string[]
  artifactRoots: string[]
  processScopes: string[]
  resume: {
    command?: string
    mustUseSameOut: boolean
  }
  stop: {
    adapter: StopTargetKind
    safeModes: StopMode[]
  }
}

const TERMINAL_CAMPAIGN_STATUSES = new Set(["verified_success", "round_limit_reached", "failed"])
const TERMINAL_TRAIN_STATUSES = new Set(["verified_success", "terminal", "failed", "round_limit_reached", "excluded_for_now"])
const LIVE_TRAIN_STATUSES = new Set(["running", "recovery_pending", "watch_live", "bootstrapping"])

function nowISO() {
  return new Date().toISOString()
}

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function normalizeSearch(input: string | undefined) {
  return normalizeSlash(input || "").toLowerCase()
}

function relativeOrAbsolute(root: string, target: string) {
  const rel = path.relative(root, target)
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : target
}

function safeFileName(input: string) {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run"
}

function isLiveTrainStatus(status: string | undefined) {
  return !!status && LIVE_TRAIN_STATUSES.has(status)
}

function isTerminalTrainStatus(status: string | undefined) {
  return !!status && TERMINAL_TRAIN_STATUSES.has(status)
}

async function tryReadJson<T = any>(file: string): Promise<T | undefined> {
  if (!(await pathExists(file))) return undefined
  try {
    return await readJsonFile<T>(file, { validatePaths: false })
  } catch {
    return undefined
  }
}

async function copyIfExists(source: string, target: string) {
  if (!(await pathExists(source))) return false
  await ensureDirectory(path.dirname(target))
  await copyFile(source, target)
  return true
}

async function snapshotFile(source: string, snapshotRoot: string, baseRoot: string) {
  const target = path.join(snapshotRoot, relativeOrAbsolute(baseRoot, source))
  return copyIfExists(source, target)
}

async function listFilesShallow(root: string, depth = 2): Promise<string[]> {
  if (!(await pathExists(root))) return []
  const result: string[] = []
  async function walk(current: string, remaining: number) {
    let entries: Awaited<ReturnType<typeof readdir>>
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      result.push(full)
      if (entry.isDirectory() && remaining > 0) await walk(full, remaining - 1)
    }
  }
  await walk(root, depth)
  return result
}

async function fileDigestOrInfo(file: string, root: string) {
  const info = await stat(file).catch(() => undefined)
  if (!info || info.isDirectory()) return undefined
  const record: Record<string, unknown> = {
    path: normalizeSlash(relativeOrAbsolute(root, file)),
    bytes: info.size,
    mtime: new Date(info.mtimeMs).toISOString(),
  }
  if (info.size <= 2 * 1024 * 1024) {
    const raw = await readFile(file)
    record.sha256 = createHash("sha256").update(raw).digest("hex")
  }
  return record
}

async function buildArtifactManifest(root: string, target: StopTarget) {
  const candidates = new Set<string>()
  const add = (item: string) => candidates.add(path.resolve(root, item))
  if (target.kind === "benchmark-long-task") {
    for (const item of [
      "orchestrator-state.json",
      "task-ledger.json",
      "train-plan.json",
      "train-queue-results.json",
      "verified-training.json",
      "merge-output.json",
      "train-replay-output.json",
      "trained-test-output.json",
      "direct-chat-test-output.json",
      "baseline-results.json",
      "final-report.json",
      "scorecard.md",
    ]) {
      add(item)
    }
  } else if (target.kind === "direct-chat-eval") {
    for (const item of [
      "config.snapshot.json",
      "summary.json",
      "summary.md",
      "results.csv",
      "transient-recovery.json",
      "master-report-update-error.log",
      "master-report-update-pending.log",
    ]) {
      add(item)
    }
    for (const file of await listFilesShallow(path.join(root, "results"), 3)) candidates.add(file)
  } else if (target.campaign) {
    for (const item of [
      "campaign.json",
      "campaign-working-memory.json",
      "exploration-tree.json",
      "routing-control.json",
      "pending-expert-package/current",
    ]) {
      candidates.add(path.join(target.campaign.campaignDir, item))
    }
  }

  const files: Array<Record<string, unknown>> = []
  for (const file of candidates) {
    const digest = await fileDigestOrInfo(file, root)
    if (digest) files.push(digest)
  }
  return {
    schema: "auto-evolve/artifact-manifest/v1",
    rootDir: normalizeSlash(root),
    generatedAt: nowISO(),
    files,
  }
}

async function inferTarget(input: StopManagerInput): Promise<StopTarget> {
  const repoRoot = path.resolve(input.cwd)
  const warnings: StopWarning[] = []
  if (input.outDir) {
    const outDir = path.resolve(input.outDir)
    const manifest = await tryReadJson<Manifest>(path.join(outDir, "run-manifest.json"))
    const hasBenchmarkState = await pathExists(path.join(outDir, "orchestrator-state.json"))
    const hasDirectChatConfig = await pathExists(path.join(outDir, "config.snapshot.json"))
    const kind = manifest?.runKind || (hasBenchmarkState ? "benchmark-long-task" : hasDirectChatConfig ? "direct-chat-eval" : "generic-process")
    const target: StopTarget = {
      kind,
      rootDir: outDir,
      runID: manifest?.runID || path.basename(outDir),
      outDir,
      campaigns: [],
      warnings,
    }
    if (kind === "benchmark-long-task") {
      target.campaigns = await collectBenchmarkCampaigns(outDir)
    }
    return target
  }
  if (input.campaignID) {
    const campaignRoot = path.join(repoRoot, "auto-evolve", "runtime-state", "long-task-campaigns")
    const campaignDir = path.isAbsolute(input.campaignID) ? input.campaignID : path.join(campaignRoot, input.campaignID)
    const campaignID = path.basename(campaignDir)
    const statePath = path.join(campaignDir, "campaign.json")
    const campaign = { campaignID, campaignDir, statePath, before: await tryReadJson<Record<string, any>>(statePath) }
    return {
      kind: "single-campaign",
      rootDir: campaignDir,
      runID: campaignID,
      campaign,
      campaigns: [campaign],
      warnings,
    }
  }
  throw new Error("Stop Manager requires --out or --campaign for the first implementation.")
}

async function collectBenchmarkCampaigns(outDir: string): Promise<CampaignTarget[]> {
  const state = await tryReadJson<BenchmarkState>(path.join(outDir, "orchestrator-state.json"))
  const ledger = await tryReadJson<BenchmarkLedger>(path.join(outDir, "task-ledger.json"))
  const dirs = new Set<string>()
  for (const row of state?.trainResults || []) {
    if (row.campaignDir) dirs.add(path.resolve(row.campaignDir))
  }
  for (const task of Object.values(ledger?.tasks || {})) {
    if (task.activeCampaignDir) dirs.add(path.resolve(task.activeCampaignDir))
    for (const attempt of task.attempts || []) {
      if (attempt.campaignDir) dirs.add(path.resolve(attempt.campaignDir))
    }
  }
  const campaigns: CampaignTarget[] = []
  for (const campaignDir of dirs) {
    const statePath = path.join(campaignDir, "campaign.json")
    campaigns.push({
      campaignID: path.basename(campaignDir),
      campaignDir,
      statePath,
      before: await tryReadJson<Record<string, any>>(statePath),
    })
  }
  return campaigns
}

async function writeRunManifestIfMissing(target: StopTarget, input: StopManagerInput) {
  if (!target.outDir) return
  const manifestPath = path.join(target.outDir, "run-manifest.json")
  if (await pathExists(manifestPath)) return
  const state = await tryReadJson<BenchmarkState>(path.join(target.outDir, "orchestrator-state.json"))
  const directConfig = await tryReadJson<Record<string, any>>(path.join(target.outDir, "config.snapshot.json"))
  const manifest: Manifest = {
    schema: "auto-evolve/run-manifest/v1",
    runID: target.runID,
    runKind: target.kind,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    rootDir: normalizeSlash(target.outDir),
    taskPackRoot:
      typeof state?.config?.taskPackRoot === "string"
        ? normalizeSlash(path.resolve(String(state.config.taskPackRoot)))
        : undefined,
    splitPath:
      typeof state?.config?.trainSplit === "string"
        ? normalizeSlash(path.resolve(String(state.config.trainSplit)))
        : typeof directConfig?.datasetBundlePath === "string"
          ? normalizeSlash(path.resolve(String(directConfig.datasetBundlePath)))
          : undefined,
    primaryStateFiles:
      target.kind === "direct-chat-eval"
        ? ["config.snapshot.json", "summary.json"]
        : ["orchestrator-state.json", "task-ledger.json", "train-plan.json"],
    artifactRoots:
      target.kind === "direct-chat-eval"
        ? ["results", "summary.json", "results.csv"]
        : ["verified-training.json", "merge-and-validate", "stop-reports", "cost-reports"],
    processScopes: target.campaigns.flatMap((campaign) => {
      const round = typeof campaign.before?.currentRound === "number" ? campaign.before.currentRound : 1
      return [campaignRoundRuntimeScope(campaign.campaignID, round)]
    }),
    resume: {
      command:
        target.kind === "direct-chat-eval"
          ? `rerun run-direct-chat-eval with --out-dir "${normalizeSlash(target.outDir)}" --resume-existing`
          : `rerun run-benchmark-orchestrator with --out "${normalizeSlash(target.outDir)}"`,
      mustUseSameOut: true,
    },
    stop: {
      adapter: target.kind,
      safeModes: ["pause", "drain", "kill-only", "snapshot-only"],
    },
  }
  if (!input.dryRun) await writeJsonFile(manifestPath, manifest)
}

async function writeStopRequest(target: StopTarget, input: StopManagerInput) {
  if (!target.outDir || input.dryRun || input.mode === "snapshot-only") return
  await writeJsonFile(path.join(target.outDir, "STOP_REQUESTED.json"), {
    schema: "auto-evolve/stop-request/v1",
    requestedAt: nowISO(),
    mode: input.mode,
    reason: input.reason || "User requested stop through Stop Manager.",
    runID: target.runID,
  })
}

async function snapshotTarget(target: StopTarget, input: StopManagerInput) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const snapshotDir = path.join(target.rootDir, "stop-snapshots", `${stamp}-${safeFileName(input.mode || "pause")}`)
  if (input.dryRun) return snapshotDir
  await ensureDirectory(snapshotDir)
  await writeJsonFile(path.join(snapshotDir, "stop-input.json"), {
    ...input,
    cwd: path.resolve(input.cwd),
    outDir: input.outDir ? path.resolve(input.outDir) : undefined,
  })
  if (target.kind === "benchmark-long-task") {
    for (const file of [
      "run-manifest.json",
      "orchestrator-state.json",
      "task-ledger.json",
      "train-plan.json",
      "train-queue-results.json",
      "train-queue-summary.json",
      "scorecard.md",
    ]) {
      await snapshotFile(path.join(target.rootDir, file), snapshotDir, target.rootDir)
    }
    await snapshotDirectoryFiles(path.join(target.rootDir, "benchmark-leases"), path.join(snapshotDir, "benchmark-leases.before"))
  } else if (target.kind === "direct-chat-eval") {
    for (const file of ["run-manifest.json", "config.snapshot.json", "summary.json", "results.csv", "transient-recovery.json"]) {
      await snapshotFile(path.join(target.rootDir, file), snapshotDir, target.rootDir)
    }
  }
  for (const campaign of target.campaigns) {
    await copyIfExists(campaign.statePath, path.join(snapshotDir, "campaign-states.before", `${campaign.campaignID}.json`))
  }
  const activeProcesses = runtimePath(path.resolve(input.cwd), "active-processes.json")
  await copyIfExists(activeProcesses, path.join(snapshotDir, "active-processes.before.json"))
  const gateState = runtimePath(path.resolve(input.cwd), "opencode-gate", "state.json")
  await copyIfExists(gateState, path.join(snapshotDir, "opencode-gate-state.before.json"))
  return snapshotDir
}

async function snapshotDirectoryFiles(sourceDir: string, targetDir: string) {
  if (!(await pathExists(sourceDir))) return
  await ensureDirectory(targetDir)
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile()) continue
    await copyIfExists(path.join(sourceDir, entry.name), path.join(targetDir, entry.name))
  }
}

async function pauseBenchmarkState(target: StopTarget, input: StopManagerInput, affectedTasks: Array<Record<string, unknown>>) {
  if (!target.outDir || input.dryRun || input.mode === "kill-only" || input.mode === "snapshot-only") return
  const statePath = path.join(target.outDir, "orchestrator-state.json")
  const state = await tryReadJson<BenchmarkState>(statePath)
  if (!state) return
  const now = nowISO()
  for (const row of state.trainResults || []) {
    const before = row.status
    if (isLiveTrainStatus(row.status)) {
      row.status = "recovery_pending"
      row.updatedAt = now
      affectedTasks.push({
        id: row.id,
        beforeStatus: before,
        afterStatus: row.status,
        campaignDir: row.campaignDir,
        nextAction: "resume-long-task-campaign",
      })
    }
  }
  state.stop = {
    status: input.mode === "abort" ? "aborted_by_user" : "paused_by_user",
    stoppedAt: now,
    reason: input.reason || "User requested stop through Stop Manager.",
    resumeInstruction: `Rerun benchmark with the same --out ${normalizeSlash(target.outDir)}.`,
  }
  state.updatedAt = now
  await writeJsonFile(statePath, state)
}

async function pauseBenchmarkLedger(target: StopTarget, input: StopManagerInput) {
  if (!target.outDir || input.dryRun || input.mode === "kill-only" || input.mode === "snapshot-only") return
  const ledgerPath = path.join(target.outDir, "task-ledger.json")
  const ledger = await tryReadJson<BenchmarkLedger>(ledgerPath)
  if (!ledger?.tasks) return
  const now = nowISO()
  for (const task of Object.values(ledger.tasks)) {
    if (task.status === "running" || task.status === "recovery_pending") {
      task.status = "recovery_pending"
      task.allowResume = true
      task.updatedAt = now
    }
    for (const attempt of task.attempts || []) {
      if (attempt.status === "running" || attempt.status === "recovery_pending") {
        attempt.status = "recovery_pending"
        attempt.updatedAt = now
        attempt.reason = input.reason || "Paused by user through Stop Manager."
      }
    }
  }
  ;(ledger as any).updatedAt = now
  ;(ledger as any).stop = {
    status: "paused_by_user",
    stoppedAt: now,
    reason: input.reason || "Paused by user through Stop Manager.",
  }
  await writeJsonFile(ledgerPath, ledger)
}

async function pauseCampaigns(target: StopTarget, input: StopManagerInput) {
  if (input.dryRun || input.mode === "kill-only" || input.mode === "snapshot-only") return
  const now = nowISO()
  for (const campaign of target.campaigns) {
    const state = await tryReadJson<Record<string, any>>(campaign.statePath)
    if (!state) continue
    if (TERMINAL_CAMPAIGN_STATUSES.has(String(state.status))) continue
    const roundNumber = typeof state.currentRound === "number" ? state.currentRound : 1
    state.status = "recovery_pending"
    state.updatedAt = now
    state.heartbeatAt = now
    delete state.ownerPID
    delete state.ownerCreationTick
    delete state.ownerCommandHint
    state.recovery = {
      action: "restart_round",
      roundNumber,
      reason: input.reason || "Paused by user through Stop Manager; resume from latest safe checkpoint.",
      detectedAt: now,
    }
    await writeJsonFile(campaign.statePath, state)
  }
}

async function releaseBenchmarkLeases(target: StopTarget, input: StopManagerInput) {
  if (!target.outDir || input.dryRun || input.mode === "snapshot-only") return 0
  const leaseDir = path.join(target.outDir, "benchmark-leases")
  if (!(await pathExists(leaseDir))) return 0
  const entries = await readdir(leaseDir, { withFileTypes: true }).catch(() => [])
  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    await rm(path.join(leaseDir, entry.name), { force: true }).catch(() => undefined)
    removed += 1
  }
  return removed
}

function slotText(slot: Record<string, any>) {
  return normalizeSearch([slot.scope, slot.caller, slot.ownerCommandHint, slot.id].filter(Boolean).join(" "))
}

function gateSlotBelongsToTarget(slot: Record<string, any>, target: StopTarget) {
  const text = slotText(slot)
  const hints = new Set<string>([target.runID, path.basename(target.rootDir), normalizeSlash(target.rootDir)])
  for (const campaign of target.campaigns) {
    hints.add(campaign.campaignID)
    hints.add(path.basename(campaign.campaignDir))
  }
  for (const hint of hints) {
    const normalized = normalizeSearch(hint)
    if (normalized && text.includes(normalized)) return true
  }
  return false
}

async function releaseGateSlots(target: StopTarget, input: StopManagerInput) {
  if (input.dryRun || input.mode === "snapshot-only") return { active: 0, queue: 0 }
  const gateStatePath = runtimePath(path.resolve(input.cwd), "opencode-gate", "state.json")
  const state = await tryReadJson<Record<string, any>>(gateStatePath)
  if (!state) return { active: 0, queue: 0 }
  const active = Array.isArray(state.active) ? state.active : []
  const queue = Array.isArray(state.queue) ? state.queue : []
  const keptActive = active.filter((slot) => !gateSlotBelongsToTarget(slot, target))
  const keptQueue = queue.filter((slot) => !gateSlotBelongsToTarget(slot, target))
  state.active = keptActive
  state.queue = keptQueue
  state.updatedAt = nowISO()
  await writeJsonFile(gateStatePath, state)
  return { active: active.length - keptActive.length, queue: queue.length - keptQueue.length }
}

async function cleanupCampaignScopes(target: StopTarget, input: StopManagerInput, processes: ProcessAction[]) {
  if (input.dryRun || input.mode === "snapshot-only") return
  for (const campaign of target.campaigns) {
    const round = typeof campaign.before?.currentRound === "number" ? campaign.before.currentRound : 1
    const scopes = [campaignRoundRuntimeScope(campaign.campaignID, round)]
    if (round > 1) scopes.push(campaignRoundRuntimeScope(campaign.campaignID, round - 1))
    for (const scope of scopes) {
      const result = await cleanupRuntimeProcessScope(scope)
      if (result.killedCount > 0 || result.skippedCount > 0 || result.mismatchCount > 0 || result.unreadableCount > 0) {
        processes.push({
          pid: 0,
          kind: `runtime-scope:${scope}`,
          ownership: "scope-registry",
          action: result.killedCount > 0 ? "killed" : "skipped",
          reason: `tracked=${result.trackedCount}; killed=${result.killedCount}; skipped=${result.skippedCount}; mismatch=${result.mismatchCount}; unreadable=${result.unreadableCount}; remaining=${result.remainingCount}`,
        })
      }
    }
  }
}

async function killCampaignOwners(target: StopTarget, input: StopManagerInput, processes: ProcessAction[], warnings: StopWarning[]) {
  if (input.dryRun || input.mode === "snapshot-only") return
  for (const campaign of target.campaigns) {
    const before = campaign.before
    const pid = typeof before?.ownerPID === "number" ? before.ownerPID : undefined
    if (!pid || pid <= 0 || pid === process.pid) continue
    const identity = await identifyProcessOwner({
      pid,
      requiredAnyCommandHints: strongProcessOwnerHints([
        before?.ownerCommandHint,
        campaign.campaignID,
        path.basename(campaign.campaignDir),
        before?.baseSpecPath,
        before?.baseSpecPath ? path.basename(String(before.baseSpecPath)) : undefined,
      ]),
      optionalCommandHints: [
        ...optionalProcessOwnerHints([before?.ownerCommandHint]),
        "run-long-task-campaign",
        "resume-long-task-campaign",
      ],
      expectedCreationTick: typeof before?.ownerCreationTick === "string" ? before.ownerCreationTick : undefined,
      heartbeatAt: typeof before?.heartbeatAt === "string" ? before.heartbeatAt : undefined,
      updatedAt: typeof before?.updatedAt === "string" ? before.updatedAt : undefined,
    })
    if (identity.ownership !== "owned") {
      warnings.push({
        code: "owner-not-killed",
        message: `Skip campaign owner PID ${pid} for ${campaign.campaignID}: ownership=${identity.ownership}.`,
        path: campaign.campaignDir,
      })
      processes.push({ pid, kind: "campaign-owner", ownership: identity.ownership, action: "skipped", reason: "ownership not proven" })
      continue
    }
    const killed = await terminateProcessTree(pid)
    processes.push({
      pid,
      kind: "campaign-owner",
      ownership: identity.ownership,
      action: killed ? "killed" : "skipped",
      reason: killed ? "owned campaign owner stopped" : "terminateProcessTree returned false",
    })
  }
}

type WindowsProcess = { pid: number; name?: string; commandLine?: string }

async function queryWindowsProcesses(): Promise<WindowsProcess[]> {
  if (process.platform !== "win32") return []
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Depth 3",
  ].join("; ")
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    })
    const trimmed = stdout.trim()
    if (!trimmed) return []
    const raw = JSON.parse(trimmed)
    const items = Array.isArray(raw) ? raw : [raw]
    return items
      .map((item) => ({
        pid: Number(item.ProcessId),
        name: typeof item.Name === "string" ? item.Name : undefined,
        commandLine: typeof item.CommandLine === "string" ? item.CommandLine : undefined,
      }))
      .filter((item) => Number.isFinite(item.pid) && item.pid > 0)
  } catch {
    return []
  }
}

function processBelongsToOut(proc: WindowsProcess, target: StopTarget) {
  const text = normalizeSearch(proc.commandLine)
  if (!text) return false
  const out = target.outDir ? normalizeSearch(target.outDir) : ""
  const runID = normalizeSearch(target.runID)
  if (target.kind === "benchmark-long-task") {
    return text.includes("run-benchmark-orchestrator") && (!!out ? text.includes(out) : text.includes(runID))
  }
  if (target.kind === "direct-chat-eval") {
    return text.includes("run-direct-chat-eval") && (!!out ? text.includes(out) : text.includes(runID))
  }
  return false
}

async function killOuterProcesses(target: StopTarget, input: StopManagerInput, processes: ProcessAction[]) {
  if (input.dryRun || input.mode === "snapshot-only") return
  const procs = await queryWindowsProcesses()
  for (const proc of procs) {
    if (proc.pid === process.pid) continue
    if (!processBelongsToOut(proc, target)) continue
    const killed = await terminateProcessTree(proc.pid)
    processes.push({
      pid: proc.pid,
      kind: "outer-runner",
      ownership: "command-line-out-match",
      action: killed ? "killed" : "skipped",
      reason: killed ? "runner command line matched target outDir" : "terminateProcessTree returned false",
    })
  }
}

async function writeArtifactManifest(target: StopTarget, input: StopManagerInput) {
  const manifest = await buildArtifactManifest(target.rootDir, target)
  if (!input.dryRun) await writeJsonFile(path.join(target.rootDir, "artifact-manifest.stop.json"), manifest)
  return manifest
}

function buildResume(target: StopTarget) {
  if (target.kind === "direct-chat-eval") {
    return {
      command: `rerun run-direct-chat-eval with --out-dir "${normalizeSlash(target.rootDir)}" --resume-existing`,
      mustUseSameOut: true,
      notes: ["Direct Chat resumes by reusing existing result.json files and rerunning missing cases."],
    }
  }
  if (target.kind === "benchmark-long-task") {
    return {
      command: `rerun run-benchmark-orchestrator with the same --out "${normalizeSlash(target.rootDir)}"`,
      mustUseSameOut: true,
      notes: ["Verified tasks remain kept. Running/watch tasks are marked recovery_pending."],
    }
  }
  if (target.kind === "single-campaign") {
    return {
      command: `bun run auto-evolve/cli.ts resume-long-task-campaign --campaign "${target.runID}"`,
      mustUseSameOut: false,
      notes: ["Single campaign was marked recovery_pending when it was not terminal."],
    }
  }
  return { mustUseSameOut: false, notes: ["Generic process stop has no automatic resume command."] }
}

async function writeReports(target: StopTarget, input: StopManagerInput, result: StopManagerResult) {
  if (input.dryRun) return result
  const stamp = result.stoppedAt.replace(/[:.]/g, "-")
  const reportDir = path.join(target.rootDir, "stop-reports")
  await ensureDirectory(reportDir)
  const reportPath = path.join(reportDir, `${stamp}-stop-report.json`)
  const markdownPath = path.join(reportDir, `${stamp}-stop-report.md`)
  result.reportPath = reportPath
  result.markdownPath = markdownPath
  await writeJsonFile(reportPath, result)
  const lines = [
    "# Stop Report",
    "",
    `- mode: ${result.mode}`,
    `- dryRun: ${result.dryRun}`,
    `- target: ${result.target.kind}`,
    `- runID: ${result.target.runID}`,
    `- root: ${normalizeSlash(result.target.rootDir)}`,
    `- resumable: ${result.resumable}`,
    `- killed processes: ${result.summary.killedProcesses}`,
    `- skipped processes: ${result.summary.skippedProcesses}`,
    `- warnings: ${result.summary.warnings}`,
    "",
    "## Resume",
    "",
    result.resume.command ? `- command: ${result.resume.command}` : "- command: (none)",
    ...result.resume.notes.map((item) => `- ${item}`),
    "",
    "## Affected Tasks",
    "",
    ...(result.affectedTasks.length
      ? result.affectedTasks.map((item) => `- ${item.id ?? "(unknown)"}: ${item.beforeStatus ?? ""} -> ${item.afterStatus ?? ""}`)
      : ["- (none)"]),
    "",
    "## Warnings",
    "",
    ...(result.warnings.length ? result.warnings.map((item) => `- ${item.code}: ${item.message}`) : ["- (none)"]),
    "",
  ]
  await writeFile(markdownPath, `${lines.join("\n")}\n`, "utf8")
  return result
}

async function writeStopTransaction(
  transactionDir: string,
  stage: string,
  patch: Record<string, unknown> = {},
  dryRun = false,
) {
  if (dryRun) return
  await ensureDirectory(transactionDir)
  await writeJsonFile(path.join(transactionDir, "transaction.json"), {
    schema: "auto-evolve/stop-transaction/v1",
    stage,
    updatedAt: nowISO(),
    ...patch,
  })
}

async function validateResumable(target: StopTarget) {
  if (target.kind === "benchmark-long-task") {
    const state = await tryReadJson<BenchmarkState>(path.join(target.rootDir, "orchestrator-state.json"))
    if (!state?.trainResults) return false
    return state.trainResults.every((row) => {
      if (row.status === "running" || row.status === "watch_live" || row.status === "bootstrapping") return false
      return true
    })
  }
  if (target.kind === "direct-chat-eval") {
    return await pathExists(path.join(target.rootDir, "config.snapshot.json"))
  }
  if (target.kind === "single-campaign" && target.campaign) {
    const state = await tryReadJson<Record<string, any>>(target.campaign.statePath)
    if (!state) return false
    if (TERMINAL_CAMPAIGN_STATUSES.has(String(state.status))) return true
    return state.status === "recovery_pending" && typeof state.ownerPID !== "number"
  }
  return true
}

async function countStateSummary(target: StopTarget) {
  let verified = 0
  let queued = 0
  let markedRecoveryPending = 0
  let terminal = 0
  const state = target.outDir ? await tryReadJson<BenchmarkState>(path.join(target.outDir, "orchestrator-state.json")) : undefined
  for (const row of state?.trainResults || []) {
    if (row.status === "verified_success") verified += 1
    else if (row.status === "queued") queued += 1
    else if (row.status === "recovery_pending") markedRecoveryPending += 1
    else if (isTerminalTrainStatus(row.status)) terminal += 1
  }
  return { verified, queued, markedRecoveryPending, terminal }
}

export async function writeRunManifest(input: {
  rootDir: string
  runKind: StopTargetKind
  runID?: string
  taskPackRoot?: string
  splitPath?: string
  primaryStateFiles?: string[]
  artifactRoots?: string[]
  processScopes?: string[]
  resumeCommand?: string
}) {
  const target = path.resolve(input.rootDir)
  const manifestPath = path.join(target, "run-manifest.json")
  const existing = await tryReadJson<Manifest>(manifestPath)
  const manifest: Manifest = {
    schema: "auto-evolve/run-manifest/v1",
    runID: input.runID || existing?.runID || path.basename(target),
    runKind: input.runKind,
    createdAt: existing?.createdAt || nowISO(),
    updatedAt: nowISO(),
    rootDir: normalizeSlash(target),
    taskPackRoot: input.taskPackRoot ? normalizeSlash(path.resolve(input.taskPackRoot)) : existing?.taskPackRoot,
    splitPath: input.splitPath ? normalizeSlash(path.resolve(input.splitPath)) : existing?.splitPath,
    primaryStateFiles: input.primaryStateFiles || existing?.primaryStateFiles || [],
    artifactRoots: input.artifactRoots || existing?.artifactRoots || [],
    processScopes: input.processScopes || existing?.processScopes || [],
    resume: {
      command: input.resumeCommand || existing?.resume?.command,
      mustUseSameOut: true,
    },
    stop: {
      adapter: input.runKind,
      safeModes: ["pause", "drain", "kill-only", "snapshot-only"],
    },
  }
  await writeJsonFile(manifestPath, manifest)
  return manifest
}

export async function stopAutoEvolveRun(input: StopManagerInput): Promise<StopManagerResult> {
  const mode = input.mode || "pause"
  const normalizedInput = { ...input, mode, cwd: path.resolve(input.cwd) }
  const target = await inferTarget(normalizedInput)
  const transactionDir = path.join(
    target.rootDir,
    "stop-transactions",
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeFileName(mode)}`,
  )
  await writeStopTransaction(transactionDir, "created", { target: target.runID, mode }, Boolean(input.dryRun))
  await writeRunManifestIfMissing(target, normalizedInput)
  await writeStopTransaction(transactionDir, "manifest_written", { target: target.runID, mode }, Boolean(input.dryRun))
  await writeStopRequest(target, normalizedInput)
  await writeStopTransaction(transactionDir, "stop_requested", { target: target.runID, mode }, Boolean(input.dryRun))
  const snapshotDir = await snapshotTarget(target, normalizedInput)
  await writeStopTransaction(transactionDir, "snapshot_written", { snapshotDir: normalizeSlash(snapshotDir) }, Boolean(input.dryRun))
  await writeArtifactManifest(target, normalizedInput)
  await writeStopTransaction(transactionDir, "artifact_manifest_written", {}, Boolean(input.dryRun))

  const affectedTasks: Array<Record<string, unknown>> = []
  const processes: ProcessAction[] = []
  const warnings = target.warnings

  if (mode !== "snapshot-only") {
    await pauseBenchmarkState(target, normalizedInput, affectedTasks)
    await pauseBenchmarkLedger(target, normalizedInput)
    await pauseCampaigns(target, normalizedInput)
    await writeStopTransaction(transactionDir, "business_state_paused", { affectedTasks: affectedTasks.length }, Boolean(input.dryRun))
    await releaseBenchmarkLeases(target, normalizedInput)
    await releaseGateSlots(target, normalizedInput)
    await writeStopTransaction(transactionDir, "leases_released", {}, Boolean(input.dryRun))
    await cleanupCampaignScopes(target, normalizedInput, processes)
    await killCampaignOwners(target, normalizedInput, processes, warnings)
    await killOuterProcesses(target, normalizedInput, processes)
    await writeStopTransaction(transactionDir, "processes_stopped", { processes: processes.length }, Boolean(input.dryRun))
  }

  const counts = await countStateSummary(target)
  const resume = buildResume(target)
  const result: StopManagerResult = {
    schema: "auto-evolve/stop-report/v1",
    mode,
    dryRun: Boolean(input.dryRun),
    stoppedAt: nowISO(),
    target: {
      kind: target.kind,
      rootDir: normalizeSlash(target.rootDir),
      runID: target.runID,
    },
    summary: {
      ...counts,
      killedProcesses: processes.filter((item) => item.action === "killed").length,
      skippedProcesses: processes.filter((item) => item.action === "skipped").length,
      warnings: warnings.length,
    },
    resume,
    affectedTasks,
    processes,
    warnings,
    snapshotDir: normalizeSlash(snapshotDir),
    transactionDir: normalizeSlash(transactionDir),
    resumable: input.dryRun ? true : await validateResumable(target),
  }
  const finalResult = await writeReports(target, normalizedInput, result)
  await writeStopTransaction(transactionDir, "validated", { resumable: finalResult.resumable }, Boolean(input.dryRun))
  return finalResult
}
