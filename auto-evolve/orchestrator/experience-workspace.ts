import path from "node:path"
import { readdir, rm } from "node:fs/promises"
import { autoEvolvePath, ensureDirectory, pathExists, readTextFile, writeTextFile } from "./fs"
import type { AutoEvolveConfig } from "./schema"

export type ExperienceWorkspaceRole =
  | "entry"
  | "change_log"
  | "rule_module"
  | "output_contract"
  | "execution_checklist"
  | "exception_module"
  | "failure_lessons"
  | "tool_guide"
  | "partition_index"
  | "task_router"
  | string

export interface ExperienceWorkspacePaths {
  root: string
  defaultEntryRelativePath: string
  defaultEntryPath: string
}

export interface ExperienceWorkspaceDocument {
  relativePath: string
  absolutePath: string
  content: string
  role?: ExperienceWorkspaceRole
  isEntry: boolean
}

export interface ExperienceWorkspaceLayout extends ExperienceWorkspacePaths {
  entryRelativePath: string
  entryPath: string
  documents: ExperienceWorkspaceDocument[]
  nonMarkdownFiles: string[]
}

export interface ExperienceWorkspaceValidation {
  valid: boolean
  errors: string[]
}

export type ExperienceWorkspaceSnapshot = Record<string, string>

const ENTRY_MARKER = /<!--\s*auto-evolve-entry:\s*(true|yes|1)\s*-->/i
const ROLE_MARKER = /<!--\s*auto-evolve-role:\s*([a-z0-9_\-/]+)\s*-->/i
const ENTRY_FILE_CANDIDATES = ["manifest.md", "README.md", "index.md", "ENTRY.md"]

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function normalizeRole(rawRole: string | undefined, relativePath: string): ExperienceWorkspaceRole | undefined {
  if (!rawRole?.trim()) return inferRoleFromPath(relativePath)

  switch (rawRole.trim().toLowerCase()) {
    case "expert_rules":
    case "pattern_general":
      return "rule_module"
    case "pattern_exception":
      return "exception_module"
    case "output_contract":
      return "output_contract"
    case "execution_checklist":
      return "execution_checklist"
    case "failure_lessons":
      return "failure_lessons"
    case "tool_guide":
      return "tool_guide"
    case "partition_index":
      return "partition_index"
    case "task_router":
      return "task_router"
    case "change_log":
      return "change_log"
    case "entry":
      return "entry"
    default:
      return rawRole.trim().toLowerCase()
  }
}

async function collectWorkspaceFiles(root: string, current = root): Promise<string[]> {
  if (!(await pathExists(current))) return []
  const entries = await readdir(current, { withFileTypes: true })
  const results: string[] = []

  for (const entry of entries) {
    const absolute = path.join(current, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await collectWorkspaceFiles(root, absolute)))
      continue
    }
    if (!entry.isFile()) continue
    results.push(normalizeSlash(path.relative(root, absolute)))
  }

  return results.sort((left, right) => left.localeCompare(right))
}

async function collectMarkdownFiles(root: string) {
  const files = await collectWorkspaceFiles(root)
  return files.filter((relative) => relative.toLowerCase().endsWith(".md"))
}

function inferRoleFromPath(relativePath: string): ExperienceWorkspaceRole | undefined {
  const normalized = normalizeSlash(relativePath)
  const filename = path.posix.basename(normalized).toLowerCase()
  const dirname = path.posix.dirname(normalized)

  switch (normalized) {
    case "manifest.md":
    case "README.md":
    case "index.md":
    case "ENTRY.md":
      return "entry"
    case "change_log.md":
      return "change_log"
    case "core/expert_rules.md":
    case "patterns/general_rules.md":
      return "rule_module"
    case "core/output_contract.md":
      return "output_contract"
    case "core/execution_checklist.md":
      return "execution_checklist"
    case "patterns/exceptions.md":
      return "exception_module"
    case "lessons/failure_lessons.md":
      return "failure_lessons"
    default:
      break
  }

  if (filename.includes("output-contract") || filename.includes("output_contract")) return "output_contract"
  if (filename.includes("execution-checklist") || filename.includes("execution_checklist")) return "execution_checklist"
  if (filename.includes("failure-lessons") || filename.includes("failure_lessons")) return "failure_lessons"
  if (filename.includes("tool-guide") || filename.includes("tool_guide")) return "tool_guide"
  if (filename.includes("partition-index") || filename.includes("partition_index")) return "partition_index"
  if (filename.includes("task-router") || filename.includes("task_router")) return "task_router"
  if (filename.includes("exception")) return "exception_module"
  if (filename.includes("rule")) return "rule_module"
  if (dirname.includes("/guides")) return "tool_guide"
  if (dirname.includes("/partitions")) return "partition_index"

  return undefined
}

