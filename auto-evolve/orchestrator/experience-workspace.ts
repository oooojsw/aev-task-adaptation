import path from "node:path"
import { readdir, rm } from "node:fs/promises"
import { autoEvolvePath, ensureDirectory, pathExists, readJsonFile, readTextFile, writeTextFile } from "./fs"
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
  | "format_standard"
  | "data_mapping"
  | "placeholder_catalog"
  | string

export type ExperienceSurfaceProfile = "operational" | "governed"

export type ExperienceWorkspaceAssetKind =
  | "script"
  | "skill_definition"
  | "helper_document"
  | "tool_manifest"
  | "data"
  | string

export interface ExperienceWorkspacePaths {
  root: string
  defaultEntryRelativePath: string
  defaultEntryPath: string
}

export interface ExperienceSurfaceDocumentContract {
  path: string
  role?: ExperienceWorkspaceRole
  notes?: string[]
}

export interface ExperienceSurfaceContract {
  version: number
  profile?: ExperienceSurfaceProfile
  entry?: string
  changeLog?: string
  documents?: ExperienceSurfaceDocumentContract[]
  formatReference?: string
  dataMappingReference?: string
  placeholderReference?: string
  assetRoots?: string[]
  runtimeSidecarRoots?: string[]
  notes?: string[]
}

export interface ExperienceWorkspaceDocument {
  relativePath: string
  absolutePath: string
  content: string
  role?: ExperienceWorkspaceRole
  isEntry: boolean
  roleSource?: "marker" | "inferred" | "contract"
}

export interface ExperienceWorkspaceAsset {
  relativePath: string
  absolutePath: string
  kind: ExperienceWorkspaceAssetKind
}

export interface ExperienceWorkspaceLayout extends ExperienceWorkspacePaths {
  entryRelativePath: string
  entryPath: string
  documents: ExperienceWorkspaceDocument[]
  assets: ExperienceWorkspaceAsset[]
  controlFiles: string[]
  runtimeSidecarFiles: string[]
  unsupportedFiles: string[]
  surfaceContract: ExperienceSurfaceContract | null
  surfaceContractPath: string | null
  resolvedAssetRoots: string[]
  resolvedRuntimeSidecarRoots: string[]
}

export interface ExperienceWorkspaceValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
  profile: ExperienceSurfaceProfile
  contractPresent: boolean
}

export type ExperienceWorkspaceSnapshot = Record<string, string>

export interface TemplateLibraryPaths {
  root: string
  files: string[]
}

export interface ExperienceWorkspaceValidationOptions {
  profile?: ExperienceSurfaceProfile | "auto"
}

const ENTRY_MARKER = /<!--\s*auto-evolve-entry:\s*(true|yes|1)\s*-->/i
const ROLE_MARKER = /<!--\s*auto-evolve-role:\s*([a-z0-9_\-/]+)\s*-->/i
const ENTRY_FILE_CANDIDATES = ["manifest.md", "README.md", "index.md", "ENTRY.md"]
const DEFAULT_WORKSPACE_ASSET_ROOTS = ["tools", "skills"] as const
const WORKSPACE_ASSET_EXTENSIONS = new Set([".md", ".py", ".ps1", ".json", ".txt", ".toml", ".yaml", ".yml", ".csv"])
const DEFAULT_RUNTIME_SIDECAR_ROOTS = [".opencode"] as const
export const EXPERIENCE_SURFACE_CONTRACT_FILE = "surface_contract.json"

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function normalizeRelativeSurfacePath(input: string) {
  return normalizeSlash(input).replace(/^\.\//, "").replace(/\/+/g, "/")
}

function normalizeRootList(input: string[] | undefined, fallback: readonly string[]) {
  const next = (input ?? [])
    .map((item) => normalizeRelativeSurfacePath(item).replace(/\/+$/, ""))
    .filter((item) => item.length > 0 && !item.startsWith(".."))
  return next.length ? [...new Set(next)] : [...fallback]
}

function normalizeSurfaceProfile(raw: unknown): ExperienceSurfaceProfile | undefined {
  if (typeof raw !== "string") return undefined
  switch (raw.trim().toLowerCase()) {
    case "operational":
      return "operational"
    case "governed":
    case "canonical":
    case "managed":
      return "governed"
    default:
      return undefined
  }
}

function inferRoleFromPath(relativePath: string): ExperienceWorkspaceRole | undefined {
  const normalized = normalizeRelativeSurfacePath(relativePath)
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
    case "format_rules.md":
    case "format_rules_summary.md":
      return "format_standard"
    case "data_mapping.md":
      return "data_mapping"
    case "placeholders.md":
      return "placeholder_catalog"
    default:
      break
  }

  if (filename.includes("format-rule") || filename.includes("format_rule")) return "format_standard"
  if (filename.includes("data-mapping") || filename.includes("data_mapping")) return "data_mapping"
  if (filename.includes("placeholder")) return "placeholder_catalog"
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
    case "format_standard":
      return "format_standard"
    case "data_mapping":
      return "data_mapping"
    case "placeholder_catalog":
      return "placeholder_catalog"
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

function classifyWorkspaceAsset(relativePath: string): ExperienceWorkspaceAssetKind {
  const normalized = normalizeRelativeSurfacePath(relativePath)
  const basename = path.posix.basename(normalized)
  const extension = path.posix.extname(normalized).toLowerCase()

  if (basename === "SKILL.md") return "skill_definition"
  if (extension === ".py" || extension === ".ps1") return "script"
  if (extension === ".json" || extension === ".toml" || extension === ".yaml" || extension === ".yml") {
    return "tool_manifest"
  }
  if (extension === ".md") return "helper_document"
  return "data"
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
    results.push(normalizeRelativeSurfacePath(path.relative(root, absolute)))
  }

  return results.sort((left, right) => left.localeCompare(right))
}

