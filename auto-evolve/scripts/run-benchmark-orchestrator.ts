import path from "node:path"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { createCoordinatorRun } from "../orchestrator/multi-instance/coordinator"
import { runCoordinatorPhase2Merge } from "../orchestrator/multi-instance/merger"
import { runCoordinatorPhase3Validate } from "../orchestrator/multi-instance/validator"
import { saveCoordinatorState } from "../orchestrator/multi-instance/repository"
import { runBlankEval } from "../orchestrator/blank-eval/runner"
import { pathExists } from "../orchestrator/fs"

type OrchestratorMode = "campaign-only" | "full-pipeline"

type CampaignRow = {
  id: string
  status: string
  cdir: string
  pending: string
  updated: string
}

type TrainQueueResult = {
  id: string
  code: number
  status: string
  campaignDir: string
  pending: string
  verified: boolean
}

type BaselineRow = {
  id: string
  passed: boolean
  runDir: string
  summary: string
}

type BenchmarkConfig = {
  label: string
  taskPackRoot: string
  trainSplit: string
  testSplit?: string
  outDir: string
  concurrency: number
  mode: OrchestratorMode
  stopAfter?: "training" | "merge" | "train-replay" | "test" | "baseline"
  dryRun: boolean
  reuseVerified: boolean
  resumeRunning: boolean
  runMerge: boolean
  runTrainReplay: boolean
  runTest: boolean
  runBaseline: boolean
  trainLimit?: number
  testLimit?: number
  validateRounds: number
  repairAttempts: number
}

type BenchmarkSummary = {
  config: BenchmarkConfig
  trainIDs: string[]
  testIDs: string[]
  trainVerified: number
  trainTotal: number
  status:
    | "dry_run"
    | "campaign_only_complete"
    | "training_incomplete"
    | "merge_complete"
    | "train_replay_failed"
    | "completed"
  trainedTestPassed?: number
  trainedTestTotal?: number
  baselinePassed?: number
  baselineTotal?: number
  mergedSkillDir?: string
}

type BenchmarkState = {
  runID: string
  phase:
    | "plan"
    | "training"
    | "campaign_only_complete"
    | "merge"
    | "train_replay"
    | "test"
    | "baseline"
    | "completed"
    | "aborted"
  updatedAt: string
  config: BenchmarkConfig
  trainIDs: string[]
  testIDs: string[]
  trainResults: Array<{
    id: string
    status: string
    campaignDir?: string
    updatedAt?: string
  }>
  merge?: {
    mergedSkillDir?: string
  }
  trainReplay?: {
    passed: number
    total: number
    failed: number
    repairAttempts?: number
    repairFixed?: number
  }
  test?: {
    passed: number
    total: number
    failed: number
  }
  baseline?: {
    passed: number
    total: number
  }
  finalReportPath?: string
}

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const autoRoot = path.join(repoRoot, "auto-evolve")
const runtimeCampaignRoot = path.join(autoRoot, "runtime-state", "long-task-campaigns")

function stamp() {
  const d = new Date()
  const p = (v: number, w = 2) => String(v).padStart(w, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
}

function nowISO() {
  return new Date().toISOString()
}

function getOption(args: string[], name: string) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  return args[index + 1]
}

function hasFlag(args: string[], name: string) {
  return args.includes(name)
}

function resolveMaybeRelative(input: string | undefined, fallback?: string) {
  const value = input?.trim() || fallback
  if (!value) return undefined
  if (path.isAbsolute(value)) return value
  return path.resolve(repoRoot, value)
}

function score(row: CampaignRow) {
  return Date.parse(row.updated || "") || 0
}

async function readIDs(file: string) {
  return JSON.parse(await readFile(file, "utf8")) as string[]
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), "utf8")
}

async function readState(file: string) {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(await readFile(file, "utf8")) as BenchmarkState
  } catch {
    return undefined
  }
}

function campaignSpecPath(taskPackRoot: string, id: string) {
  return path.join(taskPackRoot, "tasks", id, "campaign.json")
}

function baseSpecPath(taskPackRoot: string, id: string) {
  return path.join(taskPackRoot, "tasks", id, "spec.json")
}

