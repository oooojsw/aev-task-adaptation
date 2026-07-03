/**
 * Skill Merger — Phase 2 of the multi-instance coordinator.
 *
 * Reads N harvested per-instance skills (produced by Phase 1 fan-out) and
 * invokes OpenCode with the merger prompt to produce a unified skill:
 *
 *   merged-skill/
 *     INDEX.md       # how to use this skill
 *     CORE.md        # rules verified across multiple instances
 *     casebook/      # scenario notes named by task features, not raw ids
 *     meta.json      # provenance & confidence
 *
 * The merger only consumes verified training instance skills. Exhausted
 * skills are unverified drafts and must not shape the merged package.
 * We snapshot a manifest of which instance inputs the merger saw, so the
 * output is reproducible.
 */

import path from "node:path"
import { readdir, stat } from "node:fs/promises"
import { ensureDirectory, pathExists, readTextFile, writeJsonFile, writeTextFile } from "../fs"
import type { LongTaskSpec, LongTaskValidatorContract, LongTaskWorkUnit } from "../long-task/contract"
import { loadLongTaskSpec } from "../long-task/spec"
import { runOpencodeTask } from "../opencode"
import { loadConfig } from "../schema"
import type { CoordinatorState, InstanceState } from "./contract"
import { appendCoordinatorLog, mergeDir, saveCoordinatorState } from "./repository"
import { selectValidationModules } from "../validation-engine/registry"
import { runValidationStage } from "../validation-engine/stage-runner"

export interface RunMergerInput {
  cwd: string
  state: CoordinatorState
  /** Override the prompt path — defaults to methods/recipes/multi-instance/prompts/merge.md */
  promptPath?: string
  /** Optional task-specific merge contract JSON path. */
  contractPath?: string
}

export interface MergerOutcome {
  mergedSkillDir: string
  contributingInstances: string[]
  mergerRunDir: string
  postMergeValidationResultPath?: string
  postMergeValidationPassed?: boolean
}

/**
 * Default prompt location, relative to the auto-evolve repo root. We do not
 * hardcode the absolute path so the same code works under different layouts.
 */
