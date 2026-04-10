import path from "node:path"
import type { LoadedCase } from "../schema"
import type { ExperienceWorkspaceLayout, ExperienceWorkspaceSnapshot, TemplateLibraryPaths } from "../experience-workspace"
import type { KnowledgeMaintainerInputPaths, KnowledgeMaintainerSessionReportRef } from "./contract"

export interface KnowledgeMaintainerLoadingStrategyDescriptor {
  id: string
  title: string
  summary: string
  guidance: string[]
}

export interface KnowledgeMaintainerLoadingStrategyResolvedPaths {
  referencePaths: string[]
  permissionReadPaths: string[]
}

export interface KnowledgeMaintainerLoadingStrategyRuntimeInput {
  workspace: ExperienceWorkspaceLayout
  workspaceSnapshot: ExperienceWorkspaceSnapshot
  templateLibrary: TemplateLibraryPaths
  loadedCase: LoadedCase
  inputPaths: KnowledgeMaintainerInputPaths
  sessionReports: KnowledgeMaintainerSessionReportRef[]
}

export interface KnowledgeMaintainerLoadingStrategy {
  descriptor: KnowledgeMaintainerLoadingStrategyDescriptor
  collectPaths(input: KnowledgeMaintainerLoadingStrategyRuntimeInput): KnowledgeMaintainerLoadingStrategyResolvedPaths
}

function dedupePaths(items: string[]) {
  return [...new Set(items.filter(Boolean))]
}

const FULL_WORKSPACE_READ_VIA_ENTRY: KnowledgeMaintainerLoadingStrategy = {
  descriptor: {
    id: "full-workspace-read-via-entry",
    title: "Full Workspace Read Via Entry",
    summary:
      "Default loading strategy. The maintainer should start from the single entry file, but the whole current workspace remains readable if needed.",
    guidance: [
      "Start from the workspace entry file before exploring downstream modules.",
      "All current workspace Markdown files are readable in this default mode.",
      "Selective reading is still preferred even though full read access is available.",
      "Failure-context files, template files, and selected session reports are also readable.",
    ],
  },
  collectPaths(input) {
    const workspaceFiles = Object.keys(input.workspaceSnapshot).map((relative) =>
      path.join(input.workspace.root, ...relative.split("/")),
    )
    const materialPaths = input.loadedCase.spec.materials.map((item) => path.join(input.loadedCase.caseDir, item.path))
    const items = dedupePaths([
      input.workspace.root,
      input.workspace.entryPath,
      ...workspaceFiles,
      input.templateLibrary.root,
      ...input.templateLibrary.files,
      input.inputPaths.baselinePath,
      input.inputPaths.scriptsDir,
      ...materialPaths,
      input.inputPaths.expectedPath,
      input.inputPaths.actualPath,
      input.inputPaths.evaluationPath,
      input.inputPaths.actionTracePath,
      input.inputPaths.judgeSummaryPath ?? "",
      input.inputPaths.judgeReportPath ?? "",
      ...input.sessionReports.map((item) => item.absolutePath),
    ])

    return {
      referencePaths: items,
      permissionReadPaths: items,
    }
  },
}

const BUILTIN_LOADING_STRATEGIES = [FULL_WORKSPACE_READ_VIA_ENTRY]

export function listKnowledgeMaintainerLoadingStrategies() {
  return BUILTIN_LOADING_STRATEGIES.map((item) => item.descriptor)
}

export function resolveKnowledgeMaintainerLoadingStrategy(strategyID?: string) {
  const target = strategyID ?? FULL_WORKSPACE_READ_VIA_ENTRY.descriptor.id
  const found = BUILTIN_LOADING_STRATEGIES.find((item) => item.descriptor.id === target)
  if (!found) {
    throw new Error(`Unknown knowledge maintainer loading strategy: ${target}`)
  }
  return found
}
