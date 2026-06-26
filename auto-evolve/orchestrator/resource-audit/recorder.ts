import path from "node:path"
import { createHash } from "node:crypto"
import { ensureDirectory, runtimePath, writeJsonFile, writeTextFile } from "../fs"
import type { OpencodeTaskInput, OpencodeTaskRun } from "../opencode"
import type { DirectChatCaseResult, DirectChatPromptAudit } from "../direct-chat/contract"
import { summarizeDirectChatUsage, summarizeOpencodeUsage } from "./usage"
import type { ResourceUsageRecord } from "./contract"

function normalizePathForRecord(input: string | undefined) {
  return input ? input.replace(/\\/g, "/") : undefined
}

function shortHash(input: string) {
  return createHash("sha256").update(input).digest("hex").slice(0, 16)
}

function safeFilePart(input: string) {
  return input.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "record"
}

function inferRoundNumber(stageDir?: string) {
  const normalized = normalizePathForRecord(stageDir) ?? ""
  const match = normalized.match(/round-(\d+)/i)
  return match ? Number.parseInt(match[1], 10) : undefined
}

function inferCampaignID(stageDir?: string) {
  const normalized = normalizePathForRecord(stageDir) ?? ""
  const match = normalized.match(/long-task-campaigns\/([^/]+)/i)
  return match?.[1]
}

function inferRole(input: { title?: string; phase?: string; stageDir?: string }) {
  const phase = input.phase?.trim()
  if (phase) return phase
  const haystack = `${input.title ?? ""} ${input.stageDir ?? ""}`.toLowerCase()
  if (haystack.includes("blank")) return "blank_eval"
  if (haystack.includes("campaign lead")) return "campaign_lead"
  if (haystack.includes("campaign reviewer") || haystack.includes("campaign review")) return "campaign_reviewer"
  if (haystack.includes("campaign worker")) return "campaign_worker"
  if (haystack.includes("validator")) return "validator"
  if (haystack.includes("repair")) return "repair"
  if (haystack.includes("merge")) return "merger"
  if (haystack.includes("execute")) return "executor"
  return undefined
}

async function writeShard(cwd: string, record: ResourceUsageRecord) {
  const dir = runtimePath(cwd, "resource-audit", "shards")
  await ensureDirectory(dir)
  const name = `${record.source}-${process.pid}-${Date.now()}-${safeFilePart(record.recordID)}.jsonl`
  await writeTextFile(path.join(dir, name), `${JSON.stringify(record)}\n`)
}

export async function recordOpencodeResourceUsage(input: {
  cwd: string
  taskRun: OpencodeTaskRun
  taskInput: OpencodeTaskInput
}) {
  const stageDir = input.taskInput.live?.stageDir
  const summary = summarizeOpencodeUsage(input.taskRun.result.events)
  const createdAt = new Date().toISOString()
  const eventsPath = stageDir ? path.join(stageDir, "events.json") : undefined
  const runJsonPath = stageDir ? path.join(stageDir, "run.json") : undefined
  const recordID = `opencode:${shortHash(
    [
      normalizePathForRecord(stageDir) ?? input.taskRun.title,
      input.taskRun.result.sessionID ?? "",
      input.taskRun.selectedModel ?? "",
      String(input.taskRun.result.events.length),
    ].join("|"),
  )}`
  const record: ResourceUsageRecord = {
    schema: "auto-evolve-resource-usage/v1",
    recordID,
    createdAt,
    source: "opencode",
    caseID: input.taskInput.live?.caseID,
    campaignID: inferCampaignID(stageDir),
    roundNumber: inferRoundNumber(stageDir),
    stageDir: normalizePathForRecord(stageDir),
    phase: input.taskInput.live?.phase,
    role: inferRole({
      title: input.taskRun.title,
      phase: input.taskInput.live?.phase,
      stageDir,
    }),
    title: input.taskRun.title,
    sessionID: input.taskRun.result.sessionID,
    model: input.taskRun.selectedModel,
    provider: input.taskRun.selectedModelResolution?.providerID,
    resolvedModel: input.taskRun.selectedModelResolution?.modelResolvedID ?? input.taskRun.selectedModelResolution?.modelID,
    usage: summary.usage,
    cost: {
      rawCost: summary.rawCost,
      rawCurrency: typeof summary.rawCost === "number" ? "provider-native" : undefined,
      priceStatus: typeof summary.rawCost === "number" ? "raw-only" : "missing",
      priceSource: typeof summary.rawCost === "number" ? "opencode-step-finish" : undefined,
    },
    status: input.taskRun.result.exitCode === 0 ? summary.status : "error",
    exitCode: input.taskRun.result.exitCode,
    usageSource: summary.usageSource,
    refs: {
      eventsPath: normalizePathForRecord(eventsPath),
      runJsonPath: normalizePathForRecord(runJsonPath),
      stageDir: normalizePathForRecord(stageDir),
    },
    warnings: summary.warnings.length ? summary.warnings : undefined,
  }

  try {
    if (stageDir) await writeJsonFile(path.join(stageDir, "resource-usage.json"), record)
    await writeShard(input.cwd, record)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Resource audit write failed for OpenCode task "${input.taskRun.title}": ${message}`)
  }
}

export async function recordDirectChatResourceUsage(input: {
  cwd: string
  outDir: string
  caseDir: string
  result: DirectChatCaseResult
  promptAudit?: DirectChatPromptAudit
  promptAuditPath?: string
  providerResponsePath?: string
}) {
  const summary = summarizeDirectChatUsage({
    usage: input.result.usage,
    promptAudit: input.promptAudit,
  })
  const createdAt = new Date().toISOString()
  const resultPath = path.join(input.caseDir, "result.json")
  const recordID = `direct-chat:${shortHash(
    [
      normalizePathForRecord(input.outDir),
      input.result.modelID,
      input.result.caseID,
      input.result.skillMode ?? "",
      input.result.skillHash ?? "",
    ].join("|"),
  )}`
  const record: ResourceUsageRecord = {
    schema: "auto-evolve-resource-usage/v1",
    recordID,
    createdAt,
    source: "direct-chat",
    runID: path.basename(input.outDir),
    benchmarkOutDir: normalizePathForRecord(input.outDir),
    caseID: input.result.caseID,
    stageDir: normalizePathForRecord(input.caseDir),
    phase: "direct_chat_eval",
    role: "direct_chat",
    title: `direct-chat ${input.result.modelID} ${input.result.caseID}`,
    model: input.result.modelID,
    provider: input.result.provider,
    resolvedModel: input.result.resolvedModel,
    usage: summary.usage,
    cost: {
      priceStatus: "missing",
    },
    status: input.result.errorCategory && input.result.errorCategory !== "none" ? "error" : summary.status,
    passed: input.result.passed,
    score: input.result.score,
    usageSource: summary.usageSource,
    refs: {
      resultPath: normalizePathForRecord(resultPath),
      promptAuditPath: normalizePathForRecord(input.promptAuditPath),
      providerResponsePath: normalizePathForRecord(input.providerResponsePath),
      stageDir: normalizePathForRecord(input.caseDir),
    },
    warnings: summary.warnings.length ? summary.warnings : undefined,
  }

  try {
    await writeJsonFile(path.join(input.caseDir, "resource-usage.json"), record)
    await writeShard(input.cwd, record)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Resource audit write failed for Direct Chat case "${input.result.caseID}": ${message}`)
  }
}
