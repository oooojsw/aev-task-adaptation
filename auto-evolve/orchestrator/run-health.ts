import path from "node:path"
import { mkdir, readdir, readFile, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { identifyProcessOwner, optionalProcessOwnerHints, strongProcessOwnerHints } from "./process-identity"
import { writeFileAtomic, writeJsonAtomic } from "./atomic-write"

export type RunHealthKind =
  | "completed"
  | "starting"
  | "healthy_running"
  | "long_running"
  | "recovery_pending"
  | "stale_running"
  | "stuck_running"
  | "idle"
  | "unknown"

export type CampaignHealth = {
  campaignID: string
  campaignDir: string
  taskID?: string
  status: string
  health: RunHealthKind
  currentRound?: number
  maxRounds?: number
  ownerPID?: number
  ownerCreationTick?: string
  ownerAlive: boolean
  heartbeatAt?: string
  updatedAt?: string
  lastArtifactAt?: string
  lastArtifactPath?: string
  ageSeconds?: number
  artifactAgeSeconds?: number
  reason: string
  suggestedAction: "watch" | "resume" | "takeover" | "none"
}

export type DashboardSummary = {
  updatedAt: string
  campaigns: CampaignHealth[]
  counts: Record<string, number>
}

const LIVE_STATUSES = new Set(["bootstrapping", "running"])
const DONE_STATUSES = new Set([
  "verified_success",
  "round_limit_reached",
  "failed",
  "blocked_failure",
  "stagnation_failure",
  "aborted",
])

const DEFAULT_STALE_OWNER_MS = 45 * 60 * 1000
const DEFAULT_LONG_RUNNING_MS = 2 * 60 * 60 * 1000
const DEFAULT_NO_ARTIFACT_GROWTH_MS = 45 * 60 * 1000
const DEFAULT_BOOTSTRAP_NO_OWNER_GRACE_MS = 2 * 60 * 1000

function numberEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function defaultRunHealthPolicy() {
  return {
    staleOwnerMs: numberEnv("AUTO_EVOLVE_STALE_OWNER_MS", DEFAULT_STALE_OWNER_MS),
    longRunningMs: numberEnv("AUTO_EVOLVE_LONG_RUNNING_MS", DEFAULT_LONG_RUNNING_MS),
    noArtifactGrowthMs: numberEnv("AUTO_EVOLVE_NO_ARTIFACT_GROWTH_MS", DEFAULT_NO_ARTIFACT_GROWTH_MS),
    bootstrapNoOwnerGraceMs: numberEnv(
      "AUTO_EVOLVE_BOOTSTRAP_NO_OWNER_GRACE_MS",
      DEFAULT_BOOTSTRAP_NO_OWNER_GRACE_MS,
    ),
  }
}

function parseMs(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function taskIDFromCampaignID(campaignID: string) {
  const match = campaignID.match(/(?:^|-)uid([a-z0-9]+)(?:-|$)/i)
  return match ? `UID${match[1].toUpperCase()}` : undefined
}

async function newestFile(root: string, depth = 0): Promise<{ path: string; mtimeMs: number } | undefined> {
  if (depth > 5) return undefined
  let best: { path: string; mtimeMs: number } | undefined
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".opencode" || entry.name === ".git") continue
    const full = path.join(root, entry.name)
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(full)
    } catch {
      continue
    }
    if (entry.isDirectory()) {
      const child = await newestFile(full, depth + 1)
      if (child && (!best || child.mtimeMs > best.mtimeMs)) best = child
      continue
    }
    if (!best || info.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: info.mtimeMs }
  }
  return best
}

