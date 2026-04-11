import type { ExecutionStrategyID } from "../execution-strategies"
import type { PacketizationPolicyID } from "../packetization-policies"

export type ReversePropagationComponentCategory =
  | "maintenance_module"
  | "constraint_policy"
  | "routing_policy"
  | "acceptance_policy"
  | "governance_strategy"
  | "optimization_strategy"

export type ReversePropagationComponentLayer = 2 | 3 | 4 | "cross_layer"

export type ReversePropagationComponentStatus = "active" | "experimental" | "planned"

export interface ReversePropagationComponentDescriptorBase {
  id: string
  title: string
  summary: string
  category: ReversePropagationComponentCategory
  layer: ReversePropagationComponentLayer
  status: ReversePropagationComponentStatus
  stateful: boolean
  pluginFriendly: boolean
  notes?: string[]
}

export interface ReversePropagationMaintenanceModuleDescriptor
  extends ReversePropagationComponentDescriptorBase {
  category: "maintenance_module"
  defaultLoadingStrategyID: string
  defaultScopeLevelID: string
  defaultOperationIDs?: string[]
}

export type ReversePropagationComponentDescriptor =
  | ReversePropagationComponentDescriptorBase
  | ReversePropagationMaintenanceModuleDescriptor

export interface ReversePropagationStateChannelDescriptor {
  id: string
  title: string
  summary: string
  producers: string[]
  consumers: string[]
}

export interface ReversePropagationRecipeDescriptor {
  id: string
  title: string
  summary: string
  caseMethodID: string
  judgeMethodID: string
  maintenanceMethodID: string
  executionStrategyID: ExecutionStrategyID
  packetizationPolicyID: PacketizationPolicyID
  maintenanceModuleID: string
  contractStyleID: string
  maintenanceRoundsPolicy: "single_round" | "config_max_rounds"
  includePreviousRoundsInMaintainer: boolean
  constraintPolicyIDs: string[]
  routingPolicyIDs: string[]
  acceptancePolicyID: string
  batchPostJudgeStrategyID?: string
  governanceStrategyID?: string
  optimizationStrategyID?: string
  reusableInLayer3: boolean
}