function isWorkspaceAssetPath(relativePath: string, assetRoots: string[]) {
  const normalized = normalizeRelativeSurfacePath(relativePath)
  const firstSegment = normalized.split("/")[0]?.toLowerCase()
  return assetRoots.includes(firstSegment)
}

function isRuntimeSidecarPath(relativePath: string, runtimeSidecarRoots: string[]) {
  const normalized = normalizeRelativeSurfacePath(relativePath)
  const firstSegment = normalized.split("/")[0]?.toLowerCase()
  return runtimeSidecarRoots.includes(firstSegment)
}

function isSupportedWorkspaceAssetPath(relativePath: string, assetRoots: string[]) {
  if (!isWorkspaceAssetPath(relativePath, assetRoots)) return false
  const extension = path.posix.extname(normalizeRelativeSurfacePath(relativePath)).toLowerCase()
  return WORKSPACE_ASSET_EXTENSIONS.has(extension)
}

async function readExperienceSurfaceContract(root: string): Promise<{
  path: string | null
  contract: ExperienceSurfaceContract | null
}> {
  const contractPath = path.join(root, EXPERIENCE_SURFACE_CONTRACT_FILE)
  if (!(await pathExists(contractPath))) {
    return {
      path: null,
      contract: null,
    }
  }

  const raw = await readJsonFile<Record<string, unknown>>(contractPath)
  const documents = Array.isArray(raw.documents)
    ? raw.documents
        .filter((item): item is Record<string, unknown> => typeof item === "object" && !!item)
        .map((item) => ({
          path: normalizeRelativeSurfacePath(String(item.path ?? "")).trim(),
          role: typeof item.role === "string" ? normalizeRole(item.role, String(item.path ?? "")) : undefined,
          notes: Array.isArray(item.notes) ? item.notes.filter((note): note is string => typeof note === "string") : undefined,
        }))
        .filter((item) => item.path.length > 0)
    : []

  const appendLegacyReference = (rawPath: unknown, role: ExperienceWorkspaceRole) => {
    if (typeof rawPath !== "string" || !rawPath.trim()) return
    const normalized = normalizeRelativeSurfacePath(rawPath)
    if (documents.some((item) => item.path === normalized)) return
    documents.push({
      path: normalized,
      role,
      notes: ["Imported from legacy surface-contract reference field for compatibility."],
    })
  }

  appendLegacyReference(raw.formatReference, "format_standard")
  appendLegacyReference(raw.dataMappingReference, "data_mapping")
  appendLegacyReference(raw.placeholderReference, "placeholder_catalog")

  return {
    path: EXPERIENCE_SURFACE_CONTRACT_FILE,
    contract: {
      version: typeof raw.version === "number" ? raw.version : 1,
      profile: normalizeSurfaceProfile(raw.profile),
      entry: typeof raw.entry === "string" ? normalizeRelativeSurfacePath(raw.entry) : undefined,
      changeLog: typeof raw.changeLog === "string" ? normalizeRelativeSurfacePath(raw.changeLog) : undefined,
      documents: documents.length ? documents : undefined,
      formatReference:
        typeof raw.formatReference === "string" && raw.formatReference.trim()
          ? normalizeRelativeSurfacePath(raw.formatReference)
          : undefined,
      dataMappingReference:
        typeof raw.dataMappingReference === "string" && raw.dataMappingReference.trim()
          ? normalizeRelativeSurfacePath(raw.dataMappingReference)
          : undefined,
      placeholderReference:
        typeof raw.placeholderReference === "string" && raw.placeholderReference.trim()
          ? normalizeRelativeSurfacePath(raw.placeholderReference)
          : undefined,
      assetRoots: Array.isArray(raw.assetRoots) ? raw.assetRoots.filter((item): item is string => typeof item === "string") : undefined,
      runtimeSidecarRoots: Array.isArray(raw.runtimeSidecarRoots)
        ? raw.runtimeSidecarRoots.filter((item): item is string => typeof item === "string")
        : undefined,
      notes: Array.isArray(raw.notes) ? raw.notes.filter((item): item is string => typeof item === "string") : undefined,
    },
  }
}

