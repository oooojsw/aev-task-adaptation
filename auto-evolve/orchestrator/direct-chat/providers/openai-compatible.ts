import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { DirectChatCallResult, DirectChatMessage, DirectChatModelConfig } from "../contract"
import { DirectChatProviderError, classifyHttp } from "./errors"
import type { DirectChatProviderAdapter, DirectChatProviderCallInput } from "./types"

export interface OpenAICompatibleCallOptions {
  defaultBaseURL?: string
  providerLabel?: string
}

function opencodeAuthCandidates() {
  return [
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "opencode", "auth.json") : "",
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "opencode", "auth.json") : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "opencode", "auth.json") : "",
  ].filter(Boolean)
}

function readOpenCodeAuthKey(providerID?: string) {
  if (!providerID) return undefined
  for (const candidate of opencodeAuthCandidates()) {
    try {
      const auth = JSON.parse(readFileSync(candidate, "utf8").replace(/^\uFEFF/, ""))
      const value = auth?.[providerID]?.key
      if (typeof value === "string" && value.trim()) return value.trim()
    } catch {
      // Try the next standard OpenCode auth location.
    }
  }
  return undefined
}

export async function callOpenAICompatibleChatCompletions(
  model: DirectChatModelConfig,
  messages: DirectChatMessage[],
  _input?: DirectChatProviderCallInput,
  options?: OpenAICompatibleCallOptions,
): Promise<DirectChatCallResult> {
  const baseURL = model.baseURL || options?.defaultBaseURL
  if (!baseURL) throw new DirectChatProviderError(`Model ${model.id} missing baseURL`, "config", undefined, false)
  if (!model.model) throw new DirectChatProviderError(`Model ${model.id} missing model name`, "config", undefined, false)
  const apiKey =
    model.apiKey ||
    (model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined) ||
    readOpenCodeAuthKey(model.opencodeAuthProviderID)
  if (!apiKey) {
    throw new DirectChatProviderError(
      `Model ${model.id} missing API key env ${model.apiKeyEnv || "(not configured)"} and OpenCode auth provider ${model.opencodeAuthProviderID || "(not configured)"}`,
      "auth",
      undefined,
      false,
    )
  }

  const timeoutMs = model.timeoutMs ?? 120_000
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseURL.replace(/\/+$/g, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        ...(model.requestBodyExtra || {}),
        model: model.model,
        messages,
        temperature: model.temperature ?? 0,
        max_tokens: model.maxOutputTokens ?? 2048,
      }),
    })
    const text = await response.text()
    if (!response.ok) {
      const classification = classifyHttp(response.status, text)
      throw new DirectChatProviderError(
        `HTTP ${response.status} from ${options?.providerLabel || model.id}: ${text.slice(0, 1000)}`,
        classification.category,
        response.status,
        classification.retryable,
      )
    }
    const json = JSON.parse(text)
    const content = json?.choices?.[0]?.message?.content
    if (typeof content !== "string" || !content.trim()) {
      throw new DirectChatProviderError(`No assistant content returned by ${model.id}`, "parse", undefined, false)
    }
    return {
      content,
      usage: {
        inputTokens: json?.usage?.prompt_tokens,
        outputTokens: json?.usage?.completion_tokens,
        totalTokens: json?.usage?.total_tokens,
      },
      raw: json,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export const openAICompatibleProvider: DirectChatProviderAdapter = {
  id: "openai-compatible",
  matches(model) {
    return model.transport === "openai-compatible"
  },
  call(model, messages, input) {
    return callOpenAICompatibleChatCompletions(model, messages, input)
  },
}
