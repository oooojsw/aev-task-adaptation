import path from "node:path"
import { buildActionTrace } from "./action-trace"
import { ensureDirectory, pathExists, writeJsonFile, writeTextFile } from "./fs"
import type { OpencodeTaskRun } from "./opencode"
import { buildSessionExecutionReport } from "./session-execution-report"
import { buildSessionLearningLog } from "./session-learning-log"
import { buildSessionTaskManifest } from "./session-task-manifest"
import { createTaskDescriptor, type AutoEvolveTaskKind } from "./task-model"
import { cp, readdir, stat } from "node:fs/promises"

export type TaskArtifactStatus = "bootstrapping" | "running" | "done" | "error"

export interface TaskArtifactPaths {
  promptPath: string
  stdoutPath: string
  stderrPath: string
  responsePath: string
  actionTracePath: string
  sessionExecutionReportPath: string
  sessionLearningLogPath: string
  sessionTaskManifestPath: string
  eventsPath: string
  toolFailuresPath: string
  runJsonPath: string
  opencodeProcessLogPath?: string
}

export interface TaskArtifactInput {
  phase?: string
  taskKind?: AutoEvolveTaskKind
  caseID?: string
  attempt?: number
  maintenanceRound?: number
  methodID?: string
  evaluation?: import("./evaluator").EvaluationResult
  status?: TaskArtifactStatus
  startedAt?: string
  updatedAt?: string
  lastOutputAt?: string
}

type TaskArtifactRunState = {
  startedAt?: string
  updatedAt?: string
  lastOutputAt?: string
  status?: TaskArtifactStatus
}

export function resolveTaskArtifactKind(input?: Pick<TaskArtifactInput, "phase" | "taskKind">): AutoEvolveTaskKind {
  if (input?.taskKind) return input.taskKind
  switch (input?.phase) {
    case "bootstrap":
    case "solve":
    case "verify":
    case "regression":
    case "judge":
    case "maintain":
    case "post_judge":
    case "deployment_acceptance":
    case "long_task_plan":
    case "long_task_execute":
    case "long_task_validate":
    case "long_task_replan":
      return input.phase
    case "campaign_worker":
      return "solve"
    case "campaign_lead":
      return "maintain"
    case "campaign_review":
      return "judge"
    default:
      return "solve"
  }
}

export function taskArtifactPaths(stageDir: string): TaskArtifactPaths {
  return {
    promptPath: path.join(stageDir, "prompt.txt"),
    stdoutPath: path.join(stageDir, "stdout.log"),
    stderrPath: path.join(stageDir, "stderr.log"),
    responsePath: path.join(stageDir, "response.txt"),
    actionTracePath: path.join(stageDir, "action_trace.md"),
    sessionExecutionReportPath: path.join(stageDir, "session_execution_report.md"),
    sessionLearningLogPath: path.join(stageDir, "session_learning_log.md"),
    sessionTaskManifestPath: path.join(stageDir, "session_task_manifest.md"),
    eventsPath: path.join(stageDir, "events.json"),
    toolFailuresPath: path.join(stageDir, "tool_failures.json"),
    runJsonPath: path.join(stageDir, "run.json"),
  }
}

async function readRunState(file: string) {
  try {
    return (await Bun.file(file).json()) as TaskArtifactRunState
  } catch {
    return undefined
  }
}

export async function writeTaskArtifacts(
  stageDir: string,
  task: OpencodeTaskRun,
  input?: TaskArtifactInput,
): Promise<TaskArtifactPaths> {
  await ensureDirectory(stageDir)
  const paths = taskArtifactPaths(stageDir)
  const run = await readRunState(paths.runJsonPath)
  const now = new Date().toISOString()
  const descriptor = createTaskDescriptor({
    kind: resolveTaskArtifactKind(input),
    title: task.title,
    phase: input?.phase,
    caseID: input?.caseID,
    attempt: input?.attempt,
    maintenanceRound: input?.maintenanceRound,
    methodID: input?.methodID,
  })

  await writeTextFile(paths.promptPath, task.prompt + "\n")
  await writeTextFile(paths.stdoutPath, task.result.stdout)
  await writeTextFile(paths.stderrPath, task.result.stderr)
  await writeTextFile(paths.responsePath, (task.result.responseText || "").trim() + "\n")
  await writeTextFile(paths.actionTracePath, buildActionTrace(task.result.events))
  await writeTextFile(
    paths.sessionExecutionReportPath,
    buildSessionExecutionReport({
      task,
      phase: input?.phase,
      caseID: input?.caseID,
      attempt: input?.attempt,
      methodID: input?.methodID,
      evaluation: input?.evaluation,
    }),
  )
  await writeTextFile(
    paths.sessionLearningLogPath,
    buildSessionLearningLog({
      task,
      descriptor,
      evaluation: input?.evaluation,
    }),
  )
  await writeTextFile(
    paths.sessionTaskManifestPath,
    buildSessionTaskManifest({
      task,
      descriptor,
    }),
  )
  await writeJsonFile(paths.eventsPath, task.result.events)
  await writeJsonFile(paths.toolFailuresPath, task.result.toolFailures)
  await writeJsonFile(paths.runJsonPath, {
    title: task.title,
    task: descriptor,
    sessionID: task.result.sessionID,
    exitCode: task.result.exitCode,
    status: input?.status ?? (task.result.exitCode === 0 ? "done" : "error"),
    startedAt: input?.startedAt ?? run?.startedAt ?? now,
    updatedAt: input?.updatedAt ?? now,
    lastOutputAt: input?.lastOutputAt ?? run?.lastOutputAt ?? input?.updatedAt ?? now,
    model: task.selectedModel ?? null,
    agent: task.selectedAgent ?? null,
    variant: task.selectedVariant ?? null,
    referencedPaths: task.referencedPaths,
    attachedFiles: task.attachedFiles,
    permissionReadPaths: task.permissionReadPaths,
    permissionEditPaths: task.permissionEditPaths,
  })

  try {
    const logBaseDir =
      process.platform === "win32"
        ? path.join(
            process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Local"),
            "opencode",
            "logs",
          )
        : path.join(process.env.HOME ?? "/root", ".local", "share", "opencode", "logs")
    if (await pathExists(logBaseDir)) {
      const logDirents = await readdir(logBaseDir)
      const logFiles = logDirents.filter((d) => d.endsWith(".log") || d.endsWith(".txt"))
      let latestLog: { name: string; mtime: number } | null = null
      for (const name of logFiles) {
        const mtime = (await stat(path.join(logBaseDir, name))).mtimeMs
        if (!latestLog || mtime > latestLog.mtime) {
          latestLog = { name, mtime }
        }
      }
      if (latestLog) {
        const srcLog = path.join(logBaseDir, latestLog.name)
        const destLog = path.join(stageDir, "opencode_process_log.txt")
        await cp(srcLog, destLog, { force: true })
        paths.opencodeProcessLogPath = destLog
      }
    }
  } catch {}

  return paths
}
