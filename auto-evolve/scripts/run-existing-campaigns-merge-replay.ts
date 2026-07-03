import path from "node:path"
import { readFile } from "node:fs/promises"
import { createCoordinatorRun } from "../orchestrator/multi-instance/coordinator"
import { runCoordinatorPhase2Merge } from "../orchestrator/multi-instance/merger"
import { runCoordinatorPhase3Validate } from "../orchestrator/multi-instance/validator"
import { saveCoordinatorState } from "../orchestrator/multi-instance/repository"
import { ensureDirectory, pathExists, writeJsonFile } from "../orchestrator/fs"
import { loadConfig } from "../orchestrator/schema"

type CampaignManifestRow = {
  id: string
  campaignDir: string
  status?: string
  harvestedSkillPath?: string
}

type CampaignManifest = {
  rows?: CampaignManifestRow[]
  campaigns?: CampaignManifestRow[]
}

type Args = {
  taskPackRoot: string
  split: string
  campaignManifest: string
  out: string
  label: string
  replayConcurrency: number
  validateRounds: number
  repairAttempts: number
  dryRun: boolean
  promptPath?: string
  repairPromptPath?: string
  contractPath?: string
}

const repoRoot = process.cwd()

function getOption(args: string[], name: string) {
  const idx = args.indexOf(name)
  if (idx < 0) return undefined
  return args[idx + 1]
}

function parsePositiveInt(raw: string | undefined, fallback: number) {
  if (!raw) return fallback
  const got = Number.parseInt(raw, 10)
  if (!Number.isFinite(got) || got < 1) return fallback
  return got
}

function requireOption(args: string[], name: string) {
  const got = getOption(args, name)
  if (!got || got.trim().length === 0) throw new Error(`Missing required option: ${name}`)
  return got
}

function parseArgs(argv: string[]): Args {
  return {
    taskPackRoot: path.resolve(repoRoot, requireOption(argv, "--task-pack-root")),
    split: path.resolve(repoRoot, requireOption(argv, "--split")),
    campaignManifest: path.resolve(repoRoot, requireOption(argv, "--campaign-manifest")),
    out: path.resolve(repoRoot, requireOption(argv, "--out")),
    label: getOption(argv, "--label") ?? "existing-campaigns-merge-replay",
    replayConcurrency: parsePositiveInt(getOption(argv, "--replay-concurrency"), 2),
    validateRounds: parsePositiveInt(getOption(argv, "--validate-rounds"), 1),
    repairAttempts: parsePositiveInt(getOption(argv, "--repair-attempts"), 1),
    dryRun: argv.includes("--dry-run"),
    promptPath: getOption(argv, "--prompt-path")
      ? path.resolve(repoRoot, getOption(argv, "--prompt-path")!)
      : undefined,
    repairPromptPath: getOption(argv, "--repair-prompt-path")
      ? path.resolve(repoRoot, getOption(argv, "--repair-prompt-path")!)
      : undefined,
    contractPath: getOption(argv, "--merge-contract-path")
      ? path.resolve(repoRoot, getOption(argv, "--merge-contract-path")!)
      : undefined,
  }
}

function withJsonExtension(input: string) {
  return input.toLowerCase().endsWith(".json") ? input : `${input}.json`
}

function resolveAutoEvolvePath(input: string | undefined) {
  const value = input?.trim()
  if (!value) return undefined
  if (path.isAbsolute(value)) return value
  return path.resolve(repoRoot, "auto-evolve", value)
}

async function resolveMergeControl(args: Args) {
  const cfg = await loadConfig(repoRoot)
  const mergeConfig = cfg.mergeConfig
  if (!mergeConfig.enabled) {
    return {
      promptPath: args.promptPath,
      repairPromptPath: args.repairPromptPath,
      contractPath: args.contractPath,
    }
  }
  const taskPackName = path.basename(args.taskPackRoot)
  const contractRef = mergeConfig.taskPackContracts[taskPackName] ?? mergeConfig.defaultContract
  return {
    promptPath: args.promptPath ?? resolveAutoEvolvePath(mergeConfig.defaultPrompt),
    repairPromptPath: args.repairPromptPath ?? resolveAutoEvolvePath(mergeConfig.defaultRepairPrompt),
    contractPath:
      args.contractPath ??
      resolveAutoEvolvePath(path.join(mergeConfig.contractsRoot, withJsonExtension(contractRef))),
  }
}

async function readJson<T>(file: string): Promise<T> {
  const raw = await readFile(file, "utf8")
  return JSON.parse(raw.replace(/^\uFEFF/, "")) as T
}

