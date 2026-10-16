import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises"
import { writeJsonAtomic } from "../atomic-write"
import { fingerprint } from "../protocol-plugins/identity"
import { resolveResource } from "./binding"

export interface LocalSearchScope {
  schema: "aev.local-search.v1"
  task: string
  role: string
  resources: Array<{ id: string; path: string; mutable: boolean; sha256: string }>
}
export interface LocalSearchConfig extends LocalSearchScope { evidenceRoot: string }
export interface SearchQuery { query: string; resources?: string[] }
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const FILE_LIMIT = 8 * 1024 * 1024
const TOTAL_LIMIT = 64 * 1024 * 1024
const MATCH_LIMIT = 100
const OUTPUT_LIMIT = 32000

export function validateSearchScope(value: unknown): LocalSearchScope {
  const cfg = value as LocalSearchScope
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) || cfg.schema !== "aev.local-search.v1" ||
      !/^[a-f0-9]{64}$/.test(cfg.task) || typeof cfg.role !== "string" || !cfg.role.trim() ||
      Object.keys(cfg).some(key => !["schema", "task", "role", "resources"].includes(key)) ||
      !Array.isArray(cfg.resources) || !cfg.resources.length || cfg.resources.length > 512 ||
      new Set(cfg.resources.map(item => item.id)).size !== cfg.resources.length || cfg.resources.some(item =>
        !item || Object.keys(item).some(key => !["id", "path", "mutable", "sha256"].includes(key)) ||
        typeof item.id !== "string" || !item.id.trim() || item.id.length > 256 || typeof item.path !== "string" || !path.isAbsolute(item.path) ||
        typeof item.mutable !== "boolean" || !/^[a-f0-9]{64}$/.test(item.sha256))) throw new Error("Invalid local search scope")
  return structuredClone(cfg)
}

export async function bindLocalSearch(task: string, role: string, files: Array<{ id: string; path: string; mutable: boolean }>) {
  const resources = []
  let total = 0
  for (const item of files) {
    const bytes = await boundedRead(item.path)
    total += bytes.length
    if (total > TOTAL_LIMIT) throw new Error("Search total input limit exceeded")
    resources.push({ ...item, sha256: hash(bytes) })
  }
  return validateSearchScope({ schema: "aev.local-search.v1", task, role, resources })
}

