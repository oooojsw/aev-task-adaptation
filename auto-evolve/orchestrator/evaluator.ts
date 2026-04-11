import type { CompareMode } from "./schema"

export interface ToolFailure {
  tool: string
  kind: "error" | "nonzero_exit"
  title?: string
  error?: string
  output?: string
  metadata?: Record<string, unknown>
}

export interface EvaluationResult {
  passed: boolean
  mode: CompareMode
  summary: string
  mismatches: string[]
  actualPreview: string
  expectedPreview: string
  toolFailures: ToolFailure[]
  exitCode: number
}

function normalizeText(input: string) {
  return input.replace(/\r\n/g, "\n").trim()
}

function unwrapCodeFence(input: string) {
  const trimmed = input.trim()
  const match = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/)
  return match ? match[1] ?? trimmed : trimmed
}

function preview(input: string) {
  const clean = normalizeText(input)
  if (clean.length <= 240) return clean
  return clean.slice(0, 240) + "..."
}

function stableStringify(input: unknown): string {
  if (Array.isArray(input)) {
    return `[${input.map((item) => stableStringify(item)).join(",")}]`
  }
  if (input && typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${stableStringify(value)}`).join(",")}}`
  }
  return JSON.stringify(input)
}

export function evaluateResult(input: {
  mode: CompareMode
  actualText: string
  expectedText: string
  toolFailures: ToolFailure[]
  exitCode: number
}): EvaluationResult {
  const actualText = unwrapCodeFence(input.actualText)
  const expectedText = input.expectedText
  const mismatches: string[] = []
  let contentPassed = false
  let contentSummary = ""

  if (!actualText.trim()) {
    mismatches.push("OpenCode returned an empty final answer.")
  }

  switch (input.mode) {
    case "text_exact": {
      contentPassed = normalizeText(actualText) === normalizeText(expectedText)
      if (!contentPassed) mismatches.push("Normalized text does not exactly match the expected text.")
      contentSummary = contentPassed ? "Exact text matched expected output." : "Exact text comparison failed."
      break
    }
    case "text_contains": {
      contentPassed = normalizeText(actualText).includes(normalizeText(expectedText))
      if (!contentPassed) mismatches.push("Final answer does not contain the expected text block.")
      contentSummary = contentPassed ? "Final answer contains the expected text block." : "Containment comparison failed."
      break
    }
    case "json_exact": {
      try {
        const actualJson = JSON.parse(actualText)
        const expectedJson = JSON.parse(expectedText)
        contentPassed = stableStringify(actualJson) === stableStringify(expectedJson)
        if (!contentPassed) mismatches.push("Normalized JSON structure does not match expected JSON.")
        contentSummary = contentPassed ? "Exact JSON matched expected output." : "Exact JSON comparison failed."
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        contentPassed = false
        mismatches.push(`JSON parsing failed: ${message}`)
        contentSummary = "JSON comparison failed because the final answer is not valid JSON."
      }
      break
    }
  }

  if (input.exitCode !== 0) mismatches.push(`OpenCode exited with code ${input.exitCode}.`)
  if (input.toolFailures.length) mismatches.push(`${input.toolFailures.length} tool failure(s) were observed during the run.`)
  const passed = contentPassed && input.exitCode === 0 && input.toolFailures.length === 0

  let summary = contentSummary
  if (contentPassed && input.exitCode !== 0 && input.toolFailures.length === 0) {
    summary = `${contentSummary} However, the run failed because OpenCode exited with code ${input.exitCode}.`
  } else if (contentPassed && input.exitCode === 0 && input.toolFailures.length > 0) {
    summary = `${contentSummary} However, the run failed because ${input.toolFailures.length} tool failure(s) were observed.`
  } else if (contentPassed && input.exitCode !== 0 && input.toolFailures.length > 0) {
    summary = `${contentSummary} However, the run failed because OpenCode exited with code ${input.exitCode} and ${input.toolFailures.length} tool failure(s) were observed.`
  }

  return {
    passed,
    mode: input.mode,
    summary,
    mismatches,
    actualPreview: preview(actualText),
    expectedPreview: preview(expectedText),
    toolFailures: input.toolFailures,
    exitCode: input.exitCode,
  }
}
