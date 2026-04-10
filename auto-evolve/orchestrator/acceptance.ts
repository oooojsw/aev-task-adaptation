import { selectCasesBySplit, type DatasetSplit } from "./dataset-split"
import type { EvaluationResult } from "./evaluator"
import type { KnowledgePackSnapshot } from "./knowledge-pack"
import type { ExperienceWorkspaceLayout, ExperienceWorkspaceRole } from "./experience-workspace"
import type { CompareMode, LoadedCase } from "./schema"

export type RefineFailureClass = "output_contract" | "execution" | "reasoning"

export interface RefineRouting {
  classification: RefineFailureClass
  reasons: string[]
  preferredFiles: string[]
  suggestedRoles: ExperienceWorkspaceRole[]
  allowNewMarkdownFiles: boolean
}

function normalizeText(input: string) {
  return input.replace(/\r\n/g, "\n").trim()
}

function uniqueSorted(items: string[]) {
  return [...new Set(items)].sort((left, right) => left.localeCompare(right))
}

function resolveWorkspaceFilesByRoles(layout: ExperienceWorkspaceLayout | undefined, roles: ExperienceWorkspaceRole[]) {
  const allowed = new Set(roles)
  return uniqueSorted(
    (layout?.documents ?? [])
      .filter((item) => (item.isEntry && allowed.has("entry")) || (item.role ? allowed.has(item.role) : false))
      .map((item) => item.relativePath),
  )
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
  if (/[。！？；:]/.test(actual) && actual.length > expected.length) return true
  if (/(根据|规则|解释|说明|分析|because|reason|analysis)/i.test(actual) && actual.length > expected.length) return true
  return false
}

export function classifyRefineRouting(input: {
  mode: CompareMode
  actualText: string
  expectedText: string
  evaluation: EvaluationResult
  workspace?: ExperienceWorkspaceLayout
}): RefineRouting {
  const reasons: string[] = []

  if (input.evaluation.exitCode !== 0 || input.evaluation.toolFailures.length > 0 || !normalizeText(input.actualText)) {
    if (input.evaluation.exitCode !== 0) reasons.push(`OpenCode exit code was ${input.evaluation.exitCode}.`)
    if (input.evaluation.toolFailures.length > 0) reasons.push(`Observed ${input.evaluation.toolFailures.length} tool failure(s).`)
    if (!normalizeText(input.actualText)) reasons.push("The solve output was empty.")

    const suggestedRoles: ExperienceWorkspaceRole[] = [
      "entry",
      "change_log",
      "execution_checklist",
      "tool_guide",
      "failure_lessons",
    ]
    return {
      classification: "execution",
      reasons,
      preferredFiles: resolveWorkspaceFilesByRoles(input.workspace, suggestedRoles),
      suggestedRoles,
      allowNewMarkdownFiles: true,
    }
  }

  if (looksLikeOutputDisciplineFailure(input.mode, input.actualText, input.expectedText, input.evaluation)) {
    reasons.push("The failure looks like an output-format or output-discipline problem.")
    const suggestedRoles: ExperienceWorkspaceRole[] = [
      "entry",
      "change_log",
      "output_contract",
      "execution_checklist",
      "failure_lessons",
    ]
    return {
      classification: "output_contract",
      reasons,
      preferredFiles: resolveWorkspaceFilesByRoles(input.workspace, suggestedRoles),
      suggestedRoles,
      allowNewMarkdownFiles: true,
    }
  }

  reasons.push("The failure looks like a rule-selection or content-reasoning problem.")
  const suggestedRoles: ExperienceWorkspaceRole[] = [
    "entry",
    "change_log",
    "rule_module",
    "exception_module",
    "failure_lessons",
    "task_router",
    "partition_index",
  ]
  return {
    classification: "reasoning",
    reasons,
    preferredFiles: resolveWorkspaceFilesByRoles(input.workspace, suggestedRoles),
    suggestedRoles,
    allowNewMarkdownFiles: true,
  }
}

export function buildRefineRoutingBlock(routing: RefineRouting) {
  const lines = [
    "Refinement routing guidance:",
    `- failure class: ${routing.classification}`,
    ...routing.reasons.map((reason) => `- reason: ${reason}`),
    "- preferred existing files to update first:",
    ...(routing.preferredFiles.length ? routing.preferredFiles.map((item) => `  - ${item}`) : ["  - (none yet; create the needed Markdown modules)"]),
    "- suggested semantic roles for this maintenance step:",
    ...routing.suggestedRoles.map((item) => `  - ${item}`),
    `- creating new Markdown files inside the experience workspace is ${routing.allowNewMarkdownFiles ? "allowed" : "not allowed"}.`,
    "- Any newly created Markdown file should include an auto-evolve role marker near the top.",
    "- Keep exactly one entry file and keep the workspace Markdown-only.",
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
  return selectCasesBySplit(allCases, split, "train")
    .filter((item) => item.spec.id !== currentCaseID)
    .slice(0, Math.max(0, sampleSize))
}