export function validateLocalSearchAccess(scope: LocalSearchScope, reads: string[], edits: string[], evidenceRoot: string) {
  validateSearchScope(scope)
  const key = (file: string) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file)
  // 可变只说明读当前候选，不代表该角色获得写权限。
  if (!path.isAbsolute(evidenceRoot) || scope.resources.some(item => !reads.some(file => key(file) === key(item.path)))) {
    throw new Error("Search scope exceeds actual file permissions")
  }
  for (const grant of [...reads, ...edits]) {
    const tail = path.relative(grant, evidenceRoot)
    if (!tail || !path.isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${path.sep}`)) throw new Error("Search evidence must be outside model grants")
  }
}

async function boundedRead(file: string) {
  const parent = path.dirname(file)
  if (path.resolve(await realpath(parent)).toLowerCase() !== path.resolve(parent).toLowerCase()) throw new Error("Linked search parent rejected")
  await resolveResource(parent, path.basename(file))
  const handle = await open(file, "r")
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > FILE_LIMIT) throw new Error("Search file exceeds limit or is linked")
    const bytes = Buffer.alloc(Math.min(FILE_LIMIT + 1, before.size + 1))
    let used = 0
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, null)
      if (!read.bytesRead) break
      used += read.bytesRead
    }
    const after = await handle.stat()
    const current = await lstat(file)
    if (used !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ino !== current.ino || current.isSymbolicLink() || current.nlink !== 1) throw new Error("Search resource changed while reading")
    return bytes.subarray(0, used)
  } finally { await handle.close() }
}

export async function searchLocalFiles(value: LocalSearchConfig, request: SearchQuery, signal?: AbortSignal) {
  const { evidenceRoot, ...raw } = value
  const scope = validateSearchScope(raw)
  if (typeof evidenceRoot !== "string" || !path.isAbsolute(evidenceRoot) || !request ||
      Object.keys(request).some(key => !["query", "resources"].includes(key)) || typeof request.query !== "string" ||
      !request.query.trim() || Buffer.byteLength(request.query) > 1024 || request.resources !== undefined &&
      (!Array.isArray(request.resources) || !request.resources.length || new Set(request.resources).size !== request.resources.length ||
        request.resources.some(id => !scope.resources.some(item => item.id === id)))) throw new Error("Invalid scoped search request")
  const resources = request.resources ? scope.resources.filter(item => request.resources!.includes(item.id)) : scope.resources
  const inspected = []
  const matches: Array<{ resource: string; line: number; text: string; lineTruncated: boolean }> = []
  let total = 0, truncated = false
  let outputBytes = 0
  for (const resource of resources) {
    signal?.throwIfAborted()
    const bytes = await boundedRead(resource.path)
    total += bytes.length
    if (total > TOTAL_LIMIT) throw new Error("Search total input limit exceeded")
    const sha256 = hash(bytes)
    if (!resource.mutable && sha256 !== resource.sha256) throw new Error("Frozen search resource drift")
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "")
    if (text.includes("\0")) throw new Error("Local search accepts UTF-8 text only")
    inspected.push({ id: resource.id, sha256, bytes: bytes.length })
    // 不一次拆成百万行数组，防止短行资料放大内存。
    let start = 0, lineNumber = 0
    while (start <= text.length) {
      const next = text.indexOf("\n", start)
      const end = next === -1 ? text.length : next
      const line = text.slice(start, end).replace(/\r$/, "")
      lineNumber++
      if (line.includes(request.query)) {
        const item = { resource: resource.id, line: lineNumber, text: line.slice(0, 2048), lineTruncated: line.length > 2048 }
        const size = Buffer.byteLength(JSON.stringify(item))
        if (matches.length >= MATCH_LIMIT || outputBytes + size > OUTPUT_LIMIT) truncated = true
        else { matches.push(item); outputBytes += size }
      }
      if (next === -1) break
      start = end + 1
      if (lineNumber % 8192 === 0) {
        await new Promise<void>(resolve => setImmediate(resolve))
        signal?.throwIfAborted()
      }
    }
  }
  signal?.throwIfAborted()
  await mkdir(evidenceRoot, { recursive: true })
  if (path.resolve(await realpath(evidenceRoot)).toLowerCase() !== path.resolve(evidenceRoot).toLowerCase()) throw new Error("Linked search evidence rejected")
  // 留下实际读取指纹，命中内容是资料而不是验收判决。
  const receipt = { schema: "aev.local-search-receipt.v1", scope: fingerprint(scope), task: scope.task,
    role: scope.role, query: request.query, inspected, matches, truncated, scopeKind: "declared_local_text" }
  const id = fingerprint(receipt)
  await writeJsonAtomic(path.join(evidenceRoot, `${randomUUID()}.json`), { ...receipt, fingerprint: id })
  return { matches, truncated, inspectedCount: inspected.length, inputBytes: total, receipt: id, scopeKind: "declared_local_text" }
}

export async function localSearchEnvironment(config: LocalSearchConfig | undefined, dir: string) {
  if (!config) return { OPENCODE_AEV_LOCAL_SEARCH_FILE: undefined, OPENCODE_AEV_LOCAL_SEARCH_SHA256: undefined }
  const { evidenceRoot, ...scope } = config
  validateSearchScope(scope)
  if (!path.isAbsolute(dir) || !path.isAbsolute(evidenceRoot)) throw new Error("Absolute private search paths required")
  for (const item of scope.resources) {
    const tail = path.relative(item.path, evidenceRoot)
    if (!tail || !path.isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${path.sep}`)) throw new Error("Search evidence cannot be a model input")
  }
  const file = path.join(dir, "local-search.json")
  await writeJsonAtomic(file, config)
  return { OPENCODE_AEV_LOCAL_SEARCH_FILE: file.replaceAll("\\", "/"),
    OPENCODE_AEV_LOCAL_SEARCH_SHA256: hash(await readFile(file)) }
}

export async function searchFromEnvironment(request: SearchQuery, env: Record<string, string | undefined>, signal?: AbortSignal) {
  const file = env.OPENCODE_AEV_LOCAL_SEARCH_FILE
  const expected = env.OPENCODE_AEV_LOCAL_SEARCH_SHA256
  if (!file || !path.isAbsolute(file) || !expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("Explicit frozen local search binding required")
  const bytes = await boundedRead(file)
  if (bytes.length > 256000 || hash(bytes) !== expected) throw new Error("Local search binding drift")
  const config = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")) as LocalSearchConfig
  return searchLocalFiles(config, request, signal)
}
