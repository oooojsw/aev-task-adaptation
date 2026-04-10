import path from "node:path"
import { spawn } from "node:child_process"
import { ensureDirectory, pathExists, writeJsonFile } from "../fs"
import type { LoadedAutoEvolveConfig } from "../case-runtime"
import type { CaseRuntimeContext } from "../case-runtime"
import type { JudgeHardCheckArtifact } from "./contract"

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function relativeToRunDir(runDir: string, target: string) {
  return target.startsWith(runDir)
    ? target
        .slice(runDir.length + (target.charAt(runDir.length) === "\\" || target.charAt(runDir.length) === "/" ? 1 : 0))
        .replace(/\\/g, "/")
    : target.replace(/\\/g, "/")
}

async function runPythonScript(scriptPath: string, inputPath: string, outputPath: string) {
  const candidates =
    process.platform === "win32"
      ? [
          { command: "py", args: ["-3", scriptPath, inputPath, outputPath] },
          { command: "python", args: [scriptPath, inputPath, outputPath] },
        ]
      : [
          { command: "python3", args: [scriptPath, inputPath, outputPath] },
          { command: "python", args: [scriptPath, inputPath, outputPath] },
        ]

  let lastError = "No python interpreter succeeded."
  for (const candidate of candidates) {
    const result = await new Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }>((resolve) => {
      const child = spawn(candidate.command, candidate.args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk)
      })
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk)
      })
      child.on("error", (error) => {
        resolve({ ok: false, stdout, stderr: error.message, code: null })
      })
      child.on("close", (code) => {
        resolve({ ok: code === 0, stdout, stderr, code })
      })
    })

    if (result.ok) return result
    lastError = `${candidate.command}: ${result.stderr || `exit code ${result.code ?? "unknown"}`}`
  }

  throw new Error(lastError)
}

function judgeSkillPaths(cwd: string, config: LoadedAutoEvolveConfig, skillID: string) {
  const root = path.join(cwd, "auto-evolve", config.judgeSkillsDir, skillID)
  return {
    root,
    scriptPath: path.join(root, "scripts", "run.py"),
  }
}

export async function runHardJudgeTools(
  context: CaseRuntimeContext,
  judgeDir: string,
): Promise<{ artifacts: JudgeHardCheckArtifact[]; indexPath?: string }> {
  const judgeMode = context.config.judgeConfig.mode
  if (judgeMode !== "soft_plus_hard") {
    return { artifacts: [] }
  }

  const hardChecksRoot = path.join(judgeDir, "hard-checks")
  await ensureDirectory(hardChecksRoot)
  const artifacts: JudgeHardCheckArtifact[] = []

  for (const skillID of context.config.judgeConfig.autoRunSkillIDs) {
    const skill = judgeSkillPaths(context.cwd, context.config, skillID)
    const skillRunDir = path.join(hardChecksRoot, skillID)
    await ensureDirectory(skillRunDir)
    const inputPath = path.join(skillRunDir, "input.json")
    const outputPath = path.join(skillRunDir, "output.json")
    const runInfoPath = path.join(skillRunDir, "run.json")

    await writeJsonFile(inputPath, {
      runDir: context.runDir,
      caseID: context.loaded.spec.id,
      attempt: context.attempt,
      solveDir: context.solveDir,
      solveEvaluationPath: context.feedback.evaluationPath,
      solveActualOutputPath: context.feedback.actualOutputPath,
      solveExpectedPath: context.expectedPath,
      solveToolFailuresPath: path.join(context.solveDir, "tool_failures.json"),
      solveEventsPath: path.join(context.solveDir, "events.json"),
      solveSessionExecutionReportPath: context.attemptSummary.solveSessionExecutionReportPath,
      routingPath: path.join(context.acceptanceDir, "routing.json"),
      regressionBeforeSummaryPath: path.join(context.acceptanceDir, "regression-before-maintain.summary.json"),
    })

    let status: "completed" | "failed" = "completed"
    let error: string | null = null

    try {
      if (!(await pathExists(skill.scriptPath))) {
        throw new Error(`Judge skill script is missing: ${skill.scriptPath}`)
      }
      await runPythonScript(skill.scriptPath, inputPath, outputPath)
    } catch (failure) {
      status = "failed"
      error = failure instanceof Error ? failure.message : String(failure)
      await writeJsonFile(outputPath, {
        status: "failed",
        error,
      })
    }

    await writeJsonFile(runInfoPath, {
      skillID,
      scriptPath: skill.scriptPath,
      inputPath,
      outputPath,
      status,
      error,
    })

    artifacts.push({
      skillID,
      outputPath,
      relativeOutputPath: relativeToRunDir(context.runDir, outputPath),
      status,
    })
  }

  const indexPath = path.join(hardChecksRoot, "hard_checks_index.json")
  await writeJsonFile(indexPath, {
    judgeMode,
    artifacts: artifacts.map((item) => ({
      skillID: item.skillID,
      outputPath: item.outputPath,
      relativeOutputPath: item.relativeOutputPath,
      status: item.status,
    })),
  })

  return { artifacts, indexPath }
}
