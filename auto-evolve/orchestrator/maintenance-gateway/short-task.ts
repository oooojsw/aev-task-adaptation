import path from "node:path"
import { randomUUID } from "node:crypto"
import type { CaseRuntimeContext } from "../case-runtime"
import { ensureDirectory, readTextFile, writeJsonFile, writeTextFile } from "../fs"
import type { KnowledgeMaintainerPlan } from "../knowledge-maintainer/contract"
import { buildSessionRecordRef, relativeToRunDir } from "../method-strategy-helpers"
import { resolveReversePropagationRecipe } from "../reverse-propagation-control/recipes"
import type { MaintenanceEvidenceRef, MaintenanceRequest } from "./contract"

interface ShortTaskFailurePacket {
  id: string
  mode: "short"
  caseID: string
  attempt: number
  createdAt: string
  phase: "solve"
  evaluationPassed: boolean
  summary: string
  mismatches: string[]
  routingClassification?: string
  suspectedCauses: string[]
  nextPriorityFix?: string
  evidenceRefs: string[]
}

interface ShortTaskLearningUnit {
  id: string
  mode: "short"
  caseID: string
  attempt: number
  createdAt: string
  kind: "failure_pattern" | "routing_hint" | "repair_pattern"
  statement: string
  refs: string[]
}

interface ShortTaskRetryLesson {
  id: string
  mode: "short"
  caseID: string
  attempt: number
  maintenanceRound?: number
  createdAt: string
  source: "previous_attempt" | "previous_round"
  whatFailed: string
  doNotRepeat: string[]
  nextAttemptStrategy: string[]
  evidenceRefs: string[]
}

interface ShortTaskScratchEntry {
  id: string
  mode: "short"
  caseID: string
  attempt: number
  createdAt: string
  kind: "routing" | "evaluation" | "acceptance"
  statement: string
  refs: string[]
}

interface ShortTaskShadowMemoryCandidate {
  id: string
  mode: "short"
  runID: string
  caseID: string
  createdAt: string
  status: "hold" | "applied"
  summary: string
  evidenceRefs: string[]
}

function nowISO() {
  return new Date().toISOString()
}

function short(text: string, limit = 220) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return normalized.slice(0, limit - 3) + "..."
}

async function ensureJsonlFile(target: string) {
  await ensureDirectory(path.dirname(target))
  try {
    await readTextFile(target)
  } catch {
    await writeTextFile(target, "")
  }
}

async function appendJsonl<T>(target: string, value: T) {
  await ensureJsonlFile(target)
  const existing = await readTextFile(target)
  await writeTextFile(target, existing + JSON.stringify(value) + "\n")
}

function latestCompletedAttempt(context: CaseRuntimeContext) {
  return context.attempts
    .filter((item) => item.attempt < context.attempt)
    .sort((left, right) => right.attempt - left.attempt)[0]
}

function latestCompletedRound(context: CaseRuntimeContext, currentRound: number) {
  return (context.attemptSummary.maintenanceRounds ?? [])
    .filter((item) => item.round < currentRound)
    .sort((left, right) => right.round - left.round)[0]
}

function buildShortSessionReports(context: CaseRuntimeContext, plan: KnowledgeMaintainerPlan) {
  return plan.sessionReports.map((item) =>
    buildSessionRecordRef({
      ...item,
      relativePath: item.relativePath || relativeToRunDir(context.runDir, item.absolutePath),
    }),
  )
}

