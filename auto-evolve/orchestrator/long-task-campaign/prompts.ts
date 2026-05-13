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
    case "tool_failure_synthesizer":
      return "Extract recurring tool-call failures and convert them into compact, executable bypass guidance for the next round."
    case "forbidden_path_synthesizer":
      return "Extract high-confidence do-not-repeat paths that should become explicit negative guidance."
    case "learning_promoter":
      return "Rescue durable cross-unit lessons that are still trapped in local learning units or retry lessons and propose how campaign memory should preserve them."
    case "exploration_tree_synthesizer":
      return "Extract exploration-space updates: which solution regions were explored, which failed strongly, which remain promising."
    case "drift_guard_synthesizer":
      return "Extract blank-agent drift signals and recurring detours, then propose compact anti-drift guardrails."
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
    case "tool_failure_synthesizer":
      return [
        "- Focus on command/tool failures only (glob, shell syntax, dotnet invocation, encoding/path/runtime startup), not business correctness.",
        "- Read run_trace_full.attempts[].commandRecords and follow attempts[].toolFailuresPath refs for raw failure evidence.",
        "- Deduplicate repeated errors into canonical patterns; do not repeat the same issue in different wording.",
        "- Every finding should be actionable: failure pattern -> concrete bypass or guardrail for next round.",
        "- In package_advice, write short instructions that blank-agent can execute directly under the same environment.",
      ]
    case "drift_guard_synthesizer":
      return [
        "- Focus only on blank-agent execution drift: wrong operation order, missing mandatory checks, repeated avoidable mistakes.",
        "- Ignore platform/system signals (heartbeat, spawn, pid, EPERM, infrastructure) even if they appear in logs.",
        "- Convert drift evidence into short executable guardrails, not long diagnosis prose.",
        "- In exploration_advice, update anti_drift branch nodes so next round can avoid repeated blank-agent drift.",
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
  dispatchTicketsPath: string
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
      `dispatch_tickets_json: ${input.dispatchTicketsPath}`,
      ...(input.reviewerSuggestionPath ? [`latest_reviewer_suggestion: ${input.reviewerSuggestionPath}`] : []),
    ]),
    "",
    "Worker rules:",
    "- You are not the final campaign author.",
    "- Do not rewrite the pending expert package directly.",
    "- Do not output a generic summary report.",
    "- Read the full exploration tree first, then use role_positions.campaign_worker as your own position.",
    "- Focus on structured suggestions that a campaign lead can assemble into the next pending expert package.",
    "- Ground every important claim in the run-trace digest, working memory, routing control, or the current pending package.",
    "- Distinguish verified infrastructure blockers from agent-side inference. Do not treat 'stale heartbeat' wording alone as a confirmed blocker.",
    "- A missing execute/ directory for an in-flight attempt is not by itself proof of no-spawn; mark uncertain runtime diagnostics as tentative, not final.",
    "- Do not leak hidden validator answers or protected reference-only truth.",
    "- For non-drift_guard_synthesizer roles: if blank-agent execution hits system-level blockers (timeout/spawn/EPERM/path/encoding/runtime startup), propose BOTH package_advice and exploration_advice updates.",
    "- For non-drift_guard_synthesizer roles: for system blockers inside blank-agent execution, include bypass-oriented advice instead of diagnosis-only text.",
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
  dispatchTicketsPath: string
  workerSuggestionPaths: string[]
  reviewerSuggestionPath?: string
  acceptanceExperiencePath?: string
  finalAcceptanceFeedbackPath?: string
  repairChecklist?: string[]
}) {
  return [
    "You are the campaign lead for a multi-round long-task learning campaign.",
    "",
    `Campaign title: ${input.title}`,
    `Round: ${input.roundNumber}`,
    "",
    ...(input.repairChecklist && input.repairChecklist.length
      ? [
          "==================== MANDATORY REPAIR CHECKLIST (pass-02) ====================",
          "",
          "The previous pass validation FAILED. The failures have been parsed into",
          "concrete repair instructions below. You MUST address every item.",
          "",
          "HARD RULE: If this checklist is non-empty, you MUST NOT return updated_files: []. ",
          "Each repair item requires at least one file change.",
          "",
          "If you genuinely believe an item should NOT be fixed (system-level blocker, not",
          "content-level), you MUST explain why in package_highlights for each skipped item.",
          "",
          ...input.repairChecklist.map((item, i) => `REPAIR-${String(i + 1).padStart(3, "0")}: ${item}`),
          "",
          "=============================================================================",
          "",
        ]
      : []),
    "Primary inputs:",
    bullet([
      `run_trace: ${input.runTracePath}`,
      `previous_pending_expert_package: ${input.previousPendingPackageRoot}`,
      `previous_exploration_tree_json: ${input.previousExplorationTreePath}`,
      `working_memory_json: ${input.workingMemoryPath}`,
      `previous_routing_control_json: ${input.previousRoutingControlPath}`,
      `dispatch_tickets_json: ${input.dispatchTicketsPath}`,
      ...(input.reviewerSuggestionPath ? [`latest_reviewer_suggestion: ${input.reviewerSuggestionPath}`] : []),
      ...(input.acceptanceExperiencePath ? [`acceptance_experience: ${input.acceptanceExperiencePath}`] : []),
      ...(input.finalAcceptanceFeedbackPath
        ? [`latest_final_acceptance_result: ${input.finalAcceptanceFeedbackPath}`]
        : []),
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
    "- You are the only role allowed to rewrite the exploration tree.",
    "- You are the only role allowed to rewrite the next routing control file.",
    "- Read the full exploration tree first, then use role_positions.campaign_lead as your own position.",
    "- Write a real expert package, not a review memo.",
    "- `acceptance_experience` is a compact cross-round acceptance history; use it to spot repeated rejection patterns and avoid reintroducing known failures.",
    "- Treat `acceptance_experience` as trend memory, not ground truth for the current pass. Current run evidence and latest validator feedback still have priority.",
    "- The package must stay structurally compatible with the formal expert workspace surface.",
    "- The formal package must teach how to locate, derive, verify, and fill values. Do not bake final task-answer literals, fixed result numbers, or reference-only truth directly into the package.",
    "- If a rule can be written as a source locator, field mapping, calculation recipe, fill order, or self-check, prefer that form over embedding the answer itself.",
    "- BEFORE declaring completion, you MUST self-check: search all files you wrote for any literal task-answer values (exact numbers like 20,260, dates like 2026-03-23, proper names from source data). If you find any, replace them with source-locator descriptions.",
    "- Report your self-check result in the JSON fields 'surface_precheck_passed' (boolean) and 'surface_precheck_details' (string array listing any forbidden literals you found and removed).",
    "- The expert-surface-generalization validator scans for forbidden literals. If this validator failed in a previous pass or round, do NOT claim success without first verifying you have eliminated ALL instances of the forbidden values listed in the validator config.",
    "- Include concrete task logic, data linkage logic, numeric calculation guidance, field-location rules, template-filling rules, and explicit failure-path constraints when justified by evidence.",
    "- Keep the package high-cohesion and low-coupling: each file should have a clear role, repeated rules should have one canonical home, and other files should point to that home instead of cloning the same prose.",
    "- surface_contract.json is a machine-only control file. It must remain raw JSON only with the platform schema fields such as entry, changeLog, and documents. Never wrap it in Markdown, HTML comments, or prose.",
    "- Update the exploration tree as a map, not as a rigid lawbook.",
    "- For exploration-tree nodes, you must use only these status values: unexplored, in_progress, weak_fail, strong_fail, promising, validated_success, deprecated.",
    "- Do not use non-schema statuses such as verified_success, pending, done, success, failed.",
    "- Status mapping rule: if you would write verified_success, write validated_success instead; if you would write pending, write unexplored or in_progress based on actual progress.",
    "- Keep routing control small and hard: only write signals that should directly change the next graph.",
    "- Treat previous_routing_control.blockedBy as a live blocker list, not an append-only history log.",
    "- Before writing next_routing_control_json, audit every previous blockedBy item against current run evidence, worker suggestions, reviewer feedback, final acceptance feedback, and the next pending package.",
    "- Remove a blockedBy item when the current package or run evidence shows it is already fixed, superseded, deprecated, or no longer actionable.",
    "- Do not keep stale blockedBy items just because they appeared in an older summary. If a resolved issue still matters historically, record it in tree notes or package lessons, not as an active blocker.",
    "- If you remove a stale blockedBy item, mention the cleanup briefly in tree_highlights or package_highlights so the next round understands why it disappeared.",
    "- Treat open dispatch tickets as mandatory repairs that must be visibly encoded into package/tree/routing for the next round.",
    "- If latest_final_acceptance_result exists and failed, treat it as the highest-priority concrete repair input for this pass.",
    "- If this round exposed blank-agent execution system blockers, you must encode them into BOTH targets: pending expert package (failure lessons/checklist with concrete bypass guidance) and exploration tree (explicit region/node update).",
    "- Do not keep blank-agent system blockers only in tree notes or only in internal memory; the package must also carry executable bypass guidance.",
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
      surface_precheck_passed: "true or false (REQUIRED - did you self-check for hardcoded literals?)",
      surface_precheck_details: ["list any forbidden literals found and removed"],
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
  dispatchTicketsPath: string
  acceptanceExperiencePath?: string
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
      `dispatch_tickets_json: ${input.dispatchTicketsPath}`,
      ...(input.acceptanceExperiencePath ? [`acceptance_experience: ${input.acceptanceExperiencePath}`] : []),
    ]),
    "",
    "Reviewer rules:",
    "- You do not edit the package.",
    "- You do not accept or reject the package.",
    "- Read the full exploration tree first, then use role_positions.campaign_reviewer as your own position.",
    "- `acceptance_experience` is a concise history of past acceptance outcomes; use it to check whether repeated historical failures were actually addressed this round.",
    "- Do not copy old rejection text blindly from `acceptance_experience`; confirm with current package + run trace before keeping the same reason.",
    "- If dispatch tickets are still open and the package does not clearly repair them, mark not ready and name the missed ticket areas.",
    "- You only assess whether this package looks likely to pass the final blank-agent acceptance.",
    "- Mark not ready if the package hardcodes final task answers instead of teaching blank-agent how to derive them from the provided materials.",
    "- Mark not ready if the same operational rule is copied across many files without a clear canonical home.",
    "- Mark not ready if surface_contract.json is not pure machine-readable JSON in the platform schema.",
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