function buildContractDocumentMap(contract: ExperienceSurfaceContract | null) {
  const next = new Map<string, ExperienceSurfaceDocumentContract>()
  for (const document of contract?.documents ?? []) {
    next.set(normalizeRelativeSurfacePath(document.path), {
      path: normalizeRelativeSurfacePath(document.path),
      role: document.role,
      notes: document.notes,
    })
  }
  return next
}

function resolveSurfaceRoots(contract: ExperienceSurfaceContract | null) {
  return {
    assetRoots: normalizeRootList(contract?.assetRoots, DEFAULT_WORKSPACE_ASSET_ROOTS),
    runtimeSidecarRoots: normalizeRootList(contract?.runtimeSidecarRoots, DEFAULT_RUNTIME_SIDECAR_ROOTS),
  }
}

async function collectMarkdownFiles(root: string) {
  const files = await collectWorkspaceFiles(root)
  const { contract } = await readExperienceSurfaceContract(root)
  const { runtimeSidecarRoots } = resolveSurfaceRoots(contract)
  return files.filter((relative) => relative.toLowerCase().endsWith(".md") && !isRuntimeSidecarPath(relative, runtimeSidecarRoots))
}

function collectWorkspaceDocumentFiles(files: string[], runtimeSidecarRoots: string[]) {
  return files.filter((relative) => relative.toLowerCase().endsWith(".md") && !isRuntimeSidecarPath(relative, runtimeSidecarRoots))
}

function collectWorkspaceAssetFiles(files: string[], assetRoots: string[], runtimeSidecarRoots: string[]) {
  return files.filter(
    (relative) => !isRuntimeSidecarPath(relative, runtimeSidecarRoots) && isSupportedWorkspaceAssetPath(relative, assetRoots),
  )
}

function collectRuntimeSidecarFiles(files: string[], runtimeSidecarRoots: string[]) {
  return files.filter((relative) => isRuntimeSidecarPath(relative, runtimeSidecarRoots))
}

function parseDocumentMeta(
  relativePath: string,
  absolutePath: string,
  content: string,
  declared: ExperienceSurfaceDocumentContract | undefined,
  explicitEntryRelativePath: string | undefined,
): ExperienceWorkspaceDocument {
  const rawRole = ROLE_MARKER.exec(content)?.[1]
  const markerRole = rawRole ? normalizeRole(rawRole, relativePath) : undefined
  const inferredRole = markerRole ? undefined : inferRoleFromPath(relativePath)
  const contractRole = markerRole || inferredRole ? undefined : declared?.role
  const role = markerRole ?? inferredRole ?? contractRole

  return {
    relativePath,
    absolutePath,
    content,
    role,
    isEntry:
      ENTRY_MARKER.test(content) ||
      (!!explicitEntryRelativePath && normalizeRelativeSurfacePath(relativePath) === explicitEntryRelativePath),
    roleSource: markerRole ? "marker" : inferredRole ? "inferred" : contractRole ? "contract" : undefined,
  }
}

