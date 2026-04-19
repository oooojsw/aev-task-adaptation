import { createServer } from "node:http"
import { readdir, readFile, stat } from "node:fs/promises"
import * as path from "node:path"
import process from "node:process"
import { InstanceBootstrap } from "../packages/opencode/src/project/bootstrap"
import { Instance } from "../packages/opencode/src/project/instance"
import { Session } from "../packages/opencode/src/session"
import { SessionStatus } from "../packages/opencode/src/session/status"
import { MessageV2 } from "../packages/opencode/src/session/message-v2"
import { errorMessage } from "../packages/opencode/src/util/error"

type MonitorStatus = "running" | "retry" | "done" | "error" | "archived" | "idle"

type MonitorAction = {
  kind: "tool" | "text" | "reasoning" | "step_start" | "step_finish" | "error"
  label: string
  detail?: string
  timestamp: number
}

type MonitorRow = {
  id: string
  title: string
  parentID?: string
  directory: string
  updated: number
  archived: boolean
  status: MonitorStatus
  step: string
  detail?: string
  lastUser?: string
  recentActions: MonitorAction[]
  task?: ArtifactRunTask
  titleSource?: string
  whyStarted?: string
  statusReason?: string
  nextStepTitle?: string
  nextStepReason?: string
  reasonTrail?: string[]
  monitorKind?: "pipeline" | "ad_hoc"
  roundNumber?: number
}

type ArtifactRunTask = {
  kind?: string
  layer?: string
  role?: string
  title?: string
  phase?: string
  purpose?: string
  caseID?: string
  attempt?: number
  maintenanceRound?: number
  methodID?: string
}

type ArtifactRun = {
  title?: string
  task?: ArtifactRunTask
  sessionID?: string
  exitCode?: number
  status?: string
  startedAt?: string
  updatedAt?: string
  lastOutputAt?: string
  phase?: string
  methodID?: string
}

type LifecycleProgressState = {
  runID?: string
  status?: string
  activeUnitID?: string
  activeAttempt?: number
  graphRevision?: number
  noProgressCycles?: number
  validatorCalls?: number
  heartbeatAt?: string
  updatedAt?: string
  finalSummary?: string
}

type LifecycleCampaignState = {
  id?: string
  title?: string
  status?: string
  currentRound?: number
  heartbeatAt?: string
  updatedAt?: string
  lastSummary?: string
}

type JudgeSummary = {
  failureClass?: string
  shouldStartMaintainer?: boolean
  keyIssues?: string[]
  behaviorIssues?: string[]
}

type PostJudgeSummary = {
  decision?: string
  riskLevel?: string
  reasons?: string[]
  notes?: string[]
}

type CaseRunMaintenanceRoundSummary = {
  round?: number
  maintainSessionID?: string
  workspaceChanged?: boolean
  currentCaseVerificationPassed?: boolean
}

type CaseRunAttemptSummary = {
  attempt?: number
  passed?: boolean
  refineRoutingClass?: string
  solveSessionID?: string
  judgeSessionID?: string
  maintenanceRounds?: CaseRunMaintenanceRoundSummary[]
}

type CaseRunSummary = {
  caseID?: string
  attempts?: CaseRunAttemptSummary[]
}

const AUTO_EVOLVE_ROOT = import.meta.dirname
const RUNS_ROOT = path.join(AUTO_EVOLVE_ROOT, "runtime-state", "runs")
const PROPAGATION_WORKSPACES_ROOT = path.join(AUTO_EVOLVE_ROOT, "runtime-state", "propagation", "workspaces")
const LONG_TASK_RUNS_ROOT = path.join(AUTO_EVOLVE_ROOT, "runtime-state", "long-task", "runs")
const LONG_TASK_CAMPAIGNS_ROOT = path.join(AUTO_EVOLVE_ROOT, "runtime-state", "long-task-campaigns")
const ARTIFACT_SCAN_ROOTS = [
  RUNS_ROOT,
  PROPAGATION_WORKSPACES_ROOT,
  LONG_TASK_RUNS_ROOT,
  LONG_TASK_CAMPAIGNS_ROOT,
]
const ARTIFACT_CACHE_TTL_MS = 1500
const MONITOR_FRONTEND_TEMPLATE_PATH = path.join(AUTO_EVOLVE_ROOT, "frontend", "monitor", "index.html")

let artifactCache:
  | {
      expiresAt: number
      rows: MonitorRow[]
    }
  | undefined

const caseRunSummaryCache = new Map<string, CaseRunSummary | null>()

function withMonitorInstance<T>(fn: () => Promise<T>) {
  return Instance.provide({
    directory: process.cwd(),
    init: InstanceBootstrap,
    fn,
  })
}

function getOption(name: string, fallback: string) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

function latestAssistant(messages: MessageV2.WithParts[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].info.role === "assistant") return messages[index]
  }
}

function latestUser(messages: MessageV2.WithParts[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].info.role === "user") return messages[index]
  }
}

function partTimestamp(part: MessageV2.Part, fallbackTimestamp = 0, sequence = 0) {
  if ("time" in part && part.time) {
    if ("end" in part.time && typeof part.time.end === "number") return part.time.end
    if ("start" in part.time && typeof part.time.start === "number") return part.time.start
    if ("created" in part.time && typeof part.time.created === "number") return part.time.created
  }

  // Tool timing lives under state.time, not part.time.
  if (part.type === "tool" && "time" in part.state && part.state.time) {
    if ("end" in part.state.time && typeof part.state.time.end === "number") return part.state.time.end
    if ("start" in part.state.time && typeof part.state.time.start === "number") return part.state.time.start
  }

  if (typeof fallbackTimestamp === "number" && Number.isFinite(fallbackTimestamp) && fallbackTimestamp > 0) {
    return fallbackTimestamp + sequence / 1000
  }

  return sequence / 1000
}

function findActiveTool(parts: MessageV2.Part[]) {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (part.type !== "tool") continue
    if (part.state.status === "pending" || part.state.status === "running") return part
  }
}

