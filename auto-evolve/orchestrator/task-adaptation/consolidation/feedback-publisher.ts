import path from "node:path"
import { createHash } from "node:crypto"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { ensureDirectory, pathExists } from "../../fs"
import { writeFileAtomic, writeJsonAtomic } from "../../atomic-write"
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
  // 私有 Oracle 字段（必须在发布前彻底剥离）
  oracleAnswer?: string
  validatorScript?: string
  evaluatorTrace?: unknown
}

export type PublishedCaseView = {
  caseID: string
  title?: string
  prompt: string
  materials: Array<{ id: string; name: string; content: string }>
  modelResponse: string
  score: number
  passed: boolean
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
  cases: Array<{
    caseID: string
    path: string
    sha256: string
    bytes: number
    passed: boolean
  }>
  manifestSHA256: string
}

export async function publishTrainingFeedbackResource(input: {
  targetDir: string
  campaignID: string
  round: number
  cases: RawTestCaseResult[]
}): Promise<{
  manifest: PublishedFeedbackManifest
  logicalResource: LogicalResource
  manifestPath: string
}> {
  if (!input.targetDir || !path.isAbsolute(input.targetDir)) {
    throw new Error("Absolute targetDir required for feedback publishing")
  }
  if (!Number.isSafeInteger(input.round) || input.round < 1) {
    throw new Error("Valid positive round number required")
  }
  if (!Array.isArray(input.cases) || input.cases.length === 0) {
    throw new Error("Cannot publish empty training cases feedback")
  }

  const baseDir = path.resolve(input.targetDir)
  const casesDir = path.join(baseDir, "cases")
  await ensureDirectory(casesDir)

  // 幂等复用与防覆写检查（A2-5）
  const manifestPath = path.join(baseDir, "manifest.json")
  const markerPath = path.join(baseDir, ".published")
  if (await pathExists(markerPath) && await pathExists(manifestPath)) {
    try {
      const existing = JSON.parse((await readFile(manifestPath, "utf8")).replace(/^\uFEFF/, ""))
      if (existing.campaignID === input.campaignID && existing.round === input.round) {
        if (existing.totalCases === input.cases.length && existing.cases?.length === input.cases.length) {
          const existingMarker = (await readFile(markerPath, "utf8")).trim()
          if (existingMarker === existing.manifestSHA256) {
            const allCasePaths = existing.cases.map((c: any) => path.resolve(baseDir, c.path).replaceAll("\\", "/"))
            allCasePaths.push(path.resolve(manifestPath).replaceAll("\\", "/"))
            const logicalResource: LogicalResource = {
              resourceID: existing.resourceID,
              kind: "training_feedback",
              version: existing.version,
              sha256: existing.manifestSHA256,
              sensitivity: "training",
              access: "read_only",
              boundaryRoots: [baseDir.replaceAll("\\", "/")],
              paths: allCasePaths,
              metadata: {
                campaignID: existing.campaignID,
                round: existing.round,
                totalCases: existing.totalCases,
                passedCases: existing.passedCases,
                manifestPath: path.resolve(manifestPath).replaceAll("\\", "/"),
              },
            }
            return { manifest: existing, logicalResource, manifestPath: path.resolve(manifestPath).replaceAll("\\", "/") }
          }
        }
        throw new Error("Attempting to overwrite existing published feedback with different content")
      }
    } catch (err: any) {
      if (err.message?.includes("Attempting to overwrite")) throw err
    }
  }

  const publishedCases: PublishedFeedbackManifest["cases"] = []
  const allCasePaths: string[] = []
  let passedCount = 0

  const SAFE_CASE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/
  const seenCaseIDs = new Set<string>()

  for (const rawCase of input.cases) {
    if (!rawCase.caseID || typeof rawCase.caseID !== "string" || !SAFE_CASE_ID_REGEX.test(rawCase.caseID)) {
      throw new Error(`Invalid, dangerous or empty caseID: '${rawCase.caseID}'`)
    }
    if (seenCaseIDs.has(rawCase.caseID)) {
      throw new Error(`Duplicate caseID in feedback publication: '${rawCase.caseID}'`)
    }
    seenCaseIDs.add(rawCase.caseID)

    if (typeof rawCase.passed !== "boolean") {
      throw new Error(`Case '${rawCase.caseID}' must have an explicit boolean 'passed' verdict`)
    }
    const expectedScore = rawCase.passed ? 1 : 0
    if (typeof rawCase.score !== "number" || !Number.isFinite(rawCase.score) || rawCase.score !== expectedScore) {
      throw new Error(`Case '${rawCase.caseID}' score must be finite and match passed verdict exactly (${expectedScore})`)
    }

    // 1. 严格剥离私有 Oracle 字段（fail closed，杜绝泄题）
    const sanitizedView: PublishedCaseView = {
      caseID: rawCase.caseID,
      title: rawCase.title,
      prompt: rawCase.prompt ?? "",
      materials: rawCase.materials ?? [],
      modelResponse: rawCase.modelResponse ?? "",
      score: rawCase.score,
      passed: rawCase.passed,
      diagnostics: Array.isArray(rawCase.diagnostics) ? rawCase.diagnostics : [],
      sha256: "",
    }

    if (sanitizedView.passed) passedCount++

    // 先计算基础内容指纹
    const contentToHash = JSON.stringify({
      caseID: sanitizedView.caseID,
      prompt: sanitizedView.prompt,
      materials: sanitizedView.materials,
      modelResponse: sanitizedView.modelResponse,
      score: sanitizedView.score,
      passed: sanitizedView.passed,
      diagnostics: sanitizedView.diagnostics,
    })
    sanitizedView.sha256 = createHash("sha256").update(contentToHash).digest("hex")

    // 写入安全 Case 文件
    const safeCaseFile = path.join(casesDir, `case_${rawCase.caseID}.json`)
    const finalContent = `${JSON.stringify(sanitizedView, null, 2)}\n`
    await writeFileAtomic(safeCaseFile, finalContent)

    // 逐文件物理测定实际落盘的 bytes 与 sha256，确保与磁盘物理文件绝对一致
    const diskBytes = await readFile(safeCaseFile)
    const diskSHA = createHash("sha256").update(diskBytes).digest("hex")
    const diskLen = diskBytes.length

    const relPath = path.relative(baseDir, safeCaseFile).replaceAll("\\", "/")
    publishedCases.push({
      caseID: rawCase.caseID,
      path: relPath,
      sha256: diskSHA,
      bytes: diskLen,
      passed: sanitizedView.passed,
    })
    allCasePaths.push(path.resolve(safeCaseFile).replaceAll("\\", "/"))
  }

  const resourceID = `feedback:${input.campaignID}:round_${input.round}`
  const version = `v${input.round}.${Date.now()}`

  const manifestBody: Omit<PublishedFeedbackManifest, "manifestSHA256"> = {
    schema: "aev.training-feedback-manifest.v1",
    resourceID,
    campaignID: input.campaignID,
    round: input.round,
    version,
    totalCases: publishedCases.length,
    passedCases: passedCount,
    publishedAt: new Date().toISOString(),
    cases: publishedCases,
  }

  // manifestSHA256 作为权威内容摘要
  const manifestBodySHA = createHash("sha256").update(JSON.stringify(manifestBody, null, 2)).digest("hex")

  const fullManifest: PublishedFeedbackManifest = {
    ...manifestBody,
    manifestSHA256: manifestBodySHA,
  }

  const manifestJson = `${JSON.stringify(fullManifest, null, 2)}\n`
  await writeFileAtomic(manifestPath, manifestJson)

  allCasePaths.push(path.resolve(manifestPath).replaceAll("\\", "/"))

  // 写入原子完成标志
  await writeFile(path.join(baseDir, ".published"), manifestBodySHA, "utf8")

  const logicalResource: LogicalResource = {
    resourceID,
    kind: "training_feedback",
    version,
    sha256: manifestBodySHA,
    sensitivity: "training",
    access: "read_only",
    boundaryRoots: [baseDir.replaceAll("\\", "/")],
    paths: allCasePaths,
    metadata: {
      campaignID: input.campaignID,
      round: input.round,
      totalCases: publishedCases.length,
      passedCases: passedCount,
      manifestPath: path.resolve(manifestPath).replaceAll("\\", "/"),
    },
  }

  return {
    manifest: fullManifest,
    logicalResource,
    manifestPath: path.resolve(manifestPath).replaceAll("\\", "/"),
  }
}
