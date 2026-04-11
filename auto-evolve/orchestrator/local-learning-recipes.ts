import {
  isParallelBatchExecutionStrategy,
  resolveExecutionStrategy,
  type ExecutionStrategyID,
} from "./execution-strategies"
import { resolvePacketizationPolicy, type PacketizationPolicyID } from "./packetization-policies"
import { resolveReversePropagationRecipe } from "./reverse-propagation-control/recipes"

export interface LocalLearningRecipe {
  methodID: string
  caseMethodID: string
  maintenanceMethodID: string
  reversePropagationModuleID: string
  executionStrategyID: ExecutionStrategyID
  packetizationPolicyID: PacketizationPolicyID
  batchPostJudgeStrategyID: string
}

export function resolveLocalLearningRecipe(methodID: string): LocalLearningRecipe {
  const registered = resolveReversePropagationRecipe(methodID)
  if (registered) {
    return {
      methodID: registered.id,
      caseMethodID: registered.caseMethodID,
      maintenanceMethodID: registered.maintenanceMethodID,
      reversePropagationModuleID: registered.maintenanceModuleID,
      executionStrategyID: registered.executionStrategyID,
      packetizationPolicyID: registered.packetizationPolicyID,
      batchPostJudgeStrategyID:
        registered.batchPostJudgeStrategyID ??
        (registered.acceptancePolicyID === "add-only-conservative-guard"
          ? "add-only-batch-conservative-guard"
          : "strict-batch-improvement-guard"),
    }
  }

  return {
    methodID,
    caseMethodID: methodID,
    maintenanceMethodID: methodID,
    reversePropagationModuleID: "direct-rewrite",
    executionStrategyID: "sequential",
    packetizationPolicyID: "single-case-packet",
    batchPostJudgeStrategyID: "strict-batch-improvement-guard",
  }
}

export function resolveLocalLearningRecipeBatchSize(recipe: LocalLearningRecipe) {
  const executionStrategy = resolveExecutionStrategy(recipe.executionStrategyID)
  const packetizationPolicy = resolvePacketizationPolicy(recipe.packetizationPolicyID)
  return Math.max(executionStrategy.defaultBatchSize, packetizationPolicy.defaultBatchSize)
}

export { isParallelBatchExecutionStrategy }