function hasOpenStep(parts: MessageV2.Part[]) {
  const lastStart = parts
    .map((part, index) => ({ part, index }))
    .filter((item) => item.part.type === "step-start")
    .at(-1)
  const lastFinish = parts
    .map((part, index) => ({ part, index }))
    .filter((item) => item.part.type === "step-finish")
    .at(-1)
  if (!lastStart) return false
  if (!lastFinish) return true
  return lastStart.index > lastFinish.index
}

function unfinishedText(parts: MessageV2.Part[]) {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (part.type !== "text") continue
    if (!part.time?.end) return part
  }
}

function unfinishedReasoning(parts: MessageV2.Part[]) {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (part.type !== "reasoning") continue
    if (!part.time?.end) return part
  }
}

function previewText(input: string | undefined, max = 100) {
  if (!input) return undefined
  const normalized = input.replace(/\s+/g, " ").trim()
  if (!normalized) return undefined
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized
}

function padCounter(value: number, width: number) {
  return String(value).padStart(width, "0")
}

function extractTitleContextFromDirectory(directory: string) {
  const normalized = directory.replaceAll("\\", "/")
  const caseMatch = normalized.match(/\/(case-\d+)(?:\/|$)/i)
  const attemptMatch = normalized.match(/\/(attempt-\d+)(?:\/|$)/i)
  const roundMatch = normalized.match(/\/(round-\d+)(?:\/|$)/i)
  return {
    caseID: caseMatch?.[1],
    attempt: attemptMatch?.[1],
    round: roundMatch?.[1],
  }
}

function parseRoundNumber(input: string | undefined) {
  if (!input) return undefined
  const match = input.match(/round-(\d+)/i)
  if (!match?.[1]) return undefined
  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeMonitorTitle(
  baseTitle: string | undefined,
  task: ArtifactRunTask | undefined,
  directory: string,
  fallback: string,
) {
  const raw = previewText(baseTitle, 220) ?? fallback
  const title = raw.trim()
  const lower = title.toLowerCase()
  const fromDir = extractTitleContextFromDirectory(directory)
  const suffixes: string[] = []

  const caseID = task?.caseID ?? fromDir.caseID
  if (caseID && !lower.includes(caseID.toLowerCase())) {
    suffixes.push(caseID)
  }

  const attemptLabel = typeof task?.attempt === "number" ? `attempt-${padCounter(task.attempt, 2)}` : fromDir.attempt
  if (attemptLabel && !/\battempt[-_ ]?\d+\b/i.test(title)) {
    suffixes.push(attemptLabel)
  }

  const roundLabel =
    typeof task?.maintenanceRound === "number" ? `round-${padCounter(task.maintenanceRound, 3)}` : fromDir.round
  if (roundLabel && !/\bround[-_ ]?\d+\b/i.test(title)) {
    suffixes.push(roundLabel)
  }

  if (!suffixes.length) return title
  return `${title} · ${suffixes.join(" · ")}`
}

function previewValue(input: unknown, max = 120) {
  if (input === undefined || input === null) return undefined
  if (typeof input === "string") return previewText(input, max)
  try {
    return previewText(JSON.stringify(input), max)
  } catch {
    return previewText(String(input), max)
  }
}

function joinPreviewParts(parts: Array<string | undefined>) {
  return parts.filter((part): part is string => !!part && !!part.trim()).join(" | ") || undefined
}

function pushReasonLine(lines: string[], input: string | undefined) {
  const line = previewText(input, 220)
  if (!line) return
  if (lines.includes(line)) return
  lines.push(line)
}

function describeTaskPurpose(task: ArtifactRunTask | undefined) {
  if (!task) return undefined
  if (task.purpose) return task.purpose

  switch (task.kind) {
    case "solve":
      return "Solve the current case using the current experience workspace."
    case "judge":
      return "Inspect the failed run and decide whether experience maintenance should start."
    case "maintain":
      return "Update the experience workspace using the chosen reverse-propagation strategy."
    case "verify":
      return "Re-run the current case after maintenance to confirm the fix."
    case "regression":
      return "Check whether previously working cases still pass after the latest change."
    case "bootstrap":
      return "Initialize the experience workspace from the chosen starting cases."
    default:
      return undefined
  }
}

function describeTaskStart(task: ArtifactRunTask | undefined) {
  if (!task) return undefined

  switch (task.kind) {
    case "solve":
      return "This worker session is the case solve attempt."
    case "judge":
      return "This judge session was spawned after a failed solve to decide whether maintenance should run."
    case "maintain":
      return "This maintainer session was spawned to update the experience workspace after the judge approved maintenance."
    case "verify":
      return "This verification session re-checks the current case after maintenance."
    case "regression":
      return "This regression session replays prior cases to catch collateral damage."
    case "bootstrap":
      return "This bootstrap session shapes the initial experience workspace before normal learning begins."
    default:
      return task.phase ? `This session runs the ${task.phase} phase.` : undefined
  }
}

function isLikelyAutoEvolveSession(session: Session.GlobalInfo) {
  if (session.title?.toLowerCase().startsWith("auto-evolve ")) return true
  return session.directory.startsWith(AUTO_EVOLVE_ROOT)
}

function summarizeToolOutput(tool: string, output: string | undefined, max = 140) {
  const preview = previewText(output, max)
  if (!preview) return undefined
  if (/^(Done|Completed|Success|OK)\.?$/i.test(preview)) return undefined
  if (/successfully\.?$/i.test(preview) && preview.length < 80) return undefined

  if (tool === "read") return `content: ${preview}`
  if (tool === "write" || tool === "edit" || tool === "patch") return `result: ${preview}`
  if (tool === "bash" || tool === "shell") return `output: ${preview}`
  return preview
}

async function safeReadJson<T>(filePath: string) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T
  } catch {
    return undefined
  }
}

async function safeReadPreview(filePath: string, max = 120) {
  try {
    return previewText(await readFile(filePath, "utf8"), max)
  } catch {
    return undefined
  }
}

