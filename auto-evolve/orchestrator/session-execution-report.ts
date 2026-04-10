import type { EvaluationResult } from "./evaluator"
import type { OpencodeEvent, OpencodeTaskRun } from "./opencode"

export interface SessionExecutionReportInput {
  task: OpencodeTaskRun
  phase?: string
  caseID?: string
  attempt?: number
  methodID?: string
  evaluation?: EvaluationResult
}

function limitText(input: string, maxLines = 16, maxChars = 1400) {
  const trimmed = input.replace(/\r\n/g, "\n").trim()
  if (!trimmed) return ""
  const lines = trimmed.split("\n")
  const slicedLines = lines.slice(0, maxLines)
  let output = slicedLines.join("\n")
  if (output.length > maxChars) output = output.slice(0, maxChars) + "..."
  if (lines.length > maxLines) output += `\n... (${lines.length - maxLines} more lines omitted)`
  return output
}

function formatUnknown(value: unknown) {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return limitText(value)
  try {
    return limitText(JSON.stringify(value, null, 2))
  } catch {
    return limitText(String(value))
  }
}

function block(label: string, value: unknown) {
  const formatted = formatUnknown(value)
  if (!formatted) return ""
  return `${label}:\n${formatted}`
}

function summarizeToolUsage(events: OpencodeEvent[]) {
  const toolEvents = events.filter((event) => event.type === "tool_use")
  const byTool = new Map<string, number>()
  const repeatedCalls = new Map<string, { tool: string; count: number; input: string }>()
  const failures: string[] = []
  const likelyEmptyExplorations: string[] = []

  for (const event of toolEvents) {
    const tool = String(event.part?.tool ?? "unknown")
    byTool.set(tool, (byTool.get(tool) ?? 0) + 1)
    const status = String(event.part?.state?.status ?? "unknown")
    const input = formatUnknown(event.part?.state?.input)
    const signature = `${tool}::${input}`
    repeatedCalls.set(signature, {
      tool,
      count: (repeatedCalls.get(signature)?.count ?? 0) + 1,
      input,
    })

    if (status === "error") {
      failures.push(`${tool}: ${formatUnknown(event.part?.state?.error) || "unknown error"}`)
    }

    const output = (event.part?.state?.output ?? "").toString().trim()
    if ((tool === "read" || tool === "list" || tool === "glob" || tool === "grep") && !output) {
      likelyEmptyExplorations.push(`${tool}: empty output`)
    }
  }

  const repeated = [...repeatedCalls.values()]
    .filter((item) => item.count > 1)
    .sort((left, right) => right.count - left.count)
    .slice(0, 8)

  return {
    totalToolCalls: toolEvents.length,
    byTool: [...byTool.entries()].sort((a, b) => b[1] - a[1]),
    repeated,
    failures,
    likelyEmptyExplorations,
  }
}

function timeline(events: OpencodeEvent[]) {
  const lines: string[] = []
  let index = 0

  for (const event of events) {
    index += 1

    if (event.type === "step_start") {
      lines.push(`### ${index}. step_start`)
      lines.push(`- session: ${event.sessionID ?? "unknown"}`)
      if (event.part?.snapshot) lines.push(`- snapshot: ${event.part.snapshot}`)
      lines.push("")
      continue
    }

    if (event.type === "step_finish") {
      lines.push(`### ${index}. step_finish`)
      lines.push(`- reason: ${event.part?.reason ?? "unknown"}`)
      if (event.part?.cost !== undefined) lines.push(`- cost: ${event.part.cost}`)
      if (event.part?.tokens) lines.push(`- tokens: ${JSON.stringify(event.part.tokens)}`)
      lines.push("")
      continue
    }

    if (event.type === "tool_use") {
      const tool = String(event.part?.tool ?? "unknown")
      const status = String(event.part?.state?.status ?? "unknown")
      lines.push(`### ${index}. tool_use: ${tool}`)
      lines.push(`- status: ${status}`)
      if (event.part?.callID) lines.push(`- callID: ${event.part.callID}`)
      for (const piece of [
        block("title", event.part?.state?.title),
        block("input", event.part?.state?.input),
        block("output", event.part?.state?.output),
        block("error", event.part?.state?.error),
        block("metadata", event.part?.state?.metadata ?? event.part?.metadata),
      ]) {
        if (!piece) continue
        lines.push("")
        lines.push(piece)
      }
      lines.push("")
      continue
    }

    if (event.type === "text") {
      const text = formatUnknown(event.part?.text)
      if (!text) continue
      lines.push(`### ${index}. assistant_text`)
      lines.push(text)
      lines.push("")
      continue
    }

    if (event.type === "reasoning") {
      const text = formatUnknown(event.part?.text)
      if (!text) continue
      lines.push(`### ${index}. reasoning`)
      lines.push(text)
      lines.push("")
      continue
    }

    if (event.type === "error") {
      lines.push(`### ${index}. session_error`)
      lines.push(formatUnknown(event.error))
      lines.push("")
      continue
    }

    lines.push(`### ${index}. ${event.type}`)
    lines.push(formatUnknown(event.part ?? event.error ?? event))
    lines.push("")
  }

  if (lines.length === 0) {
    lines.push("No action events were captured.")
    lines.push("")
  }

  return lines
}

