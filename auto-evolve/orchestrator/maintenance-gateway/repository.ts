import path from "node:path"
import { autoEvolvePath, ensureDirectory, readTextFile, writeJsonFile, writeTextFile } from "../fs"
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
  const request: MaintenanceRequest = {
    ...base,
    createdAt: createdAt ?? nowISO(),
    updatedAt: updatedAt ?? nowISO(),
  }
  const target = maintenanceRequestPath(paths, request.id)
  await writeJsonFile(target, request)
  await appendJsonl(paths.indexPath, request)
  if (mirrorPath) {
    await writeJsonFile(mirrorPath, request)
  }
  return {
    request,
    path: target,
  }
}
