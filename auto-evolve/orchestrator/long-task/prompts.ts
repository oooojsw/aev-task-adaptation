import type {
  LongTaskRetryInputBundle,
  LongTaskSpec,
  LongTaskValidatorContract,
  LongTaskWorkGraph,
  LongTaskWorkUnit,
} from "./contract"

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
        `  required: ${validator.required !== false}`,
        `  blocking: ${validator.blocking === true}`,
        `  prompt: ${validator.prompt.trim()}`,
      ].join("\n")
    })
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
    bullet((input.spec.editablePaths ?? []).map((item) => item)),
    "",
    "Initial expert context:",
    bullet((input.spec.initialExpertContextPaths ?? []).map((item) => item)) || "- none",
    "",
    "Available validators:",
    describeValidators(input.spec.validators),
    "",
    "Planning rules:",
    "- You must create a small initial work graph without requiring a human-provided work graph.",
    "- Each work unit must be a minimal semantic obligation that can be locally retried.",
    "- Prefer 3 to 8 work units unless the task is trivial.",
    `- The graph must end in validator-backed completion using these completion validators: ${completionValidatorIDs.join(", ") || "(none)"}.`,
    "- Do not create units that are just 'read file X' or 'think more'.",
    "- Every unit must include a claim and a check plan.",
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
    `Retry budget for this unit: ${input.unit.retryBudget}`,
    "",
    "Materials:",
    describePathRefs(input.spec.materials),
    "",
    "Target paths:",
    describePathRefs(input.spec.targetPaths ?? []),
    "",
    "Editable paths:",
    bullet((input.spec.editablePaths ?? []).map((item) => item)),
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
    input.validatorInputPaths.length
      ? ["Prepared validator input payloads (you may inspect them if useful):", bullet(input.validatorInputPaths), ""].join(
          "\n",
        )
      : "",
    "Execution rules:",
    "- You may read and modify only the task-relevant paths provided to you.",
    "- You may use validator scripts directly when they are available and useful for self-checking.",
    "- Do not invent new validators.",
    "- Keep scratch notes short and structured.",
    "- If you are blocked, say so explicitly in the JSON output instead of pretending success.",
    "",
    "Return JSON only, with this shape:",
    jsonFence({
      claim_statement: "one short sentence describing what you now claim is true",
      claimed_success: true,
      blockers: ["optional blocker"],
      next_priority_fix: "optional next fix",
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
    "Available validators:",
    describeValidators(input.spec.validators),
    "",
    "Replanning rules:",
    "- Keep already-verified units out of the new draft.",
    "- Only emit remaining or replacement units.",
    "- Prefer the smallest graph change that can escape the current failure pattern.",
    `- Keep completion validator ids aligned with: ${completionValidatorIDs.join(", ") || "(none)"}.`,
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

