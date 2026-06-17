import type { DirectChatModelConfig } from "../contract"
import { DirectChatProviderError } from "./errors"
import { mockProvider } from "./mock"
import { openAICompatibleProvider } from "./openai-compatible"
import { siliconFlowProvider } from "./siliconflow"
import type { DirectChatProviderAdapter } from "./types"

const directChatProviderRegistry: DirectChatProviderAdapter[] = [
  mockProvider,
  siliconFlowProvider,
  openAICompatibleProvider,
]

export function resolveDirectChatProvider(model: DirectChatModelConfig) {
  const provider = directChatProviderRegistry.find((item) => item.matches(model))
  if (!provider) {
    throw new DirectChatProviderError(
      `Unsupported direct-chat provider/transport: provider=${model.provider || "(none)"} transport=${model.transport}`,
      "config",
      undefined,
      false,
    )
  }
  return provider
}
