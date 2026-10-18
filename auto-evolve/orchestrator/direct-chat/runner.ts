import crypto from "node:crypto"
import path from "node:path"
import { cp, readFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { ensureDirectory, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "../fs"
import type { BudgetTransportConfig } from "../task-adaptation/budget-transport"
import type {
  DirectChatCaseBundle,
  DirectChatCaseResult,
  DirectChatModelConfig,
  DirectChatModelsConfig,
  DirectChatPromptAudit,
  DirectChatRunConfig,
} from "./contract"
import { readDirectChatDatasetBundle } from "./dataset-bundler"
import { DirectChatProviderError, classifyDirectChatError, retryDirectChatCall, type DirectChatMessage } from "./provider-client"
import { buildBudgetedPrompt, estimateDirectChatTokens } from "./material-budget"
import { prepareDirectChatMaterialsForModel } from "./ocr-fallback"
import { recordDirectChatResourceUsage } from "../resource-audit/recorder"

function sha256(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex")
}

function redactModelConfig(model: DirectChatModelConfig) {
  const { apiKey: _apiKey, ...safe } = model
  return {
    ...safe,
    apiKeyConfigured: Boolean(model.apiKey),
    apiKeyEnvConfigured: Boolean(model.apiKeyEnv),
  }
}

class Semaphore {
  private active = 0
  private queue: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active += 1
    try {
      return await fn()
    } finally {
      this.active -= 1
      this.queue.shift()?.()
    }
  }
}

function normalizeModelConfigs(config: DirectChatModelsConfig, modelIDs?: string[]) {
  const entries = Object.entries(config.models).map(([id, value]) => ({ ...value, id: value.id || id }))
  const selected = modelIDs?.length ? entries.filter((item) => modelIDs.includes(item.id)) : entries
  if (selected.length === 0) throw new Error("No direct-chat models selected")
  return selected as DirectChatModelConfig[]
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const DEFAULT_TRANSIENT_RECOVERY_CATEGORIES = ["network", "timeout", "rate_limit", "provider_5xx"] as const

type SkillVariant = {
  skillMode: "with-skill" | "no-skill"
  skillBundle: string
  skillTier: "full" | "head-tail" | "core-files" | "custom" | "none"
  skillPath?: string
  sourceOriginalTokens?: number
  selectionTruncated?: boolean
}

async function loadSkillTierCandidates(skillBundlePath: string) {
  const manifestPath = path.join(path.dirname(skillBundlePath), "skill.bundle.manifest.json")
  if (await pathExists(manifestPath)) {
    const manifest = await readJsonFile<any>(manifestPath)
    const tiers = Array.isArray(manifest.publicationTiers) ? manifest.publicationTiers : []
    const loaded: Array<SkillVariant & { skillMode: "with-skill" }> = []
    for (const tier of tiers) {
      if (!tier?.path || !(await pathExists(tier.path))) continue
      loaded.push({
        skillMode: "with-skill",
        skillBundle: await readFile(tier.path, "utf8"),
        skillTier: tier.id,
        skillPath: tier.path,
        sourceOriginalTokens: estimateDirectChatTokens(await readFile(tier.path, "utf8")),
        selectionTruncated: false,
      })
    }
    if (loaded.length) return loaded
  }
  return [{
    skillMode: "with-skill" as const,
    skillBundle: await readFile(skillBundlePath, "utf8"),
    skillTier: "custom" as const,
    skillPath: skillBundlePath,
    sourceOriginalTokens: estimateDirectChatTokens(await readFile(skillBundlePath, "utf8")),
    selectionTruncated: false,
  }]
}

function headTailSkill(fullSkill: string, targetTokens: number, headRatio: number) {
  const fullTokens = estimateDirectChatTokens(fullSkill)
  if (fullTokens <= targetTokens) return { content: fullSkill, truncated: false }
  const safeRatio = Math.min(0.9, Math.max(0.1, headRatio))
  const targetChars = Math.max(200, Math.floor(fullSkill.length * (targetTokens / fullTokens)))
  const marker = "\n\n[...SKILL_MIDDLE_TRUNCATED_BY_EXPLICIT_HEAD_TAIL_POLICY...]\n\n"
  const payloadChars = Math.max(100, targetChars - marker.length)
  const headChars = Math.floor(payloadChars * safeRatio)
  return {
    content: fullSkill.slice(0, headChars) + marker + fullSkill.slice(-(payloadChars - headChars)),
    truncated: true,
  }
}

function promptFitsAllCases(model: DirectChatModelConfig, cases: DirectChatCaseBundle[], skillBundle: string) {
  for (const testCase of cases) {
    buildBudgetedPrompt({
      skillBundle,
      caseID: testCase.caseID,
      model,
      question: testCase.question.text,
      outputInstruction: testCase.question.outputInstruction,
      materials: testCase.materials,
      encodeAssets: false,
    })
  }
}

function selectConfiguredSkillTier(input: {
  model: DirectChatModelConfig
  cases: DirectChatCaseBundle[]
  candidates: Array<SkillVariant & { skillMode: "with-skill" }>
  mode: "full" | "head-tail" | "core-files"
  headRatio: number
}) {
  const full = input.candidates.find((candidate) => candidate.skillTier === "full") || input.candidates[0]
  const selected = input.mode === "core-files"
    ? input.candidates.find((candidate) => candidate.skillTier === "core-files")
    : full
  if (!selected) throw new Error(`Skill input mode ${input.mode} is unavailable for model ${input.model.id}`)
  if (input.mode !== "head-tail") {
    try {
      promptFitsAllCases(input.model, input.cases, selected.skillBundle)
      return { selected, truncated: false, originalTokens: estimateDirectChatTokens(selected.skillBundle) }
    } catch (error) {
      throw new Error(
        `Configured Direct Chat skill mode ${input.mode} does not fit model ${input.model.id}. ` +
          `Question and materials are never truncated. ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const originalTokens = estimateDirectChatTokens(full.skillBundle)
  const maxSkillTokens = Math.min(input.model.skillBudgetTokens ?? originalTokens, originalTokens)
  for (let target = maxSkillTokens; target >= 256; target = Math.floor(target * 0.9)) {
    const sliced = headTailSkill(full.skillBundle, target, input.headRatio)
    try {
      promptFitsAllCases(input.model, input.cases, sliced.content)
      return {
        selected: {
          ...full,
          skillBundle: sliced.content,
          skillTier: "head-tail" as const,
          sourceOriginalTokens: originalTokens,
          selectionTruncated: sliced.truncated,
        },
        truncated: sliced.truncated,
        originalTokens,
      }
    } catch {
      // Keep reducing only the skill. The question and materials remain unchanged.
    }
  }
  throw new Error(
    `Head-tail skill policy could not fit model ${input.model.id} without truncating question or materials.`,
  )
}

function directChatResultPath(
  outDir: string,
  model: DirectChatModelConfig,
  caseID: string,
  skillMode: "with-skill" | "no-skill",
) {
  const modelResultID = skillMode === "no-skill" ? `${model.id}__no-skill` : model.id
  return path.join(outDir, "results", modelResultID, caseID, "result.json")
}

async function archiveRecoveryAttempt(outDir: string, result: DirectChatCaseResult, round: number) {
  const sourceDir = path.dirname(result.rawResponsePath)
  if (!(await pathExists(sourceDir))) return undefined
  const archiveDir = path.join(
    outDir,
    "transient-recovery-history",
    `round-${String(round).padStart(2, "0")}`,
    result.modelID,
    result.caseID,
  )
  await ensureDirectory(path.dirname(archiveDir))
  await cp(sourceDir, archiveDir, { recursive: true, force: true })
  return archiveDir
}

type AnswerCandidate = {
  value: string
  source: string
  score: number
  index: number
}

export type AnswerExtractionResult = {
  answer: string
  source: string
  confidence: "high" | "medium" | "low"
  candidates: AnswerCandidate[]
}

const NUMERIC_ANSWER_PATTERN = String.raw`[+-]?(?:\d[\d,]*|\d*\.\d+)(?:\.\d+)?%?`

function collectAnswerCandidates(text: string) {
  const candidates: AnswerCandidate[] = []
  const addMatches = (source: string, score: number, pattern: RegExp, group = 1) => {
    for (const match of text.matchAll(pattern)) {
      const raw = match[group]
      if (!raw?.trim()) continue
      candidates.push({
        value: normalizeAnswerCandidate(raw),
        source,
        score,
        index: match.index ?? 0,
      })
    }
  }

  addMatches("answer_tag", 1000, /<answer>\s*([\s\S]*?)\s*<\/answer>/gi)
  addMatches("partial_answer_tag", 950, /<answer>\s*([^<\r\n]{1,240})(?:<\/answer>?)?/gi)
  addMatches(
    "final_answer_numeric",
    930,
    new RegExp(String.raw`(?:final answer|final value|最终答案|答案)\s*[:：]\s*(${NUMERIC_ANSWER_PATTERN})`, "gi"),
  )
  addMatches("final_answer_label", 920, /(?:final answer|final value|最终答案|答案)\s*[:：]\s*([^\r\n]{1,240})/gi)
  addMatches(
    "explicit_output",
    900,
    new RegExp(String.raw`(?:I\s+will|I'll|I\s+would)\s+(?:output|provide|return|submit|go\s+with)\s+(${NUMERIC_ANSWER_PATTERN})`, "gi"),
  )
  addMatches(
    "rounded_result",
    880,
    new RegExp(
      String.raw`(?:rounded(?:\s+to\s+(?:the\s+)?nearest\s+[\w-]+(?:\s+place)?)?[^.\r\n]{0,100}(?:is|=|:|->|→)\s*)(${NUMERIC_ANSWER_PATTERN})`,
      "gi",
    ),
  )
  addMatches("arrow_result", 840, new RegExp(String.raw`(?:->|→)\s*(${NUMERIC_ANSWER_PATTERN})`, "g"))
  addMatches(
    "answer_statement",
    820,
    new RegExp(String.raw`(?:the\s+answer|the\s+result|final\s+result)\s*(?:is\s+(?:exactly\s+)?|[=:：]\s*)(${NUMERIC_ANSWER_PATTERN})`, "gi"),
  )
  addMatches(
    "calculated_average",
    760,
    new RegExp(String.raw`(?:weighted\s+average|average|difference|percent(?:age)?\s+change)\s*(?:is|=|:)\s*(${NUMERIC_ANSWER_PATTERN})`, "gi"),
  )
  addMatches(
    "conclusion_numeric",
    740,
    new RegExp(String.raw`(?:therefore|thus|hence|so)\s*,?\s*(?:the\s+(?:answer|result|value)\s+is\s+)?(${NUMERIC_ANSWER_PATTERN})`, "gi"),
  )
  addMatches(
    "sum_statement",
    620,
    new RegExp(String.raw`(?:the\s+sum|sum)\s*(?:is\s+(?:exactly\s+|definitely\s+)?|[=:：]\s*)(${NUMERIC_ANSWER_PATTERN})`, "gi"),
  )

  for (const match of text.matchAll(/^(\s*(?:\[[^\r\n]*\]|\{[^\r\n]*\})\s*)$/gm)) {
    candidates.push({
      value: normalizeAnswerCandidate(match[1]!),
      source: "standalone_json",
      score: 800,
      index: match.index ?? 0,
    })
  }
  for (const match of text.matchAll(new RegExp(String.raw`^\s*(${NUMERIC_ANSWER_PATTERN})\s*$`, "gm"))) {
    candidates.push({
      value: normalizeAnswerCandidate(match[1]!),
      source: "standalone_numeric",
      score: 500,
      index: match.index ?? 0,
    })
  }
  return candidates
}

export function extractAnswerDetailed(response: string): AnswerExtractionResult {
  const cleaned = response.trim().replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/i, "").trim()
  const candidates = collectAnswerCandidates(cleaned)
    .filter((item) => item.value.length > 0 && item.value.length <= 500)
    .sort((left, right) => right.score - left.score || right.index - left.index)
  const selected = candidates[0]
  if (selected) {
    return {
      answer: selected.value,
      source: selected.source,
      confidence: selected.score >= 820 ? "high" : selected.score >= 620 ? "medium" : "low",
      candidates: candidates.slice(0, 20),
    }
  }
  if (cleaned.length <= 500) {
    const trailingNumber = cleaned.match(new RegExp(String.raw`(${NUMERIC_ANSWER_PATTERN})\s*$`))?.[1]
    return {
      answer: trailingNumber ? normalizeAnswerCandidate(trailingNumber) : cleaned,
      source: trailingNumber ? "short_response_trailing_value" : "short_response",
      confidence: "low",
      candidates: [],
    }
  }
  return {
    answer: cleaned,
    source: "unresolved_long_response",
    confidence: "low",
    candidates: [],
  }
}

export function extractAnswer(response: string) {
  return extractAnswerDetailed(response).answer
}

function normalizeAnswerCandidate(value: string) {
  const cleaned = value.trim().replace(/^`+|`+$/g, "").replace(/\s*\.$/g, "").trim()
  if (/^[+-]?\d[\d,]*(?:\.\d+)?%?$/.test(cleaned)) return cleaned.replace(/,/g, "")
  return cleaned
}

function answerExtensionForCase(testCase: DirectChatCaseBundle) {
  const candidateArgName = testCase.privateOracle?.candidateArgName || "--candidate"
  const args = testCase.privateOracle?.args || []
  const index = args.indexOf(candidateArgName)
  const declared = index >= 0 ? args[index + 1] : undefined
  const extension = declared ? path.extname(declared).toLowerCase() : ""
  if (extension === ".json") return ".json"
  if (extension === ".md") return ".md"
  if (extension === ".txt") return ".txt"
  if (testCase.question.answerFormat?.toLowerCase().includes("json")) return ".json"
  return ".txt"
}

function answerFileNameForCase(testCase: DirectChatCaseBundle) {
  const extension = answerExtensionForCase(testCase)
  if (extension === ".json") return "answer.json"
  if (extension === ".md") return "answer.md"
  return "answer.txt"
}

async function assertPromptDoesNotLeak(testCase: DirectChatCaseBundle, messages: DirectChatMessage[]) {
  const promptText = messages.map((item) => (typeof item.content === "string" ? item.content : JSON.stringify(item.content))).join("\n")
  const forbidden = ["private-answers", "--answer-path", "--ground-truth"]
  for (const value of forbidden) {
    if (promptText.toLowerCase().includes(value.toLowerCase())) throw new Error(`Prompt leakage guard hit: ${value}`)
  }
}

async function runProcess(command: string, args: string[]) {
  return await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }))
  })
}

