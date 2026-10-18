import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, realpath, unlink } from "node:fs/promises"
import { pathExists } from "../../fs"
import { writeFileAtomic } from "../../atomic-write"
import { safeCaseID, verifyPublication, regular, fileDigest } from "./publication-evidence"
import type { LogicalResource } from "../../task-profile-access/unified-access"

export type RawTestCaseResult = {
  caseID: string
  title?: string
  prompt: string
  materials?: Array<{ id: string; name: string; content: string }>
  modelResponse: string
  score: number
  passed: boolean
  diagnostics?: string[]
  oracleAnswer?: string
  validatorScript?: string
  evaluatorTrace?: unknown
}

export type PublishedCaseView = Omit<RawTestCaseResult, "oracleAnswer" | "validatorScript" | "evaluatorTrace"> & {
  materials: Array<{ id: string; name: string; content: string }>
  diagnostics: string[]
  sha256: string
}

export type PublishedFeedbackManifest = {
  schema: "aev.training-feedback-manifest.v1"
  resourceID: string
  campaignID: string
  round: number
  version: string
  totalCases: number
  passedCases: number
  publishedAt: string
  binding?: Record<string, string>
  cases: Array<{ caseID: string; path: string; sha256: string; bytes: number; passed: boolean }>
  manifestSHA256: string
}

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")

function publication(raw: RawTestCaseResult) {
  if (!safeCaseID(raw.caseID)) throw new Error("Invalid, dangerous or empty caseID")
  if (typeof raw.passed !== "boolean" || typeof raw.score !== "number" ||
      !Number.isFinite(raw.score) || raw.score !== (raw.passed ? 1 : 0)) throw new Error("score must be finite and match passed verdict exactly")
  if (typeof raw.prompt !== "string" || !raw.prompt.trim() || typeof raw.modelResponse !== "string" ||
      raw.title !== undefined && typeof raw.title !== "string" ||
      raw.diagnostics !== undefined && (!Array.isArray(raw.diagnostics) || raw.diagnostics.some(item => typeof item !== "string")) ||
      raw.materials !== undefined && (!Array.isArray(raw.materials) || raw.materials.some(item =>
        !item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.content !== "string"))) {
    throw new Error("Explicit public prompt, answer and textual materials required")
  }
  // 逐字段复制公开数据，嵌套对象也不能夹带私有字段。
  const body = { caseID: raw.caseID, ...(raw.title !== undefined ? { title: raw.title } : {}), prompt: raw.prompt,
    materials: (raw.materials ?? []).map(({ id, name, content }) => ({ id, name, content })),
    modelResponse: raw.modelResponse, score: raw.score, passed: raw.passed, diagnostics: raw.diagnostics ?? [] }
  return `${JSON.stringify({ ...body, sha256: sha(JSON.stringify(body)) }, null, 2)}\n`
}

export function publicationResource(file: string, manifest: PublishedFeedbackManifest): LogicalResource {
  const root = path.dirname(file).replaceAll("\\", "/")
  return { resourceID: manifest.resourceID, kind: "training_feedback", version: manifest.version,
    sha256: manifest.manifestSHA256, sensitivity: "training", access: "read_only", boundaryRoots: [root],
    paths: [...manifest.cases.map(item => path.resolve(root, item.path).replaceAll("\\", "/")), file.replaceAll("\\", "/")],
    metadata: { campaignID: manifest.campaignID, round: manifest.round, totalCases: manifest.totalCases,
      passedCases: manifest.passedCases, manifestPath: file.replaceAll("\\", "/"), ...manifest.binding } }
}

