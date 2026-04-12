import type { CaseRuntimeContext } from "./case-runtime"
import { autoEvolvePath } from "./fs"
import type { KnowledgeMaintainerPlan, KnowledgeMaintainerSessionReportRef } from "./knowledge-maintainer/contract"
import type { JudgePlan } from "./judge/contract"
import { methodPaths, readMethodPrompt } from "./methods"
import {
  buildMaintenanceRetryFeedback,
  buildSessionRecordRef,
  pushSessionReportRef,
  relativeToRunDir,
  runMaintenanceRounds,
  runTracedStep,
} from "./method-strategy-helpers"
import type { PostJudgePlan } from "./post-judge/contract"
import type { ReversePropagationRecipeDescriptor } from "./reverse-propagation-control/contract"
import { resolveReversePropagationRecipe } from "./reverse-propagation-control/recipes"
import type { AutoEvolveConfig } from "./schema"

export type MethodStrategyDecision = "continue" | "next_attempt" | "finish_run"

export interface MethodStrategyTraceEntry {
  op: string
  decision: MethodStrategyDecision
}

export interface MethodStrategyResult {
  decision: Exclude<MethodStrategyDecision, "continue">
  trace: MethodStrategyTraceEntry[]
}

export interface CaseMethodOps {
  solveCase(): Promise<void>
  finishIfPassed(): Promise<Exclude<MethodStrategyDecision, "continue"> | null>
  finishIfEvalMode(): Promise<Exclude<MethodStrategyDecision, "continue"> | null>
  finishIfMaxRetriesReached(): Promise<Exclude<MethodStrategyDecision, "continue"> | null>
  prepareFeedbackPacket(): Promise<void>
  runRegressionBeforeMaintenance(): Promise<void>
  runPreJudge(plan: JudgePlan): Promise<void>
  finishIfJudgeSkippedMaintenance(): Promise<Exclude<MethodStrategyDecision, "continue"> | null>
  invokeKnowledgeMaintainer(plan: KnowledgeMaintainerPlan): Promise<void>
  rejectIfMaintenanceFailed(): Promise<Exclude<MethodStrategyDecision, "continue"> | null>
  rejectIfNoExperienceChange(): Promise<Exclude<MethodStrategyDecision, "continue"> | null>
  rejectIfOutOfPolicyFiles(): Promise<Exclude<MethodStrategyDecision, "continue"> | null>
  verifyCurrentCase(): Promise<void>
  runRegressionAfterMaintenance(): Promise<void>
  runPostJudge(plan: PostJudgePlan): Promise<void>
  applyPostJudgeDecision(): Promise<Exclude<MethodStrategyDecision, "continue"> | null>
  finishAfterAccept(): Promise<Exclude<MethodStrategyDecision, "continue"> | null>
}

export interface MethodStrategy {
  id: string
  strategyDocPath: string
  runAttempt(ops: CaseMethodOps, context: CaseRuntimeContext): Promise<MethodStrategyResult>
}

const DIRECT_REWRITE_BASELINE_CONTRACT = [
  "Sequential-refine maintenance contract:",
  "- This method is the conservative baseline learning route.",
  "- Prefer the smallest Markdown changes that repair the current failure pattern.",
  "- Keep one coherent canonical experience workspace rather than branching versions inside the workspace.",
  "- Preserve the single entry file and keep the workspace navigable for a blank future solve agent.",
  "- You may replace placeholder seed structure; do not preserve legacy folders only because they already exist.",
  "- Add structure only when it improves long-term selective reading or maintainability.",
  "- Any new Markdown module should include an auto-evolve role marker.",
  "- Avoid copying template files verbatim into the final workspace.",
].join("\n")

