import path from "node:path"
import { autoEvolvePath, ensureDirectory, readJsonFile, readTextFile, writeJsonFile, writeTextFile } from "../fs"
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
  if (!(await readTextFile(paths.indexPath).catch(() => ""))) {
    await writeTextFile(paths.indexPath, "")
  }
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
  const existingIndexed = await findIndexedRecordByID<MaintenanceRequest>(paths.indexPath, request.id)
  if (!existingIndexed || !sameLogicalRecord(existingIndexed, request)) {
    await appendJsonl(paths.indexPath, request)
  }
  if (mirrorPath) {
    await writeJsonFile(mirrorPath, request)
  }
  return {
    request,
    path: target,
  }
}