function findAttemptDir(stageDir: string) {
  let current = stageDir
  while (current.startsWith(RUNS_ROOT)) {
    if (/^attempt-\d+$/i.test(path.basename(current))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

function findRoundDir(stageDir: string) {
  let current = stageDir
  while (current.startsWith(RUNS_ROOT)) {
    if (/^round-\d+$/i.test(path.basename(current))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

async function findEnclosingCaseRunSummary(stageDir: string) {
  let current = stageDir
  while (current.startsWith(RUNS_ROOT)) {
    if (caseRunSummaryCache.has(current)) {
      return caseRunSummaryCache.get(current) ?? undefined
    }

    const candidate = await safeReadJson<CaseRunSummary>(path.join(current, "run.json"))
    if (candidate?.caseID && Array.isArray(candidate.attempts)) {
      caseRunSummaryCache.set(current, candidate)
      return candidate
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

function matchAttemptRecord(
  caseRun: CaseRunSummary | undefined,
  sessionID: string | undefined,
  task: ArtifactRunTask | undefined,
) {
  if (!caseRun?.attempts?.length) return undefined

  for (const attempt of caseRun.attempts) {
    if (sessionID) {
      if (attempt.solveSessionID === sessionID) return { attempt, stage: "solve" as const }
      if (attempt.judgeSessionID === sessionID) return { attempt, stage: "judge" as const }
      for (const round of attempt.maintenanceRounds ?? []) {
        if (round.maintainSessionID === sessionID) return { attempt, stage: "maintain" as const, round }
      }
    }

    if (task?.kind === "solve" && typeof task.attempt === "number" && attempt.attempt === task.attempt) {
      return { attempt, stage: "solve" as const }
    }

    if (task?.kind === "judge" && typeof task.attempt === "number" && attempt.attempt === task.attempt) {
      return { attempt, stage: "judge" as const }
    }

    if (task?.kind === "maintain" && typeof task.attempt === "number" && attempt.attempt === task.attempt) {
      const round = (attempt.maintenanceRounds ?? []).find((item) => item.round === task.maintenanceRound)
      if (round) return { attempt, stage: "maintain" as const, round }
    }
  }
}

async function readSiblingRunTitle(filePath: string) {
  const run = await safeReadJson<ArtifactRun>(filePath)
  return run?.task?.title ?? run?.title
}

async function buildArtifactNarrative(run: ArtifactRun, stageDir: string) {
  const task = run.task
  const attemptDir = findAttemptDir(stageDir)
  const roundDir = findRoundDir(stageDir)
  const caseRun = await findEnclosingCaseRunSummary(stageDir)
  const judgeSummary =
    (task?.kind === "judge" || task?.kind === "maintain" || task?.kind === "solve") && attemptDir
      ? await safeReadJson<JudgeSummary>(path.join(attemptDir, "judge", "judge_summary.json"))
      : undefined
  const postJudgeSummary =
    task?.kind === "maintain" && roundDir
      ? await safeReadJson<PostJudgeSummary>(path.join(roundDir, "acceptance", "post_judge_summary.json"))
      : undefined
  const matched = matchAttemptRecord(caseRun, run.sessionID, task)
  const reasonTrail: string[] = []
  let statusReason: string | undefined
  let nextStepTitle: string | undefined
  let nextStepReason: string | undefined

  if (task?.kind === "solve") {
    if (matched?.attempt.passed === false) {
      pushReasonLine(reasonTrail, "This solve attempt failed the current case evaluation.")
      statusReason = "Solve failed the current case evaluation."
    }
    if (matched?.attempt.refineRoutingClass) {
      pushReasonLine(reasonTrail, `Failure was routed as ${matched.attempt.refineRoutingClass}.`)
      statusReason ??= `Solve failed and was routed as ${matched.attempt.refineRoutingClass}.`
    }
    if (matched?.attempt.judgeSessionID && attemptDir) {
      nextStepTitle = (await readSiblingRunTitle(path.join(attemptDir, "judge", "run.json"))) ?? "soft judge"
      nextStepReason =
        judgeSummary?.shouldStartMaintainer === true
          ? "Solve failed, so a judge session was started to decide whether maintenance should begin."
          : "Solve failed, so a judge session was started to analyze the failure."
    }
  }

  if (task?.kind === "judge") {
    if (judgeSummary?.failureClass) {
      statusReason = `Judge classified the failure as ${judgeSummary.failureClass}.`
    }
    for (const issue of judgeSummary?.keyIssues ?? []) pushReasonLine(reasonTrail, issue)
    for (const issue of judgeSummary?.behaviorIssues ?? []) pushReasonLine(reasonTrail, issue)
    if (judgeSummary?.shouldStartMaintainer && attemptDir) {
      const maintainTitle = attemptDir
        ? await readSiblingRunTitle(path.join(attemptDir, "maintenance-rounds", "round-01", "maintain", "run.json"))
        : undefined
      nextStepTitle = maintainTitle ?? "knowledge maintainer"
      nextStepReason = judgeSummary.failureClass
        ? `Judge approved maintenance because the failure pattern was ${judgeSummary.failureClass}.`
        : "Judge approved maintenance for the failed case."
    } else if (judgeSummary?.shouldStartMaintainer === false) {
      nextStepReason = "Judge decided not to start maintenance for this failure."
    }
  }

  if (task?.kind === "maintain") {
    if (judgeSummary?.failureClass) {
      statusReason = `Maintainer was started after the judge classified the failure as ${judgeSummary.failureClass}.`
    } else {
      statusReason = "Maintainer was started after the judge approved experience maintenance."
    }
    if (postJudgeSummary?.decision) {
      pushReasonLine(
        reasonTrail,
        `Post-judge decision: ${postJudgeSummary.decision}${postJudgeSummary.riskLevel ? ` (risk ${postJudgeSummary.riskLevel})` : ""}.`,
      )
      nextStepReason =
        postJudgeSummary.decision === "accept"
          ? "This maintenance round was accepted after verification and regression checks."
          : "This maintenance round was not accepted after post-judge review."
    }
    for (const reason of postJudgeSummary?.reasons ?? []) pushReasonLine(reasonTrail, reason)
    for (const note of postJudgeSummary?.notes ?? []) pushReasonLine(reasonTrail, note)
  }

  if (!statusReason && typeof run.exitCode === "number") {
    statusReason =
      run.exitCode === 0
        ? "This session finished without a process error."
        : `This session ended with exit code ${run.exitCode}.`
  }

  return {
    task,
    titleSource: run.task?.title ? "task.title" : run.title ? "run.title" : "directory name",
    whyStarted: describeTaskStart(task),
    statusReason,
    nextStepTitle,
    nextStepReason,
    reasonTrail,
  }
}

function actionFromEvent(event: any): MonitorAction | undefined {
  if (event?.type === "session.error") {
    return {
      kind: "error",
      label: "assistant_error",
      detail: previewText(event?.error?.message, 160),
      timestamp: typeof event?.timestamp === "number" ? event.timestamp : 0,
    }
  }

  if (event?.part) {
    const fallbackTimestamp =
      typeof event?.timestamp === "number"
        ? event.timestamp
        : typeof event?.time === "number"
          ? event.time
          : 0
    return actionFromPart(event.part as MessageV2.Part, fallbackTimestamp)
  }
}

async function listFilesRecursive(root: string, targetName: string, maxFiles: number) {
  const files: { filePath: string; updated: number }[] = []

  async function visit(directory: string): Promise<void> {
    if (files.length >= maxFiles) return

    let entries: import("node:fs").Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath)
        continue
      }
      if (!entry.isFile() || entry.name !== targetName) continue
      const info = await stat(fullPath).catch(() => undefined)
      files.push({ filePath: fullPath, updated: info?.mtimeMs ?? 0 })
    }
  }

  await visit(root)
  return files
}

async function collectArtifactActions(stageDir: string, limit = 20) {
  const events = (await safeReadJson<any[]>(path.join(stageDir, "events.json"))) ?? []
  return events
    .map((event) => actionFromEvent(event))
    .filter((action): action is MonitorAction => !!action)
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-limit)
}

function buildArtifactTitle(run: ArtifactRun, stageDir: string) {
  return normalizeMonitorTitle(run.task?.title ?? run.title, run.task, stageDir, path.basename(stageDir))
}

function buildArtifactStep(run: ArtifactRun) {
  return run.task?.phase ?? run.task?.kind ?? run.phase ?? "task"
}

function buildArtifactStatus(run: ArtifactRun): MonitorStatus {
  if (typeof run.exitCode === "number") {
    return run.exitCode === 0 ? "done" : "error"
  }
  return normalizeLifecycleStatus(run.status)
}

function buildArtifactDetail(run: ArtifactRun, responsePreview?: string) {
  const parts: string[] = []
  if (run.task?.caseID) parts.push(`case:${run.task.caseID}`)
  if (typeof run.task?.attempt === "number") parts.push(`attempt:${run.task.attempt}`)
  if (typeof run.task?.maintenanceRound === "number") parts.push(`round:${run.task.maintenanceRound}`)
  if (run.task?.methodID ?? run.methodID) parts.push(`method:${run.task?.methodID ?? run.methodID}`)
  if (responsePreview) parts.push(responsePreview)
  return parts.join(" | ") || undefined
}

function normalizeLifecycleStatus(status: string | undefined): MonitorStatus {
  const normalized = (status ?? "").toLowerCase()
  if (normalized === "running" || normalized === "bootstrapping" || normalized === "waiting") return "running"
  if (normalized === "retry" || normalized === "waiting_for_retry") return "retry"
  if (
    normalized === "done" ||
    normalized === "verified_success" ||
    normalized === "succeeded" ||
    normalized === "success" ||
    normalized === "completed"
  ) {
    return "done"
  }
  if (
    normalized === "error" ||
    normalized === "failed" ||
    normalized === "blocked_failure" ||
    normalized === "exhausted_failure" ||
    normalized === "stagnation_failure"
  ) {
    return "error"
  }
  if (normalized === "archived") return "archived"
  return "idle"
}

function parseIsoTimestamp(input: string | undefined) {
  if (!input) return 0
  const value = Date.parse(input)
  return Number.isFinite(value) ? value : 0
}

function lifecycleAction(label: string, detail: string | undefined, timestamp: number): MonitorAction[] {
  if (!timestamp) return []
  return [
    {
      kind: "step_start",
      label,
      detail,
      timestamp,
    },
  ]
}

async function buildArtifactRow(runJsonPath: string) {
  const run = await safeReadJson<ArtifactRun>(runJsonPath)
  if (!run || typeof run !== "object") return undefined
  if (!run.sessionID && !run.task && !run.phase) return undefined

  const stageDir = path.dirname(runJsonPath)
  const info = await stat(runJsonPath).catch(() => undefined)
  const updated = Math.max(
    info?.mtimeMs ?? 0,
    parseIsoTimestamp(run.updatedAt),
    parseIsoTimestamp(run.lastOutputAt),
    parseIsoTimestamp(run.startedAt),
  )
  const id = typeof run.sessionID === "string" && run.sessionID ? run.sessionID : `artifact:${stageDir}`
  const responsePreview = await safeReadPreview(path.join(stageDir, "response.txt"), 120)
  const narrative = await buildArtifactNarrative(run, stageDir)
  const roundNumber =
    (typeof run.task?.maintenanceRound === "number" ? run.task.maintenanceRound : undefined) ??
    parseRoundNumber(extractTitleContextFromDirectory(stageDir).round)

  return {
    id,
    title: buildArtifactTitle(run, stageDir),
    directory: stageDir,
    updated,
    archived: false,
    status: buildArtifactStatus(run),
    step: buildArtifactStep(run),
    detail: buildArtifactDetail(run, responsePreview),
    recentActions: await collectArtifactActions(stageDir, 20),
    task: narrative.task,
    titleSource: narrative.titleSource,
    whyStarted: narrative.whyStarted,
    statusReason: narrative.statusReason,
    nextStepTitle: narrative.nextStepTitle,
    nextStepReason: narrative.nextStepReason,
    reasonTrail: narrative.reasonTrail,
    monitorKind: "pipeline",
    roundNumber,
  } satisfies MonitorRow
}

async function buildProgressStateRow(progressStatePath: string) {
  const progress = await safeReadJson<LifecycleProgressState>(progressStatePath)
  if (!progress?.runID) return undefined
  const runDir = path.dirname(progressStatePath)
  const task = await safeReadJson<ArtifactRun>(path.join(runDir, "task.json"))
  const info = await stat(progressStatePath).catch(() => undefined)
  const updated = Math.max(
    info?.mtimeMs ?? 0,
    parseIsoTimestamp(progress.updatedAt),
    parseIsoTimestamp(progress.heartbeatAt),
  )
  const detail = joinPreviewParts([
    typeof progress.activeAttempt === "number" ? `attempt:${progress.activeAttempt}` : undefined,
    typeof progress.noProgressCycles === "number" ? `no-progress:${progress.noProgressCycles}` : undefined,
    typeof progress.validatorCalls === "number" ? `validators:${progress.validatorCalls}` : undefined,
  ])
  const timestamp = parseIsoTimestamp(progress.heartbeatAt) || parseIsoTimestamp(progress.updatedAt) || updated
  const roundNumber = parseRoundNumber(progress.runID)

  return {
    id: `lifecycle:run:${progress.runID}`,
    title: normalizeMonitorTitle(
      task?.title ? `Long Task ${task.title}` : undefined,
      task?.task,
      runDir,
      `Long Task ${progress.runID}`,
    ),
    directory: runDir,
    updated,
    archived: false,
    status: normalizeLifecycleStatus(progress.status),
    step: progress.activeUnitID ?? progress.status ?? "idle",
    detail,
    recentActions: lifecycleAction(
      "progress_state",
      joinPreviewParts([progress.status, progress.activeUnitID]),
      timestamp,
    ),
    task: task?.task,
    titleSource: "progress_state.json",
    whyStarted: "This row is sourced from long-task progress_state.json so startup state is visible before run.json appears.",
    statusReason: progress.finalSummary,
    nextStepTitle: progress.activeUnitID ? `Continue ${progress.activeUnitID}` : undefined,
    nextStepReason: progress.status ? `Current lifecycle status: ${progress.status}.` : undefined,
    reasonTrail: progress.finalSummary ? [progress.finalSummary] : undefined,
    monitorKind: "pipeline",
    roundNumber,
  } satisfies MonitorRow
}

async function buildCampaignStateRow(campaignStatePath: string) {
  const campaign = await safeReadJson<LifecycleCampaignState>(campaignStatePath)
  if (!campaign) return undefined
  const campaignDir = path.dirname(campaignStatePath)
  const info = await stat(campaignStatePath).catch(() => undefined)
  const updated = Math.max(
    info?.mtimeMs ?? 0,
    parseIsoTimestamp(campaign.updatedAt),
    parseIsoTimestamp(campaign.heartbeatAt),
  )
  const id = campaign.id && campaign.id.trim() ? campaign.id : path.basename(campaignDir)
  const roundLabel =
    typeof campaign.currentRound === "number" ? `round-${padCounter(Math.max(1, campaign.currentRound), 3)}` : undefined
  const timestamp = parseIsoTimestamp(campaign.heartbeatAt) || parseIsoTimestamp(campaign.updatedAt) || updated

  return {
    id: `lifecycle:campaign:${id}`,
    title: normalizeMonitorTitle(
      campaign.title ? `Long Task Campaign ${campaign.title}` : undefined,
      undefined,
      campaignDir,
      `Long Task Campaign ${id}`,
    ),
    directory: campaignDir,
    updated,
    archived: false,
    status: normalizeLifecycleStatus(campaign.status),
    step: roundLabel ?? campaign.status ?? "idle",
    detail: joinPreviewParts([campaign.status, roundLabel]),
    recentActions: lifecycleAction(
      "campaign_state",
      joinPreviewParts([campaign.status, roundLabel]),
      timestamp,
    ),
    titleSource: "campaign.json",
    whyStarted: "This row is sourced from campaign.json so campaign startup is visible immediately.",
    statusReason: previewText(campaign.lastSummary, 220),
    nextStepTitle: roundLabel ? `Advance ${roundLabel}` : undefined,
    nextStepReason: campaign.status ? `Campaign lifecycle status: ${campaign.status}.` : undefined,
    reasonTrail: campaign.lastSummary ? [campaign.lastSummary] : undefined,
    monitorKind: "pipeline",
    roundNumber: typeof campaign.currentRound === "number" ? campaign.currentRound : undefined,
  } satisfies MonitorRow
}

async function collectLifecycleRows(limit: number) {
  const maxFiles = Math.max(limit * 8, 80)
  const [progressCandidates, campaignCandidates] = await Promise.all([
    listFilesRecursive(LONG_TASK_RUNS_ROOT, "progress_state.json", maxFiles),
    listFilesRecursive(LONG_TASK_CAMPAIGNS_ROOT, "campaign.json", maxFiles),
  ])
  const rows: MonitorRow[] = []

  for (const item of progressCandidates.sort((left, right) => right.updated - left.updated)) {
    const row = await buildProgressStateRow(item.filePath)
    if (row) rows.push(row)
  }
  for (const item of campaignCandidates.sort((left, right) => right.updated - left.updated)) {
    const row = await buildCampaignStateRow(item.filePath)
    if (row) rows.push(row)
  }
  return uniqueRows(rows).sort((left, right) => right.updated - left.updated).slice(0, limit)
}

async function collectArtifactRows(limit: number) {
  const now = Date.now()
  if (artifactCache && artifactCache.expiresAt > now) {
    return artifactCache.rows.slice(0, limit)
  }

  const candidates: { filePath: string; updated: number }[] = []
  const maxFiles = Math.max(limit * 12, 120)

  for (const root of ARTIFACT_SCAN_ROOTS) {
    const exists = await stat(root)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue
    candidates.push(...(await listFilesRecursive(root, "run.json", maxFiles)))
  }

  const rows: MonitorRow[] = []
  for (const item of candidates.sort((left, right) => right.updated - left.updated)) {
    const row = await buildArtifactRow(item.filePath)
    if (row) rows.push(row)
  }

  const unique = uniqueRows(rows).sort((left, right) => right.updated - left.updated)
  artifactCache = {
    expiresAt: now + ARTIFACT_CACHE_TTL_MS,
    rows: unique,
  }
  return unique.slice(0, limit)
}

function mergeSessionRow(sessionRow: MonitorRow, artifactRow: MonitorRow) {
  const sessionIsLive = sessionRow.status === "running" || sessionRow.status === "retry"
  const artifactIsTerminal =
    artifactRow.status === "done" || artifactRow.status === "error" || artifactRow.status === "archived"
  const preferArtifactNarrative =
    artifactIsTerminal || sessionRow.status === "idle" || artifactRow.updated >= sessionRow.updated
  const preferSessionNarrative = sessionIsLive && !preferArtifactNarrative
  return {
    ...sessionRow,
    title: artifactRow.title || sessionRow.title,
    directory: artifactRow.directory || sessionRow.directory,
    updated: Math.max(sessionRow.updated, artifactRow.updated),
    status: preferSessionNarrative ? sessionRow.status : artifactRow.status || sessionRow.status,
    step: preferSessionNarrative ? sessionRow.step : artifactRow.step || sessionRow.step,
    detail: preferSessionNarrative ? sessionRow.detail ?? artifactRow.detail : artifactRow.detail ?? sessionRow.detail,
    recentActions:
      preferSessionNarrative && sessionRow.recentActions.length
        ? sessionRow.recentActions
        : artifactRow.recentActions.length
          ? artifactRow.recentActions
          : sessionRow.recentActions,
    lastUser: sessionRow.lastUser ?? artifactRow.lastUser,
    parentID: sessionRow.parentID ?? artifactRow.parentID,
    task: sessionRow.task ?? artifactRow.task,
    titleSource: artifactRow.titleSource ?? sessionRow.titleSource,
    whyStarted: artifactRow.whyStarted ?? sessionRow.whyStarted,
    statusReason: preferSessionNarrative
      ? sessionRow.statusReason ?? artifactRow.statusReason
      : artifactRow.statusReason ?? sessionRow.statusReason,
    nextStepTitle: artifactRow.nextStepTitle ?? sessionRow.nextStepTitle,
    nextStepReason: artifactRow.nextStepReason ?? sessionRow.nextStepReason,
    reasonTrail:
      preferSessionNarrative && sessionRow.reasonTrail?.length
        ? sessionRow.reasonTrail
        : artifactRow.reasonTrail ?? sessionRow.reasonTrail,
    monitorKind: artifactRow.monitorKind ?? sessionRow.monitorKind,
    roundNumber: artifactRow.roundNumber ?? sessionRow.roundNumber,
  } satisfies MonitorRow
}

function actionFromPart(part: MessageV2.Part, fallbackTimestamp = 0, sequence = 0): MonitorAction | undefined {
  if (part.type === "tool") {
    const title =
      "title" in part.state && typeof part.state.title === "string" && part.state.title ? part.state.title : undefined
    const inputPreview = previewValue(part.state.input, 80)

    let detail: string | undefined
    if (part.state.status === "completed") {
      detail = joinPreviewParts([title ?? inputPreview, summarizeToolOutput(part.tool, part.state.output, 140)])
    } else if (part.state.status === "error") {
      detail = joinPreviewParts([title ?? inputPreview, `error: ${previewText(part.state.error, 120) ?? "unknown"}`])
    } else {
      detail = title ?? inputPreview
    }

    // Build label: include tool name and a meaningful status indicator
    let label = part.tool
    if (part.state.status === "completed") {
      label += ":done"
    } else if (part.state.status === "running") {
      label += ":running"
    } else if (part.state.status === "pending") {
      label += ":pending"
    } else if (part.state.status === "error") {
      label += ":error"
    }

    return {
      kind: "tool",
      label,
      detail,
      timestamp: partTimestamp(part, fallbackTimestamp, sequence),
    }
  }

  if (part.type === "text") {
    const text = previewText(part.text, 160)
    if (!text) return undefined
    return {
      kind: "text",
      label: "assistant_text",
      detail: text,
      timestamp: partTimestamp(part, fallbackTimestamp, sequence),
    }
  }

  if (part.type === "reasoning") {
    const text = previewText(part.text, 160)
    if (!text) return undefined
    return {
      kind: "reasoning",
      label: "reasoning",
      detail: text,
      timestamp: partTimestamp(part, fallbackTimestamp, sequence),
    }
  }

  if (part.type === "step-start") {
    return {
      kind: "step_start",
      label: "step_start",
      detail: part.snapshot ? `snapshot:${part.snapshot.slice(0, 10)}` : undefined,
      timestamp: partTimestamp(part, fallbackTimestamp, sequence),
    }
  }

  if (part.type === "step-finish") {
    return {
      kind: "step_finish",
      label: `step_finish:${part.reason}`,
      detail: part.tokens?.total ? `tokens:${part.tokens.total}` : undefined,
      timestamp: partTimestamp(part, fallbackTimestamp, sequence),
    }
  }
}

function uniqueRows(rows: MonitorRow[]) {
  const seen = new Set<string>()
  const ordered: MonitorRow[] = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    ordered.push(row)
  }
  return ordered
}

function collectRecentActions(messages: MessageV2.WithParts[], limit = 20) {
  const actions: MonitorAction[] = []

  for (const message of messages) {
    const messageTimestamp =
      message.info.role === "assistant"
        ? message.info.time.completed ?? message.info.time.created
        : message.info.time.created

    if (message.info.role === "assistant" && message.info.error) {
      actions.push({
        kind: "error",
        label: "assistant_error",
        detail: previewText(message.info.error.message, 160),
        timestamp: messageTimestamp,
      })
    }

    for (let index = 0; index < message.parts.length; index++) {
      const part = message.parts[index]
      const action = actionFromPart(part, messageTimestamp, index)
      if (action) actions.push(action)
    }
  }

  return actions.sort((left, right) => left.timestamp - right.timestamp).slice(-limit)
}

function collectDetailedActions(messages: MessageV2.WithParts[], limit = 600) {
  const actions: MonitorAction[] = []

  for (const message of messages) {
    const messageTimestamp =
      message.info.role === "assistant"
        ? message.info.time.completed ?? message.info.time.created
        : message.info.time.created

    if (message.info.role === "user") {
      const userText = previewText(
        message.parts
          .filter((part): part is MessageV2.TextPart => part.type === "text")
          .map((part) => part.text)
          .join(" "),
        400,
      )
      if (userText) {
        actions.push({
          kind: "text",
          label: "user_prompt",
          detail: userText,
          timestamp: messageTimestamp,
        })
      }
    }

    if (message.info.role === "assistant" && message.info.error) {
      actions.push({
        kind: "error",
        label: "assistant_error",
        detail: previewText(message.info.error.message, 240),
        timestamp: messageTimestamp,
      })
    }

    for (let index = 0; index < message.parts.length; index++) {
      const part = message.parts[index]
      const action = actionFromPart(part, messageTimestamp, index)
      if (action) actions.push(action)
    }
  }

  return actions.sort((left, right) => left.timestamp - right.timestamp).slice(-limit)
}

async function collectSessionDetailActions(sessionID: string, messageLimit: number, actionLimit: number) {
  const effectiveMessageLimit = Math.max(20, Math.min(2000, messageLimit))
  const effectiveActionLimit = Math.max(50, Math.min(3000, actionLimit))
  await Session.get(sessionID)
  const messages = await Session.messages({ sessionID, limit: effectiveMessageLimit })
  const actions = collectDetailedActions(messages, effectiveActionLimit)
  return {
    sessionID,
    messageCount: messages.length,
    actionCount: actions.length,
    actions,
  }
}

function summarizeSession(
  session: Session.GlobalInfo,
  status: SessionStatus.Info,
  messages: MessageV2.WithParts[],
  actionsLimit = 20,
): MonitorRow {
  const assistant = latestAssistant(messages)
  const user = latestUser(messages)
  const parts = assistant?.parts ?? []
  const activeTool = findActiveTool(parts)
  const recentActions = collectRecentActions(messages, actionsLimit)

  let monitorStatus: MonitorStatus = "idle"
  let step = "idle"
  let detail: string | undefined

  if (session.time.archived) {
    monitorStatus = "archived"
    step = "archived"
  } else if (status.type === "retry") {
    monitorStatus = "retry"
    step = `retry #${status.attempt}`
    detail = status.message
  } else if (status.type === "busy") {
    monitorStatus = "running"
    if (activeTool) {
      step = `tool:${activeTool.tool}`
      detail =
        ("title" in activeTool.state && typeof activeTool.state.title === "string"
          ? activeTool.state.title
          : undefined) ?? previewValue(activeTool.state.input)
    } else if (unfinishedText(parts)) {
      step = "text"
      detail = previewText(unfinishedText(parts)?.text, 120)
    } else if (unfinishedReasoning(parts)) {
      step = "reasoning"
      detail = previewText(unfinishedReasoning(parts)?.text, 120)
    } else if (hasOpenStep(parts)) {
      step = "step"
    } else if (user) {
      step = "awaiting-assistant"
    }
  } else if (assistant?.info.role === "assistant" && assistant.info.error) {
    monitorStatus = "error"
    step = "error"
    detail = assistant.info.error.message
  } else if (assistant?.info.role === "assistant" && assistant.info.time.completed) {
    monitorStatus = "done"
    const lastFinish = [...parts].reverse().find((part) => part.type === "step-finish") as
      | MessageV2.StepFinishPart
      | undefined
    step = lastFinish ? `done:${lastFinish.reason}` : "done"
    const lastText = [...parts].reverse().find((part) => part.type === "text") as MessageV2.TextPart | undefined
    detail = previewText(lastText?.text, 120)
  }

  return {
    id: session.id,
    title: normalizeMonitorTitle(session.title, undefined, session.directory, session.id),
    parentID: session.parentID,
    directory: session.directory,
    updated: session.time.updated,
    archived: !!session.time.archived,
    status: monitorStatus,
    step,
    detail,
    lastUser: previewText(
      user?.parts
        .filter((part): part is MessageV2.TextPart => part.type === "text")
        .map((part) => part.text)
        .join(" "),
      120,
    ),
    recentActions,
    roundNumber: parseRoundNumber(session.title) ?? parseRoundNumber(session.directory),
  }
}

function formatActionNarrative(action: MonitorAction | undefined) {
  if (!action) return undefined
  const detail = previewText(action.detail, 180)
  return detail ? `${action.label}: ${detail}` : action.label
}

function fallbackWhyStarted(row: MonitorRow) {
  if (row.whyStarted) return row.whyStarted
  if (row.task) {
    return describeTaskStart(row.task) ?? describeTaskPurpose(row.task)
  }

  const source = row.monitorKind === "pipeline" ? "pipeline" : "ad hoc"
  const user = previewText(row.lastUser, 180)
  if (user) return `This ${source} session was started for the request: ${user}.`
  if (row.title) return `This ${source} session was started as "${previewText(row.title, 180)}".`
  return `This ${source} session started without a structured task narrative.`
}

function fallbackStatusReason(row: MonitorRow) {
  if (row.statusReason) return row.statusReason

  const detail = previewText(row.detail, 200)
  const latestAction = formatActionNarrative(row.recentActions.at(-1))

  switch (row.status) {
    case "running":
      return detail
        ? `This session is still running. Latest observed output: ${detail}.`
        : latestAction
          ? `This session is still running. Latest observed action: ${latestAction}.`
          : "This session is still running."
    case "retry":
      return detail
        ? `This session is in retry flow. Current signal: ${detail}.`
        : latestAction
          ? `This session is in retry flow. Latest observed action: ${latestAction}.`
          : "This session is waiting for or performing another retry."
    case "done":
      return detail
        ? `This session finished successfully. Latest result: ${detail}.`
        : latestAction
          ? `This session finished successfully. Final observed action: ${latestAction}.`
          : "This session finished successfully."
    case "error":
      return detail
        ? `This session ended with an error signal: ${detail}.`
        : latestAction
          ? `This session ended with an error after: ${latestAction}.`
          : "This session ended with an error."
    case "archived":
      return detail ? `This session is archived. Last recorded detail: ${detail}.` : "This session is archived."
    case "idle":
    default:
      return detail
        ? `No live runtime signal is active. Last known detail: ${detail}.`
        : latestAction
          ? `No live runtime signal is active. Last observed action: ${latestAction}.`
          : "No live runtime signal is currently active for this session."
  }
}

function fallbackNextStep(row: MonitorRow) {
  if (row.nextStepTitle || row.nextStepReason) {
    return {
      nextStepTitle: row.nextStepTitle,
      nextStepReason: row.nextStepReason,
    }
  }

  if (row.status === "running" || row.status === "retry") {
    return {
      nextStepTitle: undefined,
      nextStepReason: "This session is still active, so no downstream stage has been recorded yet.",
    }
  }

  if (row.monitorKind === "pipeline" || row.task) {
    return {
      nextStepTitle: undefined,
      nextStepReason: "No explicit next-stage transition was recorded in the pipeline artifacts for this session.",
    }
  }

  return {
    nextStepTitle: undefined,
    nextStepReason: "This ad hoc session does not have a structured follow-up stage recorded.",
  }
}

function fallbackReasonTrail(row: MonitorRow) {
  if (row.reasonTrail?.length) return row.reasonTrail

  const trail: string[] = []
  if (row.titleSource) {
    trail.push(`Title source: ${row.titleSource}.`)
  }

  const latestActions = row.recentActions
    .slice(-3)
    .map((action) => formatActionNarrative(action))
    .filter((line): line is string => !!line)

  for (const line of latestActions) {
    trail.push(`Observed action: ${line}.`)
  }

  if (row.status === "retry") {
    trail.push("This session is marked as retry, so another attempt or follow-up worker was expected.")
  }

  if (row.status === "error") {
    trail.push("This session reached an error state, so upstream orchestration may have stopped or rerouted work.")
  }

  return trail.length ? trail : undefined
}

function finalizeNarrativeRow(row: MonitorRow): MonitorRow {
  const next = fallbackNextStep(row)
  return {
    ...row,
    whyStarted: fallbackWhyStarted(row),
    statusReason: fallbackStatusReason(row),
    nextStepTitle: next.nextStepTitle,
    nextStepReason: next.nextStepReason,
    reasonTrail: fallbackReasonTrail(row),
  }
}

async function collectMonitorRows(limit: number) {
  const requestLimit = Math.max(1, limit)
  const expandedLimit = Math.max(requestLimit * 12, 240)
  const [statuses, artifactRows, lifecycleRows] = await Promise.all([
    SessionStatus.list(),
    collectArtifactRows(expandedLimit),
    collectLifecycleRows(expandedLimit),
  ])
  const combinedArtifactRows = uniqueRows([...lifecycleRows, ...artifactRows]).sort(
    (left, right) => right.updated - left.updated,
  )
  const sessions = [...Session.listGlobal({ limit: expandedLimit, archived: true })]
  const rows: MonitorRow[] = []
  const seen = new Set<string>()
  const artifactByID = new Map<string, MonitorRow>(combinedArtifactRows.map((row) => [row.id, row] as const))

  for (const session of sessions) {
    const messages = await Session.messages({ sessionID: session.id, limit: 20 }).catch(
      () => [] as MessageV2.WithParts[],
    )
    const sessionRow = summarizeSession(session, statuses.get(session.id) ?? { type: "idle" }, messages, 20)
    const artifactRow = artifactByID.get(session.id)
    const merged = artifactRow ? mergeSessionRow(sessionRow, artifactRow) : sessionRow
    rows.push(finalizeNarrativeRow(merged))
    seen.add(merged.id)
  }

  for (const artifactRow of combinedArtifactRows) {
    if (seen.has(artifactRow.id)) continue
    rows.push(finalizeNarrativeRow(artifactRow))
  }

  return rows.sort((left, right) => right.updated - left.updated).slice(0, requestLimit)
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

async function renderDashboardHtml(options: { limit: number; intervalSeconds: number }) {
  const limit = Math.max(1, options.limit)
  const intervalSeconds = Math.max(1, options.intervalSeconds)
  const template = await readFile(MONITOR_FRONTEND_TEMPLATE_PATH, "utf8")
  return template
    .replaceAll("__MONITOR_LIMIT__", String(limit))
    .replaceAll("__MONITOR_INTERVAL_SECONDS__", String(intervalSeconds))
}

async function main() {
  const hostname = getOption("--hostname", "127.0.0.1")
  const port = Math.max(1, Number(getOption("--port", "4219")) || 4219)
  const intervalSeconds = Math.max(1, Number(getOption("--interval", "2")) || 2)
  const limit = Math.max(1, Number(getOption("--limit", "50")) || 50)

  // Warm once so monitor refresh does not repeatedly bootstrap/dispose the OpenCode runtime.
  await withMonitorInstance(async () => undefined)

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${hostname}:${port}`)

    if (url.pathname === "/api/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" })
      response.end(JSON.stringify({ healthy: true, generatedAt: Date.now() }))
      return
    }

    if (url.pathname === "/api/sessions") {
      try {
        const requestLimit = Math.max(1, Number(url.searchParams.get("limit") || limit))
        const rows = await withMonitorInstance(() => collectMonitorRows(requestLimit))
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
        response.end(JSON.stringify({ generatedAt: Date.now(), rows }))
        return
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" })
        response.end(JSON.stringify({ error: errorMessage(error) }))
        return
      }
    }

    if (url.pathname === "/api/session-actions") {
      try {
        const sessionID = (url.searchParams.get("sessionID") ?? "").trim()
        if (!sessionID) {
          response.writeHead(400, { "content-type": "application/json; charset=utf-8" })
          response.end(JSON.stringify({ error: "Missing sessionID query parameter." }))
          return
        }

        const messageLimit = Math.max(20, Math.min(2000, Number(url.searchParams.get("messageLimit") || "400") || 400))
        const actionLimit = Math.max(50, Math.min(3000, Number(url.searchParams.get("actionLimit") || "800") || 800))
        const detail = await withMonitorInstance(() => collectSessionDetailActions(sessionID, messageLimit, actionLimit))
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
        response.end(JSON.stringify({ generatedAt: Date.now(), ...detail }))
        return
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" })
        response.end(JSON.stringify({ error: errorMessage(error) }))
        return
      }
    }

    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    })
    response.end(await renderDashboardHtml({ limit, intervalSeconds }))
  })

  server.listen(port, hostname, () => {
    console.log(
      `Auto-evolve monitor listening on ${escapeHtml(`http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${port}`)}`,
    )
  })

  const cleanup = () => {
    void Instance.disposeAll().catch(() => {})
    server.close()
  }
  process.once("SIGINT", cleanup)
  process.once("SIGTERM", cleanup)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
