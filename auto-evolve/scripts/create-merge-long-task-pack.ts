import path from "node:path"
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises"
import {
  autoEvolvePath,
  ensureDirectory,
  isPathWithinTruthRoot,
  pathExists,
  readJsonFile,
  writeJsonFile,
  writeTextFile,
} from "../orchestrator/fs"
import {
  loadConfig,
  type AutoEvolveConfig,
  type BlankAcceptanceAutoMountScenario,
  type BlankAcceptanceModeProfile,
} from "../orchestrator/schema"

type ManifestRow = {
  id?: string
  taskID?: string
  sourceID?: string
  sourceKind?: string
  status?: string
  verified?: boolean
  campaignDir?: string
  campaignID?: string
  skillRoot?: string
  skillPath?: string
  harvestedSkillPath?: string
  pendingExpertPackagePath?: string
  specPath?: string
  taskSpecPath?: string
  title?: string
  sourceCases?: string[]
  replayCases?: Array<string | ManifestReplayCase>
  levelResultPath?: string
}

type ManifestReplayCase = {
  id?: string
  sourceID?: string
  title?: string
  specPath?: string
  taskSpecPath?: string
  mode?: string
}

export type CreateMergeLongTaskPackInput = {
  cwd: string
  taskPackRoot: string
  splitPath: string
  campaignManifestPath: string
  outTaskPack: string
  label?: string
  groupSize?: number
  maxGroups?: number
  replayConcurrency?: number
  surfaceProfileSet?: string
  surfaceValidatorProfiles?: string[]
  blankAcceptanceMode?: string
  blankAcceptanceScenario?: BlankAcceptanceAutoMountScenario | string
  inputSelection?: "success_only" | "failed_only" | "success_and_failed"
  allowMissingManifestRows?: boolean
  dryRun?: boolean
}

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function safeID(input: string, fallback: string) {
  return (
    input
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || fallback
  )
}

function asString(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

function normalizeInputSelection(input: unknown, fallback: NonNullable<CreateMergeLongTaskPackInput["inputSelection"]>) {
  if (input === undefined || input === null || input === "") return fallback
  if (input === "success_only" || input === "failed_only" || input === "success_and_failed") return input
  if (input === "success-only") return "success_only"
  if (input === "failed-only") return "failed_only"
  if (input === "all" || input === "success-and-failed" || input === "success_failed") return "success_and_failed"
  throw new Error(`Invalid merge inputSelection: ${input}. Use success_only, failed_only, or success_and_failed.`)
}

function normalizePositiveInteger(input: unknown, label: string, fallback?: number) {
  if (input === undefined || input === null || input === "") return fallback
  const parsed = typeof input === "number" ? input : Number.parseInt(String(input), 10)
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`Invalid ${label}: ${input}. Use a positive integer.`)
  return Math.floor(parsed)
}

function resolveFrom(baseDir: string, value: string) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(baseDir, value)
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function normalizeID(row: ManifestRow) {
  return asString(row.id) ?? asString(row.taskID) ?? asString(row.sourceID)
}

function normalizeStatus(row: ManifestRow) {
  return (asString(row.status) ?? (row.verified ? "verified_success" : "")).toLowerCase()
}

function isSuccessRow(row: ManifestRow) {
  const status = normalizeStatus(row)
  return row.verified === true || status === "verified_success" || status === "success" || status === "passed"
}

function isFailedRow(row: ManifestRow) {
  const status = normalizeStatus(row)
  return status.includes("fail") || status.includes("round_limit") || status.includes("blocked")
}

function filterBySelection(rows: ManifestRow[], selection: CreateMergeLongTaskPackInput["inputSelection"]) {
  const mode = selection ?? "success_only"
  if (mode === "success_and_failed") return rows
  if (mode === "failed_only") return rows.filter(isFailedRow)
  return rows.filter((row) => isSuccessRow(row) || !normalizeStatus(row))
}

