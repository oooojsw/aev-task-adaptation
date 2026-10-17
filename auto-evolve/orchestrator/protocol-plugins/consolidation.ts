import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { CheckerPlugin, ExecutorPlugin, Settings } from "./contract"
import type { Execute, Evaluate } from "./runtime"
import type { HttpRequestBudget } from "./http-chat"
import { budgetTransportEnvironment, type BudgetTransportConfig } from "../task-adaptation/budget-transport"
import { fingerprint } from "./identity"
import { readDirectChatDatasetBundle } from "../direct-chat/dataset-bundler"
import { runDirectChatEvaluation } from "../direct-chat/runner"
import type { DirectChatModelsConfig } from "../direct-chat/contract"
import {
  CONSOLIDATION_CHECKER_ID, CONSOLIDATION_EXECUTOR_ID,
  digest, frozenModels, publication, score, type DirectChatSummary,
} from "../task-adaptation/consolidation/contract"

interface Common {
  candidateID: string
  maxChars: number
  expectedCases: number
  modelID: string
  datasetSHA256: string
}
interface Execution extends Common {
  datasetPath: string
  modelsPath: string
  modelsSHA256: string
  concurrency: number
}
const sha = (text: unknown) => typeof text === "string" && /^[a-f0-9]{64}$/.test(text)
const safe = (text: unknown) => typeof text === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)

function common(raw: Settings): Common {
  const s = raw as unknown as Common
  if (!s || !safe(s.candidateID) || !safe(s.modelID) || !sha(s.datasetSHA256) ||
      !Number.isSafeInteger(s.maxChars) || s.maxChars < 1 || s.maxChars > 5000 ||
      !Number.isSafeInteger(s.expectedCases) || s.expectedCases < 1 || s.expectedCases > 500) {
    throw new Error("Invalid consolidation acceptance settings")
  }
  return s
}
function execution(raw: Settings): Execution {
  const s = raw as unknown as Execution
  common(raw)
  if (Object.keys(raw).sort().join(",") !==
      ["candidateID", "concurrency", "datasetPath", "datasetSHA256", "expectedCases", "maxChars", "modelID", "modelsPath", "modelsSHA256"].sort().join(",") ||
      !path.isAbsolute(s.datasetPath) || !path.isAbsolute(s.modelsPath) || !sha(s.modelsSHA256) ||
      !Number.isSafeInteger(s.concurrency) || s.concurrency < 1 || s.concurrency > 32) {
    throw new Error("Invalid host-owned consolidation executor binding")
  }
  return s
}
function checker(raw: Settings): Common {
  common(raw)
  if (Object.keys(raw).sort().join(",") !==
      ["candidateID", "datasetSHA256", "expectedCases", "maxChars", "modelID"].sort().join(",")) {
    throw new Error("Invalid consolidation checker binding")
  }
  return raw as unknown as Common
}

async function inputs(s: Execution) {
  const [data, models] = await Promise.all([readFile(s.datasetPath), readFile(s.modelsPath)])
  if (digest(data) !== s.datasetSHA256 || digest(models) !== s.modelsSHA256) {
    throw new Error("Frozen Direct Chat dataset or model settings changed")
  }
  const cases = await readDirectChatDatasetBundle(s.datasetPath)
  if (cases.length !== s.expectedCases || new Set(cases.map(row => row.caseID)).size !== s.expectedCases ||
      cases.some(row => !safe(row.caseID) || !row.privateOracle?.scriptPath || row.materialAudit?.omittedSources?.length)) {
    throw new Error("Missing, duplicate or incomplete Direct Chat cases/oracles")
  }
  const config = JSON.parse(models.toString("utf8")) as DirectChatModelsConfig
  if (config.models?.[s.modelID]?.id && config.models[s.modelID].id !== s.modelID) throw new Error("Model identity mismatch")
  const selected = frozenModels(config, s.modelID)
  return { cases: cases.map(row => row.caseID), models: selected }
}

