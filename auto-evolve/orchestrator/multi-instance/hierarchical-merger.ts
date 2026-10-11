import path from "node:path"
import { cp, rename } from "node:fs/promises"
import { ensureDirectory, pathExists, readTextFile, writeJsonFile, writeTextFile } from "../fs"
import { loadConfig } from "../schema"
import { runOpencodeTask } from "../opencode"
import { runBlankEval } from "../blank-eval/runner"
import type { LongTaskSpec, LongTaskValidatorContract, LongTaskWorkUnit } from "../long-task/contract"
import { loadLongTaskSpec } from "../long-task/spec"
import { selectValidationModules } from "../validation-engine/registry"
import { runValidationStage } from "../validation-engine/stage-runner"
import { buildAccessProfile } from "../access-profile"
import type { CoordinatorState, InstanceState } from "./contract"
import { appendCoordinatorLog, saveCoordinatorState } from "./repository"
import { auditMergeOutput, leafSourceIDs, type MergeOutputAudit } from "./merge-output-validation"

export type HierarchicalMergeInputFilter = "success_only" | "failed_only" | "all"
export type HierarchicalMergeFailurePolicy = "exclude" | "negative_evidence" | "diagnostic_only"
export type HierarchicalMergeGrouping = "sequential" | "status_balanced"
export type HierarchicalReplayLevels = "none" | "level1" | "all"

export interface HierarchicalMergeOptions {
  groupSize: number
  inputFilter: HierarchicalMergeInputFilter
  failurePolicy: HierarchicalMergeFailurePolicy
  grouping: HierarchicalMergeGrouping
  /** Number of merge groups that may run concurrently within one level. */
  concurrency?: number
  /** Number of local replay blank-eval checks that may run concurrently inside one group. */
  localReplayConcurrency?: number
  /** Number of retries for blank-eval infrastructure failures. */
  localReplayInfrastructureRetries?: number
  /** Abort the merge instead of treating persistent infrastructure failures as model failures. */
  localReplayFailClosedOnInfrastructure?: boolean
  promptPath?: string
  repairPromptPath?: string
  contractPath?: string
  model?: string
  /** Reuse fully materialized groups when resuming the same run directory. */
  resumeExistingGroups?: boolean
  /** Optional hard UTF-8 byte cap for the final deployable CORE.md only. */
  maxFinalCoreBytes?: number
  /** Maximum complete rewrites allowed when the final CORE.md exceeds its cap. */
  finalCoreLengthRepairAttempts?: number
  localReplay?: {
    enabled: boolean
    levels: HierarchicalReplayLevels
    repairOnFailure: boolean
    repairAttemptsPerCase: number
    rerunAfterRepair: boolean
  }
}

export interface HierarchicalMergeOutcome {
  mergedSkillDir: string
  contributingInstances: string[]
  mergerRunDir: string
  reportPath: string
  reportMarkdownPath: string
  levels: Array<{
    level: number
    groups: Array<{
      groupID: string
      outputDir: string
      inputCount: number
      statusCounts: Record<string, number>
      postMergeValidation?: {
        status: "passed" | "failed" | "skipped"
        resultPath?: string
        summary: string
      }
      localReplay?: {
        total: number
        passed: number
        failed: number
        repaired: number
        infrastructureSkipped?: number
      }
    }>
  }>
}

type MergeItem = {
  id: string
  role: "train" | "test"
  status: string
  sourceTaskRoot: string
  skillPath?: string
  sourceKind: "instance" | "merged_group"
  mergeRole: "positive_method_source" | "negative_evidence_source" | "diagnostic_source"
  promotionPolicy: string
  roundsUsed?: number
  maxRounds?: number
  campaignDir?: string
  finalAcceptancePassed?: boolean
  surfacePrecheckPassed?: boolean
  notes: string[]
}

type MergeGroupResult = {
  groupID: string
  outputDir: string
  manifestPath: string
  statusCounts: Record<string, number>
  inputItems: MergeItem[]
  localReplay?: {
    total: number
    passed: number
    failed: number
    repaired: number
    infrastructureSkipped?: number
    rows: ReplayRow[]
  }
}

type ReplayRow = { id: string; passed: boolean; repaired: boolean; runDir?: string; summary?: string }
type ReplayCheckpoint = ReplayRow & { infrastructureSkipped?: boolean }

type HierarchicalPostMergeValidation = {
  status: "passed" | "failed" | "skipped"
  resultPath?: string
  summary: string
}

const DEFAULT_PROMPT_REL = "methods/recipes/multi-instance/prompts/hierarchical-merge-generic.md"
const DEFAULT_REPAIR_PROMPT_REL = "methods/recipes/multi-instance/prompts/hierarchical-merge-repair.md"
const GENERIC_CONTRACT_FALLBACK = JSON.stringify(
  {
    id: "inline/generic-hierarchical-fallback",
    requiredFiles: ["INDEX.md", "CORE.md", "meta.json"],
    requiredDirectories: ["casebook"],
    notes: [
      "Use this only when no merge contract file was configured.",
      "Keep CORE.md generic and place case-specific details under casebook/.",
    ],
  },
  null,
  2,
)

function nowISO() {
  return new Date().toISOString()
}

function statusCounts(items: MergeItem[]) {
  const out: Record<string, number> = {}
  for (const item of items) out[item.status] = (out[item.status] ?? 0) + 1
  return out
}

function isPositiveStatus(status: string) {
  return status === "passed" || status === "verified_success" || status === "success"
}

function isFailedStatus(status: string) {
  return !isPositiveStatus(status)
}