function chunk<T>(items: T[], size: number) {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
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
  if (ids) {
    const normalized = ids.map((id) => id.trim()).filter(Boolean)
    const dupes = normalized.filter((id, index) => normalized.indexOf(id) !== index)
    if (dupes.length) throw new Error(`Split contains duplicate ID(s): ${Array.from(new Set(dupes)).slice(0, 20).join(", ")}`)
    return normalized
  }
  throw new Error(`Cannot read split IDs from ${splitPath}`)
}

async function readManifestRows(manifestPath: string) {
  const raw = await readJsonFile<any>(manifestPath)
  if (Array.isArray(raw)) return raw as ManifestRow[]
  if (Array.isArray(raw.items)) return raw.items as ManifestRow[]
  if (Array.isArray(raw.results)) return raw.results as ManifestRow[]
  if (Array.isArray(raw.trainResults)) return raw.trainResults as ManifestRow[]
  throw new Error(`Cannot read campaign manifest rows from ${manifestPath}`)
}

function resolveSkillRoot(row: ManifestRow, manifestDir: string) {
  const explicit =
    asString(row.skillRoot) ??
    asString(row.skillPath) ??
    asString(row.harvestedSkillPath) ??
    asString(row.pendingExpertPackagePath)
  if (explicit) return resolveFrom(manifestDir, explicit)
  if (row.campaignDir) return path.join(resolveFrom(manifestDir, row.campaignDir), "pending-expert-package", "current")
  return undefined
}

function resolveSpecPath(taskPackRoot: string, row: ManifestRow, id: string, manifestDir: string) {
  const explicit = asString(row.specPath) ?? asString(row.taskSpecPath)
  if (explicit) return resolveFrom(manifestDir, explicit)
  return path.resolve(taskPackRoot, "tasks", id, "spec.json")
}

function resolveOptionalSpecPath(taskPackRoot: string, row: ManifestRow, id: string, manifestDir: string) {
  const explicit = asString(row.specPath) ?? asString(row.taskSpecPath)
  if (explicit) return resolveFrom(manifestDir, explicit)
  const fallback = path.resolve(taskPackRoot, "tasks", id, "spec.json")
  return fallback
}

function normalizeSourceCases(row: ManifestRow, id: string) {
  const cases = Array.isArray(row.sourceCases)
    ? row.sourceCases.map((item) => String(item).trim()).filter(Boolean)
    : []
  return cases.length ? Array.from(new Set(cases)) : [id]
}

function replayCaseID(input: string | ManifestReplayCase) {
  if (typeof input === "string") return input.trim()
  return asString(input.id) ?? asString(input.sourceID)
}

function replayCaseTitle(input: string | ManifestReplayCase, id: string) {
  if (typeof input === "string") return id
  return asString(input.title) ?? id
}

function replayCaseMode(input: string | ManifestReplayCase) {
  if (typeof input === "string") return "train-backtest"
  return asString(input.mode) ?? "train-backtest"
}

function replayCaseSpecPath(input: string | ManifestReplayCase) {
  if (typeof input === "string") return undefined
  return asString(input.specPath) ?? asString(input.taskSpecPath)
}

function resolveReplayCases(input: {
  row: ManifestRow
  rowID: string
  taskPackRoot: string
  manifestDir: string
  materialsDir: string
}) {
  const rawReplayCases = Array.isArray(input.row.replayCases) && input.row.replayCases.length
    ? input.row.replayCases
    : [input.rowID]
  const seen = new Set<string>()
  const out: Array<{ id: string; title: string; specPath: string; sourceID: string; mode: string }> = []
  for (const raw of rawReplayCases) {
    const id = replayCaseID(raw)
    if (!id) throw new Error(`Replay case for ${input.rowID} is missing id/sourceID`)
    if (seen.has(id)) continue
    seen.add(id)
    const specRef = replayCaseSpecPath(raw)
    const specPath = specRef
      ? resolveFrom(input.manifestDir, specRef)
      : resolveSpecPath(input.taskPackRoot, { id }, id, input.manifestDir)
    out.push({
      id,
      title: replayCaseTitle(raw, id),
      specPath: normalizeSlash(path.relative(input.materialsDir, specPath)),
      sourceID: input.rowID,
      mode: replayCaseMode(raw),
    })
  }
  return out
}

