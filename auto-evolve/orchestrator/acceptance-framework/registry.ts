import type {
  AcceptanceHarnessDescriptor,
  AcceptancePolicyDescriptor,
  AcceptanceStandardDescriptor,
} from "./contract"

const STANDARDS: AcceptanceStandardDescriptor[] = [
  {
    id: "maintainer-completed",
    title: "Maintainer Completed",
    summary: "The maintainer finished successfully and produced a candidate workspace state.",
    level: "transaction",
    targetKinds: ["maintenance_transaction"],
    pluginFriendly: true,
  },
  {
    id: "workspace-changed",
    title: "Workspace Changed",
    summary: "The candidate transaction actually changed tracked expert experience.",
    level: "transaction",
    targetKinds: ["maintenance_transaction"],
    pluginFriendly: true,
  },
  {
    id: "workspace-layout-valid",
    title: "Workspace Layout Valid",
    summary: "The tracked expert workspace still satisfies the canonical layout rules.",
    level: "transaction",
    targetKinds: ["maintenance_transaction", "canonical_experience", "candidate_experience"],
    pluginFriendly: true,
  },
  {
    id: "current-case-fixed",
    title: "Current Case Fixed",
    summary: "The target case or target unit now meets its intended result.",
    level: "transaction",
    targetKinds: ["maintenance_transaction", "work_unit"],
    pluginFriendly: true,
  },
  {
    id: "regression-nondegrading",
    title: "Regression Nondegrading",
    summary: "Reference behavior did not regress relative to the baseline evidence.",
    level: "transaction",
    targetKinds: ["maintenance_transaction"],
    pluginFriendly: true,
  },
  {
    id: "post-judge-accepted",
    title: "Post-Judge Accepted",
    summary: "The post-judge or equivalent transaction reviewer accepted the current candidate.",
    level: "transaction",
    targetKinds: ["maintenance_transaction"],
    pluginFriendly: true,
  },
  {
    id: "unit-validators-passed",
    title: "Unit Validators Passed",
    summary: "The active long-task work unit satisfied both execution and validator requirements.",
    level: "local",
    targetKinds: ["work_unit"],
    pluginFriendly: true,
  },
  {
    id: "completion-validators-passed",
    title: "Completion Validators Passed",
    summary: "The long-task completion validators accepted the finished run.",
    level: "candidate",
    targetKinds: ["candidate_experience"],
    pluginFriendly: true,
  },
  {
    id: "candidate-maintainer-ready",
    title: "Candidate Maintainer Ready",
    summary: "The current candidate has enough evidence to be preserved for later maintainer or governance review.",
    level: "candidate",
    targetKinds: ["candidate_experience"],
    pluginFriendly: true,
  },
  {
    id: "blank-agent-single-session-success",
    title: "Blank Agent Single-Session Success",
    summary:
      "A blank agent, with only the allowed formal expert surface and task materials, completed the task in one uninterrupted session.",
    level: "deployment",
    targetKinds: ["deployment_run", "candidate_experience", "canonical_experience"],
    pluginFriendly: true,
  },
]

