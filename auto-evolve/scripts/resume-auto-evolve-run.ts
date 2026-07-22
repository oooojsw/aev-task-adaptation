import path from "node:path"
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises"

type Args = Record<string, string | boolean>

type Candidate = {
  runID: string
  outDir: string
  taskPackRoot?: string
  trainSplit?: string
  label?: string
  updatedAt?: string
  mtimeMs: number
  verified: number
  running: number
  recovery: number
  failed: number
  queued: number
  total: number
  phase?: string
  hasStopRequest: boolean
  synthetic: boolean
}

type LineageAudit = {
  schema: "auto-evolve/resume-lineage-audit/v1"
  createdAt: string
  selection: string
  selected: ReturnType<typeof printableCandidate>
  candidates: Array<ReturnType<typeof printableCandidate>>
  taskLedger?: {
    exists: boolean
    runID?: string
    currentGenerationID?: string
    historyPolicy?: string
    taskCount?: number
    statuses?: Record<string, number>
    activeAttempts?: Array<{
      taskID: string
      status: string
      activeAttemptID?: string
      activeCampaignID?: string
      activeCampaignDir?: string
      allowResume?: boolean
    }>
  }
  warnings: string[]
}

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const autoRoot = path.join(repoRoot, "auto-evolve")
const benchmarkRunsRoot = path.join(autoRoot, "runtime-state", "benchmark-runs")

function usage() {
  return [
    "Usage:",
    "  bun run auto-evolve/scripts/resume-auto-evolve-run.ts --list [--task-pack spreadsheetbench]",
    "  bun run auto-evolve/scripts/resume-auto-evolve-run.ts --dry-run --auto",
    "  bun run auto-evolve/scripts/resume-auto-evolve-run.ts --auto",
    "  bun run auto-evolve/scripts/resume-auto-evolve-run.ts --out <benchmark-run-dir>",
    "  bun run auto-evolve/scripts/resume-auto-evolve-run.ts --run-id <run-id>",
    "  bun run auto-evolve/scripts/resume-auto-evolve-run.ts --list --include-synthetic",
    "",
    "Safety:",
    "  - Never creates a new --out directory.",
    "  - Archives STOP_REQUESTED.json before launch.",
    "  - Moves old benchmark-leases into stop-reports/cleared-benchmark-leases.",
    "  - Writes and runs a file-based launcher to avoid Windows path splitting.",
    "  - Filters dry-run/smoke fixture runs unless --include-synthetic is set.",
  ].join("\n")
}

function parseArgs(argv: string[]) {
  const result: Args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith("--")) continue
    const key = item.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith("--")) {
      result[key] = true
    } else {
      result[key] = next
      i += 1
    }
  }
  return result
}

function asString(value: string | boolean | undefined) {
  return typeof value === "string" ? value : undefined
}

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function normalizeSearch(input: string | undefined) {
  return normalizeSlash(input || "").toLowerCase()
}

async function pathExists(file: string) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

async function readJson<T = any>(file: string): Promise<T | undefined> {
  if (!(await pathExists(file))) return undefined
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) as T
  } catch {
    return undefined
  }
}

function countStatuses(rows: any[] | undefined) {
  const list = Array.isArray(rows) ? rows : []
  const isVerified = (row: any) => row?.status === "verified_success" || row?.verified === true
  return {
    verified: list.filter(isVerified).length,
    running: list.filter((row) => row?.status === "running" || row?.status === "bootstrapping" || row?.status === "watch_live").length,
    recovery: list.filter((row) => row?.status === "recovery_pending").length,
    failed: list.filter((row) => row?.status === "failed" || row?.status === "round_limit_reached").length,
    queued: list.filter((row) => row?.status === "queued").length,
    total: list.length,
  }
}

