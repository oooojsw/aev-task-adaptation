import path from "node:path"
import { rm } from "node:fs/promises"
import { ensureDirectory, pathExists, readJsonFile, writeJsonFile } from "../orchestrator/fs"
import { summarizeDirectChatUsage, summarizeOpencodeUsage } from "../orchestrator/resource-audit/usage"
import { recordDirectChatResourceUsage, recordOpencodeResourceUsage } from "../orchestrator/resource-audit/recorder"
import type { OpencodeTaskRun } from "../orchestrator/opencode"
import type { DirectChatCaseResult, DirectChatPromptAudit } from "../orchestrator/direct-chat/contract"

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

const cwd = path.resolve(import.meta.dir, "..", "..")
const tmpRoot = path.join(cwd, "auto-evolve", ".tmp-resource-audit-smoke")
const benchmarkOut = path.join(tmpRoot, "benchmark-out")

await rm(tmpRoot, { recursive: true, force: true })
await ensureDirectory(tmpRoot)

const opencodeEvents = [
  { type: "session", sessionID: "sess-smoke" },
  {
    type: "step_finish",
    sessionID: "sess-smoke",
    part: {
      cost: 0.12,
      tokens: { input: 100, output: 20, reasoning: 5, total: 125 },
    },
  },
  {
    type: "step_finish",
    sessionID: "sess-smoke",
    part: {
      cost: 0.08,
      tokens: { prompt_tokens: 50, completion_tokens: 10 },
    },
  },
] as any

const opencodeSummary = summarizeOpencodeUsage(opencodeEvents)
assert(opencodeSummary.usage.inputTokens === 150, "OpenCode input token aggregation failed")
assert(opencodeSummary.usage.outputTokens === 30, "OpenCode output token aggregation failed")
assert(opencodeSummary.usage.reasoningTokens === 5, "OpenCode reasoning token aggregation failed")
assert(opencodeSummary.usage.totalTokens === 185, "OpenCode total token aggregation failed")
assert(opencodeSummary.rawCost === 0.2, "OpenCode raw cost aggregation failed")

