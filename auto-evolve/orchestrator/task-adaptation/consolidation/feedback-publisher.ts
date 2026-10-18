import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, realpath } from "node:fs/promises"
import { pathExists } from "../../fs"
import { writeFileAtomic } from "../../atomic-write"
import { safeCaseID, verifyPublication } from "./publication-evidence"
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
  // 永久claim防并发覆盖；中断现场须显式恢复，不自动重发评测。
  try { const claim = await open(path.join(root, "publication.started.claim"), "wx"); await claim.close() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Incomplete publication requires explicit recovery")
    throw error
  }
  if (await pathExists(file) || await pathExists(path.join(root, "cases"))) throw new Error("Unclaimed publication evidence exists")
  await mkdir(path.join(root, "cases"))
  const cases: PublishedFeedbackManifest["cases"] = []
  let total = 0
  for (const item of input.cases) {
    const bytes = Buffer.from(publication(item))
    total += bytes.length
    if (total > limit) throw new Error("capacity_exceeded")
    const relative = `cases/case_${item.caseID}.json`
    await writeFileAtomic(path.join(root, relative), bytes.toString("utf8"))
    const disk = await readFile(path.join(root, relative))
    if (!bytes.equals(disk)) throw new Error("Publication disk content drift")
    cases.push({ caseID: item.caseID, path: relative, sha256: sha(disk), bytes: disk.length, passed: item.passed })
  }
  const body = { schema: "aev.training-feedback-manifest.v1" as const, resourceID: `feedback:${input.campaignID}:round_${input.round}`,
    campaignID: input.campaignID, round: input.round, version: `v${input.round}.${randomUUID()}`,
    totalCases: cases.length, passedCases: input.cases.filter(item => item.passed).length, publishedAt: new Date().toISOString(),
    ...(input.binding ? { binding: input.binding } : {}), cases }
  const manifest = { ...body, manifestSHA256: sha(JSON.stringify(body, null, 2)) }
  await writeFileAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFileAtomic(path.join(root, ".published"), manifest.manifestSHA256)
  return finish(await verifyPublication(file, manifest.manifestSHA256))
}