async function candidateFromDir(outDir: string): Promise<Candidate | undefined> {
  const statePath = path.join(outDir, "orchestrator-state.json")
  const manifestPath = path.join(outDir, "run-manifest.json")
  if (!(await pathExists(statePath)) && !(await pathExists(manifestPath))) return undefined
  const state = await readJson<any>(statePath)
  const manifest = await readJson<any>(manifestPath)
  const plan = await readJson<any>(path.join(outDir, "benchmark-plan.json"))
  const info = await stat(outDir)
  const counts = countStatuses(state?.trainResults)
  const config = plan?.config || state?.config || {}
  return {
    runID: String(state?.runID || manifest?.runID || path.basename(outDir)),
    outDir,
    taskPackRoot: config.taskPackRoot || manifest?.taskPackRoot,
    trainSplit: config.trainSplit || manifest?.splitPath,
    label: config.label,
    updatedAt: state?.updatedAt || manifest?.updatedAt,
    mtimeMs: info.mtimeMs,
    phase: state?.phase,
    hasStopRequest: await pathExists(path.join(outDir, "STOP_REQUESTED.json")),
    synthetic: isSyntheticRunID(String(state?.runID || manifest?.runID || path.basename(outDir))),
    ...counts,
  }
}

function isSyntheticRunID(runID: string) {
  const normalized = runID.toLowerCase()
  return (
    normalized.startsWith("dryrun") ||
    normalized.startsWith("_dry-run") ||
    normalized.startsWith("tmp-smoke") ||
    normalized.includes("smoke-resume-auto-evolve-run")
  )
}

async function collectCandidates() {
  const entries = await readdir(benchmarkRunsRoot, { withFileTypes: true }).catch(() => [])
  const rows: Candidate[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = await candidateFromDir(path.join(benchmarkRunsRoot, entry.name))
    if (candidate) rows.push(candidate)
  }
  return rows
}

function matchesTaskPack(candidate: Candidate, taskPackFilter?: string) {
  if (!taskPackFilter) return true
  const needle = normalizeSearch(taskPackFilter)
  const hay = [candidate.taskPackRoot, candidate.label, candidate.runID, path.basename(candidate.taskPackRoot || "")]
    .map((item) => normalizeSearch(item))
    .join("\n")
  return hay.includes(needle)
}

function sortCandidates(rows: Candidate[]) {
  return [...rows].sort((a, b) => {
    if (b.verified !== a.verified) return b.verified - a.verified
    const bUnfinished = b.running + b.recovery + b.queued
    const aUnfinished = a.running + a.recovery + a.queued
    if (bUnfinished !== aUnfinished) return bUnfinished - aUnfinished
    return b.mtimeMs - a.mtimeMs
  })
}

async function selectCandidate(args: Args) {
  const outArg = asString(args.out)
  if (outArg) {
    const outDir = path.resolve(outArg)
    const candidate = await candidateFromDir(outDir)
    if (!candidate) throw new Error(`No benchmark run state found at --out: ${outDir}`)
    return { candidate, candidates: [candidate], selection: "explicit-out" }
  }
  const runID = asString(args["run-id"])
  const taskPack = asString(args["task-pack"])
  const includeSynthetic = Boolean(args["include-synthetic"])
  let rows = await collectCandidates()
  if (runID) rows = rows.filter((row) => row.runID === runID || path.basename(row.outDir) === runID)
  if (!runID && !outArg && !includeSynthetic) rows = rows.filter((row) => !row.synthetic)
  rows = rows.filter((row) => matchesTaskPack(row, taskPack))
  if (runID && rows.length !== 1) throw new Error(`Expected exactly one run for --run-id ${runID}, got ${rows.length}.`)
  const sorted = sortCandidates(rows)
  const candidate = sorted[0]
  if (!candidate) throw new Error("No matching benchmark run found.")
  return { candidate, candidates: sorted, selection: runID ? "explicit-run-id" : taskPack ? "task-pack-highest-progress" : "auto-highest-progress" }
}

