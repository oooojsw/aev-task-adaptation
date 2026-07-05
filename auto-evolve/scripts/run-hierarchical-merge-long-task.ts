import path from "node:path"
import { ensureDirectory, readJsonFile, writeJsonFile } from "../orchestrator/fs"
import { loadConfig } from "../orchestrator/schema"
import { createMergeLongTaskPack } from "./create-merge-long-task-pack"
import {
  buildNextLevelRows,
  type HierarchicalMergeLevelOverride,
} from "./create-hierarchical-merge-long-task-pack"

type ReplayCase = {
  id: string
  title?: string
  specPath: string
  sourceID?: string
  mode?: string
}

type GeneratedGroup = {
  groupID: string
  specPath: string
  caseCount: number
  replayCaseCount?: number
}

export type HierarchicalGroupRunnerInput = {
  cwd: string
  level: number
  group: GeneratedGroup
  campaignPath: string
  logDir: string
  resume: boolean
}

export type HierarchicalGroupRunnerResult = {
  ok: boolean
  exitCode?: number
  summary?: string
}

export type HierarchicalGroupRunner = (input: HierarchicalGroupRunnerInput) => Promise<HierarchicalGroupRunnerResult>

export type RunHierarchicalMergeLongTaskInput = {
  cwd: string
  taskPackRoot: string
  splitPath: string
  campaignManifestPath: string
  outRoot: string
  label?: string
  maxInputs?: number
  maxLevels?: number
  groupSize?: number
  groupConcurrency?: number
  replayConcurrency?: number
  levelPlanningMode?: "until_one" | "configured_levels"
  finalizationMode?: "require_single_final" | "merge_remaining_to_one" | "promote_best_effort"
  levels?: HierarchicalMergeLevelOverride[]
  dryRun?: boolean
  runner?: HierarchicalGroupRunner
}

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function padLevel(input: number) {
  return String(input).padStart(2, "0")
}

function readArg(flag: string) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function positiveInteger(input: unknown, label: string, fallback?: number) {
  if (input === undefined || input === null || input === "") return fallback
  const parsed = typeof input === "number" ? input : Number.parseInt(String(input), 10)
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`Invalid ${label}: ${input}`)
  return Math.floor(parsed)
}

async function readSplitIDs(splitPath: string) {
  const raw = await readJsonFile<any>(splitPath)
  let ids: string[] | undefined
  if (Array.isArray(raw)) ids = raw.map((item) => (typeof item === "string" ? item : item?.id)).filter(Boolean).map(String)
  if (!ids && Array.isArray(raw.ids)) ids = raw.ids.map(String)
  if (!ids && Array.isArray(raw.train)) {
    ids = raw.train.map((item: any) => (typeof item === "string" ? item : item?.id)).filter(Boolean).map(String)
  }
  if (!ids && Array.isArray(raw.items)) {
    ids = raw.items.map((item: any) => (typeof item === "string" ? item : item?.id)).filter(Boolean).map(String)
  }
  if (!ids) throw new Error(`Cannot read split IDs from ${splitPath}`)
  return ids.map((id) => id.trim()).filter(Boolean)
}

function sourceCasesFromManifest(items: any[]) {
  const out: string[] = []
  for (const item of items) {
    if (Array.isArray(item?.sourceCases)) {
      out.push(...item.sourceCases.map(String).map((id: string) => id.trim()).filter(Boolean))
      continue
    }
    if (typeof item?.id === "string" && item.id.trim()) out.push(item.id.trim())
  }
  return Array.from(new Set(out))
}

async function buildNextLevelRowsFromSuccessfulGroups(level: number, groups: GeneratedGroup[]) {
  const rows = await buildNextLevelRows(level, groups)
  return rows.map((row: any) => ({
    ...row,
    replayCases: Array.isArray(row.replayCases)
      ? row.replayCases.map((item: ReplayCase) => ({ ...item, specPath: path.resolve(item.specPath) }))
      : undefined,
  }))
}