async function campaigns(taskPackRoot: string, ids: string[]) {
  const got = new Map<string, CampaignRow[]>()
  const entries = await readdir(runtimeCampaignRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(runtimeCampaignRoot, entry.name, "campaign.json")
    if (!(await pathExists(file))) continue
    const raw = await readFile(file, "utf8").catch(() => "")
    if (!raw.trim()) continue
    const row = JSON.parse(raw) as Record<string, unknown>
    const hit = ids.find((id) => path.resolve(String(row.baseSpecPath ?? "")) === path.resolve(baseSpecPath(taskPackRoot, id)))
    if (!hit) continue
    const cdir = path.join(runtimeCampaignRoot, entry.name)
    const pending = path.join(cdir, "pending-expert-package", "current")
    const rec: CampaignRow = {
      id: hit,
      status: String(row.status ?? ""),
      cdir,
      pending,
      updated: String(row.updatedAt ?? row.createdAt ?? ""),
    }
    got.set(hit, [...(got.get(hit) ?? []), rec])
  }
  for (const [id, rows] of got) got.set(id, rows.sort((a, b) => score(b) - score(a)))
  return got
}

async function verified(taskPackRoot: string, ids: string[], map?: Map<string, CampaignRow[]>) {
  const src = map ?? (await campaigns(taskPackRoot, ids))
  const got = new Map<string, CampaignRow>()
  for (const id of ids) {
    for (const row of src.get(id) ?? []) {
      if (row.status !== "verified_success") continue
      if (!(await pathExists(row.pending))) continue
      got.set(id, row)
      break
    }
  }
  return got
}

async function planTrain(config: BenchmarkConfig, ids: string[]) {
  const map = await campaigns(config.taskPackRoot, ids)
  const ok = config.reuseVerified ? await verified(config.taskPackRoot, ids, map) : new Map<string, CampaignRow>()
  const todo: Array<{ id: string; spec: string; campaign?: string }> = []
  for (const id of ids) {
    if (ok.has(id)) continue
    const latest = map.get(id)?.[0]
    const live = config.resumeRunning && latest && ["running", "bootstrapping", "recovery_pending"].includes(latest.status)
    todo.push({
      id,
      spec: campaignSpecPath(config.taskPackRoot, id),
      campaign: live ? path.basename(latest.cdir) : undefined,
    })
  }
  return { ok, todo }
}

function summarizeQueueResults(rows: TrainQueueResult[]) {
  return {
    verified: rows.filter((row) => row.verified).length,
    recoveryPending: rows.filter((row) => row.status === "recovery_pending").length,
    failed: rows.filter((row) => row.status === "failed").length,
    exhausted: rows.filter((row) => row.status === "round_limit_reached" || row.status === "exhausted_failure").length,
  }
}

