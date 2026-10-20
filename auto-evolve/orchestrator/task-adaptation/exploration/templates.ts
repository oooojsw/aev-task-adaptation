import type { ExplorationPolicy } from "./policy"

export type ExplorationRequest =
  | { mode?: "off"; after?: never; [key: string]: unknown }
  | { mode: "auto"; after?: never }
  | { mode: "observations"; after: number }

export interface HostExplorationTemplate {
  schema: "aev.exploration-template.v1"
  id: string
  version: string
  profiles: string[]
  checker: { id: string; version?: string }
  executor?: { id: string; version?: string }
  policy: {
    origin: { kind: "initial" }
    replace: string[]
    preserve: string[]
    dependencies: string[]
    defaultObservations: number
    allowance: ExplorationPolicy["allowance"]
    bounds: ExplorationPolicy["bounds"]
    safety: ExplorationPolicy["safety"]
  }
}

// 第一批仅提供受限报告模板，不预置未核验的通用生产默认配置。
export const BUILTIN_EXPLORATION_TEMPLATES: readonly HostExplorationTemplate[] = [
  {
    schema: "aev.exploration-template.v1",
    id: "report-default-exploration",
    version: "1.0.0",
    profiles: ["report"],
    checker: { id: "script-json-checker" },
    policy: {
      origin: { kind: "initial" },
      replace: ["candidate"],
      preserve: [],
      dependencies: ["source"],
      defaultObservations: 2,
      allowance: {
        rounds: 2,
        minimumRounds: 2,
        authorCalls: 200,
        authorTokens: 3000000,
        acceptanceCalls: 5,
        acceptanceTokens: 300000,
        deliveryCalls: 0,
        deliveryTokens: 0,
      },
      bounds: {
        archiveBytes: 20000000,
        candidateBytes: 10000,
        dependencyBytes: 100000,
      },
      safety: { reset: "declared_entries", effects: "sandbox_only" },
    },
  },
]
