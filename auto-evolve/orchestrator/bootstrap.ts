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
import { writeTaskArtifacts } from "./task-artifacts"
import { loadAllCases, loadConfig, type RuntimePathOverrides } from "./schema"

export interface BootstrapResult {
  message: string
  runDir?: string
  knowledgePackChanged?: boolean
  changedFiles?: string[]
}

export interface RunBootstrapOptions {
  force: boolean
  methodID?: string
  runtimePaths?: RuntimePathOverrides
}

function makeBootstrapRunID() {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`
  return `${stamp}-bootstrap`
}

async function appendChangeLog(cwd: string, count: number, runtimePaths?: RuntimePathOverrides) {
  const config = await loadConfig(cwd, runtimePaths)
  const workspace = await resolveExperienceWorkspaceLayout(experienceWorkspacePaths(cwd, config))
  const changeLog = findExperienceWorkspaceDocumentByRole(workspace, "change_log")
  const file = changeLog?.absolutePath ?? path.join(workspace.root, "change_log.md")
  const current = (await pathExists(file)) ? await Bun.file(file).text() : "# Change Log\n"
  const stamp = new Date().toISOString()
  const next = `${current.trimEnd()}\n- ${stamp}: bootstrap refreshed the experience workspace from ${count} labeled case(s).\n`
  await writeTextFile(file, next)
}

export async function runBootstrap(cwd: string, options: RunBootstrapOptions): Promise<BootstrapResult> {
  const config = await loadConfig(cwd, options.runtimePaths)
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

  const artifactPaths = await writeTaskArtifacts(runDir, task, {
    phase: "bootstrap",
    taskKind: "bootstrap",
    methodID,
  })
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
    experienceWorkspaceDocumentFiles: workspace.documents.map((item) => item.relativePath),
    experienceWorkspaceAssetFiles: workspace.assets.map((item) => ({
      relativePath: item.relativePath,
      kind: item.kind,
    })),
    experienceWorkspaceRuntimeSidecarFiles: workspace.runtimeSidecarFiles,
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
  await writeJsonFile(path.join(runDir, "task_index.json"), {
    taskCount: 1,
    tasks: [
      {
        phase: "bootstrap",
        sessionID: task.result.sessionID || null,
        executionReportPath: path.basename(artifactPaths.sessionExecutionReportPath),
        learningLogPath: path.basename(artifactPaths.sessionLearningLogPath),
        taskManifestPath: path.basename(artifactPaths.sessionTaskManifestPath),
      },
    ],
  })

  if (task.result.exitCode === 0 && knowledgePackChanged) {
    await appendChangeLog(cwd, cases.length, options.runtimePaths)
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