// Do not trust only the runner's aggregate; verify every actual request and structured validator verdict.
// A process returning exit=1 without JSON {passed:boolean} may be a crashed validator, not a wrong answer.
async function verifyTraces(root: string, summary: DirectChatSummary) {
  for (const row of summary.results) {
    if (!safe(row.caseID) || !safe(row.modelID)) throw new Error("Unsafe Direct Chat case identity")
    const dir = path.join(root, "results", row.modelID, row.caseID)
    if (path.resolve(row.requestAuditPath ?? "") !== path.join(dir, "request-audit.json") ||
        path.resolve(row.responseAuditPath ?? "") !== path.join(dir, "provider-response.json")) {
      throw new Error("Direct Chat trace location mismatch")
    }
    const request = JSON.parse(await readFile(row.requestAuditPath!, "utf8"))
    const response = JSON.parse(await readFile(row.responseAuditPath!, "utf8"))
    if (request.caseID !== row.caseID || request.skillHash !== row.skillHash ||
        request.skillMode !== "with-skill" || request.skillTier !== row.skillTier ||
        response.schema !== "direct-chat-provider-response/v1") {
      throw new Error("Direct Chat per-case request or response identity mismatch")
    }
    if (row.errorCategory === "answer_extraction") continue
    if (path.resolve(row.validatorResultPath ?? "") !== path.join(dir, "validator-result.json")) {
      throw new Error("Direct Chat validator evidence path mismatch")
    }
    const verdict = JSON.parse(await readFile(row.validatorResultPath!, "utf8"))
    if (typeof verdict.parsed?.passed !== "boolean" ||
        verdict.parsed.passed !== row.passed || verdict.passed !== row.passed ||
        verdict.score !== row.score || ![0, 1].includes(verdict.exitCode)) {
      throw new Error("Direct Chat validator lacks a trustworthy structured verdict")
    }
  }
}

export async function preflightConsolidation(settings: Settings) {
  return inputs(execution(settings))
}

