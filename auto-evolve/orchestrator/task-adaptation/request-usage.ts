export interface RequestUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  dialect?: "openai_chat" | "openai_responses" | "anthropic_messages"
  outcome?: "complete" | "transport_error" | "http_error" | "cancelled" | "stream_error" | "missing_body" | "incomplete_usage" | "execution_error"
  httpStatus?: number
}

const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const

export function validateRequestUsage(value: RequestUsage) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => ![...fields, "dialect", "outcome", "httpStatus"].includes(key)) ||
    fields.some(key => value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key]! < 0)) ||
    value.dialect !== undefined && !["openai_chat", "openai_responses", "anthropic_messages"].includes(value.dialect) ||
    value.outcome !== undefined && !["complete", "transport_error", "http_error", "cancelled", "stream_error", "missing_body", "incomplete_usage", "execution_error"].includes(value.outcome) ||
    value.httpStatus !== undefined && (!Number.isSafeInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599)) {
    throw new Error("Invalid request usage evidence")
  }
  return value
}

export function requestUsageTotal(value: RequestUsage) {
  if (value.inputTokens === undefined || value.outputTokens === undefined) return undefined
  // OpenAI缓存和推理已含在输入输出，不能再次相加。
  const total = value.inputTokens + value.outputTokens + (value.dialect === "anthropic_messages"
    ? (value.cacheReadTokens ?? 0) + (value.cacheWriteTokens ?? 0) : 0)
  return Number.isSafeInteger(total) ? total : undefined
}

export function parseRequestUsage(value: unknown, dialect: NonNullable<RequestUsage["dialect"]>): RequestUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { dialect }
  const row = value as Record<string, unknown>
  const input = dialect === "openai_chat" ? row.prompt_tokens : row.input_tokens
  const output = dialect === "openai_chat" ? row.completion_tokens : row.output_tokens
  const details = (dialect === "openai_chat" ? row.prompt_tokens_details : row.input_tokens_details) as Record<string, unknown> | undefined
  const completion = (dialect === "openai_chat" ? row.completion_tokens_details : row.output_tokens_details) as Record<string, unknown> | undefined
  const result: RequestUsage = { dialect }
  for (const [key, count] of [["inputTokens", input], ["outputTokens", output],
    ["cacheReadTokens", dialect === "anthropic_messages" ? row.cache_read_input_tokens : details?.cached_tokens],
    ["cacheWriteTokens", dialect === "anthropic_messages" ? row.cache_creation_input_tokens : undefined],
    ["reasoningTokens", completion?.reasoning_tokens]] as const) {
    if (count === undefined) continue
    if (!Number.isSafeInteger(count) || Number(count) < 0) throw new Error("Invalid provider usage")
    result[key] = Number(count)
  }
  return result
}