function selectWorkspaceEntryDocument(
  paths: ExperienceWorkspacePaths,
  documents: ExperienceWorkspaceDocument[],
  contract: ExperienceSurfaceContract | null,
) {
  const explicitRelative = normalizeRelativeSurfacePath(paths.defaultEntryRelativePath)
  const contractEntry = contract?.entry ? normalizeRelativeSurfacePath(contract.entry) : undefined
  const markedEntries = documents.filter((item) => item.isEntry)

  if (contractEntry) {
    const declared = documents.find((item) => item.relativePath === contractEntry)
    if (declared) return declared
    return {
      relativePath: contractEntry,
      absolutePath: path.join(paths.root, ...contractEntry.split("/")),
      content: "",
      role: "entry",
      isEntry: true,
      roleSource: "contract",
    } satisfies ExperienceWorkspaceDocument
  }

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
    roleSource: "inferred",
  } satisfies ExperienceWorkspaceDocument
}

function minimalSeedEntry(relativePath: string) {
  return `<!-- auto-evolve-bootstrap: replaceable -->
<!-- auto-evolve-entry: true -->
<!-- auto-evolve-role: entry -->
# Experience Workspace Entry

Status: minimal seed

## Purpose

- This file is the only guaranteed entry point for the tracked expert surface.
- Bootstrap or maintenance agents should evolve this workspace into a formal expert surface.
- Helper assets may be stored under \`tools/\` or \`skills/\`.

## Current Entry Path

- ${relativePath}
`
}

function minimalSeedChangeLog() {
  return `<!-- auto-evolve-role: change_log -->
# Change Log

- Initialized the tracked expert surface as a minimal seed.`
}

function minimalSeedSurfaceContract(paths: ExperienceWorkspacePaths) {
  return JSON.stringify(
    {
      version: 1,
      profile: "governed",
      entry: normalizeRelativeSurfacePath(paths.defaultEntryRelativePath),
      changeLog: "change_log.md",
      documents: [
        {
          path: normalizeRelativeSurfacePath(paths.defaultEntryRelativePath),
          role: "entry",
        },
        {
          path: "change_log.md",
          role: "change_log",
        },
      ],
      assetRoots: [...DEFAULT_WORKSPACE_ASSET_ROOTS],
      runtimeSidecarRoots: [...DEFAULT_RUNTIME_SIDECAR_ROOTS],
      notes: ["This contract declares the expert surface shape without forcing every document to carry inline role markers."],
    },
    null,
    2,
  )
}

export function experienceWorkspacePaths(cwd: string, config: AutoEvolveConfig): ExperienceWorkspacePaths {
  const root = autoEvolvePath(cwd, config.knowledgeDir)
  return experienceWorkspacePathsFromRoot(root, config.experienceEntryFile)
}

export function buildMinimalExperienceWorkspaceSeed(paths: ExperienceWorkspacePaths): ExperienceWorkspaceSnapshot {
  return {
    [normalizeRelativeSurfacePath(paths.defaultEntryRelativePath)]: minimalSeedEntry(
      normalizeRelativeSurfacePath(paths.defaultEntryRelativePath),
    ),
    "change_log.md": minimalSeedChangeLog(),
    [EXPERIENCE_SURFACE_CONTRACT_FILE]: minimalSeedSurfaceContract(paths),
  }
}

export async function templateLibraryPaths(cwd: string, config: AutoEvolveConfig): Promise<TemplateLibraryPaths> {
  const root = autoEvolvePath(cwd, config.templateLibraryDir)
  return {
    root,
    files: (await collectMarkdownFiles(root)).map((relative) => path.join(root, ...relative.split("/"))),
  }
}

export async function listExperienceWorkspaceFiles(pathsOrLayout: ExperienceWorkspacePaths | ExperienceWorkspaceLayout) {
  if ("documents" in pathsOrLayout && "assets" in pathsOrLayout) {
    return [
      ...pathsOrLayout.documents.map((item) => item.relativePath),
      ...pathsOrLayout.assets.map((item) => item.relativePath),
      ...pathsOrLayout.controlFiles,
    ].sort((left, right) => left.localeCompare(right))
  }

  const layout = await resolveExperienceWorkspaceLayout(pathsOrLayout)
  return [
    ...layout.documents.map((item) => item.relativePath),
    ...layout.assets.map((item) => item.relativePath),
    ...layout.controlFiles,
  ].sort((left, right) => left.localeCompare(right))
}

