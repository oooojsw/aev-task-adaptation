import path from "node:path"
import type { CaseRuntimeContext, MaintenanceRoundSummary } from "./case-runtime"
import { enterMaintenanceRound } from "./case-runtime"
import type {
  CaseMethodOps,
  MethodStrategyDecision,
  MethodStrategyTraceEntry,
} from "./method-strategies"
import type { KnowledgeMaintainerPlan, KnowledgeMaintainerSessionReportRef } from "./knowledge-maintainer/contract"
import type { PostJudgePlan } from "./post-judge/contract"

export async function runTracedStep(
  trace: MethodStrategyTraceEntry[],
  op: string,
  action: () => Promise<Exclude<MethodStrategyDecision, "continue"> | null | void>,
) {
  const result = await action()
  const decision = result ?? "continue"
  trace.push({ op, decision })
  return decision
}

export function relativeToRunDir(runDir: string, target: string) {
  return target.startsWith(runDir)
    ? target
        .slice(
          runDir.length +
            (target.charAt(runDir.length) === "\\" || target.charAt(runDir.length) === "/" ? 1 : 0),
        )
        .replace(/\\/g, "/")
    : target.replace(/\\/g, "/")
}

export function pushSessionReportRef(
  refs: Map<string, KnowledgeMaintainerSessionReportRef>,
  ref: KnowledgeMaintainerSessionReportRef | undefined,
) {
  if (!ref) return
  refs.set(ref.absolutePath, ref)
}

export function buildSessionRecordRef(input: KnowledgeMaintainerSessionReportRef) {
  const directory = path.dirname(input.absolutePath)
  const sibling = (filename: string) => path.join(directory, filename)
  const relativeSibling = (baseRelativePath: string, filename: string) =>
    baseRelativePath.replace(/[^/]+$/, filename)

  return {
    ...input,
    learningLogAbsolutePath: input.learningLogAbsolutePath ?? sibling("session_learning_log.md"),
    learningLogRelativePath:
      input.learningLogRelativePath ?? relativeSibling(input.relativePath, "session_learning_log.md"),
    taskManifestAbsolutePath: input.taskManifestAbsolutePath ?? sibling("session_task_manifest.md"),
    taskManifestRelativePath:
      input.taskManifestRelativePath ?? relativeSibling(input.relativePath, "session_task_manifest.md"),
  }
}

export function buildMaintenanceRetryFeedback(rounds: MaintenanceRoundSummary[] | undefined, nextRound: number) {
  const relevantRounds = (rounds ?? []).filter((item) => item.round < nextRound)
  if (!relevantRounds.length) {
    return "No previous maintenance round exists for this attempt."
  }

  return relevantRounds
    .map((round) => {
      const lines = [`Round ${round.round}:`]
      if (round.acceptanceReason) {
        lines.push(`- result: ${round.acceptanceReason}`)
      } else if (round.acceptanceRejected) {
        lines.push("- result: rejected")
      } else {
        lines.push("- result: incomplete")
      }
      if (round.acceptanceRejectionReasons?.length) {
        lines.push(`- rejection details: ${round.acceptanceRejectionReasons.join(" | ")}`)
      }
      if (round.workspaceChanged === false) {
        lines.push("- no workspace change was produced")
      }
      if (round.currentCaseVerificationPassed === false) {
        lines.push("- current case verification still failed")
      }
      if (
        typeof round.regressionPassedAfterRefine === "number" &&
        round.regressionAfterReports?.length
      ) {
        lines.push(`- regression reports recorded: ${round.regressionAfterReports.length}`)
      }
      return lines.join("\n")
    })
    .join("\n\n")
}

function resetRoundScopedState(context: CaseRuntimeContext) {
  context.maintenance = {}
  context.postJudge = {}
  context.acceptance = {
    regressionCases: context.acceptance.regressionCases,
    baselineRegression: context.acceptance.baselineRegression,
  }
  context.stopReason = undefined
}

export async function runMaintenanceRounds(input: {
  ops: CaseMethodOps
  context: CaseRuntimeContext
  trace: MethodStrategyTraceEntry[]
  rounds: number
  buildPlan: (context: CaseRuntimeContext, round: number) => Promise<KnowledgeMaintainerPlan>
  buildPostJudgePlan: (context: CaseRuntimeContext, round: number) => Promise<PostJudgePlan>
}) {
  const { ops, context, trace, rounds, buildPlan, buildPostJudgePlan } = input

  for (let round = 1; round <= rounds; round++) {
    resetRoundScopedState(context)
    enterMaintenanceRound(context, round)
    const plan = await buildPlan(context, round)

    await runTracedStep(trace, `invoke_knowledge_maintainer(round:${round})`, () =>
      ops.invokeKnowledgeMaintainer(plan),
    )

    const maintenanceFailed = await runTracedStep(trace, `reject_if_maintenance_failed(round:${round})`, () =>
      ops.rejectIfMaintenanceFailed(),
    )
    if (maintenanceFailed !== "continue") {
      if (round < rounds) continue
      return maintenanceFailed
    }

    const noChange = await runTracedStep(trace, `reject_if_no_experience_change(round:${round})`, () =>
      ops.rejectIfNoExperienceChange(),
    )
    if (noChange !== "continue") {
      if (round < rounds) continue
      return noChange
    }

    const outOfPolicy = await runTracedStep(trace, `reject_if_out_of_policy_files(round:${round})`, () =>
      ops.rejectIfOutOfPolicyFiles(),
    )
    if (outOfPolicy !== "continue") {
      if (round < rounds) continue
      return outOfPolicy
    }

    await runTracedStep(trace, `verify_current_case(round:${round})`, () => ops.verifyCurrentCase())

    if (context.acceptance.currentCaseVerification?.evaluation.passed) {
      await runTracedStep(trace, `run_regression_after_maintenance(round:${round})`, () =>
        ops.runRegressionAfterMaintenance(),
      )
    }

    const postJudgePlan = await buildPostJudgePlan(context, round)
    await runTracedStep(trace, `run_post_judge(round:${round})`, () =>
      ops.runPostJudge(postJudgePlan),
    )
    const postJudgeDecision = await runTracedStep(trace, `apply_post_judge_decision(round:${round})`, () =>
      ops.applyPostJudgeDecision(),
    )
    if (postJudgeDecision !== "continue") {
      if (round < rounds && postJudgeDecision === "next_attempt") continue
      return postJudgeDecision
    }

    const accepted = await runTracedStep(trace, `finish_after_accept(round:${round})`, () =>
      ops.finishAfterAccept(),
    )
    if (accepted !== "continue") return accepted
  }

  return "next_attempt" as const
}
