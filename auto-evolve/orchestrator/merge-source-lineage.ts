import path from "node:path"
import { createHash } from "node:crypto"
import { cp, lstat, readFile, readdir } from "node:fs/promises"
import { ensureDirectory, isPathWithinTruthRoot, pathExists, readJsonFile } from "./fs"

export const MERGE_SOURCE_SKILL_INDEX_SCHEMA = "merge-source-skill-index/v1" as const

export type MergeSourceSkillIndexEntry = {
  sourceCaseID: string
  sourceStatus: string
  frozenSkillRoot: string
  readableFiles: string[]
  sourceSpecPath?: string
  sourceSkillHash: string
  originBenchmarkRunID?: string
}

export type MergeSourceSkillIndex = {
  schema: typeof MERGE_SOURCE_SKILL_INDEX_SCHEMA
  entries: MergeSourceSkillIndexEntry[]
}

function slash(input: string) {
  return input.replace(/\\/g, "/")
}

function assertInside(root: string, candidate: string, label: string) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(candidate)
  if (!isPathWithinTruthRoot(resolvedRoot, resolved)) {
    throw new Error(`${label} escapes its frozen root: ${resolved}`)
  }
  return resolved
}

export async function listFrozenSkillFiles(root: string) {
  const resolvedRoot = path.resolve(root)
  if (!(await pathExists(resolvedRoot))) throw new Error(`Frozen source skill root does not exist: ${resolvedRoot}`)
  const rootInfo = await lstat(resolvedRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Frozen source skill root must be a real directory: ${resolvedRoot}`)
  }
  const files: string[] = []
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = assertInside(resolvedRoot, path.join(dir, entry.name), "Frozen source skill entry")
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new Error(`Symlink/junction-like source skill entry is forbidden: ${absolute}`)
      if (info.isDirectory()) {
        await walk(absolute)
      } else if (info.isFile()) {
        files.push(absolute)
      }
    }
  }
  await walk(resolvedRoot)
  files.sort((a, b) => slash(path.relative(resolvedRoot, a)).localeCompare(slash(path.relative(resolvedRoot, b))))
  if (!files.length) throw new Error(`Frozen source skill contains no files: ${resolvedRoot}`)
  return files
}

export async function hashFrozenSkill(root: string, files?: string[]) {
  const resolvedFiles = files ?? (await listFrozenSkillFiles(root))
  const digest = createHash("sha256")
  for (const file of resolvedFiles) {
    digest.update(slash(path.relative(root, file)))
    digest.update("\0")
    digest.update(await readFile(file))
    digest.update("\0")
  }
  return digest.digest("hex")
}

export async function copyFrozenSkill(source: string, destination: string) {
  const resolvedSource = path.resolve(source)
  await listFrozenSkillFiles(resolvedSource)
  await ensureDirectory(path.dirname(destination))
  await cp(resolvedSource, destination, { recursive: true, force: true, errorOnExist: false, dereference: false })
  const files = await listFrozenSkillFiles(destination)
  return { files, hash: await hashFrozenSkill(destination, files) }
}

export async function readAndValidateMergeSourceSkillIndex(indexPath: string): Promise<MergeSourceSkillIndex> {
  const resolvedIndex = path.resolve(indexPath)
  const index = await readJsonFile<MergeSourceSkillIndex>(resolvedIndex)
  if (index.schema !== MERGE_SOURCE_SKILL_INDEX_SCHEMA || !Array.isArray(index.entries)) {
    throw new Error(`Invalid merge source skill index: ${resolvedIndex}`)
  }
  const base = path.dirname(resolvedIndex)
  const seen = new Set<string>()
  for (const entry of index.entries) {
    const id = String(entry.sourceCaseID ?? "").trim()
    if (!id) throw new Error(`Merge source skill index contains an entry without sourceCaseID: ${resolvedIndex}`)
    if (seen.has(id)) throw new Error(`Merge source skill index contains duplicate sourceCaseID '${id}': ${resolvedIndex}`)
    seen.add(id)
    const root = assertInside(base, path.resolve(base, entry.frozenSkillRoot), `Frozen skill '${id}'`)
    const declared = (entry.readableFiles ?? []).map((item) =>
      assertInside(root, path.resolve(base, item), `Readable source skill file '${id}'`),
    )
    if (!declared.length) throw new Error(`Merge source skill index entry '${id}' has no readable files`)
    for (const file of declared) {
      const info = await lstat(file).catch(() => undefined)
      if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`Indexed source skill file is missing or unsafe: ${file}`)
    }
    const actualFiles = await listFrozenSkillFiles(root)
    const actual = new Set(actualFiles.map((item) => path.resolve(item).toLowerCase()))
    if (declared.some((item) => !actual.has(path.resolve(item).toLowerCase())) || actual.size !== declared.length) {
      throw new Error(`Indexed source skill file list is incomplete for '${id}'`)
    }
    const actualHash = await hashFrozenSkill(root, actualFiles)
    if (actualHash !== entry.sourceSkillHash) {
      throw new Error(`Frozen source skill hash mismatch for '${id}'`)
    }
  }
  return index
}

export function resolveMergeSourceSkillEntryPaths(indexPath: string, entry: MergeSourceSkillIndexEntry) {
  const base = path.dirname(path.resolve(indexPath))
  const root = assertInside(base, path.resolve(base, entry.frozenSkillRoot), `Frozen skill '${entry.sourceCaseID}'`)
  return {
    root,
    readableFiles: entry.readableFiles.map((item) =>
      assertInside(root, path.resolve(base, item), `Readable source skill file '${entry.sourceCaseID}'`),
    ),
    sourceSpecPath: entry.sourceSpecPath
      ? assertInside(base, path.resolve(base, entry.sourceSpecPath), `Frozen source spec '${entry.sourceCaseID}'`)
      : undefined,
  }
}
