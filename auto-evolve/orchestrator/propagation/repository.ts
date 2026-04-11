import path from "node:path"
import { createHash } from "node:crypto"
import {
  autoEvolvePath,
  ensureDirectory,
  pathExists,
  readJsonFile,
  readTextFile,
  writeJsonFile,
  writeTextFile,
} from "../fs"
import {
  experienceWorkspacePaths,
  experienceWorkspacePathsFromRoot,
  readExperienceWorkspace,
  restoreExperienceWorkspace,
  type ExperienceWorkspacePaths,
  type ExperienceWorkspaceSnapshot,
} from "../experience-workspace"
import type { AutoEvolveConfig } from "../schema"
import {
  ensureGlobalOptimizationLayout,
  globalOptimizationPaths,
  readOptimizationCandidatePackage,
  readOptimizationCandidateSnapshot,
} from "../global-optimization/repository"

export interface PropagationPaths {
  root: string
  objectsRoot: string
  blobsRoot: string
  treesRoot: string
  commitsRoot: string
  refsRoot: string
  canonicalRefPath: string
  branchesRoot: string
  campaignsRoot: string
  workspacesRoot: string
}

export interface ExperienceBlobRef {
  path: string
  blobHash: string
  bytes: number
}

export interface ExperienceTreeObject {
  treeHash: string
  fileCount: number
  files: ExperienceBlobRef[]
}

export interface ExperienceCommitEvaluationSummary {
  train?: {
    total: number
    passed: number
    failed: number
    acceptedRefines: number
    rejectedRefines: number
  }
  test?: {
    total: number
    passed: number
    failed: number
    acceptedRefines: number
    rejectedRefines: number
  }
}

export interface ExperienceCommitSource {
  kind: "live_workspace" | "campaign_result" | "optimization_candidate"
  description: string
  campaignID?: string
  branchName?: string
  maintenanceMethodID?: string
  propagationMethodID?: string
  baselineDir?: string
  optimizationCandidateID?: string
  optimizationStrategyID?: string
}

export interface ExperienceCommit {
  id: string
  treeHash: string
  parentCommitID: string | null
  createdAt: string
  fileCount: number
  summary: string
  source: ExperienceCommitSource
  evaluation?: ExperienceCommitEvaluationSummary
}

export interface CanonicalRef {
  headCommitID: string
  updatedAt: string
}

export interface PropagationBranchRef {
  name: string
  sourceCommitID: string
  headCommitID: string
  createdAt: string
  updatedAt: string
  status: "active" | "archived"
}

export interface ResolvedPropagationRef {
  kind: "canonical" | "branch" | "commit" | "optimization_candidate"
  sourceRef: string
  commitID: string
  branchName?: string
  optimizationCandidateID?: string
}