async function runProductValidator(testCase: DirectChatCaseBundle, answerPath: string, outDir: string) {
  const oracle = testCase.privateOracle
  const validatorResultPath = path.join(outDir, "validator-result.json")
  if (!oracle?.scriptPath) {
    const result = {
      passed: false,
      score: 0,
      error: "Missing direct-chat private oracle or validator details",
    }
    await writeJsonFile(validatorResultPath, result)
    return { passed: false, score: 0, validatorResultPath, error: result.error }
  }
  const rawArgs = oracle.args?.length
    ? [...oracle.args]
    : [
        "--answer-path",
        oracle.answerPath || "",
        "--candidate",
        answerPath,
        "--reward",
        oracle.rewardPath || "",
        "--tolerance",
        String(oracle.tolerance ?? 0.01),
      ]
  const candidateArgName = oracle.candidateArgName || "--candidate"
  const candidateIndex = rawArgs.indexOf(candidateArgName)
  if (candidateIndex >= 0 && candidateIndex + 1 < rawArgs.length) rawArgs[candidateIndex + 1] = answerPath
  else rawArgs.push(candidateArgName, answerPath)
  const command = oracle.runner === "bun" ? process.execPath : "python"
  const args = oracle.runner === "bun" ? [oracle.scriptPath, ...rawArgs] : [oracle.scriptPath, ...rawArgs]
  const processResult = await runProcess(command, args)
  let parsed: any
  try {
    parsed = JSON.parse(processResult.stdout.trim())
  } catch {
    parsed = undefined
  }
  const passed = typeof parsed?.passed === "boolean" ? parsed.passed : processResult.exitCode === 0
  const result = {
    passed,
    score: passed ? 1 : 0,
    exitCode: processResult.exitCode,
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    parsed,
  }
  await writeJsonFile(validatorResultPath, result)
  return { passed, score: passed ? 1 : 0, validatorResultPath, error: passed ? null : processResult.stderr || processResult.stdout }
}

