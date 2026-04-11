export type ExecutionStrategyID = "sequential" | "parallel-batch-5-light-shard"

export type PacketizationPolicyID = "single-case-packet" | "batch-5-aggregate"

export interface LocalLearningRecipe {
  methodID: string
  caseMethodID: string
  maintenanceMethodID: string
  reversePropagationModuleID: string
  executionStrategyID: ExecutionStrategyID
  packetizationPolicyID: PacketizationPolicyID
  batchPostJudgeStrategyID: string
  batchSize: number
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
      batchSize: 1,
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
      batchSize: 1,
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
      batchSize: 5,
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
      batchSize: 1,
    }
  )
}

export function isParallelBatchExecutionStrategy(strategyID: ExecutionStrategyID) {
  return strategyID === "parallel-batch-5-light-shard"
}