const HARNESSES: AcceptanceHarnessDescriptor[] = [
  {
    id: "maintainer-exit-check",
    title: "Maintainer Exit Check",
    summary: "Inspect whether the maintainer finished successfully before deeper acceptance continues.",
    kind: "maintainer_exit_check",
    levels: ["transaction"],
    targetKinds: ["maintenance_transaction"],
    pluginFriendly: true,
    stateful: false,
  },
  {
    id: "workspace-diff-check",
    title: "Workspace Diff Check",
    summary: "Check whether tracked expert experience changed in a meaningful way.",
    kind: "workspace_diff_check",
    levels: ["transaction"],
    targetKinds: ["maintenance_transaction"],
    pluginFriendly: true,
    stateful: false,
  },
  {
    id: "workspace-layout-check",
    title: "Workspace Layout Check",
    summary: "Validate the tracked expert workspace layout and allowed file surface.",
    kind: "workspace_layout_check",
    levels: ["transaction", "candidate"],
    targetKinds: ["maintenance_transaction", "candidate_experience", "canonical_experience"],
    pluginFriendly: true,
    stateful: false,
  },
  {
    id: "verify-current-case",
    title: "Verify Current Case",
    summary: "Re-run the target case after maintenance to verify that the intended failure was fixed.",
    kind: "verify_current_case",
    levels: ["transaction"],
    targetKinds: ["maintenance_transaction"],
    pluginFriendly: true,
    stateful: true,
  },
  {
    id: "regression-suite",
    title: "Regression Suite",
    summary: "Run selected regression cases and compare before/after pass counts and losses.",
    kind: "regression_suite",
    levels: ["transaction"],
    targetKinds: ["maintenance_transaction"],
    pluginFriendly: true,
    stateful: true,
  },
  {
    id: "post-judge-review",
    title: "Post-Judge Review",
    summary: "Use a post-judge reviewer to convert transaction evidence into an accept or retry decision.",
    kind: "post_judge_review",
    levels: ["transaction"],
    targetKinds: ["maintenance_transaction"],
    pluginFriendly: true,
    stateful: true,
  },
  {
    id: "long-task-unit-validators",
    title: "Long-Task Unit Validators",
    summary: "Use long-task unit execution claims and validator results as local acceptance evidence.",
    kind: "long_task_validator",
    levels: ["local"],
    targetKinds: ["work_unit"],
    pluginFriendly: true,
    stateful: true,
  },
  {
    id: "long-task-completion-validators",
    title: "Long-Task Completion Validators",
    summary: "Use long-task completion validators and run summary as candidate acceptance evidence.",
    kind: "long_task_validator",
    levels: ["candidate"],
    targetKinds: ["candidate_experience"],
    pluginFriendly: true,
    stateful: true,
  },
  {
    id: "candidate-package-review",
    title: "Candidate Package Review",
    summary: "Review whether the candidate package is preserved at the correct status for later maintainer or governance steps.",
    kind: "candidate_package_review",
    levels: ["candidate"],
    targetKinds: ["candidate_experience"],
    pluginFriendly: true,
    stateful: false,
  },
  {
    id: "blank-agent-single-session-case",
    title: "Blank Agent Single-Session Case",
    summary:
      "Run a blank-agent one-session case solve using only the allowed formal expert surface plus task materials.",
    kind: "blank_agent_single_session_case",
    levels: ["deployment"],
    targetKinds: ["deployment_run", "candidate_experience", "canonical_experience"],
    pluginFriendly: true,
    stateful: true,
  },
]

