import { expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdtemp, mkdir, open, readFile, writeFile, readdir, link } from "node:fs/promises"
import { createHash } from "node:crypto"
import { bindScopedReader, readResourceChunk, readResourceFromEnvironment, resourceReaderEnvironment, type ResourceReaderGrant } from "./scoped-reader"
import { publishTrainingFeedbackResource, publicationResource, type PublishedFeedbackManifest } from "./feedback-publisher"
import { fileDigest } from "./publication-evidence"

const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")
async function fixture(content = "中文🙂Valid public material\n".repeat(200)) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-reader-hardening-"))
  const result = await publishTrainingFeedbackResource({ targetDir: path.join(root, "feedback"), campaignID: "campaign", round: 1,
    cases: [{ caseID: "case1", prompt: "Public prompt", materials: [{ id: "m", name: "text", content }], modelResponse: "Answer", score: 1, passed: true }] })
  const binding = bindScopedReader(result.logicalResource, result.manifest)
  const grant: ResourceReaderGrant = { sessionID: "a".repeat(32), principalID: "actor", role: "lead", stage: "revise", campaignID: "campaign", round: 1,
    planFingerprint: "c".repeat(64), policyFingerprint: "d".repeat(64), hmacSecret: "b".repeat(64), expiresAt: Date.now() + 3600000,
    resourceID: binding.resourceID, version: binding.version, manifestPath: binding.manifestPath, manifestSHA256: binding.sha256,
    casesDir: binding.casesDir, allowedCaseIDs: ["case1"], evidenceRoot: path.join(root, "audit") }
  return { root, binding, grant, result }
}

test("valid Unicode above 9MiB round-trips every byte across bounded pages", async () => {
  const content = "中文🙂NoNewline".repeat(700000)
  expect(Buffer.byteLength(content)).toBeGreaterThan(9 * 1024 * 1024)
  expect(content).not.toContain("\uFFFD")
  const f = await fixture(content)
  const digest = createHash("sha256")
  let cursor: string | undefined
  let total = 0, pages = 0
  for (;;) {
    const chunk = await readResourceChunk(f.binding, { resourceID: f.binding.resourceID, caseID: "case1", cursor, maxBytes: 12001 })
    expect(chunk.data).not.toContain("\uFFFD")
    expect(chunk.returnedBytes).toBeLessThanOrEqual(12001)
    expect(hash(chunk.data)).toBe(chunk.chunkSHA256)
    digest.update(chunk.data)
    total += chunk.returnedBytes
    pages++
    if (chunk.eof) break
    cursor = chunk.nextCursor
    expect(cursor).toBeDefined()
  }
  expect(digest.digest("hex")).toBe(f.result.manifest.cases[0].sha256)
  expect(total).toBe(f.result.manifest.cases[0].bytes)
  expect(pages).toBeGreaterThan(700)
}, 60000)

test("cursor binds session, actor, role, worker, campaign, round, pass, plan, policy and expiry", async () => {
  const f = await fixture()
  const chunk = await readResourceChunk(f.binding, { resourceID: f.binding.resourceID, caseID: "case1", maxBytes: 1024 })
  expect(chunk.eof).toBe(false)
  for (const field of ["sessionID", "principalID", "role", "workerID", "campaignID", "passID", "planFingerprint", "policyFingerprint", "stage"] as const) {
    const changed = { ...f.binding, [field]: "other" }
    await expect(readResourceChunk(changed, { resourceID: changed.resourceID, caseID: "case1", cursor: chunk.nextCursor })).rejects.toThrow("cursor")
  }
  await expect(readResourceChunk({ ...f.binding, round: 2 }, { resourceID: f.binding.resourceID, caseID: "case1", cursor: chunk.nextCursor })).rejects.toThrow("cursor")
  await expect(readResourceChunk({ ...f.binding, expiresAt: 1 }, { resourceID: f.binding.resourceID, caseID: "case1" })).rejects.toThrow("expired")
  for (const size of [NaN, Infinity, 1.5, -1, 0, 128001]) await expect(readResourceChunk(f.binding, { resourceID: f.binding.resourceID, caseID: "case1", maxBytes: size })).rejects.toThrow()
  const abort = new AbortController()
  abort.abort()
  await expect(readResourceChunk(f.binding, { resourceID: f.binding.resourceID, caseID: "case1" }, abort.signal)).rejects.toThrow()
})