function pushValue(args: string[], name: string, value: unknown) {
  if (value === undefined || value === null || value === "") return
  args.push(name, String(value))
}

function pushFlag(args: string[], name: string, enabled: unknown) {
  if (enabled === true) args.push(name)
}

function buildBenchmarkArgs(outDir: string, config: any, manifest: any) {
  const taskPackRoot = config.taskPackRoot || manifest?.taskPackRoot
  const trainSplit = config.trainSplit || manifest?.splitPath
  if (!taskPackRoot) throw new Error("Cannot resume: missing taskPackRoot in benchmark-plan/config or run-manifest.")
  if (!trainSplit) throw new Error("Cannot resume: missing trainSplit/splitPath in benchmark-plan/config or run-manifest.")
  const args = ["run", "auto-evolve/scripts/run-benchmark-orchestrator.ts"]
  pushValue(args, "--label", config.label || path.basename(outDir))
  pushValue(args, "--task-pack-root", taskPackRoot)
  pushValue(args, "--train-split", trainSplit)
  pushValue(args, "--test-split", config.testSplit)
  pushValue(args, "--out", outDir)
  pushValue(args, "--mode", config.mode || "full-pipeline")
  pushValue(args, "--stop-after", config.stopAfter)
  const trainingConcurrency = config.stageConcurrency?.training ?? config.concurrency
  pushValue(args, "--concurrency", trainingConcurrency)
  pushValue(args, "--train-concurrency", trainingConcurrency)
  pushValue(args, "--campaign-rounds", config.campaignRounds)
  pushValue(args, "--validate-rounds", config.validateRounds)
  pushValue(args, "--repair-attempts", config.repairAttempts)
  pushValue(args, "--history-policy", config.historyPolicy)
  pushValue(args, "--resume-mode", config.resumeMode)
  pushValue(args, "--max-attempts-per-task", config.maxAttemptsPerTask)
  if (config.adaptiveConcurrency?.enabled !== false && config.adaptiveConcurrency) {
    args.push("--adaptive-concurrency")
    pushValue(args, "--adaptive-model", config.adaptiveConcurrency.model)
  } else {
    args.push("--no-adaptive-concurrency")
  }
  if (config.reuseVerified === false) args.push("--no-reuse-verified")
  if (config.resumeRunning === false) args.push("--no-resume-running")
  if (config.runMerge === false) args.push("--skip-merge")
  if (config.runTrainReplay === false) args.push("--skip-train-replay")
  if (config.runTest === false) args.push("--skip-test")
  if (config.runBaseline === false) args.push("--skip-baseline")
  pushFlag(args, "--continue-after-training-incomplete", config.continueAfterTrainingIncomplete)
  pushFlag(args, "--continue-after-train-replay-failure", config.continueAfterTrainReplayFailure)
  pushFlag(args, "--retry-infra-failed", config.retryInfraFailed)
  pushFlag(args, "--retry-product-failed", config.retryProductFailed)
  pushValue(args, "--merge-strategy", config.mergeStrategy)
  pushValue(args, "--merge-execution-mode", config.mergeExecutionMode)
  pushValue(args, "--merge-input", config.hierarchicalMerge?.inputFilter)
  pushValue(args, "--merge-group-size", config.hierarchicalMerge?.groupSize)
  pushValue(args, "--merge-grouping", config.hierarchicalMerge?.grouping)
  pushValue(args, "--hierarchical-merge-concurrency", config.stageConcurrency?.hierarchicalMerge)
  pushValue(args, "--merge-acceptance-profile", config.mergeAcceptanceProfile)
  pushValue(args, "--merge-acceptance-preset", config.mergeAcceptancePreset)
  pushValue(args, "--merge-acceptance-stages", Array.isArray(config.mergeAcceptanceStages) ? config.mergeAcceptanceStages.join(",") : undefined)
  pushValue(args, "--merge-success-criterion", config.mergeAcceptanceSuccessCriterion)
  pushValue(args, "--merge-prompt-path", config.mergePromptPath)
  pushValue(args, "--merge-repair-prompt-path", config.mergeRepairPromptPath)
  pushValue(args, "--merge-contract-path", config.mergeContractPath)
  pushValue(args, "--skillopt-project-root", config.mergeAsSkillOpt?.projectRoot)
  pushValue(args, "--skillopt-config", config.mergeAsSkillOpt?.configPath)
  pushValue(args, "--skillopt-python-command", config.mergeAsSkillOpt?.pythonCommand)
  pushValue(args, "--skillopt-bridge-script", config.mergeAsSkillOpt?.bridgeScript)
  pushValue(args, "--skillopt-batch-size", config.mergeAsSkillOpt?.batchSize)
  pushValue(args, "--skillopt-workers", config.mergeAsSkillOpt?.workers)
  pushValue(args, "--skillopt-timeout-ms", config.mergeAsSkillOpt?.timeoutMs)
  pushValue(args, "--skillopt-initial-skill", config.mergeAsSkillOpt?.initialSkillPath)
  pushValue(args, "--skillopt-optimizer-backend", config.mergeAsSkillOpt?.optimizerBackend)
  pushValue(args, "--skillopt-optimizer-model", config.mergeAsSkillOpt?.optimizerModel)
  pushValue(args, "--skillopt-optimizer-base-url", config.mergeAsSkillOpt?.optimizerBaseUrl)
  pushValue(args, "--skillopt-optimizer-api-key-env", config.mergeAsSkillOpt?.optimizerApiKeyEnv)
  pushValue(args, "--skillopt-reasoning-effort", config.mergeAsSkillOpt?.reasoningEffort)
  pushValue(args, "--replay-concurrency", config.replayConcurrency)
  pushValue(args, "--test-concurrency", config.testConcurrency)
  pushValue(args, "--baseline-concurrency", config.baselineConcurrency)
  return args
}

