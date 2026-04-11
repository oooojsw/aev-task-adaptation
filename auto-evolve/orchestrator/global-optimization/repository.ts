import path from "node:path"
import type { ExperienceWorkspaceSnapshot } from "../experience-workspace"
import { autoEvolvePath, ensureDirectory, pathExists, readJsonFile, writeJsonFile } from "../fs"
import type { AutoEvolveConfig } from "../schema"
import type { OptimizationCandidatePackage, OptimizationOutcome, OptimizerMemoryEntry } from "./contract"

export interface GlobalOptimizationPaths {
  root: string
  candidatesRoot: string
  outcomesRoot: string
  memoryRoot: string
}

function nowISO() {
  return new Date().toISOString()
}

export function globalOptimizationPaths(cwd: string, config: AutoEvolveConfig): GlobalOptimizationPaths {
  const root = autoEvolvePath(cwd, config.optimizationDir)
  return {
    root,
    candidatesRoot: path.join(root, "candidates"),
    outcomesRoot: path.join(root, "outcomes"),
    memoryRoot: path.join(root, "memory"),
  }
}

export async function ensureGlobalOptimizationLayout(paths: GlobalOptimizationPaths) {
  await ensureDirectory(paths.root)
  await ensureDirectory(paths.candidatesRoot)
  await ensureDirectory(paths.outcomesRoot)
  await ensureDirectory(paths.memoryRoot)
}

function candidateDir(paths: GlobalOptimizationPaths, candidateID: string) {
  return path.join(paths.candidatesRoot, candidateID)
}

function candidateMetadataPath(paths: GlobalOptimizationPaths, candidateID: string) {
  return path.join(candidateDir(paths, candidateID), "candidate.json")
}

function candidateSnapshotPath(paths: GlobalOptimizationPaths, candidateID: string) {
  return path.join(candidateDir(paths, candidateID), "workspace.snapshot.json")
}

function outcomePath(paths: GlobalOptimizationPaths, outcomeID: string) {
  return path.join(paths.outcomesRoot, `${outcomeID}.json`)
}

function optimizerMemoryPath(paths: GlobalOptimizationPaths, entryID: string) {
  return path.join(paths.memoryRoot, `${entryID}.json`)
}

export async function writeOptimizationCandidatePackage(
  paths: GlobalOptimizationPaths,
  input: Omit<OptimizationCandidatePackage, "createdAt" | "updatedAt" | "workspaceSnapshotPath"> & {
    createdAt?: string
    updatedAt?: string
    workspaceSnapshot: ExperienceWorkspaceSnapshot
  },
) {
  await ensureGlobalOptimizationLayout(paths)
  const snapshotPath = candidateSnapshotPath(paths, input.id)
  const candidate: OptimizationCandidatePackage = {
    ...input,
    createdAt: input.createdAt ?? nowISO(),
    updatedAt: input.updatedAt ?? nowISO(),
    workspaceSnapshotPath: snapshotPath,
  }
  await writeJsonFile(snapshotPath, input.workspaceSnapshot)
  await writeJsonFile(candidateMetadataPath(paths, input.id), candidate)
  return candidate
}

export async function readOptimizationCandidatePackage(paths: GlobalOptimizationPaths, candidateID: string) {
  const target = candidateMetadataPath(paths, candidateID)
  if (!(await pathExists(target))) {
    throw new Error(`Optimization candidate package not found: ${candidateID}`)
  }
  return readJsonFile<OptimizationCandidatePackage>(target)
}

export async function readOptimizationCandidateSnapshot(paths: GlobalOptimizationPaths, candidateID: string) {
  const candidate = await readOptimizationCandidatePackage(paths, candidateID)
  if (!(await pathExists(candidate.workspaceSnapshotPath))) {
    throw new Error(`Optimization candidate snapshot is missing: ${candidate.workspaceSnapshotPath}`)
  }
  return readJsonFile<ExperienceWorkspaceSnapshot>(candidate.workspaceSnapshotPath)
}

export async function writeOptimizationOutcome(
  paths: GlobalOptimizationPaths,
  input: Omit<OptimizationOutcome, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string },
) {
  await ensureGlobalOptimizationLayout(paths)
  const outcome: OptimizationOutcome = {
    ...input,
    createdAt: input.createdAt ?? nowISO(),
    updatedAt: input.updatedAt ?? nowISO(),
  }
  await writeJsonFile(outcomePath(paths, outcome.id), outcome)
  return outcome
}

export async function writeOptimizerMemoryEntry(paths: GlobalOptimizationPaths, entry: OptimizerMemoryEntry) {
  await ensureGlobalOptimizationLayout(paths)
  await writeJsonFile(optimizerMemoryPath(paths, entry.id), entry)
  return entry
}