export function buildSessionExecutionReport(input: SessionExecutionReportInput) {
  const { task, evaluation } = input
  const report: string[] = ["# Session Execution Report", ""]
  const toolSummary = summarizeToolUsage(task.result.events)

  report.push("## Session Meta")
  report.push(`- title: ${task.title}`)
  report.push(`- session id: ${task.result.sessionID ?? "unknown"}`)
  report.push(`- phase: ${input.phase ?? "unknown"}`)
  if (input.caseID) report.push(`- case id: ${input.caseID}`)
  if (input.attempt !== undefined) report.push(`- attempt: ${input.attempt}`)
  if (input.methodID) report.push(`- method: ${input.methodID}`)
  report.push(`- model: ${task.selectedModel ?? "default"}`)
  report.push(`- agent: ${task.selectedAgent ?? "default"}`)
  report.push(`- variant: ${task.selectedVariant ?? "default"}`)
  report.push(`- exit code: ${task.result.exitCode}`)
  report.push(`- tool failures: ${task.result.toolFailures.length}`)
  report.push("")

  report.push("## Path Inputs")
  report.push(`- referenced paths (${task.referencedPaths.length})`)
  for (const item of task.referencedPaths) report.push(`  - ${item}`)
  report.push(`- attached files (${task.attachedFiles.length})`)
  for (const item of task.attachedFiles) report.push(`  - ${item}`)
  report.push(`- permission read paths (${task.permissionReadPaths.length})`)
  for (const item of task.permissionReadPaths) report.push(`  - ${item}`)
  report.push(`- permission edit paths (${task.permissionEditPaths.length})`)
  for (const item of task.permissionEditPaths) report.push(`  - ${item}`)
  report.push("")

  report.push("## Final Outcome")
  report.push(`- response preview: ${formatUnknown(task.result.responseText) || "(empty)"}`)
  if (evaluation) {
    report.push(`- evaluation passed: ${evaluation.passed}`)
    report.push(`- evaluation summary: ${evaluation.summary}`)
    if (evaluation.mismatches.length) {
      report.push(`- mismatches:`)
      for (const mismatch of evaluation.mismatches) report.push(`  - ${mismatch}`)
    }
  }
  if (task.result.stderr.trim()) {
    report.push("")
    report.push(block("stderr excerpt", task.result.stderr))
  }
  report.push("")

  report.push("## Tool Failure Summary")
  if (!toolSummary.failures.length && !task.result.toolFailures.length) {
    report.push("- no tool failures recorded")
  } else {
    for (const failure of task.result.toolFailures) {
      report.push(`- ${failure.tool} (${failure.kind})${failure.error ? `: ${limitText(failure.error, 4, 240)}` : ""}`)
    }
    for (const failure of toolSummary.failures) {
      report.push(`- ${failure}`)
    }
  }
  report.push("")

  report.push("## Behavior Summary")
  report.push(`- total tool calls: ${toolSummary.totalToolCalls}`)
  if (toolSummary.byTool.length) {
    report.push("- tool usage counts:")
    for (const [tool, count] of toolSummary.byTool) report.push(`  - ${tool}: ${count}`)
  }
  if (toolSummary.repeated.length) {
    report.push("- repeated tool calls:")
    for (const item of toolSummary.repeated) {
      report.push(`  - ${item.tool} repeated ${item.count} times`)
      if (item.input) report.push(`    input excerpt: ${limitText(item.input, 4, 220)}`)
    }
  }
  if (toolSummary.likelyEmptyExplorations.length) {
    report.push("- likely empty explorations:")
    for (const item of toolSummary.likelyEmptyExplorations.slice(0, 8)) report.push(`  - ${item}`)
  }
  report.push("")

  report.push("## Ordered Timeline")
  report.push(...timeline(task.result.events))

  return report.join("\n")
}
