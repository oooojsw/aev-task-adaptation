import path from "node:path"
import { rm } from "node:fs/promises"
import {
  experienceWorkspacePaths,
  readExperienceWorkspace,
  resolveExperienceWorkspaceLayout,
  restoreExperienceWorkspace,
  seedExperienceWorkspace,
  writeExperienceWorkspaceSnapshot,
  type ExperienceWorkspacePaths,
  type ExperienceWorkspaceSnapshot,
} from "./experience-workspace"
import { autoEvolvePath, ensureDirectory, pathExists, readJsonFile, writeJsonFile } from "./fs"
import type { AutoEvolveConfig } from "./schema"

export interface ExperienceArchivePaths {
  root: string
  historyRoot: string
  indexPath: string
  latestRoot: string
  latestWorkspaceRoot: string
  latestMetadataPath: string
  latestSnapshotPath: string
}

export interface ExperienceArchiveMetadata {
  archiveID: string
  archivedAt: string
  note?: string
  sourceWorkspaceRoot: string
  entryRelativePath: string
  fileCount: number
  files: string[]
}

export interface ExperienceArchiveIndexEntry {
  archiveID: string
  archivedAt: string
  note?: string
  sourceWorkspaceRoot: string
  entryRelativePath: string
  fileCount: number
  historyRoot: string
}

export interface ArchivedExperienceSnapshot {
  archive: ExperienceArchivePaths
  metadata: ExperienceArchiveMetadata
  snapshot: ExperienceWorkspaceSnapshot
}

export interface ResetExperienceResult {
  archived: ArchivedExperienceSnapshot
  resetAt: string
  seededFiles: string[]
  workspaceRoot: string
}

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function archivePaths(cwd: string, config: AutoEvolveConfig): ExperienceArchivePaths {
  const root = autoEvolvePath(cwd, config.experienceArchiveDir)
  const latestRoot = path.join(root, "latest")
  return {
    root,
    historyRoot: path.join(root, "history"),
    indexPath: path.join(root, "index.json"),
    latestRoot,
    latestWorkspaceRoot: path.join(latestRoot, "workspace"),
    latestMetadataPath: path.join(latestRoot, "metadata.json"),
    latestSnapshotPath: path.join(latestRoot, "snapshot.json"),
  }
}

async function replaceArchiveSlot(paths: ExperienceArchivePaths) {
  if (await pathExists(paths.latestRoot)) {
    await rm(paths.latestRoot, { recursive: true, force: true })
  }
  await ensureDirectory(paths.latestWorkspaceRoot)
}

async function collectArchiveMetadata(
  workspace: ExperienceWorkspacePaths,
  snapshot: ExperienceWorkspaceSnapshot,
  archiveID: string,
  note?: string,
): Promise<ExperienceArchiveMetadata> {
  const archivedAt = new Date().toISOString()
  let entryRelativePath = normalizeSlash(workspace.defaultEntryRelativePath)

  try {
    const layout = await resolveExperienceWorkspaceLayout(workspace)
    entryRelativePath = layout.entryRelativePath
  } catch {
    // Keep the default entry path when the current workspace is partially broken.
  }

  return {
    archiveID,
    archivedAt,
    note,
    sourceWorkspaceRoot: workspace.root,
    entryRelativePath,
    fileCount: Object.keys(snapshot).length,
    files: Object.keys(snapshot).sort((left, right) => left.localeCompare(right)),
  }
}

function buildArchiveID(timestamp = new Date()) {
  const iso = timestamp.toISOString().replace(/[:.]/g, "-")
  return `archive-${iso}`
}

function historySlotPaths(paths: ExperienceArchivePaths, archiveID: string) {
  const slotRoot = path.join(paths.historyRoot, archiveID)
  return {
    archiveID,
    slotRoot,
    workspaceRoot: path.join(slotRoot, "workspace"),
    metadataPath: path.join(slotRoot, "metadata.json"),
    snapshotPath: path.join(slotRoot, "snapshot.json"),
  }
}

async function readArchiveIndex(paths: ExperienceArchivePaths): Promise<ExperienceArchiveIndexEntry[]> {
  if (!(await pathExists(paths.indexPath))) return []
  return readJsonFile<ExperienceArchiveIndexEntry[]>(paths.indexPath)
}

async function writeArchiveIndex(paths: ExperienceArchivePaths, entries: ExperienceArchiveIndexEntry[]) {
  const sorted = [...entries].sort((left, right) => right.archivedAt.localeCompare(left.archivedAt))
  await writeJsonFile(paths.indexPath, sorted)
}

function toIndexEntry(paths: ExperienceArchivePaths, metadata: ExperienceArchiveMetadata): ExperienceArchiveIndexEntry {
  return {
    archiveID: metadata.archiveID,
    archivedAt: metadata.archivedAt,
    note: metadata.note,
    sourceWorkspaceRoot: metadata.sourceWorkspaceRoot,
    entryRelativePath: metadata.entryRelativePath,
    fileCount: metadata.fileCount,
    historyRoot: normalizeSlash(path.relative(paths.root, historySlotPaths(paths, metadata.archiveID).slotRoot)),
  }
}

