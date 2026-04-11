import type { ReversePropagationRecipeDescriptor } from "./contract"

const RECIPES = new Map<string, ReversePropagationRecipeDescriptor>([
  [
    "sequential-refine",
    {
      id: "sequential-refine",
      title: "Sequential Refine Recipe",
      summary:
        "Sequentially solve one case, packetize one failure, and maintain the workspace through direct rewrite under a strict regression guard.",
      caseMethodID: "sequential-refine",
      judgeMethodID: "sequential-refine",
      maintenanceMethodID: "sequential-refine",
      executionStrategyID: "sequential",
      packetizationPolicyID: "single-case-packet",
      maintenanceModuleID: "direct-rewrite",
      contractStyleID: "direct-rewrite-baseline",
      maintenanceRoundsPolicy: "single_round",
      includePreviousRoundsInMaintainer: false,
      constraintPolicyIDs: ["no-extra-constraint"],
      routingPolicyIDs: ["default-judge-routing"],
      acceptancePolicyID: "strict-regression-guard",
      batchPostJudgeStrategyID: "strict-batch-improvement-guard",
      governanceStrategyID: "single-branch-governance",
      reusableInLayer3: true,
    },
  ],
  [
    "add-only",
    {
      id: "add-only",
      title: "Add-Only Recipe",
      summary:
        "Sequentially solve one case, packetize one failure, and maintain the workspace through additive memory under a conservative guard.",
      caseMethodID: "add-only",
      judgeMethodID: "add-only",
      maintenanceMethodID: "add-only",
      executionStrategyID: "sequential",
      packetizationPolicyID: "single-case-packet",
      maintenanceModuleID: "add-only-memory",
      contractStyleID: "add-only-conservative",
      maintenanceRoundsPolicy: "config_max_rounds",
      includePreviousRoundsInMaintainer: true,
      constraintPolicyIDs: ["no-extra-constraint"],
      routingPolicyIDs: ["default-judge-routing"],
      acceptancePolicyID: "add-only-conservative-guard",
      batchPostJudgeStrategyID: "add-only-batch-conservative-guard",
      governanceStrategyID: "single-branch-governance",
      reusableInLayer3: true,
    },
  ],
  [
    "parallel-batch-5-add-only",
    {
      id: "parallel-batch-5-add-only",
      title: "Parallel Batch-5 Add-Only Recipe",
      summary:
        "Run five light shards in parallel, aggregate one batch learning packet, then perform one add-only maintenance transaction.",
      caseMethodID: "parallel-batch-5-add-only",
      judgeMethodID: "parallel-batch-5-add-only",
      maintenanceMethodID: "add-only",
      executionStrategyID: "parallel-batch-5-light-shard",
      packetizationPolicyID: "batch-5-aggregate",
      maintenanceModuleID: "add-only-memory",
      contractStyleID: "add-only-conservative",
      maintenanceRoundsPolicy: "config_max_rounds",
      includePreviousRoundsInMaintainer: true,
      constraintPolicyIDs: ["no-extra-constraint"],
      routingPolicyIDs: ["default-judge-routing", "batch-aggregate-routing"],
      acceptancePolicyID: "add-only-conservative-guard",
      batchPostJudgeStrategyID: "add-only-batch-conservative-guard",
      governanceStrategyID: "single-branch-governance",
      reusableInLayer3: true,
    },
  ],
])

export function resolveReversePropagationRecipe(recipeID: string) {
  return RECIPES.get(recipeID)
}

export function listReversePropagationRecipes() {
  return [...RECIPES.values()]
}