export async function recordShortTaskFailureEvidence(context: CaseRuntimeContext) {
  if (!context.solveTask || !context.evaluation || !context.feedback.routing) {
    throw new Error("recordShortTaskFailureEvidence requires solve output, evaluation, and routing.")
  }

  const createdAt = nowISO()
  const evidenceRefs = [
    context.attemptSummary.solveSessionExecutionReportPath,
    context.feedback.actualOutputPath,
    context.feedback.evaluationPath,
    context.feedback.actionTracePath,
  ].filter((item): item is string => Boolean(item))

  const failurePacket: ShortTaskFailurePacket = {
    id: `short-failure-${context.loaded.spec.id}-attempt-${String(context.attempt).padStart(2, "0")}`,
    mode: "short",
    caseID: context.loaded.spec.id,
    attempt: context.attempt,
    createdAt,
    phase: "solve",
    evaluationPassed: context.evaluation.passed,
    summary: short(context.evaluation.summary || "Short-task solve failed and entered maintenance preparation."),
    mismatches: context.evaluation.mismatches.slice(0, 8),
    routingClassification: context.feedback.routing.classification,
    suspectedCauses: context.feedback.routing.reasons.slice(0, 6).map((item) => short(item, 160)),
    nextPriorityFix: context.feedback.routing.reasons[0]
      ? short(context.feedback.routing.reasons[0], 180)
      : undefined,
    evidenceRefs,
  }

  const learningUnits: ShortTaskLearningUnit[] = [
    {
      id: `short-learning-failure-${context.loaded.spec.id}-attempt-${String(context.attempt).padStart(2, "0")}`,
      mode: "short",
      caseID: context.loaded.spec.id,
      attempt: context.attempt,
      createdAt,
      kind: "failure_pattern",
      statement: short(context.evaluation.summary || "Current case did not meet expected output."),
      refs: evidenceRefs,
    },
  ]

  if (context.feedback.routing.reasons[0]) {
    learningUnits.push({
      id: `short-learning-routing-${context.loaded.spec.id}-attempt-${String(context.attempt).padStart(2, "0")}`,
      mode: "short",
      caseID: context.loaded.spec.id,
      attempt: context.attempt,
      createdAt,
      kind: "routing_hint",
      statement: short(
        `Route maintenance toward ${context.feedback.routing.classification ?? "unknown"} because ${context.feedback.routing.reasons[0]}`,
      ),
      refs: evidenceRefs,
    })
  }

  const scratchEntries: ShortTaskScratchEntry[] = [
    {
      id: `short-scratch-routing-${context.loaded.spec.id}-attempt-${String(context.attempt).padStart(2, "0")}`,
      mode: "short",
      caseID: context.loaded.spec.id,
      attempt: context.attempt,
      createdAt,
      kind: "routing",
      statement: short(
        `Routing classification=${context.feedback.routing.classification ?? "unknown"}; preferred files=${context.feedback.routing.preferredFiles.join(", ") || "(none)"}`,
      ),
      refs: evidenceRefs,
    },
    {
      id: `short-scratch-evaluation-${context.loaded.spec.id}-attempt-${String(context.attempt).padStart(2, "0")}`,
      mode: "short",
      caseID: context.loaded.spec.id,
      attempt: context.attempt,
      createdAt,
      kind: "evaluation",
      statement: short(context.evaluation.summary || "Evaluation failed."),
      refs: evidenceRefs,
    },
  ]

  await writeJsonFile(context.evidencePaths.failurePacketPath, failurePacket)
  for (const unit of learningUnits) {
    await appendJsonl(context.evidencePaths.learningUnitsPath, unit)
  }
  for (const entry of scratchEntries) {
    await appendJsonl(context.evidencePaths.scratchMemoryPath, entry)
  }

  context.attemptSummary.failurePacketPath = context.evidencePaths.failurePacketPath
  context.attemptSummary.learningUnitsPath = context.evidencePaths.learningUnitsPath
  context.attemptSummary.scratchMemoryPath = context.evidencePaths.scratchMemoryPath
}

export async function appendShortTaskRetryLessons(context: CaseRuntimeContext) {
  const createdAt = nowISO()
  const lessons: ShortTaskRetryLesson[] = []
  const currentRound = context.currentMaintenanceRound ?? 1

  if (currentRound > 1) {
    const previousRound = latestCompletedRound(context, currentRound)
    if (previousRound) {
      lessons.push({
        id: `short-retry-round-${context.loaded.spec.id}-attempt-${String(context.attempt).padStart(2, "0")}-round-${String(currentRound).padStart(2, "0")}`,
        mode: "short",
        caseID: context.loaded.spec.id,
        attempt: context.attempt,
        maintenanceRound: currentRound,
        createdAt,
        source: "previous_round",
        whatFailed: short(previousRound.acceptanceReason ?? "Previous maintenance round was rejected."),
        doNotRepeat: (previousRound.acceptanceRejectionReasons ?? []).slice(0, 4).map((item) => short(item, 160)),
        nextAttemptStrategy: [
          short(`Narrow the edit scope for round ${currentRound}.`, 160),
          short("Address the last rejection before broadening the workspace change.", 160),
        ],
        evidenceRefs: [context.evidencePaths.failurePacketPath],
      })
    }
  } else if (context.attempt > 1) {
    const previousAttempt = latestCompletedAttempt(context)
    if (previousAttempt) {
      const reasons = previousAttempt.acceptanceRejectionReasons?.length
        ? previousAttempt.acceptanceRejectionReasons
        : [previousAttempt.passed ? "Previous attempt still required another retry." : "Previous attempt did not pass."]
      lessons.push({
        id: `short-retry-attempt-${context.loaded.spec.id}-attempt-${String(context.attempt).padStart(2, "0")}`,
        mode: "short",
        caseID: context.loaded.spec.id,
        attempt: context.attempt,
        createdAt,
        source: "previous_attempt",
        whatFailed: short(reasons[0], 160),
        doNotRepeat: reasons.slice(0, 4).map((item) => short(item, 160)),
        nextAttemptStrategy: [
          short("Change the maintainer tactic instead of repeating the previous failed patch.", 160),
        ],
        evidenceRefs: [previousAttempt.failurePacketPath ?? context.evidencePaths.failurePacketPath].filter(
          (item): item is string => Boolean(item),
        ),
      })
    }
  }

  if (!lessons.length) return []

  for (const lesson of lessons) {
    await appendJsonl(context.evidencePaths.retryLessonsPath, lesson)
  }
  context.attemptSummary.retryLessonsPath = context.evidencePaths.retryLessonsPath
  return lessons
}

