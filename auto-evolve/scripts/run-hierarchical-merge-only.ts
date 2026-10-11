import path from "node:path"
import { readdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { ensureDirectory, pathExists, writeJsonFile } from "../orchestrator/fs"
import type { CoordinatorState, InstanceState } from "../orchestrator/multi-instance/contract"
import { saveCoordinatorState } from "../orchestrator/multi-instance/repository"
import { runCoordinatorHierarchicalMerge } from "../orchestrator/multi-instance/hierarchical-merger"

type CampaignRow = {
  id: string
  status: string
  dir: string
  updatedAt: string
  currentRound?: number
  maxRounds?: number
  pending: string
}

type BenchmarkTrainResult = {
  id: string
  status: string
  campaignDir?: string
  updatedAt?: string
}

type BenchmarkState = {
  config?: {
    taskPackRoot?: string
    trainSplit?: string
  }
  trainResults?: BenchmarkTrainResult[]
}

type FrozenSourceSkillManifest = {
  sourceSkills?: Array<{
    id?: string
    skillRoot?: string
  }>
}

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const autoRoot = path.join(repoRoot, "auto-evolve")
const campaignRoot = path.join(autoRoot, "runtime-state", "long-task-campaigns")

function getOption(args: string[], name: string) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  return args[index + 1]
}

function resolveMaybeRelative(input: string | undefined, fallback?: string) {
  const value = input?.trim() || fallback
  if (!value) return undefined
  if (path.isAbsolute(value)) return value
  return path.resolve(repoRoot, value)
}

function stamp() {
  const d = new Date()
  const p = (v: number, w = 2) => String(v).padStart(w, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T
}

function taskSpecPath(taskPackRoot: string, id: string) {
  return path.join(taskPackRoot, "tasks", id, "spec.json")
}

async function collectCampaigns(taskPackRoot: string, ids: string[]) {
  const byID = new Map<string, CampaignRow[]>()
  const entries = await readdir(campaignRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(campaignRoot, entry.name)
    const file = path.join(dir, "campaign.json")
    if (!(await pathExists(file))) continue
    let raw: Record<string, unknown>
    try {
      raw = await readJson<Record<string, unknown>>(file)
    } catch {
      continue
    }
    const hit = ids.find((id) => path.resolve(String(raw.baseSpecPath ?? "")) === path.resolve(taskSpecPath(taskPackRoot, id)))
    if (!hit) continue
    const row: CampaignRow = {
      id: hit,
      status: String(raw.status ?? "unknown"),
      dir,
      updatedAt: String(raw.updatedAt ?? raw.createdAt ?? ""),
      currentRound: typeof raw.currentRound === "number" ? raw.currentRound : undefined,
      maxRounds: typeof raw.maxRounds === "number" ? raw.maxRounds : undefined,
      pending: path.join(dir, "pending-expert-package", "current"),
    }
    byID.set(hit, [...(byID.get(hit) ?? []), row])
  }
  for (const [id, rows] of byID) {
    byID.set(
      id,
      rows.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)),
    )
  }
  return byID
}

function normalizeStoredPath(value: string) {
  if (process.platform !== "win32") return value
  return value.replace(/\\{2,}/g, "\\")
}

function samePath(left: string, right: string) {
  return path.resolve(normalizeStoredPath(left)).toLowerCase() === path.resolve(normalizeStoredPath(right)).toLowerCase()
}

async function collectCampaignsFromBenchmarkRun(input: {
  benchmarkRun: string
  taskPackRoot: string
  trainSplit: string
  ids: string[]
}) {
  const statePath = path.join(input.benchmarkRun, "orchestrator-state.json")
  if (!(await pathExists(statePath))) {
    throw new Error(`Source benchmark run has no orchestrator-state.json: ${input.benchmarkRun}`)
  }
  const state = await readJson<BenchmarkState>(statePath)
  if (state.config?.taskPackRoot && !samePath(state.config.taskPackRoot, input.taskPackRoot)) {
    throw new Error(
      `Source benchmark task-pack mismatch: expected ${input.taskPackRoot}, got ${state.config.taskPackRoot}`,
    )
  }
  if (state.config?.trainSplit && !samePath(state.config.trainSplit, input.trainSplit)) {
    throw new Error(`Source benchmark split mismatch: expected ${input.trainSplit}, got ${state.config.trainSplit}`)
  }
  const results = Array.isArray(state.trainResults) ? state.trainResults : []
  const byResultID = new Map(results.map((item) => [String(item.id), item]))
  const missing = input.ids.filter((id) => !byResultID.has(id))
  if (missing.length > 0) {
    throw new Error(`Source benchmark is missing ${missing.length} train result(s): ${missing.join(", ")}`)
  }
  const extra = results.map((item) => String(item.id)).filter((id) => !input.ids.includes(id))
  if (extra.length > 0) {
    throw new Error(`Source benchmark has ${extra.length} unexpected train result(s): ${extra.join(", ")}`)
  }

  const byID = new Map<string, CampaignRow[]>()
  for (const id of input.ids) {
    const result = byResultID.get(id)!
    if (!result.campaignDir) {
      throw new Error(`Source benchmark result ${id} has no campaignDir`)
    }
    const dir = normalizeStoredPath(result.campaignDir)
    const campaignPath = path.join(dir, "campaign.json")
    if (!(await pathExists(campaignPath))) {
      throw new Error(`Source benchmark campaign is missing for ${id}: ${dir}`)
    }
    const campaign = await readJson<Record<string, unknown>>(campaignPath)
    const specPath = String(campaign.baseSpecPath ?? "")
    if (!specPath || !samePath(specPath, taskSpecPath(input.taskPackRoot, id))) {
      throw new Error(`Source benchmark campaign/spec mismatch for ${id}: ${specPath || "<missing>"}`)
    }
    byID.set(id, [
      {
        id,
        status: String(result.status ?? campaign.status ?? "unknown"),
        dir,
        updatedAt: String(result.updatedAt ?? campaign.updatedAt ?? campaign.createdAt ?? ""),
        currentRound: typeof campaign.currentRound === "number" ? campaign.currentRound : undefined,
        maxRounds: typeof campaign.maxRounds === "number" ? campaign.maxRounds : undefined,
        pending: path.join(dir, "pending-expert-package", "current"),
      },
    ])
  }
  return byID
}

