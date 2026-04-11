import path from "node:path"
import { randomUUID } from "node:crypto"
import type {
  LongTaskFailurePacket,
  LongTaskLearningUnit,
  LongTaskRunStatus,
  LongTaskScratchUnit,
  LongTaskSpec,
  LongTaskVerificationClaim,
  LongTaskWorkGraph,
  LongTaskWorkUnit,
} from "./contract"
import { DEFAULT_LONG_TASK_BUDGETS } from "./contract"
import {
  appendArchiveRecord,
  appendFailurePacket,
  appendLearningUnit,
  appendRetryJournalEntry,
  appendScratchUnit,
  appendShadowMemoryRecord,
  appendValidatorResult,
  appendVerificationClaim,
  buildLongTaskRunSummary,
  buildRetryInputBundle,
  createInitialLongTaskProgressState,
  createLongTaskRunID,
  defaultArchiveRecord,
  defaultShadowMemoryRecord,
  initializeLongTaskRun,
  longTaskPlanPaths,
  longTaskReplanPaths,
  longTaskRunPaths,
  longTaskUnitAttemptPaths,
  longTaskPaths,
  readFailurePackets,
  readLongTaskProgressState,
  readLongTaskSpec,
  readLongTaskWorkGraph,
  resolveExistingLongTaskRun,
  writeLongTaskProgressState,
  writeLongTaskRunSummary,
  writeLongTaskWorkGraph,
  writeRetryInputBundle,
  writeScratchDerivedViews,
  buildLongTaskWorkUnit,
} from "./repository"
import {
  activateLongTaskWorkUnit,
  bumpLongTaskWorkUnitAttempt,
  createLongTaskWorkGraph,
  deriveLongTaskProgressState,
  markLongTaskWorkUnitVerified,
  mergeReplannedGraph,
  selectNextLongTaskUnit,
} from "./work-graph"
import { loadLongTaskSpec } from "./spec"
import {
  buildLongTaskExecutionPrompt,
  buildLongTaskPlanningPrompt,
  buildLongTaskReplanPrompt,
} from "./prompts"
import { runLongTaskValidator } from "./validators"
import { loadConfig } from "../schema"
import { runOpencodeTask } from "../opencode"
import { resolveModelSelection } from "../model-selection"
import { writeTaskArtifacts } from "../task-artifacts"

function nowISO() {
  return new Date().toISOString()
}

function short(text: string, limit = 200) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return normalized.slice(0, limit - 3) + "..."
}

