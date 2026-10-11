import type { OpencodeEvent } from "../opencode"

function reported(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function backendUsage(events: OpencodeEvent[]) {
  const steps = events.filter((event) => event.type === "step_finish").map((event) => {
    const tokens = event.part?.tokens
    const cost = event.part?.cost
    return { inputTokens: reported(tokens?.input), outputTokens: reported(tokens?.output),
      reasoningTokens: reported(tokens?.reasoning), cacheReadTokens: reported(tokens?.cache?.read),
      cacheWriteTokens: reported(tokens?.cache?.write),
      rawCost: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null }
  })
  // 部分步骤缺账时不把已知部分冒称整个会话用量。
  const total = (field: "inputTokens" | "outputTokens") => {
    if (!steps.length || steps.some((step) => step[field] === null)) return null
    const sum = steps.reduce((count, step) => count + step[field]!, 0)
    return Number.isSafeInteger(sum) ? sum : null
  }
  const inputTokens = total("inputTokens")
  const outputTokens = total("outputTokens")
  return { steps, inputTokens, outputTokens,
    usage: { ...(inputTokens !== null ? { inputTokens } : {}),
      ...(outputTokens !== null ? { outputTokens } : {}) } }
}