function promotionFor(input: { status: string; surfacePrecheckPassed?: boolean }) {
  if (isPositiveStatus(input.status) && input.surfacePrecheckPassed === false) return "promote_methods_only_no_literals"
  if (isPositiveStatus(input.status)) return "promote_cross_confirmed_methods"
  if (input.status === "exhausted" || input.status === "round_limit_reached") return "negative_evidence_only"
  return "diagnostic_only"
}

function mergeRoleFor(status: string): MergeItem["mergeRole"] {
  if (isPositiveStatus(status)) return "positive_method_source"
  if (status === "exhausted" || status === "round_limit_reached") return "negative_evidence_source"
  return "diagnostic_source"
}

function normalizeInputFilter(value: HierarchicalMergeInputFilter) {
  return value === "success_only" ? "success_only" : value === "failed_only" ? "failed_only" : "all"
}

function selectItems(items: MergeItem[], options: HierarchicalMergeOptions) {
  const filter = normalizeInputFilter(options.inputFilter)
  return items.filter((item) => {
    if (filter === "success_only") return isPositiveStatus(item.status)
    if (filter === "failed_only") return isFailedStatus(item.status)
    if (options.failurePolicy === "exclude") return isPositiveStatus(item.status)
    return true
  })
}

function groupSequential<T>(items: T[], size: number) {
  const groups: T[][] = []
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size))
  return groups
}

function groupStatusBalanced(items: MergeItem[], size: number) {
  const positives = items.filter((item) => isPositiveStatus(item.status))
  const negatives = items.filter((item) => !isPositiveStatus(item.status))
  const interleaved: MergeItem[] = []
  const max = Math.max(positives.length, negatives.length)
  for (let i = 0; i < max; i += 1) {
    if (positives[i]) interleaved.push(positives[i]!)
    if (negatives[i]) interleaved.push(negatives[i]!)
  }
  return groupSequential(interleaved, size)
}

function groupItems(items: MergeItem[], size: number, grouping: HierarchicalMergeGrouping) {
  if (grouping === "status_balanced") return groupStatusBalanced(items, size)
  return groupSequential(items, size)
}

async function copyTree(source: string, target: string) {
  await ensureDirectory(path.dirname(target))
  await cp(source, target, { recursive: true, force: true })
}

async function bootstrapMergeOutput(outputDir: string) {
  await ensureDirectory(path.join(outputDir, "casebook"))
  await ensureDirectory(path.join(outputDir, "evidence"))
  await ensureDirectory(path.join(outputDir, "patches"))
}

function itemFromInstance(instance: InstanceState): MergeItem {
  const notes: string[] = []
  if (!instance.harvestedSkillPath) notes.push("No harvested skill path; use metadata only.")
  if (instance.errorMessage) notes.push(instance.errorMessage)
  return {
    id: instance.id,
    role: instance.role,
    status: instance.status,
    sourceTaskRoot: instance.sourceTaskRoot,
    skillPath: instance.harvestedSkillPath,
    sourceKind: "instance",
    mergeRole: mergeRoleFor(instance.status),
    promotionPolicy: promotionFor({ status: instance.status }),
    maxRounds: instance.rounds,
    campaignDir: instance.campaignDir,
    finalAcceptancePassed: instance.status === "passed",
    notes,
  }
}

function itemFromGroup(group: MergeGroupResult, level: number): MergeItem {
  const passed = group.inputItems.filter((item) => isPositiveStatus(item.status)).length
  const failed = group.inputItems.length - passed
  return {
    id: group.groupID,
    role: "train",
    status: group.localReplay && group.localReplay.failed > 0 ? "merged_with_repaired_replay_failures" : "merged_group",
    sourceTaskRoot: path.dirname(group.manifestPath),
    skillPath: group.outputDir,
    sourceKind: "merged_group",
    mergeRole: "positive_method_source",
    promotionPolicy: "promote_cross_group_confirmed_methods",
    finalAcceptancePassed: group.localReplay ? group.localReplay.failed === 0 : undefined,
    surfacePrecheckPassed: undefined,
    notes: [
      `Merged group from level ${level}.`,
      `Input positives: ${passed}. Input non-positives: ${failed}.`,
      ...(group.localReplay
        ? [
            `Local replay ${group.localReplay.passed}/${group.localReplay.total}, repaired=${group.localReplay.repaired}, infrastructureSkipped=${group.localReplay.infrastructureSkipped ?? 0}.`,
          ]
        : []),
    ],
  }
}

async function buildPrompt(input: {
  cwd: string
  options: HierarchicalMergeOptions
  level: number
  groupID: string
  outputDir: string
  manifestPath: string
  items: MergeItem[]
}) {
  const promptPath = input.options.promptPath ?? path.join(input.cwd, "auto-evolve", DEFAULT_PROMPT_REL)
  const base = await readTextFile(promptPath)
  const contract = input.options.contractPath
    ? await readTextFile(input.options.contractPath)
    : GENERIC_CONTRACT_FALLBACK
  return [
    base.trim(),
    "",
    "# Merge Contract",
    "",
    "The following contract is authoritative for this dataset's merged skill file structure, allowed sections, and promotion rules.",
    "If this contract conflicts with generic wording in the prompt, follow this contract.",
    "",
    "```json",
    contract.trim(),
    "```",
    "",
    "# Runtime Merge Assignment",
    "",
    `mergeLevel: ${input.level}`,
    `groupID: ${input.groupID}`,
    `outputDir: ${input.outputDir}`,
    `inputManifestPath: ${input.manifestPath}`,
    "",
    "Read the manifest JSON first. Then read each input skill path that exists.",
    "Write the required output files directly to outputDir.",
    "",
    "# Input Summary",
    "",
    ...input.items.map((item) => {
      return `- ${item.id}: status=${item.status}; role=${item.mergeRole}; policy=${item.promotionPolicy}; skill=${item.skillPath ?? "(metadata-only)"}`
    }),
  ].join("\n")
}

