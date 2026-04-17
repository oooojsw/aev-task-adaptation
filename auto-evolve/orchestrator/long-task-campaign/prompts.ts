import type {
  LongTaskCampaignReviewSuggestion,
  LongTaskCampaignWorkerRole,
  LongTaskCampaignWorkerSuggestion,
} from "./contract"

function bullet(items: string[]) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- none"
}

function jsonFence(input: unknown) {
  return "```json\n" + JSON.stringify(input, null, 2) + "\n```"
}

function roleDescription(role: LongTaskCampaignWorkerRole) {
  switch (role) {
    case "success_synthesizer":
      return "Extract stable successful paths, validated methods, and reusable command/tool entrypoints from the run trace."
    case "failure_synthesizer":
      return "Extract the real failure paths, blockers, and failure causes from the run trace."
    case "forbidden_path_synthesizer":
      return "Extract high-confidence do-not-repeat paths that should become explicit negative guidance."
    case "learning_promoter":
      return "Rescue durable cross-unit lessons that are still trapped in local learning units or retry lessons and propose how campaign memory should preserve them."
    case "exploration_tree_synthesizer":
      return "Extract exploration-space updates: which solution regions were explored, which failed strongly, which remain promising."
    default:
      return "Extract structured campaign suggestions from the current round."
  }
}

function roleSpecificRules(role: LongTaskCampaignWorkerRole) {
  switch (role) {
    case "learning_promoter":
      return [
        "- Inspect the full run trace, including attempt-level learning units, retry lessons, and operational context across all units.",
        "- Focus on durable lessons that should survive beyond one unit even if they were not promoted automatically.",
        "- Prefer compact canonical statements instead of copying raw logs or long historical prose.",
        "- Use memory_advice to say what should be promoted into campaign memory, seed context, failure lessons, routing control, or the pending expert package.",
      ]
    default:
      return [] as string[]
  }
}

export function buildCampaignWorkerPrompt(input: {
  title: string
  roundNumber: number
  role: LongTaskCampaignWorkerRole
  runTracePath: string
  runTraceDigestPath: string
  pendingPackageRoot: string
  explorationTreePath: string
  workingMemoryPath: string
  routingControlPath: string
  reviewerSuggestionPath?: string
}) {
  return [
    "You are a campaign worker agent inside a multi-round long-task learning campaign.",
    "",
    `Campaign title: ${input.title}`,
    `Round: ${input.roundNumber}`,
    `Role: ${input.role}`,
    `Role objective: ${roleDescription(input.role)}`,
    "",
    "Primary inputs:",
    bullet([
      `run_trace_full: ${input.runTracePath}`,
      `run_trace_digest: ${input.runTraceDigestPath}`,
      `pending_expert_package: ${input.pendingPackageRoot}`,
      `exploration_tree_json: ${input.explorationTreePath}`,
      `working_memory_json: ${input.workingMemoryPath}`,
      `routing_control_json: ${input.routingControlPath}`,
      ...(input.reviewerSuggestionPath ? [`latest_reviewer_suggestion: ${input.reviewerSuggestionPath}`] : []),
    ]),
    "",
    "Worker rules:",
    "- You are not the final campaign author.",
    "- Do not rewrite the pending expert package directly.",
    "- Do not output a generic summary report.",
    "- Focus on structured suggestions that a campaign lead can assemble into the next pending expert package.",
    "- Ground every important claim in the run-trace digest, working memory, routing control, or the current pending package.",
    "- Distinguish verified infrastructure blockers from agent-side inference. Do not treat 'stale heartbeat' wording alone as a confirmed blocker.",
    "- A missing execute/ directory for an in-flight attempt is not by itself proof of no-spawn; mark uncertain runtime diagnostics as tentative, not final.",
    "- Do not leak hidden validator answers or protected reference-only truth.",
    ...roleSpecificRules(input.role),
    "",
    "Return JSON only, with this shape:",
    jsonFence({
      summary: "one short sentence",
      findings: ["key finding"],
      memory_advice: ["what durable lesson should be promoted and where it should live"],
      package_advice: ["what the pending expert package should add, remove, or clarify"],
      exploration_advice: ["what should change in the exploration tree"],
      refs: ["absolute/path/or/reference"],
    } satisfies Omit<LongTaskCampaignWorkerSuggestion, "id" | "roundNumber" | "role" | "createdAt" | "responsePath">),
    "",
  ].join("\n")
}

