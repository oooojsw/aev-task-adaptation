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
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  // 显式错误配置必须报错，不能悄悄退回另一套超时。
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid runtime deadline: ${name}`)
  return value
}

export function resolveRuntimeBudget(input?: OpencodeRuntimeBudget, inheritEnvironment = true): Required<OpencodeRuntimeBudget> {
  const raw = inheritEnvironment ? process.env.AUTO_EVOLVE_OPENCODE_RUNTIME_PROFILE : undefined
  const profile =
    input?.profile ?? (raw && Object.hasOwn(profiles, raw) ? (raw as OpencodeRuntimeBudgetProfile) : "long")
  const base = profiles[profile]
  if (!base) throw new Error("Unknown runtime budget profile")
  const configured = (name: string, fallback: number) => inheritEnvironment ? env(name, fallback) : fallback
  const result = {
    profile,
    softDeadlineMs: input?.softDeadlineMs ?? configured("AUTO_EVOLVE_OPENCODE_SOFT_DEADLINE_MS", base[0] * 60000),
    hardTimeoutMs: input?.hardTimeoutMs ?? configured("AUTO_EVOLVE_OPENCODE_HARD_TIMEOUT_MS", base[1] * 60000),
    silentTimeoutMs: input?.silentTimeoutMs ?? configured("AUTO_EVOLVE_OPENCODE_SILENT_TIMEOUT_MS", base[2] * 60000),
    silentTimeoutAfterActivityMs:
      input?.silentTimeoutAfterActivityMs ??
      configured("AUTO_EVOLVE_OPENCODE_SILENT_TIMEOUT_AFTER_ACTIVITY_MS", base[3] * 60000),
  }
  const keys = ["softDeadlineMs", "hardTimeoutMs", "silentTimeoutMs", "silentTimeoutAfterActivityMs"] as const
  for (const key of keys) {
    if (!Number.isSafeInteger(result[key]) || result[key] <= 0 || result[key] > 43_200_000) throw new Error("Finite positive runtime budget required (maximum12h)")
  }
  const scale = Math.min(1, result.hardTimeoutMs / (base[1] * 60000))
  for (const [index, key] of [[0, "softDeadlineMs"], [2, "silentTimeoutMs"], [3, "silentTimeoutAfterActivityMs"]] as const) {
    // 未声明的子期限按档位缩放，显式矛盾配置则拒绝。
    const variable = { softDeadlineMs: "AUTO_EVOLVE_OPENCODE_SOFT_DEADLINE_MS", silentTimeoutMs: "AUTO_EVOLVE_OPENCODE_SILENT_TIMEOUT_MS", silentTimeoutAfterActivityMs: "AUTO_EVOLVE_OPENCODE_SILENT_TIMEOUT_AFTER_ACTIVITY_MS" }[key]
    if (input?.[key] === undefined && (!inheritEnvironment || !process.env[variable])) result[key] = Math.max(1, Math.floor(base[index] * 60000 * scale))
    if (result[key] > result.hardTimeoutMs) throw new Error("Runtime sub-deadline exceeds hard timeout")
  }
  return result
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
  return { ...budget, hardTimeoutMs: remaining, softDeadlineMs: Math.min(remaining, Math.max(1, soft)),
    silentTimeoutMs: Math.min(remaining, budget.silentTimeoutMs),
    silentTimeoutAfterActivityMs: Math.min(remaining, budget.silentTimeoutAfterActivityMs) }
}

export async function activeCallbacks(signal: AbortSignal | undefined, callbacks: Array<() => Promise<void> | void>) {
  // race不取消Promise；跨期限回来的回调不得继续平台写入。
  for (const callback of callbacks) {
    if (signal?.aborted) return
    await callback()
  }
}

export function convergenceWindows(softDeadlineMs: number) {
  // 收尾窗口随会话缩放，短任务不能从启动即进入收尾。
  if (!Number.isSafeInteger(softDeadlineMs) || softDeadlineMs < 1) throw new Error("Positive soft deadline required")
  return { converge: Math.min(900000, softDeadlineMs / 3), prepare: Math.min(300000, softDeadlineMs / 6),
    finish: Math.min(120000, softDeadlineMs / 12) }
}
