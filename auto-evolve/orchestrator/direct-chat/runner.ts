import path from "node:path"
import { readFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { ensureDirectory, writeJsonFile, writeTextFile } from "../fs"
import type {
  DirectChatCaseBundle,
  DirectChatCaseResult,
  DirectChatModelConfig,
  DirectChatModelsConfig,
  DirectChatRunConfig,
} from "./contract"
import { readDirectChatDatasetBundle } from "./dataset-bundler"
import { DirectChatProviderError, classifyDirectChatError, retryDirectChatCall, type DirectChatMessage } from "./provider-client"
import { buildBudgetedPrompt } from "./material-budget"
import { prepareDirectChatMaterialsForModel } from "./ocr-fallback"

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

function extractAnswer(response: string) {
  const tagged = response.match(/<answer>\s*([\s\S]*?)\s*<\/answer>/i)?.[1]
  const cleaned = (tagged || response).trim().replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/i, "").trim()
  if (tagged) return cleaned
  const finalAnswerLine = [...cleaned.matchAll(/(?:final answer|final value|answer|答案|最终答案)\s*[:：]\s*([^\r\n]+)/gi)].pop()?.[1]
  if (finalAnswerLine) return normalizeAnswerCandidate(finalAnswerLine)
  const bracketLines = cleaned
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => /^(\[[\s\S]*\]|\{[\s\S]*\})$/.test(line))
  if (bracketLines.length) return normalizeAnswerCandidate(bracketLines[bracketLines.length - 1]!)
  const numericLines = cleaned
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => /^[+-]?(?:\d[\d,]*|\d*\.\d+)(?:\.\d+)?$/.test(line))
  if (numericLines.length) return normalizeAnswerCandidate(numericLines[numericLines.length - 1]!)
  const trailingNumber = cleaned.match(/([+-]?(?:\d[\d,]*|\d*\.\d+)(?:\.\d+)?)\s*$/)?.[1]
  if (trailingNumber) return normalizeAnswerCandidate(trailingNumber)
  return cleaned
}

function normalizeAnswerCandidate(value: string) {
  const cleaned = value.trim().replace(/^`+|`+$/g, "").replace(/\s*\.$/g, "").trim()
  if (/^[+-]?\d[\d,]*(?:\.\d+)?$/.test(cleaned)) return cleaned.replace(/,/g, "")
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
  const answerPath = testCase.privateOracle?.answerPath
  if (!answerPath) return
  const answer = (await readFile(answerPath, "utf8").catch(() => "")).trim()
  if (answer.length >= 6 && promptText.includes(answer)) throw new Error(`Prompt includes private answer literal for ${testCase.caseID}`)
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

async function runOneCase(input: {
  model: DirectChatModelConfig
  testCase: DirectChatCaseBundle
  skillBundle: string
  skillMode: "with-skill" | "no-skill"
  outDir: string
  modelsConfig: DirectChatModelsConfig
}) {
  const modelResultID = input.skillMode === "no-skill" ? `${input.model.id}__no-skill` : input.model.id
  const caseDir = path.join(input.outDir, "results", modelResultID, input.testCase.caseID)
  await ensureDirectory(caseDir)

  const started = Date.now()
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
    })
    const messages = prompt.messages as DirectChatMessage[]
    await assertPromptDoesNotLeak(input.testCase, messages)
    await writeTextFile(path.join(caseDir, "prompt.system.txt"), messages[0].content)
    await writeTextFile(path.join(caseDir, "prompt.user.txt"), typeof messages[1].content === "string" ? messages[1].content : JSON.stringify(messages[1].content, null, 2))
    await writeJsonFile(path.join(caseDir, "prompt-audit.json"), prompt.audit)

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
    })
    const answer = extractAnswer(callResult.content)
    const responsePath = path.join(caseDir, "response.txt")
    const answerPath = path.join(caseDir, answerFileNameForCase(input.testCase))
    await writeTextFile(responsePath, callResult.content)
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
      latencyMs: Date.now() - started,
      attempts,
      error: validator.error,
      errorCategory: validator.passed ? "none" : "validation",
      skillMode: input.skillMode,
    }
    await writeJsonFile(path.join(caseDir, "result.json"), result)
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
    }
    await writeJsonFile(path.join(caseDir, "result.json"), result)
    return result
  }
}

async function writeSummary(outDir: string, results: DirectChatCaseResult[]) {
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
  await writeJsonFile(path.join(outDir, "summary.json"), { schema: "direct-chat-summary/v1", summary, results })
  const csv = ["modelID,total,passed,failed,passRate,avgLatencyMs"]
  for (const item of summary) csv.push([item.modelID, item.total, item.passed, item.failed, item.passRate, item.avgLatencyMs].join(","))
  await writeTextFile(path.join(outDir, "summary.csv"), csv.join("\n") + "\n")
  const md = ["# Direct Chat Summary", ""]
  for (const item of summary) md.push(`- ${item.modelID}: ${item.passed}/${item.total} passed (${(item.passRate * 100).toFixed(1)}%)`)
  await writeTextFile(path.join(outDir, "summary.md"), md.join("\n") + "\n")
}

export async function runDirectChatEvaluation(config: DirectChatRunConfig) {
  const outDir = path.resolve(config.outDir)
  await ensureDirectory(outDir)
  const skillBundle = await readFile(config.skillBundlePath, "utf8")
  const cases = await readDirectChatDatasetBundle(config.datasetBundlePath)
  const models = normalizeModelConfigs(config.models, config.modelIDs)
  const globalSemaphore = new Semaphore(config.globalConcurrency || config.models.concurrency?.global || 4)
  const modelSemaphores = new Map(models.map((model) => [model.id, new Semaphore(model.concurrency || 1)]))
  await writeJsonFile(path.join(outDir, "config.snapshot.json"), {
    skillBundlePath: config.skillBundlePath,
    datasetBundlePath: config.datasetBundlePath,
    modelIDs: models.map((model) => model.id),
    globalConcurrency: config.globalConcurrency || config.models.concurrency?.global || 4,
    includeNoSkillBaseline: Boolean(config.includeNoSkillBaseline),
    ocrFallback: config.models.ocrFallback || null,
    createdAt: new Date().toISOString(),
  })

  const tasks: Array<Promise<DirectChatCaseResult>> = []
  const skillVariants = [
    { skillMode: "with-skill" as const, skillBundle },
    ...(config.includeNoSkillBaseline ? [{ skillMode: "no-skill" as const, skillBundle: "" }] : []),
  ]
  for (const model of models) {
    const modelSemaphore = modelSemaphores.get(model.id)!
    for (const testCase of cases) {
      for (const variant of skillVariants) {
        tasks.push(
          globalSemaphore.run(() =>
            modelSemaphore.run(() =>
              runOneCase({
                model,
                testCase,
                skillBundle: variant.skillBundle,
                skillMode: variant.skillMode,
                outDir,
                modelsConfig: config.models,
              }),
            ),
          ),
        )
      }
    }
  }
  const results = await Promise.all(tasks)
  await writeSummary(outDir, results)
  return { outDir, results }
}
