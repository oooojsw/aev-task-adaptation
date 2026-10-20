import { createHash } from "node:crypto"
import { readFile, mkdir, open } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { writeFileAtomic, writeJsonAtomic } from "../atomic-write"
import { fingerprint } from "./identity"
import type { ExecutorPlugin, Settings } from "./contract"
import type { Artifact, Execute } from "./runtime"
import { reserveRequest, settleRequest, type RequestBudget } from "../task-adaptation/request-budget"
import { validateRequestGate } from "../task-adaptation/budget-transport"
import { parseRequestUsage, requestUsageTotal, type RequestUsage } from "../task-adaptation/request-usage"

export interface HttpRequestBudget {
  config: RequestBudget
  tokenCeiling: number
  role: string
}

interface Options {
  evidenceRoot: string
  transport?: typeof fetch
  credential?: (name: string) => string | undefined
  budget?: HttpRequestBudget
  requestGate?: string
}

interface Config {
  dialect: "openai_chat" | "anthropic_messages"
  url: string
  allowedOrigins: string[]
  model: string
  expectedModel: string
  credentialEnv: string
  systemInput: string
  userInputs: string[]
  skillPlacement: "system" | "user"
  maxTokens: number
  maxInputBytes: number
  maxResponseBytes: number
  temperature: number
  timeoutMs: number
}

function config(settings: Settings): Config {
  const keys = ["dialect", "url", "allowedOrigins", "model", "expectedModel", "credentialEnv", "systemInput",
    "userInputs", "skillPlacement", "maxTokens", "maxInputBytes", "maxResponseBytes", "temperature", "timeoutMs"]
  if (Object.keys(settings).some((key) => !keys.includes(key)) || keys.some((key) => settings[key] === undefined)) {
    throw new Error("Explicit HTTP settings required; unknown fields forbidden")
  }
  const value = settings as unknown as Config
  if (!["openai_chat", "anthropic_messages"].includes(value.dialect) ||
      ![value.url, value.model, value.expectedModel, value.credentialEnv, value.systemInput].every((item) => typeof item === "string" && item.trim()) ||
      !["system", "user"].includes(value.skillPlacement) || !/^[A-Z][A-Z0-9_]*$/.test(value.credentialEnv) ||
      ![value.maxTokens, value.maxInputBytes, value.maxResponseBytes, value.timeoutMs].every((item) => Number.isSafeInteger(item) && item > 0) ||
      value.maxResponseBytes > 16 * 1024 * 1024 ||
      value.timeoutMs > 3_600_000 || !Number.isFinite(value.temperature) || value.temperature < 0 ||
      value.temperature > (value.dialect === "anthropic_messages" ? 1 : 2) ||
      !Array.isArray(value.allowedOrigins) || !value.allowedOrigins.length ||
      !Array.isArray(value.userInputs) || !value.userInputs.length ||
      value.userInputs.some((item) => typeof item !== "string" || !item.trim()) ||
      new Set(value.userInputs).size !== value.userInputs.length) throw new Error("Invalid HTTP generation contract")
  const url = new URL(value.url)
  if (!value.allowedOrigins.includes(url.origin) || url.username || url.password || url.search || url.hash ||
      !["https:", "http:"].includes(url.protocol) ||
      (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Unapproved HTTP endpoint")
  }
  if (value.allowedOrigins.some((origin) => typeof origin !== "string" || new URL(origin).origin !== origin)) {
    throw new Error("Origins must be explicit origins, not arbitrary URLs")
  }
  return value
}

function text(input: Artifact) {
  if (input.kind !== "text") throw new Error("HTTP text adapter requires text input")
  return new TextDecoder("utf-8", { fatal: true }).decode(input.bytes).replace(/^\uFEFF/, "")
}

async function bounded(response: Response, limit: number) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > limit) {
        await reader.cancel().catch(() => undefined)
        throw new Error("Provider response exceeds declared byte cap")
      }
      chunks.push(next.value)
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
  } finally {
    reader.releaseLock()
  }
}

