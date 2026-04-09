import path from "node:path"
import { autoEvolvePath, ensureDirectory, runDirectory, writeJsonFile, writeTextFile } from "./fs"
import { loadDatasetSplit, selectCasesBySplit } from "./dataset-split"
import {
  diffKnowledgePack,
  knowledgePackPaths,
  readKnowledgePack,
  writeKnowledgePackSnapshot,
} from "./knowledge-pack"
import { resolveModelSelection } from "./model-selection"
import { runOpencodeTask } from "./opencode"
import { buildBootstrapPrompt } from "./prompts"
import { loadAllCases, loadConfig } from "./schema"

export interface BootstrapResult {
  message: string
  runDir?: string
  knowledgePackChanged?: boolean
  changedFiles?: string[]
}

function makeBootstrapRunID() {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`
  return `${stamp}-bootstrap`
}

async function appendChangeLog(cwd: string, count: number) {
  const config = await loadConfig(cwd)
  const file = knowledgePackPaths(cwd, config).changeLogPath
  const current = await Bun.file(file).text()
  const stamp = new Date().toISOString()
  const next = `${current.trimEnd()}\n- ${stamp}: bootstrap refreshed the knowledge pack from ${count} labeled case(s).\n`
  await writeTextFile(file, next)
}

export async function runBootstrap(cwd: string, options: { force: boolean; methodID?: string }): Promise<BootstrapResult> {
  const config = await loadConfig(cwd)
  const split = await loadDatasetSplit(cwd, config)
  const cases = selectCasesBySplit(await loadAllCases(cwd, config), split, "train")
  const knowledgePack = knowledgePackPaths(cwd, config)
  const baselinePath = autoEvolvePath(cwd, config.baselineFile)
  const scriptsDir = autoEvolvePath(cwd, config.scriptsDir)
  const methodID = options.methodID ?? config.defaultMethod
  const execution = resolveModelSelection(config, "bootstrap")

  if (!cases.length) {
    return {
      message: "Bootstrap skipped because no labeled cases were found.",
    }
  }

  const currentPack = await readKnowledgePack(knowledgePack)
  const currentRules = currentPack["core/expert_rules.md"]
  const replaceable = currentRules.includes("<!-- auto-evolve-bootstrap: replaceable -->") || !currentRules.trim()
  if (!replaceable && !options.force) {
    return {
      message:
        "Bootstrap skipped because the knowledge pack is already customized. Re-run with --force if you want OpenCode to regenerate it.",
    }
  }

  const runID = makeBootstrapRunID()
  const runDir = runDirectory(cwd, config, runID)
  await ensureDirectory(runDir)

  const prompt = await buildBootstrapPrompt({
    cwd,
    config,
    methodID,
    knowledgePack,
    baselinePath,
    scriptsDir,
    cases,
  })

  const referencePaths = [
    knowledgePack.root,
    ...knowledgePack.files,
    baselinePath,
    scriptsDir,
    ...cases.flatMap((item) => [
      item.casePath,
      ...item.spec.materials.map((material) => path.join(item.caseDir, material.path)),
      path.join(item.caseDir, item.spec.expected.path),
    ]),
  ]

  const task = await runOpencodeTask({
    cwd,
    config,
    title: "auto-evolve bootstrap",
    prompt,
    referencePaths,
    permissionReadPaths: referencePaths,
    permissionEditPaths: knowledgePack.files,
    model: execution.model,
    agent: execution.agent,
    variant: execution.variant,
  })

  const nextPack = await readKnowledgePack(knowledgePack)
  const changedFiles = diffKnowledgePack(currentPack, nextPack)
  const knowledgePackChanged = changedFiles.length > 0

  await writeTextFile(path.join(runDir, "prompt.txt"), prompt + "\n")
  await writeTextFile(path.join(runDir, "stdout.log"), task.result.stdout)
  await writeTextFile(path.join(runDir, "stderr.log"), task.result.stderr)
  await writeTextFile(path.join(runDir, "response.txt"), (task.result.responseText || "").trim() + "\n")
  await writeJsonFile(path.join(runDir, "events.json"), task.result.events)
  await writeJsonFile(path.join(runDir, "tool_failures.json"), task.result.toolFailures)
  await writeKnowledgePackSnapshot(path.join(runDir, "knowledge_pack.before"), currentPack)
  await writeKnowledgePackSnapshot(path.join(runDir, "knowledge_pack.after"), nextPack)
  await writeJsonFile(path.join(runDir, "run.json"), {
    runID,
    phase: "bootstrap",
    methodID,
    split: "train",
    sessionID: task.result.sessionID,
    exitCode: task.result.exitCode,
    model: task.selectedModel ?? null,
    agent: task.selectedAgent ?? null,
    variant: task.selectedVariant ?? null,
    caseIDs: cases.map((item) => item.spec.id),
    knowledgePackRoot: knowledgePack.root,
    knowledgePackChanged,
    changedFiles,
    referencedPaths: task.referencedPaths,
    attachedFiles: task.attachedFiles,
    permissionReadPaths: task.permissionReadPaths,
    permissionEditPaths: task.permissionEditPaths,
  })

  if (task.result.exitCode === 0 && knowledgePackChanged) {
    await appendChangeLog(cwd, cases.length)
  }

  return {
    runDir,
    knowledgePackChanged,
    changedFiles,
    message:
      task.result.exitCode === 0
        ? knowledgePackChanged
          ? `Bootstrap completed. OpenCode refreshed the knowledge pack from ${cases.length} labeled case(s).`
          : "Bootstrap ran, but the knowledge pack was not changed."
        : `Bootstrap failed with exit code ${task.result.exitCode}. Inspect ${runDir} for details.`,
  }
}