async function runMergeGroup(input: {
  cwd: string
  state: CoordinatorState
  runRoot: string
  options: HierarchicalMergeOptions
  level: number
  groupIndex: number
  items: MergeItem[]
}) {
  const groupID = `level-${String(input.level).padStart(2, "0")}-group-${String(input.groupIndex + 1).padStart(3, "0")}`
  const root = path.join(input.runRoot, `level-${input.level}`, groupID)
  const outputDir = path.join(root, "output")
  const manifestPath = path.join(root, "input-manifest.json")
  await bootstrapMergeOutput(outputDir)
  const manifest = {
    schema: "auto-evolve/hierarchical-merge-group/v1",
    createdAt: nowISO(),
    stateID: input.state.id,
    mergeLevel: input.level,
    groupID,
    outputDir,
    mergeContractPath: input.options.contractPath,
    statusCounts: statusCounts(input.items),
    inputs: input.items,
  }
  await writeJsonFile(manifestPath, manifest)
  const prompt = await buildPrompt({
    cwd: input.cwd,
    options: input.options,
    level: input.level,
    groupID,
    outputDir,
    manifestPath,
    items: input.items,
  })
  await writeTextFile(path.join(root, "prompt.txt"), prompt)
  const config = await loadConfig(input.cwd)
  const readPaths = [
    manifestPath,
    ...(input.options.contractPath ? [input.options.contractPath] : []),
    ...input.items.map((item) => item.skillPath).filter((item): item is string => !!item),
  ]
  const access = await buildAccessProfile({
    role: "hierarchical_merger",
    mode: "open_book",
    readPaths,
    editPaths: [outputDir],
  })
  const result = await runOpencodeTask({
    cwd: input.cwd,
    config,
    title: `hierarchical-merge-${input.state.id}-${groupID}`,
    prompt,
    referencePaths: access.referencePaths,
    permissionReadPaths: access.permissionReadPaths,
    permissionEditPaths: access.permissionEditPaths,
    concurrencyScope: `hierarchical-merge:${input.state.id}`,
    model: input.options.model,
    // 合并只需文件读写，禁用 shell 防止越界。
    allowShell: false,
  })
  await writeTextFile(path.join(root, "stdout.log"), result.result.stdout)
  await writeTextFile(path.join(root, "stderr.log"), result.result.stderr)
  await writeTextFile(path.join(root, "response.txt"), result.result.responseText)
  // 空产物不能晋升到上一层，否则会悄悄丢失整组来源。
  let audit = await auditMergeOutput({
    outputDir,
    contractPath: input.options.contractPath,
    expectedSourceIDs: await leafSourceIDs(input.items),
  })
  await writeJsonFile(path.join(root, "output-files.json"), audit.files)
  await writeJsonFile(path.join(root, "output-audit.json"), audit)
  if (!audit.passed && audit.files.length > 0 && audit.missingSourceIDs.length === 0) {
    audit = await repairMergeOutput({
      cwd: input.cwd,
      stateID: input.state.id,
      groupID,
      root,
      outputDir,
      items: input.items,
      options: input.options,
      audit,
    })
  }
  if (result.result.exitCode !== 0 || !audit.passed) {
    throw new Error(`Hierarchical merge ${groupID} invalid output: exit=${result.result.exitCode}, missing=${audit.missing.join(",")}, empty=${audit.empty.join(",")}, invalidJson=${audit.invalidJson.join(",")}, missingSources=${audit.missingSourceIDs.join(",")}`)
  }
  return {
    groupID,
    outputDir,
    manifestPath,
    statusCounts: statusCounts(input.items),
    inputItems: input.items,
  } satisfies MergeGroupResult
}

async function repairMergeOutput(input: {
  cwd: string
  stateID: string
  groupID: string
  root: string
  outputDir: string
  items: MergeItem[]
  options: HierarchicalMergeOptions
  audit: MergeOutputAudit
}): Promise<MergeOutputAudit> {
  const config = await loadConfig(input.cwd)
  const readPaths = [
    path.join(input.root, "input-manifest.json"),
    input.outputDir,
    ...(input.options.contractPath ? [input.options.contractPath] : []),
    ...input.items.map((item) => item.skillPath).filter((item): item is string => !!item),
  ]
  const access = await buildAccessProfile({
    role: "hierarchical_merger",
    mode: "open_book",
    readPaths,
    editPaths: [input.outputDir],
  })
  let audit = input.audit
  for (let attempt = 1; attempt <= 2 && !audit.passed; attempt += 1) {
    const prompt = [
      "Repair an incomplete hierarchical merge output in place. Read the input manifest, contract, existing output, and source Skills.",
      `groupID: ${input.groupID}`,
      `outputDir: ${input.outputDir}`,
      `missing files: ${audit.missing.join(", ") || "none"}`,
      `empty files: ${audit.empty.join(", ") || "none"}`,
      `invalid JSON files: ${audit.invalidJson.join(", ") || "none"}`,
      `missing source IDs in PROVENANCE.json: ${audit.missingSourceIDs.join(", ") || "none"}`,
      "Fill the missing required files and repair only invalid content. Preserve existing correct procedures and every input source. Do not include private answers or final task values. Write files only to outputDir. Do not respond with narrative.",
    ].join("\n")
    await writeTextFile(path.join(input.root, `output-repair-${attempt}.prompt.txt`), prompt)
    const result = await runOpencodeTask({
      cwd: input.cwd,
      config,
      title: `hierarchical-merge-repair-${input.stateID}-${input.groupID}-${attempt}`,
      prompt,
      referencePaths: access.referencePaths,
      permissionReadPaths: access.permissionReadPaths,
      permissionEditPaths: access.permissionEditPaths,
      concurrencyScope: `hierarchical-merge:${input.stateID}`,
      model: input.options.model,
      allowShell: false,
    })
    await writeTextFile(path.join(input.root, `output-repair-${attempt}.stdout.log`), result.result.stdout)
    await writeTextFile(path.join(input.root, `output-repair-${attempt}.stderr.log`), result.result.stderr)
    await writeTextFile(path.join(input.root, `output-repair-${attempt}.response.txt`), result.result.responseText)
    audit = await auditMergeOutput({
      outputDir: input.outputDir,
      contractPath: input.options.contractPath,
      expectedSourceIDs: await leafSourceIDs(input.items),
    })
    await writeJsonFile(path.join(input.root, "output-files.json"), audit.files)
    await writeJsonFile(path.join(input.root, "output-audit.json"), audit)
    if (result.result.exitCode !== 0) break
  }
  return audit
}

