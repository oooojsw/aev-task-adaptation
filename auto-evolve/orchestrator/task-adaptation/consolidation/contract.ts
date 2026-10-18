import { createHash } from "node:crypto"
import type { DirectChatModelsConfig } from "../../direct-chat/contract"

export const CONSOLIDATION_PROFILE_ID = "multi_skill_consolidation_v1"
export const CONSOLIDATION_EXECUTOR_ID = "consolidation-direct-chat"
export const CONSOLIDATION_CHECKER_ID = "consolidation-checker"

export function digest(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex")
}

export function publication(bytes: Uint8Array, limit = 5000) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error("Invalid Skill character cap")
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error("Empty or BOM-prefixed Skill")
  }
  const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  if (!content.trim() || content.charCodeAt(0) === 0xfeff) throw new Error("Empty or BOM-prefixed Skill")
  if (/[\u200B-\u200D\u2060]/u.test(content)) {
    throw new Error("Forbidden zero-width or hidden characters in Skill")
  }
  const fenceCount = (content.match(/^```/gm) || []).length
  if (fenceCount % 2 !== 0) {
    throw new Error("Unclosed Markdown code fence in Skill")
  }
  if (/\[[^\]]*\]\([^)\n]*$/m.test(content)) {
    throw new Error("Broken Markdown link in Skill")
  }
  // Count visible Unicode code points, not UTF-8 bytes or JS UTF-16 code units.
  const chars = Array.from(content.normalize("NFC").replace(/\s/gu, "")).length
  if (chars > limit) throw new Error(`Published Skill exceeds ${limit} characters (${chars})`)
  return { chars, sha256: digest(bytes), bytes: bytes.byteLength, content }
}

export interface EvidenceRow {
  caseID: string
  answer?: string
  modelID: string
  skillHash: string
  skillMode?: string
  skillTier?: string
  selectionTruncated?: boolean
  passed: boolean
  score: number
  attempts: number
  errorCategory?: string
  outputBudgetExceeded?: boolean
  requestAuditPath?: string
  responseAuditPath?: string
  validatorResultPath?: string
}

export interface DirectChatSummary {
  validity: {
    status: string
    skillHash: string
    datasetHash: string
    skillTierSelection?: Array<{ modelID: string; selectedHash: string; truncated?: boolean; selectedTier: string }>
  }
  summary: Array<{ modelID: string; total: number; passed: number; failed: number; passRate: number }>
  results: EvidenceRow[]
}

export interface ScoreInput {
  summary: DirectChatSummary
  cases: string[]
  modelID: string
  skillHash: string
  datasetHash: string
}

export function score(input: ScoreInput) {
  const { summary, cases, modelID, skillHash, datasetHash } = input
  if (!cases.length || new Set(cases).size !== cases.length) throw new Error("Expected case IDs must be nonempty and unique")
  if (summary.validity?.status !== "valid" || summary.validity.skillHash !== skillHash ||
      summary.validity.datasetHash !== datasetHash) throw new Error("Direct Chat run validity or input hash mismatch")
  const tiers = summary.validity.skillTierSelection
  if (!Array.isArray(tiers) || tiers.length !== 1 || tiers[0]?.modelID !== modelID ||
      tiers[0].selectedHash !== skillHash || tiers[0].truncated === true ||
      !["full", "custom"].includes(tiers[0].selectedTier)) {
    throw new Error("Direct Chat did not use the complete published Skill")
  }
  if (!Array.isArray(summary.results) || summary.results.length !== cases.length ||
      !Array.isArray(summary.summary) || summary.summary.length !== 1) {
    throw new Error("Expected exactly one Direct Chat result per case")
  }
  const expected = new Set(cases)
  const seen = new Set<string>()
  let passed = 0
  for (const row of summary.results) {
    if (!row || !expected.has(row.caseID) || seen.has(row.caseID) || row.modelID !== modelID ||
        row.skillHash !== skillHash || row.skillMode !== "with-skill" ||
        !["custom", "full"].includes(row.skillTier ?? "") || row.selectionTruncated === true) {
      throw new Error("Wrong case, model, or Skill identity in Direct Chat result")
    }
    seen.add(row.caseID)
    if (row.attempts !== 1 || row.outputBudgetExceeded === true ||
        !["none", "validation", "answer_extraction"].includes(row.errorCategory ?? "") ||
        !row.requestAuditPath || !row.responseAuditPath ||
        (row.errorCategory !== "answer_extraction" && !row.validatorResultPath)) {
      throw new Error(`Retry, missing evidence or infrastructure failure for case ${row.caseID}`)
    }
    if (typeof row.passed !== "boolean" || row.score !== (row.passed ? 1 : 0) ||
        (row.passed && row.errorCategory !== "none") ||
        (!row.passed && row.errorCategory === "none")) throw new Error("Invalid per-case verdict")
    if (row.passed) passed += 1
  }
  const record = summary.summary[0]
  const rate = passed / cases.length
  if (record.modelID !== modelID || record.total !== cases.length || record.passed !== passed ||
      record.failed !== cases.length - passed || record.passRate !== rate) throw new Error("Summary and per-case verdicts disagree")
  return { total: cases.length, passed, failed: cases.length - passed, pass_rate: rate }
}

export function frozenModels(source: DirectChatModelsConfig, modelID: string): DirectChatModelsConfig {
  if (!source || !source.models || !Object.hasOwn(source.models, modelID)) throw new Error("Selected Direct Chat model missing")
  const model = source.models[modelID]
  if (model.skillInputMode && model.skillInputMode !== "full") throw new Error("Skill truncation is forbidden")
  if (model.id && model.id !== modelID) throw new Error("Model identity mismatch")
  return {
    ...source,
    models: { [modelID]: { ...model, skillInputMode: "full" } },
    retry: { maxAttempts: 1, backoffMs: 0 },
    transientRecovery: { enabled: false, maxRounds: 0 },
    skillInput: { mode: "full" },
  }
}

export interface SampleDiagnostic {
  caseID: string
  errorCategory: string
  abstractFailure: string
  suggestion: string
}

export interface ConsolidationFeedback {
  schema: "aev.consolidation-feedback.v1"
  total: number
  passed: number
  failed: number
  passRate: number
  errorCategories: Record<string, number>
  sampleDiagnostics: SampleDiagnostic[]
  message: string
}

export function buildConsolidationFeedback(
  summary: DirectChatSummary,
  maxMessageChars = 1200,
): ConsolidationFeedback {
  const total = summary.results.length
  const passed = summary.results.filter(r => r.passed).length
  const failed = total - passed
  const passRate = total > 0 ? passed / total : 0

  const errorCategories: Record<string, number> = {}
  for (const r of summary.results) {
    if (!r.passed) {
      const cat = r.errorCategory || "unknown"
      errorCategories[cat] = (errorCategories[cat] || 0) + 1
    }
  }

  // Prioritize covering distinct error categories, up to 3 samples.
  const failedResults = summary.results.filter(r => !r.passed)
  const byCategory = new Map<string, typeof failedResults>()
  for (const r of failedResults) {
    const cat = r.errorCategory || "unknown"
    if (!byCategory.has(cat)) byCategory.set(cat, [])
    byCategory.get(cat)!.push(r)
  }

  const sampleDiagnostics: SampleDiagnostic[] = []
  const sortedCategories = Array.from(byCategory.keys()).sort()
  for (const cat of sortedCategories) {
    if (sampleDiagnostics.length >= 3) break
    const rows = byCategory.get(cat)!
    rows.sort((a, b) => a.caseID.localeCompare(b.caseID))
    const chosen = rows[0]!
    sampleDiagnostics.push({
      caseID: chosen.caseID,
      errorCategory: cat,
      abstractFailure: `Case failed with category: ${cat}`,
      suggestion: `Review guidance for ${cat} tasks`,
    })
  }

  if (sampleDiagnostics.length < 3 && failedResults.length > sampleDiagnostics.length) {
    const chosenIDs = new Set(sampleDiagnostics.map(s => s.caseID))
    const remaining = failedResults.filter(r => !chosenIDs.has(r.caseID)).sort((a, b) => a.caseID.localeCompare(b.caseID))
    for (const r of remaining) {
      if (sampleDiagnostics.length >= 3) break
      sampleDiagnostics.push({
        caseID: r.caseID,
        errorCategory: r.errorCategory || "unknown",
        abstractFailure: `Case failed with category: ${r.errorCategory || "unknown"}`,
        suggestion: `Review guidance for ${r.errorCategory || "unknown"} tasks`,
      })
    }
  }

  const catSummary = Object.entries(errorCategories)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(", ")

  const samplesText = sampleDiagnostics.map(s => `[${s.caseID} (${s.errorCategory})]: ${s.suggestion}`).join("; ")

  let message = `Verified ${passed}/${total}; pass_rate=${passRate.toFixed(4)}. Errors: [${catSummary || "none"}]. Diagnostics (max 3): ${samplesText || "none"}`
  if (message.length > maxMessageChars) {
    message = message.slice(0, maxMessageChars - 3) + "..."
  }

  return {
    schema: "aev.consolidation-feedback.v1",
    total,
    passed,
    failed,
    passRate,
    errorCategories,
    sampleDiagnostics,
    message,
  }
}
