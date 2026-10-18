export type OpencodeRuntimeBudgetProfile = "short" | "medium" | "long" | "unbounded-with-watchdog"

export type OpencodeRuntimeBudget = {
  profile?: OpencodeRuntimeBudgetProfile
  softDeadlineMs?: number
  hardTimeoutMs?: number
  silentTimeoutMs?: number
  silentTimeoutAfterActivityMs?: number
}

const profiles: Record<OpencodeRuntimeBudgetProfile, number[]> = {
  short: [30, 60, 15, 60],
  medium: [90, 120, 20, 75],
  long: [120, 180, 30, 90],
  "unbounded-with-watchdog": [120, 720, 30, 120],
}

function env(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function resolveRuntimeBudget(input?: OpencodeRuntimeBudget): Required<OpencodeRuntimeBudget> {
  const raw = process.env.AUTO_EVOLVE_OPENCODE_RUNTIME_PROFILE
  const profile =
    input?.profile ?? (raw && Object.hasOwn(profiles, raw) ? (raw as OpencodeRuntimeBudgetProfile) : "long")
  const base = profiles[profile]
  if (!base) throw new Error("Unknown runtime budget profile")
  return {
    profile,
    softDeadlineMs: input?.softDeadlineMs ?? env("AUTO_EVOLVE_OPENCODE_SOFT_DEADLINE_MS", base[0] * 60000),
    hardTimeoutMs: input?.hardTimeoutMs ?? env("AUTO_EVOLVE_OPENCODE_HARD_TIMEOUT_MS", base[1] * 60000),
    silentTimeoutMs: input?.silentTimeoutMs ?? env("AUTO_EVOLVE_OPENCODE_SILENT_TIMEOUT_MS", base[2] * 60000),
    silentTimeoutAfterActivityMs:
      input?.silentTimeoutAfterActivityMs ??
      env("AUTO_EVOLVE_OPENCODE_SILENT_TIMEOUT_AFTER_ACTIVITY_MS", base[3] * 60000),
  }
}

export function readerDeadline(input?: OpencodeRuntimeBudget, now = Date.now()) {
  const timeout = resolveRuntimeBudget(input).hardTimeoutMs
  // 授权沿用角色硬期限，排队也不自动续期或延长旧游标。
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || !Number.isSafeInteger(now + timeout)) {
    throw new Error("Finite positive reader runtime deadline required")
  }
  return now + timeout
}

export function readerTimeout(timeout: number, expiry?: number, now = Date.now()) {
  if (expiry === undefined) return timeout
  if (!Number.isSafeInteger(expiry) || expiry <= now) throw new Error("Reader session expired before execution")
  return Math.min(timeout, expiry - now)
}

export function readerRuntimeBudget(input: OpencodeRuntimeBudget | undefined, expiry?: number, now = Date.now()) {
  const budget = resolveRuntimeBudget(input)
  if (expiry === undefined) return budget
  const remaining = readerTimeout(budget.hardTimeoutMs, expiry, now)
  // 提示中的软收尾期限也扣除授权后的排队时间。
  const soft = expiry - budget.hardTimeoutMs + budget.softDeadlineMs - now
  return { ...budget, hardTimeoutMs: remaining, softDeadlineMs: Math.min(remaining, Math.max(1, soft)) }
}

export async function activeCallbacks(signal: AbortSignal | undefined, callbacks: Array<() => Promise<void> | void>) {
  // race不取消Promise；跨期限回来的回调不得继续平台写入。
  for (const callback of callbacks) {
    if (signal?.aborted) return
    await callback()
  }
}