async function preflightResumeInputs(input: { outDir: string; benchmarkArgs: string[] }) {
  const valueAfter = (name: string) => {
    const index = input.benchmarkArgs.indexOf(name)
    return index >= 0 ? input.benchmarkArgs[index + 1] : undefined
  }
  const taskPackRoot = valueAfter("--task-pack-root")
  const trainSplit = valueAfter("--train-split")
  const out = valueAfter("--out")
  const errors: string[] = []
  if (!out || path.resolve(out) !== path.resolve(input.outDir)) {
    errors.push(`--out does not match selected run dir: ${out || "(missing)"}`)
  }
  if (!taskPackRoot || !(await pathExists(taskPackRoot))) errors.push(`taskPackRoot does not exist: ${taskPackRoot || "(missing)"}`)
  if (!trainSplit || !(await pathExists(trainSplit))) errors.push(`trainSplit does not exist: ${trainSplit || "(missing)"}`)
  if (!(await pathExists(input.outDir))) errors.push(`selected outDir does not exist: ${input.outDir}`)
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const item of input.benchmarkArgs) {
    if (!item.startsWith("--")) continue
    if (seen.has(item)) duplicates.push(item)
    seen.add(item)
  }
  if (duplicates.length) errors.push(`duplicate options in launcher args: ${duplicates.join(", ")}`)
  if (errors.length) throw new Error(`Resume preflight failed:\n- ${errors.join("\n- ")}`)
  return { taskPackRoot, trainSplit, out }
}

async function archiveStopRequest(outDir: string) {
  const stopPath = path.join(outDir, "STOP_REQUESTED.json")
  if (!(await pathExists(stopPath))) return undefined
  const targetDir = path.join(outDir, "stop-reports", "cleared-stop-requests")
  await mkdir(targetDir, { recursive: true })
  const target = path.join(targetDir, `STOP_REQUESTED.cleared-${stamp()}.json`)
  await rename(stopPath, target)
  return target
}