const ADD_ONLY_CONSERVATIVE_CONTRACT = [
  "Add-only maintenance contract:",
  "- This method is the conservative additive-memory route.",
  "- Preserve still-useful existing workspace content whenever possible.",
  "- Prefer appending focused addenda, adding lessons, adding guides, or creating small new modules over broad rewrites.",
  "- Avoid deleting, splitting, merging, or structurally replacing canonical modules unless the method guidance explicitly says there is no smaller safe additive patch.",
  "- Keep one coherent canonical experience workspace and a single entry file.",
  "- Use repeated maintenance rounds to narrow the additive patch when a prior round was rejected.",
  "- Any new Markdown module should include an auto-evolve role marker.",
].join("\n")

function applyTemplateVariables(template: string, variables: Record<string, string>) {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, rawKey: string) => variables[rawKey] ?? "")
}

function resolveContractBlock(recipe: ReversePropagationRecipeDescriptor) {
  switch (recipe.contractStyleID) {
    case "direct-rewrite-baseline":
      return DIRECT_REWRITE_BASELINE_CONTRACT
    case "add-only-conservative":
      return ADD_ONLY_CONSERVATIVE_CONTRACT
    default:
      return [
        `Maintenance contract for recipe ${recipe.id}:`,
        `- Follow the maintenance module ${recipe.maintenanceModuleID}.`,
        "- Keep one coherent canonical experience workspace and one single entry file.",
        "- Acceptance and rollback are evaluated later by the transaction gate; do not try to simulate acceptance policy inside the maintainer step.",
      ].join("\n")
  }
}

class RecipeDrivenMethodStrategy implements MethodStrategy {
  id: string
  strategyDocPath: string

  constructor(
    private readonly recipe: ReversePropagationRecipeDescriptor,
    strategyDocPath: string,
  ) {
    this.id = recipe.id
    this.strategyDocPath = strategyDocPath
  }

  private maintenanceRounds(context: CaseRuntimeContext) {
    return this.recipe.maintenanceRoundsPolicy === "config_max_rounds"
      ? context.config.maxMaintenanceRoundsPerAttempt
      : 1
  }

  private buildPostJudgePlan(_context: CaseRuntimeContext, _round: number): PostJudgePlan {
    return {
      strategyID: this.recipe.acceptancePolicyID,
    }
  }

  private buildRoutingVariables(context: CaseRuntimeContext, extra: Record<string, string> = {}) {
    const routing = context.feedback.routing
    return {
      routing_classification: routing?.classification ?? "unknown",
      preferred_files: routing?.preferredFiles.length ? routing.preferredFiles.join(", ") : "(none)",
      suggested_roles: routing?.suggestedRoles.length ? routing.suggestedRoles.join(", ") : "(none)",
      routing_reasons: routing?.reasons.length ? routing.reasons.join("; ") : "(none)",
      ...extra,
    }
  }