function levelOverrideFor(levels: HierarchicalMergeLevelOverride[], level: number) {
  return levels.find((item) => item.level === level)
}

function sortedLevels(levels: HierarchicalMergeLevelOverride[] | undefined) {
  const seen = new Set<number>()
  const out: HierarchicalMergeLevelOverride[] = []
  for (const item of [...(levels ?? [])].sort((a, b) => a.level - b.level)) {
    if (!Number.isFinite(item.level) || item.level < 1 || seen.has(item.level)) continue
    seen.add(item.level)
    out.push(item)
  }
  return out
}

async function defaultRunner(input: HierarchicalGroupRunnerInput): Promise<HierarchicalGroupRunnerResult> {
  await ensureDirectory(input.logDir)
  const command = input.resume ? "resume-long-task-campaign" : "run-long-task-campaign"
  const args = input.resume
    ? ["run", "auto-evolve/cli.ts", command, "--spec", input.campaignPath]
    : ["run", "auto-evolve/cli.ts", command, "--spec", input.campaignPath]
  const child = Bun.spawn(["bun", ...args], {
    cwd: input.cwd,
    stdout: Bun.file(path.join(input.logDir, "stdout.log")),
    stderr: Bun.file(path.join(input.logDir, "stderr.log")),
  })
  const exitCode = await child.exited
  return {
    ok: exitCode === 0,
    exitCode,
    summary: `campaign ${path.basename(path.dirname(input.campaignPath))} exited ${exitCode}`,
  }
}

async function runWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>) {
  const results: R[] = new Array(items.length)
  let next = 0
  async function runWorker() {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index]!, index)
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runWorker())
  await Promise.all(workers)
  return results
}

async function writeLevelInputs(inputDir: string, level: number, rows: any[]) {
  const nextInputDir = path.join(inputDir, `level-${padLevel(level)}`)
  await ensureDirectory(nextInputDir)
  const manifestPath = path.join(nextInputDir, "campaign-manifest.json")
  const splitPath = path.join(nextInputDir, "split.json")
  await writeJsonFile(manifestPath, {
    schema: "hierarchical-merge-input-manifest/v1",
    sourceLevel: level - 1,
    items: rows,
  })
  await writeJsonFile(splitPath, { ids: rows.map((row) => row.id) })
  return { manifestPath, splitPath }
}

