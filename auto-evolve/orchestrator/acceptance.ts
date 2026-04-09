import { selectCasesBySplit, type DatasetSplit } from "./dataset-split"
import type { EvaluationResult } from "./evaluator"
import type { KnowledgePackSnapshot } from "./knowledge-pack"
import type { CompareMode, LoadedCase } from "./schema"

export type RefineFailureClass = "output_contract" | "execution" | "reasoning"

export interface RefineRouting {
  classification: RefineFailureClass
  reasons: string[]
  allowedFiles: string[]
  preferredFiles: string[]
}

function normalizeText(input: string) {
  return input.replace(/\r\n/g, "\n").trim()
}

function withSharedFiles(files: string[]) {
  return [...new Set([...files, "manifest.md", "change_log.md"])].sort((left, right) => left.localeCompare(right))
}

function looksLikeOutputDisciplineFailure(mode: CompareMode, actualText: string, expectedText: string, evaluation: EvaluationResult) {
  if (mode === "json_exact") {
    return evaluation.mismatches.some((item) => item.startsWith("JSON parsing failed"))
  }

  if (mode !== "text_exact") return false

  const actual = normalizeText(actualText)
  const expected = normalizeText(expectedText)
  if (!actual || !expected) return false

  if (actual.includes(expected) && actual !== expected) return true
  if (actual.includes("```")) return true
  if (actual.includes("\n")) return true
  if (/[。！？:：]/.test(actual) && actual.length > expected.length) return true
  if (/(根据|规则|解释|说明|分析|because|reason|analysis)/i.test(actual) && actual.length > expected.length) return true
  return false
}

export function classifyRefineRouting(input: {
  mode: CompareMode
  actualText: string
  expectedText: string
  evaluation: EvaluationResult
}): RefineRouting {
  const reasons: string[] = []

  if (input.evaluation.exitCode !== 0 || input.evaluation.toolFailures.length > 0 || !normalizeText(input.actualText)) {
    if (input.evaluation.exitCode !== 0) reasons.push(`OpenCode exit code was ${input.evaluation.exitCode}.`)
    if (input.evaluation.toolFailures.length > 0) reasons.push(`Observed ${input.evaluation.toolFailures.length} tool failure(s).`)
    if (!normalizeText(input.actualText)) reasons.push("The solve output was empty.")
    return {
      classification: "execution",
      reasons,
      allowedFiles: withSharedFiles([
        "core/execution_checklist.md",
        "core/expert_rules.md",
        "lessons/failure_lessons.md",
      ]),
      preferredFiles: ["core/execution_checklist.md", "lessons/failure_lessons.md"],
    }
  }

  if (looksLikeOutputDisciplineFailure(input.mode, input.actualText, input.expectedText, input.evaluation)) {
    reasons.push("The failure looks like an output-format or output-discipline problem.")
    return {
      classification: "output_contract",
      reasons,
      allowedFiles: withSharedFiles([
        "core/output_contract.md",
        "core/execution_checklist.md",
        "lessons/failure_lessons.md",
      ]),
      preferredFiles: ["core/output_contract.md", "core/execution_checklist.md"],
    }
  }

  reasons.push("The failure looks like a rule-selection or content-reasoning problem.")
  return {
    classification: "reasoning",
    reasons,
    allowedFiles: withSharedFiles([
      "core/expert_rules.md",
      "patterns/general_rules.md",
      "patterns/exceptions.md",
      "lessons/failure_lessons.md",
    ]),
    preferredFiles: ["patterns/general_rules.md", "patterns/exceptions.md", "core/expert_rules.md"],
  }
}

export function buildRefineRoutingBlock(routing: RefineRouting) {
  const lines = [
    "Refinement routing guidance:",
    `- failure class: ${routing.classification}`,
    ...routing.reasons.map((reason) => `- reason: ${reason}`),
    "- allowed knowledge-pack files:",
    ...routing.allowedFiles.map((item) => `  - ${item}`),
    "- preferred first targets:",
    ...routing.preferredFiles.map((item) => `  - ${item}`),
    "- Do not modify any knowledge-pack file that is not listed above.",
  ]
  return lines.join("\n")
}

export function diffAgainstReference(reference: KnowledgePackSnapshot, candidate: KnowledgePackSnapshot) {
  return Object.keys(reference)
    .filter((relative) => reference[relative] !== candidate[relative])
    .sort((left, right) => left.localeCompare(right))
}

export function selectRegressionCases(
  allCases: LoadedCase[],
  split: DatasetSplit,
  currentCaseID: string,
  sampleSize: number,
) {
  return selectCasesBySplit(allCases, split, "train").filter((item) => item.spec.id !== currentCaseID).slice(0, Math.max(0, sampleSize))
}