function parseDocumentMeta(relativePath: string, absolutePath: string, content: string): ExperienceWorkspaceDocument {
  const rawRole = ROLE_MARKER.exec(content)?.[1]
  const role = normalizeRole(rawRole, relativePath)
  const isEntry = ENTRY_MARKER.test(content)

  return {
    relativePath,
    absolutePath,
    content,
    role,
    isEntry,
  }
}

function selectWorkspaceEntryDocument(paths: ExperienceWorkspacePaths, documents: ExperienceWorkspaceDocument[]) {
  const explicitRelative = normalizeSlash(paths.defaultEntryRelativePath)
  const markedEntries = documents.filter((item) => item.isEntry)

  if (markedEntries.length > 1) {
    const explicitMarked = markedEntries.find((item) => item.relativePath === explicitRelative)
    if (explicitMarked) return explicitMarked
    throw new Error(
      `Experience workspace has multiple entry-marked Markdown files: ${markedEntries.map((item) => item.relativePath).join(", ")}`,
    )
  }

  if (markedEntries.length === 1) return markedEntries[0]

  const byExplicitPath = documents.find((item) => item.relativePath === explicitRelative)
  if (byExplicitPath) return byExplicitPath

  for (const candidate of ENTRY_FILE_CANDIDATES) {
    const found = documents.find((item) => item.relativePath === candidate)
    if (found) return found
  }

  if (documents.length === 1) return documents[0]
  if (documents.length > 1) return documents[0]

  return {
    relativePath: explicitRelative,
    absolutePath: paths.defaultEntryPath,
    content: "",
    role: "entry",
    isEntry: true,
  } satisfies ExperienceWorkspaceDocument
}

function minimalSeedEntry(relativePath: string) {
  return `<!-- auto-evolve-bootstrap: replaceable -->
<!-- auto-evolve-entry: true -->
<!-- auto-evolve-role: entry -->
# 经验工作区入口

状态：最小种子

## 说明

- 这是经验工作区的唯一入口文件。
- 当前工作区还没有形成最终专家经验结构。
- 第一次 bootstrap 应该先阅读训练案例和模板库，然后自行决定最终结构。

## 当前约束

- 最终工作区必须保留一个且仅一个入口文件。
- 最终工作区只保存最终专家经验，不直接包含模板库内容。
- 未来空白 solve agent 应从本文件开始，再按需选择性读取下游文件。

## 当前入口路径

- ${relativePath}

## 当前状态

- 结构尚未展开
- 规则尚未提炼
- 后续 bootstrap 或经修 agent 需要按案例和方法要求生成正式结构
`
}

function minimalSeedChangeLog() {
  return `<!-- auto-evolve-role: change_log -->
# 变更记录

- 经验工作区已初始化为最小种子。
`
}

export function experienceWorkspacePaths(cwd: string, config: AutoEvolveConfig): ExperienceWorkspacePaths {
  const root = autoEvolvePath(cwd, config.knowledgeDir)
  const defaultEntryRelativePath = normalizeSlash(config.experienceEntryFile)

  return {
    root,
    defaultEntryRelativePath,
    defaultEntryPath: path.join(root, ...defaultEntryRelativePath.split("/")),
  }
}

export function buildMinimalExperienceWorkspaceSeed(paths: ExperienceWorkspacePaths): ExperienceWorkspaceSnapshot {
  return {
    [normalizeSlash(paths.defaultEntryRelativePath)]: minimalSeedEntry(normalizeSlash(paths.defaultEntryRelativePath)),
    "change_log.md": minimalSeedChangeLog(),
  }
}

export async function templateLibraryPaths(cwd: string, config: AutoEvolveConfig) {
  const root = autoEvolvePath(cwd, config.templateLibraryDir)
  return {
    root,
    files: (await collectMarkdownFiles(root)).map((relative) => path.join(root, ...relative.split("/"))),
  }
}

export async function listExperienceWorkspaceFiles(paths: ExperienceWorkspacePaths) {
  return collectMarkdownFiles(paths.root)
}

