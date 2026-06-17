import { callOpenAICompatibleChatCompletions } from "./openai-compatible"
import type { DirectChatProviderAdapter } from "./types"

export const SILICONFLOW_DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1"

export const siliconFlowProvider: DirectChatProviderAdapter = {
  id: "siliconflow",
  matches(model) {
    return model.provider === "siliconflow"
  },
  call(model, messages, input) {
    return callOpenAICompatibleChatCompletions(model, messages, input, {
      defaultBaseURL: SILICONFLOW_DEFAULT_BASE_URL,
      providerLabel: "siliconflow",
    })
  },
}