async function writeScorecard(file: string, state: BenchmarkState) {
  const trainVerified = state.trainResults.filter((item) => item.status === "verified_success").length
  const trainRunning = state.trainResults.filter((item) => item.status === "running").length
  const trainQueued = state.trainResults.filter((item) => item.status === "queued").length
  const trainOther = state.trainResults.length - trainVerified - trainRunning - trainQueued
  const lines = [
    "# Auto-Evolve Benchmark Orchestrator",
    "",
    `- updatedAt: \`${state.updatedAt}\``,
    `- phase: \`${state.phase}\``,
    `- taskPackRoot: \`${state.config.taskPackRoot}\``,
    `- mode: \`${state.config.mode}\``,
    `- outDir: \`${state.config.outDir}\``,
    "",
    "## Train queue",
    `- total: **${state.trainIDs.length}**`,
    `- verified_success: **${trainVerified}**`,
    `- running: **${trainRunning}**`,
    `- queued: **${trainQueued}**`,
    `- other terminal states: **${trainOther}**`,
    "",
    "## Train instances",
    "| id | status | campaignDir | updatedAt |",
    "|---|---|---|---|",
    ...state.trainResults.map((item) => {
      return `| \`${item.id}\` | \`${item.status}\` | ${item.campaignDir ? `\`${item.campaignDir}\`` : ""} | ${item.updatedAt ? `\`${item.updatedAt}\`` : ""} |`
    }),
  ]
  if (state.merge?.mergedSkillDir) {
    lines.push("", "## Merge", `- mergedSkillDir: \`${state.merge.mergedSkillDir}\``)
  }
  if (state.trainReplay) {
    lines.push(
      "",
      "## Train replay",
      `- passed: **${state.trainReplay.passed}/${state.trainReplay.total}**`,
      `- failed: **${state.trainReplay.failed}**`,
      `- repair: **${state.trainReplay.repairFixed ?? 0}/${state.trainReplay.repairAttempts ?? 0}**`,
    )
  }
  if (state.test) {
    lines.push("", "## Held-out test", `- passed: **${state.test.passed}/${state.test.total}**`, `- failed: **${state.test.failed}**`)
  }
  if (state.baseline) {
    lines.push("", "## Baseline", `- passed: **${state.baseline.passed}/${state.baseline.total}**`)
  }
  if (state.finalReportPath) {
    lines.push("", "## Final report", `- path: \`${state.finalReportPath}\``)
  }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${lines.join("\n")}\n`, "utf8")
}

async function persistState(stateFile: string, scorecardFile: string, state: BenchmarkState) {
  state.updatedAt = nowISO()
  await writeJson(stateFile, state)
  await writeScorecard(scorecardFile, state)
}

async function runOneCampaign(config: BenchmarkConfig, pick: { id: string; spec: string; campaign?: string }) {
  const logDir = path.join(config.outDir, "train-queue-logs")
  await mkdir(logDir, { recursive: true })
  const args = pick.campaign
    ? ["run", "cli.ts", "resume-long-task-campaign", "--campaign", pick.campaign, "--spec", pick.spec]
    : [
        "run",
        "cli.ts",
        "run-long-task-campaign",
        "--spec",
        pick.spec,
        ...(config.resumeRunning ? [] : ["--force-new"]),
      ]
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: autoRoot,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  await writeFile(path.join(logDir, `${pick.id}.stdout.log`), stdout, "utf8")
  await writeFile(path.join(logDir, `${pick.id}.stderr.log`), stderr, "utf8")
  const map = await campaigns(config.taskPackRoot, [pick.id])
  const ok = await verified(config.taskPackRoot, [pick.id], map)
  const hit = ok.get(pick.id) ?? map.get(pick.id)?.[0]
  return {
    id: pick.id,
    code,
    status: hit?.status ?? "unknown",
    campaignDir: hit?.cdir ?? "",
    pending: hit?.pending ?? "",
    verified: hit ? hit.status === "verified_success" && (await pathExists(hit.pending)) : false,
  } satisfies TrainQueueResult
}

async function queueTrain(
  config: BenchmarkConfig,
  todo: Array<{ id: string; spec: string; campaign?: string }>,
  state: BenchmarkState,
  stateFile: string,
  scorecardFile: string,
) {
  const rows: TrainQueueResult[] = []
  const recoveries = new Map<string, number>()
  let next = 0
  const active = new Set<Promise<void>>()

  const mark = async (id: string, patch: Partial<BenchmarkState["trainResults"][number]>) => {
    const row = state.trainResults.find((item) => item.id === id)
    if (!row) return
    Object.assign(row, patch, { updatedAt: nowISO() })
    await persistState(stateFile, scorecardFile, state)
  }

  async function start(pick: { id: string; spec: string; campaign?: string }) {
    await mark(pick.id, { status: "running" })
    const task = runOneCampaign(config, pick)
      .then(async (row) => {
        rows.push(row)
        await mark(row.id, { status: row.status, campaignDir: row.campaignDir })
        if (row.verified) return
        if (row.status !== "recovery_pending" || !row.campaignDir) return
        const attempts = recoveries.get(row.id) ?? 0
        if (attempts >= 2) return
        recoveries.set(row.id, attempts + 1)
        todo.push({
          id: row.id,
          spec: campaignSpecPath(config.taskPackRoot, row.id),
          campaign: path.basename(row.campaignDir),
        })
      })
      .finally(() => active.delete(task))
    active.add(task)
  }

  while (next < todo.length || active.size > 0) {
    while (next < todo.length && active.size < config.concurrency) {
      await start(todo[next]!)
      next += 1
    }
    if (active.size > 0) await Promise.race(active)
    await writeJson(path.join(config.outDir, "train-queue-results.json"), rows)
  }
  return rows
}

async function mergeReplayAndTest(config: BenchmarkConfig, trainIDs: string[], testIDs: string[], ok: Map<string, CampaignRow>, state: BenchmarkState, stateFile: string, scorecardFile: string) {
  state.phase = "merge"
  await persistState(stateFile, scorecardFile, state)

  const packName = path.basename(config.taskPackRoot)
  const stateRun = await createCoordinatorRun({
    cwd: repoRoot,
    runRoot: path.join(config.outDir, "merge-and-validate"),
    label: `${packName}-benchmark`,
    rounds: 1,
    instances: [
      ...trainIDs.map((id) => ({
        id,
        sourceTaskRoot: path.join(config.taskPackRoot, "tasks", id),
        engine: "skillsbench" as const,
        skillsbenchRoot: config.taskPackRoot,
        taskID: id,
        role: "train" as const,
      })),
      ...testIDs.map((id) => ({
        id,
        sourceTaskRoot: path.join(config.taskPackRoot, "tasks", id),
        engine: "skillsbench" as const,
        skillsbenchRoot: config.taskPackRoot,
        taskID: id,
        role: "test" as const,
      })),
    ],
    fanoutLimit: config.concurrency,
  })

  for (const inst of stateRun.instances) {
    if (inst.role === "test") {
      inst.status = "skipped"
      continue
    }
    const hit = ok.get(inst.id)
    inst.status = hit ? "passed" : "failed"
    inst.finishedAt = nowISO()
    inst.campaignDir = hit?.cdir
    inst.harvestedSkillPath = hit?.pending
    inst.errorMessage = hit ? undefined : "missing verified campaign"
  }
  await saveCoordinatorState(stateRun)

  const merge = await runCoordinatorPhase2Merge({ cwd: repoRoot, state: stateRun })
  stateRun.mergedSkillDir = merge.mergedSkillDir
  await saveCoordinatorState(stateRun)
  state.merge = { mergedSkillDir: merge.mergedSkillDir }
  await writeJson(path.join(config.outDir, "merge-output.json"), merge)
  await persistState(stateFile, scorecardFile, state)

  let replay = {
    passed: trainIDs.length,
    total: trainIDs.length,
    failed: 0,
    skipped: 0,
    regressions: [] as string[],
    durationMs: 0,
  }
  if (config.runTrainReplay) {
    state.phase = "train_replay"
    await persistState(stateFile, scorecardFile, state)
    replay = await runCoordinatorPhase3Validate({
      cwd: repoRoot,
      state: stateRun,
      rounds: config.validateRounds,
      validateLimit: config.concurrency,
      filter: (instance) => instance.role !== "test" && instance.status === "passed",
      repair:
        config.repairAttempts > 0
          ? {
              enabled: true,
              mode: "append_only",
              maxAttemptsPerCase: config.repairAttempts,
            }
          : undefined,
    })
    state.trainReplay = {
      passed: replay.passed,
      total: replay.total,
      failed: replay.failed,
      repairAttempts: replay.repairAttempts,
      repairFixed: replay.repairFixed,
    }
    await writeJson(path.join(config.outDir, "train-replay-output.json"), replay)
    await persistState(stateFile, scorecardFile, state)
    if (replay.passed !== replay.total) return { merge, replay, test: undefined }
  }

  if (!config.runTest || testIDs.length === 0) return { merge, replay, test: undefined }

  state.phase = "test"
  await persistState(stateFile, scorecardFile, state)
  const test = await runCoordinatorPhase3Validate({
    cwd: repoRoot,
    state: stateRun,
    rounds: config.validateRounds,
    validateLimit: config.concurrency,
    filter: (instance) => instance.role === "test",
  })
  state.test = { passed: test.passed, total: test.total, failed: test.failed }
  await writeJson(path.join(config.outDir, "trained-test-output.json"), test)
  await persistState(stateFile, scorecardFile, state)
  return { merge, replay, test }
}

async function runBaseline(config: BenchmarkConfig, testIDs: string[], state: BenchmarkState, stateFile: string, scorecardFile: string) {
  state.phase = "baseline"
  await persistState(stateFile, scorecardFile, state)
  const rows: BaselineRow[] = []
  const queue = [...testIDs]
  const baselineRoot = path.join(config.outDir, "baseline-no-skill")
  await mkdir(baselineRoot, { recursive: true })
  const active = new Set<Promise<void>>()
  async function start(id: string) {
    const task = runBlankEval({
      cwd: repoRoot,
      specPath: baseSpecPath(config.taskPackRoot, id),
      skillRoots: [],
      runRoot: path.join(baselineRoot, id),
      sourceID: id,
      mode: "test",
      concurrencyScope: `baseline-no-skill:${path.basename(config.taskPackRoot)}`,
    })
      .then((res) => {
        rows.push({ id, passed: res.passed, runDir: res.runDir, summary: res.summary })
      })
      .catch((err) => {
        rows.push({ id, passed: false, runDir: "", summary: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => active.delete(task))
    active.add(task)
  }
  while (queue.length > 0 || active.size > 0) {
    while (queue.length > 0 && active.size < config.concurrency) await start(queue.shift()!)
    if (active.size > 0) await Promise.race(active)
    await writeJson(path.join(config.outDir, "baseline-results.json"), rows)
  }
  state.baseline = { passed: rows.filter((row) => row.passed).length, total: rows.length }
  await persistState(stateFile, scorecardFile, state)
  return rows
}

function defaultLabel(taskPackRoot: string) {
  return `${path.basename(taskPackRoot)}-benchmark`
}

function shouldStopAfter(config: BenchmarkConfig, phase: NonNullable<BenchmarkConfig["stopAfter"]>) {
  return config.stopAfter === phase
}

export async function runTaskPackBenchmark(config: BenchmarkConfig) {
  const trainIDsAll = await readIDs(config.trainSplit)
  const testIDsAll = config.testSplit && existsSync(config.testSplit) ? await readIDs(config.testSplit) : []
  const trainIDs = config.trainLimit ? trainIDsAll.slice(0, config.trainLimit) : trainIDsAll
  const testIDs = config.testLimit ? testIDsAll.slice(0, config.testLimit) : testIDsAll

  const stateFile = path.join(config.outDir, "orchestrator-state.json")
  const scorecardFile = path.join(config.outDir, "scorecard.md")
  await mkdir(config.outDir, { recursive: true })

  const state =
    (await readState(stateFile)) ??
    ({
      runID: path.basename(config.outDir),
      phase: "plan",
      updatedAt: nowISO(),
      config,
      trainIDs,
      testIDs,
      trainResults: trainIDs.map((id) => ({ id, status: "queued" })),
    } satisfies BenchmarkState)
  state.config = config
  state.trainIDs = trainIDs
  state.testIDs = testIDs
  if (state.trainResults.length !== trainIDs.length) {
    state.trainResults = trainIDs.map((id) => {
      const previous = state.trainResults.find((item) => item.id === id)
      return previous ?? { id, status: "queued" }
    })
  }
  await persistState(stateFile, scorecardFile, state)

  await writeJson(path.join(config.outDir, "benchmark-plan.json"), {
    trainIDs,
    testIDs,
    config,
  })

  const before = await planTrain(config, trainIDs)
  await writeJson(path.join(config.outDir, "train-plan.json"), {
    alreadyVerified: Array.from(before.ok.keys()),
    todo: before.todo,
  })
  for (const row of state.trainResults) {
    const verifiedRow = before.ok.get(row.id)
    if (verifiedRow) {
      row.status = "verified_success"
      row.campaignDir = verifiedRow.cdir
      row.updatedAt = nowISO()
    }
  }
  await persistState(stateFile, scorecardFile, state)

  if (config.dryRun) {
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: before.ok.size,
      trainTotal: trainIDs.length,
      status: "dry_run",
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "completed"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  state.phase = "training"
  await persistState(stateFile, scorecardFile, state)
  if (before.todo.length > 0) {
    const queueRows = await queueTrain(config, before.todo, state, stateFile, scorecardFile)
    await writeJson(path.join(config.outDir, "train-queue-summary.json"), summarizeQueueResults(queueRows))
  }

  const ok = await verified(config.taskPackRoot, trainIDs)
  for (const row of state.trainResults) {
    const hit = ok.get(row.id)
    if (hit) {
      row.status = "verified_success"
      row.campaignDir = hit.cdir
      row.updatedAt = nowISO()
    }
  }
  await writeJson(path.join(config.outDir, "verified-training.json"), Array.from(ok.values()))
  await persistState(stateFile, scorecardFile, state)

  if (config.mode === "campaign-only") {
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: ok.size,
      trainTotal: trainIDs.length,
      status: "campaign_only_complete",
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "campaign_only_complete"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  if (!config.runMerge || shouldStopAfter(config, "training")) {
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: ok.size,
      trainTotal: trainIDs.length,
      status: "campaign_only_complete",
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "completed"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  if (ok.size !== trainIDs.length) {
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: ok.size,
      trainTotal: trainIDs.length,
      status: "training_incomplete",
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "aborted"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  const merged = await mergeReplayAndTest(config, trainIDs, testIDs, ok, state, stateFile, scorecardFile)
  if (shouldStopAfter(config, "merge")) {
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: ok.size,
      trainTotal: trainIDs.length,
      status: "merge_complete",
      mergedSkillDir: merged.merge.mergedSkillDir,
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "completed"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  if (merged.replay.passed !== merged.replay.total) {
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: ok.size,
      trainTotal: trainIDs.length,
      status: "train_replay_failed",
      mergedSkillDir: merged.merge.mergedSkillDir,
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "aborted"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  if (shouldStopAfter(config, "train-replay")) {
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: ok.size,
      trainTotal: trainIDs.length,
      status: "merge_complete",
      mergedSkillDir: merged.merge.mergedSkillDir,
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "completed"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  if (shouldStopAfter(config, "test")) {
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: ok.size,
      trainTotal: trainIDs.length,
      status: "completed",
      trainedTestPassed: merged.test?.passed,
      trainedTestTotal: merged.test?.total,
      mergedSkillDir: merged.merge.mergedSkillDir,
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "completed"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  let baselineRows: BaselineRow[] = []
  if (config.runBaseline && testIDs.length > 0) {
    baselineRows = await runBaseline(config, testIDs, state, stateFile, scorecardFile)
  }

  if (!config.runTest && baselineRows.length === 0) {
    const report: BenchmarkSummary = {
      config,
      trainIDs,
      testIDs,
      trainVerified: ok.size,
      trainTotal: trainIDs.length,
      status: "merge_complete",
      mergedSkillDir: merged.merge.mergedSkillDir,
    }
    const finalReportPath = path.join(config.outDir, "final-report.json")
    state.phase = "completed"
    state.finalReportPath = finalReportPath
    await writeJson(finalReportPath, report)
    await persistState(stateFile, scorecardFile, state)
    return report
  }

  const report: BenchmarkSummary = {
    config,
    trainIDs,
    testIDs,
    trainVerified: ok.size,
    trainTotal: trainIDs.length,
    status: testIDs.length > 0 ? "completed" : "merge_complete",
    trainedTestPassed: merged.test?.passed,
    trainedTestTotal: merged.test?.total,
    baselinePassed: baselineRows.filter((row) => row.passed).length,
    baselineTotal: baselineRows.length,
    mergedSkillDir: merged.merge.mergedSkillDir,
  }
  const finalReportPath = path.join(config.outDir, "final-report.json")
  state.phase = "completed"
  state.finalReportPath = finalReportPath
  await writeJson(finalReportPath, report)
  await persistState(stateFile, scorecardFile, state)
  return report
}

function parseConfig(args: string[]): BenchmarkConfig {
  const taskPackRoot = resolveMaybeRelative(getOption(args, "--task-pack-root"))
  if (!taskPackRoot) throw new Error("Missing required option: --task-pack-root <path-to-task-pack-root>")
  const trainSplit = resolveMaybeRelative(getOption(args, "--train-split"), path.join(taskPackRoot, "splits", "train-selected.json"))
  if (!trainSplit) throw new Error("Missing train split path.")
  const testSplit = resolveMaybeRelative(getOption(args, "--test-split"))
  const label = getOption(args, "--label")?.trim() || defaultLabel(taskPackRoot)
  const outDir =
    resolveMaybeRelative(getOption(args, "--out")) ??
    path.join(autoRoot, "runtime-state", "benchmark-runs", `${stamp()}-${label.replace(/[^a-zA-Z0-9._-]+/g, "-")}`)
  const modeOpt = (getOption(args, "--mode")?.trim().toLowerCase() || "full-pipeline") as OrchestratorMode
  if (modeOpt !== "campaign-only" && modeOpt !== "full-pipeline") {
    throw new Error("Invalid --mode. Use campaign-only or full-pipeline.")
  }
  const stopAfterRaw = getOption(args, "--stop-after")?.trim().toLowerCase()
  const stopAfter =
    stopAfterRaw === "training" ||
    stopAfterRaw === "merge" ||
    stopAfterRaw === "train-replay" ||
    stopAfterRaw === "test" ||
    stopAfterRaw === "baseline"
      ? stopAfterRaw
      : undefined
  if (stopAfterRaw && !stopAfter) {
    throw new Error("Invalid --stop-after. Use training, merge, train-replay, test, or baseline.")
  }
  const concurrency = Math.max(1, Number.parseInt(getOption(args, "--concurrency") ?? "5", 10))
  const validateRounds = Math.max(1, Number.parseInt(getOption(args, "--validate-rounds") ?? "1", 10))
  const repairAttempts = Math.max(0, Number.parseInt(getOption(args, "--repair-attempts") ?? "3", 10))
  const trainLimitRaw = getOption(args, "--train-limit")
  const testLimitRaw = getOption(args, "--test-limit")
  const runMerge = !hasFlag(args, "--skip-merge") && modeOpt !== "campaign-only"
  const runTrainReplay = !hasFlag(args, "--skip-train-replay")
  const runTest = !hasFlag(args, "--skip-test")
  let runBaseline = !hasFlag(args, "--skip-baseline")
  if (stopAfter && stopAfter !== "baseline") runBaseline = false
  if (stopAfter === "training") {
    return {
      label,
      taskPackRoot,
      trainSplit,
      testSplit,
      outDir,
      concurrency,
      mode: modeOpt,
      stopAfter,
      dryRun: hasFlag(args, "--dry-run"),
      reuseVerified: !hasFlag(args, "--no-reuse-verified"),
      resumeRunning: !hasFlag(args, "--no-resume-running"),
      runMerge: false,
      runTrainReplay: false,
      runTest: false,
      runBaseline: false,
      trainLimit: trainLimitRaw ? Math.max(1, Number.parseInt(trainLimitRaw, 10)) : undefined,
      testLimit: testLimitRaw ? Math.max(1, Number.parseInt(testLimitRaw, 10)) : undefined,
      validateRounds,
      repairAttempts,
    }
  }
  if (stopAfter === "merge") {
    return {
      label,
      taskPackRoot,
      trainSplit,
      testSplit,
      outDir,
      concurrency,
      mode: modeOpt,
      stopAfter,
      dryRun: hasFlag(args, "--dry-run"),
      reuseVerified: !hasFlag(args, "--no-reuse-verified"),
      resumeRunning: !hasFlag(args, "--no-resume-running"),
      runMerge: true,
      runTrainReplay: false,
      runTest: false,
      runBaseline: false,
      trainLimit: trainLimitRaw ? Math.max(1, Number.parseInt(trainLimitRaw, 10)) : undefined,
      testLimit: testLimitRaw ? Math.max(1, Number.parseInt(testLimitRaw, 10)) : undefined,
      validateRounds,
      repairAttempts,
    }
  }
  if (stopAfter === "train-replay") {
    return {
      label,
      taskPackRoot,
      trainSplit,
      testSplit,
      outDir,
      concurrency,
      mode: modeOpt,
      stopAfter,
      dryRun: hasFlag(args, "--dry-run"),
      reuseVerified: !hasFlag(args, "--no-reuse-verified"),
      resumeRunning: !hasFlag(args, "--no-resume-running"),
      runMerge: true,
      runTrainReplay: true,
      runTest: false,
      runBaseline: false,
      trainLimit: trainLimitRaw ? Math.max(1, Number.parseInt(trainLimitRaw, 10)) : undefined,
      testLimit: testLimitRaw ? Math.max(1, Number.parseInt(testLimitRaw, 10)) : undefined,
      validateRounds,
      repairAttempts,
    }
  }
  if (stopAfter === "test") {
    runBaseline = false
  }
  return {
    label,
    taskPackRoot,
    trainSplit,
    testSplit,
    outDir,
    concurrency,
    mode: modeOpt,
    stopAfter,
    dryRun: hasFlag(args, "--dry-run"),
    reuseVerified: !hasFlag(args, "--no-reuse-verified"),
    resumeRunning: !hasFlag(args, "--no-resume-running"),
    runMerge,
    runTrainReplay,
    runTest,
    runBaseline,
    trainLimit: trainLimitRaw ? Math.max(1, Number.parseInt(trainLimitRaw, 10)) : undefined,
    testLimit: testLimitRaw ? Math.max(1, Number.parseInt(testLimitRaw, 10)) : undefined,
    validateRounds,
    repairAttempts,
  }
}

async function main() {
  const config = parseConfig(process.argv.slice(2))
  const report = await runTaskPackBenchmark(config)
  console.log(JSON.stringify(report, null, 2))
}

if (import.meta.main) {
  await main()
}
