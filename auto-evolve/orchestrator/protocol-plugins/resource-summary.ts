import path from "node:path"
import { readdir, readFile, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fingerprint } from "./identity"

const schemas = new Set(["aev.training-invocation-accounting.v1", "aev.backend-invocation-accounting.v1"])
function token(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

export async function summarizeResources(root: string) {
  if (!path.isAbsolute(root) || await realpath(root) !== path.resolve(root)) throw new Error("Canonical absolute resource root required")
  const rows: Array<{ path: string; sha256: string; role: string; status: string; requestFingerprint: string;
    inputTokens: number | null; outputTokens: number | null; elapsedMs: number | null }> = []
  const claims = new Set<string>()
  const recorded = new Set<string>()
  const ignoredAcceptance: string[] = []
  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Linked resource evidence is not traversed")
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) { await visit(file); continue }
      if (entry.name === "started.claim") claims.add(dir)
      if (entry.name === "protocol.accounting.json") { ignoredAcceptance.push(file); continue }
      if (!["accounting.json", "invocation.accounting.json"].includes(entry.name)) continue
      const bytes = await readFile(file)
      const record = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""))
      if (!schemas.has(record.schema)) throw new Error(`Unknown invocation accounting schema: ${file}`)
      if (record.reused !== false || typeof record.status !== "string" ||
        typeof record.requestFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(record.requestFingerprint)) {
        throw new Error(`Invalid physical invocation identity: ${file}`)
      }
      if (recorded.has(dir)) throw new Error(`Duplicate physical invocation ledger: ${dir}`)
      recorded.add(dir)
      rows.push({ path: file, sha256: createHash("sha256").update(bytes).digest("hex"),
        role: record.role ?? record.transport ?? "tool-backend", status: record.status, requestFingerprint: record.requestFingerprint,
        inputTokens: token(record.inputTokens), outputTokens: token(record.outputTokens),
        elapsedMs: typeof record.elapsedMs === "number" && Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0 ? record.elapsedMs : null })
    }
  }
  await visit(root)
  // 只累计实际调用叶账；验收摘要与其重叠，不能再相加。
  const missing: string[] = []
  const ignoredWrapperClaims: string[] = []
  for (const dir of [...claims].filter((item) => !recorded.has(item))) {
    const completed = await readFile(path.join(dir, "completed.json"), "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      return null
    })
    if (completed) {
      const cache = JSON.parse(completed.replace(/^\uFEFF/, ""))
      if (cache.schema === "aev.plugin-cache.v1") {
        if (cache.bodyFingerprint !== fingerprint(cache.body) || cache.request !== path.basename(dir)) throw new Error("Cache wrapper identity drift")
        ignoredWrapperClaims.push(dir)
        continue
      }
    }
    missing.push(dir)
  }
  missing.sort()
  const total = (field: "inputTokens" | "outputTokens") => {
    const knownTokens = rows.reduce((sum, row) => sum + (row[field] ?? 0), 0)
    if (!Number.isSafeInteger(knownTokens)) throw new Error("Resource token total overflow")
    return { knownTokens, unreportedInvocations: rows.filter((row) => row[field] === null).length,
      startedWithoutLedger: missing.length, completeForDiscoveredInvocations: missing.length === 0 && rows.every((row) => row[field] !== null && row.status === "completed") }
  }
  return { schema: "aev.resource-summary.v1", root, invocations: rows.sort((a, b) => a.path.localeCompare(b.path)),
    startedWithoutLedger: missing, ignoredWrapperClaims: ignoredWrapperClaims.sort(), ignoredOverlappingAcceptance: ignoredAcceptance.sort(), input: total("inputTokens"), output: total("outputTokens"),
    fee: null, scope: "Discovered physical invocation ledgers only; excludes uninstrumented legacy/optional calls. Unclassified started claims may be wrapper claims, not proven API calls. Invocation elapsed times overlap and are not wall time." }
}