const DEFAULT_PROMPT_REL = "methods/recipes/multi-instance/prompts/merge.md"
export async function runCoordinatorPhase2Merge(input: RunMergerInput): Promise<MergerOutcome> {
  const state = input.state
  state.phase = "phase2_merge"
  await saveCoordinatorState(state)

  const mergerRoot = mergeDir(state.runRoot)
  await ensureDirectory(mergerRoot)
  const mergedSkillDir = path.join(mergerRoot, "output")
  await ensureDirectory(mergedSkillDir)
  await ensureDirectory(path.join(mergedSkillDir, "casebook"))

  const contributingInstances = state.instances.filter(
    (i) =>
      // Only train instances feed the merger. Held-out test instances are
      // intentionally never merged — that's how we know the merged skill
      // generalizes when Phase 3 runs them.
      i.role !== "test" &&
      i.status === "passed" &&
      i.harvestedSkillPath,
  )

  if (contributingInstances.length === 0) {
    await appendCoordinatorLog(state, "warn", "Phase 2: no contributing instances — nothing to merge")
    state.phase = "phase2_merge"
    await saveCoordinatorState(state)
    return { mergedSkillDir, contributingInstances: [], mergerRunDir: mergerRoot }
  }

  await appendCoordinatorLog(
    state,
    "info",
    `Phase 2: merging ${contributingInstances.length} instance skills`,
  )

  // Snapshot the manifest of inputs the merger sees. This is the single
  // unambiguous record of what shaped the output, useful for re-running
  // a merger without redoing fan-out.
  const inputManifest = {
    contributingInstances: contributingInstances.map((i) => ({
      id: i.id,
      status: i.status,
      sourceTaskRoot: i.sourceTaskRoot,
      harvestedSkillPath: i.harvestedSkillPath,
    })),
  }
  await writeJsonFile(path.join(mergerRoot, "input-manifest.json"), inputManifest)

  // Build the prompt body without inlining all skill text. Very large prompt
  // arguments can exceed process spawn limits on Windows.
  const promptPath = input.promptPath ?? path.join(input.cwd, "auto-evolve", DEFAULT_PROMPT_REL)
  const promptBody = await readTextFile(promptPath)
  const contractPath = input.contractPath
  const contractBody = contractPath
    ? await readTextFile(contractPath)
    : JSON.stringify(
        {
          id: "inline.generic-fallback",
          note: "No merge contract path was provided; use a conservative generic skill layout.",
          requiredFiles: ["INDEX.md", "CORE.md", "meta.json", "casebook/", "open_observations.md"],
        },
        null,
        2,
      )
  const lines = await buildInstanceIndex(contributingInstances)
  const manifestPath = path.join(mergerRoot, "input-manifest.json")
  const fullPrompt = [
    promptBody.trim(),
    "",
    "# Merge Contract",
    "",
    contractPath ? `Merge contract path: ${contractPath}` : "Merge contract path: (inline generic fallback)",
    "",
    "```json",
    contractBody.trim(),
    "```",
    "",
    "# Inputs",
    "",
    `You are merging ${contributingInstances.length} instance skill(s).`,
    "",
    `Output root for your writes: ${mergedSkillDir}`,
    "",
    `Manifest JSON path: ${manifestPath}`,
    "",
    "Read the manifest first, then read each harvested skill from disk via those paths.",
    "Do not ask for more files; all inputs are already accessible.",
    "",
    "Contributing instances:",
    ...lines,
    "",
    "# Working instructions",
    "",
    `Write the merged skill artifacts required by the merge contract directly to: ${mergedSkillDir}`,
    "Use file edits to create the files. Do not zip them or echo their content back to the user.",
  ].join("\n")
  await writeTextFile(path.join(mergerRoot, "prompt.txt"), fullPrompt)

  // Spawn the merger agent. We grant edit-only access to the merged-skill
  // output directory (and read-only access to the input manifest plus
  // every harvested skill path), to keep the merger from accidentally
  // reaching into instance run-roots.
  const config = await loadConfig(input.cwd)
  const readPaths = [
    manifestPath,
    ...(contractPath ? [contractPath] : []),
    ...contributingInstances.map((i) => i.harvestedSkillPath!).filter(Boolean),
  ]
  const editPaths = [mergedSkillDir]

  const result = await runOpencodeTask({
    cwd: input.cwd,
    config,
    title: `multi-instance-merge-${state.id}`,
    prompt: fullPrompt,
    concurrencyScope: `multi-instance-merge:${state.id}`,
    permissionReadPaths: readPaths,
    permissionEditPaths: editPaths,
  })

  await writeTextFile(path.join(mergerRoot, "stdout.log"), result.result.stdout)
  await writeTextFile(path.join(mergerRoot, "stderr.log"), result.result.stderr)
  await writeTextFile(path.join(mergerRoot, "response.txt"), result.result.responseText)

  // Verify the merger produced the required files. Failure here is loud:
  // we record the issue but do not throw — phase 3 may still be useful
  // even with a partial merge.
  const expected = ["INDEX.md", "CORE.md", "meta.json"]
  const missing: string[] = []
  for (const f of expected) {
    if (!(await pathExists(path.join(mergedSkillDir, f)))) missing.push(f)
  }
  if (missing.length > 0) {
    await appendCoordinatorLog(
      state,
      "warn",
      `Phase 2: merger output missing files: ${missing.join(", ")}. Inspect ${mergerRoot}.`,
    )
  } else {
    await appendCoordinatorLog(state, "info", "Phase 2: merger output complete (INDEX, CORE, meta)")
  }

  const postMergeValidation = await runPostMergeValidation({
    cwd: input.cwd,
    state,
    config,
    mergerRoot,
    mergedSkillDir,
    manifestPath,
    contributingInstances,
  })

  state.mergedSkillDir = mergedSkillDir
  state.postMergeValidationStatus = postMergeValidation.status
  state.postMergeValidationResultPath = postMergeValidation.resultPath
  state.postMergeValidationSummary = postMergeValidation.summary
  await saveCoordinatorState(state)

  if (postMergeValidation.status === "failed") {
    throw new Error(`Phase 2 post-merge validation failed: ${postMergeValidation.summary}`)
  }

  return {
    mergedSkillDir,
    contributingInstances: contributingInstances.map((i) => i.id),
    mergerRunDir: mergerRoot,
    postMergeValidationResultPath: postMergeValidation.resultPath,
    postMergeValidationPassed:
      postMergeValidation.status === "skipped" ? undefined : postMergeValidation.status === "passed",
  }
}