export function buildShortTaskMaintenanceRequest(context: CaseRuntimeContext, plan: KnowledgeMaintainerPlan): MaintenanceRequest {
  if (
    !context.feedback.routing ||
    !context.feedback.actualOutputPath ||
    !context.feedback.evaluationPath ||
    !context.feedback.actionTracePath
  ) {
    throw new Error("buildShortTaskMaintenanceRequest requires prepared feedback artifacts.")
  }

  const createdAt = nowISO()
  const round = context.currentMaintenanceRound
  const acceptancePolicyID = resolveReversePropagationRecipe(context.methodID)?.acceptancePolicyID
  const evidence: MaintenanceEvidenceRef[] = [
    {
      kind: "execution_report",
      path: context.attemptSummary.solveSessionExecutionReportPath ?? context.solveDir,
      label: "current_failed_solve",
      required: true,
    },
    {
      kind: "failure_packet",
      path: context.evidencePaths.failurePacketPath,
      label: "short_failure_packet",
      required: true,
    },
    {
      kind: "learning_unit",
      path: context.evidencePaths.learningUnitsPath,
      label: "short_learning_units",
    },
    {
      kind: "retry_lesson",
      path: context.evidencePaths.retryLessonsPath,
      label: "short_retry_lessons",
    },
    {
      kind: "scratch_memory",
      path: context.evidencePaths.scratchMemoryPath,
      label: "short_scratch_memory",
    },
    {
      kind: "actual_output",
      path: context.feedback.actualOutputPath,
      label: "actual_output",
      required: true,
    },
    {
      kind: "evaluation",
      path: context.feedback.evaluationPath,
      label: "evaluation",
      required: true,
    },
    {
      kind: "action_trace",
      path: context.feedback.actionTracePath,
      label: "action_trace",
    },
  ]

  if (context.judge.judgeSummaryPath) {
    evidence.push({
      kind: "judge_summary",
      path: context.judge.judgeSummaryPath,
      label: "judge_summary",
    })
  }

  if (context.judge.judgeReportPath) {
    evidence.push({
      kind: "judge_report",
      path: context.judge.judgeReportPath,
      label: "judge_report",
    })
  }

  return {
    id: `maint-req-short-${context.loaded.spec.id}-attempt-${String(context.attempt).padStart(2, "0")}${round ? `-round-${String(round).padStart(2, "0")}` : ""}-${randomUUID().slice(0, 8)}`,
    createdAt,
    updatedAt: createdAt,
    status: "ready_for_maintainer",
    mode: "short",
    sourceRunID: path.basename(context.runDir),
    caseID: context.loaded.spec.id,
    attempt: context.attempt,
    maintenanceRound: round,
    title: `Short Task Maintenance ${context.loaded.spec.id} attempt ${context.attempt}`,
    goal: context.loaded.spec.instruction,
    domainTags: context.loaded.spec.tags ?? [],
    summary: short(
      `Short-task failure routed into maintainer. classification=${context.feedback.routing.classification ?? "unknown"}; summary=${context.evaluation?.summary ?? "no evaluation summary"}`,
      240,
    ),
    runtimeRoot: context.currentAttemptDir,
    workspaceRoot: context.workspace.root,
    templateLibraryRoot: context.templateLibrary.root,
    recipeID: context.strategy.id,
    maintenanceModuleID: plan.reversePropagationModuleID,
    acceptancePolicyID,
    loadingStrategyID: plan.loadingStrategyID,
    scopeLevelID: plan.scopeLevelID,
    operationIDs: plan.operationIDs ?? [],
    routing: {
      classification: context.feedback.routing.classification,
      preferredFiles: context.feedback.routing.preferredFiles,
      suggestedRoles: context.feedback.routing.suggestedRoles,
      allowNewMarkdownFiles: context.feedback.routing.allowNewMarkdownFiles,
      reasons: context.feedback.routing.reasons,
    },
    sessionReports: buildShortSessionReports(context, plan),
    evidence,
    notes: [
      "This request is the thin boundary object between the short runtime kernel and the maintainer core.",
      "Acceptance and rollback remain outside the maintainer core.",
    ],
  }
}

export async function writeShortTaskShadowMemoryCandidate(input: {
  runDir: string
  caseID: string
  passed: boolean
  summary: string
  evidenceRefs: string[]
  outputPath: string
}) {
  const candidate: ShortTaskShadowMemoryCandidate = {
    id: `short-shadow-${input.caseID}-${randomUUID().slice(0, 8)}`,
    mode: "short",
    runID: path.basename(input.runDir),
    caseID: input.caseID,
    createdAt: nowISO(),
    status: input.passed ? "applied" : "hold",
    summary: short(input.summary, 260),
    evidenceRefs: input.evidenceRefs,
  }
  await writeJsonFile(input.outputPath, candidate)
  return candidate
}
