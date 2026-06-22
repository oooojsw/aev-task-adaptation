import path from "node:path"
import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { autoEvolvePath, ensureDirectory, pathExists, readJsonFile, writeJsonFile } from "./fs"

export type AdaptiveFailureClass =
  | "rate_limit"
  | "provider_busy"
  | "timeout"
  | "auth_error"
  | "model_unavailable"
  | "unknown"

export interface AdaptiveModelRuntime {
  safeTaskConcurrency: number
  safeOpenCodeConcurrency: number
  safeRequestSpacingMs: number
  cooldownUntil: string | null
  lastFailureClass: AdaptiveFailureClass | null
  lastProbeStatus?: string
}

type Profile = {
  minTaskConcurrency: number
  maxTaskConcurrency: number
  minOpenCodeConcurrency: number
  maxOpenCodeConcurrency: number
  minRequestSpacingMs: number
  maxRequestSpacingMs: number
  initialRequestSpacingMs: number
  successesToIncrease: number
  additiveIncrease: number
  rateLimitDecreaseFactor: number
  timeoutDecrease: number
  cooldownAfterRateLimitMs: number
  cooldownAfterProviderBusyMs: number
  cooldownAfterTimeoutMs: number
  onlineAdjust: boolean
}

const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 50

function numberValue(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function profileFrom(raw: any): Profile {
  return {
    minTaskConcurrency: numberValue(raw?.minTaskConcurrency, 1),
    maxTaskConcurrency: numberValue(raw?.maxTaskConcurrency, 2),
    minOpenCodeConcurrency: numberValue(raw?.minOpenCodeConcurrency, 1),
    maxOpenCodeConcurrency: numberValue(raw?.maxOpenCodeConcurrency, 3),
    minRequestSpacingMs: numberValue(raw?.minRequestSpacingMs, 10_000),
    maxRequestSpacingMs: numberValue(raw?.maxRequestSpacingMs, 90_000),
    initialRequestSpacingMs: numberValue(raw?.initialRequestSpacingMs, 20_000),
    successesToIncrease: numberValue(raw?.successesToIncrease, 3),
    additiveIncrease: numberValue(raw?.additiveIncrease, 1),
    rateLimitDecreaseFactor: numberValue(raw?.rateLimitDecreaseFactor, 0.5),
    timeoutDecrease: numberValue(raw?.timeoutDecrease, 1),
    cooldownAfterRateLimitMs: numberValue(raw?.cooldownAfterRateLimitMs, 15 * 60_000),
    cooldownAfterProviderBusyMs: numberValue(raw?.cooldownAfterProviderBusyMs, 5 * 60_000),
    cooldownAfterTimeoutMs: numberValue(raw?.cooldownAfterTimeoutMs, 3 * 60_000),
    onlineAdjust: raw?.onlineAdjust === true,
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function nowISO() {
  return new Date().toISOString()
}

function statePath(cwd: string) {
  const override = process.env.AUTO_EVOLVE_MODEL_CONCURRENCY_STATE_ROOT?.trim()
  const root = override ? path.resolve(override) : autoEvolvePath(cwd, "runtime-state", "model-concurrency")
  return path.join(root, "state.json")
}

function lockPath(cwd: string) {
  return path.join(path.dirname(statePath(cwd)), "state-lock")
}

async function acquireLock(cwd: string) {
  const target = lockPath(cwd)
  await ensureDirectory(path.dirname(target))
  while (true) {
    try {
      await mkdir(target)
      return async () => rm(target, { recursive: true, force: true })
    } catch {
      const info = await stat(target).catch(() => undefined)
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      await sleep(LOCK_WAIT_MS)
    }
  }
}

async function readRawConfig(cwd: string) {
  const target = autoEvolvePath(cwd, "config.json")
  if (!(await pathExists(target))) return {}
  return JSON.parse((await readFile(target, "utf8")).replace(/^\uFEFF/, "")) as Record<string, any>
}

async function resolveProfile(cwd: string, model: string) {
  const config = await readRawConfig(cwd)
  const adaptive = config.adaptiveConcurrency
  if (adaptive?.enabled !== true) return undefined
  const profileName = adaptive?.modelBindings?.[model] || adaptive?.defaultProfile
  const raw = profileName ? adaptive?.profiles?.[profileName] : undefined
  return { name: profileName || "conservative", profile: profileFrom(raw) }
}

export function classifyAdaptiveFailure(text: string): AdaptiveFailureClass {
  const lower = text.toLowerCase()
  if (/\b429\b/.test(lower) || lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("quota throttle")) {
    return "rate_limit"
  }
  if (
    /\b50[234]\b/.test(lower) ||
    lower.includes("provider busy") ||
    lower.includes("upstream busy") ||
    lower.includes("server overloaded") ||
    lower.includes("overloaded") ||
    lower.includes("service unavailable") ||
    lower.includes("bad gateway") ||
    lower.includes("gateway timeout")
  ) return "provider_busy"
  if (lower.includes("timed out") || lower.includes("timeout") || lower.includes("silent output timeout")) return "timeout"
  if (/\b40[13]\b/.test(lower) || lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("invalid token")) {
    return "auth_error"
  }
  if (lower.includes("model not found") || lower.includes("invalid model") || lower.includes("model unavailable")) {
    return "model_unavailable"
  }
  return "unknown"
}

export async function readAdaptiveModelRuntime(cwd: string, model: string): Promise<AdaptiveModelRuntime | undefined> {
  const target = statePath(cwd)
  if (!(await pathExists(target))) return undefined
  const state = await readJsonFile<Record<string, any>>(target).catch(() => undefined)
  const entry = state?.models?.[model]
  if (!entry || typeof entry !== "object") return undefined
  return {
    safeTaskConcurrency: Math.max(0, Math.floor(numberValue(entry.safeTaskConcurrency, 0))),
    safeOpenCodeConcurrency: Math.max(0, Math.floor(numberValue(entry.safeOpenCodeConcurrency, 0))),
    safeRequestSpacingMs: Math.max(0, Math.floor(numberValue(entry.safeRequestSpacingMs, 0))),
    cooldownUntil: typeof entry.cooldownUntil === "string" ? entry.cooldownUntil : null,
    lastFailureClass: typeof entry.lastFailureClass === "string" ? entry.lastFailureClass : null,
    lastProbeStatus: typeof entry.lastProbeStatus === "string" ? entry.lastProbeStatus : undefined,
  }
}

export async function recordAdaptiveModelOutcome(input: {
  cwd: string
  model: string
  exitCode: number
  text: string
  source: string
}) {
  const resolved = await resolveProfile(input.cwd, input.model)
  if (!resolved || !resolved.profile.onlineAdjust) return undefined
  const failureClass = input.exitCode === 0 ? undefined : classifyAdaptiveFailure(input.text)
  const congestionFailure = failureClass === "rate_limit" || failureClass === "provider_busy" || failureClass === "timeout"
  const blockingFailure = failureClass === "auth_error" || failureClass === "model_unavailable"
  const transportSuccess = input.exitCode === 0
  if (!transportSuccess && !congestionFailure && !blockingFailure) return undefined

  const release = await acquireLock(input.cwd)
  try {
    const target = statePath(input.cwd)
    const state = (await readJsonFile<Record<string, any>>(target).catch(() => ({ version: 1, models: {} }))) as Record<string, any>
    state.version = 1
    state.models ||= {}
    const current = state.models[input.model] || {}
    const profile = resolved.profile
    let openCode = Math.floor(nonNegativeNumber(current.safeOpenCodeConcurrency, profile.minOpenCodeConcurrency))
    let tasks = Math.floor(nonNegativeNumber(current.safeTaskConcurrency, profile.minTaskConcurrency))
    let spacing = Math.floor(numberValue(current.safeRequestSpacingMs, profile.initialRequestSpacingMs))
    let successStreak = Math.floor(numberValue(current.successStreak, 0))
    let failureStreak = Math.floor(numberValue(current.failureStreak, 0))
    let cooldownUntil: string | null = typeof current.cooldownUntil === "string" ? current.cooldownUntil : null

    if (transportSuccess) {
      successStreak += 1
      failureStreak = 0
      const cooldownExpired = !cooldownUntil || Date.parse(cooldownUntil) <= Date.now()
      if (cooldownExpired && successStreak >= profile.successesToIncrease) {
        openCode = clamp(openCode + profile.additiveIncrease, profile.minOpenCodeConcurrency, profile.maxOpenCodeConcurrency)
        if (openCode >= 3) tasks = clamp(tasks + 1, profile.minTaskConcurrency, profile.maxTaskConcurrency)
        spacing = clamp(spacing - 5_000, profile.minRequestSpacingMs, profile.maxRequestSpacingMs)
        successStreak = 0
        cooldownUntil = null
      }
    } else {
      successStreak = 0
      failureStreak += 1
      if (failureClass === "rate_limit") {
        openCode = Math.max(profile.minOpenCodeConcurrency, Math.floor(openCode * profile.rateLimitDecreaseFactor))
        tasks = Math.max(profile.minTaskConcurrency, Math.floor(tasks * profile.rateLimitDecreaseFactor))
        spacing = clamp(spacing * 2, profile.minRequestSpacingMs, profile.maxRequestSpacingMs)
        cooldownUntil = new Date(Date.now() + profile.cooldownAfterRateLimitMs).toISOString()
      } else if (failureClass === "provider_busy" || failureClass === "timeout") {
        openCode = Math.max(profile.minOpenCodeConcurrency, openCode - profile.timeoutDecrease)
        if (openCode <= 2) tasks = profile.minTaskConcurrency
        spacing = clamp(spacing + 10_000, profile.minRequestSpacingMs, profile.maxRequestSpacingMs)
        cooldownUntil = new Date(
          Date.now() +
            (failureClass === "provider_busy" ? profile.cooldownAfterProviderBusyMs : profile.cooldownAfterTimeoutMs),
        ).toISOString()
      } else if (blockingFailure) {
        openCode = 0
        tasks = 0
        cooldownUntil = null
      }
    }

    const activeCooldown = cooldownUntil && Date.parse(cooldownUntil) > Date.now()
    const lastFailureClass = failureClass ?? (activeCooldown ? current.lastFailureClass ?? null : null)
    const updated = {
      ...current,
      profile: resolved.name,
      currentTaskConcurrency: tasks,
      currentOpenCodeConcurrency: openCode,
      safeTaskConcurrency: tasks,
      safeOpenCodeConcurrency: openCode,
      safeRequestSpacingMs: spacing,
      successStreak,
      failureStreak,
      lastFailureClass,
      cooldownUntil,
      lastOnlineUpdateAt: nowISO(),
      lastOnlineUpdateSource: input.source,
    }
    state.models[input.model] = updated
    await writeJsonFile(target, state)
    await appendFile(
      path.join(path.dirname(target), "online-events.jsonl"),
      `${JSON.stringify({
        createdAt: nowISO(),
        model: input.model,
        source: input.source,
        exitCode: input.exitCode,
        failureClass: failureClass ?? null,
        safeTaskConcurrency: tasks,
        safeOpenCodeConcurrency: openCode,
        safeRequestSpacingMs: spacing,
        cooldownUntil,
      })}\n`,
      "utf8",
    )
    return updated as AdaptiveModelRuntime
  } finally {
    await release()
  }
}
