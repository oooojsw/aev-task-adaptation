import path from "node:path"
import { readFile, lstat } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { reserveRequest, settleRequest, type RequestBudget } from "./request-budget"
import { fingerprint } from "../protocol-plugins/identity"
import { writeJsonAtomic } from "../atomic-write"
import { parseRequestUsage, requestUsageTotal, type RequestUsage } from "./request-usage"

export interface BudgetTransportConfig {
  schema: "aev.budget-transport.v1"
  budget: RequestBudget
  role: string
  dialect: "openai_chat" | "openai_responses" | "anthropic_messages"
  expectedModels: string[]
  maxInputTokens: number
  maxOutputTokens: number
  gate?: string
}

const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0

export function validateRequestGate(value: unknown, bounded: boolean): string | undefined {
  if (value === undefined) return undefined
  if (!bounded || typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Request gate requires an explicit bounded transport")
  return value
}

export function validateBudgetTransport(value: unknown): BudgetTransportConfig {
  const cfg = value as BudgetTransportConfig
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) ||
      Object.keys(cfg).some(key => !["schema", "budget", "role", "dialect", "expectedModels", "maxInputTokens", "maxOutputTokens", "gate"].includes(key)) ||
      cfg.gate !== undefined && (typeof cfg.gate !== "string" || !/^[a-f0-9]{64}$/.test(cfg.gate)) ||
      cfg.schema !== "aev.budget-transport.v1" || typeof cfg.role !== "string" || !cfg.role.trim() ||
      !["openai_chat", "openai_responses", "anthropic_messages"].includes(cfg.dialect) ||
      !positive(cfg.maxInputTokens) || !positive(cfg.maxOutputTokens) ||
      !Array.isArray(cfg.expectedModels) || !cfg.expectedModels.length ||
      cfg.expectedModels.some(model => typeof model !== "string" || !model.trim()) || new Set(cfg.expectedModels).size !== cfg.expectedModels.length ||
      !cfg.budget || typeof cfg.budget !== "object" || !path.isAbsolute(cfg.budget.root) ||
      typeof cfg.budget.scope !== "string" || !cfg.budget.scope.trim() || !positive(cfg.budget.calls) || !positive(cfg.budget.tokens) ||
      Object.keys(cfg.budget).some(key => !["root", "scope", "calls", "tokens"].includes(key))) throw new Error("Invalid explicit provider request budget")
  return structuredClone(cfg)
}

