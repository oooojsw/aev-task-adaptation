import type { Snapshot } from "./contract"
import type { PackSnapshot } from "./project-pack"
import { immutable } from "./identity"
import type { Entry } from "./entry"

export interface AuthorContext {
  fingerprint: string
  projectFingerprint: string
  task: string
  phase: string
  claim: string
  executor?: { id: string; version: string; settings: Record<string, unknown> }
  skill: PackSnapshot["pack"]["skill"]
  checks: Array<{ name: string; target: string; stage: string; mechanism: string; required: boolean }>
}

export function authorContext(entry: Entry, protocol: Snapshot, project: PackSnapshot): AuthorContext {
  const plan = protocol.selection.protocol.phases[entry.phase]
  if (!plan) throw new Error("Missing author protocol phase")
  // 作者只收到协议职责摘要，不把私有评分路径和凭证配置塞进提示。
  return immutable({ fingerprint: protocol.fingerprint, projectFingerprint: project.fingerprint,
    task: entry.taskID, phase: entry.phase, claim: plan.claim,
    ...(plan.executor ? { executor: { id: plan.executor.id, version: plan.executor.version,
      settings: Object.fromEntries(["model", "maxTokens", "temperature", "skillPlacement", "maxInputBytes"]
        .filter((key) => plan.executor!.settings[key] !== undefined).map((key) => [key, plan.executor!.settings[key]])) } } : {}),
    skill: project.pack.skill, checks: plan.checks.map(({ name, target, stage, mechanism, required }) =>
      ({ name, target, stage, mechanism, required })) })
}

export function protocolAuthorLines(context: AuthorContext) {
  return ["Frozen acceptance contract (author-facing view):", JSON.stringify(context, null, 2),
    "The host controller owns formal acceptance; do not launch another acceptance or claim a pass from self-review.",
    "Author exploration may retain its existing tools and multiple steps. Acceptance execution is a separate configured backend.",
    "Use the declared Skill entry files. Do not invent README, INDEX, CORE, answer.txt or surface_contract.json requirements.",
    "Only explicit checks define required constraints. Skill checks do not prove task execution or held-out transfer.",
    "On ordinary rejection, use the actual candidate, product and check evidence to revise reusable guidance.",
    "Execution/scoring/data faults require infrastructure or dataset handling, not invented Skill repairs.",
    "Absent tool traces do not imply failure. Do not change evaluator, private labels, protocol or execution mode.",
    "Private scoring inputs and task-specific answers must not be copied into deployable Skill."]
}

export function protocolRolePrompt(role: "worker" | "lead" | "reviewer", input: {
  protocolContext: AuthorContext
  title: string
  roundNumber: number
  [key: string]: unknown
}) {
  const readableKeys = ["runTracePath", "runTraceDigestPath", "pendingPackageRoot", "previousPendingPackageRoot",
    "explorationTreePath", "previousExplorationTreePath", "workingMemoryPath", "routingControlPath",
    "previousRoutingControlPath", "dispatchTicketsPath", "blankAgentAcceptanceDiagnosisPath",
    "acceptanceExperiencePath", "finalAcceptanceFeedbackPath", "reviewerSuggestionPath", "workerSuggestionPaths", "protocolFeedbackPaths",
    "blankAgentEvidenceBundlePath", "blankAgentEvidenceReadPaths"]
  const inputs = Object.fromEntries(readableKeys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]))
  const output = role === "worker" ? { summary: "", findings: [], memory_advice: [], package_advice: [], exploration_advice: [], refs: [] }
    : role === "lead" ? { summary: "", updated_files: [], package_highlights: [], tree_highlights: [], refs: [],
      surface_precheck_passed: false, surface_precheck_details: [] }
    : { ready_for_final_acceptance: false, summary: "", reasons: [], next_attention_areas: [], refs: [] }
  return [ `You are the campaign ${role}. Campaign: ${input.title}. Round: ${input.roundNumber}.`,
    ...protocolAuthorLines(input.protocolContext),
    role === "worker" ? `Analysis role: ${String(input.role)}. Provide evidence-grounded suggestions; do not edit Skill.`
      : role === "reviewer" ? "Review only; do not edit or issue a formal acceptance verdict. Readiness is advice, not a pass."
      : "Write actual reusable Skill and update exploration/routing in the declared editable targets only.",
    "Readable references:", JSON.stringify(inputs, null, 2),
    ...(role === "lead" ? ["Editable targets:", JSON.stringify({ skill: input.nextPendingPackageRoot,
      exploration: input.nextExplorationTreePath, routing: input.nextRoutingControlPath }),
      "Use exploration statuses unexplored, in_progress, weak_fail, strong_fail, promising, validated_success, deprecated.",
      "Remove resolved routing blockers using current evidence; keep runtime directives out of Skill.",
      "Review repair checklist against current receipts; do not fabricate a content change for an infrastructure fault.",
      JSON.stringify({ repairChecklist: input.repairChecklist ?? [] }),
      "Self-check answer leakage; the reported surface self-check is author advice, not a host check result.",
      "A product rejection means the generated answer failed, not that Skill content is prohibited.",
      "Inspect the declared actual product and public materials before proposing a reusable correction.",
      "surface_precheck fields describe your Skill self-review only; do not populate them with product-check failures."] : []),
    "Every claim needs current evidence. Keep all JSON paths forward-slash normalized.",
    "Return JSON only, matching this shape:", JSON.stringify(output, null, 2)].join("\n")
}