function resolveProfileRefs(config: AutoEvolveConfig, input: CreateMergeLongTaskPackInput) {
  const asLongTask = config.mergeConfig.asLongTask
  const setName = input.surfaceProfileSet ?? asLongTask.surfaceProfileSet
  const profileSet = config.validationConfig.profileSets[setName]
  if (!profileSet) {
    const available = Object.keys(config.validationConfig.profileSets).sort().join(", ") || "(none)"
    throw new Error(`Unknown validationConfig.profileSets entry for merge-as-long-task: ${setName}. Available: ${available}`)
  }
  const fromSet = profileSet?.validatorProfiles ?? []
  const fromConfig = asLongTask.surfaceValidatorProfiles ?? []
  const fromInput = input.surfaceValidatorProfiles ?? []
  const refs = Array.from(new Set([...fromSet, ...fromConfig, ...fromInput].map((item) => item.trim()).filter(Boolean)))
  if (!refs.length) {
    throw new Error(`Merge-as-long-task surface profile set ${setName} did not provide any validatorProfiles`)
  }
  return refs
}

async function resolveValidatorProfilePath(input: {
  autoRoot: string
  baseDir: string
  profilesRoot: string
  ref: string
}) {
  const rawRef = input.ref.trim()
  if (!rawRef) return undefined
  const profilesRoot = path.isAbsolute(input.profilesRoot)
    ? path.resolve(input.profilesRoot)
    : path.resolve(input.autoRoot, input.profilesRoot)

  const resolveFromProfilesRoot = async (ref: string) => {
    const normalizedRef = ref
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/^auto-evolve\/task-packs\/validator-profiles\//i, "")
      .replace(/^task-packs\/validator-profiles\//i, "")
    const fileRef = normalizedRef.endsWith(".json") ? normalizedRef : `${normalizedRef}.json`
    return path.resolve(profilesRoot, fileRef)
  }

  if (path.isAbsolute(rawRef)) {
    const absoluteProfile = rawRef.endsWith(".json") ? rawRef : `${rawRef}.json`
    if (await pathExists(absoluteProfile)) return absoluteProfile
    const normalizedAbsolute = absoluteProfile.replace(/\\/g, "/")
    const marker = "/task-packs/validator-profiles/"
    const markerIndex = normalizedAbsolute.toLowerCase().lastIndexOf(marker)
    if (markerIndex >= 0) return resolveFromProfilesRoot(normalizedAbsolute.slice(markerIndex + marker.length))
    return absoluteProfile
  }
  if (rawRef.endsWith(".json") || rawRef.includes(path.sep) || rawRef.includes("/")) {
    const local = resolveFrom(input.baseDir, rawRef)
    if (await pathExists(local)) return local
    return resolveFromProfilesRoot(rawRef)
  }
  return resolveFromProfilesRoot(rawRef)
}

async function collectValidatorIDsFromProfiles(input: {
  autoRoot: string
  baseDir: string
  profilesRoot: string
  refs: string[]
  chain?: string[]
}): Promise<string[]> {
  const ids: string[] = []
  for (const ref of input.refs) {
    const profilePath = await resolveValidatorProfilePath({
      autoRoot: input.autoRoot,
      baseDir: input.baseDir,
      profilesRoot: input.profilesRoot,
      ref,
    })
    if (!profilePath) continue
    if (!(await pathExists(profilePath))) throw new Error(`Validator profile does not exist: ${profilePath}`)
    const key = profilePath.toLowerCase()
    const chain = input.chain ?? []
    if (chain.includes(key)) throw new Error(`Validator profile cycle detected: ${[...chain, key].join(" -> ")}`)
    const rawProfile = await readJsonFile<Record<string, unknown>>(profilePath)
    const validators = Array.isArray(rawProfile.validators) ? rawProfile.validators : []
    const profileDir = path.dirname(profilePath)
    for (const item of validators) {
      if (isRecord(item) && typeof item.use === "string" && item.use.trim()) {
        ids.push(
          ...(await collectValidatorIDsFromProfiles({
            autoRoot: input.autoRoot,
            baseDir: profileDir,
            profilesRoot: input.profilesRoot,
            refs: [item.use],
            chain: [...chain, key],
          })),
        )
        continue
      }
      if (isRecord(item) && typeof item.id === "string" && item.id.trim()) ids.push(item.id.trim())
    }
  }
  return Array.from(new Set(ids))
}

function resolveBlankAcceptanceMode(config: AutoEvolveConfig, input: CreateMergeLongTaskPackInput) {
  const scenario = input.blankAcceptanceScenario ?? "merge_initial_replay"
  const autoMount = config.blankAcceptanceConfig.autoMount
  const autoModeID = autoMount.enabled ? autoMount.rules[scenario] : undefined
  if (input.blankAcceptanceScenario && autoMount.enabled && !autoModeID) {
    const available = Object.keys(autoMount.rules).sort().join(", ") || "(none)"
    throw new Error(`Unknown blank acceptance autoMount scenario: ${scenario}. Available: ${available}`)
  }
  const modeID =
    input.blankAcceptanceMode ??
    autoModeID ??
    config.mergeConfig.asLongTask.finalBlankAcceptanceMode ??
    config.blankAcceptanceConfig.defaultMode
  const mode = config.blankAcceptanceConfig.modes[modeID]
  if (!mode) {
    throw new Error(
      `Unknown blankAcceptanceConfig.modes entry: ${modeID}. ` +
        `scenario=${scenario}, autoMount=${autoMount.enabled ? "enabled" : "disabled"}`,
    )
  }
  return { modeID, mode, scenario }
}

function assertModeLegal(modeID: string, mode: BlankAcceptanceModeProfile, caseCount: number) {
  if (caseCount <= 0) throw new Error(`Blank acceptance mode ${modeID} has no cases to evaluate`)
  if (mode.runner === "single" && caseCount !== 1) {
    throw new Error(`Blank acceptance mode ${modeID} uses runner=single but selected ${caseCount} cases`)
  }
  if (mode.caseSelection === "previous_failed_only") {
    throw new Error(
      `Blank acceptance mode ${modeID} uses previous_failed_only. ` +
        "This generator needs an explicit failed-case list; use focused repair orchestration for that mode.",
    )
  }
}

async function isEmptyDir(dir: string) {
  try {
    const entries = await readdir(dir)
    return entries.length === 0
  } catch {
    return false
  }
}

async function assertSafeOutputDir(input: {
  cwd: string
  autoRoot: string
  outTaskPack: string
  taskPackRoot: string
}) {
  const out = path.resolve(input.outTaskPack)
  const autoRoot = path.resolve(input.autoRoot)
  const taskPackRoot = path.resolve(input.taskPackRoot)
  const cwd = path.resolve(input.cwd)
  const forbidden = [path.parse(out).root, cwd, autoRoot, taskPackRoot, path.dirname(taskPackRoot)]
  for (const item of forbidden) {
    if (path.resolve(item).toLowerCase() === out.toLowerCase()) {
      throw new Error(`Refusing to use unsafe merge output directory: ${out}`)
    }
  }
  if (isPathWithinTruthRoot(out, taskPackRoot) || isPathWithinTruthRoot(taskPackRoot, out)) {
    throw new Error(`Refusing merge output directory that overlaps source task pack: ${out}`)
  }
  if (await pathExists(out)) {
    const info = await stat(out)
    if (!info.isDirectory()) throw new Error(`Merge output path exists but is not a directory: ${out}`)
    const summaryPath = path.join(out, "dataset-summary.json")
    if (await pathExists(summaryPath)) {
      const summary = await readJsonFile<any>(summaryPath).catch(() => undefined)
      if (summary?.schema === "merge-long-task-pack-summary/v1") return
    }
    if (await isEmptyDir(out)) return
    throw new Error(
      `Refusing to delete non-empty directory without merge-long-task marker: ${out}. ` +
        "Choose a fresh --out-task-pack path or remove it manually after inspection.",
    )
  }
}

function blankEvalCriterion(mode: BlankAcceptanceModeProfile) {
  return mode.successCriterion === "report_only" ? "allow_partial" : mode.successCriterion
}

function taskEntryMarkdown(input: { groupID: string; caseCount: number; validatorProfiles: string[] }) {
  return `# Merge Long Task: ${input.groupID}

You are merging multiple previously learned single-case skills into one clean, general expert skill.

Inputs:
- \`materials/input-manifest.json\`: source skill list and source case metadata.
- \`materials/replay-plan.json\`: cases that the merged skill will be blank-evaluated on.
- \`materials/merge-inputs/\`: copied source skills.
- \`materials/merge-contract.json\`: the output contract the merged skill must satisfy.

Write the merged skill into \`workspace/merged-skill\`.

Hard requirements:
- Preserve reusable methods from successful cases.
- Record useful negative evidence from failed or difficult cases without copying their concrete answers.
- Do not include private-answer paths, validator private files, gold answers, or absolute runtime paths.
- Satisfy the mounted surface validator profiles: ${input.validatorProfiles.join(", ") || "(none)"}.
- The merged skill must teach a blank agent how to solve the replay cases without seeing any training traces.

This group contains ${input.caseCount} source skill(s).
`
}

function seedSkillFiles(groupID: string) {
  return {
    "INDEX.md": `# Merged Skill ${groupID}

## How To Use

Read CORE.md first, then consult casebook entries only when a case resembles the current task.

## Read Order

1. CORE.md
2. casebook/
3. open_observations.md

## Output Requirements

Follow the target task spec exactly. Do not invent answer values or copy private validation data.
`,
    "CORE.md": `# Core Rules

## Material Navigation Rules

Use only the materials visible to the blank agent.

## Extraction Rules

Extract facts from task materials, not from prior campaign traces.

## Calculation Or Transformation Rules

Describe reusable procedures. Do not hard-code case-specific answers.

## Output Discipline

Write outputs to the paths requested by the task spec.

## Failure Lessons

Use casebook notes to avoid repeated mistakes.
`,
    "meta.json": {
      schema: "auto-evolve-merged-skill/v1",
      profileID: "merge-long-task",
      createdAt: new Date().toISOString(),
      groupID,
    },
    "surface_contract.json": {
      version: 1,
      entry: "INDEX.md",
      documents: ["INDEX.md", "CORE.md", "casebook/", "open_observations.md"],
    },
    "open_observations.md": "# Open Observations\n\n",
  }
}

async function writeSeedSkill(root: string, groupID: string) {
  const files = seedSkillFiles(groupID)
  await writeTextFile(path.join(root, "INDEX.md"), files["INDEX.md"])
  await writeTextFile(path.join(root, "CORE.md"), files["CORE.md"])
  await writeJsonFile(path.join(root, "meta.json"), files["meta.json"])
  await writeJsonFile(path.join(root, "surface_contract.json"), files["surface_contract.json"])
  await writeTextFile(path.join(root, "open_observations.md"), files["open_observations.md"])
  await ensureDirectory(path.join(root, "casebook"))
  await writeTextFile(path.join(root, "casebook", "README.md"), "# Casebook\n\nAdd scenario-specific reusable lessons here.\n")
}

export async function createMergeLongTaskPack(input: CreateMergeLongTaskPackInput) {
  const cwd = path.resolve(input.cwd)
  const autoRoot = autoEvolvePath(cwd)
  const config = await loadConfig(cwd)
  const taskPackRoot = path.resolve(input.taskPackRoot)
  const outTaskPack = path.resolve(input.outTaskPack)
  const splitPath = path.resolve(input.splitPath)
  const manifestPath = path.resolve(input.campaignManifestPath)
  const manifestDir = path.dirname(manifestPath)
  const splitIDs = await readSplitIDs(splitPath)
  const manifestRows = await readManifestRows(manifestPath)
  const rowsByID = new Map<string, ManifestRow>()
  const duplicateManifestIDs: string[] = []
  for (const row of manifestRows) {
    const id = normalizeID(row)
    if (!id) continue
    if (rowsByID.has(id)) duplicateManifestIDs.push(id)
    rowsByID.set(id, row)
  }
  if (duplicateManifestIDs.length) {
    throw new Error(`Campaign manifest contains duplicate ID(s): ${Array.from(new Set(duplicateManifestIDs)).slice(0, 20).join(", ")}`)
  }
  const missingManifestIDs = splitIDs.map(String).filter((id) => !rowsByID.has(id))
  if (missingManifestIDs.length > 0 && !input.allowMissingManifestRows) {
    throw new Error(
      `Campaign manifest is missing ${missingManifestIDs.length} split ID(s): ${missingManifestIDs.slice(0, 20).join(", ")}. ` +
        "Pass --allow-missing-manifest-rows only when you intentionally provide a filtered manifest.",
    )
  }
  const selectedRows = splitIDs.map((id) => rowsByID.get(String(id))).filter((row): row is ManifestRow => Boolean(row))
  const inputSelection = normalizeInputSelection(input.inputSelection, config.mergeConfig.asLongTask.inputSelection)
  const filteredRows = filterBySelection(selectedRows, inputSelection)
  if (!filteredRows.length) {
    throw new Error(
      `No source skills selected for merge-as-long-task. splitIDs=${splitIDs.length}, manifestRows=${manifestRows.length}, inputSelection=${
        inputSelection
      }`,
    )
  }
  const groupSize = normalizePositiveInteger(input.groupSize, "merge group size", config.mergeConfig.asLongTask.groupSize)!
  const maxGroups = normalizePositiveInteger(input.maxGroups, "max groups")
  const groups = chunk(filteredRows, groupSize).slice(0, maxGroups ?? Number.POSITIVE_INFINITY)
  const validatorProfiles = resolveProfileRefs(config, input)
  const profileValidatorIDs = await collectValidatorIDsFromProfiles({
    autoRoot,
    baseDir: outTaskPack,
    profilesRoot: config.validationConfig.profilesRoot,
    refs: validatorProfiles,
  })
  const { modeID, mode, scenario } = resolveBlankAcceptanceMode(config, input)
  const replayConcurrency = normalizePositiveInteger(
    input.replayConcurrency,
    "replay concurrency",
    mode.concurrency ?? config.mergeConfig.asLongTask.replayConcurrency,
  )!
  const generated: Array<{ groupID: string; specPath: string; caseCount: number; replayCaseCount: number }> = []

  if (!input.dryRun) {
    await assertSafeOutputDir({ cwd, autoRoot, outTaskPack, taskPackRoot })
    await rm(outTaskPack, { recursive: true, force: true })
    await mkdir(outTaskPack, { recursive: true })
  }

  for (const [index, group] of groups.entries()) {
    const groupID = `merge-group-${String(index + 1).padStart(3, "0")}`
    const taskDir = path.join(outTaskPack, "tasks", groupID)
    const materialsDir = path.join(taskDir, "materials")
    const mergeInputsDir = path.join(materialsDir, "merge-inputs")
    const workspaceDir = path.join(taskDir, "workspace", "merged-skill")
    const replayCases = group.flatMap((row) => {
      const id = normalizeID(row)!
      return resolveReplayCases({ row, rowID: id, taskPackRoot, manifestDir, materialsDir })
    })
    assertModeLegal(modeID, mode, replayCases.length)
    for (const replayCase of replayCases) {
      const absoluteReplaySpec = path.resolve(materialsDir, replayCase.specPath)
      if (!(await pathExists(absoluteReplaySpec))) {
        throw new Error(`Missing replay spec for ${replayCase.id}: ${absoluteReplaySpec}`)
      }
    }
    const manifest = []
    for (const row of group) {
      const id = normalizeID(row)!
      const skillRoot = resolveSkillRoot(row, manifestDir)
      if (!skillRoot || !(await pathExists(skillRoot))) {
        throw new Error(`Missing skill root for ${id}: ${skillRoot ?? "(not provided)"}`)
      }
      const dest = path.join(mergeInputsDir, safeID(id, `case-${manifest.length + 1}`))
      if (!input.dryRun) await cp(skillRoot, dest, { recursive: true, force: true })
      const explicitSourceSpec = asString(row.specPath) ?? asString(row.taskSpecPath)
      const maybeSourceSpecPath = explicitSourceSpec ? resolveFrom(manifestDir, explicitSourceSpec) : resolveOptionalSpecPath(taskPackRoot, row, id, manifestDir)
      const sourceSpecPath = maybeSourceSpecPath && (await pathExists(maybeSourceSpecPath)) ? maybeSourceSpecPath : undefined
      manifest.push({
        id,
        sourceKind: asString(row.sourceKind) ?? (Array.isArray(row.replayCases) && row.replayCases.length ? "merged_skill" : "case_skill"),
        status: normalizeStatus(row) || undefined,
        sourceSkillRoot: normalizeSlash(path.relative(materialsDir, dest)),
        sourceSpecPath: sourceSpecPath ? normalizeSlash(path.relative(materialsDir, sourceSpecPath)) : undefined,
        sourceCases: normalizeSourceCases(row, id),
        replayCases: resolveReplayCases({ row, rowID: id, taskPackRoot, manifestDir, materialsDir }),
        levelResultPath: row.levelResultPath ? normalizeSlash(path.relative(materialsDir, resolveFrom(manifestDir, row.levelResultPath))) : undefined,
      })
    }

    const plan = {
      schema: "auto-evolve-blank-eval-plan/v1",
      cases: replayCases,
    }
    const completionValidatorIDs = Array.from(new Set([...profileValidatorIDs, "merged-skill-blank-eval-plan"]))
    const spec = {
      id: groupID,
      title: `Merge source skills ${groupID}`,
      goal: `Merge ${group.length} source skills into one clean expert skill that passes surface checks and blank replay.`,
      taskFamily: "merge-long-task",
      domainTags: ["merge", "skill", "blank-eval-plan"],
      materials: [
        { path: "./00-task-entry.md", label: "Task entry", role: "instructions" },
        { path: "./materials/input-manifest.json", label: "Source skill manifest", role: "materials" },
        { path: "./materials/replay-plan.json", label: "Blank replay plan", role: "materials" },
        { path: "./materials/merge-contract.json", label: "Merge output contract", role: "materials" },
      ],
      targetPaths: [{ path: "./workspace/merged-skill", label: "merged-skill", role: "experience-workspace" }],
      editablePaths: ["./workspace/merged-skill"],
      preservePreseededEditablePaths: ["./workspace/merged-skill"],
      validatorProfiles,
      validators: [
        {
          id: "merged-skill-blank-eval-plan",
          type: "blank_eval_plan",
          title: "Merged skill blank replay",
          placement: "completion_only",
          planPath: "./materials/replay-plan.json",
          skillRootPath: "./workspace/merged-skill",
          mode: mode.mode ?? "parallel",
          concurrency: replayConcurrency,
          stopOnFirstFailure: mode.stopOnFirstFailure ?? false,
          successCriterion: blankEvalCriterion(mode),
          minPassRate: mode.minPassRate,
          replayPolicy: {
            strategy: "failures_then_regression",
            statePath: "./materials/.blank-eval-replay-policy/merged-skill-blank-eval-plan.json",
          },
          required: true,
          blocking: mode.successCriterion !== "report_only",
          validation: {
            target: "product",
            stage: "post_merge",
            answerAccess: "private_oracle",
            allowedAudiences: ["merger", "repair_agent", "dashboard", "memory", "audit"],
          },
        },
      ],
      initialGraph: {
        planner_summary: "The generated task has a single merge unit followed by completion validators.",
        completion_validator_ids: completionValidatorIDs,
        units: [
          {
            id: "merge-skills",
            title: "Merge source skills",
            goal: "Read the source skills, merge reusable lessons into workspace/merged-skill, and satisfy the merge contract.",
            inputs: ["./00-task-entry.md", "./materials/input-manifest.json", "./materials/merge-contract.json"],
            depends_on: [],
            expected_artifacts: ["./workspace/merged-skill/INDEX.md", "./workspace/merged-skill/CORE.md"],
            claim: "Merged skill package has been written.",
            check_plan: "Completion validators will check surface quality and blank replay.",
            validator_ids: [],
            retry_budget: 1,
          },
        ],
      },
      budgets: {
        maxAttemptsPerUnit: 1,
        maxTotalUnitAttempts: 3,
        maxGraphReplans: 1,
        maxValidatorCalls: 20,
        maxNoProgressCycles: 4,
        maxUnitsPerGraph: 4,
      },
      notes: `Generated by create-merge-long-task-pack using blank acceptance scenario ${scenario} and mode ${modeID}.`,
    }

    if (!input.dryRun) {
      await ensureDirectory(taskDir)
      await writeTextFile(
        path.join(taskDir, "00-task-entry.md"),
        taskEntryMarkdown({ groupID, caseCount: group.length, validatorProfiles }),
      )
      await writeJsonFile(path.join(materialsDir, "input-manifest.json"), { schema: "merge-input-manifest/v1", items: manifest })
      await writeJsonFile(path.join(materialsDir, "replay-plan.json"), plan)
      await writeJsonFile(path.join(materialsDir, "merge-contract.json"), {
        schema: "merge-contract-pointer/v1",
        contractRef: config.mergeConfig.defaultContract,
        taskPackContracts: config.mergeConfig.taskPackContracts,
      })
      await writeSeedSkill(workspaceDir, groupID)
      await writeJsonFile(path.join(taskDir, "spec.json"), spec)
      await writeJsonFile(path.join(taskDir, "campaign.json"), {
        title: `${input.label ?? path.basename(outTaskPack)}-${groupID}`,
        taskFamily: "merge-long-task",
        mode: "graph_iterative",
        baseSpecPath: "./spec.json",
        maxRounds: 3,
        seedTargets: [
          {
            targetPath: "./workspace/merged-skill",
            seedPath: "./workspace/merged-skill",
            kind: "experience_workspace",
            resetOnStart: false,
          },
        ],
      })
    }
    generated.push({ groupID, specPath: path.join(taskDir, "spec.json"), caseCount: group.length, replayCaseCount: replayCases.length })
  }

  if (!input.dryRun) {
    await writeJsonFile(path.join(outTaskPack, "dataset-summary.json"), {
      schema: "merge-long-task-pack-summary/v1",
      label: input.label ?? path.basename(outTaskPack),
      sourceTaskPackRoot: normalizeSlash(taskPackRoot),
      sourceSplitPath: normalizeSlash(splitPath),
      sourceCampaignManifestPath: normalizeSlash(manifestPath),
      blankAcceptanceScenario: scenario,
      blankAcceptanceMode: modeID,
      generated,
    })
  }

  return {
    outTaskPack,
    selected: filteredRows.length,
    groups: generated,
    validatorProfiles,
    profileValidatorIDs,
    blankAcceptanceScenario: scenario,
    blankAcceptanceMode: modeID,
  }
}

function readArg(flag: string) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const cwd = path.resolve(import.meta.dir, "..", "..")
  const taskPackRoot = readArg("--task-pack-root")
  const splitPath = readArg("--split")
  const campaignManifestPath = readArg("--campaign-manifest")
  const outTaskPack = readArg("--out-task-pack")
  if (!taskPackRoot || !splitPath || !campaignManifestPath || !outTaskPack) {
    throw new Error("--task-pack-root, --split, --campaign-manifest and --out-task-pack are required")
  }
  const result = await createMergeLongTaskPack({
    cwd,
    taskPackRoot,
    splitPath,
    campaignManifestPath,
    outTaskPack,
    label: readArg("--label"),
    groupSize: readArg("--group-size") ? Number(readArg("--group-size")) : undefined,
    maxGroups: readArg("--max-groups") ? Number(readArg("--max-groups")) : undefined,
    replayConcurrency: readArg("--replay-concurrency") ? Number(readArg("--replay-concurrency")) : undefined,
    surfaceProfileSet: readArg("--surface-profile-set"),
    surfaceValidatorProfiles: readArg("--surface-validator-profiles")?.split(",").map((item) => item.trim()).filter(Boolean),
    blankAcceptanceMode: readArg("--blank-acceptance-mode"),
    blankAcceptanceScenario: readArg("--blank-acceptance-scenario"),
    inputSelection: readArg("--input-selection") as CreateMergeLongTaskPackInput["inputSelection"],
    allowMissingManifestRows: process.argv.includes("--allow-missing-manifest-rows"),
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