async function readSplitIDs(file: string) {
  const raw = await readJson<unknown>(file)
  if (Array.isArray(raw)) return raw.map((item) => String(item))
  if (raw && typeof raw === "object" && Array.isArray((raw as { ids?: unknown[] }).ids)) {
    return (raw as { ids: unknown[] }).ids.map((item) => String(item))
  }
  throw new Error(`Unsupported split format: ${file}`)
}

async function readManifest(file: string) {
  const raw = await readJson<CampaignManifest | CampaignManifestRow[]>(file)
  const rows = Array.isArray(raw) ? raw : raw.rows ?? raw.campaigns ?? []
  if (!rows.length) throw new Error(`Campaign manifest is empty: ${file}`)
  const out = new Map<string, CampaignManifestRow>()
  for (const row of rows) {
    if (!row.id || !row.campaignDir) throw new Error(`Invalid campaign manifest row: ${JSON.stringify(row)}`)
    out.set(row.id, {
      ...row,
      campaignDir: path.resolve(repoRoot, row.campaignDir),
      harvestedSkillPath: row.harvestedSkillPath ? path.resolve(repoRoot, row.harvestedSkillPath) : undefined,
    })
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const mergeControl = await resolveMergeControl(args)
  await ensureDirectory(args.out)

  const ids = await readSplitIDs(args.split)
  const manifest = await readManifest(args.campaignManifest)
  const missing = ids.filter((id) => !manifest.has(id))
  if (missing.length) throw new Error(`Campaign manifest missing split IDs: ${missing.join(", ")}`)

  const state = await createCoordinatorRun({
    cwd: repoRoot,
    runRoot: path.join(args.out, "merge-and-validate"),
    label: args.label,
    rounds: args.validateRounds,
    instances: ids.map((id) => ({
      id,
      sourceTaskRoot: path.join(args.taskPackRoot, "tasks", id),
      engine: "skillsbench" as const,
      skillsbenchRoot: args.taskPackRoot,
      taskID: id,
      role: "train" as const,
    })),
    fanoutLimit: args.replayConcurrency,
  })

  const now = new Date().toISOString()
  for (const instance of state.instances) {
    const row = manifest.get(instance.id)!
    const skillPath = row.harvestedSkillPath ?? path.join(row.campaignDir, "pending-expert-package", "current")
    if (!(await pathExists(skillPath))) {
      throw new Error(`Harvested skill path does not exist for ${instance.id}: ${skillPath}`)
    }
    instance.status = "passed"
    instance.finishedAt = now
    instance.campaignDir = row.campaignDir
    instance.harvestedSkillPath = skillPath
  }
  await saveCoordinatorState(state)
  await writeJsonFile(path.join(args.out, "existing-campaign-input.json"), {
    taskPackRoot: args.taskPackRoot,
    split: args.split,
    campaignManifest: args.campaignManifest,
    ids,
    rows: state.instances.map((instance) => ({
      id: instance.id,
      campaignDir: instance.campaignDir,
      harvestedSkillPath: instance.harvestedSkillPath,
    })),
  })

  if (args.dryRun) {
    await writeJsonFile(path.join(args.out, "dry-run-ok.json"), {
      ok: true,
      idCount: ids.length,
      replayConcurrency: args.replayConcurrency,
      validateRounds: args.validateRounds,
      repairAttempts: args.repairAttempts,
      promptPath: mergeControl.promptPath,
      repairPromptPath: mergeControl.repairPromptPath,
      contractPath: mergeControl.contractPath,
      coordinatorStatePath: path.join(state.runRoot, "coordinator-state.json"),
    })
    return
  }

  const merge = await runCoordinatorPhase2Merge({
    cwd: repoRoot,
    state,
    promptPath: mergeControl.promptPath,
    contractPath: mergeControl.contractPath,
  })
  state.mergedSkillDir = merge.mergedSkillDir
  await saveCoordinatorState(state)
  await writeJsonFile(path.join(args.out, "merge-output.json"), merge)

  const replay = await runCoordinatorPhase3Validate({
    cwd: repoRoot,
    state,
    rounds: args.validateRounds,
    validateLimit: args.replayConcurrency,
    filter: (instance) => instance.role !== "test" && instance.status === "passed",
    repair:
      args.repairAttempts > 0
        ? {
            enabled: true,
            mode: "append_only",
            maxAttemptsPerCase: args.repairAttempts,
            promptPath: mergeControl.repairPromptPath,
            contractPath: mergeControl.contractPath,
          }
        : undefined,
  })
  await writeJsonFile(path.join(args.out, "train-replay-output.json"), replay)
  await writeJsonFile(path.join(args.out, "summary.json"), {
    label: args.label,
    mergedSkillDir: merge.mergedSkillDir,
    merge,
    replay,
  })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