async function enforceFinalCoreLength(input: {
  cwd: string
  stateID: string
  groupID: string
  groupRoot: string
  outputDir: string
  options: HierarchicalMergeOptions
}) {
  const cap = input.options.maxFinalCoreBytes
  if (!cap || cap <= 0) return true
  const corePath = path.join(input.outputDir, "CORE.md")
  const attempts = Math.max(0, input.options.finalCoreLengthRepairAttempts ?? 0)
  const config = await loadConfig(input.cwd)
  const records: Array<{ attempt: number; bytes: number; status: string }> = []

  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    const bytes = Buffer.byteLength(await readTextFile(corePath), "utf8")
    if (bytes <= cap) {
      records.push({ attempt, bytes, status: "within_limit" })
      await writeJsonFile(path.join(input.groupRoot, "final-core-length-gate.json"), { capBytes: cap, records })
      return true
    }
    records.push({ attempt, bytes, status: "over_limit" })
    if (attempt === attempts) break
    const prompt = [
      "Rewrite only CORE.md in the specified merged skill directory.",
      `The current file is ${bytes} UTF-8 bytes; the mandatory hard limit is ${cap} bytes.`,
      "Preserve the operational method and remove redundancy. Do not truncate mechanically, do not edit other files, and do not add case-specific answers.",
      `outputDir: ${input.outputDir}`,
      `corePath: ${corePath}`,
    ].join("\n")
    const result = await runOpencodeTask({
      cwd: input.cwd,
      config,
      title: `hierarchical-final-core-length-repair-${input.stateID}-${input.groupID}-${attempt + 1}`,
      prompt,
      referencePaths: [corePath],
      permissionReadPaths: [input.outputDir],
      permissionEditPaths: [input.outputDir],
      concurrencyScope: `hierarchical-merge:${input.stateID}`,
      model: input.options.model,
      // 长度修复只能改合并产物，避免越界读取或写入。
      allowShell: false,
    })
    await writeTextFile(path.join(input.groupRoot, `final-core-length-repair-${attempt + 1}.stdout.log`), result.result.stdout)
    await writeTextFile(path.join(input.groupRoot, `final-core-length-repair-${attempt + 1}.stderr.log`), result.result.stderr)
    await writeTextFile(path.join(input.groupRoot, `final-core-length-repair-${attempt + 1}.response.txt`), result.result.responseText)
    if (result.result.exitCode !== 0) break
  }
  const finalBytes = await pathExists(corePath) ? Buffer.byteLength(await readTextFile(corePath), "utf8") : -1
  records.push({ attempt: records.length, bytes: finalBytes, status: "rejected_over_limit" })
  await writeJsonFile(path.join(input.groupRoot, "final-core-length-gate.json"), { capBytes: cap, records })
  return false
}

async function loadCompletedMergeGroup(input: {
  root: string
  groupID: string
  items: MergeItem[]
  contractPath?: string
}): Promise<MergeGroupResult | undefined> {
  const outputDir = path.join(input.root, "output")
  const manifestPath = path.join(input.root, "input-manifest.json")
  const required = [
    path.join(input.root, "response.txt"),
    path.join(input.root, "output-files.json"),
    manifestPath,
    path.join(outputDir, "INDEX.md"),
    path.join(outputDir, "CORE.md"),
    path.join(outputDir, "meta.json"),
  ]
  for (const file of required) {
    if (!(await pathExists(file))) return undefined
  }
  const manifest = JSON.parse(await readTextFile(manifestPath)) as {
    groupID?: string
    inputs?: Array<{ id?: string }>
  }
  const manifestIDs = Array.isArray(manifest.inputs) ? manifest.inputs.map((item) => String(item.id ?? "")) : []
  const expectedIDs = input.items.map((item) => item.id)
  if (manifest.groupID !== input.groupID || JSON.stringify(manifestIDs) !== JSON.stringify(expectedIDs)) return undefined
  const audit = await auditMergeOutput({
    outputDir,
    contractPath: input.contractPath,
    expectedSourceIDs: await leafSourceIDs(input.items),
  })
  if (!audit.passed) return undefined
  return {
    groupID: input.groupID,
    outputDir,
    manifestPath,
    statusCounts: statusCounts(input.items),
    inputItems: input.items,
  }
}

async function archiveIncompleteMergeGroup(root: string) {
  if (!(await pathExists(root))) return
  const archived = `${root}.interrupted-${Date.now()}`
  await rename(root, archived)
}

