import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { loadConfig } from "../orchestrator/schema"
import { autoEvolvePath, ensureDirectory, pathExists, readJsonFile, writeJsonFile } from "../orchestrator/fs"
import { runOpencodeTask } from "../orchestrator/opencode"
import { OpenCodeGate } from "../orchestrator/opencode-gate"
import { extractJsonObject } from "../orchestrator/long-task/json-extract"

type FailureClass =
  | "rate_limit"
  | "provider_busy"
  | "timeout"
  | "auth_error"
  | "model_unavailable"
  | "invalid_response"
  | "unknown"

interface ProbeProfile {
  initialTaskConcurrency: number
  initialOpenCodeConcurrency: number
  minTaskConcurrency: number
  maxTaskConcurrency: number
  minOpenCodeConcurrency: number
  maxOpenCodeConcurrency: number
  initialRequestSpacingMs: number
  minRequestSpacingMs: number
  maxRequestSpacingMs: number
  successesToIncrease: number
  additiveIncrease: number
  rateLimitDecreaseFactor: number
  timeoutDecrease: number
  cooldownAfterRateLimitMs: number
  cooldownAfterProviderBusyMs: number
  cooldownAfterTimeoutMs: number
  maxProbeConcurrency: number
  probeRoundsPerLevel: number
  probeTimeoutMs: number
  reuseProbeResultTtlMs: number
}

interface ProbeResultItem {
  model: string
  concurrency: number
  round: number
  index: number
  passed: boolean
  durationMs: number
  failureClass?: FailureClass
  exitCode?: number
  responseText?: string
  message?: string
}

interface ProbeState {
  version: number
  models: Record<
    string,
    {
      profile: string
      currentTaskConcurrency: number
      currentOpenCodeConcurrency: number
      safeTaskConcurrency: number
      safeOpenCodeConcurrency: number
      safeRequestSpacingMs: number
      successStreak: number
      failureStreak: number
      lastFailureClass: FailureClass | null
      cooldownUntil: string | null
      lastProbeAt: string | null
      lastProbeStatus: "never" | "passed" | "partial_success" | "blocked" | "failed" | "dry_run"
      lastProbePath?: string
    }
  >
}

const BUILTIN_PROFILES: Record<string, ProbeProfile> = {
  "alibaba-low-concurrency": {
    initialTaskConcurrency: 1,
    initialOpenCodeConcurrency: 1,
    minTaskConcurrency: 1,
    maxTaskConcurrency: 2,
    minOpenCodeConcurrency: 1,
    maxOpenCodeConcurrency: 3,
    initialRequestSpacingMs: 20_000,
    minRequestSpacingMs: 10_000,
    maxRequestSpacingMs: 90_000,
    successesToIncrease: 3,
    additiveIncrease: 1,
    rateLimitDecreaseFactor: 0.5,
    timeoutDecrease: 1,
    cooldownAfterRateLimitMs: 15 * 60 * 1000,
    cooldownAfterProviderBusyMs: 5 * 60 * 1000,
    cooldownAfterTimeoutMs: 3 * 60 * 1000,
    maxProbeConcurrency: 3,
    probeRoundsPerLevel: 2,
    probeTimeoutMs: 120_000,
    reuseProbeResultTtlMs: 24 * 60 * 60 * 1000,
  },
  conservative: {
    initialTaskConcurrency: 1,
    initialOpenCodeConcurrency: 1,
    minTaskConcurrency: 1,
    maxTaskConcurrency: 2,
    minOpenCodeConcurrency: 1,
    maxOpenCodeConcurrency: 3,
    initialRequestSpacingMs: 15_000,
    minRequestSpacingMs: 5_000,
    maxRequestSpacingMs: 60_000,
    successesToIncrease: 3,
    additiveIncrease: 1,
    rateLimitDecreaseFactor: 0.5,
    timeoutDecrease: 1,
    cooldownAfterRateLimitMs: 10 * 60 * 1000,
    cooldownAfterProviderBusyMs: 5 * 60 * 1000,
    cooldownAfterTimeoutMs: 3 * 60 * 1000,
    maxProbeConcurrency: 3,
    probeRoundsPerLevel: 2,
    probeTimeoutMs: 120_000,
    reuseProbeResultTtlMs: 24 * 60 * 60 * 1000,
  },
}

function parseArgs(argv: string[]) {
  const result: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith("--")) continue
    const key = item.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith("--")) {
      result[key] = true
    } else {
      result[key] = next
      i += 1
    }
  }
  return result
}