export async function listExperienceWorkspaceDocuments(paths: ExperienceWorkspacePaths): Promise<ExperienceWorkspaceDocument[]> {
  const allFiles = await collectWorkspaceFiles(paths.root)
  const { contract } = await readExperienceSurfaceContract(paths.root)
  const { runtimeSidecarRoots } = resolveSurfaceRoots(contract)
  const contractDocuments = buildContractDocumentMap(contract)
  const explicitEntryRelativePath = contract?.entry ? normalizeRelativeSurfacePath(contract.entry) : undefined
  const files = collectWorkspaceDocumentFiles(allFiles, runtimeSidecarRoots)
  const documents: ExperienceWorkspaceDocument[] = []

  for (const relative of files) {
    const absolutePath = path.join(paths.root, ...relative.split("/"))
    const content = await readTextFile(absolutePath)
    documents.push(parseDocumentMeta(relative, absolutePath, content, contractDocuments.get(relative), explicitEntryRelativePath))
  }

  return documents.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

export async function listExperienceWorkspaceAssets(paths: ExperienceWorkspacePaths): Promise<ExperienceWorkspaceAsset[]> {
  const allFiles = await collectWorkspaceFiles(paths.root)
  const { contract } = await readExperienceSurfaceContract(paths.root)
  const { assetRoots, runtimeSidecarRoots } = resolveSurfaceRoots(contract)
  const files = collectWorkspaceAssetFiles(allFiles, assetRoots, runtimeSidecarRoots)

  return files.map((relativePath) => ({
    relativePath,
    absolutePath: path.join(paths.root, ...relativePath.split("/")),
    kind: classifyWorkspaceAsset(relativePath),
  }))
}

export async function resolveExperienceWorkspaceLayout(paths: ExperienceWorkspacePaths): Promise<ExperienceWorkspaceLayout> {
  const allFiles = await collectWorkspaceFiles(paths.root)
  const { path: surfaceContractPath, contract: surfaceContract } = await readExperienceSurfaceContract(paths.root)
  const { assetRoots, runtimeSidecarRoots } = resolveSurfaceRoots(surfaceContract)
  const contractDocuments = buildContractDocumentMap(surfaceContract)
  const explicitEntryRelativePath = surfaceContract?.entry ? normalizeRelativeSurfacePath(surfaceContract.entry) : undefined

  const documentFiles = collectWorkspaceDocumentFiles(allFiles, runtimeSidecarRoots)
  const documents: ExperienceWorkspaceDocument[] = []
  for (const relative of documentFiles) {
    const absolutePath = path.join(paths.root, ...relative.split("/"))
    const content = await readTextFile(absolutePath)
    documents.push(parseDocumentMeta(relative, absolutePath, content, contractDocuments.get(relative), explicitEntryRelativePath))
  }
  documents.sort((left, right) => left.relativePath.localeCompare(right.relativePath))

  const assetFiles = collectWorkspaceAssetFiles(allFiles, assetRoots, runtimeSidecarRoots)
  const assets = assetFiles.map((relativePath) => ({
    relativePath,
    absolutePath: path.join(paths.root, ...relativePath.split("/")),
    kind: classifyWorkspaceAsset(relativePath),
  }))
  const runtimeSidecarFiles = collectRuntimeSidecarFiles(allFiles, runtimeSidecarRoots)
  const controlFiles = surfaceContractPath ? [surfaceContractPath] : []

  const supportedFiles = new Set([
    ...documents.map((item) => item.relativePath),
    ...assets.map((item) => item.relativePath),
    ...controlFiles,
    ...runtimeSidecarFiles,
  ])
  const unsupportedFiles = allFiles.filter((relative) => !supportedFiles.has(relative))
  const entryDocument = selectWorkspaceEntryDocument(paths, documents, surfaceContract)

  return {
    ...paths,
    entryRelativePath: entryDocument.relativePath,
    entryPath: entryDocument.absolutePath,
    documents,
    assets,
    controlFiles,
    runtimeSidecarFiles,
    unsupportedFiles,
    surfaceContract,
    surfaceContractPath,
    resolvedAssetRoots: assetRoots,
    resolvedRuntimeSidecarRoots: runtimeSidecarRoots,
  }
}

function resolveValidationProfile(
  layout: ExperienceWorkspaceLayout,
  options?: ExperienceWorkspaceValidationOptions,
): ExperienceSurfaceProfile {
  if (options?.profile && options.profile !== "auto") return options.profile
  return layout.surfaceContract?.profile ?? "governed"
}

export function validateExperienceWorkspaceLayout(
  layout: ExperienceWorkspaceLayout,
  options?: ExperienceWorkspaceValidationOptions,
): ExperienceWorkspaceValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const profile = resolveValidationProfile(layout, options)
  const documentPathSet = new Set(layout.documents.map((item) => item.relativePath))
  const contract = layout.surfaceContract

  if (!layout.documents.length) {
    errors.push("Experience surface has no expert Markdown documents.")
  }

  if (!layout.documents.some((item) => item.relativePath === layout.entryRelativePath)) {
    errors.push(`Experience surface entry file is missing: ${layout.entryRelativePath}`)
  }

  if (contract?.entry && !documentPathSet.has(normalizeRelativeSurfacePath(contract.entry))) {
    errors.push(`Experience surface contract entry does not exist: ${normalizeRelativeSurfacePath(contract.entry)}`)
  }

  if (contract?.changeLog && !documentPathSet.has(normalizeRelativeSurfacePath(contract.changeLog))) {
    const message = `Experience surface contract change-log does not exist: ${normalizeRelativeSurfacePath(contract.changeLog)}`
    if (profile === "governed") errors.push(message)
    else warnings.push(message)
  }

  for (const declared of contract?.documents ?? []) {
    if (!documentPathSet.has(normalizeRelativeSurfacePath(declared.path))) {
      const message = `Experience surface contract references a missing document: ${normalizeRelativeSurfacePath(declared.path)}`
      if (profile === "governed") errors.push(message)
      else warnings.push(message)
    }
  }

  const hasChangeLog =
    layout.documents.some((item) => item.role === "change_log") ||
    (!!contract?.changeLog && documentPathSet.has(normalizeRelativeSurfacePath(contract.changeLog)))

  if (!hasChangeLog) {
    const message = "Experience surface does not currently declare a change-log Markdown file."
    if (profile === "governed") errors.push(message)
    else warnings.push(message)
  }

  for (const document of layout.documents) {
    if (!document.role) {
      const message = `Experience surface document has no declared or inferable role: ${document.relativePath}`
      if (profile === "governed") errors.push(message)
      else warnings.push(message)
    }
  }

  if (layout.unsupportedFiles.length) {
    errors.push(
      `Experience surface only supports expert Markdown documents, optional ${EXPERIENCE_SURFACE_CONTRACT_FILE}, approved helper assets under ${layout.resolvedAssetRoots.join(
        ", ",
      )}, and runtime sidecars under ${layout.resolvedRuntimeSidecarRoots.join(", ")}. Unsupported files: ${layout.unsupportedFiles.join(", ")}`,
    )
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    profile,
    contractPresent: !!layout.surfaceContract,
  }
}

