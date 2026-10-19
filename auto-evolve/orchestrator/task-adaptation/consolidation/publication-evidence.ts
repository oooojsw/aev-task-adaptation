import path from "node:path"
import { createHash } from "node:crypto"
import { lstat, readFile, realpath, open } from "node:fs/promises"
import type { PublishedFeedbackManifest } from "./feedback-publisher"

export const safeCaseID = (id: unknown): id is string => typeof id === "string" &&
  /^[A-Za-z0-9_-]{1,64}$/.test(id) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id)
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")

export async function regular(file: string) {
  if (!path.isAbsolute(file) || path.resolve(await realpath(file)).toLowerCase() !== path.resolve(file).toLowerCase()) throw new Error("Linked feedback path rejected")
  for (let cursor = file; cursor !== path.dirname(cursor); cursor = path.dirname(cursor)) {
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Linked feedback ancestor rejected")
  }
  const info = await lstat(file)
  if (!info.isFile() || info.nlink !== 1) throw new Error("Feedback requires an unlinked regular file")
  return info
}

export async function fileDigest(file: string) {
  const before = await regular(file)
  const hash = createHash("sha256")
  let bytes = 0
  const handle = await open(file, "r")
  try {
    const opened = await handle.stat()
    if (opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) throw new Error("Feedback replaced before verification")
    const block = Buffer.alloc(65536)
    for (;;) {
      const read = await handle.read(block, 0, block.length, null)
      if (!read.bytesRead) break
      bytes += read.bytesRead
      hash.update(block.subarray(0, read.bytesRead))
    }
    const closed = await handle.stat()
    if (closed.size !== bytes || closed.mtimeMs !== before.mtimeMs || closed.ctimeMs !== before.ctimeMs) throw new Error("Feedback changed during verification")
  } finally { await handle.close() }
  const after = await regular(file)
  if (before.ino !== after.ino || before.size !== bytes || after.size !== bytes ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Feedback changed during verification")
  return { bytes, sha256: hash.digest("hex"), identity: after }
}

export async function verifyPublication(file: string, expected?: string, identities?: Map<string, Awaited<ReturnType<typeof regular>>>) {
  const info = await regular(file)
  if (info.size > 1048576) throw new Error("Feedback manifest capacity exceeded")
  const manifest = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) as PublishedFeedbackManifest
  const { manifestSHA256, ...body } = manifest
  if (manifest.schema !== "aev.training-feedback-manifest.v1" || sha(JSON.stringify(body, null, 2)) !== manifestSHA256 ||
      expected !== undefined && expected !== manifestSHA256) throw new Error("Feedback manifest body digest mismatch")
  const marker = path.join(path.dirname(file), ".published")
  const marked = await regular(marker)
  if ((await readFile(marker, "utf8")).trim() !== manifestSHA256) throw new Error("Feedback completion marker mismatch")
  if (identities) {
    const current = await regular(file)
    if (current.ino !== info.ino || current.size !== info.size || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs) throw new Error("Feedback manifest changed during verification")
    identities.set(file, current)
    const currentMarker = await regular(marker)
    if (marked.ino !== currentMarker.ino || marked.size !== currentMarker.size || marked.mtimeMs !== currentMarker.mtimeMs || marked.ctimeMs !== currentMarker.ctimeMs) throw new Error("Feedback marker changed during verification")
    identities.set(marker, currentMarker)
  }
  if (!Array.isArray(manifest.cases) || manifest.totalCases !== manifest.cases.length || manifest.totalCases < 1 ||
      !Number.isSafeInteger(manifest.round) || manifest.round < 1 || typeof manifest.campaignID !== "string" ||
      !manifest.campaignID || typeof manifest.version !== "string" || !manifest.version ||
      manifest.resourceID !== `feedback:${manifest.campaignID}:round_${manifest.round}` ||
      manifest.passedCases !== manifest.cases.filter(item => item.passed === true).length) throw new Error("Feedback manifest identity mismatch")
  const seen = new Set<string>()
  for (const item of manifest.cases) {
    if (!safeCaseID(item.caseID) || seen.has(item.caseID) || item.path !== `cases/case_${item.caseID}.json` ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 1 || typeof item.passed !== "boolean") throw new Error("Feedback case identity mismatch")
    seen.add(item.caseID)
    const actual = await fileDigest(path.join(path.dirname(file), item.path))
    if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) throw new Error("Feedback case digest mismatch")
    identities?.set(path.join(path.dirname(file), item.path), actual.identity)
  }
  return manifest
}
