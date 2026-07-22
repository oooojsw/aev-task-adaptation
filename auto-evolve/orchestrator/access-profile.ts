import path from "node:path"
import {
  assertNoDirectoryReadPaths,
} from "./long-task-campaign/blank-agent-evidence"
import {
  assertExpertOracleReadPaths,
  assertNoOracleLeakageInBlankAgentChannel,
} from "./long-task-campaign/expert-oracle-evidence"

export type AccessProfileMode =
  | "open_book"
  | "closed_book"
  | "readonly_audit"
  | "maintenance"
  | "validator"

export type AccessProfile = {
  role: string
  mode: AccessProfileMode
  referencePaths: string[]
  permissionReadPaths: string[]
  permissionEditPaths: string[]
}

export type AccessProfileInput = {
  role: string
  mode: AccessProfileMode
  basePaths?: string[]
  referencePaths?: Array<string | undefined>
  readPaths?: Array<string | undefined>
  editPaths?: Array<string | undefined>
  carryoverFiles?: string[]
  blankAgentEvidenceBundlePath?: string
  blankAgentEvidenceReadPaths?: string[]
  expertOracleBundlePath?: string
  expertOracleReadPaths?: string[]
}

const CLOSED_BOOK_FORBIDDEN_PATTERNS = [
  /(?:^|[\\/])private-answers(?:[\\/]|$)/i,
  /(?:^|[\\/])result\.private\.json$/i,
  /(?:^|[\\/])result\.training\.json$/i,
  /(?:^|[\\/])validator_input\.json$/i,
  /(?:^|[\\/])expert-oracle-bundle\.json$/i,
  /(?:^|[\\/])campaign-working-memory\.json$/i,
  /(?:^|[\\/])exploration-tree\.json$/i,
  /(?:^|[\\/])routing-control\.json$/i,
  /(?:^|[\\/])retry_input_bundle\.json$/i,
]

function uniqueAccessPaths(items: Array<string | undefined>) {
  return Array.from(new Set(items.filter((item): item is string => typeof item === "string" && item.trim().length > 0)))
}

function normalizedForMatch(input: string) {
  return input.split(path.sep).join("/")
}

function assertClosedBookSafe(paths: string[], label: string) {
  for (const item of paths) {
    const normalized = normalizedForMatch(item)
    if (CLOSED_BOOK_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(normalized))) {
      throw new Error(`${label} cannot expose closed-book-forbidden path: ${item}`)
    }
  }
}

export async function buildAccessProfile(input: AccessProfileInput): Promise<AccessProfile> {
  const label = `access-profile:${input.role}:${input.mode}`
  const blankEvidencePaths = uniqueAccessPaths(input.blankAgentEvidenceReadPaths ?? [])
  const expertOraclePaths = uniqueAccessPaths(input.expertOracleReadPaths ?? [])

  if (input.mode === "closed_book") {
    if (input.blankAgentEvidenceBundlePath || blankEvidencePaths.length) {
      throw new Error(`${label} cannot receive blank-agent evidence bundles.`)
    }
    if (input.expertOracleBundlePath || expertOraclePaths.length) {
      throw new Error(`${label} cannot receive expert oracle bundles or private answer paths.`)
    }
  }

  if (blankEvidencePaths.length) {
    assertNoDirectoryReadPaths(blankEvidencePaths, `${label} blank-agent-evidence read paths`)
    assertNoOracleLeakageInBlankAgentChannel(blankEvidencePaths, `${label} blank-agent-evidence read paths`)
  }

  if (expertOraclePaths.length) {
    if (input.mode !== "open_book" && input.mode !== "validator" && input.mode !== "readonly_audit") {
      throw new Error(`${label} cannot read expert oracle paths in mode ${input.mode}.`)
    }
    await assertExpertOracleReadPaths(expertOraclePaths, `${label} expert-oracle read paths`)
  }

  const readPaths = uniqueAccessPaths([
    ...(input.basePaths ?? []),
    ...(input.readPaths ?? []),
    ...(input.blankAgentEvidenceBundlePath ? [input.blankAgentEvidenceBundlePath] : []),
    ...blankEvidencePaths,
    ...(input.expertOracleBundlePath ? [input.expertOracleBundlePath] : []),
    ...expertOraclePaths,
    ...(input.carryoverFiles ?? []),
  ])
  const referencePaths = uniqueAccessPaths([...(input.referencePaths ?? readPaths)])
  const editPaths = input.mode === "readonly_audit" ? [] : uniqueAccessPaths(input.editPaths ?? [])

  if (input.mode === "closed_book") {
    assertClosedBookSafe([...readPaths, ...referencePaths, ...editPaths], label)
  }

  return {
    role: input.role,
    mode: input.mode,
    referencePaths,
    permissionReadPaths: readPaths,
    permissionEditPaths: editPaths,
  }
}