  private collectSessionReports(
    context: CaseRuntimeContext,
    options?: { includePreviousAttempts?: boolean; includePreviousRounds?: boolean },
  ) {
    const refs = new Map<string, KnowledgeMaintainerSessionReportRef>()
    const includePreviousAttempts = options?.includePreviousAttempts ?? true
    const includePreviousRounds = options?.includePreviousRounds ?? false

    pushSessionReportRef(
      refs,
      context.attemptSummary.solveSessionExecutionReportPath
        ? buildSessionRecordRef({
            label: "current_failed_solve",
            absolutePath: context.attemptSummary.solveSessionExecutionReportPath,
            relativePath: relativeToRunDir(context.runDir, context.attemptSummary.solveSessionExecutionReportPath),
            phase: "solve",
            caseID: context.loaded.spec.id,
            attempt: context.attempt,
            sessionID: context.attemptSummary.solveSessionID,
          })
        : undefined,
    )

    for (const item of context.acceptance.baselineRegression?.cases ?? []) {
      if (!item.sessionExecutionReportPath) continue
      pushSessionReportRef(refs, buildSessionRecordRef({
        label: `regression_before_${item.caseID}`,
        absolutePath: item.sessionExecutionReportPath,
        relativePath: relativeToRunDir(context.runDir, item.sessionExecutionReportPath),
        phase: "regression_before_maintain",
        caseID: item.caseID,
        attempt: context.attempt,
        sessionID: item.solveSessionID,
      }))
    }

    if (includePreviousRounds) {
      const currentRound = context.currentMaintenanceRound ?? Number.MAX_SAFE_INTEGER
      for (const round of context.attemptSummary.maintenanceRounds ?? []) {
        if (round.round >= currentRound) continue
        if (round.maintainSessionExecutionReportPath) {
          pushSessionReportRef(refs, buildSessionRecordRef({
            label: `previous_maintain_round_${round.round}`,
            absolutePath: round.maintainSessionExecutionReportPath,
            relativePath: relativeToRunDir(context.runDir, round.maintainSessionExecutionReportPath),
            phase: "maintain",
            caseID: context.loaded.spec.id,
            attempt: context.attempt,
            sessionID: round.maintainSessionID,
          }))
        }
        if (round.currentCaseVerificationReportPath) {
          pushSessionReportRef(refs, buildSessionRecordRef({
            label: `previous_verify_round_${round.round}`,
            absolutePath: round.currentCaseVerificationReportPath,
            relativePath: relativeToRunDir(context.runDir, round.currentCaseVerificationReportPath),
            phase: "verify",
            caseID: context.loaded.spec.id,
            attempt: context.attempt,
          }))
        }
        for (const report of round.regressionAfterReports ?? []) {
          pushSessionReportRef(refs, buildSessionRecordRef({
            label: `previous_regression_after_round_${round.round}_${report.caseID}`,
            absolutePath: report.path,
            relativePath: relativeToRunDir(context.runDir, report.path),
            phase: "regression_after_maintain",
            caseID: report.caseID,
            attempt: context.attempt,
          }))
        }
      }
    }

    if (includePreviousAttempts) {
      for (const previous of context.attempts.filter((item) => item.attempt < context.attempt).slice(-2)) {
        if (previous.solveSessionExecutionReportPath) {
          pushSessionReportRef(refs, buildSessionRecordRef({
            label: `previous_solve_attempt_${previous.attempt}`,
            absolutePath: previous.solveSessionExecutionReportPath,
            relativePath: relativeToRunDir(context.runDir, previous.solveSessionExecutionReportPath),
            phase: "solve",
            caseID: context.loaded.spec.id,
            attempt: previous.attempt,
            sessionID: previous.solveSessionID,
          }))
        }
        if (previous.refineSessionExecutionReportPath) {
          pushSessionReportRef(refs, buildSessionRecordRef({
            label: `previous_maintain_attempt_${previous.attempt}`,
            absolutePath: previous.refineSessionExecutionReportPath,
            relativePath: relativeToRunDir(context.runDir, previous.refineSessionExecutionReportPath),
            phase: "maintain",
            caseID: context.loaded.spec.id,
            attempt: previous.attempt,
            sessionID: previous.refineSessionID,
          }))
        }
        if (previous.currentCaseVerificationReportPath) {
          pushSessionReportRef(refs, buildSessionRecordRef({
            label: `previous_verify_attempt_${previous.attempt}`,
            absolutePath: previous.currentCaseVerificationReportPath,
            relativePath: relativeToRunDir(context.runDir, previous.currentCaseVerificationReportPath),
            phase: "verify",
            caseID: context.loaded.spec.id,
            attempt: previous.attempt,
          }))
        }
      }
    }

    return [...refs.values()]
  }

  private async buildJudgePlan(context: CaseRuntimeContext): Promise<JudgePlan> {
    const paths = methodPaths(context.cwd, context.config, this.recipe.judgeMethodID)
    const judgeExtensionTemplate = await readMethodPrompt(paths, "judge_extension")
    return {
      attempt: context.attempt,
      judgeExtensionBlock: applyTemplateVariables(judgeExtensionTemplate, this.buildRoutingVariables(context)),
      sessionReports: this.collectSessionReports(context),
    }
  }

