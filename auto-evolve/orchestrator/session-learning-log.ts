import type { EvaluationResult } from "./evaluator"
import type { OpencodeTaskRun } from "./opencode"
import type { AutoEvolveTaskDescriptor } from "./task-model"

function countToolUses(events: OpencodeTaskRun["result"]["events"]) {
  const counts = new Map<string, number>()
  for (const event of events) {
    if (event.type !== "tool_use") continue
    const toolName = typeof event.part?.tool === "string" && event.part.tool.trim() ? event.part.tool : "(unknown)"
    counts.set(toolName, (counts.get(toolName) ?? 0) + 1)
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])
}

function formatToolCounts(entries: [string, number][]) {
  if (!entries.length) return "- no explicit tool usage was recorded"
  return entries.map(([name, count]) => `- ${name}: ${count} time(s)`).join("\n")
}

function behaviorNotes(task: OpencodeTaskRun, evaluation?: EvaluationResult) {
  const notes: string[] = []
  const toolUses = task.result.events.filter((event) => event.type === "tool_use")
  const assistantTexts = task.result.events.filter((event) => event.type === "text")

  if (!toolUses.length) {
    notes.push("The session solved the task without explicit tool usage.")
  }
  if (task.result.toolFailures.length) {
    notes.push(`Tool failures were observed: ${task.result.toolFailures.length}.`)
  }
  if (assistantTexts.length > 1) {
    notes.push(`The agent emitted ${assistantTexts.length} assistant text blocks, which may indicate iterative narration.`)
  }
  if (evaluation?.mismatches.length) {
    notes.push(`Evaluation mismatches were recorded: ${evaluation.mismatches.join(" | ")}`)
  }
  if (task.result.exitCode !== 0) {
    notes.push(`The task exited with code ${task.result.exitCode}.`)
  }

  return notes.length ? notes : ["No special behavior warnings were derived from the session trace."]
}

export function buildSessionLearningLog(input: {
  task: OpencodeTaskRun
  descriptor: AutoEvolveTaskDescriptor
  evaluation?: EvaluationResult
}) {
  const toolCounts = countToolUses(input.task.result.events)
  const notes = behaviorNotes(input.task, input.evaluation)

  return [
    "# Session Learning Log",
    "",
    "## Task",
    "",
    `- kind: ${input.descriptor.kind}`,
    `- layer: ${input.descriptor.layer}`,
    `- role: ${input.descriptor.role}`,
    `- phase: ${input.descriptor.phase}`,
    input.descriptor.caseID ? `- case: ${input.descriptor.caseID}` : "",
    input.descriptor.attempt !== undefined ? `- attempt: ${input.descriptor.attempt}` : "",
    input.descriptor.maintenanceRound !== undefined
      ? `- maintenance round: ${input.descriptor.maintenanceRound}`
      : "",
    input.descriptor.methodID ? `- method: ${input.descriptor.methodID}` : "",
    "",
    "## What Happened",
    "",
    `- session id: ${input.task.result.sessionID || "(unknown)"}`,
    `- exit code: ${input.task.result.exitCode}`,
    `- finish reason: ${input.task.result.finishReason || "(unknown)"}`,
    "",
    "## Tool Usage Pattern",
    "",
    formatToolCounts(toolCounts),
    "",
    "## Derived Lessons",
    "",
    ...notes.map((note) => `- ${note}`),
    "",
  ]
    .filter(Boolean)
    .join("\n")
}