export async function consolidationPlugins(root: string, options: { budget?: HttpRequestBudget } = {}) {
  if (!path.isAbsolute(root)) throw new Error("Consolidation evidence root must be absolute")
  await mkdir(root, { recursive: true })
  const baseImplementation = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex")
  const implementation = options.budget ? fingerprint({ source: baseImplementation, budget: options.budget.config }) : baseImplementation
  const executor: ExecutorPlugin = {
    id: CONSOLIDATION_EXECUTOR_ID, version: "1", implementation,
    skillFormats: ["text", "files"], productKinds: ["json"], materialKinds: ["text", "json"],
    validate: execution,
  }
  const checks: CheckerPlugin = {
    id: CONSOLIDATION_CHECKER_ID, version: "1", implementation,
    targets: ["skill", "product"], mechanisms: ["script"], productKinds: ["json", "text"],
    validate: checker,
  }
  const preflight = async (settings: Settings) => inputs(execution(settings))
  const execute: Execute = async input => {
    const s = execution(input.settings)
    if (input.skill.length !== 1 || input.skill[0]?.id !== s.candidateID) {
      throw new Error("Consolidation requires exactly one candidate publication entry")
    }
    const pub = publication(input.skill[0].bytes, s.maxChars)
    const { cases, models } = await preflight(input.settings)
    const id = randomUUID()
    const dir = path.join(root, id)
    await mkdir(dir)
    const skill = path.join(dir, "DIRECT_CHAT.md")
    await writeFile(skill, input.skill[0].bytes)
    const run = path.join(dir, "direct-chat")

    let envVars: { OPENCODE_AEV_REQUEST_BUDGET_FILE?: string; OPENCODE_AEV_REQUEST_BUDGET_SHA256?: string } = {}
    if (options.budget) {
      const selectedModel = models.models[s.modelID]
      const wireModel = selectedModel?.model ?? s.modelID
      const transportConfig: BudgetTransportConfig = {
        schema: "aev.budget-transport.v1",
        budget: options.budget.config,
        role: options.budget.role || "independent",
        dialect: "openai_chat",
        expectedModels: Array.from(new Set([s.modelID, wireModel])),
        maxInputTokens: options.budget.tokenCeiling,
        maxOutputTokens: selectedModel?.maxOutputTokens ?? 2048,
      }
      envVars = await budgetTransportEnvironment(transportConfig, dir)
    }

    const prevFile = process.env.OPENCODE_AEV_REQUEST_BUDGET_FILE
    const prevSha = process.env.OPENCODE_AEV_REQUEST_BUDGET_SHA256
    const prevEnforce = process.env.AEV_CONSOLIDATION_ENFORCE_BUDGET
    let result
    try {
      if (envVars.OPENCODE_AEV_REQUEST_BUDGET_FILE) {
        process.env.OPENCODE_AEV_REQUEST_BUDGET_FILE = envVars.OPENCODE_AEV_REQUEST_BUDGET_FILE
        process.env.OPENCODE_AEV_REQUEST_BUDGET_SHA256 = envVars.OPENCODE_AEV_REQUEST_BUDGET_SHA256
      }
      process.env.AEV_CONSOLIDATION_ENFORCE_BUDGET = "1"
      result = await runDirectChatEvaluation({
        skillBundlePath: skill, datasetBundlePath: s.datasetPath, outDir: run,
        models, modelIDs: [s.modelID], globalConcurrency: s.concurrency,
        includeNoSkillBaseline: false, noSkillOnly: false, allowOmittedMaterials: false,
        resumeExisting: false, skillInputMode: "full", updateMasterReport: false,
      })
    } finally {
      if (prevFile !== undefined) process.env.OPENCODE_AEV_REQUEST_BUDGET_FILE = prevFile
      else delete process.env.OPENCODE_AEV_REQUEST_BUDGET_FILE
      if (prevSha !== undefined) process.env.OPENCODE_AEV_REQUEST_BUDGET_SHA256 = prevSha
      else delete process.env.OPENCODE_AEV_REQUEST_BUDGET_SHA256
      if (prevEnforce !== undefined) process.env.AEV_CONSOLIDATION_ENFORCE_BUDGET = prevEnforce
      else delete process.env.AEV_CONSOLIDATION_ENFORCE_BUDGET
    }
    const data = await readFile(path.join(run, "summary.json"))
    const report = JSON.parse(data.toString("utf8")) as DirectChatSummary
    const metrics = score({ summary: report, cases, modelID: s.modelID,
      skillHash: pub.sha256, datasetHash: s.datasetSHA256 })
    await verifyTraces(run, report)
    if (result.results.length !== metrics.total) throw new Error("Direct Chat execution count mismatch")
    const product = {
      schema: "aev.consolidation-eval.v1", runID: id, candidate_sha256: pub.sha256,
      dataset_sha256: s.datasetSHA256, model_id: s.modelID, skill_chars: pub.chars,
      ...metrics, evidence_sha256: digest(data),
    }
    const tokens = result.results.reduce((acc, row) => ({
      inputTokens: acc.inputTokens + (row.usage?.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (row.usage?.outputTokens ?? 0),
    }), { inputTokens: 0, outputTokens: 0 })
    return { status: "completed", product: { kind: "json", bytes: Buffer.from(JSON.stringify(product)) }, usage: tokens }
  }
  const evaluate: Evaluate = async input => {
    const s = checker(input.settings)
    if (input.skill.length !== 1 || input.skill[0]?.id !== s.candidateID) {
      return { status: "data_error", message: "Exactly one candidate Skill entry is required" }
    }
    let pub
    try { pub = publication(input.skill[0].bytes, s.maxChars) }
    catch (error) { return { status: "rejected", message: error instanceof Error ? error.message : String(error) } }
    if (input.check.target === "skill") {
      return { status: "passed", message: `Published Skill surface passed (${pub.chars}/${s.maxChars})` }
    }
    try {
      if (input.candidate.length !== 1 || input.candidate[0]?.kind !== "json") throw new Error("Missing JSON product")
      const product = JSON.parse(Buffer.from(input.candidate[0].bytes).toString("utf8"))
      if (product.schema !== "aev.consolidation-eval.v1" || !/^[0-9a-f-]{36}$/.test(product.runID) ||
          product.candidate_sha256 !== pub.sha256 || product.skill_chars !== pub.chars ||
          product.dataset_sha256 !== s.datasetSHA256 || product.model_id !== s.modelID ||
          product.total !== s.expectedCases || !sha(product.evidence_sha256)) {
        throw new Error("Consolidation product identity mismatch")
      }
      const dir = path.join(root, product.runID, "direct-chat")
      const data = await readFile(path.join(dir, "summary.json"))
      if (digest(data) !== product.evidence_sha256) throw new Error("Direct Chat evidence digest mismatch")
      const summary = JSON.parse(data.toString("utf8")) as DirectChatSummary
      const snapshot = JSON.parse(await readFile(path.join(dir, "config.snapshot.json"), "utf8"))
      if (snapshot.datasetHash !== s.datasetSHA256 || !Array.isArray(snapshot.caseIDs) ||
          snapshot.caseIDs.length !== s.expectedCases || snapshot.modelIDs?.length !== 1 ||
          snapshot.modelIDs[0] !== s.modelID || snapshot.resumeExisting !== false ||
          snapshot.includeNoSkillBaseline !== false || snapshot.noSkillOnly !== false) {
        throw new Error("Direct Chat snapshot identity mismatch")
      }
      const metrics = score({ summary, cases: snapshot.caseIDs, modelID: s.modelID,
        skillHash: pub.sha256, datasetHash: s.datasetSHA256 })
      await verifyTraces(dir, summary)
      if (metrics.passed !== product.passed || metrics.failed !== product.failed ||
          metrics.pass_rate !== product.pass_rate) throw new Error("Reported pass rate does not match cases")
      return { status: "passed", message: `Verified ${metrics.passed}/${metrics.total}; pass_rate=${metrics.pass_rate}` }
    } catch (error) {
      return { status: "scoring_error", message: error instanceof Error ? error.message : String(error) }
    }
  }
  return { executor, execute, checker: checks, evaluate, preflight }
}