export async function runHierarchicalMergeLongTask(input: RunHierarchicalMergeLongTaskInput) {
  const cwd = path.resolve(input.cwd)
  const config = await loadConfig(cwd)
  const hierarchical = config.mergeConfig.asLongTask.hierarchical
  const taskPackRoot = path.resolve(input.taskPackRoot)
  const outRoot = path.resolve(input.outRoot)
  const inputDir = path.join(outRoot, "_live-inputs")
  const statePath = path.join(outRoot, "hierarchical-live-state.json")
  const runner = input.runner ?? defaultRunner
  const maxLevels = positiveInteger(input.maxLevels, "hierarchical max levels", hierarchical.maxLevels)!
  const defaultGroupSize = positiveInteger(input.groupSize, "hierarchical group size", hierarchical.groupSize)!
  const defaultGroupConcurrency = positiveInteger(input.groupConcurrency, "hierarchical group concurrency", hierarchical.groupConcurrency)!
  const defaultReplayConcurrency = positiveInteger(input.replayConcurrency, "hierarchical replay concurrency", hierarchical.blankReplayConcurrency)!
  const levelPlanningMode = input.levelPlanningMode ?? hierarchical.levelPlanningMode
  const finalizationMode = input.finalizationMode ?? hierarchical.finalizationMode
  const levelOverrides = sortedLevels(input.levels ?? hierarchical.levels)

  await ensureDirectory(outRoot)
  await ensureDirectory(inputDir)

  let currentSplitPath = path.resolve(input.splitPath)
  let currentManifestPath = path.resolve(input.campaignManifestPath)
  let currentIDs = await readSplitIDs(currentSplitPath)
  const maxInputs = positiveInteger(input.maxInputs, "hierarchical max inputs")
  if (maxInputs && currentIDs.length > maxInputs) {
    currentIDs = currentIDs.slice(0, maxInputs)
    const firstSplitPath = path.join(inputDir, "level-01-split.json")
    await writeJsonFile(firstSplitPath, { ids: currentIDs })
    currentSplitPath = firstSplitPath
  }
  let level = 1
  const levels: any[] = []
  let finalSkillPath: string | undefined

  while (currentIDs.length > 1) {
    if (level > maxLevels) throw new Error(`Live hierarchical merge exceeded maxLevels=${maxLevels}`)
    const override = levelOverrideFor(levelOverrides, level)
    if (levelPlanningMode === "configured_levels" && !override) {
      if (finalizationMode === "merge_remaining_to_one") {
        // fall through with one forced final group that consumes all remaining skills
      } else {
        throw new Error(`Configured live hierarchy ended before one skill remained at level ${level}`)
      }
    }
    const groupSize = positiveInteger(override?.groupSize, `level ${level} group size`, override ? defaultGroupSize : defaultGroupSize)!
    const forcedFinal = levelPlanningMode === "configured_levels" && !override && finalizationMode === "merge_remaining_to_one"
    const actualGroupSize = forcedFinal ? currentIDs.length : groupSize
    if (currentIDs.length > 1 && actualGroupSize < 2) throw new Error(`Level ${level} groupSize must be >= 2`)
    const groupCount = Math.ceil(currentIDs.length / actualGroupSize)
    const isFinalLevel = groupCount <= 1
    const outTaskPack = path.join(outRoot, `level-${padLevel(level)}`, "task-pack")
    const result = await createMergeLongTaskPack({
      cwd,
      taskPackRoot,
      splitPath: currentSplitPath,
      campaignManifestPath: currentManifestPath,
      outTaskPack,
      label: `${input.label ?? path.basename(outRoot)}-level-${padLevel(level)}`,
      groupSize: actualGroupSize,
      replayConcurrency: positiveInteger(override?.blankReplayConcurrency, `level ${level} replay concurrency`, defaultReplayConcurrency)!,
      surfaceProfileSet: override?.surfaceProfileSet ?? hierarchical.surfaceProfileSet,
      surfaceValidatorProfiles: override?.surfaceValidatorProfiles ?? hierarchical.surfaceValidatorProfiles,
      blankAcceptanceScenario:
        override?.blankAcceptanceScenario ??
        (isFinalLevel ? hierarchical.finalBlankAcceptanceScenario : hierarchical.intermediateBlankAcceptanceScenario),
      inputSelection: level === 1 ? hierarchical.inputSelection : "success_only",
      dryRun: input.dryRun,
    })
    const groupConcurrency = positiveInteger(override?.groupConcurrency, `level ${level} group concurrency`, defaultGroupConcurrency)!
    const groupResults = input.dryRun
      ? result.groups.map((group) => ({ groupID: group.groupID, ok: true, skipped: true }))
      : await runWithConcurrency(result.groups, groupConcurrency, async (group) => {
          const taskDir = path.dirname(path.resolve(group.specPath))
          const campaignPath = path.join(taskDir, "campaign.json")
          const runResult = await runner({
            cwd,
            level,
            group,
            campaignPath,
            logDir: path.join(outRoot, "logs", `level-${padLevel(level)}`, group.groupID),
            resume: false,
          })
          return { groupID: group.groupID, ...runResult }
        })
    const successfulGroups = result.groups.filter((group) => groupResults.some((item: any) => item.groupID === group.groupID && item.ok))
    const failedGroups = result.groups.filter((group) => !successfulGroups.some((item) => item.groupID === group.groupID))
    levels.push({
      level,
      inputCount: currentIDs.length,
      groupSize: actualGroupSize,
      groupConcurrency,
      groupCount: result.groups.length,
      successCount: successfulGroups.length,
      failedCount: failedGroups.length,
      outTaskPack: normalizeSlash(outTaskPack),
      groups: groupResults,
    })
    await writeJsonFile(statePath, {
      schema: "hierarchical-merge-long-task-live-state/v1",
      label: input.label ?? path.basename(outRoot),
      updatedAt: new Date().toISOString(),
      currentLevel: level,
      levels,
    })
    if (failedGroups.length) throw new Error(`Level ${level} has ${failedGroups.length} failed group(s); live hierarchy stops fail-closed`)
    if (successfulGroups.length <= 1) {
      const finalGroup = successfulGroups[0]
      if (finalGroup) finalSkillPath = path.join(path.dirname(path.resolve(finalGroup.specPath)), "workspace", "merged-skill")
      break
    }
    const rows = await buildNextLevelRowsFromSuccessfulGroups(level, successfulGroups)
    const nextInput = await writeLevelInputs(inputDir, level + 1, rows)
    currentManifestPath = nextInput.manifestPath
    currentSplitPath = nextInput.splitPath
    currentIDs = rows.map((row) => row.id)
    level += 1
  }

  const report = {
    schema: "hierarchical-merge-long-task-live-report/v1",
    label: input.label ?? path.basename(outRoot),
    taskPackRoot: normalizeSlash(taskPackRoot),
    sourceSplitPath: normalizeSlash(path.resolve(input.splitPath)),
    sourceCampaignManifestPath: normalizeSlash(path.resolve(input.campaignManifestPath)),
    levelPlanningMode,
    finalizationMode,
    levels,
    finalSkillPath: finalSkillPath ? normalizeSlash(finalSkillPath) : undefined,
    status: finalSkillPath ? "complete" : "no_final_skill",
  }
  await writeJsonFile(path.join(outRoot, "hierarchical-live-report.json"), report)
  return report
}