test("changed files, hardlinks, expired grants and config drift fail closed; audits contain no data or secret", async () => {
  const f = await fixture()
  const env = await resourceReaderEnvironment(f.grant, path.join(f.root, "private"))
  await readResourceFromEnvironment({ resourceID: f.binding.resourceID, caseID: "case1" }, env)
  await expect(readResourceFromEnvironment({ resourceID: "other", caseID: "case1" }, env)).rejects.toThrow()
  const audit = (await Promise.all((await readdir(f.grant.evidenceRoot!)).map(file => readFile(path.join(f.grant.evidenceRoot!, file), "utf8")))).join("")
  expect(audit).toContain("rejected")
  expect(audit).not.toContain(f.grant.hmacSecret)
  expect(audit).not.toContain("Public prompt")
  expect(audit).not.toContain("Answer")
  const file = path.join(f.binding.casesDir, "case_case1.json")
  await writeFile(file, "tampered")
  await expect(readResourceFromEnvironment({ resourceID: f.binding.resourceID, caseID: "case1" }, env)).rejects.toThrow("changed")
  const g = await fixture()
  await expect(resourceReaderEnvironment({ ...g.grant, expiresAt: 1 }, path.join(g.root, "expired"))).rejects.toThrow()
  await link(path.join(g.binding.casesDir, "case_case1.json"), path.join(g.root, "alias"))
  await expect(readResourceChunk(g.binding, { resourceID: g.binding.resourceID, caseID: "case1" })).rejects.toThrow("unlinked")
  const h = await fixture()
  const cfg = await resourceReaderEnvironment(h.grant, path.join(h.root, "private"))
  await writeFile(cfg.OPENCODE_AEV_RESOURCE_READER_FILE!, "{}")
  await expect(readResourceFromEnvironment({ resourceID: h.binding.resourceID, caseID: "case1" }, cfg)).rejects.toThrow("SHA")
})

test("short physical reads are filled and unexpected zero progress fails closed", async () => {
  const f = await fixture()
  const file = path.join(f.binding.casesDir, "case_case1.json")
  const handle = await open(file, "r")
  const prototype = Object.getPrototypeOf(handle)
  const original = prototype.read
  await handle.close()
  try {
    prototype.read = function(buffer: Buffer, offset: number, length: number, position: number | null) {
      return original.call(this, buffer, offset, Math.min(length, 17), position)
    }
    const chunk = await readResourceChunk(f.binding, { resourceID: f.binding.resourceID, caseID: "case1", maxBytes: 1024 })
    expect(chunk.returnedBytes).toBeGreaterThan(1000)
    expect(chunk.data).not.toContain("\uFFFD")
    // 已完成指纹验证后模拟底层提前EOF，不能当正常短页返回。
    prototype.read = async () => ({ bytesRead: 0 })
    await expect(readResourceChunk(f.binding, { resourceID: f.binding.resourceID, caseID: "case1", cursor: chunk.nextCursor })).rejects.toThrow("unexpected EOF")
  } finally { prototype.read = original }
})

test("64MiB-plus file streams with bounded reader memory and exact digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-reader-64m-"))
  await mkdir(path.join(root, "cases"))
  const file = path.join(root, "cases", "case_large.json")
  const handle = await open(file, "wx")
  // 此夹具流式构造合法JSON，不在内存创建整个压力文件。
  const block = "中🙂abcdefghijklmnop".repeat(1024)
  try {
    await handle.write('{"prompt":"')
    let size = 0
    while (size <= 65 * 1024 * 1024) { await handle.write(block); size += Buffer.byteLength(block) }
    await handle.write('"}\n')
  } finally { await handle.close() }
  const actual = await fileDigest(file)
  const body = { schema: "aev.training-feedback-manifest.v1" as const, resourceID: "feedback:stress:round_1", campaignID: "stress", round: 1,
    version: "stress-v1", totalCases: 1, passedCases: 1, publishedAt: new Date().toISOString(),
    cases: [{ caseID: "large", path: "cases/case_large.json", sha256: actual.sha256, bytes: actual.bytes, passed: true }] }
  const manifest: PublishedFeedbackManifest = { ...body, manifestSHA256: hash(JSON.stringify(body, null, 2)) }
  const manifestPath = path.join(root, "manifest.json")
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(path.join(root, ".published"), manifest.manifestSHA256)
  const binding = bindScopedReader(publicationResource(manifestPath, manifest), manifest)
  Bun.gc(true)
  const initial = process.memoryUsage().rss
  let peak = initial, count = 0, total = 0, cursor: string | undefined
  const digest = createHash("sha256")
  for (;;) {
    const chunk = await readResourceChunk(binding, { resourceID: binding.resourceID, caseID: "large", cursor, maxBytes: 64000 })
    digest.update(chunk.data)
    count++
    total += chunk.returnedBytes
    peak = Math.max(peak, process.memoryUsage().rss)
    if (count % 64 === 0) Bun.gc(true)
    if (chunk.eof) break
    cursor = chunk.nextCursor
  }
  expect(digest.digest("hex")).toBe(actual.sha256)
  expect(total).toBe(actual.bytes)
  expect(peak - initial).toBeLessThan(64 * 1024 * 1024)
  console.log(JSON.stringify({ fixture: "bounded-reader-64MiB", bytes: total, pages: count, initialRSS: initial, peakRSS: peak, growth: peak - initial }))
}, 60000)
