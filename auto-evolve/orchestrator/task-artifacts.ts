import path from "node:path"
import { buildActionTrace } from "./action-trace"
import { ensureDirectory, writeJsonFile, writeTextFile } from "./fs"
import type { OpencodeTaskRun } from "./opencode"
import { buildSessionExecutionReport } from "./session-execution-report"
import { buildSessionLearningLog } from "./session-learning-log"
import { buildSessionTaskManifest } from "./session-task-manifest"
import { createTaskDescriptor, type AutoEvolveTaskKind } from "./task-model"

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
}

export async function writeTaskArtifacts(
  stageDir: string,
  task: OpencodeTaskRun,
  input?: {
    phase?: string
    taskKind?: AutoEvolveTaskKind
    caseID?: string
    attempt?: number
    maintenanceRound?: number
    methodID?: string
    evaluation?: import("./evaluator").EvaluationResult
  },
): Promise<TaskArtifactPaths> {
  await ensureDirectory(stageDir)
  const promptPath = path.join(stageDir, "prompt.txt")
  const stdoutPath = path.join(stageDir, "stdout.log")
  const stderrPath = path.join(stageDir, "stderr.log")
  const responsePath = path.join(stageDir, "response.txt")
  const actionTracePath = path.join(stageDir, "action_trace.md")
  const sessionExecutionReportPath = path.join(stageDir, "session_execution_report.md")
  const sessionLearningLogPath = path.join(stageDir, "session_learning_log.md")
  const sessionTaskManifestPath = path.join(stageDir, "session_task_manifest.md")
  const eventsPath = path.join(stageDir, "events.json")
  const toolFailuresPath = path.join(stageDir, "tool_failures.json")
  const runJsonPath = path.join(stageDir, "run.json")
  const descriptor = createTaskDescriptor({
    kind: input?.taskKind ?? ((input?.phase ?? "solve") as AutoEvolveTaskKind),
    title: task.title,
    phase: input?.phase,
    caseID: input?.caseID,
    attempt: input?.attempt,
    maintenanceRound: input?.maintenanceRound,
    methodID: input?.methodID,
  })

  await writeTextFile(promptPath, task.prompt + "\n")
  await writeTextFile(stdoutPath, task.result.stdout)
  await writeTextFile(stderrPath, task.result.stderr)
  await writeTextFile(responsePath, (task.result.responseText || "").trim() + "\n")
  await writeTextFile(actionTracePath, buildActionTrace(task.result.events))
  await writeTextFile(
    sessionExecutionReportPath,
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
    sessionLearningLogPath,
    buildSessionLearningLog({
      task,
      descriptor,
      evaluation: input?.evaluation,
    }),
  )
  await writeTextFile(
    sessionTaskManifestPath,
    buildSessionTaskManifest({
      task,
      descriptor,
    }),
  )
  await writeJsonFile(eventsPath, task.result.events)
  await writeJsonFile(toolFailuresPath, task.result.toolFailures)
  await writeJsonFile(runJsonPath, {
    title: task.title,
    task: descriptor,
    sessionID: task.result.sessionID,
    exitCode: task.result.exitCode,
    model: task.selectedModel ?? null,
    agent: task.selectedAgent ?? null,
    variant: task.selectedVariant ?? null,
    referencedPaths: task.referencedPaths,
    attachedFiles: task.attachedFiles,
    permissionReadPaths: task.permissionReadPaths,
    permissionEditPaths: task.permissionEditPaths,
  })

  return {
    promptPath,
    stdoutPath,
    stderrPath,
    responsePath,
    actionTracePath,
    sessionExecutionReportPath,
    sessionLearningLogPath,
    sessionTaskManifestPath,
    eventsPath,
    toolFailuresPath,
    runJsonPath,
  }
}
