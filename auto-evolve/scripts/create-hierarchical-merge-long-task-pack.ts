import path from "node:path"
import { ensureDirectory, readJsonFile, writeJsonFile } from "../orchestrator/fs"
import { loadConfig } from "../orchestrator/schema"
import { createMergeLongTaskPack } from "./create-merge-long-task-pack"

type GeneratedGroup = {
  groupID: string
  specPath: string
  caseCount: number
  replayCaseCount?: number
}

export type HierarchicalMergeLevelOverride = {
  level: number
  groupSize?: number
  groupConcurrency?: number
  replayScope?: "group_cases" | "union_source_cases" | "sampled_source_cases"
  blankReplayConcurrency?: number
  surfaceProfileSet?: string
  surfaceValidatorProfiles?: string[]
  blankAcceptanceScenario?: string
}

type ResolvedLevelPlan = {
  level: number
  groupSize: number
  groupConcurrency: number
  replayScope: "group_cases" | "union_source_cases" | "sampled_source_cases"
  replayConcurrency: number
  surfaceProfileSet: string
  surfaceValidatorProfiles: string[]
  blankAcceptanceScenario: string
  isConfigured: boolean
  isFinalLevel: boolean
}

type ReplayCase = {
  id: string
  title?: string
  specPath: string
  sourceID?: string
  mode?: string
}

