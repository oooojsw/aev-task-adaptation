import path from "node:path"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { ensureDirectory } from "../../fs"
import { writeJsonAtomic } from "../../atomic-write"
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

  const publishedCases: PublishedFeedbackManifest["cases"] = []
  const allCasePaths: string[] = []
  let passedCount = 0

  for (const rawCase of input.cases) {
    if (!rawCase.caseID || typeof rawCase.caseID !== "string") {
      throw new Error("Each case must have a valid string caseID")
    }

    // 1. 严格剥离私有 Oracle 字段（fail closed，杜绝泄题）
    const sanitizedView: PublishedCaseView = {
      caseID: rawCase.caseID,
      title: rawCase.title,
      prompt: rawCase.prompt ?? "",
      materials: rawCase.materials ?? [],
      modelResponse: rawCase.modelResponse ?? "",
      score: Number(rawCase.score) || 0,
      passed: Boolean(rawCase.passed),
      diagnostics: Array.isArray(rawCase.diagnostics) ? rawCase.diagnostics : [],
      sha256: "",
    }

    if (sanitizedView.passed) passedCount++

    const serialized = JSON.stringify(sanitizedView, null, 2)
    const caseSHA = createHash("sha256").update(serialized).digest("hex")
    sanitizedView.sha256 = caseSHA

    // 重新写入带有 sha256 的最终 JSON
    const finalContent = JSON.stringify(sanitizedView, null, 2)
    const safeCaseFile = path.join(casesDir, `case_${rawCase.caseID}.json`)
    await writeJsonAtomic(safeCaseFile, JSON.parse(finalContent))

    const relPath = path.relative(baseDir, safeCaseFile).replaceAll("\\", "/")
    publishedCases.push({
      caseID: rawCase.caseID,
      path: relPath,
      sha256: caseSHA,
      bytes: Buffer.byteLength(finalContent, "utf8"),
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

  const manifestSerialized = JSON.stringify(manifestBody, null, 2)
  const manifestSHA = createHash("sha256").update(manifestSerialized).digest("hex")

  const fullManifest: PublishedFeedbackManifest = {
    ...manifestBody,
    manifestSHA256: manifestSHA,
  }

  const manifestPath = path.join(baseDir, "manifest.json")
  await writeJsonAtomic(manifestPath, fullManifest)
  allCasePaths.push(path.resolve(manifestPath).replaceAll("\\", "/"))

  // 写入原子完成标志
  await writeFile(path.join(baseDir, ".published"), manifestSHA, "utf8")

  const logicalResource: LogicalResource = {
    resourceID,
    kind: "training_feedback",
    version,
    sha256: manifestSHA,
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