export function buildCampaignLeadPrompt(input: {
  title: string
  roundNumber: number
  runTracePath: string
  previousPendingPackageRoot: string
  nextPendingPackageRoot: string
  previousExplorationTreePath: string
  nextExplorationTreePath: string
  workingMemoryPath: string
  previousRoutingControlPath: string
  nextRoutingControlPath: string
  workerSuggestionPaths: string[]
  reviewerSuggestionPath?: string
}) {
  return [
    "You are the campaign lead for a multi-round long-task learning campaign.",
    "",
    `Campaign title: ${input.title}`,
    `Round: ${input.roundNumber}`,
    "",
    "Primary inputs:",
    bullet([
      `run_trace: ${input.runTracePath}`,
      `previous_pending_expert_package: ${input.previousPendingPackageRoot}`,
      `previous_exploration_tree_json: ${input.previousExplorationTreePath}`,
      `working_memory_json: ${input.workingMemoryPath}`,
      `previous_routing_control_json: ${input.previousRoutingControlPath}`,
      ...(input.reviewerSuggestionPath ? [`latest_reviewer_suggestion: ${input.reviewerSuggestionPath}`] : []),
    ]),
    "",
    "Worker suggestions:",
    bullet(input.workerSuggestionPaths),
    "",
    "Editable targets:",
    bullet([
      `next_pending_expert_package_root: ${input.nextPendingPackageRoot}`,
      `next_exploration_tree_json: ${input.nextExplorationTreePath}`,
      `next_routing_control_json: ${input.nextRoutingControlPath}`,
    ]),
    "",
    "Campaign lead rules:",
    "- You are the only role allowed to rewrite the next pending expert package.",
    "- Write a real expert package, not a review memo.",
    "- The package must stay structurally compatible with the formal expert workspace surface.",
    "- Include concrete task logic, data linkage logic, numeric calculation guidance, field-location rules, template-filling rules, and explicit failure-path constraints when justified by evidence.",
    "- Update the exploration tree as a map, not as a rigid lawbook.",
    "- For exploration-tree nodes, you must use only these status values: unexplored, in_progress, weak_fail, strong_fail, promising, validated_success, deprecated.",
    "- Do not use non-schema statuses such as verified_success, pending, done, success, failed.",
    "- Status mapping rule: if you would write verified_success, write validated_success instead; if you would write pending, write unexplored or in_progress based on actual progress.",
    "- Keep routing control small and hard: only write signals that should directly change the next graph.",
    "- Do not copy tentative runtime-stall narratives into routing_control.blockedBy as hard blockers unless supported by hard evidence in run trace.",
    "- Do not put round-specific command directives into the package if they belong in routing control instead.",
    "- If a worker suggestion includes memory_advice, treat it as rescue guidance for durable lessons that might otherwise stay trapped in unit-local memory.",
    "- Do not leak hidden validator answers or protected reference-only truth.",
    "",
    "Return JSON only, with this shape:",
    jsonFence({
      summary: "one short sentence",
      updated_files: ["absolute/path/you/changed"],
      package_highlights: ["important package changes"],
      tree_highlights: ["important exploration-tree changes"],
      refs: ["absolute/path/or/reference"],
    }),
    "",
  ].join("\n")
}

export function buildCampaignReviewerPrompt(input: {
  title: string
  roundNumber: number
  pendingPackageRoot: string
  runTracePath: string
  explorationTreePath: string
  workingMemoryPath: string
  routingControlPath: string
}) {
  return [
    "You are the round reviewer for a multi-round long-task learning campaign.",
    "",
    `Campaign title: ${input.title}`,
    `Round: ${input.roundNumber}`,
    "",
    "Inputs:",
    bullet([
      `pending_expert_package: ${input.pendingPackageRoot}`,
      `run_trace: ${input.runTracePath}`,
      `exploration_tree_json: ${input.explorationTreePath}`,
      `working_memory_json: ${input.workingMemoryPath}`,
      `routing_control_json: ${input.routingControlPath}`,
    ]),
    "",
    "Reviewer rules:",
    "- You do not edit the package.",
    "- You do not accept or reject the package.",
    "- You only assess whether this package looks likely to pass the final blank-agent acceptance.",
    "- Do not treat heartbeat wording alone as decisive failure evidence; require hard run-trace evidence before concluding a true orchestrator stall.",
    "- If it is not ready, explain the reasons in abstract diagnostic language.",
    "- Do not leak hidden validator answers or protected reference-only truth.",
    "",
    "Return JSON only, with this shape:",
    jsonFence({
      ready_for_final_acceptance: false,
      summary: "one short sentence",
      reasons: ["why it still looks risky"],
      next_attention_areas: ["what campaign should look at next"],
      refs: ["absolute/path/or/reference"],
    } satisfies Omit<LongTaskCampaignReviewSuggestion, "id" | "roundNumber" | "createdAt" | "responsePath">),
    "",
  ].join("\n")
}
