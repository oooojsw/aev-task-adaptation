import { createHash } from "node:crypto"
import { readFile, mkdir, open } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { writeFileAtomic, writeJsonAtomic } from "../atomic-write"
import { fingerprint } from "./identity"
import type { ExecutorPlugin, Settings } from "./contract"
import type { Artifact, Execute } from "./runtime"

interface Options {
  evidenceRoot: string
  transport?: typeof fetch
  credential?: (name: string) => string | undefined
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

function usage(value: unknown) {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object") throw new Error("Malformed provider usage")
  const record = value as Record<string, unknown>
  const result: { inputTokens?: number; outputTokens?: number } = {}
  for (const [name, candidate] of [
    ["inputTokens", record.input_tokens ?? record.prompt_tokens],
    ["outputTokens", record.output_tokens ?? record.completion_tokens],
  ] as const) {
    if (candidate === undefined) continue
    if (!Number.isSafeInteger(candidate) || Number(candidate) < 0) throw new Error("Invalid provider token count")
    result[name] = Number(candidate)
  }
  return result
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
  const implementation = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex")
  const descriptor: ExecutorPlugin = { id: "http-text-chat", version: "1", implementation,
    skillFormats: ["text", "package"], productKinds: ["text"], materialKinds: ["text"], validate(settings) { config(settings) } }
  const transport = options.transport ?? fetch
  const credential = options.credential ?? ((name: string) => process.env[name])
  const execute: Execute = async (input) => {
    const cfg = config(input.settings)
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
    const key = fingerprint({ implementation, url: cfg.url, credentialEnv: cfg.credentialEnv, request })
    const dir = path.join(options.evidenceRoot, key)
    await mkdir(dir, { recursive: true })
    const claim = await open(path.join(dir, "started.claim"), "wx")
    await claim.close()
    await writeJsonAtomic(path.join(dir, "request.json"), { url: cfg.url, credentialAlias: cfg.credentialEnv, request,
      requestFingerprint: key, tools: false, turns: 1, retries: 0 })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
    try {
      const response = await transport(cfg.url, { method: "POST", redirect: "error", signal: controller.signal,
        headers: cfg.dialect === "anthropic_messages"
          ? { "content-type": "application/json", "x-api-key": secret, "anthropic-version": "2023-06-01" }
          : { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: wire })
      const raw = await bounded(response, cfg.maxResponseBytes)
      await writeFileAtomic(path.join(dir, "response.raw.txt"), raw)
      await writeJsonAtomic(path.join(dir, "response.meta.json"), { status: response.status, requestFingerprint: key,
        responseSHA256: createHash("sha256").update(raw).digest("hex") })
      if (!response.ok) throw new Error("Provider response was not successful")
      const data = JSON.parse(raw)
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
      const tokens = usage(data.usage)
      if (tokens?.outputTokens !== undefined && tokens.outputTokens > cfg.maxTokens) {
        throw new Error("Provider exceeded frozen output token budget")
      }
      await writeJsonAtomic(path.join(dir, "completed.json"), { requestFingerprint: key, model: data.model,
        answerSHA256: createHash("sha256").update(answer).digest("hex"), ...(tokens ? { usage: tokens } : {}) })
      return { status: "completed", product: { kind: "text", bytes: Buffer.from(answer) }, ...(tokens ? { usage: tokens } : {}) }
    } catch {
      // 保留原回复；不得把接口故障算为Skill拒绝或自动重试。
      await writeJsonAtomic(path.join(dir, "failure.json"), { requestFingerprint: key,
        status: "execution_error", outcome: "inspect_before_retry" })
      return { status: "execution_error", message: "HTTP execution failed; raw evidence retained" }
    } finally {
      clearTimeout(timer)
    }
  }
  return { descriptor, execute }
}
