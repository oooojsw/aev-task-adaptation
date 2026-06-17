import type { DirectChatProviderAdapter } from "./types"

export const mockProvider: DirectChatProviderAdapter = {
  id: "mock",
  matches(model) {
    return model.transport === "mock"
  },
  async call(model, messages, input) {
    const content = model.mockResponse ?? "MOCK_RESPONSE"
    return {
      content,
      usage: {
        inputTokens: messages.reduce((sum, item) => sum + Math.ceil(JSON.stringify(item.content).length / 4), 0),
        outputTokens: Math.ceil(content.length / 4),
      },
      raw: { mock: true, attempt: input?.attempt ?? 1 },
    }
  },
}