async function archiveBenchmarkLeases(outDir: string) {
  const leaseDir = path.join(outDir, "benchmark-leases")
  if (!(await pathExists(leaseDir))) return [] as string[]
  const entries = await readdir(leaseDir, { withFileTypes: true }).catch(() => [])
  const targetDir = path.join(outDir, "stop-reports", "cleared-benchmark-leases", stamp())
  const moved: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    await mkdir(targetDir, { recursive: true })
    const source = path.join(leaseDir, entry.name)
    const target = path.join(targetDir, entry.name)
    await rename(source, target).catch(() => undefined)
    if (await pathExists(target)) moved.push(target)
  }
  return moved
}

function stamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)
}

async function findBunExe() {
  const own = process.execPath
  if (own && /bun(?:\.exe)?$/i.test(path.basename(own))) return own
  const common = path.join(process.env.APPDATA || "", "npm", "node_modules", "bun", "bin", "bun.exe")
  if (await pathExists(common)) return common
  return "bun"
}

async function writeLauncher(input: {
  outDir: string
  args: string[]
  bunExe: string
  projectRoot: string
}) {
  const logDir = path.join(input.outDir, "resume-logs", `resume-${stamp()}`)
  await mkdir(logDir, { recursive: true })
  const launcherPath = path.join(logDir, "launcher.mjs")
  const stdoutPath = path.join(logDir, "stdout.log")
  const stderrPath = path.join(logDir, "stderr.log")
  const resultPath = path.join(logDir, "launch-result.json")
  const argvPath = path.join(logDir, "argv.json")
  await writeFile(argvPath, JSON.stringify({ bunExe: input.bunExe, projectRoot: input.projectRoot, args: input.args }, null, 2), "utf8")
  const launcher = `import { spawn } from "node:child_process";
import fs from "node:fs";
const bunExe = ${JSON.stringify(input.bunExe)};
const projectRoot = ${JSON.stringify(input.projectRoot)};
const args = ${JSON.stringify(input.args, null, 2)};
const stdoutPath = ${JSON.stringify(stdoutPath)};
const stderrPath = ${JSON.stringify(stderrPath)};
const resultPath = ${JSON.stringify(resultPath)};
const statePath = ${JSON.stringify(path.join(input.outDir, "orchestrator-state.json"))};
const beforeMtime = fs.existsSync(statePath) ? fs.statSync(statePath).mtimeMs : 0;
fs.appendFileSync(stdoutPath, "");
fs.appendFileSync(stderrPath, "");
const outFd = fs.openSync(stdoutPath, "a");
const errFd = fs.openSync(stderrPath, "a");
const child = spawn(bunExe, args, {
  cwd: projectRoot,
  detached: true,
  windowsHide: true,
  stdio: ["ignore", outFd, errFd],
});
child.unref();
await new Promise((resolve) => setTimeout(resolve, 12000));
let alive = true;
try { process.kill(child.pid, 0); } catch { alive = false; }
const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, "utf8") : "";
const stateMtime = fs.existsSync(statePath) ? fs.statSync(statePath).mtimeMs : 0;
const strictError = /Unexpected bare argument\\(s\\)|path containing spaces was not quoted correctly|Unknown option/i.test(stderr);
const result = {
  pid: child.pid,
  alive,
  strictError,
  stateTouched: stateMtime > beforeMtime,
  detached: true,
  stdoutPath,
  stderrPath,
  resultPath,
  checkedAt: new Date().toISOString(),
};
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
// Do not explicitly close these log handles while the detached benchmark process is alive.
// On Windows/Bun this avoids rare child stdio invalidation when the short launcher exits.
if (!alive || strictError) {
  try { fs.closeSync(outFd); } catch {}
  try { fs.closeSync(errFd); } catch {}
}
if (!alive || strictError) process.exit(2);
`
  await writeFile(launcherPath, launcher, "utf8")
  return { logDir, launcherPath, stdoutPath, stderrPath, resultPath, argvPath }
}