export async function publishTrainingFeedbackResource(input: {
  targetDir: string; campaignID: string; round: number; cases: RawTestCaseResult[]
  expectedCaseIDs?: string[]
  binding?: Record<string, string>
  maxTotalBytes?: number
  recoverIncomplete?: boolean
}) {
  if (!path.isAbsolute(input.targetDir) || !input.campaignID || !Number.isSafeInteger(input.round) || input.round < 1) {
    throw new Error("Absolute publication location and explicit Campaign identity required")
  }
  if (!Array.isArray(input.cases) || !input.cases.length) throw new Error("Cannot publish empty training cases feedback")
  if (input.binding && Object.entries(input.binding).some(([key, value]) =>
      !["task", "phase", "protocolFingerprint", "receiptFingerprint", "candidateSHA256", "datasetSHA256", "modelID", "runID", "passID", "planFingerprint", "policyFingerprint"].includes(key) ||
      typeof value !== "string" || !value)) throw new Error("Invalid host publication binding")
  const seen = new Set<string>()
  for (const item of input.cases) {
    publication(item)
    if (seen.has(item.caseID)) throw new Error("Duplicate caseID")
    seen.add(item.caseID)
  }
  if (input.expectedCaseIDs && (input.expectedCaseIDs.length !== seen.size || new Set(input.expectedCaseIDs).size !== seen.size ||
      input.expectedCaseIDs.some(id => !seen.has(id)))) throw new Error("Frozen expected case set mismatch")
  const limit = input.maxTotalBytes ?? 536870912
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1073741824) throw new Error("Invalid publication capacity")
  const root = path.resolve(input.targetDir)
  await mkdir(root, { recursive: true })
  if (path.resolve(await realpath(root)).toLowerCase() !== root.toLowerCase()) throw new Error("Linked publication root rejected")
  const file = path.join(root, "manifest.json")
  const finish = (manifest: PublishedFeedbackManifest) => ({ manifest, manifestPath: file.replaceAll("\\", "/"),
    logicalResource: publicationResource(file, manifest) })
  if (await pathExists(path.join(root, ".published"))) {
    const saved = await verifyPublication(file)
    if (saved.campaignID !== input.campaignID || saved.round !== input.round || saved.totalCases !== input.cases.length ||
        JSON.stringify(saved.binding) !== JSON.stringify(input.binding)) throw new Error("Attempting to overwrite existing published feedback with different content")
    for (const item of input.cases) {
      const previous = saved.cases.find(row => row.caseID === item.caseID)
      if (!previous || previous.sha256 !== sha(publication(item))) throw new Error("Attempting to overwrite existing published feedback with different content")
    }
    return finish(saved)
  }
  const intentPath = path.join(root, "publication.intent.json")
  const failurePath = path.join(root, "publication.failed.json")
  const planned = input.cases.map(item => {
    const bytes = publication(item)
    return { caseID: item.caseID, path: `cases/case_${item.caseID}.json`, sha256: sha(bytes), bytes: Buffer.byteLength(bytes), passed: item.passed }
  })
  let body = { schema: "aev.training-feedback-manifest.v1" as const, resourceID: `feedback:${input.campaignID}:round_${input.round}`,
    campaignID: input.campaignID, round: input.round, version: `v${input.round}.${randomUUID()}`,
    totalCases: planned.length, passedCases: input.cases.filter(item => item.passed).length, publishedAt: new Date().toISOString(),
    ...(input.binding ? { binding: input.binding } : {}), cases: planned }
  let lock: string | undefined
  if (input.recoverIncomplete) {
    // 只恢复已明确失败的出版，不接管仍在运行或未知中断的调用。
    await regular(intentPath)
    await regular(failurePath)
    const saved = JSON.parse((await readFile(intentPath, "utf8")).replace(/^\uFEFF/, "")) as typeof body
    const failure = JSON.parse((await readFile(failurePath, "utf8")).replace(/^\uFEFF/, ""))
    if (failure.intent !== sha(JSON.stringify(saved)) || saved.campaignID !== body.campaignID || saved.round !== body.round ||
        JSON.stringify(saved.cases) !== JSON.stringify(planned) || JSON.stringify(saved.binding) !== JSON.stringify(body.binding)) throw new Error("Publication recovery identity mismatch")
    body = saved
    lock = path.join(root, "publication.recovery.lock")
    const handle = await open(lock, "wx")
    await handle.close()
  } else {
    try { const claim = await open(path.join(root, "publication.started.claim"), "wx"); await claim.close() }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Incomplete publication requires explicit recovery")
      throw error
    }
    if (await pathExists(file) || await pathExists(path.join(root, "cases"))) throw new Error("Unclaimed publication evidence exists")
    await mkdir(path.join(root, "cases"))
    await writeFileAtomic(intentPath, JSON.stringify(body))
  }
  try {
    if (path.resolve(await realpath(path.join(root, "cases"))).toLowerCase() !== path.join(root, "cases").toLowerCase()) throw new Error("Linked publication cases rejected")
    let total = 0
    for (let index = 0; index < input.cases.length; index++) {
      const item = planned[index]
      total += item.bytes
      if (total > limit) throw new Error("capacity_exceeded")
      const target = path.join(root, item.path)
      if (input.recoverIncomplete && await pathExists(target)) {
        const actual = await fileDigest(target)
        if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) throw new Error("Publication recovery content drift")
        continue
      }
      await writeFileAtomic(target, publication(input.cases[index]))
      const actual = await fileDigest(target)
      if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) throw new Error("Publication disk content drift")
    }
    const manifest = { ...body, manifestSHA256: sha(JSON.stringify(body, null, 2)) }
    if (await pathExists(file)) {
      await regular(file)
      if (JSON.stringify(JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))) !== JSON.stringify(manifest)) throw new Error("Existing publication manifest drift")
    } else await writeFileAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFileAtomic(path.join(root, ".published"), manifest.manifestSHA256)
    return finish(await verifyPublication(file, manifest.manifestSHA256))
  } catch (error) {
    await writeFileAtomic(failurePath, JSON.stringify({ status: "incomplete", intent: sha(JSON.stringify(body)) }))
    throw error
  } finally { if (lock) await unlink(lock) }
}
