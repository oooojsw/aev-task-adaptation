import path from "node:path"
import { autoEvolvePath, ensureDirectory, pathExists, runDirectory, writeJsonFile, writeTextFile } from "./fs"
import { loadDatasetSplit, selectCasesBySplit } from "./dataset-split"
import {
  buildMinimalExperienceWorkspaceSeed,
  diffExperienceWorkspace,
  findExperienceWorkspaceDocumentByRole,
  experienceWorkspacePaths,
  readExperienceWorkspace,
  restoreExperienceWorkspace,
  resolveExperienceWorkspaceLayout,
  seedExperienceWorkspace,
  templateLibraryPaths,
  validateExperienceWorkspaceLayout,
  writeExperienceWorkspaceSnapshot,
} from "./experience-workspace"
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
  const workspace = await resolveExperienceWorkspaceLayout(experienceWorkspacePaths(cwd, config))
  const changeLog = findExperienceWorkspaceDocumentByRole(workspace, "change_log")
  const file = changeLog?.absolutePath ?? path.join(workspace.root, "change_log.md")
  const current = (await pathExists(file)) ? await Bun.file(file).text() : "# Change Log\n"
  const stamp = new Date().toISOString()
  const next = `${current.trimEnd()}\n- ${stamp}: bootstrap refreshed the experience workspace from ${count} labeled case(s).\n`
  await writeTextFile(file, next)
}

export async function runBootstrap(cwd: string, options: { force: boolean; methodID?: string }): Promise<BootstrapResult> {
  const config = await loadConfig(cwd)
  const split = await loadDatasetSplit(cwd, config)
  const cases = selectCasesBySplit(await loadAllCases(cwd, config), split, "train")
  const workspacePaths = experienceWorkspacePaths(cwd, config)
  let workspace = await resolveExperienceWorkspaceLayout(workspacePaths)
  const templateLibrary = await templateLibraryPaths(cwd, config)
  const baselinePath = autoEvolvePath(cwd, config.baselineFile)
  const scriptsDir = autoEvolvePath(cwd, config.scriptsDir)
  const methodID = options.methodID ?? config.defaultMethod
  const execution = resolveModelSelection(config, "bootstrap")

  if (!cases.length) {
    return {
      message: "Bootstrap skipped because no labeled cases were found.",
    }
  }

  const originalPack = await readExperienceWorkspace(workspacePaths)
  const currentEntry = originalPack[workspace.entryRelativePath] ?? ""
  const replaceable = currentEntry.includes("<!-- auto-evolve-bootstrap: replaceable -->") || !currentEntry.trim()
  if (!replaceable && !options.force) {
    return {
      message:
        "Bootstrap skipped because the experience workspace is already customized. Re-run with --force if you want OpenCode to regenerate it.",
    }
  }

  const runID = makeBootstrapRunID()
  const runDir = runDirectory(cwd, config, runID)
  await ensureDirectory(runDir)

  const seedSnapshot = buildMinimalExperienceWorkspaceSeed(workspacePaths)
  const seededBeforeBootstrap = diffExperienceWorkspace(originalPack, seedSnapshot).length > 0
  await seedExperienceWorkspace(workspacePaths)
  workspace = await resolveExperienceWorkspaceLayout(workspacePaths)
  const currentPack = await readExperienceWorkspace(workspacePaths)

  const prompt = await buildBootstrapPrompt({
    cwd,
    config,
    methodID,
    workspace,
    templateLibrary,
    baselinePath,
    scriptsDir,
    cases,
  })

  const referencePaths = [
    workspace.root,
    ...Object.keys(currentPack).map((relative) => path.join(workspace.root, ...relative.split("/"))),
    templateLibrary.root,
    ...templateLibrary.files,
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
    permissionEditPaths: [workspace.root],
    model: execution.model,
    agent: execution.agent,
    variant: execution.variant,
  })

  const rawNextPack = await readExperienceWorkspace(workspacePaths)
  const rawWorkspace = await resolveExperienceWorkspaceLayout(workspacePaths)
  const rawChangedFiles = diffExperienceWorkspace(currentPack, rawNextPack)
  const workspaceValidation = validateExperienceWorkspaceLayout(rawWorkspace)
  const rolledBackInvalidWorkspace = task.result.exitCode === 0 && !workspaceValidation.valid

  if (rolledBackInvalidWorkspace) {
    await restoreExperienceWorkspace(workspacePaths, currentPack)
    workspace = await resolveExperienceWorkspaceLayout(workspacePaths)
  } else {
    workspace = rawWorkspace
  }

  const nextPack = await readExperienceWorkspace(workspacePaths)
  const changedFiles = rolledBackInvalidWorkspace ? [] : rawChangedFiles
  const knowledgePackChanged = changedFiles.length > 0

  await writeTextFile(path.join(runDir, "prompt.txt"), prompt + "\n")
  await writeTextFile(path.join(runDir, "stdout.log"), task.result.stdout)
  await writeTextFile(path.join(runDir, "stderr.log"), task.result.stderr)
  await writeTextFile(path.join(runDir, "response.txt"), (task.result.responseText || "").trim() + "\n")
  await writeJsonFile(path.join(runDir, "events.json"), task.result.events)
  await writeJsonFile(path.join(runDir, "tool_failures.json"), task.result.toolFailures)
  await writeExperienceWorkspaceSnapshot(path.join(runDir, "experience_workspace.original_before_seed"), originalPack)
  await writeExperienceWorkspaceSnapshot(path.join(runDir, "experience_workspace.seed_before_bootstrap"), currentPack)
  await writeExperienceWorkspaceSnapshot(path.join(runDir, "experience_workspace.after_raw"), rawNextPack)
  await writeExperienceWorkspaceSnapshot(path.join(runDir, "experience_workspace.after"), nextPack)
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
    experienceWorkspaceRoot: workspace.root,
    experienceWorkspaceEntryPath: workspace.entryPath,
    experienceWorkspaceEntryRelativePath: workspace.entryRelativePath,
    seededBeforeBootstrap,
    knowledgePackChanged,
    changedFiles,
    rawChangedFiles,
    workspaceValidationErrors: workspaceValidation.errors,
    rolledBackInvalidWorkspace,
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
        ? rolledBackInvalidWorkspace
          ? `Bootstrap produced an invalid experience workspace and was rolled back. Inspect ${runDir} for details.`
          : knowledgePackChanged
            ? `Bootstrap completed. OpenCode refreshed the experience workspace from ${cases.length} labeled case(s).`
            : "Bootstrap ran, but the experience workspace was not changed."
        : `Bootstrap failed with exit code ${task.result.exitCode}. Inspect ${runDir} for details.`,
  }
}
