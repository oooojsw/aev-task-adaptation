import path from "node:path"
import { readdir } from "node:fs/promises"
import { ensureDirectory, pathExists, readJsonFile, runtimePath, writeJsonFile, writeTextFile } from "../orchestrator/fs"
import type { ResourceUsageRecord } from "../orchestrator/resource-audit/contract"

function parseArg(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function flag(name: string) {
  return process.argv.includes(name)
}

function normalizePath(input: string) {
  return input.replace(/\\/g, "/")
}

async function collectFiles(root: string, filename: string, out: string[] = []) {
  if (!(await pathExists(root))) return out
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      await collectFiles(full, filename, out)
    } else if (entry.isFile() && entry.name === filename) {
      out.push(full)
    }
  }
  return out
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function csvCell(value: unknown) {
  const text = value === undefined || value === null ? "" : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function keyFor(record: ResourceUsageRecord) {
  return [
    record.source,
    record.model ?? "",
    record.provider ?? "",
    record.phase ?? "",
    record.role ?? "",
  ].join("\u001f")
}

function aggregate(records: ResourceUsageRecord[]) {
  const byKey = new Map<string, any>()
  for (const record of records) {
    const key = keyFor(record)
    const current =
      byKey.get(key) ??
      {
        source: record.source,
        model: record.model ?? "",
        provider: record.provider ?? "",
        phase: record.phase ?? "",
        role: record.role ?? "",
        sessions: 0,
        passed: 0,
        failed: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        estimatedPromptTokens: 0,
        skillTokens: 0,
        materialTokens: 0,
        rawCost: 0,
      }
    current.sessions += 1
    if (record.passed === true) current.passed += 1
    if (record.passed === false) current.failed += 1
    current.inputTokens += num(record.usage.inputTokens)
    current.outputTokens += num(record.usage.outputTokens)
    current.reasoningTokens += num(record.usage.reasoningTokens)
    current.totalTokens += num(record.usage.totalTokens)
    current.estimatedPromptTokens += num(record.usage.estimatedPromptTokens)
    current.skillTokens += num(record.usage.skillTokens)
    current.materialTokens += num(record.usage.materialTokens)
    current.rawCost += num(record.cost.rawCost)
    byKey.set(key, current)
  }
  return [...byKey.values()].sort((a, b) => b.totalTokens - a.totalTokens)
}

type Rollup = {
  sessions: number
  passed: number
  failed: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  estimatedPromptTokens: number
  skillTokens: number
  materialTokens: number
  rawCost: number
}

function emptyRollup(): Rollup {
  return {
    sessions: 0,
    passed: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimatedPromptTokens: 0,
    skillTokens: 0,
    materialTokens: 0,
    rawCost: 0,
  }
}

function addRecordToRollup(rollup: Rollup, record: ResourceUsageRecord) {
  rollup.sessions += 1
  if (record.passed === true) rollup.passed += 1
  if (record.passed === false) rollup.failed += 1
  rollup.inputTokens += num(record.usage.inputTokens)
  rollup.outputTokens += num(record.usage.outputTokens)
  rollup.reasoningTokens += num(record.usage.reasoningTokens)
  rollup.totalTokens += num(record.usage.totalTokens)
  rollup.estimatedPromptTokens += num(record.usage.estimatedPromptTokens)
  rollup.skillTokens += num(record.usage.skillTokens)
  rollup.materialTokens += num(record.usage.materialTokens)
  rollup.rawCost += num(record.cost.rawCost)
}

function normalizedRole(record: ResourceUsageRecord) {
  const raw = `${record.role ?? ""} ${record.phase ?? ""} ${record.title ?? ""}`.toLowerCase()
  if (raw.includes("blank")) return "blank_eval"
  if (raw.includes("lead")) return "lead"
  if (raw.includes("review")) return "reviewer"
  if (raw.includes("worker")) return "worker"
  if (raw.includes("validate") || raw.includes("validator")) return "validator"
  if (raw.includes("repair")) return "repair"
  if (raw.includes("merge")) return "merger"
  if (raw.includes("execute") || raw.includes("executor")) return "executor"
  if (raw.includes("direct_chat")) return "direct_chat"
  return record.role || record.phase || "unknown"
}

async function readOptionalJson<T = any>(file: string | undefined): Promise<T | undefined> {
  if (!file || !(await pathExists(file))) return undefined
  try {
    return await readJsonFile<T>(file)
  } catch {
    return undefined
  }
}

async function loadBenchmarkMaps(benchmarkOut: string | undefined) {
  const result = {
    benchmarkOut: benchmarkOut ? path.resolve(benchmarkOut) : undefined,
    benchmarkRunID: benchmarkOut ? path.basename(path.resolve(benchmarkOut)) : undefined,
    taskLedgerPath: undefined as string | undefined,
    orchestratorStatePath: undefined as string | undefined,
    campaignToTask: new Map<string, any>(),
    taskByID: new Map<string, any>(),
  }
  if (!result.benchmarkOut) return result

  result.taskLedgerPath = path.join(result.benchmarkOut, "task-ledger.json")
  result.orchestratorStatePath = path.join(result.benchmarkOut, "orchestrator-state.json")
  const ledger = await readOptionalJson<any>(result.taskLedgerPath)
  if (ledger?.runID) result.benchmarkRunID = String(ledger.runID)
  if (ledger?.tasks && typeof ledger.tasks === "object") {
    for (const [taskID, task] of Object.entries<any>(ledger.tasks)) {
      const attempts = Array.isArray(task.attempts) ? task.attempts : []
      result.taskByID.set(taskID, {
        taskID,
        ledgerTask: task,
        runID: ledger.runID,
        generationID: ledger.currentGenerationID,
        historyPolicy: ledger.historyPolicy,
      })
      for (const attempt of attempts) {
        if (attempt?.campaignID) {
          result.campaignToTask.set(String(attempt.campaignID), {
            taskID,
            ledgerTask: task,
            attempt,
            runID: ledger.runID,
            generationID: attempt.generationID ?? ledger.currentGenerationID,
            historyPolicy: ledger.historyPolicy,
          })
        }
        if (attempt?.campaignDir) {
          result.campaignToTask.set(normalizePath(String(attempt.campaignDir)), {
            taskID,
            ledgerTask: task,
            attempt,
            runID: ledger.runID,
            generationID: attempt.generationID ?? ledger.currentGenerationID,
            historyPolicy: ledger.historyPolicy,
          })
        }
      }
      if (task.activeCampaignID) {
        result.campaignToTask.set(String(task.activeCampaignID), {
          taskID,
          ledgerTask: task,
          runID: ledger.runID,
          generationID: ledger.currentGenerationID,
          historyPolicy: ledger.historyPolicy,
        })
      }
      if (task.activeCampaignDir) {
        result.campaignToTask.set(normalizePath(String(task.activeCampaignDir)), {
          taskID,
          ledgerTask: task,
          runID: ledger.runID,
          generationID: ledger.currentGenerationID,
          historyPolicy: ledger.historyPolicy,
        })
      }
    }
  }

  const state = await readOptionalJson<any>(result.orchestratorStatePath)
  if (state?.runID) result.benchmarkRunID = String(state.runID)
  if (Array.isArray(state?.trainResults)) {
    for (const row of state.trainResults) {
      if (!row?.id) continue
      const existing = result.taskByID.get(String(row.id)) ?? { taskID: String(row.id) }
      existing.orchestratorRow = row
      result.taskByID.set(String(row.id), existing)
      if (row.campaignDir) result.campaignToTask.set(normalizePath(String(row.campaignDir)), existing)
      if (row.campaignDir) result.campaignToTask.set(path.basename(String(row.campaignDir)), existing)
    }
  }
  return result
}

function campaignDirForRecord(record: ResourceUsageRecord) {
  const stageDir = record.stageDir ?? record.refs?.stageDir
  if (!stageDir) return undefined
  const normalized = normalizePath(stageDir)
  const marker = "/rounds/"
  const index = normalized.indexOf(marker)
  return index >= 0 ? normalized.slice(0, index) : undefined
}

/**
 * A report bound to one benchmark must not absorb every historical campaign
 * below runtime-state. Campaign lineage is the authoritative ownership link.
 */
async function filterRecordsForBenchmark(
  records: ResourceUsageRecord[],
  maps: Awaited<ReturnType<typeof loadBenchmarkMaps>>,
) {
  if (!maps.benchmarkOut || !maps.benchmarkRunID) return records
  const campaignLineage = new Map<string, string | undefined>()
  const included: ResourceUsageRecord[] = []
  for (const record of records) {
    const normalizedBenchmarkOut = normalizePath(maps.benchmarkOut)
    const stageDir = normalizePath(record.stageDir ?? record.refs?.stageDir ?? "")
    if (
      normalizePath(record.benchmarkOutDir ?? "") === normalizedBenchmarkOut ||
      (stageDir && stageDir.startsWith(`${normalizedBenchmarkOut}/`))
    ) {
      included.push(record)
      continue
    }
    const campaignDir = campaignDirForRecord(record)
    if (campaignDir) {
      if (!campaignLineage.has(campaignDir)) {
        const campaign = await readOptionalJson<any>(path.join(campaignDir, "campaign.json"))
        campaignLineage.set(campaignDir, campaign?.runLineage?.benchmarkRunID ? String(campaign.runLineage.benchmarkRunID) : undefined)
      }
      const lineageRunID = campaignLineage.get(campaignDir)
      // A campaign's own lineage is stronger evidence than an inherited caseID.
      if (lineageRunID === maps.benchmarkRunID) {
        included.push(record)
        continue
      }
      // A present but foreign campaign lineage is conclusive; never fall back to caseID.
      if (lineageRunID) continue
    }
    const meta = findTaskMeta(record, maps)
    if (meta.runID && String(meta.runID) === maps.benchmarkRunID) included.push(record)
  }
  return included
}

function campaignLookupKeys(record: ResourceUsageRecord) {
  return [
    record.campaignID,
    record.stageDir,
    record.refs?.stageDir,
    record.stageDir ? normalizePath(record.stageDir).match(/long-task-campaigns\/([^/]+)/)?.[1] : undefined,
  ].filter((item): item is string => Boolean(item))
}

function findTaskMeta(record: ResourceUsageRecord, maps: Awaited<ReturnType<typeof loadBenchmarkMaps>>) {
  for (const key of campaignLookupKeys(record)) {
    const normalized = normalizePath(key)
    const direct = maps.campaignToTask.get(key) ?? maps.campaignToTask.get(normalized) ?? maps.campaignToTask.get(path.basename(key))
    if (direct) return direct
  }
  const fallbackID = record.caseID || record.campaignID || "unknown"
  return maps.taskByID.get(fallbackID) ?? { taskID: fallbackID }
}

async function buildTaskSummaries(records: ResourceUsageRecord[], benchmarkOut: string | undefined) {
  const maps = await loadBenchmarkMaps(benchmarkOut)
  const scopedRecords = await filterRecordsForBenchmark(records, maps)
  const byTask = new Map<string, any>()
  const byRound = new Map<string, any>()
  const byTaskRole = new Map<string, any>()
  const campaignStateCache = new Map<string, any>()

  async function campaignStateFor(campaignDir: string | undefined) {
    if (!campaignDir) return undefined
    const normalized = normalizePath(campaignDir)
    if (campaignStateCache.has(normalized)) return campaignStateCache.get(normalized)
    const state = await readOptionalJson<any>(path.join(campaignDir, "campaign.json"))
    campaignStateCache.set(normalized, state)
    return state
  }

  for (const record of scopedRecords) {
    const meta = findTaskMeta(record, maps)
    const campaignDir =
      meta.ledgerTask?.activeCampaignDir ||
      meta.attempt?.campaignDir ||
      meta.orchestratorRow?.campaignDir ||
      record.stageDir?.split("/rounds/")[0] ||
      record.refs?.stageDir?.split("/rounds/")[0]
    const campaignState = await campaignStateFor(campaignDir)
    const taskID = meta.taskID || campaignState?.runLineage?.taskID || record.caseID || record.campaignID || "unknown"
    const campaignID = record.campaignID || campaignState?.id || meta.ledgerTask?.activeCampaignID || meta.attempt?.campaignID || ""
    const taskKey = `${taskID}\u001f${campaignID}`
    const role = normalizedRole(record)
    const roundNumber = record.roundNumber ?? 0

    const task =
      byTask.get(taskKey) ??
      {
        schema: "auto-evolve-resource-task-summary/v1",
        taskID,
        caseID: record.caseID || taskID,
        campaignID,
        campaignDir: normalizePath(campaignDir || ""),
        benchmarkRunID: meta.runID || campaignState?.runLineage?.benchmarkRunID || "",
        generationID: meta.generationID || campaignState?.runLineage?.generationID || "",
        attemptID: meta.attempt?.attemptID || campaignState?.runLineage?.attemptID || "",
        historyPolicy: meta.historyPolicy || campaignState?.runLineage?.historyPolicy || "",
        taskStatus: meta.ledgerTask?.status || meta.orchestratorRow?.status || "",
        campaignStatus: campaignState?.status || "",
        verified: campaignState?.status === "verified_success" || meta.ledgerTask?.status === "verified_success",
        roundCount: campaignState?.currentRound ?? 0,
        maxRounds: campaignState?.maxRounds ?? "",
        modelRequested: campaignState?.runLineage?.modelRequested ?? "",
        modelResolved: campaignState?.runLineage?.modelResolved ?? "",
        totals: emptyRollup(),
        byRole: {} as Record<string, Rollup>,
        byPhase: {} as Record<string, Rollup>,
        failure: {
          kind: campaignState?.lastGateFailureKind ?? campaignState?.recovery?.action ?? "",
          summary: campaignState?.lastGateFailureSummary ?? campaignState?.lastSummary ?? "",
          lastFinalAcceptancePassed: campaignState?.lastFinalAcceptancePassed ?? "",
          lastFinalAcceptanceResultPath: campaignState?.lastFinalAcceptanceResultPath ?? "",
          recoveryAction: campaignState?.recovery?.action ?? "",
          recoveryReason: campaignState?.recovery?.reason ?? "",
        },
        refs: {
          campaignJson: campaignDir ? normalizePath(path.join(campaignDir, "campaign.json")) : "",
          taskLedger: maps.taskLedgerPath ? normalizePath(maps.taskLedgerPath) : "",
          orchestratorState: maps.orchestratorStatePath ? normalizePath(maps.orchestratorStatePath) : "",
          pendingExpertPackage: campaignDir ? normalizePath(path.join(campaignDir, "pending-expert-package", "current")) : "",
        },
      }
    addRecordToRollup(task.totals, record)
    task.byRole[role] ??= emptyRollup()
    addRecordToRollup(task.byRole[role], record)
    const phase = record.phase || "unknown"
    task.byPhase[phase] ??= emptyRollup()
    addRecordToRollup(task.byPhase[phase], record)
    byTask.set(taskKey, task)

    const roundKey = `${taskKey}\u001f${roundNumber}`
    const round =
      byRound.get(roundKey) ??
      {
        taskID,
        campaignID,
        roundNumber,
        roundID: roundNumber ? `round-${String(roundNumber).padStart(3, "0")}` : "",
        finalStatus: "",
        gateFailureKind: "",
        finalAcceptancePassed: "",
        totals: emptyRollup(),
        byRole: {} as Record<string, Rollup>,
        refs: {
          roundSummaryPath:
            campaignDir && roundNumber
              ? normalizePath(path.join(campaignDir, "rounds", `round-${String(roundNumber).padStart(3, "0")}`, "round-summary.md"))
              : "",
          runTracePath:
            campaignDir && roundNumber
              ? normalizePath(path.join(campaignDir, "rounds", `round-${String(roundNumber).padStart(3, "0")}`, "run-trace.json"))
              : "",
          finalAcceptanceResultPath:
            campaignDir && roundNumber
              ? normalizePath(path.join(campaignDir, "rounds", `round-${String(roundNumber).padStart(3, "0")}`, "final-acceptance", "result.json"))
              : "",
        },
      }
    addRecordToRollup(round.totals, record)
    round.byRole[role] ??= emptyRollup()
    addRecordToRollup(round.byRole[role], record)
    byRound.set(roundKey, round)

    const taskRoleKey = `${taskKey}\u001f${role}`
    const taskRole =
      byTaskRole.get(taskRoleKey) ??
      {
        taskID,
        campaignID,
        role,
        totals: emptyRollup(),
      }
    addRecordToRollup(taskRole.totals, record)
    byTaskRole.set(taskRoleKey, taskRole)
  }

  return {
    tasks: [...byTask.values()].sort((a, b) => b.totals.totalTokens - a.totals.totalTokens),
    rounds: [...byRound.values()].sort((a, b) => `${a.taskID}:${a.roundNumber}`.localeCompare(`${b.taskID}:${b.roundNumber}`)),
    taskRoles: [...byTaskRole.values()].sort((a, b) => `${a.taskID}:${a.role}`.localeCompare(`${b.taskID}:${b.role}`)),
  }
}

function usageCsv(records: ResourceUsageRecord[]) {
  const headers = [
    "recordID",
    "createdAt",
    "source",
    "caseID",
    "campaignID",
    "roundNumber",
    "phase",
    "role",
    "title",
    "model",
    "provider",
    "resolvedModel",
    "status",
    "passed",
    "score",
    "usageSource",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
    "estimatedPromptTokens",
    "skillTokens",
    "materialTokens",
    "rawCost",
    "priceStatus",
    "stageDir",
  ]
  const rows = [headers.join(",")]
  for (const record of records) {
    rows.push(
      headers
        .map((header) => {
          const value =
            header in record
              ? (record as any)[header]
              : header in record.usage
                ? (record.usage as any)[header]
                : header in record.cost
                  ? (record.cost as any)[header]
                  : ""
          return csvCell(value)
        })
        .join(","),
    )
  }
  return rows.join("\n") + "\n"
}

function aggregateCsv(rows: any[]) {
  const headers = [
    "source",
    "model",
    "provider",
    "phase",
    "role",
    "sessions",
    "passed",
    "failed",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
    "estimatedPromptTokens",
    "skillTokens",
    "materialTokens",
    "rawCost",
  ]
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\n") + "\n"
}

function taskSummaryCsv(tasks: any[]) {
  const roles = ["executor", "validator", "worker", "lead", "reviewer", "blank_eval", "repair", "merger", "direct_chat"]
  const headers = [
    "taskID",
    "caseID",
    "campaignID",
    "taskStatus",
    "campaignStatus",
    "verified",
    "roundCount",
    "maxRounds",
    "sessions",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
    "rawCost",
    ...roles.map((role) => `${role}Tokens`),
    "failureKind",
    "failureSummary",
    "campaignDir",
  ]
  const rows = [headers.join(",")]
  for (const task of tasks) {
    rows.push(
      [
        task.taskID,
        task.caseID,
        task.campaignID,
        task.taskStatus,
        task.campaignStatus,
        task.verified,
        task.roundCount,
        task.maxRounds,
        task.totals.sessions,
        task.totals.inputTokens,
        task.totals.outputTokens,
        task.totals.reasoningTokens,
        task.totals.totalTokens,
        task.totals.rawCost,
        ...roles.map((role) => task.byRole?.[role]?.totalTokens ?? 0),
        task.failure?.kind ?? "",
        task.failure?.summary ?? "",
        task.campaignDir,
      ].map(csvCell).join(","),
    )
  }
  return rows.join("\n") + "\n"
}

function roundSummaryCsv(rounds: any[]) {
  const roles = ["executor", "validator", "worker", "lead", "reviewer", "blank_eval", "repair", "merger", "direct_chat"]
  const headers = [
    "taskID",
    "campaignID",
    "roundNumber",
    "roundID",
    "sessions",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
    "rawCost",
    ...roles.map((role) => `${role}Tokens`),
    "roundSummaryPath",
    "runTracePath",
    "finalAcceptanceResultPath",
  ]
  return [
    headers.join(","),
    ...rounds.map((round) =>
      [
        round.taskID,
        round.campaignID,
        round.roundNumber,
        round.roundID,
        round.totals.sessions,
        round.totals.inputTokens,
        round.totals.outputTokens,
        round.totals.reasoningTokens,
        round.totals.totalTokens,
        round.totals.rawCost,
        ...roles.map((role) => round.byRole?.[role]?.totalTokens ?? 0),
        round.refs?.roundSummaryPath ?? "",
        round.refs?.runTracePath ?? "",
        round.refs?.finalAcceptanceResultPath ?? "",
      ].map(csvCell).join(","),
    ),
  ].join("\n") + "\n"
}

function taskRoleSummaryCsv(taskRoles: any[]) {
  const headers = ["taskID", "campaignID", "role", "sessions", "inputTokens", "outputTokens", "reasoningTokens", "totalTokens", "rawCost"]
  return [
    headers.join(","),
    ...taskRoles.map((row) =>
      [
        row.taskID,
        row.campaignID,
        row.role,
        row.totals.sessions,
        row.totals.inputTokens,
        row.totals.outputTokens,
        row.totals.reasoningTokens,
        row.totals.totalTokens,
        row.totals.rawCost,
      ].map(csvCell).join(","),
    ),
  ].join("\n") + "\n"
}

function taskSummaryMarkdown(taskSummaries: { tasks: any[]; rounds: any[]; taskRoles: any[] }, createdAt: string, benchmarkOut: string | undefined) {
  const totals = taskSummaries.tasks.reduce(
    (sum, task) => {
      sum.sessions += num(task.totals.sessions)
      sum.inputTokens += num(task.totals.inputTokens)
      sum.outputTokens += num(task.totals.outputTokens)
      sum.reasoningTokens += num(task.totals.reasoningTokens)
      sum.totalTokens += num(task.totals.totalTokens)
      sum.rawCost += num(task.totals.rawCost)
      if (task.verified) sum.verified += 1
      return sum
    },
    { sessions: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, rawCost: 0, verified: 0 },
  )
  const lines = [
    "# Resource Task Summary",
    "",
    `- Created: ${createdAt}`,
    `- Benchmark out: ${benchmarkOut ? normalizePath(path.resolve(benchmarkOut)) : ""}`,
    `- Tasks: ${taskSummaries.tasks.length}`,
    `- Verified tasks: ${totals.verified}`,
    `- Rounds with usage: ${taskSummaries.rounds.length}`,
    `- Role rows: ${taskSummaries.taskRoles.length}`,
    `- Sessions: ${totals.sessions}`,
    `- Input tokens: ${totals.inputTokens}`,
    `- Output tokens: ${totals.outputTokens}`,
    `- Reasoning tokens: ${totals.reasoningTokens}`,
    `- Total tokens: ${totals.totalTokens}`,
    `- Raw provider cost: ${totals.rawCost}`,
    "",
    "## Task Rows",
    "",
    "| taskID | campaignID | status | verified | rounds | sessions | totalTokens | failure |",
    "|---|---|---|---:|---:|---:|---:|---|",
    ...taskSummaries.tasks.map(
      (task) =>
        `| ${task.taskID} | ${task.campaignID} | ${task.campaignStatus || task.taskStatus} | ${task.verified} | ${task.roundCount} | ${task.totals.sessions} | ${task.totals.totalTokens} | ${String(task.failure?.kind ?? "").replace(/\|/g, "/")} |`,
    ),
    "",
  ]
  return lines.join("\n")
}

const cwd = path.resolve(import.meta.dir, "..", "..")
const scanRoot = path.resolve(parseArg("--root") ?? runtimePath(cwd))
const outDir = path.resolve(parseArg("--out-dir") ?? runtimePath(cwd, "resource-audit"))
const benchmarkOut = parseArg("--benchmark-out")
await ensureDirectory(outDir)

const files = await collectFiles(scanRoot, "resource-usage.json")
const records: ResourceUsageRecord[] = []
const seen = new Set<string>()
const warnings: string[] = []
for (const file of files) {
  try {
    const record = await readJsonFile<ResourceUsageRecord>(file)
    if (record?.schema !== "auto-evolve-resource-usage/v1") continue
    if (seen.has(record.recordID)) continue
    seen.add(record.recordID)
    records.push(record)
  } catch (error) {
    warnings.push(`${normalizePath(file)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const benchmarkMaps = await loadBenchmarkMaps(benchmarkOut)
const scopedRecords = await filterRecordsForBenchmark(records, benchmarkMaps)
const byGroup = aggregate(scopedRecords)
const taskSummaries = await buildTaskSummaries(scopedRecords, benchmarkOut)
const summary = {
  schema: "auto-evolve-resource-cost-report/v1",
  createdAt: new Date().toISOString(),
  scanRoot: normalizePath(scanRoot),
  recordCount: scopedRecords.length,
  warningCount: warnings.length,
  totals: {
    inputTokens: scopedRecords.reduce((sum, item) => sum + num(item.usage.inputTokens), 0),
    outputTokens: scopedRecords.reduce((sum, item) => sum + num(item.usage.outputTokens), 0),
    reasoningTokens: scopedRecords.reduce((sum, item) => sum + num(item.usage.reasoningTokens), 0),
    totalTokens: scopedRecords.reduce((sum, item) => sum + num(item.usage.totalTokens), 0),
    estimatedPromptTokens: scopedRecords.reduce((sum, item) => sum + num(item.usage.estimatedPromptTokens), 0),
    rawCost: scopedRecords.reduce((sum, item) => sum + num(item.cost.rawCost), 0),
  },
  byGroup,
  taskSummary: {
    taskCount: taskSummaries.tasks.length,
    roundCount: taskSummaries.rounds.length,
    taskRoleCount: taskSummaries.taskRoles.length,
  },
  warnings,
}

await writeJsonFile(path.join(outDir, "aggregate-summary.json"), summary)
await writeTextFile(path.join(outDir, "usage-records.csv"), usageCsv(scopedRecords))
await writeTextFile(path.join(outDir, "aggregate-by-group.csv"), aggregateCsv(byGroup))
await writeJsonFile(path.join(outDir, "task-summary.json"), {
  schema: "auto-evolve-resource-task-summary-list/v1",
  createdAt: summary.createdAt,
  benchmarkOut: benchmarkOut ? normalizePath(path.resolve(benchmarkOut)) : "",
  tasks: taskSummaries.tasks,
  rounds: taskSummaries.rounds,
  taskRoles: taskSummaries.taskRoles,
})
await writeTextFile(path.join(outDir, "task-summary.csv"), taskSummaryCsv(taskSummaries.tasks))
await writeTextFile(path.join(outDir, "round-summary.csv"), roundSummaryCsv(taskSummaries.rounds))
await writeTextFile(path.join(outDir, "task-role-summary.csv"), taskRoleSummaryCsv(taskSummaries.taskRoles))
await writeTextFile(path.join(outDir, "task-summary.md"), taskSummaryMarkdown(taskSummaries, summary.createdAt, benchmarkOut))

if (benchmarkOut) {
  const benchmarkOutDir = path.resolve(benchmarkOut)
  await ensureDirectory(benchmarkOutDir)
  await writeJsonFile(path.join(benchmarkOutDir, "resource-task-summary.json"), {
    schema: "auto-evolve-resource-task-summary-list/v1",
    createdAt: summary.createdAt,
    benchmarkOut: normalizePath(benchmarkOutDir),
    tasks: taskSummaries.tasks,
    rounds: taskSummaries.rounds,
    taskRoles: taskSummaries.taskRoles,
  })
  await writeTextFile(path.join(benchmarkOutDir, "resource-task-summary.md"), taskSummaryMarkdown(taskSummaries, summary.createdAt, benchmarkOutDir))
  await writeTextFile(path.join(benchmarkOutDir, "resource-task-summary.csv"), taskSummaryCsv(taskSummaries.tasks))
  await writeTextFile(path.join(benchmarkOutDir, "resource-round-summary.csv"), roundSummaryCsv(taskSummaries.rounds))
}

const md = [
  "# Resource Cost Report",
  "",
  `- Created: ${summary.createdAt}`,
  `- Scan root: ${summary.scanRoot}`,
  `- Records: ${summary.recordCount}`,
  `- Warnings: ${summary.warningCount}`,
  `- Input tokens: ${summary.totals.inputTokens}`,
  `- Output tokens: ${summary.totals.outputTokens}`,
  `- Reasoning tokens: ${summary.totals.reasoningTokens}`,
  `- Total tokens: ${summary.totals.totalTokens}`,
  `- Estimated prompt tokens: ${summary.totals.estimatedPromptTokens}`,
  `- Raw provider cost: ${summary.totals.rawCost}`,
  `- Task summaries: ${summary.taskSummary.taskCount}`,
  `- Round summaries: ${summary.taskSummary.roundCount}`,
  "",
  "## Top Groups",
  "",
  "| source | model | phase | role | sessions | totalTokens |",
  "|---|---|---|---:|---:|---:|",
  ...byGroup.slice(0, 20).map((row) => `| ${row.source} | ${row.model} | ${row.phase} | ${row.role} | ${row.sessions} | ${row.totalTokens} |`),
  "",
]
if (warnings.length) {
  md.push("## Warnings", "")
  for (const warning of warnings.slice(0, 100)) md.push(`- ${warning}`)
}
md.push(
  "",
  "## Top Tasks",
  "",
  "| taskID | campaignID | status | verified | rounds | sessions | totalTokens |",
  "|---|---|---|---:|---:|---:|---:|",
  ...taskSummaries.tasks
    .slice(0, 20)
    .map((task) => `| ${task.taskID} | ${task.campaignID} | ${task.campaignStatus || task.taskStatus} | ${task.verified} | ${task.roundCount} | ${task.totals.sessions} | ${task.totals.totalTokens} |`),
  "",
)
await writeTextFile(path.join(outDir, "aggregate-summary.md"), md.join("\n"))

if (flag("--json")) {
  console.log(JSON.stringify({ outDir: normalizePath(outDir), records: records.length, warnings: warnings.length }))
} else {
  console.log(`resource-cost-report records=${records.length} warnings=${warnings.length} out=${normalizePath(outDir)}`)
}
