import { autoEvolvePath, pathExists, readTextFile } from "../fs"
import type { AutoEvolveConfig } from "../schema"

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

const BUILTIN_MODULE_DESCRIPTORS: ReversePropagationModuleDescriptor[] = [
  {
    id: "direct-rewrite",
    title: "Direct Rewrite",
    summary:
      "Directly revise the current experience workspace into a better single canonical version. This is the current baseline reverse-propagation module.",
    defaultLoadingStrategyID: "full-workspace-read-via-entry",
    defaultScopeLevelID: "full-access",
  },
  {
    id: "add-only-memory",
    title: "Add-Only Memory",
    summary:
      "Preserve existing experience and prefer additive maintenance: append clarifications, add lessons, add guides, and create new small modules without broad rewrites.",
    defaultLoadingStrategyID: "full-workspace-read-via-entry",
    defaultScopeLevelID: "full-access",
    defaultOperationIDs: [
      "inspect_workspace",
      "inspect_templates",
      "inspect_failure_context",
      "inspect_session_records",
      "append_to_existing_module",
      "create_module",
      "add_tool_guide",
      "add_failure_lesson",
      "rewrite_entry_navigation",
      "record_change",
    ],
  },
]

export function listReversePropagationModules() {
  return [...BUILTIN_MODULE_DESCRIPTORS]
}

function resolveReversePropagationModuleDescriptor(moduleID?: string) {
  const target = moduleID ?? "direct-rewrite"
  const found = BUILTIN_MODULE_DESCRIPTORS.find((item) => item.id === target)
  if (found) return found
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
