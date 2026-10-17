import path from "node:path"
import { realpath } from "node:fs/promises"
import { pathExists } from "../fs"
import type {
  InformationViewAccess,
  InformationViewSensitivity,
} from "./contract"

export type TrustedAccessContext = {
  principalKind: "agent" | "host_checker" | "host_publisher" | "independent"
  role: "worker" | "lead" | "planner" | "reviewer" | "checker" | "independent"
  workerID?: string
  stage: "explore" | "revise" | "accept" | "deliver"
  taskPlanFingerprint?: string
  campaignID: string
  taskID?: string
  phase?: string
  currentRound: number
  requestedFeedbackRound?: number
  feedbackPassID?: string
  receiptFingerprint?: string
  policyFingerprint?: string
  runtime?: string[]
}

export type AccessPrincipal = {
  principalID: string
  roleID: string
  workerID?: string
  campaignID: string
  round: number
  pass?: number
  runtime?: string[]
  context?: TrustedAccessContext
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
  metadata?: {
    campaignID?: string
    round?: number
    totalCases?: number
    passedCases?: number
    manifestPath?: string
    [key: string]: unknown
  }
}

export type VerifiedFeedbackResource = {
  schema: "aev.verified-feedback-resource.v1"
  resourceID: string
  manifestPath: string
  manifestSHA256: string
  campaignID: string
  sourceRound: number
  sourcePassID?: string
  expectedCases: number
  boundaryRoots: string[]
  paths: string[]
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
    | "TEMPORAL_VIOLATION"
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
  const role = principal.roleID.toLowerCase()

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

  // 2. 敏感度检查（必须在明确允许列表中）
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

  // 4. Runtime 权限检查（Deny by default：严禁 ?? true）
  if (resource.kind === "training_feedback") {
    const hasFeedbackRuntime = Boolean(principal.runtime && principal.runtime.includes("feedback"))
    if (!hasFeedbackRuntime) {
      return {
        granted: false,
        principalID: principal.principalID,
        roleID: principal.roleID,
        resourceID: resource.resourceID,
        reasonCode: "RUNTIME_NOT_PERMITTED",
        message: "Principal lacks explicit runtime.feedback authorization.",
      }
    }

    // 训练角色仅限 lead 与 worker，其他角色（如 reviewer、checker）无权以 Agent 身份读取训练题目正文
    if (!["lead", "worker"].includes(role)) {
      return {
        granted: false,
        principalID: principal.principalID,
        roleID: principal.roleID,
        resourceID: resource.resourceID,
        reasonCode: "RUNTIME_NOT_PERMITTED",
        message: `Role '${principal.roleID}' is not authorized to consume training feedback cases.`,
      }
    }

    // 5. 跨 Campaign 隔离检查
    const resourceCampaign = resource.metadata?.campaignID
    if (resourceCampaign && principal.campaignID && resourceCampaign !== principal.campaignID) {
      return {
        granted: false,
        principalID: principal.principalID,
        roleID: principal.roleID,
        resourceID: resource.resourceID,
        reasonCode: "PRINCIPAL_MISMATCH",
        message: `Cross-campaign access denied: principal=${principal.campaignID}, resource=${resourceCampaign}`,
      }
    }

    // 6. 轮次时序规则：严禁超前读取未来轮次
    const resourceRound = resource.metadata?.round
    if (typeof resourceRound === "number" && typeof principal.round === "number") {
      if (resourceRound > principal.round) {
        return {
          granted: false,
          principalID: principal.principalID,
          roleID: principal.roleID,
          resourceID: resource.resourceID,
          reasonCode: "TEMPORAL_VIOLATION",
          message: `Cannot access future round feedback: current=${principal.round}, resource=${resourceRound}`,
        }
      }
    }
  }

  // 7. 物理路径边界检查（防目录穿越与软链接逃逸）
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