async function preflightDirectChatRun(input: {
  outDir: string
  skillBundle: string
  datasetBundleText: string
  cases: DirectChatCaseBundle[]
  models: DirectChatModelConfig[]
  modelVariants: Map<string, SkillVariant[]>
  allowOmittedMaterials?: boolean
}) {
  const checks: Array<Record<string, unknown>> = []
  const errors: string[] = []
  for (const testCase of input.cases) {
    if (testCase.materialAudit.omittedSources.length && !input.allowOmittedMaterials) {
      errors.push(
        `${testCase.caseID}: omitted source materials: ${testCase.materialAudit.omittedSources.join(", ")}`,
      )
    }
    for (const model of input.models) {
      for (const variant of input.modelVariants.get(model.id) || []) {
        try {
          const prompt = buildBudgetedPrompt({
            skillBundle: variant.skillBundle,
            caseID: testCase.caseID,
            model,
            question: testCase.question.text,
            outputInstruction: testCase.question.outputInstruction,
            materials: testCase.materials,
            encodeAssets: false,
            skillAudit: {
              tier: variant.skillTier,
              sourceOriginalTokens: variant.sourceOriginalTokens,
              selectionTruncated: variant.selectionTruncated,
            },
          })
          const capabilityWarnings = prompt.audit.warnings.filter(
            (warning) =>
              warning.includes("does not declare") ||
              warning.includes("unsupported") ||
              warning.includes("not certified"),
          )
          checks.push({
            caseID: testCase.caseID,
            modelID: model.id,
            skillMode: variant.skillMode,
            skillTier: variant.skillTier,
            status: capabilityWarnings.length ? "deferred-material-routing" : "passed",
            estimatedPromptTokens: prompt.audit.estimatedPromptTokens,
            promptBudgetTokens: prompt.audit.promptBudgetTokens,
            skillTokens: prompt.audit.skill.includedTokens,
            materialTokens: prompt.audit.materials.reduce((sum, material) => sum + material.includedTokens, 0),
            warnings: prompt.audit.warnings,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          errors.push(`${testCase.caseID}/${model.id}/${variant.skillMode}: ${message}`)
          checks.push({
            caseID: testCase.caseID,
            modelID: model.id,
            skillMode: variant.skillMode,
            skillTier: variant.skillTier,
            status: "failed",
            error: message,
          })
        }
      }
    }
  }
  const payload = {
    schema: "direct-chat-run-preflight/v1",
    status: errors.length ? "failed" : "passed",
    createdAt: new Date().toISOString(),
    skillHash: sha256(input.skillBundle),
    datasetHash: sha256(input.datasetBundleText),
    caseCount: input.cases.length,
    modelIDs: input.models.map((model) => model.id),
    checks,
    errors,
  }
  const preflightPath = path.join(input.outDir, "run-preflight.json")
  await writeJsonFile(preflightPath, payload)
  if (errors.length) {
    throw new Error(
      `Direct Chat preflight failed before any model request. See ${preflightPath}. First errors: ${errors.slice(0, 5).join(" | ")}`,
    )
  }
  return { preflightPath, payload }
}

async function runOneCase(input: {
  model: DirectChatModelConfig
  testCase: DirectChatCaseBundle
  skillBundle: string
  skillMode: "with-skill" | "no-skill"
  skillTier: SkillVariant["skillTier"]
  sourceOriginalTokens?: number
  selectionTruncated?: boolean
  outDir: string
  cwd: string
  modelsConfig: DirectChatModelsConfig
  requestBudgetTransport?: BudgetTransportConfig
  enforceRequestBudget?: boolean
}) {
  const modelResultID = input.skillMode === "no-skill" ? `${input.model.id}__no-skill` : input.model.id
  const caseDir = path.join(input.outDir, "results", modelResultID, input.testCase.caseID)
  await ensureDirectory(caseDir)

  const started = Date.now()
  let promptAudit: DirectChatPromptAudit | undefined
  let promptAuditPath: string | undefined
  let providerResponsePath: string | undefined
  const writeResultAndUsage = async (result: DirectChatCaseResult) => {
    await writeJsonFile(path.join(caseDir, "result.json"), result)
    await recordDirectChatResourceUsage({
      cwd: input.cwd,
      outDir: input.outDir,
      caseDir,
      result,
      promptAudit,
      promptAuditPath,
      providerResponsePath,
    })
  }
  try {
    const prepared = await prepareDirectChatMaterialsForModel({
      caseID: input.testCase.caseID,
      model: input.model,
      modelsConfig: input.modelsConfig,
      materials: input.testCase.materials,
      caseDir,
    })
    const prompt = buildBudgetedPrompt({
      skillBundle: input.skillBundle,
      caseID: input.testCase.caseID,
      model: input.model,
      question: input.testCase.question.text,
      outputInstruction: input.testCase.question.outputInstruction,
      materials: prepared.materials,
      skillAudit: {
        tier: input.skillTier,
        sourceOriginalTokens: input.sourceOriginalTokens,
        selectionTruncated: input.selectionTruncated,
      },
    })
    const messages = prompt.messages as DirectChatMessage[]
    promptAudit = prompt.audit
    await assertPromptDoesNotLeak(input.testCase, messages)
    await writeTextFile(
      path.join(caseDir, "prompt.system.txt"),
      typeof messages[0].content === "string" ? messages[0].content : JSON.stringify(messages[0].content, null, 2),
    )
    await writeTextFile(path.join(caseDir, "prompt.user.txt"), typeof messages[1].content === "string" ? messages[1].content : JSON.stringify(messages[1].content, null, 2))
    promptAuditPath = path.join(caseDir, "prompt-audit.json")
    await writeJsonFile(promptAuditPath, prompt.audit)
    const requestAuditPath = path.join(caseDir, "request-audit.json")
    await writeJsonFile(requestAuditPath, {
      schema: "direct-chat-request-audit/v1",
      createdAt: new Date().toISOString(),
      caseID: input.testCase.caseID,
      skillMode: input.skillMode,
      skillTier: input.skillTier,
      skillHash: input.skillMode === "no-skill" ? "NO_SKILL" : sha256(input.skillBundle),
      model: redactModelConfig(input.model),
      promptAudit: prompt.audit,
      materialAudit: input.testCase.materialAudit,
    })

    const capabilityWarning = prompt.audit.warnings.find(
      (warning) =>
        warning.includes("does not declare") ||
        warning.includes("unsupported") ||
        warning.includes("not certified"),
    )
    if (capabilityWarning) throw new DirectChatProviderError(capabilityWarning, "config", undefined, false)
    const { result: callResult, attempts } = await retryDirectChatCall(input.model, messages, {
      maxAttempts: input.modelsConfig.retry?.maxAttempts ?? 3,
      backoffMs: input.modelsConfig.retry?.backoffMs ?? 3000,
    }, {
      caseID: input.testCase.caseID,
      requestBudgetTransport: input.requestBudgetTransport,
      enforceRequestBudget: input.enforceRequestBudget,
      // 同题不同候选属不同评测；原目录重发仍由同一账本拒绝。
      stableRequestID: sha256(path.resolve(caseDir).replaceAll("\\", "/")),
    })
    const responsePath = path.join(caseDir, "response.txt")
    await writeTextFile(responsePath, callResult.content)
    providerResponsePath = path.join(caseDir, "provider-response.json")
    await writeJsonFile(providerResponsePath, {
      schema: "direct-chat-provider-response/v1",
      resolvedModel: callResult.resolvedModel || null,
      finishReason: callResult.finishReason || null,
      usage: callResult.usage || null,
      raw: callResult.raw ?? null,
    })
    const outputBudgetExceeded =
      typeof callResult.usage?.outputTokens === "number" &&
      callResult.usage.outputTokens > (input.model.maxOutputTokens ?? 2048)
    const extraction = extractAnswerDetailed(callResult.content)
    const answer = extraction.answer
    const answerPath = path.join(caseDir, answerFileNameForCase(input.testCase))
    await writeJsonFile(path.join(caseDir, "answer-extraction.json"), extraction)
    if (extraction.source === "unresolved_long_response") {
      const result: DirectChatCaseResult = {
        schema: "direct-chat-result/v1",
        caseID: input.testCase.caseID,
        modelID: modelResultID,
        provider: input.model.provider,
        passed: false,
        score: 0,
        answer: "",
        rawResponsePath: responsePath,
        usage: callResult.usage,
        resolvedModel: callResult.resolvedModel,
        finishReason: callResult.finishReason,
        responseAuditPath: providerResponsePath,
        requestAuditPath,
        outputBudgetExceeded,
        latencyMs: Date.now() - started,
        attempts,
        error: "The model returned a long response without a confidently identifiable final answer.",
        errorCategory: "answer_extraction",
        skillMode: input.skillMode,
        skillTier: input.skillTier,
        skillHash: input.skillMode === "no-skill" ? "NO_SKILL" : sha256(input.skillBundle),
      }
      await writeResultAndUsage(result)
      return result
    }
    await writeTextFile(answerPath, answer)
    const validator = await runProductValidator(input.testCase, answerPath, caseDir)
    const result: DirectChatCaseResult = {
      schema: "direct-chat-result/v1",
      caseID: input.testCase.caseID,
      modelID: modelResultID,
      provider: input.model.provider,
      passed: validator.passed,
      score: validator.score,
      answer,
      rawResponsePath: responsePath,
      validatorResultPath: validator.validatorResultPath,
      usage: callResult.usage,
      resolvedModel: callResult.resolvedModel,
      finishReason: callResult.finishReason,
      responseAuditPath: providerResponsePath,
      requestAuditPath,
      outputBudgetExceeded,
      latencyMs: Date.now() - started,
      attempts,
      error: validator.error,
      errorCategory: validator.passed ? "none" : "validation",
      skillMode: input.skillMode,
      skillTier: input.skillTier,
      skillHash: input.skillMode === "no-skill" ? "NO_SKILL" : sha256(input.skillBundle),
    }
    await writeResultAndUsage(result)
    return result
  } catch (error) {
    const result: DirectChatCaseResult = {
      schema: "direct-chat-result/v1",
      caseID: input.testCase.caseID,
      modelID: modelResultID,
      provider: input.model.provider,
      passed: false,
      score: 0,
      answer: "",
      rawResponsePath: path.join(caseDir, "response.txt"),
      latencyMs: Date.now() - started,
      attempts: 0,
      error: error instanceof Error ? error.message : String(error),
      errorCategory: classifyDirectChatError(error),
      skillMode: input.skillMode,
      skillTier: input.skillTier,
      skillHash: input.skillMode === "no-skill" ? "NO_SKILL" : sha256(input.skillBundle),
    }
    await writeResultAndUsage(result)
    return result
  }
}

async function writeSummary(
  outDir: string,
  results: DirectChatCaseResult[],
  integrity: {
    preflightPath: string
    skillHash: string
    datasetHash: string
    expectedResultCount: number
    skillTierSelection: Array<Record<string, unknown>>
  },
) {
  const byModel = new Map<string, DirectChatCaseResult[]>()
  for (const result of results) byModel.set(result.modelID, [...(byModel.get(result.modelID) || []), result])
  const summary = Array.from(byModel.entries()).map(([modelID, items]) => ({
    modelID,
    total: items.length,
    passed: items.filter((item) => item.passed).length,
    failed: items.filter((item) => !item.passed).length,
    passRate: items.length ? items.filter((item) => item.passed).length / items.length : 0,
    avgLatencyMs: items.length ? Math.round(items.reduce((sum, item) => sum + item.latencyMs, 0) / items.length) : 0,
  }))
  const validityReasons: string[] = []
  if (results.length !== integrity.expectedResultCount) {
    validityReasons.push(`Expected ${integrity.expectedResultCount} results but found ${results.length}`)
  }
  const outputBudgetViolations = results.filter((result) => result.outputBudgetExceeded)
  if (outputBudgetViolations.length) {
    validityReasons.push(
      `${outputBudgetViolations.length} provider responses exceeded the configured output token budget`,
    )
  }
  const validity = {
    status: validityReasons.length ? "invalid" : "valid",
    reasons: validityReasons,
    preflightPath: integrity.preflightPath,
    skillHash: integrity.skillHash,
    datasetHash: integrity.datasetHash,
    promptIntegrity: "passed",
    materialIntegrity: "passed",
    modelAuditIntegrity: outputBudgetViolations.length ? "failed" : "passed",
    skillTierSelection: integrity.skillTierSelection,
  }
  await writeJsonFile(path.join(outDir, "summary.json"), {
    schema: "direct-chat-summary/v1",
    validity,
    summary,
    results,
  })
  const csv = ["modelID,total,passed,failed,passRate,avgLatencyMs"]
  for (const item of summary) csv.push([item.modelID, item.total, item.passed, item.failed, item.passRate, item.avgLatencyMs].join(","))
  await writeTextFile(path.join(outDir, "summary.csv"), csv.join("\n") + "\n")
  const md = ["# Direct Chat Summary", ""]
  md.push(`- Validity: ${validity.status}`)
  for (const reason of validity.reasons) md.push(`- Invalid reason: ${reason}`)
  for (const item of summary) md.push(`- ${item.modelID}: ${item.passed}/${item.total} passed (${(item.passRate * 100).toFixed(1)}%)`)
  await writeTextFile(path.join(outDir, "summary.md"), md.join("\n") + "\n")
}

async function updateMasterReport(outDir: string) {
  const scriptPath = path.resolve(import.meta.dir, "..", "..", "scripts", "update-direct-chat-master-report.py")
  const reportPath = path.resolve(import.meta.dir, "..", "..", "runtime-state", "direct-chat-reports", "direct-chat-evaluation-master.xlsx")
  try {
    const result = await runProcess("python", [scriptPath, "--out", reportPath, "--current-run", outDir])
    if (result.exitCode !== 0) {
      await writeTextFile(
        path.join(outDir, "master-report-update-error.log"),
        `exitCode=${result.exitCode}\nstdout=${result.stdout}\nstderr=${result.stderr}\n`,
      )
      console.warn(`Direct Chat master report update failed; evaluation results remain valid: ${result.stderr || result.stdout}`)
      return
    }
    try {
      const statusLine = result.stdout.trim().split(/\r?\n/g).filter(Boolean).at(-1)
      const status = statusLine ? JSON.parse(statusLine) : undefined
      if (status?.status === "pending-excel-close") {
        const message =
          `The Direct Chat master workbook is open. The complete update was saved to ${status.pendingPath} ` +
          "and will be promoted automatically after Excel closes."
        await writeTextFile(path.join(outDir, "master-report-update-pending.log"), `${message}\n`)
        console.warn(message)
      }
    } catch {
      // The workbook update already succeeded; malformed diagnostic output must not affect evaluation.
    }
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    await writeTextFile(path.join(outDir, "master-report-update-error.log"), `${message}\n`)
    console.warn(`Direct Chat master report update failed; evaluation results remain valid: ${message}`)
  }
}

export async function runDirectChatEvaluation(config: DirectChatRunConfig) {
  const outDir = path.resolve(config.outDir)
  const cwd = path.resolve(import.meta.dir, "..", "..", "..")
  await ensureDirectory(outDir)
  const skillBundle = await readFile(config.skillBundlePath, "utf8")
  const datasetBundleText = await readFile(config.datasetBundlePath, "utf8")
  const allCases = await readDirectChatDatasetBundle(config.datasetBundlePath)
  const requestedCaseIDs = config.caseIDs?.map((item) => item.trim()).filter(Boolean)
  const requestedCaseSet = requestedCaseIDs?.length ? new Set(requestedCaseIDs) : undefined
  const cases = requestedCaseSet ? allCases.filter((item) => requestedCaseSet.has(item.caseID)) : allCases
  if (requestedCaseSet) {
    const matched = new Set(cases.map((item) => item.caseID))
    const missing = [...requestedCaseSet].filter((id) => !matched.has(id))
    if (missing.length) throw new Error(`Direct-chat case IDs not found in dataset bundle: ${missing.join(", ")}`)
  }
  const models = normalizeModelConfigs(config.models, config.modelIDs)
  const globalSemaphore = new Semaphore(config.globalConcurrency || config.models.concurrency?.global || 4)
  const modelSemaphores = new Map(models.map((model) => [model.id, new Semaphore(model.concurrency || 1)]))
  const modelRequestSpacing = new Map(models.map((model) => [model.id, Math.max(0, Math.floor(model.minIntervalMs || 0))]))
  const modelNextAvailableAt = new Map<string, number>()
  const skillCandidates = config.noSkillOnly ? [] : await loadSkillTierCandidates(config.skillBundlePath)
  const modelVariants = new Map<string, SkillVariant[]>()
  const skillTierSelection: Array<Record<string, unknown>> = []
  for (const model of models) {
    if (config.noSkillOnly) {
      modelVariants.set(model.id, [{ skillMode: "no-skill", skillBundle: "", skillTier: "none" }])
      continue
    }
    const configuredMode =
      model.skillInputMode || config.skillInputMode || config.models.skillInput?.mode || "full"
    const headRatio = model.skillHeadRatio ?? config.models.skillInput?.headRatio ?? 0.65
    const selection = selectConfiguredSkillTier({
      model,
      cases,
      candidates: skillCandidates,
      mode: configuredMode,
      headRatio,
    })
    const variants: SkillVariant[] = [selection.selected]
    if (config.includeNoSkillBaseline) variants.push({ skillMode: "no-skill", skillBundle: "", skillTier: "none" })
    modelVariants.set(model.id, variants)
    skillTierSelection.push({
      modelID: model.id,
      selectedTier: selection.selected.skillTier,
      selectedPath: selection.selected.skillPath,
      selectedHash: sha256(selection.selected.skillBundle),
      selectedBytes: Buffer.byteLength(selection.selected.skillBundle, "utf8"),
      originalTokens: selection.originalTokens,
      includedTokens: estimateDirectChatTokens(selection.selected.skillBundle),
      truncated: selection.truncated,
      headRatio: configuredMode === "head-tail" ? headRatio : null,
    })
  }
  const preflight = await preflightDirectChatRun({
    outDir,
    skillBundle,
    datasetBundleText,
    cases,
    models,
    modelVariants,
    allowOmittedMaterials: config.allowOmittedMaterials,
  })
  await writeJsonFile(path.join(outDir, "config.snapshot.json"), {
    skillBundlePath: config.skillBundlePath,
    skillHash: sha256(skillBundle),
    datasetBundlePath: config.datasetBundlePath,
    datasetHash: sha256(datasetBundleText),
    runModeID: config.runModeID || null,
    runModeDescription: config.runModeDescription || null,
    modelIDs: models.map((model) => model.id),
    models: models.map(redactModelConfig),
    skillTierSelection,
    caseIDs: cases.map((item) => item.caseID),
    globalConcurrency: config.globalConcurrency || config.models.concurrency?.global || 4,
    includeNoSkillBaseline: Boolean(config.includeNoSkillBaseline),
    noSkillOnly: Boolean(config.noSkillOnly),
    resumeExisting: Boolean(config.resumeExisting),
    transientRecovery: config.models.transientRecovery || null,
    ocrFallback: config.models.ocrFallback || null,
    preflightPath: preflight.preflightPath,
    createdAt: new Date().toISOString(),
  })
  if (config.preflightOnly) return { outDir, results: [], preflight }

  const executions: Array<{
    model: DirectChatModelConfig
    testCase: DirectChatCaseBundle
    variant: SkillVariant
  }> = []
  for (const model of models) {
    for (const testCase of cases) {
      for (const variant of modelVariants.get(model.id) || []) {
        executions.push({ model, testCase, variant })
      }
    }
  }
  async function executeOne(
    execution: (typeof executions)[number],
    options: { reuseExisting: boolean },
  ): Promise<DirectChatCaseResult> {
    const resultPath = directChatResultPath(
      outDir,
      execution.model,
      execution.testCase.caseID,
      execution.variant.skillMode,
    )
    if (options.reuseExisting && (await pathExists(resultPath))) {
      const existing = await readJsonFile<DirectChatCaseResult>(resultPath)
      const expectedSkillHash =
        execution.variant.skillMode === "no-skill" ? "NO_SKILL" : sha256(execution.variant.skillBundle)
      if (existing.skillTier === execution.variant.skillTier && existing.skillHash === expectedSkillHash) return existing
    }
    const modelSemaphore = modelSemaphores.get(execution.model.id)!
    return await globalSemaphore.run(() =>
      modelSemaphore.run(() =>
        (async () => {
          const spacingMs = modelRequestSpacing.get(execution.model.id) || 0
          if (spacingMs > 0) {
            const now = Date.now()
            const nextAvailableAt = modelNextAvailableAt.get(execution.model.id) || 0
            const waitMs = Math.max(0, nextAvailableAt - now)
            if (waitMs > 0) await sleep(waitMs)
          }
          const startedAt = Date.now()
          try {
            return await runOneCase({
              model: execution.model,
              testCase: execution.testCase,
              skillBundle: execution.variant.skillBundle,
              skillMode: execution.variant.skillMode,
              skillTier: execution.variant.skillTier,
              sourceOriginalTokens: execution.variant.sourceOriginalTokens,
              selectionTruncated: execution.variant.selectionTruncated,
              outDir,
              cwd,
              modelsConfig: config.models,
              requestBudgetTransport: config.requestBudgetTransport,
              enforceRequestBudget: config.enforceRequestBudget,
            })
          } finally {
            const spacingMs = modelRequestSpacing.get(execution.model.id) || 0
            if (spacingMs > 0) modelNextAvailableAt.set(execution.model.id, startedAt + spacingMs)
          }
        })(),
      ),
    )
  }

  const results = await Promise.all(
    executions.map((execution) => executeOne(execution, { reuseExisting: Boolean(config.resumeExisting) })),
  )
  const recoveryConfig = config.models.transientRecovery
  const recoveryEnabled = recoveryConfig?.enabled !== false
  const recoveryRounds = recoveryEnabled ? Math.max(0, Math.floor(recoveryConfig?.maxRounds ?? 2)) : 0
  const recoveryDelayMs = Math.max(0, Math.floor(recoveryConfig?.delayMs ?? 30_000))
  const recoveryCategories = new Set(
    recoveryConfig?.categories?.length ? recoveryConfig.categories : DEFAULT_TRANSIENT_RECOVERY_CATEGORIES,
  )
  const recoveryAudit: {
    schema: "direct-chat-transient-recovery/v1"
    enabled: boolean
    maxRounds: number
    delayMs: number
    categories: string[]
    rounds: Array<Record<string, unknown>>
  } = {
    schema: "direct-chat-transient-recovery/v1",
    enabled: recoveryEnabled,
    maxRounds: recoveryRounds,
    delayMs: recoveryDelayMs,
    categories: [...recoveryCategories],
    rounds: [],
  }
  for (let round = 1; round <= recoveryRounds; round += 1) {
    const targetIndexes = results
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => !result.passed && recoveryCategories.has(result.errorCategory || "unknown"))
      .map(({ index }) => index)
    if (targetIndexes.length === 0) break
    const startedAt = new Date().toISOString()
    await writeJsonFile(path.join(outDir, "transient-recovery.json"), {
      ...recoveryAudit,
      activeRound: round,
      pending: targetIndexes.map((index) => ({
        modelID: results[index].modelID,
        caseID: results[index].caseID,
        errorCategory: results[index].errorCategory,
      })),
    })
    if (recoveryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, recoveryDelayMs))
    const before = targetIndexes.map((index) => results[index])
    await Promise.all(before.map((result) => archiveRecoveryAttempt(outDir, result, round)))
    const rerun = await Promise.all(
      targetIndexes.map((index) => executeOne(executions[index], { reuseExisting: false })),
    )
    rerun.forEach((result, offset) => {
      results[targetIndexes[offset]] = result
    })
    recoveryAudit.rounds.push({
      round,
      startedAt,
      finishedAt: new Date().toISOString(),
      attempted: targetIndexes.length,
      recovered: rerun.filter((result) => !recoveryCategories.has(result.errorCategory || "unknown")).length,
      stillTransient: rerun.filter((result) => recoveryCategories.has(result.errorCategory || "unknown")).length,
      cases: rerun.map((result) => ({
        modelID: result.modelID,
        caseID: result.caseID,
        passed: result.passed,
        errorCategory: result.errorCategory,
      })),
    })
    await writeJsonFile(path.join(outDir, "transient-recovery.json"), recoveryAudit)
  }
  await writeJsonFile(path.join(outDir, "transient-recovery.json"), recoveryAudit)
  await writeSummary(outDir, results, {
    preflightPath: preflight.preflightPath,
    skillHash: sha256(skillBundle),
    datasetHash: sha256(datasetBundleText),
    expectedResultCount: executions.length,
    skillTierSelection,
  })
  if (config.updateMasterReport !== false) await updateMasterReport(outDir)
  return { outDir, results }
}
