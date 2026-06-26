import path from "node:path"
import type { AutoEvolveConfig } from "../schema"
import { autoEvolvePath, ensureDirectory, readJsonFile, readTextFile, writeJsonFile, writeTextFile } from "../fs"
import { appendJsonlIfMissingLocked, ensureJsonlFileLocked, readJsonlFile } from "../jsonl"
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

async function readJsonl<T>(target: string): Promise<T[]> {
  return readJsonlFile<T>(target)
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
  await ensureJsonlFileLocked(paths.indexPath)
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
  await appendJsonlIfMissingLocked<AcceptanceRecord>(
    paths.indexPath,
    record,
    (existing, next) => existing.id === next.id && sameLogicalRecord(existing, next),
  )
  if (mirrorPath) {
    await writeJsonFile(mirrorPath, record)
  }
  return {
    record,
    path: target,
  }
}