async function runLauncher(launcherPath: string, bunExe: string) {
  const proc = Bun.spawn([bunExe, launcherPath], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code }
}

function printableCandidate(row: Candidate) {
  return {
    runID: row.runID,
    taskPack: path.basename(row.taskPackRoot || ""),
    label: row.label,
    verified: row.verified,
    running: row.running,
    recovery: row.recovery,
    failed: row.failed,
    queued: row.queued,
    total: row.total,
    phase: row.phase,
    hasStopRequest: row.hasStopRequest,
    synthetic: row.synthetic,
    outDir: row.outDir,
    updatedAt: row.updatedAt,
  }
}

function countLedgerStatuses(tasks: Record<string, any>) {
  const statuses: Record<string, number> = {}
  for (const task of Object.values(tasks)) {
    const status = String((task as any)?.status ?? "unknown")
    statuses[status] = (statuses[status] ?? 0) + 1
  }
  return statuses
}

async function buildLineageAudit(input: {
  selection: string
  selected: Candidate
  candidates: Candidate[]
}) {
  const warnings: string[] = []
  if (input.selected.hasStopRequest) warnings.push("Selected run has STOP_REQUESTED.json; resume wrapper will archive it before launch.")
  if (input.selected.synthetic) warnings.push("Selected run is marked synthetic/smoke; do not use it for formal experiment conclusions.")
  if (input.candidates.length > 1) {
    const sameTaskPack = input.candidates.filter((row) => row.taskPackRoot && row.taskPackRoot === input.selected.taskPackRoot)
    if (sameTaskPack.length > 1) warnings.push(`Multiple candidate runs share the selected task-pack (${sameTaskPack.length}); selection is based on progress sorting or explicit args.`)
  }
  const ledgerPath = path.join(input.selected.outDir, "task-ledger.json")
  const ledger = await readJson<any>(ledgerPath)
  const tasks = ledger?.tasks && typeof ledger.tasks === "object" ? ledger.tasks as Record<string, any> : undefined
  if (!ledger) warnings.push("Missing task-ledger.json; lineage checks will rely on orchestrator-state/run-manifest only.")
  const activeAttempts = tasks
    ? Object.values(tasks)
        .map((task: any) => ({
          taskID: String(task.id ?? ""),
          status: String(task.status ?? "unknown"),
          activeAttemptID: task.activeAttemptID,
          activeCampaignID: task.activeCampaignID,
          activeCampaignDir: task.activeCampaignDir,
          allowResume: task.allowResume,
        }))
        .filter((task) => task.status !== "queued" || task.activeAttemptID || task.activeCampaignID)
    : []
  return {
    schema: "auto-evolve/resume-lineage-audit/v1" as const,
    createdAt: new Date().toISOString(),
    selection: input.selection,
    selected: printableCandidate(input.selected),
    candidates: input.candidates.slice(0, 20).map(printableCandidate),
    taskLedger: {
      exists: !!ledger,
      runID: ledger?.runID,
      currentGenerationID: ledger?.currentGenerationID,
      historyPolicy: ledger?.historyPolicy,
      taskCount: tasks ? Object.keys(tasks).length : undefined,
      statuses: tasks ? countLedgerStatuses(tasks) : undefined,
      activeAttempts: activeAttempts.slice(0, 200),
    },
    warnings,
  } satisfies LineageAudit
}

