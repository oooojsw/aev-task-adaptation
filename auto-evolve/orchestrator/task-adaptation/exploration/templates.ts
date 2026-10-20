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
  checker: { name: string; id: string; version?: string }
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

// 生产默认模板列表为空：未获正式批准前，auto 明确返回未启用
export const BUILTIN_EXPLORATION_TEMPLATES: readonly HostExplorationTemplate[] = []

// 供 Host 测试显式注入的受信报告 fixture 模板
export const FIXTURE_REPORT_EXPLORATION_TEMPLATE: HostExplorationTemplate = {
  schema: "aev.exploration-template.v1",
  id: "report-default-exploration",
  version: "1.0.0",
  profiles: ["report"],
  checker: { name: "quality", id: "script-json-checker" },
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
}