async function collectFrozenSourceSkills(input: { manifestPath: string; ids: string[] }) {
  const manifest = await readJson<FrozenSourceSkillManifest>(input.manifestPath)
  const rows = Array.isArray(manifest.sourceSkills) ? manifest.sourceSkills : []
  const byID = new Map<string, string>()
  for (const row of rows) {
    const id = String(row.id ?? "").trim()
    const skillRoot = String(row.skillRoot ?? "").trim()
    if (!id || !skillRoot) throw new Error(`Invalid frozen source skill row in ${input.manifestPath}`)
    if (byID.has(id)) throw new Error(`Duplicate frozen source skill ID: ${id}`)
    const resolved = normalizeStoredPath(skillRoot)
    if (!(await pathExists(resolved))) throw new Error(`Frozen source skill is missing for ${id}: ${resolved}`)
    byID.set(id, resolved)
  }
  const missing = input.ids.filter((id) => !byID.has(id))
  const extra = [...byID.keys()].filter((id) => !input.ids.includes(id))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Frozen source skill/split mismatch: missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`,
    )
  }
  return byID
}

function mapStatus(status: string): InstanceState["status"] {
  if (status === "verified_success") return "passed"
  if (status === "round_limit_reached" || status === "exhausted_failure") return "exhausted"
  return "failed"
}

async function buildInstance(input: {
  id: string
  taskPackRoot: string
  row?: CampaignRow
}): Promise<InstanceState> {
  const sourceTaskRoot = path.join(input.taskPackRoot, "tasks", input.id)
  const row = input.row
  const hasPending = row ? await pathExists(row.pending) : false
  const status = row ? mapStatus(row.status) : "failed"
  const notes: string[] = []
  if (!row) notes.push("No existing campaign found; metadata-only diagnostic input.")
  if (row && row.status === "running") notes.push("Existing campaign was running; merge-only treats it as diagnostic and does not resume it.")
  if (row && !hasPending) notes.push("No pending expert package found; metadata-only diagnostic input.")
  return {
    id: input.id,
    sourceTaskRoot,
    engine: "skillsbench",
    role: "train",
    status,
    rounds: row?.maxRounds ?? 0,
    finishedAt: row?.updatedAt,
    campaignID: row?.dir ? path.basename(row.dir) : undefined,
    campaignRunRoot: row?.dir,
    campaignDir: row?.dir,
    harvestedSkillPath: hasPending ? row!.pending : undefined,
    errorMessage: notes.length > 0 ? notes.join(" ") : undefined,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const taskPackRoot = resolveMaybeRelative(getOption(args, "--task-pack-root"))
  if (!taskPackRoot) throw new Error("Missing --task-pack-root")
  const trainSplit = resolveMaybeRelative(getOption(args, "--train-split"), path.join(taskPackRoot, "splits", "train-selected.json"))
  if (!trainSplit) throw new Error("Missing --train-split")
  const sourceBenchmarkRun = resolveMaybeRelative(getOption(args, "--source-benchmark-run"))
  const sourceSkillsManifest = resolveMaybeRelative(getOption(args, "--source-skills-manifest"))
  if (sourceBenchmarkRun && sourceSkillsManifest) {
    throw new Error("Use only one source selector: --source-benchmark-run or --source-skills-manifest")
  }
  const outDir =
    resolveMaybeRelative(getOption(args, "--out")) ??
    path.join(autoRoot, "runtime-state", "hierarchical-merge-only", `${stamp()}-${path.basename(taskPackRoot)}`)

  const ids = await readJson<string[]>(trainSplit)
  if (new Set(ids).size !== ids.length) throw new Error("Train split contains duplicate task IDs")
  const frozenSkills = sourceSkillsManifest
    ? await collectFrozenSourceSkills({ manifestPath: sourceSkillsManifest, ids })
    : undefined
  const campaigns = frozenSkills
    ? new Map<string, CampaignRow[]>()
    : sourceBenchmarkRun
      ? await collectCampaignsFromBenchmarkRun({ benchmarkRun: sourceBenchmarkRun, taskPackRoot, trainSplit, ids })
      : await collectCampaigns(taskPackRoot, ids)
  const instances: InstanceState[] = []
  for (const id of ids) {
    const frozenSkillRoot = frozenSkills?.get(id)
    if (frozenSkillRoot) {
      instances.push({
        id,
        sourceTaskRoot: path.join(taskPackRoot, "tasks", id),
        engine: "skillsbench",
        role: "train",
        status: "passed",
        rounds: 0,
        harvestedSkillPath: frozenSkillRoot,
      })
    } else {
      instances.push(await buildInstance({ id, taskPackRoot, row: campaigns.get(id)?.[0] }))
    }
  }

  await ensureDirectory(outDir)
  const state: CoordinatorState = {
    id: path.basename(outDir),
    label: `merge-only-${path.basename(taskPackRoot)}`,
    phase: "phase2_merge",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runRoot: outDir,
    options: {
      skillsbenchRoot: taskPackRoot,
      rounds: 0,
      fanoutLimit: 0,
      minTerminalToStop: ids.length,
    },
    instances,
    log: [
      {
        at: new Date().toISOString(),
        level: "info",
        message: "Merge-only coordinator state built from existing campaign directories; no training or resume is allowed.",
      },
    ],
  }
  await saveCoordinatorState(state)
  await writeJsonFile(path.join(outDir, "merge-only-input-summary.json"), {
    sourceBenchmarkRun,
    sourceSkillsManifest,
    ids,
    statusCounts: instances.reduce<Record<string, number>>((acc, item) => {
      acc[item.status] = (acc[item.status] ?? 0) + 1
      return acc
    }, {}),
    instances: instances.map((item) => ({
      id: item.id,
      status: item.status,
      campaignDir: item.campaignDir,
      harvestedSkillPath: item.harvestedSkillPath,
      errorMessage: item.errorMessage,
    })),
  })

  const localReplayEnabled = !args.includes("--hierarchical-no-local-replay")
  const repairAttemptsPerCase = Math.max(
    0,
    Number.parseInt(getOption(args, "--hierarchical-repair-attempts") ?? "1", 10),
  )
  const localReplayConcurrency = Math.max(
    1,
    Number.parseInt(getOption(args, "--hierarchical-replay-concurrency") ?? "1", 10),
  )
  const promptPath = resolveMaybeRelative(getOption(args, "--merge-prompt"))
  const contractPath = resolveMaybeRelative(getOption(args, "--merge-contract"))
  const mergeModel = getOption(args, "--merge-model")?.trim()
  const mergeConcurrency = Math.max(1, Number.parseInt(getOption(args, "--merge-concurrency") ?? "1", 10))
  const groupSize = Math.max(2, Number.parseInt(getOption(args, "--merge-group-size") ?? "5", 10))
  const maxFinalCoreBytes = getOption(args, "--max-final-core-bytes")
    ? Math.max(1, Number.parseInt(getOption(args, "--max-final-core-bytes")!, 10))
    : undefined
  const finalCoreLengthRepairAttempts = Math.max(
    0,
    Number.parseInt(getOption(args, "--final-core-length-repair-attempts") ?? "0", 10),
  )

  await writeJsonFile(path.join(outDir, "merge-run-config.json"), {
    sourceBenchmarkRun,
    sourceSkillsManifest,
    trainSplit,
    promptPath,
    contractPath,
    mergeModel,
    mergeConcurrency,
    groupSize,
    localReplayEnabled,
    maxFinalCoreBytes,
    finalCoreLengthRepairAttempts,
  })

  if (args.includes("--preflight-only")) {
    await writeJsonFile(path.join(outDir, "preflight-result.json"), {
      passed: true,
      sourceBenchmarkRun,
      sourceSkillsManifest,
      taskCount: ids.length,
      message: "Input lineage validated; no merger model was started.",
    })
    return
  }

  const result = await runCoordinatorHierarchicalMerge({
    cwd: repoRoot,
    state,
    options: {
      groupSize,
      inputFilter: "all",
      failurePolicy: "negative_evidence",
      grouping: "status_balanced",
      concurrency: mergeConcurrency,
      promptPath,
      contractPath,
      model: mergeModel,
      resumeExistingGroups: true,
      localReplayConcurrency,
      localReplayInfrastructureRetries: 2,
      localReplayFailClosedOnInfrastructure: args.includes("--hierarchical-fail-closed-infrastructure"),
      maxFinalCoreBytes,
      finalCoreLengthRepairAttempts,
      localReplay: {
        enabled: localReplayEnabled,
        levels: "level1",
        repairOnFailure:
          localReplayEnabled && !args.includes("--hierarchical-no-repair") && repairAttemptsPerCase > 0,
        repairAttemptsPerCase,
        rerunAfterRepair: args.includes("--hierarchical-rerun-after-repair"),
      },
    },
  })
  await writeJsonFile(path.join(outDir, "merge-only-result.json"), result)
  console.log(JSON.stringify(result, null, 2))
}

if (import.meta.main) {
  await main()
}
