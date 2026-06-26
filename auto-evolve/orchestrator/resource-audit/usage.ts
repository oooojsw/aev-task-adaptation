import type { OpencodeEvent } from "../opencode"
import type { DirectChatPromptAudit } from "../direct-chat/contract"
import type { ResourceTokenUsage, ResourceUsageSummary } from "./contract"

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function add(target: ResourceTokenUsage, key: keyof ResourceTokenUsage, value: unknown) {
  const n = asNumber(value)
  if (typeof n !== "number") return
  target[key] = (target[key] ?? 0) + n
}

function tokenObject(part: unknown) {
  if (!part || typeof part !== "object") return undefined
  const tokens = (part as Record<string, unknown>).tokens
  return tokens && typeof tokens === "object" ? (tokens as Record<string, unknown>) : undefined
}

function tokenValue(tokens: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const got = asNumber(tokens[key])
    if (typeof got === "number") return got
  }
  return undefined
}

export function summarizeOpencodeUsage(events: OpencodeEvent[]): ResourceUsageSummary {
  const usage: ResourceTokenUsage = {}
  const warnings: string[] = []
  let rawCost = 0
  let hasCost = false
  let stepFinishCount = 0
  let stepFinishWithUsage = 0

  for (const event of events) {
    if (event.type !== "step_finish") continue
    stepFinishCount += 1
    const part = event.part && typeof event.part === "object" ? (event.part as Record<string, unknown>) : undefined
    const cost = asNumber(part?.cost)
    if (typeof cost === "number") {
      rawCost += cost
      hasCost = true
    }

    const tokens = tokenObject(part)
    if (!tokens) continue
    stepFinishWithUsage += 1
    add(usage, "inputTokens", tokenValue(tokens, ["input", "inputTokens", "prompt", "promptTokens", "prompt_tokens"]))
    add(usage, "outputTokens", tokenValue(tokens, ["output", "outputTokens", "completion", "completionTokens", "completion_tokens"]))
    add(usage, "reasoningTokens", tokenValue(tokens, ["reasoning", "reasoningTokens", "reasoning_tokens"]))
    add(usage, "totalTokens", tokenValue(tokens, ["total", "totalTokens", "total_tokens"]))
    add(usage, "cacheReadTokens", tokenValue(tokens, ["cacheRead", "cacheReadTokens", "cachedInput", "cachedInputTokens", "cached_input_tokens"]))
    add(usage, "cacheWriteTokens", tokenValue(tokens, ["cacheWrite", "cacheWriteTokens", "cache_write_tokens"]))
  }

  const componentTotal =
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.reasoningTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  if (componentTotal > 0 && (typeof usage.totalTokens !== "number" || usage.totalTokens < componentTotal)) {
    usage.totalTokens = componentTotal
  }

  if (stepFinishCount === 0) warnings.push("No step_finish events found.")
  if (stepFinishCount > 0 && stepFinishWithUsage === 0) warnings.push("step_finish events did not include token usage.")
  if (stepFinishCount > stepFinishWithUsage && stepFinishWithUsage > 0) {
    warnings.push(`${stepFinishCount - stepFinishWithUsage} step_finish events lacked token usage.`)
  }

  const hasAnyUsage = Object.values(usage).some((value) => typeof value === "number")
  return {
    usage,
    rawCost: hasCost ? rawCost : undefined,
    usageSource: hasAnyUsage ? "opencode_event" : "missing",
    status: hasAnyUsage && warnings.length === 0 ? "ok" : hasAnyUsage ? "partial" : "partial",
    warnings,
  }
}

export function summarizeDirectChatUsage(input: {
  usage?: {
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    totalTokens?: number
  }
  promptAudit?: DirectChatPromptAudit
}): ResourceUsageSummary {
  const usage: ResourceTokenUsage = {}
  const warnings: string[] = []
  const actual = input.usage
  if (actual) {
    if (typeof actual.inputTokens === "number") usage.inputTokens = actual.inputTokens
    if (typeof actual.outputTokens === "number") usage.outputTokens = actual.outputTokens
    if (typeof actual.reasoningTokens === "number") usage.reasoningTokens = actual.reasoningTokens
    if (typeof actual.totalTokens === "number") usage.totalTokens = actual.totalTokens
  }

  if (input.promptAudit) {
    usage.estimatedPromptTokens = input.promptAudit.estimatedPromptTokens
    usage.promptBudgetTokens = input.promptAudit.promptBudgetTokens
    usage.skillTokens = input.promptAudit.skill?.includedTokens
    usage.materialTokens = input.promptAudit.materials.reduce((sum, item) => sum + (item.includedTokens || 0), 0)
  }

  if (typeof usage.totalTokens !== "number") {
    const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.reasoningTokens ?? 0)
    if (total > 0) usage.totalTokens = total
  }

  if (!actual) warnings.push("Provider did not return usage; prompt estimates are retained separately.")
  const hasProviderUsage = Boolean(actual && Object.values(actual).some((value) => typeof value === "number"))
  const hasEstimate = typeof usage.estimatedPromptTokens === "number"
  return {
    usage,
    usageSource: hasProviderUsage ? "provider" : hasEstimate ? "estimate" : "missing",
    status: hasProviderUsage ? "ok" : hasEstimate ? "partial" : "partial",
    warnings,
  }
}
