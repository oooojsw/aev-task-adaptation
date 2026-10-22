import { DirectChatProviderError, classifyHttp } from "./errors"
import type { DirectChatProviderAdapter } from "./types"

export const anthropicMessagesProvider: DirectChatProviderAdapter = {
  id: "anthropic-messages",
  matches: model => model.transport === "anthropic-messages",
  async call(model, messages, input) {
    const key = model.apiKey ?? (model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined)
    if (!key || !model.baseURL || !model.model) throw new DirectChatProviderError("Explicit Anthropic endpoint, model and credential required", "config", undefined, false)
    // 此后端仅承载单次文本答题，不静默转换图片或工具会话。
    if (messages.some(item => typeof item.content !== "string")) throw new DirectChatProviderError("Anthropic text adapter rejects non-text content", "config", undefined, false)
    const body = { ...(model.requestBodyExtra ?? {}), model: model.model, max_tokens: model.maxOutputTokens ?? 2048,
      temperature: model.temperature ?? 0, stream: false,
      system: messages.filter(item => item.role === "system").map(item => item.content).join("\n\n"),
      messages: messages.filter(item => item.role !== "system").map(item => ({ role: item.role, content: item.content })) }
    const init = { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(model.timeoutMs ?? 120000) }
    const url = `${model.baseURL.replace(/\/+$/g, "")}/messages`
    const file = process.env.OPENCODE_AEV_REQUEST_BUDGET_FILE
    let cfg = input?.requestBudgetTransport
    if (!cfg && file) cfg = await (await import("../../task-adaptation/budget-transport")).readBudgetTransport(file, process.env.OPENCODE_AEV_REQUEST_BUDGET_SHA256)
    if (!cfg && (input?.enforceRequestBudget || process.env.AEV_CONSOLIDATION_ENFORCE_BUDGET === "1"))
      throw new DirectChatProviderError("Anthropic consolidation requires shared request budget", "config", undefined, false)
    if (cfg && cfg.dialect !== "anthropic_messages") throw new DirectChatProviderError("Anthropic budget dialect mismatch", "config", undefined, false)
    const reply = cfg
      ? await (await import("../../task-adaptation/budget-transport")).budgetedProviderFetch(url, init, cfg,
        model.contextWindowTokens ?? 16384, fetch, input?.stableRequestID ? `${input.stableRequestID}__attempt${input.attempt ?? 1}` : undefined)
      : await fetch(url, init)
    const text = await reply.text()
    if (!reply.ok) {
      const error = classifyHttp(reply.status, text)
      throw new DirectChatProviderError(`HTTP ${reply.status}: ${text.slice(0, 1000)}`, error.category, reply.status, error.retryable)
    }
    const json = JSON.parse(text)
    const content = Array.isArray(json.content) ? json.content.filter((item: {type?: string}) => item.type === "text")
      .map((item: {text: string}) => item.text).join("\n") : ""
    const usage = json.usage ?? {}
    const fields = [usage.input_tokens, usage.output_tokens]
    const total = fields.every(value => typeof value === "number")
      ? usage.input_tokens + usage.output_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : undefined
    const response = { content, resolvedModel: json.model, raw: json,
      finishReason: json.stop_reason === "max_tokens" ? "length" : json.stop_reason,
      usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: total } }
    // 已收到的原始回复与用量必须留证，不能因无答案而丢失。
    if (!content.trim()) throw new DirectChatProviderError("No Anthropic final text; thinking is not an answer", "parse", undefined, false,
      { response, attempts: input?.attempt ?? 1 })
    return response
  },
}
