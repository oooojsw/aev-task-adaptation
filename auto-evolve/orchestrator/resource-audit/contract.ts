export type ResourceUsageSource = "opencode_event" | "provider" | "estimate" | "missing"

export type ResourceAuditSource = "opencode" | "direct-chat" | "scan-existing"

export type ResourceUsageStatus = "ok" | "error" | "partial"

export type ResourcePriceStatus = "ok" | "missing" | "subscription" | "raw-only"

export interface ResourceTokenUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  estimatedPromptTokens?: number
  promptBudgetTokens?: number
  skillTokens?: number
  materialTokens?: number
}

export interface ResourceCostUsage {
  rawCost?: number
  rawCurrency?: string
  estimatedUSD?: number
  priceStatus: ResourcePriceStatus
  priceSource?: string
}

export interface ResourceUsageRecord {
  schema: "auto-evolve-resource-usage/v1"
  recordID: string
  createdAt: string
  source: ResourceAuditSource
  runID?: string
  benchmarkOutDir?: string
  datasetID?: string
  taskID?: string
  caseID?: string
  campaignID?: string
  roundNumber?: number
  stageDir?: string
  phase?: string
  role?: string
  title?: string
  sessionID?: string
  model?: string
  provider?: string
  resolvedModel?: string
  usage: ResourceTokenUsage
  cost: ResourceCostUsage
  status: ResourceUsageStatus
  passed?: boolean
  score?: number
  exitCode?: number
  usageSource: ResourceUsageSource
  refs: {
    eventsPath?: string
    runJsonPath?: string
    resultPath?: string
    promptAuditPath?: string
    providerResponsePath?: string
    stageDir?: string
  }
  warnings?: string[]
}

export interface ResourceUsageSummary {
  usage: ResourceTokenUsage
  rawCost?: number
  status: ResourceUsageStatus
  usageSource: ResourceUsageSource
  warnings: string[]
}
