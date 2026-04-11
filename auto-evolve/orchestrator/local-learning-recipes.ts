import {
  isParallelBatchExecutionStrategy,
  resolveExecutionStrategy,
  type ExecutionStrategyID,
} from "./execution-strategies"
import { resolvePacketizationPolicy, type PacketizationPolicyID } from "./packetization-policies"

export interface LocalLearningRecipe {
  methodID: string
  caseMethodID: string
  maintenanceMethodID: string
  reversePropagationModuleID: string
  executionStrategyID: ExecutionStrategyID
  packetizationPolicyID: PacketizationPolicyID
  batchPostJudgeStrategyID: string
}

const RECIPES = new Map<string, LocalLearningRecipe>([
  [
    "sequential-refine",
    {
      methodID: "sequential-refine",
      caseMethodID: "sequential-refine",
      maintenanceMethodID: "sequential-refine",
      reversePropagationModuleID: "direct-rewrite",
      executionStrategyID: "sequential",
      packetizationPolicyID: "single-case-packet",
      batchPostJudgeStrategyID: "strict-batch-improvement-guard",
    },
  ],
  [
    "add-only",
    {
      methodID: "add-only",
      caseMethodID: "add-only",
      maintenanceMethodID: "add-only",
      reversePropagationModuleID: "add-only-memory",
      executionStrategyID: "sequential",
      packetizationPolicyID: "single-case-packet",
      batchPostJudgeStrategyID: "add-only-batch-conservative-guard",
    },
  ],
  [
    "parallel-batch-5-add-only",
    {
      methodID: "parallel-batch-5-add-only",
      caseMethodID: "parallel-batch-5-add-only",
      maintenanceMethodID: "add-only",
      reversePropagationModuleID: "add-only-memory",
      executionStrategyID: "parallel-batch-5-light-shard",
      packetizationPolicyID: "batch-5-aggregate",
      batchPostJudgeStrategyID: "add-only-batch-conservative-guard",
    },
  ],
])

export function resolveLocalLearningRecipe(methodID: string): LocalLearningRecipe {
  return (
    RECIPES.get(methodID) ?? {
      methodID,
      caseMethodID: methodID,
      maintenanceMethodID: methodID,
      reversePropagationModuleID: "direct-rewrite",
      executionStrategyID: "sequential",
      packetizationPolicyID: "single-case-packet",
      batchPostJudgeStrategyID: "strict-batch-improvement-guard",
    }
  )
}

export function resolveLocalLearningRecipeBatchSize(recipe: LocalLearningRecipe) {
  const executionStrategy = resolveExecutionStrategy(recipe.executionStrategyID)
  const packetizationPolicy = resolvePacketizationPolicy(recipe.packetizationPolicyID)
  return Math.max(executionStrategy.defaultBatchSize, packetizationPolicy.defaultBatchSize)
}

export { isParallelBatchExecutionStrategy }
