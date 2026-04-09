import path from "node:path"
import { autoEvolvePath, ensureDirectory, readTextFile, writeTextFile } from "./fs"
import type { AutoEvolveConfig } from "./schema"

export const KNOWLEDGE_PACK_RELATIVE_FILES = [
  "manifest.md",
  "core/expert_rules.md",
  "core/output_contract.md",
  "core/execution_checklist.md",
  "patterns/general_rules.md",
  "patterns/exceptions.md",
  "lessons/failure_lessons.md",
  "change_log.md",
] as const

export interface KnowledgePackPaths {
  root: string
  manifestPath: string
  coreExpertRulesPath: string
  outputContractPath: string
  executionChecklistPath: string
  generalRulesPath: string
  exceptionsPath: string
  failureLessonsPath: string
  changeLogPath: string
  files: string[]
}

export type KnowledgePackSnapshot = Record<string, string>

function entries(paths: KnowledgePackPaths) {
  return [
    ["manifest.md", paths.manifestPath],
    ["core/expert_rules.md", paths.coreExpertRulesPath],
    ["core/output_contract.md", paths.outputContractPath],
    ["core/execution_checklist.md", paths.executionChecklistPath],
    ["patterns/general_rules.md", paths.generalRulesPath],
    ["patterns/exceptions.md", paths.exceptionsPath],
    ["lessons/failure_lessons.md", paths.failureLessonsPath],
    ["change_log.md", paths.changeLogPath],
  ] as const
}

export function knowledgePackPaths(cwd: string, config: AutoEvolveConfig): KnowledgePackPaths {
  const root = autoEvolvePath(cwd, config.knowledgeDir)
  return {
    root,
    manifestPath: path.join(root, "manifest.md"),
    coreExpertRulesPath: path.join(root, "core", "expert_rules.md"),
    outputContractPath: path.join(root, "core", "output_contract.md"),
    executionChecklistPath: path.join(root, "core", "execution_checklist.md"),
    generalRulesPath: path.join(root, "patterns", "general_rules.md"),
    exceptionsPath: path.join(root, "patterns", "exceptions.md"),
    failureLessonsPath: path.join(root, "lessons", "failure_lessons.md"),
    changeLogPath: path.join(root, "change_log.md"),
    files: KNOWLEDGE_PACK_RELATIVE_FILES.map((item) => path.join(root, item)),
  }
}

export async function readKnowledgePack(paths: KnowledgePackPaths): Promise<KnowledgePackSnapshot> {
  const snapshot: KnowledgePackSnapshot = {}
  for (const [relative, absolute] of entries(paths)) {
    snapshot[relative] = await readTextFile(absolute)
  }
  return snapshot
}

export function diffKnowledgePack(before: KnowledgePackSnapshot, after: KnowledgePackSnapshot) {
  return Object.keys(before)
    .filter((relative) => before[relative] !== after[relative])
    .sort((left, right) => left.localeCompare(right))
}

export async function restoreKnowledgePack(paths: KnowledgePackPaths, snapshot: KnowledgePackSnapshot) {
  for (const [relative, absolute] of entries(paths)) {
    await writeTextFile(absolute, snapshot[relative] ?? "")
  }
}

export async function writeKnowledgePackSnapshot(targetDir: string, snapshot: KnowledgePackSnapshot) {
  await ensureDirectory(targetDir)
  for (const [relative, content] of Object.entries(snapshot)) {
    await writeTextFile(path.join(targetDir, relative), content)
  }
}