function extractJsonObject(raw: string) {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const attempts = [trimmed]
  const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)```/i)
  if (fencedMatch?.[1]) attempts.push(fencedMatch[1].trim())
  const firstObjectMatch = trimmed.match(/\{[\s\S]*\}/)
  if (firstObjectMatch?.[0]) attempts.push(firstObjectMatch[0].trim())

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as Record<string, unknown>
    } catch {
      continue
    }
  }
  return undefined
}

function normalizeStringArray(input: unknown) {
  if (!Array.isArray(input)) return []
  return input
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
}

function normalizeGraphUnits(raw: unknown, spec: LongTaskSpec) {
  if (!Array.isArray(raw)) return []
  const maxUnits = spec.budgets?.maxUnitsPerGraph ?? DEFAULT_LONG_TASK_BUDGETS.maxUnitsPerGraph
  const usedIDs = new Set<string>()
  const validatorIDs = new Set(spec.validators.map((item) => item.id))
  const units: LongTaskWorkUnit[] = []

  for (const item of raw) {
    if (units.length >= maxUnits) break
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `unit-${units.length + 1}`
    if (usedIDs.has(id)) continue
    usedIDs.add(id)
    const retryBudgetRaw = typeof item.retry_budget === "number" && item.retry_budget > 0 ? item.retry_budget : 1
    const retryBudget = Math.min(
      retryBudgetRaw,
      spec.budgets?.maxAttemptsPerUnit ?? DEFAULT_LONG_TASK_BUDGETS.maxAttemptsPerUnit,
    )
    const proposedValidatorIDs = normalizeStringArray(item.validator_ids).filter((idValue) => validatorIDs.has(idValue))
    units.push(
      buildLongTaskWorkUnit({
        id,
        title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : id,
        goal: typeof item.goal === "string" && item.goal.trim() ? item.goal.trim() : `Advance ${id}`,
        inputs: normalizeStringArray(item.inputs),
        dependsOn: normalizeStringArray(item.depends_on).filter((dep) => dep !== id),
        expectedArtifacts: normalizeStringArray(item.expected_artifacts),
        claim: typeof item.claim === "string" && item.claim.trim() ? item.claim.trim() : `Unit ${id} is complete.`,
        checkPlan:
          typeof item.check_plan === "string" && item.check_plan.trim()
            ? item.check_plan.trim()
            : "Run the assigned validators for this unit.",
        validatorIDs:
          proposedValidatorIDs.length > 0
            ? proposedValidatorIDs
            : spec.validators.filter((validator) => validator.required !== false).map((validator) => validator.id),
        retryBudget,
      }),
    )
  }

  return units
}

function fallbackLongTaskGraph(spec: LongTaskSpec, reason: string) {
  const requiredValidatorIDs = spec.validators.filter((item) => item.required !== false).map((item) => item.id)
  return createLongTaskWorkGraph({
    plannerSummary: `Fallback graph used: ${reason}`,
    completionValidatorIDs: requiredValidatorIDs,
    units: [
      buildLongTaskWorkUnit({
        id: "complete-task",
        title: "Complete Task",
        goal: spec.goal,
        inputs: spec.materials.map((item) => item.path),
        dependsOn: [],
        expectedArtifacts: (spec.targetPaths ?? []).map((item) => item.path),
        claim: "The main long-task goal is completed and validator-ready.",
        checkPlan: "Run all required validators against the current task outputs.",
        validatorIDs: requiredValidatorIDs,
        retryBudget: spec.budgets?.maxAttemptsPerUnit ?? DEFAULT_LONG_TASK_BUDGETS.maxAttemptsPerUnit,
      }),
    ],
  })
}

function normalizePlanningGraph(raw: Record<string, unknown> | undefined, spec: LongTaskSpec, fallbackReason: string) {
  if (!raw) return fallbackLongTaskGraph(spec, fallbackReason)
  const completionValidatorIDs = normalizeStringArray(raw.completion_validator_ids)
  const units = normalizeGraphUnits(raw.units, spec)
  if (!units.length) return fallbackLongTaskGraph(spec, fallbackReason)
  return createLongTaskWorkGraph({
    plannerSummary:
      typeof raw.planner_summary === "string" && raw.planner_summary.trim() ? raw.planner_summary.trim() : undefined,
    completionValidatorIDs:
      completionValidatorIDs.length > 0
        ? completionValidatorIDs
        : spec.validators.filter((item) => item.required !== false).map((item) => item.id),
    units,
  })
}

function normalizeExecutionOutput(raw: Record<string, unknown> | undefined, unit: LongTaskWorkUnit) {
  const claimStatement =
    typeof raw?.claim_statement === "string" && raw.claim_statement.trim()
      ? raw.claim_statement.trim()
      : `Attempted ${unit.id}, but did not return a structured claim.`
  const claimedSuccess = typeof raw?.claimed_success === "boolean" ? raw.claimed_success : false
  const blockers = normalizeStringArray(raw?.blockers)
  const nextPriorityFix =
    typeof raw?.next_priority_fix === "string" && raw.next_priority_fix.trim() ? raw.next_priority_fix.trim() : undefined
  const updatedFiles = normalizeStringArray(raw?.updated_files)

  const scratchUnits = Array.isArray(raw?.scratch_units)
    ? raw.scratch_units
        .filter((item) => typeof item === "object" && item !== null && !Array.isArray(item))
        .map((item) => item as Record<string, unknown>)
    : []

  const learningUnits = Array.isArray(raw?.learning_units)
    ? raw.learning_units
        .filter((item) => typeof item === "object" && item !== null && !Array.isArray(item))
        .map((item) => item as Record<string, unknown>)
    : []

  return {
    claimStatement,
    claimedSuccess,
    blockers,
    nextPriorityFix,
    updatedFiles,
    scratchUnits,
    learningUnits,
  }
}

function makeScratchUnits(input: {
  runID: string
  unit: LongTaskWorkUnit
  attempt: number
  rawUnits: Record<string, unknown>[]
}) {
  return input.rawUnits.map((item) => ({
    id: `scratch-${randomUUID().slice(0, 8)}`,
    runID: input.runID,
    unitID: input.unit.id,
    attempt: input.attempt,
    createdAt: nowISO(),
    kind:
      item.kind === "claim" ||
      item.kind === "obs" ||
      item.kind === "map" ||
      item.kind === "hyp" ||
      item.kind === "fail" ||
      item.kind === "fix" ||
      item.kind === "rule_candidate" ||
      item.kind === "verified"
        ? item.kind
        : "obs",
    statement:
      typeof item.statement === "string" && item.statement.trim()
        ? short(item.statement.trim(), 220)
        : "Unstructured scratch note.",
    refs: normalizeStringArray(item.refs),
    relatedUnitIDs: normalizeStringArray(item.related_unit_ids),
  }))
}

function makeLearningUnits(input: {
  runID: string
  unit: LongTaskWorkUnit
  rawUnits: Record<string, unknown>[]
}) {
  return input.rawUnits.map((item) => ({
    id: `learning-${randomUUID().slice(0, 8)}`,
    runID: input.runID,
    unitID: input.unit.id,
    createdAt: nowISO(),
    kind:
      item.kind === "obs" ||
      item.kind === "map" ||
      item.kind === "rule" ||
      item.kind === "exception" ||
      item.kind === "failure_pattern" ||
      item.kind === "repair_pattern" ||
      item.kind === "tooling_hint" ||
      item.kind === "validator_hint"
        ? item.kind
        : "failure_pattern",
    statement:
      typeof item.statement === "string" && item.statement.trim()
        ? short(item.statement.trim(), 240)
        : "Unstructured learning unit.",
    scope:
      item.scope === "instance" ||
      item.scope === "local" ||
      item.scope === "pattern" ||
      item.scope === "global_candidate"
        ? item.scope
        : "local",
    strength: item.strength === 2 || item.strength === 3 ? item.strength : 1,
    refs: normalizeStringArray(item.refs),
    relations: Array.isArray(item.relations)
      ? item.relations
          .filter((relation) => typeof relation === "object" && relation !== null && !Array.isArray(relation))
          .map((relation) => relation as Record<string, unknown>)
          .filter(
            (relation) =>
              typeof relation.type === "string" &&
              typeof relation.targetID === "string" &&
              relation.targetID.trim().length > 0,
          )
          .map((relation) => ({
            type:
              relation.type === "supports" ||
              relation.type === "conflicts" ||
              relation.type === "exception_of" ||
              relation.type === "derived_from" ||
              relation.type === "blocks"
                ? relation.type
                : "supports",
            targetID: relation.targetID as string,
          }))
      : [],
  } satisfies LongTaskLearningUnit))
}

function createClaim(input: {
  runID: string
  unit: LongTaskWorkUnit
  attempt: number
  claimStatement: string
  claimedSuccess: boolean
  blockers: string[]
  nextPriorityFix?: string
  evidenceRefs: string[]
  checkTools: string[]
}): LongTaskVerificationClaim {
  return {
    id: `claim-${randomUUID().slice(0, 8)}`,
    runID: input.runID,
    unitID: input.unit.id,
    attempt: input.attempt,
    createdAt: nowISO(),
    statement: short(input.claimStatement, 240),
    claimedSuccess: input.claimedSuccess,
    blockers: input.blockers,
    nextPriorityFix: input.nextPriorityFix,
    evidenceRefs: input.evidenceRefs,
    checkTools: input.checkTools,
  }
}

function createFailurePacket(input: {
  runID: string
  unitID: string
  attempt: number
  claimedSuccess: boolean
  verificationPassed: boolean
  mismatchSummary: string
  suspectedCauses: string[]
  nextPriorityFix?: string
  evidenceRefs: string[]
  retryLevel: LongTaskFailurePacket["retryLevel"]
  failureType: LongTaskFailurePacket["failureType"]
  promotionHint?: LongTaskFailurePacket["promotionHint"]
}): LongTaskFailurePacket {
  return {
    id: `failure-${randomUUID().slice(0, 8)}`,
    runID: input.runID,
    unitID: input.unitID,
    attempt: input.attempt,
    createdAt: nowISO(),
    failureType: input.failureType,
    retryLevel: input.retryLevel,
    claimedSuccess: input.claimedSuccess,
    verificationPassed: input.verificationPassed,
    mismatchSummary: short(input.mismatchSummary, 260),
    suspectedCauses: input.suspectedCauses.map((item) => short(item, 180)).slice(0, 6),
    nextPriorityFix: input.nextPriorityFix ? short(input.nextPriorityFix, 220) : undefined,
    evidenceRefs: input.evidenceRefs,
    promotionHint: input.promotionHint ?? "shadow_candidate",
  }
}

function shouldStopForBudgets(input: {
  progress: ReturnType<typeof deriveLongTaskProgressState>
  spec: LongTaskSpec
}) {
  const budgets = input.spec.budgets ?? DEFAULT_LONG_TASK_BUDGETS
  if (input.progress.totalUnitAttempts >= budgets.maxTotalUnitAttempts) return "exhausted_failure" as const
  if (input.progress.validatorCalls >= budgets.maxValidatorCalls) return "exhausted_failure" as const
  if (input.progress.noProgressCycles >= budgets.maxNoProgressCycles) return "stagnation_failure" as const
  return undefined
}

async function runPlanningSession(input: {
  cwd: string
  configPathCwd: string
  spec: LongTaskSpec
  specPath: string
  run: ReturnType<typeof longTaskRunPaths>
  phase: "plan" | "replan"
  existingGraph?: LongTaskWorkGraph
  failureSummaries?: string[]
}) {
  const config = await loadConfig(input.configPathCwd)
  const selection = resolveModelSelection(config, "solve", input.spec.planning)
  const draftPaths =
    input.phase === "plan"
      ? longTaskPlanPaths(input.run)
      : longTaskReplanPaths(input.run, (input.existingGraph?.revision ?? 0) + 1)

  const prompt =
    input.phase === "plan"
      ? buildLongTaskPlanningPrompt({
          spec: input.spec,
          specPath: input.specPath,
          planningOutputPath: draftPaths.graphDraftPath,
        })
      : buildLongTaskReplanPrompt({
          spec: input.spec,
          graph: input.existingGraph!,
          unresolvedUnits: input.existingGraph!.units.filter((unit) => unit.status !== "verified"),
          failurePacketSummaries: input.failureSummaries ?? [],
          replanOutputPath: draftPaths.graphDraftPath,
        })

  const task = await runOpencodeTask({
    cwd: input.cwd,
    config,
    title: input.phase === "plan" ? "Long Task Graph Bootstrap" : "Long Task Graph Replan",
    prompt,
    referencePaths: [
      input.specPath,
      ...input.spec.materials.map((item) => item.path),
      ...(input.spec.targetPaths ?? []).map((item) => item.path),
      ...(input.spec.initialExpertContextPaths ?? []),
    ],
    attachedFiles: [],
    permissionReadPaths: [
      input.specPath,
      ...input.spec.materials.map((item) => item.path),
      ...(input.spec.targetPaths ?? []).map((item) => item.path),
      ...(input.spec.initialExpertContextPaths ?? []),
    ],
    permissionEditPaths: [],
    model: selection.model,
    agent: selection.agent,
    variant: selection.variant,
  })

  await writeTaskArtifacts(draftPaths.root, task, {
    phase: input.phase === "plan" ? "long_task_plan" : "long_task_replan",
    taskKind: input.phase === "plan" ? "long_task_plan" : "long_task_replan",
    methodID: input.spec.reversePropagation?.recipeID,
  })

  const raw = extractJsonObject(task.result.responseText)
  const graph = normalizePlanningGraph(
    raw,
    input.spec,
    input.phase === "plan" ? "planner output was invalid" : "replanner output was invalid",
  )
  await writeLongTaskWorkGraph(input.run, graph)
  return graph
}

async function executeWorkUnit(input: {
  cwd: string
  configPathCwd: string
  spec: LongTaskSpec
  run: ReturnType<typeof longTaskRunPaths>
  graph: LongTaskWorkGraph
  unit: LongTaskWorkUnit
}) {
  const config = await loadConfig(input.configPathCwd)
  const selection = resolveModelSelection(config, "solve", input.spec.execution)
  let graph = activateLongTaskWorkUnit(input.graph, input.unit.id)
  graph = bumpLongTaskWorkUnitAttempt(graph, input.unit.id)
  const activeUnit = graph.units.find((item) => item.id === input.unit.id)!
  const attempt = activeUnit.attemptCount
  const attemptPaths = longTaskUnitAttemptPaths(input.run, activeUnit.id, attempt)

  const progressBefore = deriveLongTaskProgressState({
    runID: (await readLongTaskProgressState(input.run)).runID,
    graph,
    previous: await readLongTaskProgressState(input.run),
    status: "running",
  })
  progressBefore.activeUnitID = activeUnit.id
  progressBefore.activeAttempt = attempt
  progressBefore.totalUnitAttempts += 1
  await writeLongTaskWorkGraph(input.run, graph)
  await writeLongTaskProgressState(input.run, progressBefore)

  const bundle = await buildRetryInputBundle({
    run: input.run,
    unitID: activeUnit.id,
  })
  await writeRetryInputBundle(attemptPaths.inputBundlePath, bundle)

  const validatorInputPaths = activeUnit.validatorIDs.map((validatorID) =>
    path.join(attemptPaths.validatorsRoot, validatorID, "validator_input.json"),
  )
  const prompt = buildLongTaskExecutionPrompt({
    spec: input.spec,
    graph,
    unit: activeUnit,
    bundlePath: attemptPaths.inputBundlePath,
    validatorInputPaths,
  })

  const task = await runOpencodeTask({
    cwd: input.cwd,
    config,
    title: `Long Task Execute ${activeUnit.id}`,
    prompt,
    referencePaths: [
      ...input.spec.materials.map((item) => item.path),
      ...(input.spec.targetPaths ?? []).map((item) => item.path),
      ...(input.spec.initialExpertContextPaths ?? []),
      attemptPaths.inputBundlePath,
      ...input.spec.validators.filter((item) => item.type === "script").map((item) => item.path),
    ],
    attachedFiles: [],
    permissionReadPaths: [
      ...input.spec.materials.map((item) => item.path),
      ...(input.spec.targetPaths ?? []).map((item) => item.path),
      ...(input.spec.initialExpertContextPaths ?? []),
      attemptPaths.inputBundlePath,
      ...input.spec.validators.filter((item) => item.type === "script").map((item) => item.path),
    ],
    permissionEditPaths: input.spec.editablePaths ?? [],
    model: selection.model,
    agent: selection.agent,
    variant: selection.variant,
  })

  await writeTaskArtifacts(attemptPaths.executeDir, task, {
    phase: "long_task_execute",
    taskKind: "long_task_execute",
    methodID: input.spec.reversePropagation?.recipeID,
  })

  const rawOutput = extractJsonObject(task.result.responseText)
  const normalized = normalizeExecutionOutput(rawOutput, activeUnit)
  const claim = createClaim({
    runID: progressBefore.runID,
    unit: activeUnit,
    attempt,
    claimStatement: normalized.claimStatement,
    claimedSuccess: normalized.claimedSuccess,
    blockers: normalized.blockers,
    nextPriorityFix: normalized.nextPriorityFix,
    evidenceRefs: [path.join(attemptPaths.executeDir, "response.txt"), ...normalized.updatedFiles],
    checkTools: activeUnit.validatorIDs,
  })
  await appendVerificationClaim(input.run, claim)

  const scratchUnits = makeScratchUnits({
    runID: progressBefore.runID,
    unit: activeUnit,
    attempt,
    rawUnits: normalized.scratchUnits,
  })
  for (const item of scratchUnits) await appendScratchUnit(input.run, item)

  const learningUnits = makeLearningUnits({
    runID: progressBefore.runID,
    unit: activeUnit,
    rawUnits: normalized.learningUnits,
  })
  for (const item of learningUnits) await appendLearningUnit(input.run, item)
  await writeScratchDerivedViews(input.run)

  const validatorContracts = input.spec.validators.filter((validator) => activeUnit.validatorIDs.includes(validator.id))
  const validatorResults = []
  let progressMid = await readLongTaskProgressState(input.run)

  for (const validator of validatorContracts) {
    const validatorDir = path.join(attemptPaths.validatorsRoot, validator.id)
    const result = await runLongTaskValidator({
      cwd: input.cwd,
      config,
      contract: validator,
      spec: input.spec,
      unit: activeUnit,
      runID: progressBefore.runID,
      attempt,
      validatorDir,
      bundlePath: attemptPaths.inputBundlePath,
      payload: {
        runID: progressBefore.runID,
        unitID: activeUnit.id,
        attempt,
        goal: input.spec.goal,
        materials: input.spec.materials,
        targetPaths: input.spec.targetPaths ?? [],
        editablePaths: input.spec.editablePaths ?? [],
        bundlePath: attemptPaths.inputBundlePath,
      },
    })
    validatorResults.push(result)
    await appendValidatorResult(input.run, result)
    progressMid = {
      ...progressMid,
      validatorCalls: progressMid.validatorCalls + 1,
    }
    await writeLongTaskProgressState(input.run, progressMid)
  }

  return {
    graph,
    activeUnit,
    attempt,
    attemptPaths,
    claim,
    validatorResults,
    allValidatorsPassed: validatorResults.every((result) => result.passed),
    normalized,
  }
}

async function replanGraph(input: {
  cwd: string
  configPathCwd: string
  spec: LongTaskSpec
  run: ReturnType<typeof longTaskRunPaths>
  graph: LongTaskWorkGraph
}) {
  const recentFailures = (await readFailurePackets(input.run))
    .slice(-6)
    .map((packet) => `[${packet.unitID}] ${packet.mismatchSummary}`)
  const replanned = await runPlanningSession({
    cwd: input.cwd,
    configPathCwd: input.configPathCwd,
    spec: input.spec,
    specPath: input.run.taskPath,
    run: input.run,
    phase: "replan",
    existingGraph: input.graph,
    failureSummaries: recentFailures,
  })

  const nextGraph = mergeReplannedGraph({
    current: input.graph,
    replannedUnits: replanned.units.filter((unit) => unit.status !== "verified"),
    plannerSummary: replanned.plannerSummary,
    completionValidatorIDs: replanned.completionValidatorIDs,
  })

  await writeLongTaskWorkGraph(input.run, nextGraph)
  return nextGraph
}

async function runCompletionValidators(input: {
  cwd: string
  configPathCwd: string
  spec: LongTaskSpec
  run: ReturnType<typeof longTaskRunPaths>
  graph: LongTaskWorkGraph
}) {
  const completionValidatorIDs =
    input.graph.completionValidatorIDs.length > 0
      ? input.graph.completionValidatorIDs
      : input.spec.validators.filter((item) => item.required !== false).map((item) => item.id)
  const validatorContracts = input.spec.validators.filter((validator) => completionValidatorIDs.includes(validator.id))
  const progress = await readLongTaskProgressState(input.run)
  const syntheticUnit: LongTaskWorkUnit = {
    id: "__completion__",
    title: "Final Completion Validation",
    goal: "Validate that the long task as a whole is complete.",
    inputs: input.spec.materials.map((item) => item.path),
    dependsOn: [],
    expectedArtifacts: (input.spec.targetPaths ?? []).map((item) => item.path),
    claim: "The overall task goal is complete.",
    checkPlan: "Run final completion validators.",
    validatorIDs: completionValidatorIDs,
    retryBudget: 1,
    status: "active",
    attemptCount: 1,
  }
  const completionDir = path.join(input.run.root, "completion")
  const bundlePath = path.join(completionDir, "completion_bundle.json")
  await writeRetryInputBundle(bundlePath, {
    id: `completion-${randomUUID().slice(0, 8)}`,
    runID: progress.runID,
    unitID: syntheticUnit.id,
    createdAt: nowISO(),
    progressState: progress,
    currentUnit: syntheticUnit,
    recentClaims: [],
    recentFailurePackets: [],
    relevantScratchUnits: [],
    relevantLearningUnits: [],
  })

  const config = await loadConfig(input.configPathCwd)
  const results = []
  let updatedProgress = progress
  for (const validator of validatorContracts) {
    const result = await runLongTaskValidator({
      cwd: input.cwd,
      config,
      contract: validator,
      spec: input.spec,
      unit: syntheticUnit,
      runID: progress.runID,
      attempt: 1,
      validatorDir: path.join(completionDir, validator.id),
      bundlePath,
      payload: {
        runID: progress.runID,
        unitID: syntheticUnit.id,
        attempt: 1,
        goal: input.spec.goal,
        materials: input.spec.materials,
        targetPaths: input.spec.targetPaths ?? [],
        editablePaths: input.spec.editablePaths ?? [],
        bundlePath,
      },
    })
    results.push(result)
    await appendValidatorResult(input.run, result)
    updatedProgress = { ...updatedProgress, validatorCalls: updatedProgress.validatorCalls + 1 }
    await writeLongTaskProgressState(input.run, updatedProgress)
  }

  return results
}

async function finalizeLongTaskRun(input: {
  cwd: string
  run: ReturnType<typeof longTaskRunPaths>
  spec: LongTaskSpec
  status: LongTaskRunStatus
  summaryText: string
}) {
  const graph = await readLongTaskWorkGraph(input.run)
  const progress = await readLongTaskProgressState(input.run)
  const nextProgress = deriveLongTaskProgressState({
    runID: progress.runID,
    graph,
    previous: progress,
    status: input.status,
    finalSummary: input.summaryText,
  })
  await writeLongTaskProgressState(input.run, nextProgress)
  const summary = await buildLongTaskRunSummary(input.run)
  await writeLongTaskRunSummary(input.run, summary)

  const paths = longTaskPaths(input.cwd)
  await appendArchiveRecord(paths, defaultArchiveRecord({ run: input.run, summary }))
  await appendShadowMemoryRecord(paths, defaultShadowMemoryRecord({ run: input.run, summary, spec: input.spec }))

  return {
    runID: summary.runID,
    runDir: input.run.root,
    status: summary.status,
    summaryPath: input.run.summaryJsonPath,
    summary,
  }
}

async function continueLongTaskLoop(input: {
  cwd: string
  configPathCwd: string
  spec: LongTaskSpec
  run: ReturnType<typeof longTaskRunPaths>
}) {
  while (true) {
    let graph = await readLongTaskWorkGraph(input.run)
    let progress = await readLongTaskProgressState(input.run)

    if (
      progress.status === "verified_success" ||
      progress.status === "exhausted_failure" ||
      progress.status === "stagnation_failure" ||
      progress.status === "blocked_failure"
    ) {
      return finalizeLongTaskRun({
        cwd: input.cwd,
        run: input.run,
        spec: input.spec,
        status: progress.status,
        summaryText: progress.finalSummary ?? `Long-task finished with status ${progress.status}.`,
      })
    }

    const budgetStop = shouldStopForBudgets({ progress, spec: input.spec })
    if (budgetStop) {
      return finalizeLongTaskRun({
        cwd: input.cwd,
        run: input.run,
        spec: input.spec,
        status: budgetStop,
        summaryText: `Long-task stopped because ${budgetStop} was reached.`,
      })
    }

    const nextUnit = selectNextLongTaskUnit(graph)
    if (!nextUnit) {
      const allVerified = graph.units.length > 0 && graph.units.every((unit) => unit.status === "verified")
      if (allVerified) {
        const completionResults = await runCompletionValidators({
          cwd: input.cwd,
          configPathCwd: input.configPathCwd,
          spec: input.spec,
          run: input.run,
          graph,
        })
        const completionPassed = completionResults.every((result) => result.passed)
        if (completionPassed) {
          return finalizeLongTaskRun({
            cwd: input.cwd,
            run: input.run,
            spec: input.spec,
            status: "verified_success",
            summaryText: "All work units completed and all required completion validators passed.",
          })
        }

        const failure = createFailurePacket({
          runID: progress.runID,
          unitID: "__completion__",
          attempt: 1,
          claimedSuccess: true,
          verificationPassed: false,
          mismatchSummary: completionResults.map((item) => item.summary).join(" | ") || "Final completion validation failed.",
          suspectedCauses: completionResults.flatMap((item) => item.details).slice(0, 6),
          evidenceRefs: completionResults.flatMap((item) => item.evidenceRefs),
          retryLevel: "subgraph_retry",
          failureType: "validator_failed",
        })
        await appendFailurePacket(input.run, failure)
        await appendRetryJournalEntry(input.run, {
          id: `retry-${randomUUID().slice(0, 8)}`,
          runID: progress.runID,
          createdAt: nowISO(),
          level: "subgraph_retry",
          toUnitID: "__completion__",
          reason: failure.mismatchSummary,
        })

        if ((progress.graphReplanCount ?? 0) < (input.spec.budgets?.maxGraphReplans ?? DEFAULT_LONG_TASK_BUDGETS.maxGraphReplans)) {
          graph = await replanGraph({
            cwd: input.cwd,
            configPathCwd: input.configPathCwd,
            spec: input.spec,
            run: input.run,
            graph,
          })
          progress = deriveLongTaskProgressState({
            runID: progress.runID,
            graph,
            previous: progress,
            status: "running",
          })
          progress.graphReplanCount += 1
          progress.noProgressCycles += 1
          progress.lastFailurePacketID = failure.id
          await writeLongTaskWorkGraph(input.run, graph)
          await writeLongTaskProgressState(input.run, progress)
          continue
        }

        return finalizeLongTaskRun({
          cwd: input.cwd,
          run: input.run,
          spec: input.spec,
          status: "exhausted_failure",
          summaryText: failure.mismatchSummary,
        })
      }

      if ((progress.graphReplanCount ?? 0) < (input.spec.budgets?.maxGraphReplans ?? DEFAULT_LONG_TASK_BUDGETS.maxGraphReplans)) {
        graph = await replanGraph({
          cwd: input.cwd,
          configPathCwd: input.configPathCwd,
          spec: input.spec,
          run: input.run,
          graph,
        })
        progress = deriveLongTaskProgressState({
          runID: progress.runID,
          graph,
          previous: progress,
          status: "running",
        })
        progress.graphReplanCount += 1
        progress.noProgressCycles += 1
        await writeLongTaskWorkGraph(input.run, graph)
        await writeLongTaskProgressState(input.run, progress)
        continue
      }

      return finalizeLongTaskRun({
        cwd: input.cwd,
        run: input.run,
        spec: input.spec,
        status: "blocked_failure",
        summaryText: "No ready work unit remained and the graph could not be replanned further.",
      })
    }

    const execution = await executeWorkUnit({
      cwd: input.cwd,
      configPathCwd: input.configPathCwd,
      spec: input.spec,
      run: input.run,
      graph,
      unit: nextUnit,
    })

    graph = execution.graph
    progress = await readLongTaskProgressState(input.run)
    progress.lastClaimID = execution.claim.id

    if (execution.allValidatorsPassed) {
      graph = markLongTaskWorkUnitVerified(graph, execution.activeUnit.id, execution.claim.id)
      progress = deriveLongTaskProgressState({
        runID: progress.runID,
        graph,
        previous: progress,
        status: "running",
      })
      progress.noProgressCycles = 0
      progress.lastProgressAt = nowISO()
      await writeLongTaskWorkGraph(input.run, graph)
      await writeLongTaskProgressState(input.run, progress)
      continue
    }

    const failure = createFailurePacket({
      runID: progress.runID,
      unitID: execution.activeUnit.id,
      attempt: execution.attempt,
      claimedSuccess: execution.claim.claimedSuccess,
      verificationPassed: false,
      mismatchSummary:
        execution.validatorResults.map((item) => item.summary).join(" | ") || "Validators did not pass for this unit.",
      suspectedCauses: [
        ...execution.claim.blockers,
        ...execution.validatorResults.flatMap((item) => item.details),
      ].slice(0, 6),
      nextPriorityFix: execution.claim.nextPriorityFix ?? execution.normalized.nextPriorityFix,
      evidenceRefs: [
        path.join(execution.attemptPaths.executeDir, "response.txt"),
        ...execution.validatorResults.flatMap((item) => item.evidenceRefs),
      ],
      retryLevel: "work_unit_retry",
      failureType: "validator_failed",
    })
    await appendFailurePacket(input.run, failure)
    await appendRetryJournalEntry(input.run, {
      id: `retry-${randomUUID().slice(0, 8)}`,
      runID: progress.runID,
      createdAt: nowISO(),
      level: "work_unit_retry",
      fromUnitID: execution.activeUnit.id,
      toUnitID: execution.activeUnit.id,
      reason: failure.mismatchSummary,
    })

    const unitAfterFailure: LongTaskWorkUnit = {
      ...execution.activeUnit,
      status: "active",
      lastFailurePacketID: failure.id,
      lastClaimID: execution.claim.id,
    }
    graph = {
      ...graph,
      units: graph.units.map((unit) => (unit.id === unitAfterFailure.id ? unitAfterFailure : unit)),
      updatedAt: nowISO(),
    }

    progress = deriveLongTaskProgressState({
      runID: progress.runID,
      graph,
      previous: progress,
      status: "waiting_for_retry",
    })
    progress.lastFailurePacketID = failure.id
    progress.noProgressCycles += 1
    await writeLongTaskWorkGraph(input.run, graph)
    await writeLongTaskProgressState(input.run, progress)

    const attemptsLimit = Math.min(
      execution.activeUnit.retryBudget,
      input.spec.budgets?.maxAttemptsPerUnit ?? DEFAULT_LONG_TASK_BUDGETS.maxAttemptsPerUnit,
    )

    if (execution.activeUnit.attemptCount < attemptsLimit) {
      continue
    }

    if ((progress.graphReplanCount ?? 0) < (input.spec.budgets?.maxGraphReplans ?? DEFAULT_LONG_TASK_BUDGETS.maxGraphReplans)) {
      graph = await replanGraph({
        cwd: input.cwd,
        configPathCwd: input.configPathCwd,
        spec: input.spec,
        run: input.run,
        graph,
      })
      progress = deriveLongTaskProgressState({
        runID: progress.runID,
        graph,
        previous: progress,
        status: "running",
      })
      progress.graphReplanCount += 1
      await writeLongTaskWorkGraph(input.run, graph)
      await writeLongTaskProgressState(input.run, progress)
      continue
    }

    return finalizeLongTaskRun({
      cwd: input.cwd,
      run: input.run,
      spec: input.spec,
      status: "exhausted_failure",
      summaryText: `Unit ${execution.activeUnit.id} exhausted its retry budget and no further replans were available.`,
    })
  }
}

export async function runLongTask(input: { cwd: string; specPath: string }) {
  await loadConfig(input.cwd)
  const { spec, specPath } = await loadLongTaskSpec(input.specPath)
  const runID = createLongTaskRunID(spec.title)
  const progress = createInitialLongTaskProgressState(runID)
  const placeholderGraph = createLongTaskWorkGraph({
    plannerSummary: "Long-task run initialized before graph bootstrap.",
    completionValidatorIDs: spec.validators.filter((item) => item.required !== false).map((item) => item.id),
    units: [],
    revision: 0,
  })

  const initialized = await initializeLongTaskRun({
    cwd: input.cwd,
    spec,
    workGraph: placeholderGraph,
    progressState: progress,
  })

  const graph = await runPlanningSession({
    cwd: input.cwd,
    configPathCwd: input.cwd,
    spec,
    specPath,
    run: initialized.run,
    phase: "plan",
  })

  const runningProgress = deriveLongTaskProgressState({
    runID: initialized.runID,
    graph,
    previous: progress,
    status: "running",
  })
  await writeLongTaskWorkGraph(initialized.run, graph)
  await writeLongTaskProgressState(initialized.run, runningProgress)

  return continueLongTaskLoop({
    cwd: input.cwd,
    configPathCwd: input.cwd,
    spec,
    run: initialized.run,
  })
}

export async function resumeLongTask(input: { cwd: string; runID: string }) {
  const resolved = resolveExistingLongTaskRun(input.cwd, input.runID)
  const spec = await readLongTaskSpec(resolved.run)
  return continueLongTaskLoop({
    cwd: input.cwd,
    configPathCwd: input.cwd,
    spec,
    run: resolved.run,
  })
}
