import { createHash } from "node:crypto"

export const CONSOLIDATION_PROFILE_ID = "multi_skill_consolidation_v1"
export const CONSOLIDATION_EXECUTOR_ID = "consolidation-direct-chat"
export const CONSOLIDATION_CHECKER_ID = "consolidation-checker"

export function digest(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex")
}

export function publication(bytes: Uint8Array, limit = 5000) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error("Invalid Skill character cap")
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (!content.trim() || content.charCodeAt(0) === 0xfeff) throw new Error("Empty or BOM-prefixed Skill")
  // Count visible Unicode code points, not UTF-8 bytes or JS UTF-16 code units.
  const chars = Array.from(content.normalize("NFC").replace(/\s/gu, "")).length
  if (chars > limit) throw new Error(`Published Skill exceeds ${limit} characters (${chars})`)
  return { chars, sha256: digest(bytes), bytes: bytes.byteLength, content }
}

export interface EvidenceRow {
  caseID: string
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

export function frozenModels(source: { models: Record<string, any>; retry?: any; transientRecovery?: any; skillInput?: any }, modelID: string) {
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
