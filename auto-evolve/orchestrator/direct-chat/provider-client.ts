import type { DirectChatCallResult, DirectChatMessage, DirectChatModelConfig } from "./contract"
import { DirectChatProviderError, classifyDirectChatError } from "./providers/errors"
import { resolveDirectChatProvider } from "./providers"
import type { DirectChatProviderCallInput } from "./providers/types"

export { DirectChatProviderError, classifyDirectChatError }
export type { DirectChatMessage }

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function callDirectChatModel(
  model: DirectChatModelConfig,
  messages: DirectChatMessage[],
  input?: DirectChatProviderCallInput,
): Promise<DirectChatCallResult> {
  return await resolveDirectChatProvider(model).call(model, messages, input)
}

export async function retryDirectChatCall(
  model: DirectChatModelConfig,
  messages: DirectChatMessage[],
  options: { maxAttempts: number; backoffMs: number },
  input?: DirectChatProviderCallInput,
) {
  let lastError: unknown
  for (let attempt = 1; attempt <= Math.max(1, options.maxAttempts); attempt += 1) {
    try {
      const result = await callDirectChatModel(model, messages, { ...input, attempt })
      return { result, attempts: attempt }
    } catch (error) {
      // 请求失败也保留尝试次数，不能统一报为未调用。
      lastError = error instanceof DirectChatProviderError
        ? new DirectChatProviderError(error.message, error.category, error.status, error.retryable, error.received,
          error.status === undefined && ["config", "auth"].includes(error.category) ? 0 : attempt)
        : new DirectChatProviderError(error instanceof Error ? error.message : String(error), classifyDirectChatError(error), undefined, true, undefined, attempt)
      if (attempt >= Math.max(1, options.maxAttempts)) break
      if (error instanceof DirectChatProviderError && !error.retryable) break
      await sleep(options.backoffMs * attempt)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