export async function readCampaignHealth(campaignDir: string, nowMs = Date.now()): Promise<CampaignHealth | undefined> {
  const statePath = path.join(campaignDir, "campaign.json")
  if (!existsSync(statePath)) return undefined
  let state: any
  try {
    state = JSON.parse(await readFile(statePath, "utf8"))
  } catch {
    return undefined
  }

  const campaignID = String(state.id ?? path.basename(campaignDir))
  const heartbeatMs = parseMs(state.heartbeatAt) ?? parseMs(state.updatedAt)
  const ageSeconds = typeof heartbeatMs === "number" ? Math.max(0, Math.round((nowMs - heartbeatMs) / 1000)) : undefined
  const ownerPID = typeof state.ownerPID === "number" ? state.ownerPID : undefined
  const ownerCommandHint = typeof state.ownerCommandHint === "string" ? state.ownerCommandHint : undefined
  const ownerCreationTick = typeof state.ownerCreationTick === "string" ? state.ownerCreationTick : undefined
  const policy = defaultRunHealthPolicy()
  const status = String(state.status ?? "unknown")
  const taskID = taskIDFromCampaignID(campaignID)
  const baseSpecPath = typeof state.baseSpecPath === "string" ? state.baseSpecPath : undefined
  const ownerIdentity = await identifyProcessOwner({
    pid: ownerPID,
    requiredAnyCommandHints: strongProcessOwnerHints([
      ownerCommandHint,
      campaignID,
      path.basename(campaignDir),
      baseSpecPath,
      baseSpecPath ? path.basename(baseSpecPath) : undefined,
    ]),
    optionalCommandHints: [
      ...optionalProcessOwnerHints([ownerCommandHint]),
      "run-long-task-campaign",
      "resume-long-task-campaign",
    ],
    expectedCreationTick: ownerCreationTick,
    heartbeatAt: typeof state.heartbeatAt === "string" ? state.heartbeatAt : undefined,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : undefined,
    staleAfterMs: policy.staleOwnerMs,
  })
  const ownerAlive = ownerIdentity.alive && (ownerIdentity.ownership === "owned" || ownerIdentity.ownership === "unknown_owner")
  const heartbeatStaleForArtifactCheck =
    typeof heartbeatMs === "number" && nowMs - heartbeatMs > Math.min(policy.staleOwnerMs, policy.noArtifactGrowthMs)
  const needsArtifactCheck = status === "recovery_pending" || (LIVE_STATUSES.has(status) && heartbeatStaleForArtifactCheck)
  const newest = needsArtifactCheck ? await newestFile(campaignDir) : undefined
  const artifactAgeSeconds = newest ? Math.max(0, Math.round((nowMs - newest.mtimeMs) / 1000)) : undefined

  let health: RunHealthKind = "unknown"
  let reason = "Unable to classify campaign state."
  let suggestedAction: CampaignHealth["suggestedAction"] = "none"

  if (DONE_STATUSES.has(status)) {
    health = "completed"
    reason = `Campaign is terminal (${status}).`
  } else if (status === "recovery_pending") {
    health = "recovery_pending"
    reason = "Campaign is already marked for recovery."
    suggestedAction = "resume"
  } else if (!LIVE_STATUSES.has(status)) {
    health = "idle"
    reason = `Campaign status is ${status}.`
  } else if (ownerPID && ownerIdentity.ownership === "wrong_owner") {
    health = "stale_running"
    reason = `Campaign status is ${status}, but owner PID ${ownerPID} appears to belong to another process.`
    suggestedAction = "resume"
  } else if (ownerPID && !ownerAlive) {
    health = "stale_running"
    reason = `Campaign status is ${status}, but owner PID ${ownerPID} is not alive.`
    suggestedAction = "resume"
  } else if (ownerPID && ownerAlive) {
    const heartbeatStale = typeof heartbeatMs === "number" && nowMs - heartbeatMs > policy.staleOwnerMs
    const artifactStale = newest && nowMs - newest.mtimeMs > policy.noArtifactGrowthMs
    if (heartbeatStale && artifactStale) {
      health = "stuck_running"
      reason = `Owner PID ${ownerPID} is alive, but heartbeat and artifacts are stale.`
      suggestedAction = "takeover"
    } else if (typeof heartbeatMs === "number" && nowMs - heartbeatMs > policy.longRunningMs) {
      health = "long_running"
      reason = `Owner PID ${ownerPID} is alive; run is long, but not proven stuck.`
      suggestedAction = "watch"
    } else {
      health = "healthy_running"
      reason = `Owner PID ${ownerPID} is alive.`
      suggestedAction = "watch"
    }
  } else {
    const ageMs = typeof heartbeatMs === "number" ? nowMs - heartbeatMs : Number.POSITIVE_INFINITY
    if (status === "bootstrapping" && ageMs <= policy.bootstrapNoOwnerGraceMs) {
      health = "starting"
      reason = "Campaign is bootstrapping without owner PID within the short startup grace."
      suggestedAction = "watch"
    } else {
      health = "stale_running"
      reason = `Campaign status is ${status}, but no owner PID is recorded.`
      suggestedAction = "resume"
    }
  }

  return {
    campaignID,
    campaignDir,
    taskID,
    status,
    health,
    currentRound: typeof state.currentRound === "number" ? state.currentRound : undefined,
    maxRounds: typeof state.maxRounds === "number" ? state.maxRounds : undefined,
    ownerPID,
    ownerCreationTick,
    ownerAlive,
    heartbeatAt: typeof state.heartbeatAt === "string" ? state.heartbeatAt : undefined,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : undefined,
    lastArtifactAt: newest ? new Date(newest.mtimeMs).toISOString() : undefined,
    lastArtifactPath: newest?.path,
    ageSeconds,
    artifactAgeSeconds,
    reason,
    suggestedAction,
  }
}