const stageDir = path.join(tmpRoot, "long-task-campaigns", "campaign-smoke", "rounds", "round-003", "execute")
const campaignDir = path.join(tmpRoot, "long-task-campaigns", "campaign-smoke")
await writeJsonFile(path.join(campaignDir, "campaign.json"), {
  id: "campaign-smoke",
  title: "Smoke Campaign",
  mode: "graph_iterative",
  baseSpecPath: "spec.json",
  maxRounds: 7,
  currentRound: 3,
  status: "verified_success",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastFinalAcceptancePassed: true,
  lastSummary: "smoke passed",
  runLineage: {
    benchmarkRunID: "run-smoke",
    generationID: "generation-001",
    taskID: "case-smoke",
    attemptID: "attempt-001",
    historyPolicy: "fresh-non-verified",
  },
})
await writeJsonFile(path.join(benchmarkOut, "task-ledger.json"), {
  schema: "auto-evolve/benchmark-history/v1",
  runID: "run-smoke",
  currentGenerationID: "generation-001",
  historyPolicy: "fresh-non-verified",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  fingerprint: { taskPackRoot: "smoke" },
  tasks: {
    "case-smoke": {
      id: "case-smoke",
      status: "verified_success",
      activeAttemptID: "attempt-001",
      activeCampaignID: "campaign-smoke",
      activeCampaignDir: campaignDir,
      allowResume: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: [
        {
          attemptID: "attempt-001",
          campaignID: "campaign-smoke",
          campaignDir,
          generationID: "generation-001",
          status: "verified_success",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
  },
})
await writeJsonFile(path.join(benchmarkOut, "orchestrator-state.json"), {
  trainResults: [
    {
      id: "case-smoke",
      status: "verified_success",
      verified: true,
      campaignDir,
    },
  ],
})
const taskRun: OpencodeTaskRun = {
  title: "Long Task Execute smoke",
  prompt: "smoke",
  selectedModel: "provider/model-smoke",
  selectedAgent: "builder",
  selectedVariant: undefined,
  referencedPaths: [],
  attachedFiles: [],
  promptInlineFiles: [],
  permissionReadPaths: [],
  permissionEditPaths: [],
  selectedModelResolution: {
    requestedModel: "provider/model-smoke",
    providerID: "provider",
    modelID: "model-smoke",
    providerSource: "runtime-config",
  },
  result: {
    sessionID: "sess-smoke",
    exitCode: 0,
    finishReason: undefined,
    stdout: "",
    stderr: "",
    events: opencodeEvents,
    responseText: "ok",
    toolFailures: [],
  },
}

await recordOpencodeResourceUsage({
  cwd,
  taskRun,
  taskInput: {
    cwd,
    config: {} as any,
    title: taskRun.title,
    prompt: taskRun.prompt,
    live: {
      stageDir,
      phase: "long_task_execute",
      caseID: "case-smoke",
    },
  },
})
assert(await pathExists(path.join(stageDir, "resource-usage.json")), "OpenCode stage resource-usage.json missing")
const opencodeRecord = await readJsonFile<any>(path.join(stageDir, "resource-usage.json"))
assert(opencodeRecord.usage.inputTokens === 150, "OpenCode record input tokens mismatch")
assert(opencodeRecord.roundNumber === 3, "OpenCode record round inference mismatch")

const promptAudit: DirectChatPromptAudit = {
  schema: "direct-chat-prompt-audit/v1",
  caseID: "UID-SMOKE",
  modelID: "mock-model",
  promptBudgetTokens: 4096,
  estimatedPromptTokens: 320,
  skill: {
    originalTokens: 100,
    includedTokens: 80,
    truncated: false,
  },
  materials: [
    {
      id: "m1",
      title: "material",
      type: "text",
      originalTokens: 250,
      includedTokens: 200,
      truncated: false,
    },
  ],
  warnings: [],
}

const directSummary = summarizeDirectChatUsage({
  usage: { inputTokens: 330, outputTokens: 15, reasoningTokens: 7, totalTokens: 352 },
  promptAudit,
})
assert(directSummary.usage.estimatedPromptTokens === 320, "Direct Chat estimated prompt tokens missing")
assert(directSummary.usage.skillTokens === 80, "Direct Chat skill tokens missing")
assert(directSummary.usage.materialTokens === 200, "Direct Chat material tokens missing")

const caseDir = path.join(tmpRoot, "direct-chat", "results", "mock-model", "UID-SMOKE")
await ensureDirectory(caseDir)
const result: DirectChatCaseResult = {
  schema: "direct-chat-result/v1",
  caseID: "UID-SMOKE",
  modelID: "mock-model",
  provider: "mock",
  passed: true,
  score: 1,
  answer: "42",
  rawResponsePath: path.join(caseDir, "response.txt"),
  usage: { inputTokens: 330, outputTokens: 15, reasoningTokens: 7, totalTokens: 352 },
  latencyMs: 123,
  attempts: 1,
  error: null,
  errorCategory: "none",
  skillMode: "with-skill",
  skillTier: "full",
  skillHash: "hash-smoke",
}
await writeJsonFile(path.join(caseDir, "prompt-audit.json"), promptAudit)
await recordDirectChatResourceUsage({
  cwd,
  outDir: path.join(tmpRoot, "direct-chat"),
  caseDir,
  result,
  promptAudit,
  promptAuditPath: path.join(caseDir, "prompt-audit.json"),
})
assert(await pathExists(path.join(caseDir, "resource-usage.json")), "Direct Chat resource-usage.json missing")
const directRecord = await readJsonFile<any>(path.join(caseDir, "resource-usage.json"))
assert(directRecord.usage.inputTokens === 330, "Direct Chat record input tokens mismatch")
assert(directRecord.usage.materialTokens === 200, "Direct Chat record material tokens mismatch")

const reportDir = path.join(tmpRoot, "report")
const reportProc = Bun.spawn(
  [
    "bun",
    "run",
    path.join(cwd, "auto-evolve", "scripts", "update-resource-cost-report.ts"),
    "--root",
    tmpRoot,
    "--benchmark-out",
    benchmarkOut,
    "--out-dir",
    reportDir,
    "--json",
  ],
  {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  },
)
const reportStdout = await new Response(reportProc.stdout).text()
const reportStderr = await new Response(reportProc.stderr).text()
const reportCode = await reportProc.exited
assert(reportCode === 0, `resource cost report failed: ${reportStderr || reportStdout}`)
const taskSummary = await readJsonFile<any>(path.join(reportDir, "task-summary.json"))
assert(Array.isArray(taskSummary.tasks), "Task summary tasks missing")
const smokeTask = taskSummary.tasks.find((task: any) => task.taskID === "case-smoke")
assert(smokeTask, "Smoke task summary missing")
assert(smokeTask.totals.totalTokens === 185, "Smoke task total tokens mismatch")
assert(smokeTask.byRole.executor.totalTokens === 185, "Smoke task executor tokens mismatch")
assert(taskSummary.rounds.some((round: any) => round.taskID === "case-smoke" && round.roundNumber === 3), "Smoke round summary missing")
assert(await pathExists(path.join(reportDir, "task-summary.md")), "task-summary.md missing")
assert(await pathExists(path.join(reportDir, "task-summary.csv")), "task-summary.csv missing")
assert(await pathExists(path.join(reportDir, "round-summary.csv")), "round-summary.csv missing")
assert(await pathExists(path.join(reportDir, "task-role-summary.csv")), "task-role-summary.csv missing")
assert(await pathExists(path.join(benchmarkOut, "resource-task-summary.json")), "benchmark resource-task-summary.json missing")
assert(await pathExists(path.join(benchmarkOut, "resource-task-summary.md")), "benchmark resource-task-summary.md missing")
assert(await pathExists(path.join(benchmarkOut, "resource-task-summary.csv")), "benchmark resource-task-summary.csv missing")
assert(await pathExists(path.join(benchmarkOut, "resource-round-summary.csv")), "benchmark resource-round-summary.csv missing")

console.log("resource-audit smoke passed")