export type CreateHierarchicalMergeLongTaskPackInput = {
  cwd: string
  taskPackRoot: string
  splitPath: string
  campaignManifestPath: string
  outRoot: string
  label?: string
  groupSize?: number
  maxInputs?: number
  maxLevels?: number
  levelPlanningMode?: "until_one" | "configured_levels"
  singleInputMode?: "promote" | "wrap" | "fail"
  finalizationMode?: "require_single_final" | "merge_remaining_to_one" | "promote_best_effort"
  levels?: HierarchicalMergeLevelOverride[]
  replayConcurrency?: number
  surfaceProfileSet?: string
  surfaceValidatorProfiles?: string[]
  inputSelection?: "success_only" | "failed_only" | "success_and_failed"
  intermediateBlankAcceptanceScenario?: string
  finalBlankAcceptanceScenario?: string
  dryRun?: boolean
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
  const normalized = ids.map((id) => id.trim()).filter(Boolean)
  const dupes = normalized.filter((id, index) => normalized.indexOf(id) !== index)
  if (dupes.length) throw new Error(`Split contains duplicate ID(s): ${Array.from(new Set(dupes)).slice(0, 20).join(", ")}`)
  return normalized
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

export async function buildNextLevelRows(level: number, groups: GeneratedGroup[]) {
  const rows = []
  for (const group of groups) {
    const taskDir = path.dirname(path.resolve(group.specPath))
    const materialsDir = path.join(taskDir, "materials")
    const inputManifest = await readJsonFile<any>(path.join(materialsDir, "input-manifest.json"))
    const replayPlan = await readJsonFile<any>(path.join(materialsDir, "replay-plan.json"))
    const manifestItems = Array.isArray(inputManifest.items) ? inputManifest.items : []
    const planCases = Array.isArray(replayPlan.cases) ? replayPlan.cases : []
    const sourceCases = sourceCasesFromManifest(manifestItems)
    const replayCases: ReplayCase[] = planCases.map((item: any) => {
      const id = String(item?.id ?? item?.sourceID ?? "").trim()
      if (!id) throw new Error(`Replay plan case in ${materialsDir} is missing id/sourceID`)
      const specPath = String(item?.specPath ?? "").trim()
      if (!specPath) throw new Error(`Replay plan case ${id} in ${materialsDir} is missing specPath`)
      return {
        id,
        title: typeof item?.title === "string" ? item.title : id,
        specPath: path.resolve(materialsDir, specPath),
        sourceID: typeof item?.sourceID === "string" ? item.sourceID : id,
        mode: typeof item?.mode === "string" ? item.mode : "train-backtest",
      }
    })
    rows.push({
      id: `level-${padLevel(level)}-${group.groupID}`,
      sourceKind: "merged_skill",
      status: "verified_success",
      verified: true,
      title: `Level ${level} merged skill ${group.groupID}`,
      skillRoot: path.join(taskDir, "workspace", "merged-skill"),
      sourceCases,
      replayCases,
      levelResultPath: path.join(taskDir, "campaign.json"),
    })
  }
  return rows
}

async function readSingleInputSkillPath(manifestPath: string, id: string) {
  const manifest = await readJsonFile<any>(manifestPath)
  const items = Array.isArray(manifest.items) ? manifest.items : []
  const row = items.find((item: any) => String(item?.id ?? "").trim() === id)
  if (!row) return undefined
  const explicitSkillRoot = typeof row.skillRoot === "string" && row.skillRoot.trim() ? row.skillRoot.trim() : undefined
  if (explicitSkillRoot) return path.resolve(path.dirname(manifestPath), explicitSkillRoot)
  const campaignDir = typeof row.campaignDir === "string" && row.campaignDir.trim() ? row.campaignDir.trim() : undefined
  if (campaignDir) return path.join(path.resolve(path.dirname(manifestPath), campaignDir), "pending-expert-package", "current")
  return undefined
}

function normalizeMode<T extends string>(input: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(input as T) ? input as T : fallback
}

function levelOverrideFor(levels: HierarchicalMergeLevelOverride[], level: number) {
  return levels.find((item) => item.level === level)
}

function mergeLevelOverrides(
  inputLevels: HierarchicalMergeLevelOverride[] | undefined,
  configLevels: HierarchicalMergeLevelOverride[] | undefined,
) {
  const source = inputLevels ?? configLevels ?? []
  const seen = new Set<number>()
  const out: HierarchicalMergeLevelOverride[] = []
  for (const item of [...source].sort((a, b) => a.level - b.level)) {
    if (!Number.isFinite(item.level) || item.level < 1 || seen.has(item.level)) continue
    seen.add(item.level)
    out.push({
      ...item,
      surfaceValidatorProfiles: item.surfaceValidatorProfiles ? [...item.surfaceValidatorProfiles] : undefined,
    })
  }
  return out
}

function resolveLevelPlan(input: {
  level: number
  currentCount: number
  forceFinal: boolean
  groupSizeFallback: number
  replayConcurrencyFallback: number
  override?: HierarchicalMergeLevelOverride
  hierarchical: Awaited<ReturnType<typeof loadConfig>>["mergeConfig"]["asLongTask"]["hierarchical"]
  userInput: CreateHierarchicalMergeLongTaskPackInput
}): ResolvedLevelPlan {
  const groupSize = positiveInteger(input.override?.groupSize ?? input.userInput.groupSize, `level ${input.level} group size`, input.groupSizeFallback)!
  if (input.currentCount > 1 && groupSize < 2) {
    throw new Error(`Hierarchical level ${input.level} has groupSize=${groupSize}; groupSize must be >= 2 when more than one skill remains`)
  }
  const groupCount = Math.ceil(input.currentCount / groupSize)
  const isFinalLevel = input.forceFinal || groupCount <= 1
  const replayScope =
    input.override?.replayScope ??
    (isFinalLevel ? input.hierarchical.finalReplayScope : input.hierarchical.intermediateReplayScope)
  return {
    level: input.level,
    groupSize,
    groupConcurrency: positiveInteger(
      input.override?.groupConcurrency,
      `level ${input.level} group concurrency`,
      input.hierarchical.groupConcurrency,
    )!,
    replayScope,
    replayConcurrency: positiveInteger(
      input.override?.blankReplayConcurrency ?? input.userInput.replayConcurrency,
      `level ${input.level} blank replay concurrency`,
      input.replayConcurrencyFallback,
    )!,
    surfaceProfileSet: input.override?.surfaceProfileSet ?? input.userInput.surfaceProfileSet ?? input.hierarchical.surfaceProfileSet,
    surfaceValidatorProfiles:
      input.override?.surfaceValidatorProfiles ??
      input.userInput.surfaceValidatorProfiles ??
      input.hierarchical.surfaceValidatorProfiles,
    blankAcceptanceScenario:
      input.override?.blankAcceptanceScenario ??
      (isFinalLevel
        ? input.userInput.finalBlankAcceptanceScenario ?? input.hierarchical.finalBlankAcceptanceScenario
        : input.userInput.intermediateBlankAcceptanceScenario ?? input.hierarchical.intermediateBlankAcceptanceScenario),
    isConfigured: Boolean(input.override),
    isFinalLevel,
  }
}

export async function createHierarchicalMergeLongTaskPacks(input: CreateHierarchicalMergeLongTaskPackInput) {
  const cwd = path.resolve(input.cwd)
  const config = await loadConfig(cwd)
  const hierarchical = config.mergeConfig.asLongTask.hierarchical
  const taskPackRoot = path.resolve(input.taskPackRoot)
  const outRoot = path.resolve(input.outRoot)
  const sourceSplitPath = path.resolve(input.splitPath)
  const sourceCampaignManifestPath = path.resolve(input.campaignManifestPath)
  const defaultGroupSize = positiveInteger(input.groupSize, "hierarchical group size", hierarchical.groupSize)!
  const maxLevels = positiveInteger(input.maxLevels, "hierarchical max levels", hierarchical.maxLevels)!
  const maxInputs = positiveInteger(input.maxInputs, "hierarchical max inputs")
  const defaultReplayConcurrency = positiveInteger(
    input.replayConcurrency,
    "hierarchical blank replay concurrency",
    hierarchical.blankReplayConcurrency,
  )!
  const levelPlanningMode = normalizeMode(
    input.levelPlanningMode,
    ["until_one", "configured_levels"] as const,
    hierarchical.levelPlanningMode,
  )
  const singleInputMode = normalizeMode(input.singleInputMode, ["promote", "wrap", "fail"] as const, hierarchical.singleInputMode)
  const finalizationMode = normalizeMode(
    input.finalizationMode,
    ["require_single_final", "merge_remaining_to_one", "promote_best_effort"] as const,
    hierarchical.finalizationMode,
  )
  const levelOverrides = mergeLevelOverrides(input.levels, hierarchical.levels)

  await ensureDirectory(outRoot)
  const inputDir = path.join(outRoot, "_inputs")
  await ensureDirectory(inputDir)

  let currentSplitPath = sourceSplitPath
  let currentManifestPath = sourceCampaignManifestPath
  let currentTaskPackRoot = taskPackRoot
  const sourceIDs = await readSplitIDs(currentSplitPath)
  let currentIDs = [...sourceIDs]
  if (maxInputs && currentIDs.length > maxInputs) {
    currentIDs = currentIDs.slice(0, maxInputs)
    currentSplitPath = path.join(inputDir, "level-01-split.json")
    await writeJsonFile(currentSplitPath, { ids: currentIDs })
  }

  if (currentIDs.length < 1) throw new Error("Hierarchical merge needs at least one input skill")
  const levels = []
  let level = 1
  let finalTaskPack = ""
  let finalGroup: GeneratedGroup | undefined
  let finalSkillPath: string | undefined
  let forceSingleWrap = false
  let promotedBestEffort = false

  if (currentIDs.length === 1) {
    if (singleInputMode === "fail") {
      throw new Error("Hierarchical merge received one input skill and singleInputMode=fail")
    }
    if (singleInputMode === "promote") {
      finalSkillPath = await readSingleInputSkillPath(currentManifestPath, currentIDs[0]!)
    } else {
      forceSingleWrap = true
    }
  }

  while (currentIDs.length > 1 || forceSingleWrap) {
    if (level > maxLevels) {
      throw new Error(`Hierarchical merge exceeded maxLevels=${maxLevels} with ${currentIDs.length} item(s) still remaining`)
    }
    const configuredLevel = levelOverrideFor(levelOverrides, level)
    let forceFinalLevel = forceSingleWrap
    if (levelPlanningMode === "configured_levels" && !configuredLevel && !forceSingleWrap) {
      if (currentIDs.length === 1) {
        finalSkillPath = await readSingleInputSkillPath(currentManifestPath, currentIDs[0]!)
        break
      }
      if (finalizationMode === "merge_remaining_to_one") {
        forceFinalLevel = true
      } else if (finalizationMode === "promote_best_effort") {
        promotedBestEffort = true
        break
      } else {
        throw new Error(
          `Configured hierarchical levels ended at level ${level - 1} with ${currentIDs.length} skill(s) remaining. ` +
            "Set finalizationMode=merge_remaining_to_one or add another level.",
        )
      }
    }
    const plan = resolveLevelPlan({
      level,
      currentCount: currentIDs.length,
      forceFinal: forceFinalLevel,
      groupSizeFallback: forceFinalLevel && !configuredLevel ? currentIDs.length : defaultGroupSize,
      replayConcurrencyFallback: defaultReplayConcurrency,
      override: configuredLevel,
      hierarchical,
      userInput: input,
    })
    const levelDir = path.join(outRoot, `level-${padLevel(level)}`)
    const outTaskPack = path.join(levelDir, "task-pack")
    const result = await createMergeLongTaskPack({
      cwd,
      taskPackRoot: currentTaskPackRoot,
      splitPath: currentSplitPath,
      campaignManifestPath: currentManifestPath,
      outTaskPack,
      label: `${input.label ?? path.basename(outRoot)}-level-${padLevel(level)}`,
      groupSize: plan.groupSize,
      replayConcurrency: plan.replayConcurrency,
      surfaceProfileSet: plan.surfaceProfileSet,
      surfaceValidatorProfiles: plan.surfaceValidatorProfiles,
      blankAcceptanceScenario: plan.blankAcceptanceScenario,
      inputSelection: level === 1 ? input.inputSelection ?? hierarchical.inputSelection : "success_only",
      dryRun: input.dryRun,
    })
    levels.push({
      level,
      inputCount: currentIDs.length,
      groupSize: plan.groupSize,
      groupConcurrency: plan.groupConcurrency,
      replayScope: plan.replayScope,
      replayConcurrency: plan.replayConcurrency,
      isConfigured: plan.isConfigured,
      isFinalLevel: plan.isFinalLevel,
      groupCount: result.groups.length,
      outTaskPack: normalizeSlash(outTaskPack),
      blankAcceptanceScenario: result.blankAcceptanceScenario,
      blankAcceptanceMode: result.blankAcceptanceMode,
      groups: result.groups.map((group) => ({
        ...group,
        specPath: normalizeSlash(group.specPath),
      })),
    })
    if (result.groups.length <= 1) {
      finalTaskPack = outTaskPack
      finalGroup = result.groups[0]
      if (finalGroup) {
        finalSkillPath = path.join(path.dirname(path.resolve(finalGroup.specPath)), "workspace", "merged-skill")
      }
      break
    }

    const nextRows = await buildNextLevelRows(level, result.groups)
    const nextInputDir = path.join(inputDir, `level-${padLevel(level + 1)}`)
    await ensureDirectory(nextInputDir)
    currentManifestPath = path.join(nextInputDir, "campaign-manifest.json")
    currentSplitPath = path.join(nextInputDir, "split.json")
    await writeJsonFile(currentManifestPath, {
      schema: "hierarchical-merge-input-manifest/v1",
      sourceLevel: level,
      items: nextRows,
    })
    await writeJsonFile(currentSplitPath, { ids: nextRows.map((row) => row.id) })
    currentTaskPackRoot = taskPackRoot
    currentIDs = nextRows.map((row) => row.id)
    forceSingleWrap = false
    level += 1
  }

  const summary = {
    schema: "hierarchical-merge-long-task-pack-summary/v1",
    label: input.label ?? path.basename(outRoot),
    sourceTaskPackRoot: normalizeSlash(taskPackRoot),
    sourceSplitPath: normalizeSlash(sourceSplitPath),
    sourceCampaignManifestPath: normalizeSlash(sourceCampaignManifestPath),
    selectedInputCount: maxInputs ? Math.min(maxInputs, sourceIDs.length) : sourceIDs.length,
    groupSize: defaultGroupSize,
    maxLevels,
    levelPlanningMode,
    singleInputMode,
    finalizationMode,
    replayConcurrency: defaultReplayConcurrency,
    acceptanceProfile: hierarchical.acceptanceProfile,
    failedGroupPolicy: hierarchical.failedGroupPolicy,
    levelOverrides: levelOverrides.map((item) => ({
      ...item,
      surfaceValidatorProfiles: item.surfaceValidatorProfiles ? [...item.surfaceValidatorProfiles] : undefined,
    })),
    levels,
    finalTaskPack: normalizeSlash(finalTaskPack),
    finalSpecPath: finalGroup ? normalizeSlash(finalGroup.specPath) : undefined,
    finalSkillPath: finalSkillPath ? normalizeSlash(finalSkillPath) : undefined,
    status: promotedBestEffort ? "promoted_best_effort" : finalGroup ? "final_group_generated" : "single_input_promoted",
    remainingInputIDs: promotedBestEffort ? currentIDs : undefined,
  }
  if (!input.dryRun) await writeJsonFile(path.join(outRoot, "hierarchical-summary.json"), summary)
  return summary
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
  const result = await createHierarchicalMergeLongTaskPacks({
    cwd,
    taskPackRoot,
    splitPath,
    campaignManifestPath,
    outRoot,
    label: readArg("--label"),
    groupSize: readArg("--group-size") ? Number(readArg("--group-size")) : undefined,
    maxInputs: readArg("--max-inputs") ? Number(readArg("--max-inputs")) : undefined,
    maxLevels: readArg("--max-levels") ? Number(readArg("--max-levels")) : undefined,
    levelPlanningMode: readArg("--level-planning-mode") as CreateHierarchicalMergeLongTaskPackInput["levelPlanningMode"],
    singleInputMode: readArg("--single-input-mode") as CreateHierarchicalMergeLongTaskPackInput["singleInputMode"],
    finalizationMode: readArg("--finalization-mode") as CreateHierarchicalMergeLongTaskPackInput["finalizationMode"],
    levels,
    replayConcurrency: readArg("--replay-concurrency") ? Number(readArg("--replay-concurrency")) : undefined,
    surfaceProfileSet: readArg("--surface-profile-set"),
    surfaceValidatorProfiles: readArg("--surface-validator-profiles")?.split(",").map((item) => item.trim()).filter(Boolean),
    inputSelection: readArg("--input-selection") as CreateHierarchicalMergeLongTaskPackInput["inputSelection"],
    intermediateBlankAcceptanceScenario: readArg("--intermediate-blank-acceptance-scenario"),
    finalBlankAcceptanceScenario: readArg("--final-blank-acceptance-scenario"),
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
