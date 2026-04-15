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
    case "exploration_tree_synthesizer":
      return "Extract exploration-space updates: which solution regions were explored, which failed strongly, which remain promising."
    default:
      return "Extract structured campaign suggestions from the current round."
  }
}

export function buildCampaignWorkerPrompt(input: {
  title: string
  roundNumber: number
  role: LongTaskCampaignWorkerRole
  runTracePath: string
  pendingPackageRoot: string
  explorationTreePath: string
  reviewerSuggestionPath?: string
  campaignMemoryPaths: string[]
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
      `run_trace: ${input.runTracePath}`,
      `pending_expert_package: ${input.pendingPackageRoot}`,
      `exploration_tree_json: ${input.explorationTreePath}`,
      ...(input.reviewerSuggestionPath ? [`latest_reviewer_suggestion: ${input.reviewerSuggestionPath}`] : []),
    ]),
    "",
    "Campaign-internal memory inputs:",
    bullet(input.campaignMemoryPaths),
    "",
    "Worker rules:",
    "- You are not the final campaign author.",
    "- Do not rewrite the pending expert package directly.",
    "- Do not output a generic summary report.",
    "- Focus on structured suggestions that a campaign lead can assemble into the next pending expert package.",
    "- Ground every important claim in the run trace or the current pending package.",
    "- Do not leak hidden validator answers or protected reference-only truth.",
    "",
    "Return JSON only, with this shape:",
    jsonFence({
      summary: "one short sentence",
      findings: ["key finding"],
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
  workerSuggestionPaths: string[]
  reviewerSuggestionPath?: string
  campaignMemoryPaths: string[]
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
      ...(input.reviewerSuggestionPath ? [`latest_reviewer_suggestion: ${input.reviewerSuggestionPath}`] : []),
    ]),
    "",
    "Worker suggestions:",
    bullet(input.workerSuggestionPaths),
    "",
    "Campaign-internal memory inputs:",
    bullet(input.campaignMemoryPaths),
    "",
    "Editable targets:",
    bullet([
      `next_pending_expert_package_root: ${input.nextPendingPackageRoot}`,
      `next_exploration_tree_json: ${input.nextExplorationTreePath}`,
    ]),
    "",
    "Campaign lead rules:",
    "- You are the only role allowed to rewrite the next pending expert package.",
    "- Write a real expert package, not a review memo.",
    "- The package must stay structurally compatible with the formal expert workspace surface.",
    "- Include concrete task logic, data linkage logic, numeric calculation guidance, field-location rules, template-filling rules, and explicit failure-path constraints when justified by evidence.",
    "- Update the exploration tree as a map, not as a rigid lawbook.",
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
    ]),
    "",
    "Reviewer rules:",
    "- You do not edit the package.",
    "- You do not accept or reject the package.",
    "- You only assess whether this package looks likely to pass the final blank-agent acceptance.",
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
