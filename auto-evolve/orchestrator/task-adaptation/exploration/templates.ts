import type { ExplorationPolicy } from "./policy"
import type { ExplorationPolicyV2 } from "./policy-v2"

export type ExplorationRequest =
  | { mode?: "off"; after?: never; [key: string]: unknown }
  | { mode: "auto"; template?: string; budgetMode?: "best_effort" }
  | { mode: "observations"; after: number; template?: string; budgetMode?: "best_effort" }
  | { mode: "window"; afterRound: number; template?: string; budgetMode?: "best_effort" }
  | { mode: "metric"; minimumRounds?: number; maximumRounds?: number; patience?: number; template?: string; budgetMode?: "best_effort" }

export interface HostExplorationTemplateV1 {
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

export interface HostExplorationTemplateV2 {
  schema: "aev.exploration-template.v2"
  id: string
  version: string
  profiles: string[]
  checker: HostExplorationTemplateV1["checker"]
  executor?: HostExplorationTemplateV1["executor"]
  policy: ExplorationPolicyV2
  // 未声明覆盖范围即只批准原值，不能推断额外轮数或额度。
  overrides?: Partial<Record<"afterRound" | "minimumRounds" | "maximumRounds" | "patience", { minimum: number; maximum: number }>>
}

export type HostExplorationTemplate = HostExplorationTemplateV1 | HostExplorationTemplateV2

// 生产默认模板列表为空：未获正式批准前，auto 明确返回未启用
export const BUILTIN_EXPLORATION_TEMPLATES: readonly HostExplorationTemplate[] = []

// 供 Host 测试显式注入的受信报告 fixture 模板
export const FIXTURE_REPORT_EXPLORATION_TEMPLATE: HostExplorationTemplateV1 = {
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
