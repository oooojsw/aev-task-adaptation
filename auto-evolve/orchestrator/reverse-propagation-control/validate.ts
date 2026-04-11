import { resolveExecutionStrategy } from "../execution-strategies"
import { methodPaths } from "../methods"
import { resolvePacketizationPolicy } from "../packetization-policies"
import { resolveBatchPostJudgeStrategy } from "../batch-post-judge"
import { listReversePropagationRecipes } from "./recipes"
import {
  listReversePropagationComponents,
  listReversePropagationStateChannels,
  resolveReversePropagationComponent,
  resolveRegisteredMaintenanceModule,
} from "./registry"
import { pathExists } from "../fs"
import type { AutoEvolveConfig } from "../schema"

export interface ReversePropagationControlPlaneValidationReport {
  componentCount: number
  recipeCount: number
  stateChannelCount: number
  errors: string[]
}

function validateComponentCategory(componentID: string, expectedCategory: string, errors: string[]) {
  try {
    const component = resolveReversePropagationComponent(componentID)
    if (component.category !== expectedCategory) {
      errors.push(
        `Component ${componentID} has category ${component.category}, expected ${expectedCategory}.`,
      )
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
}

export async function validateReversePropagationControlPlane(
  cwd?: string,
  config?: Pick<AutoEvolveConfig, "methodsDir">,
): Promise<ReversePropagationControlPlaneValidationReport> {
  const components = listReversePropagationComponents()
  const recipes = listReversePropagationRecipes()
  const stateChannels = listReversePropagationStateChannels()
  const errors: string[] = []

  for (const recipe of recipes) {
    try {
      resolveExecutionStrategy(recipe.executionStrategyID)
    } catch (error) {
      errors.push(`Recipe ${recipe.id} references invalid execution strategy: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      resolvePacketizationPolicy(recipe.packetizationPolicyID)
    } catch (error) {
      errors.push(`Recipe ${recipe.id} references invalid packetization policy: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      resolveRegisteredMaintenanceModule(recipe.maintenanceModuleID)
    } catch (error) {
      errors.push(`Recipe ${recipe.id} references invalid maintenance module: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (cwd && config) {
      for (const [label, methodID] of [
        ["caseMethodID", recipe.caseMethodID],
        ["judgeMethodID", recipe.judgeMethodID],
        ["maintenanceMethodID", recipe.maintenanceMethodID],
      ] as const) {
        const paths = methodPaths(cwd, { methodsDir: config.methodsDir, defaultMethod: recipe.id } as AutoEvolveConfig, methodID)
        if (!(await pathExists(paths.root))) {
          errors.push(`Recipe ${recipe.id} references missing ${label} method directory: ${methodID}`)
        }
      }
    }

    for (const componentID of recipe.constraintPolicyIDs) {
      validateComponentCategory(componentID, "constraint_policy", errors)
    }
    for (const componentID of recipe.routingPolicyIDs) {
      validateComponentCategory(componentID, "routing_policy", errors)
    }
    validateComponentCategory(recipe.acceptancePolicyID, "acceptance_policy", errors)
    if (recipe.governanceStrategyID) {
      validateComponentCategory(recipe.governanceStrategyID, "governance_strategy", errors)
    }
    if (recipe.optimizationStrategyID) {
      validateComponentCategory(recipe.optimizationStrategyID, "optimization_strategy", errors)
    }
    if (recipe.batchPostJudgeStrategyID) {
      try {
        resolveBatchPostJudgeStrategy(recipe.batchPostJudgeStrategyID)
      } catch (error) {
        errors.push(
          `Recipe ${recipe.id} references invalid batch post-judge strategy: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  for (const channel of stateChannels) {
    for (const componentID of [...channel.producers, ...channel.consumers]) {
      try {
        resolveReversePropagationComponent(componentID)
      } catch (error) {
        errors.push(
          `State channel ${channel.id} references unknown component ${componentID}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  return {
    componentCount: components.length,
    recipeCount: recipes.length,
    stateChannelCount: stateChannels.length,
    errors,
  }
}
