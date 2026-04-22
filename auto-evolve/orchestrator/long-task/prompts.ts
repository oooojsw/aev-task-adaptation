import type {
  LongTaskCapabilityContract,
  LongTaskRetryInputBundle,
  LongTaskSpec,
  LongTaskValidatorContract,
  LongTaskWorkGraph,
  LongTaskWorkUnit,
} from "./contract"
import { resolveLongTaskEditablePaths } from "./repository"

function bullet(items: string[]) {
  return items.map((item) => `- ${item}`).join("\n")
}

function jsonFence(input: unknown) {
  return "```json\n" + JSON.stringify(input, null, 2) + "\n```"
}

function describePathRefs(
  refs: { path: string; label?: string; role?: string }[],
  fallback = "- none",
) {
  if (!refs.length) return fallback
  return refs
    .map((item) => {
      const labels = [item.label, item.role].filter(Boolean).join(", ")
      return labels ? `- ${item.path} (${labels})` : `- ${item.path}`
    })
    .join("\n")
}

function describeValidators(validators: LongTaskValidatorContract[]) {
  return validators
    .map((validator) => {
      if (validator.type === "script") {
        return [
          `- id: ${validator.id}`,
          `  title: ${validator.title}`,
          `  type: script`,
          `  placement: ${validator.placement ?? "unit"}`,
          `  required: ${validator.required !== false}`,
          `  blocking: ${validator.blocking === true}`,
          `  path: ${validator.path}`,
          validator.cwd ? `  cwd: ${validator.cwd}` : "",
          validator.args?.length ? `  args: ${validator.args.join(" ")}` : "",
          validator.inputMode === "none" ? "  input_mode: none" : "  input_mode: json_file",
        ]
          .filter(Boolean)
          .join("\n")
      }

      return [
        `- id: ${validator.id}`,
        `  title: ${validator.title}`,
        `  type: prompt_json`,
        `  placement: ${validator.placement ?? "unit"}`,
        `  required: ${validator.required !== false}`,
        `  blocking: ${validator.blocking === true}`,
        `  prompt: ${validator.prompt.trim()}`,
      ].join("\n")
    })
    .join("\n")
}

function describeEditablePaths(spec: LongTaskSpec) {
  return bullet(resolveLongTaskEditablePaths(spec))
}