async function runLocalSuccessReplay(input: {
  cwd: string
  state: CoordinatorState
  group: MergeGroupResult
  groupRoot: string
  options: HierarchicalMergeOptions
}) {
  const replayTargets = input.group.inputItems.filter(
    (item) => item.sourceKind === "instance" && isPositiveStatus(item.status),
  )
  const rows: ReplayCheckpoint[] = []
  let passed = 0
  let repaired = 0
  let infrastructureSkipped = 0
  let next = 0
  let fatalInfrastructureError: Error | undefined
  const active = new Set<Promise<void>>()
  const limit = Math.max(1, input.options.localReplayConcurrency ?? 1)
  const checkpointRoot = path.join(input.groupRoot, "local-success-replay", "checkpoints")
  await ensureDirectory(checkpointRoot)
  async function saveCheckpoint(row: ReplayCheckpoint) {
    await writeJsonFile(path.join(checkpointRoot, `${row.id}.json`), row)
  }
  const pendingTargets: MergeItem[] = []
  for (const item of replayTargets) {
    const checkpointPath = path.join(checkpointRoot, `${item.id}.json`)
    if (!(await pathExists(checkpointPath))) {
      pendingTargets.push(item)
      continue
    }
    const row = JSON.parse(await readTextFile(checkpointPath)) as ReplayCheckpoint
    if (row.id !== item.id) throw new Error(`Replay checkpoint ID mismatch: ${checkpointPath}`)
    rows.push(row)
    if (row.passed) passed += 1
    if (row.repaired) repaired += 1
    if (row.infrastructureSkipped) infrastructureSkipped += 1
  }
  async function runItem(item: MergeItem) {
    const specPath = path.join(item.sourceTaskRoot, "spec.json")
    try {
      const infrastructureRetries = Math.max(0, input.options.localReplayInfrastructureRetries ?? 0)
      let result: Awaited<ReturnType<typeof runBlankEval>> | undefined
      for (let attempt = 0; attempt <= infrastructureRetries; attempt += 1) {
        const runRoot = path.join(
          input.groupRoot,
          "local-success-replay",
          item.id,
          `attempt-${String(attempt + 1).padStart(2, "0")}`,
        )
        result = await runBlankEval({
          cwd: input.cwd,
          specPath,
          skillRoots: [input.group.outputDir],
          runRoot,
          sourceID: `${input.group.groupID}:${item.id}:attempt-${attempt + 1}`,
          mode: "train-backtest",
          concurrencyScope: `hierarchical-local-replay:${input.state.id}`,
        })
        if (result.failureKind !== "validator_infrastructure") break
      }
      if (!result) throw new Error(`Blank replay produced no result for ${item.id}`)
      if (result.failureKind === "validator_infrastructure") {
        const message = `Hierarchical replay infrastructure failed for ${item.id}: ${result.summary}`
        if (input.options.localReplayFailClosedOnInfrastructure) {
          fatalInfrastructureError ??= new Error(message)
          return
        }
        const row: ReplayCheckpoint = {
          id: item.id,
          passed: false,
          repaired: false,
          infrastructureSkipped: true,
          runDir: result.runDir,
          summary: message,
        }
        infrastructureSkipped += 1
        rows.push(row)
        await saveCheckpoint(row)
        return
      }
      if (result.passed) {
        passed += 1
        const row = { id: item.id, passed: true, repaired: false, runDir: result.runDir, summary: result.summary }
        rows.push(row)
        await saveCheckpoint(row)
        return
      }
      const didRepair = result.failureKind !== "dataset_failure" && input.options.localReplay?.repairOnFailure
        ? await runOneShotRepair({
            cwd: input.cwd,
            state: input.state,
            group: input.group,
            groupRoot: input.groupRoot,
            item,
            failedRunDir: result.runDir,
            failedSummary: result.summary,
            options: input.options,
          })
        : false
      if (didRepair) repaired += 1
      const row = { id: item.id, passed: false, repaired: didRepair, runDir: result.runDir, summary: result.summary }
      rows.push(row)
      await saveCheckpoint(row)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (input.options.localReplayFailClosedOnInfrastructure) {
        fatalInfrastructureError ??= new Error(`Hierarchical replay crashed for ${item.id}: ${message}`)
        return
      }
      const row: ReplayCheckpoint = {
        id: item.id,
        passed: false,
        repaired: false,
        infrastructureSkipped: true,
        summary: message,
      }
      infrastructureSkipped += 1
      rows.push(row)
      await saveCheckpoint(row)
    }
  }
  while (next < pendingTargets.length || active.size > 0) {
    while (!fatalInfrastructureError && next < pendingTargets.length && active.size < limit) {
      const task = runItem(pendingTargets[next]!).finally(() => active.delete(task))
      active.add(task)
      next += 1
    }
    if (active.size > 0) await Promise.race(active)
    else if (fatalInfrastructureError) throw fatalInfrastructureError
  }
  const summary = {
    total: replayTargets.length,
    passed,
    failed: replayTargets.length - passed - infrastructureSkipped,
    repaired,
    infrastructureSkipped,
    rows,
  }
  input.group.localReplay = summary
  await writeJsonFile(path.join(input.groupRoot, "local-success-replay", "summary.json"), summary)
}

