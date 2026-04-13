export type AutoEvolveTaskLayer =
  | "task_execution"
  | "judge"
  | "experience_maintenance"
  | "experience_transaction"

export type AutoEvolveTaskRole = "worker" | "judge" | "maintainer" | "acceptance" | "transaction_gate"

export type AutoEvolveTaskKind =
  | "bootstrap"
  | "solve"
  | "verify"
  | "regression"
  | "judge"
  | "maintain"
  | "post_judge"
  | "deployment_acceptance"
  | "long_task_plan"
  | "long_task_execute"
  | "long_task_validate"
  | "long_task_replan"

export interface AutoEvolveTaskDescriptor {
  kind: AutoEvolveTaskKind
  layer: AutoEvolveTaskLayer
  role: AutoEvolveTaskRole
  title: string
  phase: string
  purpose: string
  caseID?: string
  attempt?: number
  maintenanceRound?: number
  methodID?: string
}

function purposeForKind(kind: AutoEvolveTaskKind) {
  switch (kind) {
    case "bootstrap":
      return "Generate or refresh an initial experience workspace from labeled examples."
    case "solve":
      return "Solve the current case using the current experience workspace."
    case "verify":
      return "Re-solve the current case after maintenance to check whether the targeted failure is fixed."
    case "regression":
      return "Re-run selected reference cases to detect capability regressions after maintenance."
    case "judge":
      return "Analyze task records and failure context, then decide whether maintenance should start."
    case "maintain":
      return "Maintain the experience workspace using the chosen reverse-propagation module."
    case "post_judge":
      return "Evaluate post-maintenance evidence and decide whether to accept or roll back the maintenance transaction."
    case "deployment_acceptance":
      return "Run a deployment-level acceptance harness against the formal expert surface and target materials."
    case "long_task_plan":
      return "Bootstrap an initial work graph for a validator-driven long-running task."
    case "long_task_execute":
      return "Execute one long-task work unit and produce a verifier-facing claim plus structured scratch output."
    case "long_task_validate":
      return "Run a long-task validator and convert its result into a normalized verification record."
    case "long_task_replan":
      return "Revise the remaining long-task work graph after repeated failures or blocked progress."
    default:
      return "Execute an auto-evolve task."
  }
}

export function createTaskDescriptor(input: {
  kind: AutoEvolveTaskKind
  title: string
  phase?: string
  caseID?: string
  attempt?: number
  maintenanceRound?: number
  methodID?: string
  purpose?: string
}): AutoEvolveTaskDescriptor {
  const { kind } = input

  const layer: AutoEvolveTaskLayer =
    kind === "judge"
      ? "judge"
      : kind === "maintain"
        ? "experience_maintenance"
        : kind === "verify" || kind === "regression" || kind === "post_judge" || kind === "deployment_acceptance"
          ? "experience_transaction"
          : "task_execution"

  const role: AutoEvolveTaskRole =
    kind === "judge"
      ? "judge"
      : kind === "maintain"
        ? "maintainer"
        : kind === "deployment_acceptance"
          ? "acceptance"
          : kind === "verify" || kind === "regression" || kind === "post_judge"
            ? "transaction_gate"
          : "worker"

  return {
    kind,
    layer,
    role,
    title: input.title,
    phase: input.phase ?? kind,
    purpose: input.purpose ?? purposeForKind(kind),
    caseID: input.caseID,
    attempt: input.attempt,
    maintenanceRound: input.maintenanceRound,
    methodID: input.methodID,
  }
}