async function runPostMergeValidation(input: {
  cwd: string
  state: CoordinatorState
  config: Awaited<ReturnType<typeof loadConfig>>
  mergerRoot: string
  mergedSkillDir: string
  manifestPath: string
  contributingInstances: InstanceState[]
}) {
  const loaded = await loadContributingSpecs(input)
  const validators = uniqueValidatorsByID(loaded.flatMap((item) => item.spec.validators))
  const selected = selectValidationModules({
    validators,
    stage: "post_merge",
  })

  if (!selected.length) {
    await appendCoordinatorLog(
      input.state,
      "info",
      "Phase 2: no post_merge validation modules configured; skipping validation-engine post-merge stage.",
    )
    return {
      status: "skipped" as const,
      summary: "No post_merge validation modules configured.",
      resultPath: undefined,
    }
  }

  const mergedSpec = buildPostMergeSpec(input.state, input.mergedSkillDir, validators, loaded[0]?.spec)
  const unit = buildPostMergeUnit(input.state, input.manifestPath, input.mergedSkillDir, selected)
  const stageDir = path.join(input.mergerRoot, "post-merge-validation")
  const bundlePath = path.join(stageDir, "bundle.json")
  const payload = buildPostMergePayload(input)
  await ensureDirectory(stageDir)
  await writeJsonFile(bundlePath, payload)

  const stage = await runValidationStage({
    cwd: input.cwd,
    config: input.config,
    spec: mergedSpec,
    unit,
    stage: "post_merge",
    runID: `multi-instance-post-merge-${input.state.id}`,
    attempt: 1,
    stageDir,
    bundlePath,
    payload,
    validators,
  })

  await appendCoordinatorLog(
    input.state,
    stage.passed ? "info" : "error",
    `Phase 2: post-merge validation ${stage.passed ? "passed" : "failed"} (${selected.length} module(s)): ${stage.summary}`,
  )

  return {
    status: stage.passed ? ("passed" as const) : ("failed" as const),
    summary: stage.summary,
    resultPath: stage.resultPath,
  }
}

async function loadContributingSpecs(input: {
  state: CoordinatorState
  contributingInstances: InstanceState[]
}) {
  const out: Array<{ instance: InstanceState; spec: LongTaskSpec }> = []
  for (const instance of input.contributingInstances) {
    const specPath = path.join(instance.sourceTaskRoot, "spec.json")
    try {
      const loaded = await loadLongTaskSpec(specPath, { allowMissingInitialExpertContextPaths: true })
      out.push({ instance, spec: loaded.spec })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await appendCoordinatorLog(
        input.state,
        "warn",
        `Phase 2: could not load post-merge validators from ${instance.id}: ${message}`,
      )
    }
  }
  return out
}

function uniqueValidatorsByID(validators: LongTaskValidatorContract[]) {
  const byID = new Map<string, LongTaskValidatorContract>()
  for (const validator of validators) byID.set(validator.id, validator)
  return Array.from(byID.values())
}

