import path from "node:path"
import { realpath } from "node:fs/promises"
import { pathExists } from "../fs"
import type {
  InformationViewAccess,
  InformationViewSensitivity,
  RoleAccessPolicy,
} from "./contract"

export type AccessPrincipal = {
  principalID: string
  roleID: string
  workerID?: string
  campaignID: string
  round: number
  pass?: number
  runtime?: string[]
}

export type LogicalResourceKind =
  | "training_feedback"
  | "candidate"
  | "source_skill"
  | "task_plan"
  | "system_internal"

export type LogicalResource = {
  resourceID: string
  kind: LogicalResourceKind
  version: string
  sha256: string
  sensitivity: InformationViewSensitivity
  access: InformationViewAccess
  boundaryRoots: string[]
  paths: string[]
  entryPaths?: string[]
  metadata?: Record<string, unknown>
}

export type AccessDecision = {
  granted: boolean
  principalID: string
  roleID: string
  resourceID: string
  reasonCode:
    | "GRANTED"
    | "SENSITIVITY_DISALLOWED"
    | "ACCESS_MODE_MISMATCH"
    | "RUNTIME_NOT_PERMITTED"
    | "BOUNDARY_ESCAPED"
    | "PRINCIPAL_MISMATCH"
    | "UNKNOWN_RESOURCE"
  message?: string
  allowedPaths?: string[]
}

export type CompiledInvocationGrant = {
  principal: AccessPrincipal
  readablePaths: string[]
  writablePaths: string[]
  referencePaths: string[]
  readerScope?: {
    resourceID: string
    version: string
    sha256: string
    cases: string[]
  }
}

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export async function authorizeResourceAccess(
  principal: AccessPrincipal,
  resource: LogicalResource,
  action: "read" | "write" | "search",
  allowedSensitivities: InformationViewSensitivity[] = ["public", "training"],
): Promise<AccessDecision> {
  // 1. 私有 Oracle 绝对禁止对任何优化 Agent（Worker、Lead 等）开放
  if (resource.sensitivity === "private_oracle") {
    return {
      granted: false,
      principalID: principal.principalID,
      roleID: principal.roleID,
      resourceID: resource.resourceID,
      reasonCode: "SENSITIVITY_DISALLOWED",
      message: "Private oracle materials are strictly sealed against agent access.",
    }
  }

  // 2. 敏感度检查
  if (!allowedSensitivities.includes(resource.sensitivity)) {
    return {
      granted: false,
      principalID: principal.principalID,
      roleID: principal.roleID,
      resourceID: resource.resourceID,
      reasonCode: "SENSITIVITY_DISALLOWED",
      message: `Role sensitivity policy does not permit access to ${resource.sensitivity} resource.`,
    }
  }

  // 3. 访问模式检查 (read vs write)
  if (action === "read" && resource.access === "write_only") {
    return {
      granted: false,
      principalID: principal.principalID,
      roleID: principal.roleID,
      resourceID: resource.resourceID,
      reasonCode: "ACCESS_MODE_MISMATCH",
      message: "Resource is write-only.",
    }
  }
  if (action === "write" && resource.access === "read_only") {
    return {
      granted: false,
      principalID: principal.principalID,
      roleID: principal.roleID,
      resourceID: resource.resourceID,
      reasonCode: "ACCESS_MODE_MISMATCH",
      message: "Resource is read-only.",
    }
  }

  // 4. Runtime 权限检查（针对训练反馈）
  if (resource.kind === "training_feedback") {
    const hasFeedbackRuntime = principal.runtime?.includes("feedback") ?? true
    if (!hasFeedbackRuntime) {
      return {
        granted: false,
        principalID: principal.principalID,
        roleID: principal.roleID,
        resourceID: resource.resourceID,
        reasonCode: "RUNTIME_NOT_PERMITTED",
        message: "Principal lacks runtime.feedback authorization.",
      }
    }
  }

  // 5. 物理路径边界检查（防目录穿越与软链接逃逸）
  const boundaryRoots = resource.boundaryRoots.map((root) => path.resolve(root))
  const allowedPaths: string[] = []

  for (const candidate of resource.paths) {
    const resolvedCandidate = path.resolve(candidate)
    const inBoundary = boundaryRoots.some((root) => isWithin(root, resolvedCandidate))
    if (!inBoundary) {
      return {
        granted: false,
        principalID: principal.principalID,
        roleID: principal.roleID,
        resourceID: resource.resourceID,
        reasonCode: "BOUNDARY_ESCAPED",
        message: `Resource path escapes declared boundaries: ${resolvedCandidate}`,
      }
    }

    if (await pathExists(resolvedCandidate)) {
      const realCandidate = await realpath(resolvedCandidate)
      const realBoundaryRoots = await Promise.all(
        boundaryRoots.map(async (r) => (await pathExists(r) ? realpath(r) : r)),
      )
      const inRealBoundary = realBoundaryRoots.some((r) => isWithin(r, realCandidate))
      if (!inRealBoundary) {
        return {
          granted: false,
          principalID: principal.principalID,
          roleID: principal.roleID,
          resourceID: resource.resourceID,
          reasonCode: "BOUNDARY_ESCAPED",
          message: `Resolved realpath escapes boundary: ${realCandidate}`,
        }
      }
    }
    allowedPaths.push(resolvedCandidate.replaceAll("\\", "/"))
  }

  return {
    granted: true,
    principalID: principal.principalID,
    roleID: principal.roleID,
    resourceID: resource.resourceID,
    reasonCode: "GRANTED",
    allowedPaths,
  }
}