function describeCapabilities(capabilities: LongTaskCapabilityContract[]) {
  if (!capabilities.length) return "- none"
  return capabilities
    .map((capability) =>
      [
        `- id: ${capability.id}`,
        `  title: ${capability.title}`,
        `  kind: ${capability.kind}`,
        `  description: ${capability.description.trim()}`,
        capability.referencePaths?.length ? `  reference_paths: ${capability.referencePaths.join(", ")}` : "",
        capability.attachedFiles?.length ? `  attached_files: ${capability.attachedFiles.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n")
}

export function buildLongTaskPlanningPrompt(input: {
  spec: LongTaskSpec
  specPath: string
  planningOutputPath: string
}) {
  const completionValidatorIDs = input.spec.validators.filter((item) => item.required !== false).map((item) => item.id)
  return [
    "You are bootstrapping the initial work graph for a validator-driven long task.",
    "",
    `Spec path: ${input.specPath}`,
    `Planning output path: ${input.planningOutputPath}`,
    "",
    "Task goal:",
    input.spec.goal.trim(),
    "",
    "Materials:",
    describePathRefs(input.spec.materials),
    "",
    "Target paths:",
    describePathRefs(input.spec.targetPaths ?? []),
    "",
    "Editable paths:",
    describeEditablePaths(input.spec),
    "",
    "Campaign pending expert package:",
    input.spec.campaignPendingPackageRoot ? `- ${input.spec.campaignPendingPackageRoot}` : "- none",
    "",
    "Campaign exploration tree:",
    input.spec.campaignExplorationTreePath ? `- ${input.spec.campaignExplorationTreePath}` : "- none",
    "",
    "Campaign working memory:",
    input.spec.campaignWorkingMemoryPath ? `- ${input.spec.campaignWorkingMemoryPath}` : "- none",
    "",
    "Campaign routing control:",
    input.spec.campaignRoutingControlPath ? `- ${input.spec.campaignRoutingControlPath}` : "- none",
    "",
    "Initial expert context:",
    bullet((input.spec.initialExpertContextPaths ?? []).map((item) => item)) || "- none",
    "",
    "Available validators:",
    describeValidators(input.spec.validators),
    "",
    "Registered capabilities:",
    describeCapabilities(input.spec.capabilities ?? []),
    "",
    "Planning rules:",
    "- You must create a small initial work graph without requiring a human-provided work graph.",
    "- Each work unit must be a minimal semantic obligation that can be locally retried.",
    "- Each work unit must reduce uncertainty against the goal or the validators.",
    "- Treat the current campaign pending expert package as the latest draft expert experience, not as an optional note.",
    "- Treat the exploration tree as a map of explored and unexplored solution space, not as a hard law.",
    "- Treat the routing control file as the hard next-round control signal. Required regions and forbidden units must change the graph.",
    "- Read the full exploration tree first, then use role_positions.planner as your immediate focus.",
    "- Prefer 3 to 8 work units unless the task is trivial.",
    `- The graph must end in validator-backed completion using these completion validators: ${completionValidatorIDs.join(", ") || "(none)"}.`,
    "- Do not create units that are just 'read file X' or 'think more'.",
    "- Every unit must include a claim and a check plan.",
    "- Think in terms of capability gaps, not domain steps. Choose units because they close an inspection, transformation, comparison, synthesis, or validation gap.",
    "- When intermediate validators are available, attach them to the units that produce the corresponding intermediate artifacts.",
    "- Exploratory or analysis-only units must not be blocked by final delivery validators before target outputs exist.",
    "- If a unit is only for reading materials, tracing evidence, or preparing structure, set validator_ids to an empty array.",
    "- Reserve final delivery validators for units that actually produce or finalize the target outputs.",
    "- Units may reuse the same validator if needed.",
    "",
    "Return JSON only, with this shape:",
    jsonFence({
      planner_summary: "why this initial graph is shaped this way",
      completion_validator_ids: completionValidatorIDs,
      units: [
        {
          id: "short-kebab-id",
          title: "short human title",
          goal: "what this unit must achieve",
          inputs: ["absolute/or/spec-relative-paths or symbolic inputs"],
          depends_on: [],
          expected_artifacts: ["paths or artifact labels"],
          claim: "what success would mean for this unit",
          check_plan: "how the unit should be checked",
          validator_ids: completionValidatorIDs,
          retry_budget: Math.min(input.spec.budgets?.maxAttemptsPerUnit ?? 3, 3),
        },
      ],
    }),
  ].join("\n")
}

export function buildLongTaskExecutionPrompt(input: {
  spec: LongTaskSpec
  graph: LongTaskWorkGraph
  unit: LongTaskWorkUnit
  bundlePath: string
  validatorInputPaths: string[]
}) {
  const relevantValidators = input.spec.validators.filter((validator) => input.unit.validatorIDs.includes(validator.id))
  return [
    "You are executing one work unit inside a validator-driven long task.",
    "",
    "Global goal:",
    input.spec.goal.trim(),
    "",
    `Current work unit: ${input.unit.id}`,
    `Title: ${input.unit.title}`,
    `Goal: ${input.unit.goal}`,
    `Claim: ${input.unit.claim}`,
    `Check plan: ${input.unit.checkPlan}`,
    `Current attempt: ${input.unit.attemptCount}`,
    `Retry budget for this unit: ${input.unit.retryBudget}`,
    "",
    "Expected artifacts:",
    input.unit.expectedArtifacts.length ? bullet(input.unit.expectedArtifacts) : "- none",
    "",
    "Materials:",
    describePathRefs(input.spec.materials),
    "",
    "Target paths:",
    describePathRefs(input.spec.targetPaths ?? []),
    "",
    "Editable paths:",
    describeEditablePaths(input.spec),
    "",
    "Campaign pending expert package:",
    input.spec.campaignPendingPackageRoot ? `- ${input.spec.campaignPendingPackageRoot}` : "- none",
    "",
    "Campaign exploration tree:",
    input.spec.campaignExplorationTreePath ? `- ${input.spec.campaignExplorationTreePath}` : "- none",
    "",
    "Campaign working memory:",
    input.spec.campaignWorkingMemoryPath ? `- ${input.spec.campaignWorkingMemoryPath}` : "- none",
    "",
    "Campaign routing control:",
    input.spec.campaignRoutingControlPath ? `- ${input.spec.campaignRoutingControlPath}` : "- none",
    "",
    "Formal package roots:",
    input.spec.formalPackageRoots?.length
      ? bullet(input.spec.formalPackageRoots)
      : "- infer from the tracked expert workspace and experience-workspace targets",
    "",
    "Initial expert context:",
    (input.spec.initialExpertContextPaths ?? []).length
      ? bullet(input.spec.initialExpertContextPaths ?? [])
      : "- none",
    "",
    `Retry input bundle path: ${input.bundlePath}`,
    "",
    "Validators for this unit:",
    describeValidators(relevantValidators),
    "",
    "Registered capabilities:",
    describeCapabilities(input.spec.capabilities ?? []),
    "",
    input.validatorInputPaths.length
      ? ["Prepared validator input payloads (you may inspect them if useful):", bullet(input.validatorInputPaths), ""].join(
          "\n",
        )
      : "",
    "Execution rules:",
    "- You may read and modify only the task-relevant paths provided to you.",
    "- Work backward from the current claim and validators. Every action should either reduce uncertainty or increase validator confidence.",
    "- Read the full exploration tree first, then use role_positions.executor as your immediate focus.",
    "- Read the current campaign pending expert package, exploration tree, working memory, and routing control before deciding how to proceed.",
    "- Runtime shell is Windows PowerShell. Prefer PowerShell-native commands (for example: Get-ChildItem, Select-String, Test-Path).",
    "- Do not use Unix shell command styles such as `ls -la`, `||`, `&&`, or bash-only syntax.",
    "- Do not rely on rg/grep/glob/skill tool calls in this task runtime. Use PowerShell-native file search and inspection instead.",
    "- Document, spreadsheet, and template handling must be headless-only. Do not launch Word, Excel, Explorer, or any other desktop GUI application.",
    "- Do not use Start-Process, Invoke-Item, file association opens, explorer.exe, WINWORD, EXCEL, or equivalent GUI-launch paths.",
    "- If you update surface_contract.json, keep it in the platform surface-contract schema. Use entry/changeLog/documents instead of replacing the contract with task-local custom keys only.",
    "- Choose capabilities because of the gap they close, not because of domain habit or fixed task recipes.",
    "- You may create small local helper artifacts inside editable paths when they materially improve verification or retryability, but do not assume any task-specific route is mandatory.",
    "- You may use validator scripts directly when they are available and useful for self-checking.",
    "- Do not invent new validators.",
    "- Produce the expected artifacts for the current unit whenever the unit calls for explicit intermediate outputs.",
    "- If the current unit has no formal validators, satisfy the check plan by creating the expected artifacts and leaving concise structured scratch evidence.",
    "- Read the retry bundle carefully, especially recent failures, relevant learning units, run-global operational context, and relevant shadow memory. Repeated mistakes should change your next move.",
    "- Do not declare orchestrator or campaign-lead 'stuck' based only on a stale heartbeat timestamp or a missing execute/ directory during an in-flight attempt.",
    "- For an in-flight attempt, seeing only retry_input_bundle.json can be normal before task artifacts are flushed; treat this as unknown state, not proof of no-spawn.",
    "- If you suspect runtime stall, label it as a hypothesis unless you have hard evidence (for example: owner process not alive, repeated no-progress checks over time, or explicit runtime timeout/error).",
    "- Treat the formal expert package as a live shared surface. If you stabilize a rule, method, blocker, or package gap, write it into the formal package instead of leaving it only in local notes.",
    "- If this is not the first attempt for the current unit, you must explicitly acknowledge the previous same-unit failure, state what strategy changed this time, and list the self-checks you ran before returning your claim.",
    "- Keep scratch notes short and structured.",
    "- If you are blocked, say so explicitly in the JSON output instead of pretending success.",
    "",
    "Return JSON only, with this shape:",
    jsonFence({
      claim_statement: "one short sentence describing what you now claim is true",
      claimed_success: true,
      blockers: ["optional blocker"],
      next_priority_fix: "optional next fix",
      retry_ack: "required on retry attempts: what you understood from the previous same-unit failure",
      strategy_change: "required on retry attempts: what changed in this attempt",
      self_checks_run: ["validator or local check you ran before returning the claim"],
      updated_files: ["absolute/path/you/changed"],
      scratch_units: [
        {
          kind: "obs",
          statement: "short observation",
          refs: ["file:/abs/path or validator:ID"],
          related_unit_ids: [input.unit.id],
        },
      ],
      learning_units: [
        {
          kind: "failure_pattern",
          statement: "short reusable learning",
          scope: "local",
          strength: 1,
          refs: ["validator:ID"],
          relations: [],
        },
      ],
    }),
  ]
    .filter(Boolean)
    .join("\n")
}

export function buildLongTaskPromptValidatorPrompt(input: {
  spec: LongTaskSpec
  unit: LongTaskWorkUnit
  validator: Extract<LongTaskValidatorContract, { type: "prompt_json" }>
  bundlePath: string
}) {
  return [
    "You are a validator for a long-running task.",
    "",
    "Global goal:",
    input.spec.goal.trim(),
    "",
    `Current work unit: ${input.unit.id}`,
    `Unit goal: ${input.unit.goal}`,
    `Unit claim: ${input.unit.claim}`,
    "",
    `Retry bundle path: ${input.bundlePath}`,
    "",
    "Validator contract:",
    input.validator.prompt.trim(),
    "",
    "Task target paths:",
    describePathRefs(input.spec.targetPaths ?? []),
    "",
    "Return JSON only:",
    jsonFence({
      passed: true,
      summary: "one short summary sentence",
      details: ["short detail"],
      blocking: false,
    }),
  ].join("\n")
}

export function buildLongTaskReplanPrompt(input: {
  spec: LongTaskSpec
  graph: LongTaskWorkGraph
  unresolvedUnits: LongTaskWorkUnit[]
  failurePacketSummaries: string[]
  replanOutputPath: string
}) {
  const completionValidatorIDs =
    input.graph.completionValidatorIDs.length > 0
      ? input.graph.completionValidatorIDs
      : input.spec.validators.filter((item) => item.required !== false).map((item) => item.id)

  return [
    "You are replanning the remaining work graph for a validator-driven long task.",
    "",
    `Replan output path: ${input.replanOutputPath}`,
    "",
    "Global goal:",
    input.spec.goal.trim(),
    "",
    "Current unresolved units:",
    jsonFence(
      input.unresolvedUnits.map((unit) => ({
        id: unit.id,
        title: unit.title,
        goal: unit.goal,
        depends_on: unit.dependsOn,
        validator_ids: unit.validatorIDs,
        status: unit.status,
      })),
    ),
    "",
    "Recent failure packet summaries:",
    input.failurePacketSummaries.length ? bullet(input.failurePacketSummaries) : "- none",
    "",
    "Campaign pending expert package:",
    input.spec.campaignPendingPackageRoot ? `- ${input.spec.campaignPendingPackageRoot}` : "- none",
    "",
    "Campaign exploration tree:",
    input.spec.campaignExplorationTreePath ? `- ${input.spec.campaignExplorationTreePath}` : "- none",
    "",
    "Campaign working memory:",
    input.spec.campaignWorkingMemoryPath ? `- ${input.spec.campaignWorkingMemoryPath}` : "- none",
    "",
    "Campaign routing control:",
    input.spec.campaignRoutingControlPath ? `- ${input.spec.campaignRoutingControlPath}` : "- none",
    "",
    "Available validators:",
    describeValidators(input.spec.validators),
    "",
    "Registered capabilities:",
    describeCapabilities(input.spec.capabilities ?? []),
    "",
    "Replanning rules:",
    "- Keep already-verified units out of the new draft.",
    "- Only emit remaining or replacement units.",
    "- Prefer the smallest graph change that can escape the current failure pattern.",
    "- Use the exploration tree as a memory of explored solution regions, but do not treat it as an untouchable rulebook.",
    "- Treat the routing control file as a hard constraint. Required regions must appear, and forbidden units must not reappear.",
    "- Read the full exploration tree first, then use role_positions.planner as your immediate focus.",
    "- Replan around capability gaps and validator gaps, not around domain recipes.",
    `- Keep completion validator ids aligned with: ${completionValidatorIDs.join(", ") || "(none)"}.`,
    "- Prefer intermediate validators for intermediate outputs whenever such validators are available.",
    "- Do not attach final delivery validators to pure analysis or evidence-gathering units.",
    "- If a replanned unit only reads materials or prepares structure, its validator_ids may be an empty array.",
    "",
    "Return JSON only, with this shape:",
    jsonFence({
      planner_summary: "why the graph changed",
      completion_validator_ids: completionValidatorIDs,
      units: [
        {
          id: "replanned-unit-id",
          title: "short title",
          goal: "what remains to do",
          inputs: ["path or logical dependency"],
          depends_on: [],
          expected_artifacts: ["artifact"],
          claim: "claim",
          check_plan: "how to validate",
          validator_ids: completionValidatorIDs,
          retry_budget: Math.min(input.spec.budgets?.maxAttemptsPerUnit ?? 3, 3),
        },
      ],
    }),
  ].join("\n")
}
