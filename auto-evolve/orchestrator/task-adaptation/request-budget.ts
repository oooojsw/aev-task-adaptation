import path from "node:path"
import { mkdir, readFile, realpath, open, lstat } from "node:fs/promises"
import { withFileLock } from "../jsonl"
import { writeJsonAtomic } from "../atomic-write"
import { canonical, fingerprint } from "../protocol-plugins/identity"

export interface RequestBudget {
  root: string
  scope: string
  calls: number
  tokens: number
}

interface Attempt {
  id: string
  request: string
  model: string
  role: string
  reservationTokens: number
  status: "reserved" | "settled" | "unknown" | "overrun"
  usedTokens?: number
}

interface State {
  schema: "aev.request-budget.v1"
  binding: string
  attempts: Attempt[]
  lastDenial?: {
    reason: "calls" | "tokens" | "unresolved"
    request: string
    role: string
    model: string
    reservationTokens: number
    atState: string
  }
}

const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0

async function location(config: RequestBudget) {
  if (!config || !path.isAbsolute(config.root) || typeof config.scope !== "string" || !config.scope.trim() ||
      !positive(config.calls) || !positive(config.tokens)) throw new Error("Explicit finite request budget required")
  await mkdir(config.root, { recursive: true })
  const root = await realpath(config.root)
  if (root.toLowerCase() !== path.resolve(config.root).toLowerCase()) throw new Error("Linked request budget root rejected")
  return { root, file: path.join(root, "budget.json"), binding: fingerprint(config) }
}

async function transaction<T>(config: RequestBudget, apply: (state: State) => Promise<T> | T) {
  const { file, binding } = await location(config)
  return withFileLock(`${file}.lock`, async () => {
    let state: State
    let fresh = false
    try { state = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      fresh = true
      state = { schema: "aev.request-budget.v1", binding, attempts: [] }
    }
    if (state.schema !== "aev.request-budget.v1" || state.binding !== binding || !Array.isArray(state.attempts) ||
        new Set(state.attempts.map(item => item.id)).size !== state.attempts.length || state.attempts.some(item =>
          !item || typeof item.id !== "string" || !item.id || !/^[a-f0-9]{64}$/.test(item.request) ||
          typeof item.model !== "string" || !item.model.trim() || typeof item.role !== "string" || !item.role.trim() ||
          !positive(item.reservationTokens) || !["reserved", "settled", "unknown", "overrun"].includes(item.status) ||
          (item.status === "settled" || item.status === "overrun") &&
            (!Number.isSafeInteger(item.usedTokens) || Number(item.usedTokens) < 0 ||
              (item.status === "overrun") !== (Number(item.usedTokens) > item.reservationTokens)) ||
          (item.status === "reserved" || item.status === "unknown") && item.usedTokens !== undefined) ||
        state.lastDenial && (typeof state.lastDenial !== "object" || Array.isArray(state.lastDenial) || !["calls", "tokens", "unresolved"].includes(state.lastDenial.reason) ||
          !/^[a-f0-9]{64}$/.test(state.lastDenial.request) || !/^[a-f0-9]{64}$/.test(state.lastDenial.atState) ||
          ![state.lastDenial.role, state.lastDenial.model].every(value => typeof value === "string" && value.trim()) ||
          !positive(state.lastDenial.reservationTokens))) throw new Error("Request budget evidence or limits drift")
    const claim = `${file}.started.claim`
    try {
      const info = await lstat(claim)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (await readFile(claim, "utf8")) !== binding) {
        throw new Error("Request budget initialization claim drift")
      }
      if (fresh) throw new Error("Request budget state missing after initialization; inspect before recovery")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      // 永久认领防止账本丢失后被当成零消耗；旧完整账本只补认领。
      const handle = await open(claim, "wx")
      try { await handle.writeFile(binding, "utf8") } finally { await handle.close() }
    }
    if (fresh) await writeJsonAtomic(file, state)
    const before = canonical(state)
    const result = await apply(state)
    if (canonical(state) !== before) await writeJsonAtomic(file, state)
    return result
  }, { staleMs: 600000, timeoutMs: 60000 })
}

export function budgetTotals(attempts: ReadonlyArray<Attempt>) {
  const settled = attempts.filter(item => item.status === "settled" || item.status === "overrun")
  return { admittedAttempts: attempts.length,
    reportedTokens: settled.reduce((sum, item) => sum + item.usedTokens!, 0),
    outstandingTokens: attempts.filter(item => item.status === "reserved" || item.status === "unknown")
      .reduce((sum, item) => sum + item.reservationTokens, 0),
    unresolvedAttempts: attempts.filter(item => item.status === "reserved" || item.status === "unknown").length,
    unknownAttempts: attempts.filter(item => item.status === "unknown").length,
    overrunAttempts: attempts.filter(item => item.status === "overrun").length }
}

export async function reserveRequest(config: RequestBudget, attempt: Omit<Attempt, "status" | "usedTokens">) {
  if (!attempt || ![attempt.id, attempt.model, attempt.role].every(value => typeof value === "string" && value.trim()) ||
      !/^[a-f0-9]{64}$/.test(attempt.request) || !positive(attempt.reservationTokens)) throw new Error("Explicit request token ceiling required")
  const result = await transaction(config, state => {
    if (state.attempts.some(item => item.id === attempt.id)) throw new Error("Prior request reservation exists; inspect before retry")
    const totals = budgetTotals(state.attempts)
    // 未知计费不释放预留，不能以失败或重试偷偷扩大预算。
    const reason = totals.unknownAttempts || totals.overrunAttempts ? "unresolved" as const
      : totals.admittedAttempts >= config.calls ? "calls" as const
      : totals.reportedTokens + totals.outstandingTokens + attempt.reservationTokens > config.tokens ? "tokens" as const : undefined
    if (reason) {
      // 拒绝也原子留证；无发送不增调用，后续停止不靠解析异常文本。
      state.lastDenial = { reason, request: attempt.request, role: attempt.role, model: attempt.model,
        reservationTokens: attempt.reservationTokens, atState: fingerprint(state.attempts) }
      return { totals, reason }
    }
    delete state.lastDenial
    state.attempts.push({ id: attempt.id, request: attempt.request, model: attempt.model, role: attempt.role,
      reservationTokens: attempt.reservationTokens, status: "reserved" })
    return { totals: budgetTotals(state.attempts), reason: undefined }
  })
  if (result.reason) throw new Error(result.reason === "unresolved" ? "Request budget needs unresolved usage inspection" : "Request budget exhausted")
  return result.totals
}

export async function settleRequest(config: RequestBudget, id: string, tokens: number | undefined) {
  if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < 0)) throw new Error("Invalid reported request token count")
  return transaction(config, state => {
    const attempt = state.attempts.find(item => item.id === id)
    if (!attempt) throw new Error("Request settlement without reservation")
    const status = tokens === undefined ? "unknown" : tokens > attempt.reservationTokens ? "overrun" : "settled"
    if (attempt.status !== "reserved") {
      if (attempt.status === status && attempt.usedTokens === tokens) return budgetTotals(state.attempts)
      throw new Error("Conflicting request usage settlement")
    }
    attempt.status = status
    if (tokens !== undefined) attempt.usedTokens = tokens
    return budgetTotals(state.attempts)
  })
}

export async function inspectBudget(config: RequestBudget) {
  return transaction(config, state => ({ ...budgetTotals(state.attempts), scope: config.scope,
    limits: { calls: config.calls, tokens: config.tokens },
    ...(state.lastDenial && state.lastDenial.atState === fingerprint(state.attempts) ? { denial: structuredClone(state.lastDenial) } : {}) }))
}