async function writeHistorySnapshot(
  paths: ExperienceArchivePaths,
  metadata: ExperienceArchiveMetadata,
  snapshot: ExperienceWorkspaceSnapshot,
) {
  const slot = historySlotPaths(paths, metadata.archiveID)
  await ensureDirectory(slot.workspaceRoot)
  await writeExperienceWorkspaceSnapshot(slot.workspaceRoot, snapshot)
  await writeJsonFile(slot.metadataPath, metadata)
  await writeJsonFile(slot.snapshotPath, snapshot)
  return slot
}

async function ensureLegacyLatestMigrated(paths: ExperienceArchivePaths) {
  if (!(await pathExists(paths.latestMetadataPath)) || !(await pathExists(paths.latestSnapshotPath))) return

  const metadata = await readJsonFile<ExperienceArchiveMetadata | Omit<ExperienceArchiveMetadata, "archiveID">>(
    paths.latestMetadataPath,
  )
  const snapshot = await readJsonFile<ExperienceWorkspaceSnapshot>(paths.latestSnapshotPath)
  const index = await readArchiveIndex(paths)

  const archiveID = "archiveID" in metadata && metadata.archiveID ? metadata.archiveID : buildArchiveID(new Date(metadata.archivedAt))
  if (index.some((entry) => entry.archiveID === archiveID)) return

  const normalizedMetadata: ExperienceArchiveMetadata = {
    archiveID,
    archivedAt: metadata.archivedAt,
    note: metadata.note,
    sourceWorkspaceRoot: metadata.sourceWorkspaceRoot,
    entryRelativePath: metadata.entryRelativePath,
    fileCount: metadata.fileCount,
    files: metadata.files,
  }

  await ensureDirectory(paths.historyRoot)
  await writeHistorySnapshot(paths, normalizedMetadata, snapshot)
  await writeArchiveIndex(paths, [...index, toIndexEntry(paths, normalizedMetadata)])
}

export async function synchronizeExperienceArchiveHistory(cwd: string, config: AutoEvolveConfig) {
  const archive = archivePaths(cwd, config)
  await ensureDirectory(archive.root)
  await ensureDirectory(archive.historyRoot)
  await ensureLegacyLatestMigrated(archive)
  return {
    archive,
    entries: await readArchiveIndex(archive),
  }
}

export async function archiveCurrentExperienceWorkspace(
  cwd: string,
  config: AutoEvolveConfig,
  options?: { note?: string },
): Promise<ArchivedExperienceSnapshot> {
  const workspace = experienceWorkspacePaths(cwd, config)
  const archive = archivePaths(cwd, config)
  const snapshot = await readExperienceWorkspace(workspace)
  const archiveID = buildArchiveID()
  const metadata = await collectArchiveMetadata(workspace, snapshot, archiveID, options?.note)

  await ensureDirectory(archive.root)
  await ensureDirectory(archive.historyRoot)
  await ensureLegacyLatestMigrated(archive)
  const index = await readArchiveIndex(archive)
  await writeHistorySnapshot(archive, metadata, snapshot)
  await writeArchiveIndex(archive, [...index, toIndexEntry(archive, metadata)])
  await replaceArchiveSlot(archive)
  await writeExperienceWorkspaceSnapshot(archive.latestWorkspaceRoot, snapshot)
  await writeJsonFile(archive.latestMetadataPath, metadata)
  await writeJsonFile(archive.latestSnapshotPath, snapshot)

  return {
    archive,
    metadata,
    snapshot,
  }
}

export async function resetExperienceWorkspace(
  cwd: string,
  config: AutoEvolveConfig,
  options?: { note?: string },
): Promise<ResetExperienceResult> {
  const archived = await archiveCurrentExperienceWorkspace(cwd, config, options)
  const workspace = experienceWorkspacePaths(cwd, config)
  const seeded = await seedExperienceWorkspace(workspace)

  return {
    archived,
    resetAt: new Date().toISOString(),
    seededFiles: Object.keys(seeded).sort((left, right) => left.localeCompare(right)),
    workspaceRoot: workspace.root,
  }
}

export async function restoreLatestArchivedExperienceWorkspace(cwd: string, config: AutoEvolveConfig) {
  const workspace = experienceWorkspacePaths(cwd, config)
  const archive = archivePaths(cwd, config)

  if (!(await pathExists(archive.latestSnapshotPath))) {
    throw new Error(`No archived experience snapshot found at ${archive.latestSnapshotPath}`)
  }

  const snapshot = await readJsonFile<ExperienceWorkspaceSnapshot>(archive.latestSnapshotPath)
  await restoreExperienceWorkspace(workspace, snapshot)

  return {
    archive,
    restoredFiles: Object.keys(snapshot).sort((left, right) => left.localeCompare(right)),
    workspaceRoot: workspace.root,
  }
}