function nowISO() {
  return new Date().toISOString()
}

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function contentHash(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

function jsonHash(value: unknown) {
  return contentHash(JSON.stringify(value))
}

function bytes(content: string) {
  return Buffer.byteLength(content, "utf8")
}

function makeCommitID(treeHash: string) {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`
  return `${stamp}-${treeHash.slice(0, 12)}`
}

export function propagationPaths(cwd: string, config: AutoEvolveConfig): PropagationPaths {
  const root = autoEvolvePath(cwd, config.propagationDir)
  return {
    root,
    objectsRoot: path.join(root, "objects"),
    blobsRoot: path.join(root, "objects", "blobs"),
    treesRoot: path.join(root, "objects", "trees"),
    commitsRoot: path.join(root, "commits"),
    refsRoot: path.join(root, "refs"),
    canonicalRefPath: path.join(root, "refs", "canonical.json"),
    branchesRoot: path.join(root, "refs", "branches"),
    campaignsRoot: path.join(root, "campaigns"),
    workspacesRoot: path.join(root, "workspaces"),
  }
}

export async function ensurePropagationLayout(paths: PropagationPaths) {
  await ensureDirectory(paths.root)
  await ensureDirectory(paths.objectsRoot)
  await ensureDirectory(paths.blobsRoot)
  await ensureDirectory(paths.treesRoot)
  await ensureDirectory(paths.commitsRoot)
  await ensureDirectory(paths.refsRoot)
  await ensureDirectory(paths.branchesRoot)
  await ensureDirectory(paths.campaignsRoot)
  await ensureDirectory(paths.workspacesRoot)
}

async function blobPath(paths: PropagationPaths, blobHash: string) {
  return path.join(paths.blobsRoot, blobHash)
}

function treePath(paths: PropagationPaths, treeHash: string) {
  return path.join(paths.treesRoot, `${treeHash}.json`)
}

function commitPath(paths: PropagationPaths, commitID: string) {
  return path.join(paths.commitsRoot, `${commitID}.json`)
}

function branchRefPath(paths: PropagationPaths, branchName: string) {
  return path.join(paths.branchesRoot, `${branchName}.json`)
}

export function branchWorkspaceRoot(paths: PropagationPaths, branchName: string) {
  return path.join(paths.workspacesRoot, branchName, "workspace")
}

export function branchRunsRoot(paths: PropagationPaths, branchName: string) {
  return path.join(paths.workspacesRoot, branchName, "runs")
}

export function relativeToAutoEvolveRoot(cwd: string, absolutePath: string) {
  return normalizeSlash(path.relative(autoEvolvePath(cwd), absolutePath))
}

export function sanitizeBranchName(input: string) {
  const cleaned = input.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-")
  return cleaned.replace(/^-|-$/g, "") || "branch"
}

export async function storeSnapshotAsTree(paths: PropagationPaths, snapshot: ExperienceWorkspaceSnapshot) {
  const files = Object.entries(snapshot)
    .map(([relativePath, content]) => {
      const blobHash = contentHash(content)
      return {
        path: normalizeSlash(relativePath),
        blobHash,
        bytes: bytes(content),
        content,
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path))

  for (const item of files) {
    const target = await blobPath(paths, item.blobHash)
    if (!(await pathExists(target))) {
      await writeTextFile(target, item.content)
    }
  }

  const treePayload = {
    fileCount: files.length,
    files: files.map(({ path, blobHash, bytes }) => ({ path, blobHash, bytes })),
  }
  const treeHash = jsonHash(treePayload)
  const object: ExperienceTreeObject = {
    treeHash,
    fileCount: treePayload.fileCount,
    files: treePayload.files,
  }
  const target = treePath(paths, treeHash)
  if (!(await pathExists(target))) {
    await writeJsonFile(target, object)
  }

  return object
}

export async function loadTree(paths: PropagationPaths, treeHash: string) {
  return readJsonFile<ExperienceTreeObject>(treePath(paths, treeHash))
}

export async function loadTreeSnapshot(paths: PropagationPaths, treeHash: string): Promise<ExperienceWorkspaceSnapshot> {
  const tree = await loadTree(paths, treeHash)
  const snapshot: ExperienceWorkspaceSnapshot = {}

  for (const file of tree.files) {
    snapshot[file.path] = await readTextFile(path.join(paths.blobsRoot, file.blobHash))
  }

  return snapshot
}

export async function writeCommit(
  paths: PropagationPaths,
  input: Omit<ExperienceCommit, "id" | "createdAt" | "fileCount"> & { id?: string; createdAt?: string; fileCount?: number },
) {
  const tree = await loadTree(paths, input.treeHash)
  const commit: ExperienceCommit = {
    id: input.id ?? makeCommitID(input.treeHash),
    treeHash: input.treeHash,
    parentCommitID: input.parentCommitID ?? null,
    createdAt: input.createdAt ?? nowISO(),
    fileCount: input.fileCount ?? tree.fileCount,
    summary: input.summary,
    source: input.source,
    evaluation: input.evaluation,
  }

  await writeJsonFile(commitPath(paths, commit.id), commit)
  return commit
}

export async function readCommit(paths: PropagationPaths, commitID: string) {
  return readJsonFile<ExperienceCommit>(commitPath(paths, commitID))
}

async function tryReadCommit(paths: PropagationPaths, commitID: string) {
  const target = commitPath(paths, commitID)
  if (!(await pathExists(target))) return undefined
  return readJsonFile<ExperienceCommit>(target)
}

export async function createCommitFromWorkspace(
  paths: PropagationPaths,
  workspacePaths: ExperienceWorkspacePaths,
  input: {
    parentCommitID?: string | null
    summary: string
    source: ExperienceCommitSource
    evaluation?: ExperienceCommitEvaluationSummary
  },
) {
  const snapshot = await readExperienceWorkspace(workspacePaths)
  const tree = await storeSnapshotAsTree(paths, snapshot)
  return writeCommit(paths, {
    treeHash: tree.treeHash,
    parentCommitID: input.parentCommitID ?? null,
    summary: input.summary,
    source: input.source,
    evaluation: input.evaluation,
    fileCount: tree.fileCount,
  })
}

export async function createCommitFromSnapshot(
  paths: PropagationPaths,
  snapshot: ExperienceWorkspaceSnapshot,
  input: {
    parentCommitID?: string | null
    summary: string
    source: ExperienceCommitSource
    evaluation?: ExperienceCommitEvaluationSummary
  },
) {
  const tree = await storeSnapshotAsTree(paths, snapshot)
  return writeCommit(paths, {
    treeHash: tree.treeHash,
    parentCommitID: input.parentCommitID ?? null,
    summary: input.summary,
    source: input.source,
    evaluation: input.evaluation,
    fileCount: tree.fileCount,
  })
}

export async function readCanonicalRef(paths: PropagationPaths) {
  if (!(await pathExists(paths.canonicalRefPath))) return undefined
  return readJsonFile<CanonicalRef>(paths.canonicalRefPath)
}

export async function writeCanonicalRef(paths: PropagationPaths, ref: CanonicalRef) {
  await writeJsonFile(paths.canonicalRefPath, ref)
}

export async function readBranchRef(paths: PropagationPaths, branchName: string) {
  const target = branchRefPath(paths, branchName)
  if (!(await pathExists(target))) return undefined
  return readJsonFile<PropagationBranchRef>(target)
}

export async function writeBranchRef(paths: PropagationPaths, ref: PropagationBranchRef) {
  await writeJsonFile(branchRefPath(paths, ref.name), ref)
}

export async function ensureCanonicalCommitFromLiveWorkspace(cwd: string, config: AutoEvolveConfig) {
  const repo = propagationPaths(cwd, config)
  await ensurePropagationLayout(repo)
  const liveWorkspacePaths = experienceWorkspacePaths(cwd, config)
  const tree = await storeSnapshotAsTree(repo, await readExperienceWorkspace(liveWorkspacePaths))
  const currentCanonical = await readCanonicalRef(repo)

  if (currentCanonical) {
    const currentCommit = await tryReadCommit(repo, currentCanonical.headCommitID)
    if (currentCommit?.treeHash === tree.treeHash) {
      return {
        ref: currentCanonical,
        commit: currentCommit,
      }
    }

    const nextCommit = await writeCommit(repo, {
      treeHash: tree.treeHash,
      parentCommitID: currentCommit?.id ?? null,
      summary: currentCommit
        ? "Snapshot current canonical experience workspace"
        : "Recover canonical experience snapshot from live workspace",
      source: {
        kind: "live_workspace",
        description: currentCommit
          ? "Snapshot current canonical experience workspace"
          : "Recover canonical experience snapshot from live workspace",
      },
      fileCount: tree.fileCount,
    })
    const nextRef: CanonicalRef = {
      headCommitID: nextCommit.id,
      updatedAt: nowISO(),
    }
    await writeCanonicalRef(repo, nextRef)
    return {
      ref: nextRef,
      commit: nextCommit,
    }
  }

  const initialCommit = await writeCommit(repo, {
    treeHash: tree.treeHash,
    parentCommitID: null,
    summary: "Initialize canonical experience snapshot from live workspace",
    source: {
      kind: "live_workspace",
      description: "Initialize canonical experience snapshot from live workspace",
    },
    fileCount: tree.fileCount,
  })
  const ref: CanonicalRef = {
    headCommitID: initialCommit.id,
    updatedAt: nowISO(),
  }
  await writeCanonicalRef(repo, ref)
  return {
    ref,
    commit: initialCommit,
  }
}

export async function resolvePropagationRef(
  cwd: string,
  config: AutoEvolveConfig,
  refText = "canonical",
): Promise<ResolvedPropagationRef> {
  const repo = propagationPaths(cwd, config)
  await ensurePropagationLayout(repo)

  if (refText === "canonical") {
    const canonical = await ensureCanonicalCommitFromLiveWorkspace(cwd, config)
    return {
      kind: "canonical",
      sourceRef: "canonical",
      commitID: canonical.commit.id,
    }
  }

  if (refText.startsWith("branch:")) {
    const branchName = sanitizeBranchName(refText.slice("branch:".length))
    const branch = await readBranchRef(repo, branchName)
    if (!branch) throw new Error(`Propagation branch not found: ${branchName}`)
    return {
      kind: "branch",
      sourceRef: refText,
      commitID: branch.headCommitID,
      branchName,
    }
  }

  if (refText.startsWith("commit:")) {
    const commitID = refText.slice("commit:".length).trim()
    if (!commitID) throw new Error("Propagation commit ref is empty.")
    await readCommit(repo, commitID)
    return {
      kind: "commit",
      sourceRef: refText,
      commitID,
    }
  }

  if (refText.startsWith("optimization:")) {
    const candidateID = refText.slice("optimization:".length).trim()
    if (!candidateID) throw new Error("Optimization candidate ref is empty.")
    const optimization = globalOptimizationPaths(cwd, config)
    await ensureGlobalOptimizationLayout(optimization)
    const candidate = await readOptimizationCandidatePackage(optimization, candidateID)
    const snapshot = await readOptimizationCandidateSnapshot(optimization, candidateID)
    const adoptedCommit = await createCommitFromSnapshot(repo, snapshot, {
      parentCommitID: candidate.baseCommitID,
      summary: `Adopt optimization candidate ${candidateID} as propagation source`,
      source: {
        kind: "optimization_candidate",
        description: "Adopt an optimization candidate package as a propagation source",
        optimizationCandidateID: candidateID,
        optimizationStrategyID: candidate.strategyID,
      },
    })
    return {
      kind: "optimization_candidate",
      sourceRef: refText,
      commitID: adoptedCommit.id,
      optimizationCandidateID: candidateID,
    }
  }

  throw new Error(`Unsupported propagation source ref: ${refText}`)
}

export async function checkoutCommitToWorkspace(
  paths: PropagationPaths,
  config: AutoEvolveConfig,
  commitID: string,
  workspaceRoot: string,
) {
  const commit = await readCommit(paths, commitID)
  const snapshot = await loadTreeSnapshot(paths, commit.treeHash)
  const workspacePaths = experienceWorkspacePathsFromRoot(workspaceRoot, config.experienceEntryFile)
  await restoreExperienceWorkspace(workspacePaths, snapshot)
  return {
    commit,
    workspacePaths,
  }
}
