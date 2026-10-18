import path from "node:path"
import { open, readFile, realpath, mkdir } from "node:fs/promises"
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { pathExists } from "../../fs"
import { writeJsonAtomic } from "../../atomic-write"
import { regular, verifyPublication } from "./publication-evidence"
import type { LogicalResource } from "../../task-profile-access/unified-access"
import type { PublishedFeedbackManifest } from "./feedback-publisher"

export type ResourceReaderGrant = {
  sessionID: string
  principalID: string
  role: string
  workerID?: string
  campaignID: string
  round: number
  passID?: string
  resourceID: string
  version: string
  manifestPath: string
  manifestSHA256: string
  casesDir: string
  allowedCaseIDs: string[]
  hmacSecret: string
  evidenceRoot?: string
  planFingerprint: string
  policyFingerprint: string
  stage: string
  expiresAt: number
}

function within(root: string, file: string) {
  const tail = path.relative(path.resolve(root), path.resolve(file))
  return !tail || !path.isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${path.sep}`)
}

async function validateGrant(grant: ResourceReaderGrant) {
  if (!grant || !/^[a-f0-9]{32}$/.test(grant.sessionID) || !/^[a-f0-9]{64}$/.test(grant.hmacSecret) ||
      !grant.principalID || !["lead", "worker"].includes(grant.role) ||
      !/^[a-f0-9]{64}$/.test(grant.planFingerprint) || !/^[a-f0-9]{64}$/.test(grant.policyFingerprint) ||
      grant.stage !== (grant.role === "worker" ? "explore" : "revise") ||
      !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now() ||
      grant.role === "worker" && !grant.workerID || !grant.campaignID ||
      !Number.isSafeInteger(grant.round) || grant.round < 1 || !path.isAbsolute(grant.manifestPath) ||
      !/^[a-f0-9]{64}$/.test(grant.manifestSHA256) || !Array.isArray(grant.allowedCaseIDs)) {
    throw new Error("Invalid resource reader configuration grant")
  }
  const manifest = await verifyPublication(grant.manifestPath, grant.manifestSHA256)
  if (manifest.campaignID !== grant.campaignID || manifest.round > grant.round || manifest.version !== grant.version ||
      manifest.resourceID !== grant.resourceID || path.resolve(grant.casesDir) !== path.join(path.dirname(grant.manifestPath), "cases") ||
      grant.allowedCaseIDs.length !== manifest.cases.length || new Set(grant.allowedCaseIDs).size !== manifest.cases.length ||
      manifest.cases.some(item => !grant.allowedCaseIDs.includes(item.caseID))) throw new Error("Resource reader publication binding mismatch")
  return manifest
}

export async function validateResourceReaderAccess(grant: ResourceReaderGrant, reads: string[], edits: string[], evidenceRoot: string) {
  await validateGrant(grant)
  if (!path.isAbsolute(evidenceRoot) || !reads.some(file => path.resolve(file) === path.resolve(grant.manifestPath))) {
    throw new Error("Reader requires explicit index permission and private evidence root")
  }
  // 大题只经专用工具读取；审计和授权密钥不能成为模型材料。
  if ([...reads, ...edits].some(file => within(file, evidenceRoot)) ||
      reads.some(file => within(file, grant.casesDir) || within(grant.casesDir, file)) ||
      edits.some(file => within(file, grant.manifestPath) || within(file, grant.casesDir))) {
    throw new Error("Resource reader scope exceeds actual file permissions")
  }
}

export type ScopedReaderBinding = {
  resourceID: string
  version: string
  sha256: string
  manifestPath: string
  casesDir: string
  allowedCases: Set<string>
  hmacSecret: string
  sessionID?: string
  principalID?: string
  role?: string
  campaignID?: string
  round?: number
  evidenceRoot?: string
  workerID?: string
  passID?: string
  planFingerprint?: string
  policyFingerprint?: string
  stage?: string
  expiresAt?: number
}

const sessions = new WeakMap<ScopedReaderBinding, Promise<Map<string, Awaited<ReturnType<typeof regular>>>>>()
const configured = new Map<string, { binding: ScopedReaderBinding; stamp: Awaited<ReturnType<typeof regular>> }>()
const unchanged = (a: Awaited<ReturnType<typeof regular>>, b: Awaited<ReturnType<typeof regular>>) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs

async function snapshot(binding: ScopedReaderBinding) {
  let pending = sessions.get(binding)
  if (!pending) {
    pending = (async () => {
      const identities = new Map<string, Awaited<ReturnType<typeof regular>>>()
      const manifest = await verifyPublication(binding.manifestPath, binding.sha256, identities)
      if (manifest.resourceID !== binding.resourceID || manifest.version !== binding.version ||
          path.resolve(binding.casesDir) !== path.join(path.dirname(binding.manifestPath), "cases") ||
          binding.allowedCases.size !== manifest.cases.length || manifest.cases.some(item => !binding.allowedCases.has(item.caseID))) throw new Error("Reader publication identity mismatch")
      return identities
    })()
    sessions.set(binding, pending)
  }
  return pending
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
  binding: ScopedReaderBinding,
  caseID: string,
  offset: number,
): string {
  return createHmac("sha256", binding.hmacSecret)
    .update(JSON.stringify({ session: binding.sessionID, actor: binding.principalID, role: binding.role, worker: binding.workerID,
      campaign: binding.campaignID, round: binding.round, pass: binding.passID, plan: binding.planFingerprint,
      policy: binding.policyFingerprint, stage: binding.stage, expiry: binding.expiresAt, resource: binding.resourceID,
      version: binding.version, manifest: binding.sha256, caseID, field: "public_case", offset }))
    .digest("hex")
}

function safeHmacEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false
  const bufA = Buffer.from(a, "hex")
  const bufB = Buffer.from(b, "hex")
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
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
    sessionID: randomBytes(16).toString("hex"), expiresAt: Date.now() + 3600000,
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
  signal?: AbortSignal,
): Promise<ReadChunkResult> {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(binding.expiresAt) || binding.expiresAt! <= Date.now()) throw new Error("Reader session expired")
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

  // 3. 物理文件定位与防逃逸检查
  const caseFile = path.join(binding.casesDir, `case_${input.caseID}.json`)
  if (!(await pathExists(caseFile))) {
    throw new Error(`Physical case file missing for valid caseID: ${input.caseID}`)
  }
  const resolvedCasesDir = await realpath(binding.casesDir)
  const resolvedCaseFile = await realpath(caseFile)
  if (!resolvedCaseFile.startsWith(resolvedCasesDir + path.sep)) {
    throw new Error(`Path traversal or symlink escape detected for case ${input.caseID}`)
  }

  // 4. 解析与核验 Cursor（HMAC 密码学防伪签名校验）
  let offset = 0
  const identities = await snapshot(binding)
  // 首次流式核验全文件；后续页绑定相同物理身份，不逐页重读全量。
  for (const file of [binding.manifestPath, path.join(path.dirname(binding.manifestPath), ".published"), caseFile]) {
    if (!unchanged(identities.get(file)!, await regular(file))) throw new Error("Reader source changed after verification")
  }
  const fileStats = identities.get(caseFile)!
  const totalLength = fileStats.size

  if (input.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(input.cursor, "base64").toString("utf8"))
      const expectedHmac = computeCursorHmac(binding, input.caseID, decoded.offset)

      if (
        decoded.resourceID !== binding.resourceID ||
        decoded.caseID !== input.caseID ||
        decoded.version !== binding.version ||
        !safeHmacEqual(decoded.sig, expectedHmac) ||
        !Number.isSafeInteger(decoded.offset) ||
        decoded.offset < 0 ||
        decoded.offset > totalLength
      ) {
        throw new Error("Invalid cursor structure or HMAC verification failed")
      }
      offset = decoded.offset
    } catch {
      throw new Error("Forged, corrupt or incompatible cursor rejected")
    }
  }

  let maxBytes = 64000
  if (input.maxBytes !== undefined) {
    if (typeof input.maxBytes !== "number" || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1024 || input.maxBytes > 128000) {
      throw new Error(`Invalid maxBytes: ${input.maxBytes}. Must be safe integer between 1024 and 128000.`)
    }
    maxBytes = input.maxBytes
  }

  const targetEnd = Math.min(offset + maxBytes, totalLength)
  const readLen = targetEnd - offset

  // 5. 真实的“物理有界 I/O”：仅使用 FileHandle 读取指定区间字节，绝不加载整份文件
  const handle = await open(caseFile, "r")
  let rawBytes: Buffer
  try {
    if (!unchanged(fileStats, await handle.stat())) throw new Error("Reader source replaced before open")
    const rawBuffer = Buffer.alloc(readLen)
    let used = 0
    while (used < readLen) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(rawBuffer, used, readLen - used, offset + used)
      if (!bytesRead) throw new Error("Reader reached unexpected EOF without progress")
      used += bytesRead
    }
    if (!unchanged(fileStats, await handle.stat()) || !unchanged(fileStats, await regular(caseFile))) throw new Error("Reader source changed during read")
    rawBytes = rawBuffer
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
      sig: computeCursorHmac(binding, input.caseID, actualEnd),
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
    data: new TextDecoder("utf-8", { fatal: true }).decode(chunkSlice),
  }
}

/**
 * 供 Host 在为子进程准备 overrideConfigDir 时写入私有受信 reader 配置与 SHA
 */
export async function resourceReaderEnvironment(
  grant: ResourceReaderGrant | undefined,
  dir: string,
): Promise<{
  OPENCODE_AEV_RESOURCE_READER_FILE?: string
  OPENCODE_AEV_RESOURCE_READER_SHA256?: string
}> {
  if (!grant) {
    return {
      OPENCODE_AEV_RESOURCE_READER_FILE: undefined,
      OPENCODE_AEV_RESOURCE_READER_SHA256: undefined,
    }
  }
  if (!path.isAbsolute(dir)) throw new Error("Absolute private reader path required")
  await validateGrant(grant)
  const file = path.join(dir, "resource-reader.json")
  await writeJsonAtomic(file, grant)
  const fileBytes = await readFile(file)
  const sha = createHash("sha256").update(fileBytes).digest("hex")
  return {
    OPENCODE_AEV_RESOURCE_READER_FILE: file.replaceAll("\\", "/"),
    OPENCODE_AEV_RESOURCE_READER_SHA256: sha,
  }
}

/**
 * 供 OpenCode 工具 aev_read_resource 调用的环境适配器
 * 必须校验 Host 写入的私有 config 及其 SHA256，严禁从公开 manifest 自推导秘钥
 */
export async function readResourceFromEnvironment(
  input: { resourceID: string; caseID: string; cursor?: string; maxBytes?: number },
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<ReadChunkResult> {
  const configFile = env.OPENCODE_AEV_RESOURCE_READER_FILE
  const expectedSHA = env.OPENCODE_AEV_RESOURCE_READER_SHA256
  if (!configFile || !expectedSHA || !(await pathExists(configFile))) {
    throw new Error("aev_read_resource is not configured or permitted in this session")
  }
  const info = await regular(configFile)
  if (info.size > 1048576) throw new Error("Resource reader config capacity exceeded")
  const previous = configured.get(expectedSHA)
  if (previous && !unchanged(previous.stamp, info)) throw new Error("Resource reader config changed after binding")
  const fileBytes = await readFile(configFile)
  const actualSHA = createHash("sha256").update(fileBytes).digest("hex")
  if (actualSHA !== expectedSHA) {
    throw new Error("Resource reader config SHA mismatch; possible tampering")
  }
  const grant = JSON.parse(fileBytes.toString("utf8").replace(/^\uFEFF/, "")) as ResourceReaderGrant
  if (!previous) await validateGrant(grant)
  const allowedCases = new Set(grant.allowedCaseIDs)
  const binding: ScopedReaderBinding = previous?.binding ?? {
    resourceID: grant.resourceID,
    version: grant.version,
    sha256: grant.manifestSHA256,
    manifestPath: grant.manifestPath,
    casesDir: grant.casesDir,
    allowedCases,
    hmacSecret: grant.hmacSecret,
    sessionID: grant.sessionID,
    principalID: grant.principalID,
    role: grant.role,
    campaignID: grant.campaignID,
    round: grant.round,
    evidenceRoot: grant.evidenceRoot,
    workerID: grant.workerID, passID: grant.passID, planFingerprint: grant.planFingerprint,
    policyFingerprint: grant.policyFingerprint, stage: grant.stage, expiresAt: grant.expiresAt,
  }
  if (!previous) {
    if (configured.size >= 64) configured.delete(configured.keys().next().value!)
    configured.set(expectedSHA, { binding, stamp: info })
  }
  const audit = async (status: string, result?: ReadChunkResult) => {
    if (!binding.evidenceRoot || !path.isAbsolute(binding.evidenceRoot)) throw new Error("Private reader audit required")
    await mkdir(binding.evidenceRoot, { recursive: true })
    if (path.resolve(await realpath(binding.evidenceRoot)).toLowerCase() !== path.resolve(binding.evidenceRoot).toLowerCase()) throw new Error("Linked reader audit rejected")
    await writeJsonAtomic(path.join(binding.evidenceRoot, `${randomUUID()}.json`), { schema: "aev.reader-audit.v1",
      sessionID: binding.sessionID, resourceID: binding.resourceID, caseID: binding.allowedCases.has(input.caseID) ? input.caseID : "unauthorized",
      status, ...(result ? { offset: result.offset, bytes: result.returnedBytes, chunkSHA256: result.chunkSHA256, eof: result.eof } : {}) })
  }
  try {
    const result = await readResourceChunk(binding, input, signal)
    await audit("completed", result)
    return result
  } catch (error) { await audit("rejected"); throw error }
}