const POLICIES: AcceptancePolicyDescriptor[] = [
  {
    id: "strict-regression-guard",
    title: "Strict Regression Guard",
    summary:
      "Transaction acceptance requires a valid workspace, a fixed target case, and no harmful regression before canonical acceptance.",
    status: "active",
    pluginFriendly: true,
    stages: [
      {
        id: "transaction_guard",
        title: "Transaction Guard",
        summary: "Evaluate the maintenance transaction before canonical acceptance.",
        level: "transaction",
        targetKind: "maintenance_transaction",
        standardIDs: [
          "maintainer-completed",
          "workspace-changed",
          "workspace-layout-valid",
          "current-case-fixed",
          "regression-nondegrading",
          "post-judge-accepted",
        ],
        harnessIDs: [
          "maintainer-exit-check",
          "workspace-diff-check",
          "workspace-layout-check",
          "verify-current-case",
          "regression-suite",
          "post-judge-review",
        ],
        successOutcome: "accept",
        failureOutcome: "retry",
        required: true,
      },
    ],
  },
  {
    id: "add-only-conservative-guard",
    title: "Add-Only Conservative Guard",
    summary:
      "Transaction acceptance favors narrow additive repairs and rejects unstable or structurally invalid additive updates.",
    status: "active",
    pluginFriendly: true,
    stages: [
      {
        id: "transaction_guard",
        title: "Add-Only Transaction Guard",
        summary: "Evaluate the additive maintenance transaction before canonical acceptance.",
        level: "transaction",
        targetKind: "maintenance_transaction",
        standardIDs: [
          "maintainer-completed",
          "workspace-changed",
          "workspace-layout-valid",
          "current-case-fixed",
          "regression-nondegrading",
          "post-judge-accepted",
        ],
        harnessIDs: [
          "maintainer-exit-check",
          "workspace-diff-check",
          "workspace-layout-check",
          "verify-current-case",
          "regression-suite",
          "post-judge-review",
        ],
        successOutcome: "accept",
        failureOutcome: "retry",
        required: true,
      },
    ],
  },
  {
    id: "long-task-candidate-guard",
    title: "Long-Task Candidate Guard",
    summary:
      "Candidate acceptance for long-task runs preserves only runs that completed their required validators and are maintainer-ready.",
    status: "active",
    pluginFriendly: true,
    stages: [
      {
        id: "local_guard",
        title: "Local Work-Unit Guard",
        summary: "Evaluate whether the current long-task work unit satisfied its execution and validator contract.",
        level: "local",
        targetKind: "work_unit",
        standardIDs: ["unit-validators-passed"],
        harnessIDs: ["long-task-unit-validators"],
        successOutcome: "observe",
        failureOutcome: "retry",
        required: true,
      },
      {
        id: "candidate_guard",
        title: "Candidate Guard",
        summary: "Evaluate whether a long-task run should be preserved as a maintainer-ready candidate.",
        level: "candidate",
        targetKind: "candidate_experience",
        standardIDs: ["completion-validators-passed", "candidate-maintainer-ready"],
        harnessIDs: ["long-task-completion-validators", "candidate-package-review"],
        successOutcome: "promote",
        failureOutcome: "hold",
        required: true,
      },
    ],
  },
  {
    id: "blank-agent-single-session-gate",
    title: "Blank-Agent Single-Session Gate",
    summary:
      "Deployment acceptance requires that a blank agent can solve the target in one uninterrupted session using only the allowed formal expert surface.",
    status: "experimental",
    pluginFriendly: true,
    stages: [
      {
        id: "deployment_guard",
        title: "Deployment Guard",
        summary: "Run the highest-level deployment acceptance harness.",
        level: "deployment",
        targetKind: "deployment_run",
        standardIDs: ["blank-agent-single-session-success"],
        harnessIDs: ["blank-agent-single-session-case"],
        successOutcome: "promote",
        failureOutcome: "hold",
        required: true,
      },
    ],
  },
]

export function listAcceptanceStandards() {
  return [...STANDARDS]
}

export function resolveAcceptanceStandard(standardID: string) {
  const standard = STANDARDS.find((item) => item.id === standardID)
  if (!standard) {
    throw new Error(`Unknown acceptance standard: ${standardID}`)
  }
  return standard
}

export function listAcceptanceHarnesses() {
  return [...HARNESSES]
}

export function resolveAcceptanceHarness(harnessID: string) {
  const harness = HARNESSES.find((item) => item.id === harnessID)
  if (!harness) {
    throw new Error(`Unknown acceptance harness: ${harnessID}`)
  }
  return harness
}

export function listAcceptancePolicies() {
  return [...POLICIES]
}

export function resolveAcceptancePolicy(policyID: string) {
  const policy = POLICIES.find((item) => item.id === policyID)
  if (!policy) {
    throw new Error(`Unknown acceptance policy: ${policyID}`)
  }
  return policy
}

export function resolveAcceptancePolicyStage(policyID: string, stageID: string) {
  const policy = resolveAcceptancePolicy(policyID)
  const stage = policy.stages.find((item) => item.id === stageID)
  if (!stage) {
    throw new Error(`Acceptance policy ${policyID} does not define stage: ${stageID}`)
  }
  return stage
}