function requireString(args: Record<string, string | boolean>, key: string) {
  const value = args[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing required --${key}`)
  return value.trim()
}

function positiveInt(value: unknown, fallback: number) {
  if (typeof value !== "string") return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function slug(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "model"
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeProfile(raw: unknown, fallback: ProbeProfile): ProbeProfile {
  if (!raw || typeof raw !== "object") return fallback
  const input = raw as Record<string, unknown>
  const numberField = (key: keyof ProbeProfile) => {
    const value = input[key]
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback[key]
  }
  return {
    initialTaskConcurrency: numberField("initialTaskConcurrency"),
    initialOpenCodeConcurrency: numberField("initialOpenCodeConcurrency"),
    minTaskConcurrency: numberField("minTaskConcurrency"),
    maxTaskConcurrency: numberField("maxTaskConcurrency"),
    minOpenCodeConcurrency: numberField("minOpenCodeConcurrency"),
    maxOpenCodeConcurrency: numberField("maxOpenCodeConcurrency"),
    initialRequestSpacingMs: numberField("initialRequestSpacingMs"),
    minRequestSpacingMs: numberField("minRequestSpacingMs"),
    maxRequestSpacingMs: numberField("maxRequestSpacingMs"),
    successesToIncrease: numberField("successesToIncrease"),
    additiveIncrease: numberField("additiveIncrease"),
    rateLimitDecreaseFactor: numberField("rateLimitDecreaseFactor"),
    timeoutDecrease: numberField("timeoutDecrease"),
    cooldownAfterRateLimitMs: numberField("cooldownAfterRateLimitMs"),
    cooldownAfterProviderBusyMs: numberField("cooldownAfterProviderBusyMs"),
    cooldownAfterTimeoutMs: numberField("cooldownAfterTimeoutMs"),
    maxProbeConcurrency: numberField("maxProbeConcurrency"),
    probeRoundsPerLevel: numberField("probeRoundsPerLevel"),
    probeTimeoutMs: numberField("probeTimeoutMs"),
    reuseProbeResultTtlMs: numberField("reuseProbeResultTtlMs"),
  }
}

async function readAdaptiveSettings(repoRoot: string, model: string, explicitProfile?: string) {
  const configPath = autoEvolvePath(repoRoot, "config.json")
  let raw: any = {}
  if (await pathExists(configPath)) {
    raw = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, ""))
  }
  const profileName =
    explicitProfile ||
    raw?.adaptiveConcurrency?.modelBindings?.[model] ||
    raw?.adaptiveConcurrency?.defaultProfile ||
    "conservative"
  const fallback = BUILTIN_PROFILES[profileName] ?? BUILTIN_PROFILES.conservative
  const profile = raw?.adaptiveConcurrency?.profiles?.[profileName]
  return { profileName, profile: normalizeProfile(profile, fallback) }
}

function classifyFailure(text: string): FailureClass {
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
  ) {
    return "provider_busy"
  }
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("silent output timeout") ||
    lower.includes("hard process timeout")
  ) {
    return "timeout"
  }
  if (
    /\b40[13]\b/.test(lower) ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("invalid api key") ||
    lower.includes("invalid token")
  ) {
    return "auth_error"
  }
  if (lower.includes("model not found") || lower.includes("invalid model") || lower.includes("model unavailable")) {
    return "model_unavailable"
  }
  return "unknown"
}

function computeSafeTaskConcurrency(safeOpenCodeConcurrency: number, profile: ProbeProfile) {
  if (safeOpenCodeConcurrency <= 0) return 0
  if (safeOpenCodeConcurrency <= 2) return profile.minTaskConcurrency
  return clamp(Math.floor(safeOpenCodeConcurrency / 1.5), profile.minTaskConcurrency, profile.maxTaskConcurrency)
}

function nextSpacing(profile: ProbeProfile, failureClass?: FailureClass) {
  if (failureClass === "rate_limit") {
    return clamp(profile.initialRequestSpacingMs * 2, profile.minRequestSpacingMs, profile.maxRequestSpacingMs)
  }
  if (failureClass === "provider_busy" || failureClass === "timeout") {
    return clamp(profile.initialRequestSpacingMs + 10_000, profile.minRequestSpacingMs, profile.maxRequestSpacingMs)
  }
  return clamp(profile.initialRequestSpacingMs, profile.minRequestSpacingMs, profile.maxRequestSpacingMs)
}

function cooldownUntil(profile: ProbeProfile, failureClass?: FailureClass) {
  const now = Date.now()
  if (failureClass === "rate_limit") return new Date(now + profile.cooldownAfterRateLimitMs).toISOString()
  if (failureClass === "provider_busy") return new Date(now + profile.cooldownAfterProviderBusyMs).toISOString()
  if (failureClass === "timeout") return new Date(now + profile.cooldownAfterTimeoutMs).toISOString()
  return null
}

async function runSmoke(input: {
  repoRoot: string
  config: Awaited<ReturnType<typeof loadConfig>>
  model: string
  concurrency: number
  round: number
  index: number
  timeoutMs: number
  dryRun: boolean
  dryRunFailAt?: number
  dryRunFailureClass?: FailureClass
}): Promise<ProbeResultItem> {
  const started = Date.now()
  if (input.dryRun) {
    await sleep(10)
    if (input.dryRunFailAt === input.concurrency && input.index === input.concurrency - 1) {
      return {
        model: input.model,
        concurrency: input.concurrency,
        round: input.round,
        index: input.index,
        passed: false,
        durationMs: Date.now() - started,
        exitCode: 1,
        failureClass: input.dryRunFailureClass ?? "rate_limit",
        message: "Synthetic dry-run failure for concurrency-controller testing.",
      }
    }
    return {
      model: input.model,
      concurrency: input.concurrency,
      round: input.round,
      index: input.index,
      passed: true,
      durationMs: Date.now() - started,
      exitCode: 0,
      responseText: '{"ok":true,"probe":"model-concurrency-smoke","dryRun":true}',
    }
  }
  const prompt = [
    "Return exactly this JSON and nothing else:",
    '{"ok":true,"probe":"model-concurrency-smoke"}',
  ].join("\n")
  try {
    const result = await runOpencodeTask({
      cwd: input.repoRoot,
      config: input.config,
      title: `Model Concurrency Smoke ${input.model} c${input.concurrency} r${input.round} i${input.index}`,
      prompt,
      model: input.model,
      runtimeBudget: {
        profile: "short",
        hardTimeoutMs: input.timeoutMs,
        silentTimeoutMs: Math.min(input.timeoutMs, 90_000),
        silentTimeoutAfterActivityMs: Math.min(input.timeoutMs, 90_000),
      },
      runtimeScope: `model-probe:${slug(input.model)}`,
      concurrencyScope: `model:${slug(input.model)}`,
      permissionReadPaths: [input.repoRoot],
      permissionEditPaths: [],
      isolateHostRuntime: true,
      injectPlatformSafetyRules: false,
      recordAdaptiveConcurrency: false,
    })
    const combined = [result.result.stderr, result.result.stdout, result.result.responseText].join("\n")
    if (result.result.exitCode !== 0) {
      const failureClass = classifyFailure(combined)
      return {
        model: input.model,
        concurrency: input.concurrency,
        round: input.round,
        index: input.index,
        passed: false,
        durationMs: Date.now() - started,
        exitCode: result.result.exitCode,
        failureClass,
        message: combined.slice(0, 2000),
      }
    }
    const parsed = extractJsonObject(result.result.responseText) ?? extractJsonObject(combined)
    if (!parsed || parsed.ok !== true) {
      return {
        model: input.model,
        concurrency: input.concurrency,
        round: input.round,
        index: input.index,
        passed: false,
        durationMs: Date.now() - started,
        exitCode: result.result.exitCode,
        failureClass: "invalid_response",
        responseText: result.result.responseText,
        message: `Smoke response did not contain {"ok":true}.`,
      }
    }
    return {
      model: input.model,
      concurrency: input.concurrency,
      round: input.round,
      index: input.index,
      passed: true,
      durationMs: Date.now() - started,
      exitCode: result.result.exitCode,
      responseText: result.result.responseText,
    }
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    return {
      model: input.model,
      concurrency: input.concurrency,
      round: input.round,
      index: input.index,
      passed: false,
      durationMs: Date.now() - started,
      failureClass: classifyFailure(message),
      message: message.slice(0, 2000),
    }
  }
}

function summarizeFailure(items: ProbeResultItem[]) {
  const failed = items.find((item) => !item.passed)
  return failed?.failureClass
}

function statusFromResult(input: { dryRun: boolean; failedClass?: FailureClass; safeOpenCode: number; max: number }) {
  if (input.dryRun) return "dry_run" as const
  if (input.failedClass === "auth_error" || input.failedClass === "model_unavailable") return "blocked" as const
  if (input.failedClass && input.safeOpenCode <= 0) return "failed" as const
  if (input.failedClass) return "partial_success" as const
  if (input.safeOpenCode >= input.max) return "passed" as const
  return "partial_success" as const
}

async function loadState(statePath: string): Promise<ProbeState> {
  if (await pathExists(statePath)) return await readJsonFile<ProbeState>(statePath)
  return { version: 1, models: {} }
}

function renderReport(input: {
  model: string
  profileName: string
  startedAt: string
  finishedAt: string
  results: ProbeResultItem[]
  safeOpenCodeConcurrency: number
  safeTaskConcurrency: number
  safeRequestSpacingMs: number
  failureClass?: FailureClass
  cooldownUntil: string | null
  dryRun: boolean
}) {
  const rows = input.results
    .map((item) =>
      [
        item.concurrency,
        item.round,
        item.index,
        item.passed ? "PASS" : "FAIL",
        item.failureClass ?? "-",
        item.durationMs,
        item.exitCode ?? "-",
      ].join(" | "),
    )
    .join("\n")
  return [
    "# Model Concurrency Probe",
    "",
    `Model: ${input.model}`,
    `Profile: ${input.profileName}`,
    `Started: ${input.startedAt}`,
    `Finished: ${input.finishedAt}`,
    `Dry run: ${input.dryRun ? "yes" : "no"}`,
    "",
    "## Results",
    "",
    "| concurrency | round | index | status | failure_class | duration_ms | exit_code |",
    "|---:|---:|---:|---|---|---:|---:|",
    rows ? rows.split("\n").map((line) => `| ${line} |`).join("\n") : "| - | - | - | - | - | - | - |",
    "",
    "## Recommendation",
    "",
    `safeOpenCodeConcurrency: ${input.safeOpenCodeConcurrency}`,
    `safeTaskConcurrency: ${input.safeTaskConcurrency}`,
    `safeRequestSpacingMs: ${input.safeRequestSpacingMs}`,
    `failureClass: ${input.failureClass ?? "-"}`,
    `cooldownUntil: ${input.cooldownUntil ?? "-"}`,
    "",
  ].join("\n")
}

async function main() {
  const repoRoot = path.resolve(import.meta.dir, "..", "..")
  const args = parseArgs(process.argv.slice(2))
  const model = requireString(args, "model")
  const explicitProfile = typeof args.profile === "string" ? args.profile.trim() : undefined
  const { profileName, profile } = await readAdaptiveSettings(repoRoot, model, explicitProfile)
  const min = positiveInt(args.min, profile.minOpenCodeConcurrency)
  const max = positiveInt(args.max, profile.maxProbeConcurrency)
  const rounds = positiveInt(args.rounds, profile.probeRoundsPerLevel)
  const timeoutMs = positiveInt(args["timeout-ms"], profile.probeTimeoutMs)
  const spacingMs = positiveInt(args["spacing-ms"], profile.initialRequestSpacingMs)
  const dryRun = Boolean(args["dry-run"])
  const dryRunFailAt = typeof args["dry-run-fail-at"] === "string" ? positiveInt(args["dry-run-fail-at"], -1) : undefined
  const dryRunFailureClass =
    typeof args["dry-run-failure-class"] === "string"
      ? (args["dry-run-failure-class"] as FailureClass)
      : undefined

  const effectiveMin = clamp(min, profile.minOpenCodeConcurrency, profile.maxOpenCodeConcurrency)
  const effectiveMax = clamp(max, effectiveMin, profile.maxOpenCodeConcurrency)
  const startedAt = new Date().toISOString()
  const config = await loadConfig(repoRoot)
  const gateConfig = OpenCodeGate.instance().getStatus().config
  OpenCodeGate.configure({
    modelLimits: {
      ...(gateConfig.modelLimits ?? {}),
      [model.trim().toLowerCase()]: { maxConcurrent: effectiveMax, minSpawnIntervalMs: 0 },
    },
  })
  const outRoot = autoEvolvePath(repoRoot, "runtime-state", "model-concurrency")
  const probesRoot = path.join(outRoot, "probes")
  await mkdir(probesRoot, { recursive: true })

  const results: ProbeResultItem[] = []
  let safeOpenCodeConcurrency = Math.max(0, effectiveMin - 1)
  let failureClass: FailureClass | undefined

  for (let concurrency = effectiveMin; concurrency <= effectiveMax; concurrency += 1) {
    let levelFailed = false
    for (let round = 1; round <= rounds; round += 1) {
      const batch = await Promise.all(
        Array.from({ length: concurrency }, (_, index) =>
          runSmoke({
            repoRoot,
            config,
            model,
            concurrency,
            round,
            index,
            timeoutMs,
            dryRun,
            dryRunFailAt,
            dryRunFailureClass,
          }),
        ),
      )
      results.push(...batch)
      const failed = summarizeFailure(batch)
      if (failed) {
        failureClass = failed
        levelFailed = true
        break
      }
      if (round < rounds && spacingMs > 0) await sleep(spacingMs)
    }
    if (levelFailed) break
    safeOpenCodeConcurrency = concurrency
    if (concurrency < effectiveMax && spacingMs > 0) await sleep(spacingMs)
  }

  const safeTaskConcurrency = computeSafeTaskConcurrency(safeOpenCodeConcurrency, profile)
  const safeRequestSpacingMs = nextSpacing(profile, failureClass)
  const cooldown = cooldownUntil(profile, failureClass)
  const finishedAt = new Date().toISOString()
  const probeID = `${finishedAt.replace(/[:.]/g, "-")}-${slug(model)}`
  const probePath = path.join(probesRoot, `${probeID}.json`)
  const reportPath = path.join(outRoot, "report.md")
  const statePath = path.join(outRoot, dryRun ? "state-dry-run.json" : "state.json")

  const state = await loadState(statePath)
  const status = statusFromResult({ dryRun, failedClass: failureClass, safeOpenCode: safeOpenCodeConcurrency, max: effectiveMax })
  const previous = state.models[model]
  const preservePreviousSafeLevel =
    !failureClass &&
    !dryRun &&
    previous &&
    previous.safeOpenCodeConcurrency > safeOpenCodeConcurrency &&
    effectiveMax < previous.safeOpenCodeConcurrency
  const stateSafeOpenCodeConcurrency = preservePreviousSafeLevel
    ? previous.safeOpenCodeConcurrency
    : safeOpenCodeConcurrency
  const stateSafeTaskConcurrency = preservePreviousSafeLevel
    ? previous.safeTaskConcurrency
    : safeTaskConcurrency
  const stateSafeRequestSpacingMs = preservePreviousSafeLevel
    ? previous.safeRequestSpacingMs
    : safeRequestSpacingMs
  state.models[model] = {
    profile: profileName,
    currentTaskConcurrency: stateSafeTaskConcurrency,
    currentOpenCodeConcurrency: stateSafeOpenCodeConcurrency,
    safeTaskConcurrency: stateSafeTaskConcurrency,
    safeOpenCodeConcurrency: stateSafeOpenCodeConcurrency,
    safeRequestSpacingMs: stateSafeRequestSpacingMs,
    successStreak: failureClass ? 0 : results.filter((item) => item.passed).length,
    failureStreak: failureClass ? 1 : 0,
    lastFailureClass: failureClass ?? null,
    cooldownUntil: cooldown,
    lastProbeAt: finishedAt,
    lastProbeStatus: status,
    lastProbePath: probePath,
  }

  const probePayload = {
    version: 1,
    probeID,
    model,
    profileName,
    startedAt,
    finishedAt,
    dryRun,
    requested: { min, max, rounds, timeoutMs, spacingMs },
    effective: { min: effectiveMin, max: effectiveMax },
    recommendation: {
      safeOpenCodeConcurrency,
      safeTaskConcurrency,
      safeRequestSpacingMs,
      failureClass: failureClass ?? null,
      cooldownUntil: cooldown,
      status,
    },
    results,
  }
  await writeJsonFile(probePath, probePayload)
  await writeJsonFile(statePath, state)
  await ensureDirectory(path.dirname(reportPath))
  await writeFile(
    reportPath,
    renderReport({
      model,
      profileName,
      startedAt,
      finishedAt,
      results,
      safeOpenCodeConcurrency,
      safeTaskConcurrency,
      safeRequestSpacingMs,
      failureClass,
      cooldownUntil: cooldown,
      dryRun,
    }),
    "utf8",
  )

  console.log(
    JSON.stringify(
      {
        model,
        profile: profileName,
        dryRun,
        probePath,
        statePath,
        reportPath,
        recommendation: probePayload.recommendation,
      },
      null,
      2,
    ),
  )
}

await main()
