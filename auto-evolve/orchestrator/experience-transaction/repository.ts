import path from "node:path"
import type { AutoEvolveConfig } from "../schema"
import { autoEvolvePath, ensureDirectory, writeJsonFile } from "../fs"
import { appendJsonlLocked, ensureJsonlFileLocked } from "../jsonl"
import type { ExperienceTransactionRecord } from "./contract"

export interface ExperienceTransactionPaths {
  root: string
  recordsRoot: string
  indexPath: string
}

function nowISO() {
  return new Date().toISOString()
}

function pad(value: number) {
  return String(value).padStart(2, "0")
}

export function experienceTransactionPaths(
  cwd: string,
  config?: Pick<AutoEvolveConfig, "experienceTransactionDir">,
) {
  const root = config
    ? autoEvolvePath(cwd, config.experienceTransactionDir)
    : autoEvolvePath(cwd, "runtime-state", "experience-transaction")
  return {
    root,
    recordsRoot: path.join(root, "records"),
    indexPath: path.join(root, "index.jsonl"),
  } satisfies ExperienceTransactionPaths
}

export async function ensureExperienceTransactionLayout(paths: ExperienceTransactionPaths) {
  await ensureDirectory(paths.root)
  await ensureDirectory(paths.recordsRoot)
  await ensureJsonlFileLocked(paths.indexPath)
}

function recordPath(
  paths: ExperienceTransactionPaths,
  input: Pick<ExperienceTransactionRecord, "sourceRunID" | "caseID" | "attempt" | "stage"> & {
    maintenanceRound?: number
  },
) {
  const attemptRoot = path.join(paths.recordsRoot, input.sourceRunID, input.caseID, `attempt-${pad(input.attempt)}`)
  const roundSegment = input.maintenanceRound !== undefined ? `round-${pad(input.maintenanceRound)}` : "attempt"
  return path.join(attemptRoot, roundSegment, `${input.stage}.json`)
}

export async function writeExperienceTransactionRecord(
  paths: ExperienceTransactionPaths,
  input: Omit<ExperienceTransactionRecord, "createdAt" | "updatedAt"> & {
    createdAt?: string
    updatedAt?: string
    mirrorPath?: string
  },
) {
  await ensureExperienceTransactionLayout(paths)
  const { mirrorPath, createdAt, updatedAt, ...base } = input
  const record: ExperienceTransactionRecord = {
    ...base,
    createdAt: createdAt ?? nowISO(),
    updatedAt: updatedAt ?? nowISO(),
  }
  const target = recordPath(paths, record)
  await writeJsonFile(target, record)
  await appendJsonlLocked(paths.indexPath, record)
  if (mirrorPath) {
    await writeJsonFile(mirrorPath, record)
  }
  return {
    record,
    path: target,
  }
}
