import path from "node:path"
import { open, stat } from "node:fs/promises"
import { createHash, createHmac, randomBytes } from "node:crypto"
import { pathExists, readJsonFile } from "../../fs"
import type { LogicalResource } from "../../task-profile-access/unified-access"
import type { PublishedFeedbackManifest } from "./feedback-publisher"

export type ScopedReaderBinding = {
  resourceID: string
  version: string
  sha256: string
  manifestPath: string
  casesDir: string
  allowedCases: Set<string>
  hmacSecret: string
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

function computeCursorHmac(
  secret: string,
  resourceID: string,
  caseID: string,
  version: string,
  offset: number,
  manifestSHA: string,
): string {
  return createHmac("sha256", secret)
    .update(`${resourceID}:${caseID}:${version}:${offset}:${manifestSHA}`)
    .digest("hex")
    .slice(0, 32)
}

/**
 * 确保分段切片边界严格对齐 UTF-8 字符边界，绝不将多字节字符（如 3 字节中文字符、4 字节 Emoji）截断。
 * 检查 buffer 末尾是否落在未闭合的多字节字符序列中，若是，则退回至该字符之前。
 */
function findSafeUtf8Length(buffer: Buffer): number {
  const len = buffer.length
  if (len === 0) return 0

  // 往后最多回溯 4 个字节，寻找最后一个可能未闭合字符的 lead byte
  for (let i = 1; i <= Math.min(4, len); i++) {
    const byte = buffer[len - i]
    // ASCII 字符自成一体
    if ((byte & 0x80) === 0x00) {
      break
    }
    // 找到了多字节字符的 lead byte
    if ((byte & 0xc0) === 0xc0) {
      let expectedLen = 1
      if ((byte & 0xe0) === 0xc0) expectedLen = 2
      else if ((byte & 0xf0) === 0xe0) expectedLen = 3
      else if ((byte & 0xf8) === 0xf0) expectedLen = 4

      // 如果这个字符在当前 buffer 中包含的字节数 i 小于它所需要的完整字节数 expectedLen
      // 说明它被截断了！安全的末尾必须排空这 i 个未闭合字节，留给下一个分段
      if (i < expectedLen) {
        return len - i
      }
      return len
    }
    // continuation byte (0b10xxxxxx)，继续往前寻找其所属的 lead byte
  }
  return len
}

export function bindScopedReader(
  resource: LogicalResource,
  manifest: PublishedFeedbackManifest,
  secret?: string,
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
    hmacSecret: secret ?? randomBytes(32).toString("hex"),
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

  // 4. 解析与核验 Cursor（HMAC 密码学防伪签名校验）
  let offset = 0
  const fileStats = await stat(caseFile)
  const totalLength = fileStats.size

  if (input.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(input.cursor, "base64").toString("utf8"))
      const expectedHmac = computeCursorHmac(
        binding.hmacSecret,
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
        decoded.sig !== expectedHmac ||
        typeof decoded.offset !== "number" ||
        decoded.offset < 0 ||
        decoded.offset > totalLength
      ) {
        throw new Error("Invalid cursor structure or HMAC verification failed")
      }
      offset = decoded.offset
    } catch {
      throw new Error(`Forged, corrupt or incompatible cursor rejected: ${input.cursor}`)
    }
  }

  const maxBytes = Math.min(Math.max(input.maxBytes ?? 64000, 1024), 128000)
  const targetEnd = Math.min(offset + maxBytes, totalLength)
  const readLen = targetEnd - offset

  // 5. 真实的“物理有界 I/O”：仅使用 FileHandle 读取指定区间字节，绝不加载整份文件
  const handle = await open(caseFile, "r")
  let rawBytes: Buffer
  try {
    const rawBuffer = Buffer.alloc(readLen)
    const { bytesRead } = await handle.read(rawBuffer, 0, readLen, offset)
    rawBytes = rawBuffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }

  // 6. UTF-8 字符边界对齐（防止截断中文字符造成乱码）
  const actualSafeLen = targetEnd >= totalLength ? rawBytes.length : findSafeUtf8Length(rawBytes)
  const chunkSlice = rawBytes.subarray(0, actualSafeLen)
  const actualEnd = offset + chunkSlice.length
  const returnedBytes = chunkSlice.length
  const eof = actualEnd >= totalLength

  const chunkSHA256 = createHash("sha256").update(chunkSlice).digest("hex")

  let nextCursor: string | undefined
  if (!eof) {
    const nextCursorObj = {
      resourceID: binding.resourceID,
      caseID: input.caseID,
      version: binding.version,
      offset: actualEnd,
      sig: computeCursorHmac(
        binding.hmacSecret,
        binding.resourceID,
        input.caseID,
        binding.version,
        actualEnd,
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

/**
 * 供 OpenCode 工具 aev_read_resource 调用的环境适配器
 */
export async function readResourceFromEnvironment(
  input: { resourceID: string; caseID: string; cursor?: string; maxBytes?: number },
  env: NodeJS.ProcessEnv,
): Promise<ReadChunkResult> {
  const configFile = env.OPENCODE_AEV_RESOURCE_READER_FILE
  if (!configFile || !(await pathExists(configFile))) {
    throw new Error("aev_read_resource is not configured or permitted in this session")
  }
  const rawJson = await readJsonFile<any>(configFile)
  let binding: ScopedReaderBinding
  if (rawJson.schema === "aev.training-feedback-manifest.v1") {
    const casesDir = path.join(path.dirname(configFile), "cases")
    const allowedCases = new Set<string>((rawJson.cases || []).map((c: any) => c.caseID))
    binding = {
      resourceID: rawJson.resourceID,
      version: rawJson.version,
      sha256: rawJson.manifestSHA256,
      manifestPath: configFile,
      casesDir,
      allowedCases,
      hmacSecret:
        env.OPENCODE_AEV_HMAC_SECRET ??
        createHash("sha256").update(`${rawJson.manifestSHA256}:aev_internal_reader`).digest("hex"),
    }
  } else if (rawJson.casesDir && (rawJson.allowedCases || rawJson.resourceID)) {
    binding = {
      ...rawJson,
      allowedCases: new Set(
        Array.isArray(rawJson.allowedCases)
          ? rawJson.allowedCases
          : rawJson.allowedCases instanceof Set
            ? Array.from(rawJson.allowedCases)
            : Object.keys(rawJson.allowedCases ?? {}),
      ),
    }
  } else {
    throw new Error("Invalid resource reader configuration file")
  }
  return readResourceChunk(binding, input)
}
