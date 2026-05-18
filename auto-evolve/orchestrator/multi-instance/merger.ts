/**
 * Skill Merger — Phase 2 of the multi-instance coordinator.
 *
 * Reads N harvested per-instance skills (produced by Phase 1 fan-out) and
 * invokes OpenCode with the merger prompt to produce a unified skill:
 *
 *   merged-skill/
 *     INDEX.md       # how to use this skill
 *     CORE.md        # rules verified across multiple instances
 *     cases/         # per-instance notes
 *     meta.json      # provenance & confidence
 *
 * The merger only consumes "verified" or "exhausted" instance skills. A
 * "failed" instance contributes nothing because its skill was never
 * exercised end-to-end. We do snapshot a manifest of which instance
 * inputs the merger saw, so the output is reproducible.
 */

import path from "node:path"
import { readdir, stat } from "node:fs/promises"
import { ensureDirectory, pathExists, readTextFile, writeJsonFile, writeTextFile } from "../fs"
import { runOpencodeTask } from "../opencode"
import { loadConfig } from "../schema"
import type { CoordinatorState, InstanceState } from "./contract"
import { appendCoordinatorLog, mergeDir, saveCoordinatorState } from "./repository"

export interface RunMergerInput {
  cwd: string
  state: CoordinatorState
  /** Override the prompt path — defaults to methods/recipes/multi-instance/prompts/merge.md */
  promptPath?: string
}

export interface MergerOutcome {
  mergedSkillDir: string
  contributingInstances: string[]
  mergerRunDir: string
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
  await ensureDirectory(path.join(mergedSkillDir, "cases"))

  const contributingInstances = state.instances.filter(
    (i) =>
      // Only train instances feed the merger. Held-out test instances are
      // intentionally never merged — that's how we know the merged skill
      // generalizes when Phase 3 runs them.
      i.role !== "test" &&
      (i.status === "passed" || i.status === "exhausted") &&
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

  // Build the prompt body. We inline the per-instance skill contents so the
  // merger agent sees the actual text, not just paths it would have to read.
  const promptPath = input.promptPath ?? path.join(input.cwd, "auto-evolve", DEFAULT_PROMPT_REL)
  const promptBody = await readTextFile(promptPath)
  const inlined = await inlineInstanceSkills(contributingInstances)
  const fullPrompt = [
    promptBody.trim(),
    "",
    "# Inputs",
    "",
    `You are merging ${contributingInstances.length} instance skill(s).`,
    "",
    `Output root for your writes: ${mergedSkillDir}`,
    "",
    "Each instance is presented below with its id and skill content.",
    "",
    inlined,
    "",
    "# Working instructions",
    "",
    `Write the four output artifacts directly to: ${mergedSkillDir}`,
    "Use file edits to create the files. Do not zip them or echo their content back to the user.",
  ].join("\n")
  await writeTextFile(path.join(mergerRoot, "prompt.txt"), fullPrompt)

  // Spawn the merger agent. We grant edit-only access to the merged-skill
  // output directory (and read-only access to the input manifest plus
  // every harvested skill path), to keep the merger from accidentally
  // reaching into instance run-roots.
  const config = await loadConfig(input.cwd)
  const readPaths = [
    path.join(mergerRoot, "input-manifest.json"),
    ...contributingInstances.map((i) => i.harvestedSkillPath!).filter(Boolean),
  ]
  const editPaths = [mergedSkillDir]

  const result = await runOpencodeTask({
    cwd: input.cwd,
    config,
    title: `multi-instance-merge-${state.id}`,
    prompt: fullPrompt,
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

  state.mergedSkillDir = mergedSkillDir
  await saveCoordinatorState(state)

  return {
    mergedSkillDir,
    contributingInstances: contributingInstances.map((i) => i.id),
    mergerRunDir: mergerRoot,
  }
}

/**
 * Concatenate the per-instance skill text with explicit instance markers.
 * The merger sees a single prompt rather than a forest of files, which keeps
 * its working memory bounded.
 */
async function inlineInstanceSkills(instances: InstanceState[]): Promise<string> {
  const blocks: string[] = []
  for (const inst of instances) {
    const block: string[] = []
    block.push(`## Instance: ${inst.id}`)
    block.push(`Status from fan-out: ${inst.status}`)
    block.push(`Source root: ${inst.sourceTaskRoot}`)
    block.push("")
    if (!inst.harvestedSkillPath) {
      block.push("(no harvested skill on disk — instance contributes nothing)")
      blocks.push(block.join("\n"))
      continue
    }
    const tree = await listSkillTree(inst.harvestedSkillPath)
    block.push("Skill files:")
    for (const item of tree) {
      block.push(`  - ${item.relPath} (${item.bytes} bytes)`)
    }
    block.push("")
    for (const item of tree) {
      if (!item.isText) continue
      block.push(`### ${item.relPath}`)
      const content = await readTextFile(path.join(inst.harvestedSkillPath, item.relPath))
      block.push(truncate(content, 8000))
      block.push("")
    }
    blocks.push(block.join("\n"))
  }
  return blocks.join("\n\n---\n\n")
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

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[...truncated ${text.length - max} chars...]`
}