export async function readBudgetTransport(file: string, expectedSHA256: string | undefined) {
  if (!path.isAbsolute(file) || !expectedSHA256 || !/^[a-f0-9]{64}$/.test(expectedSHA256)) throw new Error("Frozen provider budget file and hash required")
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Linked provider budget file rejected")
  const bytes = await readFile(file)
  if (bytes.length > 16384 || createHash("sha256").update(bytes).digest("hex") !== expectedSHA256) throw new Error("Provider budget configuration drift")
  return validateBudgetTransport(JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")))
}

export async function budgetTransportEnvironment(config: BudgetTransportConfig | undefined, dir: string) {
  if (!config) return { OPENCODE_AEV_REQUEST_BUDGET_FILE: undefined, OPENCODE_AEV_REQUEST_BUDGET_SHA256: undefined }
  const value = validateBudgetTransport(config)
  if (!path.isAbsolute(dir)) throw new Error("Absolute private budget configuration directory required")
  const file = path.join(dir, "request-budget.json")
  await writeJsonAtomic(file, value)
  const bytes = await readFile(file)
  return { OPENCODE_AEV_REQUEST_BUDGET_FILE: file.replaceAll("\\", "/"),
    OPENCODE_AEV_REQUEST_BUDGET_SHA256: createHash("sha256").update(bytes).digest("hex") }
}

function meter(dialect: BudgetTransportConfig["dialect"], streaming: boolean) {
  let reported: RequestUsage = { dialect }
  let terminal = false
  let invalid = false
  let pending = ""
  let data: string[] = []
  const decoder = new TextDecoder("utf-8", { fatal: true })
  function usage(value: unknown) {
    reported = { ...reported, ...parseRequestUsage(value, dialect) }
  }
  function value(text: string) {
    if (!text.trim()) return
    if (text.trim() === "[DONE]") { terminal = true; return }
    const item = JSON.parse(text)
    if (dialect === "anthropic_messages") {
      usage(item.type === "message_start" ? item.message?.usage : item.usage)
      if (item.type === "message_stop") terminal = true
      if (item.type === "error") invalid = true
    } else if (dialect === "openai_responses") {
      usage(item.response?.usage ?? item.usage)
      if (["response.completed", "response.incomplete", "response.failed"].includes(item.type)) terminal = true
      if (item.type === "error") invalid = true
    } else usage(item.usage)
    if (!streaming) terminal = true
  }
  function line(text: string) {
    if (!text) {
      if (data.length) value(data.join("\n"))
      data = []
    } else if (text.startsWith("data:")) data.push(text.slice(5).trimStart())
  }
  function feed(text: string, final: boolean) {
    if (invalid) return
    pending += text
    // 只限制计量缓冲，不截断或重写交给SDK的响应字节。
    if (pending.length + data.reduce((sum, item) => sum + item.length, 0) > 1048576) { invalid = true; pending = ""; data = []; return }
    if (!streaming) {
      if (final) { value(pending); pending = "" }
      return
    }
    for (;;) {
      const index = pending.indexOf("\n")
      if (index < 0) break
      line(pending.slice(0, index).replace(/\r$/, ""))
      pending = pending.slice(index + 1)
    }
    if (final) { if (pending) line(pending.replace(/\r$/, "")); line(""); pending = "" }
  }
  return {
    push(bytes: Uint8Array) { try { feed(decoder.decode(bytes, { stream: true }), false) } catch { invalid = true } },
    finish() {
      try { feed(decoder.decode(), true) } catch { invalid = true }
      return { tokens: !invalid && terminal ? requestUsageTotal(reported) : undefined,
        usage: reported }
    },
    partial() { return structuredClone(reported) },
  }
}

export async function budgetedProviderFetch(input: RequestInfo | URL, init: RequestInit,
  config: BudgetTransportConfig, modelContextTokens: number, transport: typeof fetch = fetch,
  stableRequestID?: string): Promise<Response> {
  const cfg = validateBudgetTransport(config)
  if (!positive(modelContextTokens) || cfg.maxInputTokens < modelContextTokens) throw new Error("Provider input reservation must cover declared model context")
  if ((init.method ?? "GET").toUpperCase() !== "POST" || typeof init.body !== "string") throw new Error("Provider budget adapter requires explicit JSON POST")
  const body = JSON.parse(init.body)
  if (!body || !cfg.expectedModels.includes(body.model)) throw new Error("Provider model outside frozen request budget")
  const output = cfg.dialect === "anthropic_messages" ? body.max_tokens : cfg.dialect === "openai_responses" ? body.max_output_tokens : body.max_completion_tokens ?? body.max_tokens
  if (!positive(output) || output > cfg.maxOutputTokens) throw new Error("Provider output reservation requires explicit bounded request")
  if (cfg.dialect === "openai_chat" && !Array.isArray(body.messages) || cfg.dialect === "openai_responses" && !Array.isArray(body.input) ||
      cfg.dialect === "anthropic_messages" && !Array.isArray(body.messages)) throw new Error("Provider wire dialect does not match budget adapter")
  const reservationTokens = cfg.maxInputTokens + Number(output)
  if (!positive(reservationTokens)) throw new Error("Provider reservation overflow")
  const id = stableRequestID ? `provider-${stableRequestID}` : `provider-${randomUUID()}`
  const request = fingerprint({ endpoint: String(input), body: init.body, role: cfg.role })
  await reserveRequest(cfg.budget, { id, request, model: body.model, role: cfg.role, reservationTokens,
    ...(cfg.gate ? { gate: cfg.gate } : {}) })
  let response: Response
  try { response = await transport(input, init) }
  catch (error) { await settleRequest(cfg.budget, id, undefined, { dialect: cfg.dialect, outcome: "transport_error" }); throw error }
  if (!response.body) { await settleRequest(cfg.budget, id, undefined, { dialect: cfg.dialect, outcome: "missing_body", httpStatus: response.status }); return response }
  const contentType = response.headers.get("content-type") ?? ""
  const streaming = contentType.includes("text/event-stream") || (body.stream === true && !contentType.includes("application/json"))
  const usage = meter(cfg.dialect, streaming)
  const reader = response.body.getReader()
  let settled: Promise<unknown> | undefined
  let cancelled = false
  const settle = (outcome?: "cancelled" | "stream_error") => {
    const result = outcome ? { tokens: undefined, usage: usage.partial() } : usage.finish()
    return settled ??= settleRequest(cfg.budget, id, result.tokens, { ...result.usage,
      httpStatus: response.status, outcome: outcome ?? (!response.ok ? "http_error" : result.tokens === undefined ? "incomplete_usage" : "complete") })
  }
  // 在消费同一条流时旁路计量，不克隆响应或提前读取整份答案。
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read()
        // 取消会唤醒挂起读取，不能抢先结算成正常结束或流错误。
        if (cancelled) return
        if (part.done) { await settle(); controller.close(); reader.releaseLock(); return }
        usage.push(part.value)
        controller.enqueue(part.value)
      } catch (error) {
        try { await settle("stream_error") } finally { controller.error(error) }
      }
    },
    async cancel(reason) { cancelled = true; try { await reader.cancel(reason) } finally { await settle("cancelled"); reader.releaseLock() } },
  })
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
}