function lineageAuditMarkdown(audit: LineageAudit) {
  const lines = [
    "# Resume Lineage Audit",
    "",
    `- createdAt: \`${audit.createdAt}\``,
    `- selection: \`${audit.selection}\``,
    `- selected: \`${audit.selected.runID}\``,
    `- outDir: \`${audit.selected.outDir}\``,
    `- progress: \`${audit.selected.verified}/${audit.selected.total} verified, running=${audit.selected.running}, recovery=${audit.selected.recovery}, failed=${audit.selected.failed}, queued=${audit.selected.queued}\``,
    `- phase: \`${audit.selected.phase ?? "unknown"}\``,
    `- taskLedger: \`${audit.taskLedger?.exists ? "present" : "missing"}\``,
    `- generation: \`${audit.taskLedger?.currentGenerationID ?? "unknown"}\``,
    `- historyPolicy: \`${audit.taskLedger?.historyPolicy ?? "unknown"}\``,
    "",
    "## Warnings",
    ...(audit.warnings.length ? audit.warnings.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Candidate Runs",
    "| runID | verified/total | running | recovery | failed | queued | phase | STOP |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    ...audit.candidates.map((row) =>
      `| ${row.runID} | ${row.verified}/${row.total} | ${row.running} | ${row.recovery} | ${row.failed} | ${row.queued} | ${row.phase ?? ""} | ${row.hasStopRequest ? "yes" : "no"} |`,
    ),
  ]
  return `${lines.join("\n")}\n`
}

async function writeLineageAudit(logDir: string, audit: LineageAudit) {
  const jsonPath = path.join(logDir, "lineage-audit.json")
  const markdownPath = path.join(logDir, "lineage-audit.md")
  await writeFile(jsonPath, JSON.stringify(audit, null, 2), "utf8")
  await writeFile(markdownPath, lineageAuditMarkdown(audit), "utf8")
  return { jsonPath, markdownPath }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.h) {
    console.log(usage())
    return
  }
  if (!args.list && !args.auto && !args.out && !args["run-id"] && !args["task-pack"]) {
    console.log(usage())
    return
  }
  const selection = await selectCandidate(args)
  if (args.list) {
    console.log(JSON.stringify(selection.candidates.slice(0, 30).map(printableCandidate), null, 2))
    return
  }
  const candidate = selection.candidate
  const plan = await readJson<any>(path.join(candidate.outDir, "benchmark-plan.json"))
  const state = await readJson<any>(path.join(candidate.outDir, "orchestrator-state.json"))
  const manifest = await readJson<any>(path.join(candidate.outDir, "run-manifest.json"))
  const config = plan?.config || state?.config || {}
  const benchmarkArgs = buildBenchmarkArgs(candidate.outDir, config, manifest)
  const preflight = await preflightResumeInputs({ outDir: candidate.outDir, benchmarkArgs })
  const stopArchive = args["dry-run"] ? undefined : await archiveStopRequest(candidate.outDir)
  const movedLeases = args["dry-run"] ? [] : await archiveBenchmarkLeases(candidate.outDir)
  const bunExe = await findBunExe()
  const launcher = await writeLauncher({ outDir: candidate.outDir, args: benchmarkArgs, bunExe, projectRoot: repoRoot })
  const lineageAudit = await buildLineageAudit({
    selection: selection.selection,
    selected: candidate,
    candidates: selection.candidates,
  })
  const lineageAuditPaths = await writeLineageAudit(launcher.logDir, lineageAudit)
  const summary = {
    schema: "auto-evolve/resume-run/v1",
    dryRun: Boolean(args["dry-run"]),
    selection: selection.selection,
    selected: printableCandidate(candidate),
    stopArchive,
    movedLeases,
    bunExe,
    launcher,
    lineageAudit: lineageAuditPaths,
    lineageWarnings: lineageAudit.warnings,
    preflight,
    benchmarkArgs,
  }
  if (args["dry-run"]) {
    console.log(JSON.stringify(summary, null, 2))
    return
  }
  const launch = await runLauncher(launcher.launcherPath, bunExe)
  const launchResult = await readJson<any>(launcher.resultPath)
  console.log(JSON.stringify({ ...summary, launch, launchResult }, null, 2))
  if (launch.code !== 0 || launchResult?.alive !== true || launchResult?.strictError) process.exit(2)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
