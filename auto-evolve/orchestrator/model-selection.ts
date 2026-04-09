import type { AutoEvolveConfig, ExecutionSpec, ModelPhase, ModelSelection } from "./schema"

export function resolveModelSelection(
  config: AutoEvolveConfig,
  phase: ModelPhase,
  execution?: ExecutionSpec,
): ModelSelection {
  const phaseDefaults = config.modelConfig.phases[phase] ?? {}
  return {
    model: execution?.model ?? phaseDefaults.model ?? config.modelConfig.defaults.model,
    agent: execution?.agent ?? phaseDefaults.agent ?? config.modelConfig.defaults.agent,
    variant: execution?.variant ?? phaseDefaults.variant ?? config.modelConfig.defaults.variant,
  }
}