export async function listExperienceWorkspaceDocuments(paths: ExperienceWorkspacePaths): Promise<ExperienceWorkspaceDocument[]> {
  const files = await collectMarkdownFiles(paths.root)
  const documents: ExperienceWorkspaceDocument[] = []

  for (const relative of files) {
    const absolutePath = path.join(paths.root, ...relative.split("/"))
    const content = await readTextFile(absolutePath)
    documents.push(parseDocumentMeta(relative, absolutePath, content))
  }

  return documents.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

export async function resolveExperienceWorkspaceLayout(paths: ExperienceWorkspacePaths): Promise<ExperienceWorkspaceLayout> {
  const allFiles = await collectWorkspaceFiles(paths.root)
  const nonMarkdownFiles = allFiles.filter((relative) => !relative.toLowerCase().endsWith(".md"))
  const documents = await listExperienceWorkspaceDocuments(paths)
  const entryDocument = selectWorkspaceEntryDocument(paths, documents)

  return {
    ...paths,
    entryRelativePath: entryDocument.relativePath,
    entryPath: entryDocument.absolutePath,
    documents,
    nonMarkdownFiles,
  }
}

export function validateExperienceWorkspaceLayout(layout: ExperienceWorkspaceLayout): ExperienceWorkspaceValidation {
  const errors: string[] = []

  if (!layout.documents.length) {
    errors.push("Experience workspace has no Markdown documents.")
  }

  if (!layout.documents.some((item) => item.relativePath === layout.entryRelativePath)) {
    errors.push(`Experience workspace entry file is missing: ${layout.entryRelativePath}`)
  }

  if (!layout.documents.some((item) => item.role === "change_log")) {
    errors.push("Experience workspace must contain one change-log Markdown file.")
  }

  for (const document of layout.documents) {
    if (!document.role) {
      errors.push(`Experience workspace document is missing an auto-evolve role marker or recognizable role: ${document.relativePath}`)
    }
  }

  if (layout.nonMarkdownFiles.length) {
    errors.push(
      `Experience workspace must remain Markdown-only. Found non-Markdown files: ${layout.nonMarkdownFiles.join(", ")}`,
    )
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

export async function readExperienceWorkspace(paths: ExperienceWorkspacePaths): Promise<ExperienceWorkspaceSnapshot> {
  const snapshot: ExperienceWorkspaceSnapshot = {}
  const files = await listExperienceWorkspaceFiles(paths)
  for (const relative of files) {
    snapshot[relative] = await readTextFile(path.join(paths.root, ...relative.split("/")))
  }
  return snapshot
}

export function diffExperienceWorkspace(before: ExperienceWorkspaceSnapshot, after: ExperienceWorkspaceSnapshot) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((relative) => (before[relative] ?? "") !== (after[relative] ?? ""))
    .sort((left, right) => left.localeCompare(right))
}

export async function restoreExperienceWorkspace(paths: ExperienceWorkspacePaths, snapshot: ExperienceWorkspaceSnapshot) {
  await rm(paths.root, { recursive: true, force: true })
  await ensureDirectory(paths.root)

  for (const [relative, content] of Object.entries(snapshot)) {
    await writeTextFile(path.join(paths.root, ...relative.split("/")), content)
  }
}

export async function seedExperienceWorkspace(paths: ExperienceWorkspacePaths) {
  const snapshot = buildMinimalExperienceWorkspaceSeed(paths)
  await restoreExperienceWorkspace(paths, snapshot)
  return snapshot
}

export async function writeExperienceWorkspaceSnapshot(targetDir: string, snapshot: ExperienceWorkspaceSnapshot) {
  await ensureDirectory(targetDir)
  for (const [relative, content] of Object.entries(snapshot)) {
    await writeTextFile(path.join(targetDir, ...relative.split("/")), content)
  }
}

export function findExperienceWorkspaceDocumentsByRole(
  layout: ExperienceWorkspaceLayout,
  roles: ExperienceWorkspaceRole[],
) {
  const allowed = new Set(roles)
  return layout.documents.filter((item) => item.role && allowed.has(item.role))
}

export function findExperienceWorkspaceDocumentByRole(
  layout: ExperienceWorkspaceLayout,
  role: ExperienceWorkspaceRole,
) {
  return layout.documents.find((item) => item.role === role)
}