export async function httpChat(options: Options): Promise<{ descriptor: ExecutorPlugin; execute: Execute }> {
  if (!path.isAbsolute(options.evidenceRoot)) throw new Error("Absolute HTTP evidence root required")
  const gate = validateRequestGate(options.requestGate, Boolean(options.budget))
  const source = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex")
  const implementation = options.budget ? fingerprint({ source, budget: options.budget,
    ledger: createHash("sha256").update(await readFile(fileURLToPath(new URL("../task-adaptation/request-budget.ts", import.meta.url)))).digest("hex") }) : source
  const descriptor: ExecutorPlugin = { id: "http-text-chat", version: "1", implementation,
    skillFormats: ["text", "package"], productKinds: ["text"], materialKinds: ["text"], validate(settings) { config(settings) } }
  const transport = options.transport ?? fetch
  const credential = options.credential ?? ((name: string) => process.env[name])
  const execute: Execute = async (input) => {
    const cfg = config(input.settings)
    if (options.budget && (!Number.isSafeInteger(options.budget.tokenCeiling) || options.budget.tokenCeiling < cfg.maxTokens ||
        typeof options.budget.role !== "string" || !options.budget.role.trim())) throw new Error("Explicit HTTP request token ceiling and role required")
    function material(id: string) {
      const matches = input.materials.filter((item) => item.id === id)
      if (matches.length !== 1) throw new Error(`Exactly one declared public prompt required: ${id}`)
      return text(matches[0])
    }
    let system = material(cfg.systemInput)
    let user = cfg.userInputs.map(material).join("\n\n")
    const skill = input.skill.map((item) => `Skill file ${JSON.stringify(item.id)}:\n${text(item)}`).join("\n\n")
    if (cfg.skillPlacement === "system") system += `\n\n${skill}`
    else user += `\n\n${skill}`
    const request = cfg.dialect === "anthropic_messages"
      ? { model: cfg.model, max_tokens: cfg.maxTokens, temperature: cfg.temperature, system,
          messages: [{ role: "user", content: user }] }
      : { model: cfg.model, max_tokens: cfg.maxTokens, temperature: cfg.temperature,
          messages: [{ role: "system", content: system }, { role: "user", content: user }] }
    const wire = JSON.stringify(request)
    // 输入字节与输出token分别限额，不把两种单位相加或静默裁剪。
    if (Buffer.byteLength(wire, "utf8") > cfg.maxInputBytes) throw new Error("Input byte budget exceeded; no truncation")
    const secret = credential(cfg.credentialEnv)
    if (!secret) throw new Error("Missing explicitly selected credential")
    // 阶段授权绑定本次尝试，不随阶段变化重定义冻结插件。
    const key = fingerprint({ implementation, url: cfg.url, credentialEnv: cfg.credentialEnv, request, ...(gate ? { gate } : {}) })
    const dir = path.join(options.evidenceRoot, key)
    await mkdir(dir, { recursive: true })
    const claim = await open(path.join(dir, "started.claim"), "wx")
    await claim.close()
    const startedAt = new Date().toISOString()
    const clock = performance.now()
    let observedUsage: RequestUsage | undefined
    let httpStatus: number | undefined
    let outcome: RequestUsage["outcome"] = "transport_error"
    let actualModel: string | null = null
    let dispatched = false
    const account = async (status: string) => {
      if (options.budget && !dispatched) {
        // 准入被拒没有真实网络调用，不能污染API消耗账本。
        return writeJsonAtomic(path.join(dir, "budget.admission.json"), { status: "blocked_before_dispatch", requestFingerprint: key })
      }
      return writeJsonAtomic(path.join(dir, "invocation.accounting.json"), {
      schema: "aev.backend-invocation-accounting.v1", transport: "http", requestFingerprint: key,
      requestedModel: cfg.model, actualModel, startedAt, finishedAt: new Date().toISOString(),
      elapsedMs: Math.max(0, Math.round(performance.now() - clock)), reused: false, fee: null, status,
      inputTokens: observedUsage?.inputTokens ?? null, outputTokens: observedUsage?.outputTokens ?? null,
      cacheReadTokens: observedUsage?.cacheReadTokens ?? null, cacheWriteTokens: observedUsage?.cacheWriteTokens ?? null,
      reasoningTokens: observedUsage?.reasoningTokens ?? null, totalTokens: observedUsage ? requestUsageTotal(observedUsage) ?? null : null,
      role: options.budget?.role ?? "executor", phase: input.phase, gate: gate ?? null,
      dialect: cfg.dialect, httpStatus: httpStatus ?? null,
      usageSource: observedUsage ? "provider_response" : "missing", errorKind: status === "completed" ? null : "http_or_persistence_error",
      })
    }
    await writeJsonAtomic(path.join(dir, "request.json"), { url: cfg.url, credentialAlias: cfg.credentialEnv, request,
      requestFingerprint: key, tools: false, turns: 1, retries: 0 })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
    let reserved = false
    try {
      if (options.budget) {
        await reserveRequest(options.budget.config, { id: key, request: key, model: cfg.model,
          role: options.budget.role, reservationTokens: options.budget.tokenCeiling, ...(gate ? { gate } : {}) })
        reserved = true
      }
      // 禁默认空闲超时，长回答仍受协议总时限约束。
      dispatched = true
      const response = await transport(cfg.url, { method: "POST", redirect: "error", timeout: false, signal: controller.signal,
        headers: cfg.dialect === "anthropic_messages"
          ? { "content-type": "application/json", "x-api-key": secret, "anthropic-version": "2023-06-01" }
          : { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: wire } as RequestInit & { timeout: false })
      httpStatus = response.status
      outcome = response.ok ? "execution_error" : "http_error"
      const raw = await bounded(response, cfg.maxResponseBytes)
      await writeFileAtomic(path.join(dir, "response.raw.txt"), raw)
      await writeJsonAtomic(path.join(dir, "response.meta.json"), { status: response.status, requestFingerprint: key,
        responseSHA256: createHash("sha256").update(raw).digest("hex") })
      const data = JSON.parse(raw)
      // 错误响应也可能计费，先留用量再判断产物是否有效。
      observedUsage = parseRequestUsage(data?.usage, cfg.dialect)
      actualModel = typeof data?.model === "string" ? data.model : null
      if (!response.ok) throw new Error("Provider response was not successful")
      if (!data || data.model !== cfg.expectedModel) throw new Error("Actual model differs from frozen expectation")
      let answer: string
      if (cfg.dialect === "anthropic_messages") {
        if (data.stop_reason !== "end_turn" || !Array.isArray(data.content) || data.content.some((item: { type?: string }) => item.type === "tool_use")) {
          throw new Error("Incomplete or tool-bearing Anthropic reply")
        }
        answer = data.content.filter((item: { type?: string }) => item.type === "text")
          .map((item: { text?: string }) => typeof item.text === "string" ? item.text : "").join("\n")
      } else {
        const choice = data.choices?.[0]
        if (!Array.isArray(data.choices) || data.choices.length !== 1 || choice.finish_reason !== "stop" ||
            choice.message?.tool_calls?.length || typeof choice.message?.content !== "string") {
          throw new Error("Incomplete or tool-bearing OpenAI-compatible reply")
        }
        answer = choice.message.content
      }
      if (!answer.trim()) throw new Error("No final answer")
      const tokens = { ...(observedUsage.inputTokens !== undefined ? { inputTokens: observedUsage.inputTokens } : {}),
        ...(observedUsage.outputTokens !== undefined ? { outputTokens: observedUsage.outputTokens } : {}) }
      if (tokens?.outputTokens !== undefined && tokens.outputTokens > cfg.maxTokens) {
        throw new Error("Provider exceeded frozen output token budget")
      }
      await writeJsonAtomic(path.join(dir, "completed.json"), { requestFingerprint: key, model: data.model,
        answerSHA256: createHash("sha256").update(answer).digest("hex"), ...(tokens ? { usage: tokens } : {}) })
      await account("completed")
      outcome = "complete"
      return { status: "completed", product: { kind: "text", bytes: Buffer.from(answer) }, ...(tokens ? { usage: tokens } : {}) }
    } catch {
      // 保留原回复；不得把接口故障算为Skill拒绝或自动重试。
      await writeJsonAtomic(path.join(dir, "failure.json"), { requestFingerprint: key,
        status: "execution_error", outcome: "inspect_before_retry" })
      // 即使产物不合格，已报告用量仍属于实际调用消耗。
      await account("infrastructure_error")
      return { status: "execution_error", message: "HTTP execution failed; raw evidence retained",
        ...(observedUsage ? { usage: observedUsage } : {}) }
    } finally {
      clearTimeout(timer)
      if (reserved && options.budget) {
        // 缺少任一侧用量即保留整份预留，不把未知计费记作零。
        const total = observedUsage ? requestUsageTotal(observedUsage) : undefined
        await settleRequest(options.budget.config, key, total, { ...observedUsage, dialect: cfg.dialect,
          outcome: outcome === "complete" && total === undefined ? "incomplete_usage" : outcome,
          ...(httpStatus !== undefined ? { httpStatus } : {}) })
      }
    }
  }
  return { descriptor, execute }
}
