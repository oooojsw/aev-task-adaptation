import path from "node:path"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { pathExists } from "../../fs"
import type { LogicalResource } from "../../task-profile-access/unified-access"
import type { PublishedCaseView, PublishedFeedbackManifest } from "./feedback-publisher"

export type ScopedReaderBinding = {
  resourceID: string
  version: string
  sha256: string
  manifestPath: string
  casesDir: string
  allowedCases: Set<string>
}

export type ReadChunkResult = {
  resourceID: string
  caseID: string
  version: string
  chunkSHA256: string
  offset: number
  returnedBytes: number
  nextCursor?: string
  eof: boolean
  data: string
}

export function bindScopedReader(
  resource: LogicalResource,
  manifest: PublishedFeedbackManifest,
): ScopedReaderBinding {
  if (resource.kind !== "training_feedback") {
    throw new Error(`Cannot bind scoped reader to non-feedback resource kind: ${resource.kind}`)
  }
  const manifestPath = resource.metadata?.manifestPath as string
  if (!manifestPath || typeof manifestPath !== "string") {
    throw new Error("Missing valid manifestPath in resource metadata")
  }

  const casesDir = path.join(path.dirname(manifestPath), "cases")
  const allowedCases = new Set(manifest.cases.map((c) => c.caseID))

  return {
    resourceID: resource.resourceID,
    version: resource.version,
    sha256: resource.sha256,
    manifestPath,
    casesDir,
    allowedCases,
  }
}

export async function readResourceChunk(
  binding: ScopedReaderBinding,
  input: {
    resourceID: string
    caseID: string
    cursor?: string
    maxBytes?: number
  },
): Promise<ReadChunkResult> {
  // 1. 资源 ID 与版本校验
  if (input.resourceID !== binding.resourceID) {
    throw new Error(
      `Resource mismatch: request=${input.resourceID}, bound=${binding.resourceID}`,
    )
  }

  // 2. caseID 白名单校验
  if (!binding.allowedCases.has(input.caseID)) {
    throw new Error(
      `Unauthorized or unknown caseID '${input.caseID}' for resource '${binding.resourceID}'`,
    )
  }

  // 3. 校验并定位物理文件
  const caseFile = path.join(binding.casesDir, `case_${input.caseID}.json`)
  if (!(await pathExists(caseFile))) {
    throw new Error(`Physical case file missing for valid caseID: ${input.caseID}`)
  }

  const rawBytes = await readFile(caseFile)
  const totalLength = rawBytes.length

  // 4. 解析 Cursor（防伪造与越权）
  let offset = 0
  if (input.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(input.cursor, "base64").toString("utf8"))
      if (
        decoded.resourceID !== binding.resourceID ||
        decoded.caseID !== input.caseID ||
        decoded.version !== binding.version ||
        typeof decoded.offset !== "number" ||
        decoded.offset < 0 ||
        decoded.offset > totalLength
      ) {
        throw new Error("Invalid cursor structure or version drift")
      }
      offset = decoded.offset
    } catch {
      throw new Error(`Forged, corrupt or incompatible cursor rejected: ${input.cursor}`)
    }
  }

  const maxBytes = Math.min(Math.max(input.maxBytes ?? 64000, 1024), 128000)
  const end = Math.min(offset + maxBytes, totalLength)
  const chunkSlice = rawBytes.subarray(offset, end)
  const returnedBytes = chunkSlice.length
  const eof = end >= totalLength

  const chunkSHA256 = createHash("sha256").update(chunkSlice).digest("hex")

  let nextCursor: string | undefined
  if (!eof) {
    const nextCursorObj = {
      resourceID: binding.resourceID,
      caseID: input.caseID,
      version: binding.version,
      offset: end,
    }
    nextCursor = Buffer.from(JSON.stringify(nextCursorObj), "utf8").toString("base64")
  }

  return {
    resourceID: binding.resourceID,
    caseID: input.caseID,
    version: binding.version,
    chunkSHA256,
    offset,
    returnedBytes,
    nextCursor,
    eof,
    data: chunkSlice.toString("utf8"),
  }
}