  private async buildKnowledgeMaintainerPlan(
    context: CaseRuntimeContext,
    round: number,
  ): Promise<KnowledgeMaintainerPlan> {
    const paths = methodPaths(context.cwd, context.config, this.recipe.maintenanceMethodID)
    const maintainExtensionTemplate = await readMethodPrompt(paths, "maintain_extension")
    const methodExtensionBlock = applyTemplateVariables(
      maintainExtensionTemplate,
      this.buildRoutingVariables(context, {
        maintenance_round: String(round),
        maintenance_retry_feedback: buildMaintenanceRetryFeedback(context.attemptSummary.maintenanceRounds, round),
      }),
    )

    return {
      contractBlock: resolveContractBlock(this.recipe),
      methodExtensionBlock,
      reversePropagationModuleID: this.recipe.maintenanceModuleID,
      loadingStrategyID: "full-workspace-read-via-entry",
      scopeLevelID: "full-access",
      maintenanceRound: round,
      sessionReports: this.collectSessionReports(context, {
        includePreviousAttempts: true,
        includePreviousRounds: this.recipe.includePreviousRoundsInMaintainer,
      }),
    }
  }

  async runAttempt(ops: CaseMethodOps, context: CaseRuntimeContext): Promise<MethodStrategyResult> {
    const trace: MethodStrategyTraceEntry[] = []

    await runTracedStep(trace, "solve_case", () => ops.solveCase())

    const passed = await runTracedStep(trace, "finish_if_passed", () => ops.finishIfPassed())
    if (passed !== "continue") return { decision: passed, trace }

    const evalMode = await runTracedStep(trace, "finish_if_eval_mode", () => ops.finishIfEvalMode())
    if (evalMode !== "continue") return { decision: evalMode, trace }

    const retries = await runTracedStep(trace, "finish_if_max_retries_reached", () => ops.finishIfMaxRetriesReached())
    if (retries !== "continue") return { decision: retries, trace }

    await runTracedStep(trace, "prepare_feedback_packet", () => ops.prepareFeedbackPacket())

    if (context.executionProfile === "light_shard") {
      const judgePlan = await this.buildJudgePlan(context)
      await runTracedStep(trace, "run_pre_judge", () => ops.runPreJudge(judgePlan))
      const judgeDecision = await runTracedStep(trace, "finish_if_judge_skipped_maintenance", () =>
        ops.finishIfJudgeSkippedMaintenance(),
      )
      if (judgeDecision !== "continue") return { decision: judgeDecision, trace }
      context.stopReason = "light shard collected learning packet"
      trace.push({ op: "finish_after_light_shard_packetization", decision: "finish_run" })
      return { decision: "finish_run", trace }
    }

    await runTracedStep(trace, "run_regression_before_maintenance", () => ops.runRegressionBeforeMaintenance())
    const judgePlan = await this.buildJudgePlan(context)
    await runTracedStep(trace, "run_pre_judge", () => ops.runPreJudge(judgePlan))
    const judgeDecision = await runTracedStep(trace, "finish_if_judge_skipped_maintenance", () =>
      ops.finishIfJudgeSkippedMaintenance(),
    )
    if (judgeDecision !== "continue") return { decision: judgeDecision, trace }

    const maintenanceDecision = await runMaintenanceRounds({
      ops,
      context,
      trace,
      rounds: this.maintenanceRounds(context),
      buildPlan: (runtimeContext, round) => this.buildKnowledgeMaintainerPlan(runtimeContext, round),
      buildPostJudgePlan: async (runtimeContext, round) => this.buildPostJudgePlan(runtimeContext, round),
    })

    return { decision: maintenanceDecision, trace }
  }
}

export function resolveMethodStrategy(cwd: string, config: AutoEvolveConfig, methodID: string): MethodStrategy {
  const strategyDocPath = autoEvolvePath(cwd, config.methodsDir, methodID, "FLOW.md")
  const recipe = resolveReversePropagationRecipe(methodID)
  if (!recipe) {
    throw new Error(`No recipe-defined method strategy is registered for method: ${methodID}`)
  }
  return new RecipeDrivenMethodStrategy(recipe, strategyDocPath)
}
