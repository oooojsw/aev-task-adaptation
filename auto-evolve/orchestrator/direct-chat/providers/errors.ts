import type { DirectChatErrorCategory } from "../contract"

export class DirectChatProviderError extends Error {
  constructor(
    message: string,
    readonly category: DirectChatErrorCategory,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message)
    this.name = "DirectChatProviderError"
  }
}

export function classifyDirectChatError(error: unknown): DirectChatErrorCategory {
  if (error instanceof DirectChatProviderError) return error.category
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes("api key") || message.includes("unauthorized") || message.includes("forbidden")) return "auth"
  if (message.includes("quota") || message.includes("insufficient balance")) return "quota"
  if (message.includes("rate") || message.includes("429")) return "rate_limit"
  if (message.includes("context") || message.includes("token") || message.includes("too long")) return "context_length"
  if (message.includes("abort") || message.includes("timeout")) return "timeout"
  if (message.includes("fetch") || message.includes("network") || message.includes("econn")) return "network"
  return "unknown"
}

export function classifyHttp(status: number, body: string): { category: DirectChatErrorCategory; retryable: boolean } {
  const lower = body.toLowerCase()
  if (status === 401 || status === 403) return { category: "auth", retryable: false }
  if (status === 429 && (lower.includes("quota") || lower.includes("balance"))) return { category: "quota", retryable: false }
  if (status === 429) return { category: "rate_limit", retryable: true }
  if (status === 400 && (lower.includes("context") || lower.includes("token") || lower.includes("too long"))) {
    return { category: "context_length", retryable: false }
  }
  if (status >= 500) return { category: "provider_5xx", retryable: true }
  if (status >= 400) return { category: "bad_request", retryable: false }
  return { category: "unknown", retryable: false }
}