function buildPostMergeSpec(
  state: CoordinatorState,
  mergedSkillDir: string,
  validators: LongTaskValidatorContract[],
  template?: LongTaskSpec,
): LongTaskSpec {
  return {
    ...(template ?? {
      title: "Post-merge validation",
      goal: "Validate the merged expert surface after multi-instance merge.",
      materials: [{ path: mergedSkillDir, label: "merged skill", role: "experience-workspace" }],
      validators,
      budgets: {
        maxAttemptsPerUnit: 1,
        maxTotalUnitAttempts: 1,
        maxGraphReplans: 0,
        maxValidatorCalls: validators.length || 1,
        maxNoProgressCycles: 1,
        maxUnitsPerGraph: 1,
      },
    }),
    id: `post-merge-${state.id}`,
    title: `Post-merge validation for ${state.label || state.id}`,
    goal: "Validate the merged expert surface after multi-instance merge.",
    materials: [{ path: mergedSkillDir, label: "merged skill", role: "experience-workspace" }],
    targetPaths: [{ path: mergedSkillDir, label: "merged skill", role: "experience-workspace" }],
    editablePaths: [],
    initialExpertContextPaths: [],
    formalPackageRoots: [mergedSkillDir],
    validators,
  }
}

function buildPostMergeUnit(
  state: CoordinatorState,
  manifestPath: string,
  mergedSkillDir: string,
  validators: LongTaskValidatorContract[],
): LongTaskWorkUnit {
  return {
    id: "post-merge-surface",
    title: "Post-merge merged skill validation",
    goal: "Validate the merged expert surface before train replay or held-out test begins.",
    inputs: [manifestPath, mergedSkillDir],
    dependsOn: [],
    expectedArtifacts: [mergedSkillDir],
    claim: `Merged skill for ${state.id} is ready for post-merge validation.`,
    checkPlan: "Run validation-engine post_merge modules against the merged skill output directory.",
    validatorIDs: validators.map((item) => item.id),
    retryBudget: 0,
    status: "active",
    attemptCount: 1,
  }
}

function buildPostMergePayload(input: {
  state: CoordinatorState
  mergedSkillDir: string
  manifestPath: string
  contributingInstances: InstanceState[]
}) {
  return {
    schema: "auto-evolve/multi-instance-post-merge-validation/v1",
    task: {
      id: input.state.id,
      title: input.state.label,
      phase: "post_merge",
      goal: "Validate the merged expert surface before train replay or held-out test.",
    },
    targetPaths: [
      {
        path: input.mergedSkillDir,
        label: "merged skill",
        role: "experience-workspace",
      },
    ],
    expectedArtifacts: [input.mergedSkillDir],
    files: {
      merged_skill_dir: input.mergedSkillDir,
      input_manifest_path: input.manifestPath,
    },
    contributingInstances: input.contributingInstances.map((instance) => ({
      id: instance.id,
      sourceTaskRoot: instance.sourceTaskRoot,
      harvestedSkillPath: instance.harvestedSkillPath,
    })),
  }
}

/**
 * Concatenate the per-instance skill text with explicit instance markers.
 * The merger sees a single prompt rather than a forest of files, which keeps
 * its working memory bounded.
 */
async function buildInstanceIndex(instances: InstanceState[]): Promise<string[]> {
  const lines: string[] = []
  for (const inst of instances) {
    if (!inst.harvestedSkillPath) {
      lines.push(`- ${inst.id}: (missing harvestedSkillPath)`)
      continue
    }
    const tree = await listSkillTree(inst.harvestedSkillPath)
    const text = tree.filter((item) => item.isText).length
    lines.push(`- ${inst.id}: ${inst.harvestedSkillPath} (files=${tree.length}, text=${text})`)
  }
  return lines
}

interface SkillTreeItem {
  relPath: string
  bytes: number
  isText: boolean
}

async function listSkillTree(root: string): Promise<SkillTreeItem[]> {
  const out: SkillTreeItem[] = []
  await walk(root, "", out)
  return out
}

async function walk(root: string, rel: string, out: SkillTreeItem[]) {
  const full = path.join(root, rel)
  const entries = await readdir(full, { withFileTypes: true })
  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name
    if (entry.isDirectory()) {
      await walk(root, childRel, out)
    } else if (entry.isFile()) {
      const fileStat = await stat(path.join(root, childRel))
      out.push({
        relPath: childRel,
        bytes: fileStat.size,
        isText: isProbablyText(entry.name),
      })
    }
  }
}

function isProbablyText(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".json") ||
    lower.endsWith(".jsonl") ||
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml") ||
    lower.endsWith(".toml")
  )
}
