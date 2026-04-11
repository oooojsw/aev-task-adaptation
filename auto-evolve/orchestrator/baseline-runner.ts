import path from "node:path"
import { autoEvolvePath, readTextFile, runDirectory, ensureDirectory, writeJsonFile, writeTextFile } from "./fs"
import {
  experienceWorkspacePaths,
  readExperienceWorkspace,
  writeExperienceWorkspaceSnapshot,
} from "./experience-workspace"
import { loadConfig } from "./schema"
import { runBootstrap } from "./bootstrap"
import { runRound, type RunRoundResult } from "./round-runner"
import type { RuntimePathOverrides } from "./schema"

export interface RunBaselineOptions {
  methodID?: string
  trainLimit?: number
  testLimit?: number
  skipBootstrap?: boolean
  forceBootstrap?: boolean
  runtimePaths?: RuntimePathOverrides
}

export interface RunBaselineResult {
  baselineDir: string
  methodID: string
  bootstrapUsed: boolean
  bootstrapForced: boolean
  bootstrapRunDir?: string
  trainRound: RunRoundResult
  testRound: RunRoundResult
}

function makeBaselineID() {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`
  return `${stamp}-baseline`
}

function rate(passed: number, total: number) {
  if (!total) return "0.0%"
  return `${((passed / total) * 100).toFixed(1)}%`
}

function changedFilesSummary(round: RunRoundResult) {
  const accepted = round.acceptedRefines
  const rejected = round.rejectedRefines
  return `accepted refines ${accepted}, rejected refines ${rejected}`
}

export async function runBaseline(cwd: string, options?: RunBaselineOptions): Promise<RunBaselineResult> {
  const config = await loadConfig(cwd, options?.runtimePaths)
  const methodID = options?.methodID ?? config.defaultMethod
  const trainLimit = Math.max(1, options?.trainLimit ?? config.roundCaseLimit)
  const testLimit = Math.max(1, options?.testLimit ?? config.roundCaseLimit)
  const bootstrapUsed = !options?.skipBootstrap
  const bootstrapForced = !!options?.forceBootstrap
  const workspace = experienceWorkspacePaths(cwd, config)
  const baselineDir = runDirectory(cwd, config, makeBaselineID())

  await ensureDirectory(baselineDir)
  await writeExperienceWorkspaceSnapshot(
    path.join(baselineDir, "experience_workspace.initial"),
    await readExperienceWorkspace(workspace),
  )
  await writeTextFile(path.join(baselineDir, "baseline.md"), await readTextFile(autoEvolvePath(cwd, config.baselineFile)))
  await writeTextFile(path.join(baselineDir, "dataset-split.md"), await readTextFile(autoEvolvePath(cwd, config.splitFile)))
  await writeTextFile(path.join(baselineDir, "model-config.json"), await readTextFile(config.modelConfigPath))

  let bootstrapRunDir: string | undefined
  if (bootstrapUsed) {
    const bootstrapResult = await runBootstrap(cwd, {
      force: bootstrapForced,
      methodID,
      runtimePaths: options?.runtimePaths,
    })
    bootstrapRunDir = bootstrapResult.runDir
    await writeExperienceWorkspaceSnapshot(
      path.join(baselineDir, "experience_workspace.after_bootstrap"),
      await readExperienceWorkspace(workspace),
    )
  }

  const trainRound = await runRound(cwd, {
    methodID,
    caseLimit: trainLimit,
    split: "train",
    mode: "learn",
    runtimePaths: options?.runtimePaths,
  })
  await writeExperienceWorkspaceSnapshot(
    path.join(baselineDir, "experience_workspace.after_train"),
    await readExperienceWorkspace(workspace),
  )

  const testRound = await runRound(cwd, {
    methodID,
    caseLimit: testLimit,
    split: "test",
    mode: "eval",
    runtimePaths: options?.runtimePaths,
  })
  await writeExperienceWorkspaceSnapshot(
    path.join(baselineDir, "experience_workspace.final"),
    await readExperienceWorkspace(workspace),
  )

  await writeJsonFile(path.join(baselineDir, "scorecard.json"), {
    methodID,
    bootstrapUsed,
    bootstrapForced,
    bootstrapRunDir: bootstrapRunDir ?? null,
    modelConfigPath: config.modelConfigPath,
    defaultModel: config.modelConfig.defaults.model ?? null,
    trainRound,
    testRound,
  })

  await writeTextFile(
    path.join(baselineDir, "scorecard.md"),
    [
      "# Baseline Scorecard",
      "",
      `- method: ${methodID}`,
      `- bootstrap used: ${bootstrapUsed}`,
      `- bootstrap forced: ${bootstrapForced}`,
      `- bootstrap run: ${bootstrapRunDir ?? "(not run)"}`,
      `- model config: ${config.modelConfigPath}`,
      `- default model: ${config.modelConfig.defaults.model ?? "(none)"}`,
      "",
      "## Train",
      "",
      `- round: ${trainRound.roundDir}`,
      `- total: ${trainRound.totalCases}`,
      `- passed: ${trainRound.passedCases}`,
      `- failed: ${trainRound.failedCases}`,
      `- pass rate: ${rate(trainRound.passedCases, trainRound.totalCases)}`,
      `- ${changedFilesSummary(trainRound)}`,
      "",
      ...trainRound.cases.map(
        (item) =>
          `- ${item.caseID}: ${item.passed ? "passed" : "failed"} after ${item.attempts} attempt(s), accepted refines ${item.acceptedRefines}, rejected refines ${item.rejectedRefines}`,
      ),
      "",
      "## Test",
      "",
      `- round: ${testRound.roundDir}`,
      `- total: ${testRound.totalCases}`,
      `- passed: ${testRound.passedCases}`,
      `- failed: ${testRound.failedCases}`,
      `- pass rate: ${rate(testRound.passedCases, testRound.totalCases)}`,
      `- ${changedFilesSummary(testRound)}`,
      "",
      ...testRound.cases.map(
        (item) =>
          `- ${item.caseID}: ${item.passed ? "passed" : "failed"} after ${item.attempts} attempt(s), accepted refines ${item.acceptedRefines}, rejected refines ${item.rejectedRefines}`,
      ),
      "",
      "## Snapshots",
      "",
      `- initial: ${path.join(baselineDir, "experience_workspace.initial")}`,
      ...(bootstrapUsed ? [`- after bootstrap: ${path.join(baselineDir, "experience_workspace.after_bootstrap")}`] : []),
      `- after train: ${path.join(baselineDir, "experience_workspace.after_train")}`,
      `- final: ${path.join(baselineDir, "experience_workspace.final")}`,
      "",
    ].join("\n"),
  )

  return {
    baselineDir,
    methodID,
    bootstrapUsed,
    bootstrapForced,
    bootstrapRunDir,
    trainRound,
    testRound,
  }
}