export async function readExperienceWorkspace(
  pathsOrLayout: ExperienceWorkspacePaths | ExperienceWorkspaceLayout,
): Promise<ExperienceWorkspaceSnapshot> {
  const snapshot: ExperienceWorkspaceSnapshot = {}
  const files = await listExperienceWorkspaceFiles(pathsOrLayout)
  const root = pathsOrLayout.root
  for (const relative of files) {
    snapshot[relative] = await readTextFile(path.join(root, ...relative.split("/")))
  }
  return snapshot
}

export function diffExperienceWorkspace(before: ExperienceWorkspaceSnapshot, after: ExperienceWorkspaceSnapshot) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((relative) => (before[relative] ?? "") !== (after[relative] ?? ""))
    .sort((left, right) => left.localeCompare(right))
}

export async function restoreExperienceWorkspace(paths: ExperienceWorkspacePaths, snapshot: ExperienceWorkspaceSnapshot) {
  await ensureDirectory(paths.root)
  const currentTrackedFiles = await listExperienceWorkspaceFiles(paths)
  const nextTrackedFiles = new Set(Object.keys(snapshot))

  for (const relative of currentTrackedFiles) {
    if (nextTrackedFiles.has(relative)) continue
    await rm(path.join(paths.root, ...relative.split("/")), { force: true })
  }

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

export function experienceWorkspacePathsFromRoot(root: string, defaultEntryRelativePath: string): ExperienceWorkspacePaths {
  const normalizedEntry = normalizeRelativeSurfacePath(defaultEntryRelativePath)
  return {
    root,
    defaultEntryRelativePath: normalizedEntry,
    defaultEntryPath: path.join(root, ...normalizedEntry.split("/")),
  }
}

export function findExperienceWorkspaceDocumentsByRole(layout: ExperienceWorkspaceLayout, roles: ExperienceWorkspaceRole[]) {
  const allowed = new Set(roles)
  return layout.documents.filter((item) => item.role && allowed.has(item.role))
}

export function findExperienceWorkspaceDocumentByRole(layout: ExperienceWorkspaceLayout, role: ExperienceWorkspaceRole) {
  return layout.documents.find((item) => item.role === role)
}
