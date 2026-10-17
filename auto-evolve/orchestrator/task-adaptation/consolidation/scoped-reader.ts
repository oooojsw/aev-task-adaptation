import path from "node:path"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { pathExists } from "../../fs"
import type { LogicalResource } from "../../task-profile-access/unified-access"
import type { PublishedFeedbackManifest } from "./feedback-publisher"

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

function computeCursorSignature(
  resourceID: string,
  caseID: string,
  version: string,
  offset: number,
  manifestSHA: string,
): string {
  return createHash("sha256")
    .update(`${resourceID}:${caseID}:${version}:${offset}:${manifestSHA}`)
    .digest("hex")
    .slice(0, 16)
}

/**
 * 确保分段切片边界严格对齐 UTF-8 字符边界，绝不将多字节字符（如 3 字节中文字符、4 字节 Emoji）截断
 */
function findSafeUtf8End(buffer: Buffer, start: number, targetEnd: number): number {
  if (targetEnd >= buffer.length) return buffer.length
  let pos = targetEnd

  // 若 targetEnd 恰好落在 continuation byte (0b10xxxxxx, 即 0x80 ~ 0xBF)，往前退回至该字符的首字节
  while (pos > start && (buffer[pos] & 0xc0) === 0x80) {
    pos--
  }

  // 此时 buffer[pos] 是一个字符的首字节（或 ASCII 字节）
  const leadByte = buffer[pos]
  let charLen = 1
  if ((leadByte & 0xe0) === 0xc0) charLen = 2
  else if ((leadByte & 0xf0) === 0xe0) charLen = 3
  else if ((leadByte & 0xf8) === 0xf0) charLen = 4

  // 如果首字节所在的完整字符超出了 targetEnd，则放弃该字符（将其留给下一页），确保当前页绝不含半字
  if (pos + charLen > targetEnd) {
    return pos
  }
  return pos + charLen
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
  // 1. 资源 ID 校验
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

  // 3. 物理文件定位
  const caseFile = path.join(binding.casesDir, `case_${input.caseID}.json`)
  if (!(await pathExists(caseFile))) {
    throw new Error(`Physical case file missing for valid caseID: ${input.caseID}`)
  }

  const rawBytes = await readFile(caseFile)
  const totalLength = rawBytes.length

  // 4. 解析与核验 Cursor（签名防伪与防越权）
  let offset = 0
  if (input.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(input.cursor, "base64").toString("utf8"))
      const expectedSig = computeCursorSignature(
        binding.resourceID,
        input.caseID,
        binding.version,
        decoded.offset,
        binding.sha256,
      )

      if (
        decoded.resourceID !== binding.resourceID ||
        decoded.caseID !== input.caseID ||
        decoded.version !== binding.version ||
        decoded.sig !== expectedSig ||
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
  const targetEnd = Math.min(offset + maxBytes, totalLength)

  // 5. UTF-8 字符边界对齐（防止截断中文字符造成乱码）
  const end = targetEnd >= totalLength ? totalLength : findSafeUtf8End(rawBytes, offset, targetEnd)
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
      sig: computeCursorSignature(
        binding.resourceID,
        input.caseID,
        binding.version,
        end,
        binding.sha256,
      ),
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