async function main() {
  const cwd = path.resolve(import.meta.dir, "..", "..")
  const taskPackRoot = readArg("--task-pack-root")
  const splitPath = readArg("--split")
  const campaignManifestPath = readArg("--campaign-manifest")
  const outRoot = readArg("--out-root")
  if (!taskPackRoot || !splitPath || !campaignManifestPath || !outRoot) {
    throw new Error("--task-pack-root, --split, --campaign-manifest and --out-root are required")
  }
  const levelsPath = readArg("--levels-path")
  const levels = levelsPath ? await readJsonFile<HierarchicalMergeLevelOverride[]>(path.resolve(levelsPath)) : undefined
  const result = await runHierarchicalMergeLongTask({
    cwd,
    taskPackRoot,
    splitPath,
    campaignManifestPath,
    outRoot,
    label: readArg("--label"),
    maxInputs: readArg("--max-inputs") ? Number(readArg("--max-inputs")) : undefined,
    maxLevels: readArg("--max-levels") ? Number(readArg("--max-levels")) : undefined,
    groupSize: readArg("--group-size") ? Number(readArg("--group-size")) : undefined,
    groupConcurrency: readArg("--group-concurrency") ? Number(readArg("--group-concurrency")) : undefined,
    replayConcurrency: readArg("--replay-concurrency") ? Number(readArg("--replay-concurrency")) : undefined,
    levelPlanningMode: readArg("--level-planning-mode") as RunHierarchicalMergeLongTaskInput["levelPlanningMode"],
    finalizationMode: readArg("--finalization-mode") as RunHierarchicalMergeLongTaskInput["finalizationMode"],
    levels,
    dryRun: process.argv.includes("--dry-run"),
  })
  console.log(JSON.stringify(result, null, 2))
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}
