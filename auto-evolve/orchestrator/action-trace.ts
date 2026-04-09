import type { OpencodeEvent } from "./opencode"

function limitText(input: string, maxLines = 12, maxChars = 800) {
  const trimmed = input.replace(/\r\n/g, "\n").trim()
  if (!trimmed) return ""
  const lines = trimmed.split("\n")
  const slicedLines = lines.slice(0, maxLines)
  let output = slicedLines.join("\n")
  if (output.length > maxChars) {
    output = output.slice(0, maxChars) + "..."
  }
  if (lines.length > maxLines) {
    output += `\n... (${lines.length - maxLines} more lines omitted)`
  }
  return output
}

function formatBlock(label: string, value: unknown) {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") {
    const text = limitText(value)
    return text ? `${label}:\n${text}` : ""
  }
  try {
    return `${label}:\n${limitText(JSON.stringify(value, null, 2))}`
  } catch {
    return `${label}:\n${String(value)}`
  }
}

export function buildActionTrace(events: OpencodeEvent[]) {
  const lines: string[] = ["# Solve Action Trace", ""]
  let index = 0

  for (const event of events) {
    index += 1
    if (event.type === "step_start") {
      lines.push(`## ${index}. step_start`)
      lines.push(`- session: ${event.sessionID ?? "unknown"}`)
      if (event.part?.snapshot) lines.push(`- snapshot: ${event.part.snapshot}`)
      lines.push("")
      continue
    }

    if (event.type === "step_finish") {
      lines.push(`## ${index}. step_finish`)
      lines.push(`- reason: ${event.part?.reason ?? "unknown"}`)
      if (event.part?.cost !== undefined) lines.push(`- cost: ${event.part.cost}`)
      if (event.part?.tokens) {
        lines.push(`- tokens: ${JSON.stringify(event.part.tokens)}`)
      }
      lines.push("")
      continue
    }

    if (event.type === "tool_use") {
      const tool = event.part?.tool ?? "unknown"
      const status = event.part?.state?.status ?? "unknown"
      lines.push(`## ${index}. tool_use: ${tool}`)
      lines.push(`- status: ${status}`)
      if (event.part?.callID) lines.push(`- callID: ${event.part.callID}`)

      const inputBlock = formatBlock("input", event.part?.state?.input)
      const outputBlock = formatBlock("output", event.part?.state?.output)
      const errorBlock = formatBlock("error", event.part?.state?.error)
      const metadataBlock = formatBlock("metadata", event.part?.state?.metadata ?? event.part?.metadata)
      const titleBlock = formatBlock("title", event.part?.state?.title)

      for (const block of [titleBlock, inputBlock, outputBlock, errorBlock, metadataBlock]) {
        if (!block) continue
        lines.push("")
        lines.push(block)
      }
      lines.push("")
      continue
    }

    if (event.type === "text" && typeof event.part?.text === "string") {
      const text = limitText(event.part.text)
      if (!text) continue
      lines.push(`## ${index}. assistant_text`)
      lines.push(text)
      lines.push("")
      continue
    }

    if (event.type === "error") {
      lines.push(`## ${index}. session_error`)
      lines.push(limitText(JSON.stringify(event.error ?? {}, null, 2)))
      lines.push("")
    }
  }

  if (lines.length === 2) {
    lines.push("No action events were captured.")
    lines.push("")
  }

  return lines.join("\n")
}
