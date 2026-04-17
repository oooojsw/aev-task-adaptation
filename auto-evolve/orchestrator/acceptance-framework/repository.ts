import path from "node:path"
import type { AutoEvolveConfig } from "../schema"
import { autoEvolvePath, ensureDirectory, readJsonFile, readTextFile, writeJsonFile, writeTextFile } from "../fs"
import type { AcceptanceRecord } from "./contract"

export interface AcceptanceFrameworkPaths {
  root: string
  recordsRoot: string
  indexPath: string
}

function nowISO() {
  return new Date().toISOString()
}

function sanitizeSegment(input: string) {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "_")
}

async function appendJsonl<T>(target: string, value: T) {
  await ensureDirectory(path.dirname(target))
  const existing = await readTextFile(target).catch(() => "")
  await writeTextFile(target, existing + JSON.stringify(value) + "\n")
}

async function readJsonl<T>(target: string): Promise<T[]> {
  const raw = await readTextFile(target).catch(() => "")
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

function stripRecordTimestamps<T extends { createdAt?: string; updatedAt?: string }>(value: T) {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = value
  return rest
}

function sameLogicalRecord<T extends { createdAt?: string; updatedAt?: string }>(left: T, right: T) {
  return JSON.stringify(stripRecordTimestamps(left)) === JSON.stringify(stripRecordTimestamps(right))
}

async function findIndexedRecordByID<T extends { id: string }>(target: string, id: string) {
  return (await readJsonl<T>(target)).find((item) => item.id === id)
}

export function acceptanceFrameworkPaths(
  cwd: string,
  config?: Pick<AutoEvolveConfig, "acceptanceFrameworkDir">,
) {
  const root = config
    ? autoEvolvePath(cwd, config.acceptanceFrameworkDir)
    : autoEvolvePath(cwd, "runtime-state", "acceptance-framework")
  return {
    root,
    recordsRoot: path.join(root, "records"),
    indexPath: path.join(root, "index.jsonl"),
  } satisfies AcceptanceFrameworkPaths
}

export async function ensureAcceptanceFrameworkLayout(paths: AcceptanceFrameworkPaths) {
  await ensureDirectory(paths.root)
  await ensureDirectory(paths.recordsRoot)
  if (!(await readTextFile(paths.indexPath).catch(() => ""))) {
    await writeTextFile(paths.indexPath, "")
  }
}

function recordPath(paths: AcceptanceFrameworkPaths, record: AcceptanceRecord) {
  return path.join(
    paths.recordsRoot,
    sanitizeSegment(record.sourceRunID),
    `${sanitizeSegment(record.targetKind)}-${sanitizeSegment(record.targetID)}-${sanitizeSegment(record.stageID)}.json`,
  )
}

export async function writeAcceptanceRecord(
  paths: AcceptanceFrameworkPaths,
  input: Omit<AcceptanceRecord, "createdAt" | "updatedAt"> & {
    createdAt?: string
    updatedAt?: string
    mirrorPath?: string
  },
) {
  await ensureAcceptanceFrameworkLayout(paths)
  const { mirrorPath, createdAt, updatedAt, ...base } = input
  const provisional: AcceptanceRecord = {
    ...base,
    createdAt: createdAt ?? nowISO(),
    updatedAt: updatedAt ?? nowISO(),
  }
  const target = recordPath(paths, provisional)
  const existing = await readJsonFile<AcceptanceRecord>(target).catch(() => undefined)
  const draft: AcceptanceRecord = {
    ...provisional,
    id: existing?.id ?? provisional.id,
    createdAt: existing?.createdAt ?? provisional.createdAt,
    updatedAt: provisional.updatedAt,
  }
  const record = existing && sameLogicalRecord(existing, draft) ? { ...draft, updatedAt: existing.updatedAt } : draft
  await writeJsonFile(target, record)
  const existingIndexed = await findIndexedRecordByID<AcceptanceRecord>(paths.indexPath, record.id)
  if (!existingIndexed || !sameLogicalRecord(existingIndexed, record)) {
    await appendJsonl(paths.indexPath, record)
  }
  if (mirrorPath) {
    await writeJsonFile(mirrorPath, record)
  }
  return {
    record,
    path: target,
  }
}
