import { autoEvolvePath, pathExists, readTextFile } from "../fs"
import type { AutoEvolveConfig } from "../schema"
import {
  listRegisteredMaintenanceModules,
  resolveRegisteredMaintenanceModule,
} from "../reverse-propagation-control/registry"

export interface ReversePropagationModuleDescriptor {
  id: string
  title: string
  summary: string
  defaultLoadingStrategyID: string
  defaultScopeLevelID: string
  defaultOperationIDs?: string[]
}

export interface ResolvedReversePropagationModule {
  descriptor: ReversePropagationModuleDescriptor
  promptPath: string
  promptBody: string
}

export function listReversePropagationModules() {
  return listRegisteredMaintenanceModules().map((item) => ({
    id: item.id,
    title: item.title,
    summary: item.summary,
    defaultLoadingStrategyID: item.defaultLoadingStrategyID,
    defaultScopeLevelID: item.defaultScopeLevelID,
    defaultOperationIDs: item.defaultOperationIDs,
  }))
}

function resolveReversePropagationModuleDescriptor(moduleID?: string) {
  const target = moduleID ?? "direct-rewrite"
  try {
    const found = resolveRegisteredMaintenanceModule(target)
    return {
      id: found.id,
      title: found.title,
      summary: found.summary,
      defaultLoadingStrategyID: found.defaultLoadingStrategyID,
      defaultScopeLevelID: found.defaultScopeLevelID,
      defaultOperationIDs: found.defaultOperationIDs,
    } satisfies ReversePropagationModuleDescriptor
  } catch {}
  return {
    id: target,
    title: target,
    summary: "Custom reverse-propagation module loaded from the project module directory.",
    defaultLoadingStrategyID: "full-workspace-read-via-entry",
    defaultScopeLevelID: "full-access",
  } satisfies ReversePropagationModuleDescriptor
}

export async function resolveReversePropagationModule(
  cwd: string,
  config: AutoEvolveConfig,
  moduleID?: string,
): Promise<ResolvedReversePropagationModule> {
  const descriptor = resolveReversePropagationModuleDescriptor(moduleID)
  const promptPath = autoEvolvePath(cwd, config.reversePropagationModulesDir, `${descriptor.id}.md`)
  if (!(await pathExists(promptPath))) {
    throw new Error(`Reverse-propagation module file is missing: ${promptPath}`)
  }
  return {
    descriptor,
    promptPath,
    promptBody: await readTextFile(promptPath),
  }
}
