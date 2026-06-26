import path from "node:path"
import { autoEvolvePath, ensureDirectory, readJsonFile, writeJsonFile } from "../fs"
import { appendJsonlIfMissingLocked, ensureJsonlFileLocked, readJsonlFile } from "../jsonl"
import type { AutoEvolveConfig } from "../schema"
import type { MaintenanceRequest } from "./contract"

export interface MaintenanceGatewayPaths {
  root: string
  requestsRoot: string
  indexPath: string
}

function nowISO() {
  return new Date().toISOString()
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

export function maintenanceGatewayPaths(cwd: string, config?: Pick<AutoEvolveConfig, "maintenanceGatewayDir">) {
  const root = config
    ? autoEvolvePath(cwd, config.maintenanceGatewayDir)
    : autoEvolvePath(cwd, "runtime-state", "maintenance-gateway")
  return {
    root,
    requestsRoot: path.join(root, "requests"),
    indexPath: path.join(root, "index.jsonl"),
  } satisfies MaintenanceGatewayPaths
}

export async function ensureMaintenanceGatewayLayout(paths: MaintenanceGatewayPaths) {
  await ensureDirectory(paths.root)
  await ensureDirectory(paths.requestsRoot)
  await ensureJsonlFileLocked(paths.indexPath)
}

export function maintenanceRequestPath(paths: MaintenanceGatewayPaths, requestID: string) {
  return path.join(paths.requestsRoot, `${requestID}.json`)
}

export async function writeMaintenanceRequest(
  paths: MaintenanceGatewayPaths,
  input: Omit<MaintenanceRequest, "createdAt" | "updatedAt"> & {
    createdAt?: string
    updatedAt?: string
    mirrorPath?: string
  },
) {
  await ensureMaintenanceGatewayLayout(paths)
  const { mirrorPath, createdAt, updatedAt, ...base } = input
  const target = maintenanceRequestPath(paths, base.id)
  const existing = await readJsonFile<MaintenanceRequest>(target).catch(() => undefined)
  const draft: MaintenanceRequest = {
    ...base,
    id: existing?.id ?? base.id,
    createdAt: existing?.createdAt ?? createdAt ?? nowISO(),
    updatedAt: updatedAt ?? nowISO(),
  }
  const request = existing && sameLogicalRecord(existing, draft) ? { ...draft, updatedAt: existing.updatedAt } : draft
  await writeJsonFile(target, request)
  await appendJsonlIfMissingLocked<MaintenanceRequest>(
    paths.indexPath,
    request,
    (existingIndexed, next) => existingIndexed.id === next.id && sameLogicalRecord(existingIndexed, next),
  )
  if (mirrorPath) {
    await writeJsonFile(mirrorPath, request)
  }
  return {
    request,
    path: target,
  }
}