async function runOneShotRepair(input: {
  cwd: string
  state: CoordinatorState
  group: MergeGroupResult
  groupRoot: string
  item: MergeItem
  failedRunDir: string
  failedSummary: string
  options: HierarchicalMergeOptions
}) {
  const attempts = Math.max(0, input.options.localReplay?.repairAttemptsPerCase ?? 0)
  if (attempts <= 0) return false
  const repairRoot = path.join(input.groupRoot, "one-shot-repair", input.item.id)
  const draft = path.join(repairRoot, "draft-output")
  await copyTree(input.group.outputDir, draft)
  const manifestPath = path.join(repairRoot, "repair-manifest.json")
  const manifest = {
    schema: "auto-evolve/hierarchical-local-success-repair/v1",
    createdAt: nowISO(),
    groupID: input.group.groupID,
    caseID: input.item.id,
    baseGroupSkill: input.group.outputDir,
    draftGroupSkill: draft,
    originalSkillPath: input.item.skillPath,
    sourceTaskRoot: input.item.sourceTaskRoot,
    failedReplayRunDir: input.failedRunDir,
    failedSummary: input.failedSummary,
    mergeContractPath: input.options.contractPath,
    editPolicy: {
      "CORE.md": "append_only",
      "INDEX.md": "append_only",
      "casebook/*.md": "rewrite_allowed",
      "patches/*.md": "append_only",
      "patches/*.jsonl": "append_only",
      "meta.json": "rewrite_allowed",
      "surface_contract.json": "rewrite_allowed_but_surface_checked",
      "open_observations.md": "append_only",
    },
  }
  await writeJsonFile(manifestPath, manifest)
  const promptPath = input.options.repairPromptPath ?? path.join(input.cwd, "auto-evolve", DEFAULT_REPAIR_PROMPT_REL)
  const contract = input.options.contractPath
    ? await readTextFile(input.options.contractPath)
    : GENERIC_CONTRACT_FALLBACK
  const prompt = [
    (await readTextFile(promptPath)).trim(),
    "",
    "# Merge Contract",
    "",
    "The following contract is authoritative for what the repaired group skill may contain and how it should be organized.",
    "If this contract conflicts with generic wording in the repair prompt, follow this contract.",
    "",
    "```json",
    contract.trim(),
    "```",
    "",
    "# Repair Assignment",
    "",
    `repairManifestPath: ${manifestPath}`,
    `draftGroupSkill: ${draft}`,
    `baseGroupSkill: ${input.group.outputDir}`,
    `failedCaseID: ${input.item.id}`,
    "",
    "Read the repair manifest first. Edit only draftGroupSkill.",
  ].join("\n")
  await writeTextFile(path.join(repairRoot, "prompt.txt"), prompt)
  const config = await loadConfig(input.cwd)
  const access = await buildAccessProfile({
    role: "hierarchical_repair_agent",
    mode: "open_book",
    readPaths: [
      manifestPath,
      ...(input.options.contractPath ? [input.options.contractPath] : []),
      input.group.outputDir,
      ...(input.item.skillPath ? [input.item.skillPath] : []),
    ],
    editPaths: [draft],
  })
  const result = await runOpencodeTask({
    cwd: input.cwd,
    config,
    title: `hierarchical-repair-${input.state.id}-${input.group.groupID}-${input.item.id}`,
    prompt,
    referencePaths: access.referencePaths,
    permissionReadPaths: access.permissionReadPaths,
    permissionEditPaths: access.permissionEditPaths,
    concurrencyScope: `hierarchical-repair:${input.state.id}`,
  })
  await writeTextFile(path.join(repairRoot, "stdout.log"), result.result.stdout)
  await writeTextFile(path.join(repairRoot, "stderr.log"), result.result.stderr)
  await writeTextFile(path.join(repairRoot, "response.txt"), result.result.responseText)
  const child = Bun.spawn([process.execPath, "run", "scripts/validate-append-only-skill-patch.ts", input.group.outputDir, draft], {
    cwd: path.join(input.cwd, "auto-evolve"),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  await writeTextFile(path.join(repairRoot, "policy-check.stdout.json"), stdout)
  await writeTextFile(path.join(repairRoot, "policy-check.stderr.log"), stderr)
  if (code !== 0) return false
  input.group.outputDir = draft
  return true
}

function shouldReplayLevel(options: HierarchicalMergeOptions, level: number) {
  const local = options.localReplay
  if (!local?.enabled) return false
  if (local.levels === "none") return false
  if (local.levels === "all") return true
  return level === 1
}

async function loadPostMergeValidators(state: CoordinatorState) {
  const validators: LongTaskValidatorContract[] = []
  for (const instance of state.instances.filter((item) => item.role !== "test")) {
    const specPath = path.join(instance.sourceTaskRoot, "spec.json")
    try {
      const loaded = await loadLongTaskSpec(specPath, { allowMissingInitialExpertContextPaths: true })
      validators.push(...loaded.spec.validators)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await appendCoordinatorLog(state, "warn", `Hierarchical merge: could not load validators from ${instance.id}: ${message}`)
    }
  }
  const byID = new Map<string, LongTaskValidatorContract>()
  for (const validator of validators) byID.set(validator.id, validator)
  return Array.from(byID.values())
}

function buildHierarchicalPostMergeSpec(input: {
  state: CoordinatorState
  outputDir: string
  validators: LongTaskValidatorContract[]
}): LongTaskSpec {
  return {
    id: `hierarchical-post-merge-${input.state.id}`,
    title: `Hierarchical post-merge validation for ${input.state.label || input.state.id}`,
    goal: "Validate a hierarchical merged expert surface before it is replayed or merged upward.",
    materials: [{ path: input.outputDir, label: "merged skill", role: "experience-workspace" }],
    targetPaths: [{ path: input.outputDir, label: "merged skill", role: "experience-workspace" }],
    editablePaths: [],
    initialExpertContextPaths: [],
    formalPackageRoots: [input.outputDir],
    validators: input.validators,
    budgets: {
      maxAttemptsPerUnit: 1,
      maxTotalUnitAttempts: 1,
      maxGraphReplans: 0,
      maxValidatorCalls: input.validators.length || 1,
      maxNoProgressCycles: 1,
      maxUnitsPerGraph: 1,
    },
  }
}

function buildHierarchicalPostMergeUnit(input: {
  groupID: string
  manifestPath: string
  outputDir: string
  validators: LongTaskValidatorContract[]
}): LongTaskWorkUnit {
  return {
    id: `post-merge-${input.groupID}`,
    title: `Post-merge validation for ${input.groupID}`,
    goal: "Validate the hierarchical merge output before replay or upward merge.",
    inputs: [input.manifestPath, input.outputDir],
    dependsOn: [],
    expectedArtifacts: [input.outputDir],
    claim: `Hierarchical merged skill ${input.groupID} is ready for post_merge validation.`,
    checkPlan: "Run validation-engine post_merge modules against the merged skill output directory.",
    validatorIDs: input.validators.map((item) => item.id),
    retryBudget: 0,
    status: "active",
    attemptCount: 1,
  }
}

async function runHierarchicalPostMergeValidation(input: {
  cwd: string
  state: CoordinatorState
  config: Awaited<ReturnType<typeof loadConfig>>
  groupRoot: string
  groupID: string
  outputDir: string
  manifestPath: string
  validators: LongTaskValidatorContract[]
}): Promise<HierarchicalPostMergeValidation> {
  const selected = selectValidationModules({
    validators: input.validators,
    stage: "post_merge",
  })
  if (!selected.length) {
    return {
      status: "skipped",
      summary: "No post_merge validation modules configured.",
    }
  }

  const stageDir = path.join(input.groupRoot, "post-merge-validation")
  const bundlePath = path.join(stageDir, "bundle.json")
  const payload = {
    schema: "auto-evolve/hierarchical-post-merge-validation/v1",
    task: {
      id: input.state.id,
      title: input.state.label,
      phase: "post_merge",
      groupID: input.groupID,
      goal: "Validate hierarchical merged expert surface.",
    },
    targetPaths: [{ path: input.outputDir, label: "merged skill", role: "experience-workspace" }],
    expectedArtifacts: [input.outputDir],
    files: {
      merged_skill_dir: input.outputDir,
      input_manifest_path: input.manifestPath,
    },
  }
  await ensureDirectory(stageDir)
  await writeJsonFile(bundlePath, payload)
  const spec = buildHierarchicalPostMergeSpec({
    state: input.state,
    outputDir: input.outputDir,
    validators: input.validators,
  })
  const unit = buildHierarchicalPostMergeUnit({
    groupID: input.groupID,
    manifestPath: input.manifestPath,
    outputDir: input.outputDir,
    validators: input.validators,
  })
  const stage = await runValidationStage({
    cwd: input.cwd,
    config: input.config,
    spec,
    unit,
    stage: "post_merge",
    runID: `hierarchical-post-merge-${input.state.id}-${input.groupID}`,
    attempt: 1,
    stageDir,
    bundlePath,
    payload,
    validators: input.validators,
  })
  return {
    status: stage.passed ? "passed" : "failed",
    resultPath: stage.resultPath,
    summary: stage.summary,
  }
}

export async function runCoordinatorHierarchicalMerge(input: {
  cwd: string
  state: CoordinatorState
  options: HierarchicalMergeOptions
}): Promise<HierarchicalMergeOutcome> {
  const state = input.state
  state.phase = "phase2_merge"
  await saveCoordinatorState(state)
  const runRoot = path.join(state.runRoot, "phase2-hierarchical-merge")
  await ensureDirectory(runRoot)
  await appendCoordinatorLog(state, "info", `Hierarchical merge starting: groupSize=${input.options.groupSize}`)
  const config = await loadConfig(input.cwd)
  const postMergeValidators = await loadPostMergeValidators(state)

  const allItems = state.instances.map(itemFromInstance)
  const selected = selectItems(allItems, input.options)
  if (!selected.length) throw new Error("Hierarchical merge has no selected inputs.")
  await writeJsonFile(path.join(runRoot, "input-manifest.full.json"), {
    schema: "auto-evolve/hierarchical-merge-full/v1",
    createdAt: nowISO(),
    stateID: state.id,
    options: input.options,
    statusCounts: statusCounts(selected),
    inputs: selected,
  })

  let current = selected
  const levels: HierarchicalMergeOutcome["levels"] = []
  let level = 1
  while (current.length > 1) {
    const groups = groupItems(current, Math.max(2, input.options.groupSize), input.options.grouping)
    const levelOut: HierarchicalMergeOutcome["levels"][number] = { level, groups: [] }
    const next: MergeItem[] = []
    let groupIndex = 0
    const active = new Set<Promise<void>>()
    const groupLimit = Math.max(1, input.options.concurrency ?? 1)
    async function runOneGroup(i: number) {
      const groupRoot = path.join(runRoot, `level-${level}`, `level-${String(level).padStart(2, "0")}-group-${String(i + 1).padStart(3, "0")}`)
      const groupID = `level-${String(level).padStart(2, "0")}-group-${String(i + 1).padStart(3, "0")}`
      let group = input.options.resumeExistingGroups
        ? await loadCompletedMergeGroup({
            root: groupRoot,
            groupID,
            items: groups[i]!,
            contractPath: input.options.contractPath,
          })
        : undefined
      if (group) {
        await appendCoordinatorLog(state, "info", `Hierarchical merge ${groupID}: reused completed group.`)
      } else {
        const existingManifest = path.join(groupRoot, "input-manifest.json")
        const existingOutput = path.join(groupRoot, "output")
        if (input.options.resumeExistingGroups && await pathExists(existingManifest) && await pathExists(existingOutput)) {
          const manifest = JSON.parse(await readTextFile(existingManifest)) as { groupID?: string; inputs?: MergeItem[] }
          const expectedIDs = groups[i]!.map((item) => item.id)
          const storedIDs = manifest.inputs?.map((item) => item.id) ?? []
          if (manifest.groupID === groupID && JSON.stringify(storedIDs) === JSON.stringify(expectedIDs)) {
            const audit = await auditMergeOutput({
              outputDir: existingOutput,
              contractPath: input.options.contractPath,
              expectedSourceIDs: await leafSourceIDs(groups[i]!),
            })
            // 少整组来源时必须重新合并，补 UID 标签不能补回缺失的方法。
            if (!audit.passed && audit.files.length > 0 && audit.missingSourceIDs.length === 0) {
              const repaired = await repairMergeOutput({
                cwd: input.cwd,
                stateID: state.id,
                groupID,
                root: groupRoot,
                outputDir: existingOutput,
                items: groups[i]!,
                options: input.options,
                audit,
              })
              if (repaired.passed) {
                group = {
                  groupID,
                  outputDir: existingOutput,
                  manifestPath: existingManifest,
                  statusCounts: statusCounts(groups[i]!),
                  inputItems: groups[i]!,
                }
              }
            }
          }
        }
      }
      if (!group) {
        if (input.options.resumeExistingGroups) await archiveIncompleteMergeGroup(groupRoot)
        group = await runMergeGroup({
          cwd: input.cwd,
          state,
          runRoot,
          options: input.options,
          level,
          groupIndex: i,
          items: groups[i]!,
        })
      }
      if (groups.length === 1) {
        const lengthAccepted = await enforceFinalCoreLength({
          cwd: input.cwd,
          stateID: state.id,
          groupID: group.groupID,
          groupRoot,
          outputDir: group.outputDir,
          options: input.options,
        })
        if (!lengthAccepted) {
          throw new Error(`Hierarchical merge ${group.groupID} final CORE.md exceeds the configured hard byte cap.`)
        }
      }
      let postMergeValidation = await runHierarchicalPostMergeValidation({
        cwd: input.cwd,
        state,
        config,
        groupRoot,
        groupID: group.groupID,
        outputDir: group.outputDir,
        manifestPath: group.manifestPath,
        validators: postMergeValidators,
      })
      if (postMergeValidation.status === "failed") {
        await appendCoordinatorLog(
          state,
          "error",
          `Hierarchical merge ${group.groupID}: post_merge validation failed: ${postMergeValidation.summary}`,
        )
        throw new Error(`Hierarchical merge ${group.groupID} post_merge validation failed: ${postMergeValidation.summary}`)
      }
      if (shouldReplayLevel(input.options, level)) {
        await runLocalSuccessReplay({ cwd: input.cwd, state, group, groupRoot, options: input.options })
        if ((group.localReplay?.repaired ?? 0) > 0) {
          postMergeValidation = await runHierarchicalPostMergeValidation({
            cwd: input.cwd,
            state,
            config,
            groupRoot,
            groupID: `${group.groupID}-after-repair`,
            outputDir: group.outputDir,
            manifestPath: group.manifestPath,
            validators: postMergeValidators,
          })
          if (postMergeValidation.status === "failed") {
            await appendCoordinatorLog(
              state,
              "error",
              `Hierarchical merge ${group.groupID}: post-repair post_merge validation failed: ${postMergeValidation.summary}`,
            )
            throw new Error(
              `Hierarchical merge ${group.groupID} post-repair post_merge validation failed: ${postMergeValidation.summary}`,
            )
          }
        }
      }
      levelOut.groups.push({
        groupID: group.groupID,
        outputDir: group.outputDir,
        inputCount: group.inputItems.length,
        statusCounts: group.statusCounts,
        postMergeValidation,
        localReplay: group.localReplay
          ? {
              total: group.localReplay.total,
              passed: group.localReplay.passed,
              failed: group.localReplay.failed,
              repaired: group.localReplay.repaired,
              infrastructureSkipped: group.localReplay.infrastructureSkipped ?? 0,
            }
          : undefined,
      })
      next.push(itemFromGroup(group, level))
    }
    while (groupIndex < groups.length || active.size > 0) {
      while (groupIndex < groups.length && active.size < groupLimit) {
        const task = runOneGroup(groupIndex).finally(() => active.delete(task))
        active.add(task)
        groupIndex += 1
      }
      if (active.size > 0) await Promise.race(active)
    }
    levelOut.groups.sort((left, right) => left.groupID.localeCompare(right.groupID))
    next.sort((left, right) => left.id.localeCompare(right.id))
    levels.push(levelOut)
    current = next
    level += 1
  }

  const final = current[0]
  if (!final?.skillPath) throw new Error("Hierarchical merge did not produce a final skill.")
  state.mergedSkillDir = final.skillPath
  await saveCoordinatorState(state)
  const report = {
    schema: "auto-evolve/hierarchical-merge-report/v1",
    createdAt: nowISO(),
    stateID: state.id,
    mergedSkillDir: final.skillPath,
    statusCounts: statusCounts(selected),
    selectedInputCount: selected.length,
    levels,
  }
  const reportPath = path.join(runRoot, "report.json")
  const reportMarkdownPath = path.join(runRoot, "report.md")
  await writeJsonFile(reportPath, report)
  await writeTextFile(
    reportMarkdownPath,
    [
      "# Hierarchical Merge Report",
      "",
      `- state: ${state.id}`,
      `- selected inputs: ${selected.length}`,
      `- final merged skill: ${final.skillPath}`,
      "",
      "## Status Counts",
      "",
      ...Object.entries(statusCounts(selected)).map(([status, count]) => `- ${status}: ${count}`),
      "",
      "## Levels",
      "",
      ...levels.flatMap((entry) => [
        `### Level ${entry.level}`,
        "",
        ...entry.groups.map((group) => `- ${group.groupID}: inputs=${group.inputCount}, output=${group.outputDir}`),
        "",
      ]),
    ].join("\n"),
  )
  await appendCoordinatorLog(state, "info", `Hierarchical merge complete: ${final.skillPath}`)
  return {
    mergedSkillDir: final.skillPath,
    contributingInstances: selected.map((item) => item.id),
    mergerRunDir: runRoot,
    reportPath,
    reportMarkdownPath,
    levels,
  }
}