export async function scanCampaignHealth(campaignRoot: string) {
  const nowMs = Date.now()
  if (!existsSync(campaignRoot)) return []
  const entries = await readdir(campaignRoot, { withFileTypes: true })
  const rows: CampaignHealth[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const row = await readCampaignHealth(path.join(campaignRoot, entry.name), nowMs)
    if (row) rows.push(row)
  }
  return rows.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
}

function formatAge(seconds?: number) {
  if (typeof seconds !== "number") return ""
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 120) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

export async function writeRunDashboard(input: {
  campaignRoot: string
  dashboardRoot: string
  label?: string
  phase?: string
  trainVerified?: number
  trainTotal?: number
  includeSmoke?: boolean
}) {
  const campaigns = (await scanCampaignHealth(input.campaignRoot)).filter((row) => {
    if (input.includeSmoke || process.env.AUTO_EVOLVE_DASHBOARD_INCLUDE_SMOKE === "1") return true
    return !row.campaignID.toLowerCase().includes("smoke")
  })
  const counts: Record<string, number> = {}
  for (const row of campaigns) counts[row.health] = (counts[row.health] ?? 0) + 1
  const summary: DashboardSummary = {
    updatedAt: new Date().toISOString(),
    campaigns,
    counts,
  }
  await mkdir(input.dashboardRoot, { recursive: true })
  await writeJsonAtomic(path.join(input.dashboardRoot, "active-runs.json"), summary, {
    attempts: 8,
    baseDelayMs: 80,
    maxDelayMs: 2000,
  })

  const active = campaigns.filter((row) => row.health !== "completed" && row.health !== "idle")
  const lines = [
    "# Auto-Evolve Active Runs",
    "",
    `- updatedAt: \`${summary.updatedAt}\``,
    input.label ? `- label: \`${input.label}\`` : undefined,
    input.phase ? `- phase: \`${input.phase}\`` : undefined,
    typeof input.trainVerified === "number" && typeof input.trainTotal === "number"
      ? `- train: **${input.trainVerified}/${input.trainTotal} verified**`
      : undefined,
    "",
    "## Health Counts",
    ...Object.entries(counts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `- ${key}: **${value}**`),
    "",
    "## Active Tasks",
    "",
    "| task | status | health | round | owner | heartbeat age | artifact age | action |",
    "|---|---|---|---:|---:|---:|---:|---|",
    ...(active.length
      ? active.map((row) =>
          [
            row.taskID ?? row.campaignID,
            row.status,
            row.health,
            `${row.currentRound ?? ""}/${row.maxRounds ?? ""}`,
            row.ownerPID ? `${row.ownerPID}${row.ownerAlive ? "" : " (dead)"}` : "",
            formatAge(row.ageSeconds),
            formatAge(row.artifactAgeSeconds),
            row.suggestedAction,
          ]
            .map((item) => String(item).replace(/\|/g, "\\|"))
            .join(" | "),
        ).map((line) => `| ${line} |`)
      : ["| _none_ |  |  |  |  |  |  |  |"]),
    "",
    "## Problems",
    ...campaigns
      .filter((row) => row.suggestedAction === "resume" || row.suggestedAction === "takeover" || row.health === "stuck_running")
      .map((row) => `- ${row.taskID ?? row.campaignID}: ${row.reason}`),
    "",
  ].filter((line): line is string => typeof line === "string")

  await writeFileAtomic(path.join(input.dashboardRoot, "active-runs.md"), `${lines.join("\n")}\n`, {
    attempts: 8,
    baseDelayMs: 80,
    maxDelayMs: 2000,
  })
  return summary
}
