import path from "node:path"
import { randomUUID } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import type {
  LongTaskFailurePacket,
  LongTaskLearningUnit,
  LongTaskOperationalContextItem,
  LongTaskRunStatus,
  LongTaskScratchUnit,
  LongTaskRetryLesson,
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
  appendRetryLesson,
  appendScratchUnit,
  appendShadowMemoryRecord,
  readLearningUnits,
  readOperationalContext,
  readRetryLessons,
  readScratchUnits,
  readShadowMemoryRecords,
  readVerificationClaims,
  appendValidatorResult,
  appendVerificationClaim,
  buildLongTaskRunSummary,
  buildRetryInputBundle,
  createInitialLongTaskProgressState,
  createLongTaskRunID,
  defaultArchiveRecord,
  defaultShadowMemoryRecord,
  initializeLongTaskRun,
  isolateLongTaskRuntimePaths,
  longTaskPlanPaths,
  longTaskReplanPaths,
  longTaskRunPaths,
  longTaskUnitAttemptPaths,
  longTaskPaths,
  readFailurePackets,
  readLongTaskProgressState,
  readLongTaskFinalizationState,
  readLongTaskSpec,
  readLongTaskWorkGraph,
  resolveExistingLongTaskRun,
  resolveLongTaskEditablePaths,
  resolveLongTaskFormalPackageRoots,
  upsertOperationalContext,
  writeLongTaskCandidatePackage,
  writeLongTaskFinalizationState,
  writeLongTaskProgressState,
  writeLongTaskRunSummary,
  writeLongTaskWorkGraph,
  writeRetryInputBundle,
  writeScratchDerivedViews,
  buildLongTaskWorkUnit,
} from "./repository"
import { maintenanceGatewayPaths, writeMaintenanceRequest } from "../maintenance-gateway/repository"
import { recordAcceptanceResult } from "../acceptance-framework/run"
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
import { buildLongTaskExecutionPrompt, buildLongTaskPlanningPrompt, buildLongTaskReplanPrompt } from "./prompts"
import { runLongTaskValidator } from "./validators"
import { loadConfig } from "../schema"
import { runOpencodeTask, type OpencodeTaskInput } from "../opencode"
import type { OpencodeRunResult } from "../opencode"
import { hasConcreteAnswerLeakageSurface } from "../answer-surface"
import { resolveModelSelection } from "../model-selection"
import { writeTaskArtifacts } from "../task-artifacts"
import { extractJsonObject } from "./json-extract"
import { cleanupRuntimeProcessScope, longTaskRunRuntimeScope } from "../runtime-process-registry"
import {
  experienceWorkspacePathsFromRoot,
  readExperienceWorkspace,
  writeExperienceWorkspaceSnapshot,
} from "../experience-workspace"

function nowISO() {
  return new Date().toISOString()
}

function short(text: string, limit = 200) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return normalized.slice(0, limit - 3) + "..."
}

const NO_SIGNAL_BLOCK_FAILURE_THRESHOLD = (() => {
  const value = Number.parseInt(process.env.AUTO_EVOLVE_NO_SIGNAL_BLOCK_THRESHOLD ?? "", 10)
  if (Number.isFinite(value) && value >= 2) return value
  // Default threshold lowered from 3 to 2 to terminate unresponsive units faster
  return 2
})()

interface TaskSignalHealth {
  noSessionSignal: boolean
  hasTransportSignal: boolean
  likelyInfrastructureFailure: boolean
}

function analyzeTaskSignalHealth(
  result: Pick<OpencodeRunResult, "exitCode" | "events" | "responseText" | "sessionID" | "stdout" | "stderr">,
): TaskSignalHealth {
  const noEvents = result.events.length === 0
  const noResponse = result.responseText.trim().length === 0
  const noSession = typeof result.sessionID !== "string" || result.sessionID.trim().length === 0
  const hasTransportSignal = result.stdout.trim().length > 0 || result.stderr.trim().length > 0
  const noSessionSignal = noEvents && noResponse && !hasTransportSignal
  return {
    noSessionSignal,
    hasTransportSignal,
    likelyInfrastructureFailure: result.exitCode !== 0 && noSession && noSessionSignal,
  }
}

function noSignalSummary(input: {
  owner: string
  result: Pick<OpencodeRunResult, "exitCode" | "stderr">
}) {
  const stderrLine = short(input.result.stderr || "", 120)
  const suffix = stderrLine ? ` Last stderr: ${stderrLine}` : ""
  return short(
    `${input.owner} produced no structured signal (no events/response) and exited with code ${input.result.exitCode}.${suffix}`,
    240,
  )
}

function isHardNoSignalSummary(text: string) {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim()
  if (!normalized) return false
  return normalized.includes("no structured signal") || normalized.includes("no-structured-signal") || normalized.includes("no events/response")
}

function isNoSignalFailurePacket(packet: LongTaskFailurePacket) {
  return packet.failureType === "invalid_execution_output" && isHardNoSignalSummary(packet.mismatchSummary)
}

function hasConsecutiveNoSignalFailures(packets: LongTaskFailurePacket[], threshold: number) {
  if (threshold <= 0) return false
  if (packets.length < threshold) return false
  return packets.slice(-threshold).every(isNoSignalFailurePacket)
}

function onceActivationCallback(callback?: OpencodeTaskInput["onSpawn"]) {
  if (!callback) return undefined
  let activated = false
  return async () => {
    if (activated) return
    activated = true
    await callback()
  }
}

async function cleanupRuntimeScopeWithRetry(scope: string | undefined) {
  const first = await cleanupRuntimeProcessScope(scope)
  if (first.remainingCount <= 0) return
  await sleep(250)
  await cleanupRuntimeProcessScope(scope)
}

async function updateLongTaskProgressStatus(run: ReturnType<typeof longTaskRunPaths>, status: LongTaskRunStatus) {
  const [graph, previous] = await Promise.all([readLongTaskWorkGraph(run), readLongTaskProgressState(run)])
  if (previous.status === status) return
  if (
    previous.status === "graph_completed" ||
    previous.status === "verified_success" ||
    previous.status === "exhausted_failure" ||
    previous.status === "stagnation_failure" ||
    previous.status === "blocked_failure" ||
    previous.status === "archived"
  ) {
    return
  }
  const next = deriveLongTaskProgressState({
    runID: previous.runID,
    graph,
    previous,
    status,
  })
  await writeLongTaskProgressState(run, next)
}

function isLiveLongTaskStatus(status: LongTaskRunStatus) {
  return status === "planning" || status === "bootstrapping" || status === "running" || status === "waiting_for_retry"
}

async function pulseLongTaskProgress(run: ReturnType<typeof longTaskRunPaths>) {
  const progress = await readLongTaskProgressState(run)
  if (!isLiveLongTaskStatus(progress.status)) return
  await writeLongTaskProgressState(run, progress)
}

async function extractJsonObjectFromPath(filePath: string) {
  try {
    const content = await readFile(filePath, "utf8")
    return extractJsonObject(content)
  } catch {
    return undefined
  }
}

function readStringField(raw: Record<string, unknown> | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = raw?.[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function readBooleanField(raw: Record<string, unknown> | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = raw?.[key]
    if (typeof value === "boolean") return value
  }
  return undefined
}

function readArrayField(raw: Record<string, unknown> | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = raw?.[key]
    if (Array.isArray(value)) return value
  }
  return undefined
}

function normalizeStringArray(input: unknown) {
  if (!Array.isArray(input)) return []
  return input
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
}

function uniqueStrings(items: string[]) {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)))
}

function includesAny(text: string, items: string[]) {
  const normalized = text.toLowerCase()
  return items.some((item) => normalized.includes(item))
}

function isPlatformValidationUnit(raw: Record<string, unknown>) {
  const text = [
    typeof raw.id === "string" ? raw.id : "",
    typeof raw.title === "string" ? raw.title : "",
    typeof raw.goal === "string" ? raw.goal : "",
    typeof raw.claim === "string" ? raw.claim : "",
    typeof raw.check_plan === "string" ? raw.check_plan : "",
  ]
    .join(" ")
    .toLowerCase()
  if (includesAny(text, ["validate-completion-gate", "run-final-acceptance", "confirm-validator"])) return true
  if (!includesAny(text, ["completion validator", "completion validators", "single-point-soft-validate", "runpromptvalidator", "result.json"])) return false
  return includesAny(text, ["run", "invoke", "confirm", "execute"])
}

function scrubCheckPlan(input: string | undefined) {
  const text = input?.trim()
  if (!text) return "Create the expected artifacts and leave concise local self-check evidence."
  if (
    includesAny(text, ["completion validator", "completion validators", "single-point-soft-validate", "runpromptvalidator"]) ||
    includesAny(text, ["result.json"])
  ) {
    return [
      "Do not run platform-owned completion validators from this worker.",
      "Complete the expected artifacts and run only local self-checks that do not create validator result files.",
      "The orchestrator will run completion validators after graph completion.",
    ].join(" ")
  }
  return text
}

function isExperienceWorkspaceRef(input: { role?: string; label?: string; path: string }) {
  const descriptor = `${input.role ?? ""} ${input.label ?? ""} ${path.basename(input.path)}`.toLowerCase()
  return descriptor.includes("experience-workspace") || descriptor.includes("expert-workspace")
}

async function buildCompletionValidationSpec(input: {
  spec: LongTaskSpec
  run: ReturnType<typeof longTaskRunPaths>
}) {
  const pendingPackageRoot = input.spec.campaignPendingPackageRoot
  if (!pendingPackageRoot) return input.spec

  const validationPackageRoot = path.join(input.run.root, "completion", "validation-expert-workspace")
  const snapshot = await readExperienceWorkspace(experienceWorkspacePathsFromRoot(pendingPackageRoot, "manifest.md"))
  await rm(validationPackageRoot, { recursive: true, force: true })
  await writeExperienceWorkspaceSnapshot(validationPackageRoot, snapshot)

  const previousTargets = input.spec.targetPaths ?? []
  const targetPaths = previousTargets.length
    ? previousTargets.map((item) =>
        isExperienceWorkspaceRef(item)
          ? {
              ...item,
              path: validationPackageRoot,
              label: item.label ? `${item.label} validation mirror` : "validation expert workspace mirror",
            }
          : item,
      )
    : [
        {
          path: validationPackageRoot,
          label: "validation expert workspace mirror",
          role: "experience-workspace",
        },
      ]

  return {
    ...input.spec,
    targetPaths,
    formalPackageRoots: [validationPackageRoot],
    initialExpertContextPaths: uniqueStrings([validationPackageRoot, ...(input.spec.initialExpertContextPaths ?? [])]),
    preservePreseededEditablePaths: uniqueStrings([
      validationPackageRoot,
      ...(input.spec.preservePreseededEditablePaths ?? []),
    ]),
  }
}

function pad(value: number) {
  return String(value).padStart(2, "0")
}

function longTaskAcceptancePolicyID(spec: LongTaskSpec) {
  return spec.reversePropagation?.acceptancePolicyID ?? "long-task-candidate-guard"
}

function longTaskLocalAcceptanceTargetID(unit: LongTaskWorkUnit, attempt: number) {
  return `${unit.id}:attempt-${pad(attempt)}`
}

function longTaskAttemptAcceptanceMirrorPath(attemptRoot: string, stageID: string) {
  return path.join(attemptRoot, "acceptance", `${stageID}.json`)
}

function longTaskRunAcceptanceMirrorPath(runRoot: string, stageID: string) {
  return path.join(runRoot, "acceptance", `${stageID}.json`)
}

function capabilityReferencePaths(spec: LongTaskSpec) {
  return uniqueStrings((spec.capabilities ?? []).flatMap((capability) => capability.referencePaths ?? []))
}

function capabilityAttachedFiles(spec: LongTaskSpec) {
  return uniqueStrings((spec.capabilities ?? []).flatMap((capability) => capability.attachedFiles ?? []))
}

function looksLikePathRef(value: string) {
  return value.startsWith(".") || value.includes("/") || value.includes("\\") || value.includes(":")
}

function allowedGraphPathRoots(spec: LongTaskSpec) {
  return uniqueStrings([
    ...spec.materials.map((item) => item.path),
    ...(spec.targetPaths ?? []).map((item) => item.path),
    ...(spec.editablePaths ?? []),
    ...(spec.initialExpertContextPaths ?? []),
    ...capabilityReferencePaths(spec),
  ]).map((item) => path.resolve(item))
}

function isWithinAllowedGraphRoots(value: string, roots: string[]) {
  const resolved = path.resolve(value)
  return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
}

function sanitizeGraphPathRefs(values: string[], roots: string[]) {
  return values.filter((value) => !looksLikePathRef(value) || isWithinAllowedGraphRoots(value, roots))
}

function normalizeGraphUnits(raw: unknown, spec: LongTaskSpec) {
  if (!Array.isArray(raw)) return []
  const maxUnits = spec.budgets?.maxUnitsPerGraph ?? DEFAULT_LONG_TASK_BUDGETS.maxUnitsPerGraph
  const usedIDs = new Set<string>()
  const unitScopedValidatorIDs = new Set(
    spec.validators.filter((item) => item.placement !== "completion_only").map((item) => item.id),
  )
  const allowedRoots = allowedGraphPathRoots(spec)
  const fallbackInputs = uniqueStrings([
    ...spec.materials.map((item) => item.path),
    ...(spec.initialExpertContextPaths ?? []),
    ...(spec.editablePaths ?? []),
  ])
  const fallbackExpectedArtifacts = uniqueStrings([
    ...(spec.targetPaths ?? []).map((item) => item.path),
    ...(spec.editablePaths ?? []),
  ])
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
    if (isPlatformValidationUnit(item as Record<string, unknown>)) continue
    const sanitizedInputs = sanitizeGraphPathRefs(normalizeStringArray(item.inputs), allowedRoots)
    const sanitizedExpectedArtifacts = sanitizeGraphPathRefs(
      normalizeStringArray(item.expected_artifacts),
      allowedRoots,
    )
    const hasExplicitValidatorIDs = Object.prototype.hasOwnProperty.call(item, "validator_ids")
    const proposedValidatorIDs = normalizeStringArray(item.validator_ids).filter((idValue) =>
      unitScopedValidatorIDs.has(idValue),
    )
    units.push(
      buildLongTaskWorkUnit({
        id,
        title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : id,
        goal: typeof item.goal === "string" && item.goal.trim() ? item.goal.trim() : `Advance ${id}`,
        inputs: sanitizedInputs.length > 0 ? sanitizedInputs : fallbackInputs,
        dependsOn: normalizeStringArray(item.depends_on).filter((dep) => dep !== id),
        expectedArtifacts:
          sanitizedExpectedArtifacts.length > 0 ? sanitizedExpectedArtifacts : fallbackExpectedArtifacts,
        claim: typeof item.claim === "string" && item.claim.trim() ? item.claim.trim() : `Unit ${id} is complete.`,
        checkPlan: scrubCheckPlan(typeof item.check_plan === "string" ? item.check_plan : undefined),
        validatorIDs:
          proposedValidatorIDs.length > 0
            ? proposedValidatorIDs
            : hasExplicitValidatorIDs
              ? []
              : spec.validators
                  .filter((validator) => validator.required !== false && validator.placement !== "completion_only")
                  .map((validator) => validator.id),
        retryBudget,
      }),
    )
  }

  return units
}

export function requiredWorkUnitValidatorIDs(spec: LongTaskSpec) {
  return spec.validators
    .filter((item) => item.required !== false && item.placement !== "completion_only")
    .map((item) => item.id)
}

export function requiredCompletionValidatorIDs(spec: LongTaskSpec) {
  if (spec.disableCompletionValidators) return []
  return spec.validators
    .filter((item) => item.required !== false && item.placement === "completion_only")
    .map((item) => item.id)
}

function fallbackLongTaskGraph(spec: LongTaskSpec, reason: string) {
  const completionValidatorIDs = requiredCompletionValidatorIDs(spec)
  const unitValidatorIDs = requiredWorkUnitValidatorIDs(spec)
  return createLongTaskWorkGraph({
    plannerSummary: `Fallback graph used: ${reason}`,
    completionValidatorIDs,
    units: [
      buildLongTaskWorkUnit({
        id: "complete-task",
        title: "Complete Task",
        goal: spec.goal,
        inputs: spec.materials.map((item) => item.path),
        dependsOn: [],
        expectedArtifacts: (spec.targetPaths ?? []).map((item) => item.path),
        claim: "The main long-task goal is completed and validator-ready.",
        checkPlan: "Run all required work-unit validators against the current task outputs.",
        validatorIDs: unitValidatorIDs,
        retryBudget: spec.budgets?.maxAttemptsPerUnit ?? DEFAULT_LONG_TASK_BUDGETS.maxAttemptsPerUnit,
      }),
    ],
  })
}

function normalizePlanningGraph(raw: Record<string, unknown> | undefined, spec: LongTaskSpec, fallbackReason: string) {
  if (!raw) return fallbackLongTaskGraph(spec, fallbackReason)
  const hasExplicitCompletionValidatorIDs = Object.prototype.hasOwnProperty.call(raw, "completion_validator_ids")
  const completionValidatorIDs = normalizeStringArray(raw.completion_validator_ids)
  const units = normalizeGraphUnits(raw.units, spec)
  if (!units.length) return fallbackLongTaskGraph(spec, fallbackReason)
  return createLongTaskWorkGraph({
    plannerSummary:
      typeof raw.planner_summary === "string" && raw.planner_summary.trim() ? raw.planner_summary.trim() : undefined,
    completionValidatorIDs: hasExplicitCompletionValidatorIDs
      ? completionValidatorIDs
      : requiredCompletionValidatorIDs(spec),
    units,
  })
}

function normalizeExecutionOutput(raw: Record<string, unknown> | undefined, unit: LongTaskWorkUnit) {
  const claimStatement =
    readStringField(raw, "claim_statement", "claimStatement", "claim", "summary") ??
    `Attempted ${unit.id}, but did not return a structured claim.`
  const claimedSuccess = readBooleanField(raw, "claimed_success", "claimedSuccess", "success") ?? false
  const blockers = normalizeStringArray(readArrayField(raw, "blockers"))
  const nextPriorityFix = readStringField(raw, "next_priority_fix", "nextPriorityFix")
  const updatedFiles = normalizeStringArray(readArrayField(raw, "updated_files", "updatedFiles"))
  const retryAck = readStringField(raw, "retry_ack", "retryAck")
  const strategyChange = readStringField(raw, "strategy_change", "strategyChange")
  const selfChecksRun = normalizeStringArray(readArrayField(raw, "self_checks_run", "selfChecksRun"))

  const scratchUnits = Array.isArray(readArrayField(raw, "scratch_units", "scratchUnits"))
    ? (readArrayField(raw, "scratch_units", "scratchUnits") as unknown[])
        .filter((item) => typeof item === "object" && item !== null && !Array.isArray(item))
        .map((item) => item as Record<string, unknown>)
    : []

  const learningUnits = Array.isArray(readArrayField(raw, "learning_units", "learningUnits"))
    ? (readArrayField(raw, "learning_units", "learningUnits") as unknown[])
        .filter((item) => typeof item === "object" && item !== null && !Array.isArray(item))
        .map((item) => item as Record<string, unknown>)
    : []

  return {
    claimStatement,
    claimedSuccess,
    blockers,
    nextPriorityFix,
    updatedFiles,
    retryAck,
    strategyChange,
    selfChecksRun,
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

function makeLearningUnits(input: { runID: string; unit: LongTaskWorkUnit; rawUnits: Record<string, unknown>[] }) {
  return input.rawUnits.map(
    (item) =>
      ({
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
      }) satisfies LongTaskLearningUnit,
  )
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

function makeRetryReflectionScratchUnits(input: {
  runID: string
  unit: LongTaskWorkUnit
  attempt: number
  retryAck?: string
  strategyChange?: string
  selfChecksRun: string[]
}) {
  const notes: LongTaskScratchUnit[] = []
  if (input.retryAck) {
    notes.push({
      id: `scratch-${randomUUID().slice(0, 8)}`,
      runID: input.runID,
      unitID: input.unit.id,
      attempt: input.attempt,
      createdAt: nowISO(),
      kind: "obs",
      statement: short(`retry_ack: ${input.retryAck}`, 220),
      refs: [],
      relatedUnitIDs: [input.unit.id],
    })
  }
  if (input.strategyChange) {
    notes.push({
      id: `scratch-${randomUUID().slice(0, 8)}`,
      runID: input.runID,
      unitID: input.unit.id,
      attempt: input.attempt,
      createdAt: nowISO(),
      kind: "fix",
      statement: short(`strategy_change: ${input.strategyChange}`, 220),
      refs: [],
      relatedUnitIDs: [input.unit.id],
    })
  }
  for (const check of input.selfChecksRun) {
    notes.push({
      id: `scratch-${randomUUID().slice(0, 8)}`,
      runID: input.runID,
      unitID: input.unit.id,
      attempt: input.attempt,
      createdAt: nowISO(),
      kind: "obs",
      statement: short(`self_check_run: ${check}`, 220),
      refs: [],
      relatedUnitIDs: [input.unit.id],
    })
  }
  return notes
}

function buildWorkUnitFailureSummary(input: {
  claim: LongTaskVerificationClaim
  validatorResults: Array<{ passed: boolean; summary: string }>
}) {
  const parts: string[] = []
  if (!input.claim.claimedSuccess) {
    parts.push(`Execution claim failed: ${input.claim.statement}`)
  }
  parts.push(...input.validatorResults.filter((item) => !item.passed).map((item) => item.summary))
  return parts.join(" | ") || "The current work unit did not satisfy its execution or validation contract."
}

function createRetryLesson(input: {
  runID: string
  unit: LongTaskWorkUnit
  attempt: number
  claim: LongTaskVerificationClaim
  failure: LongTaskFailurePacket
  strategyChange?: string
  selfChecksRun: string[]
}): LongTaskRetryLesson {
  const isNoSignalFailure = isHardNoSignalSummary(input.failure.mismatchSummary)
  const doNotRepeat = uniqueStrings([
    isNoSignalFailure
      ? "Do not continue domain-level retries until runtime can return structured execution signal."
      : input.claim.claimedSuccess
        ? ""
        : "Do not claim success while blockers or known gaps still remain.",
    ...(isNoSignalFailure ? [] : input.failure.suspectedCauses.map((item) => `Do not ignore: ${short(item, 120)}`)),
  ]).slice(0, 4)

  const nextAttemptStrategy = uniqueStrings([
    input.failure.nextPriorityFix ?? "",
    input.strategyChange ?? "",
    isNoSignalFailure ? "Restore events/response structured signal first, then retry this unit." : "",
    `Follow the current unit check plan before returning claimed_success=true: ${short(input.unit.checkPlan, 160)}`,
  ]).slice(0, 4)

  const requiredSelfChecks = uniqueStrings([
    ...input.unit.validatorIDs.map((validatorID) => `validator:${validatorID}`),
    ...input.selfChecksRun.map((item) => `self-check:${short(item, 140)}`),
    short(input.unit.checkPlan, 160),
  ]).slice(0, 6)

  return {
    id: `retry-lesson-${randomUUID().slice(0, 8)}`,
    runID: input.runID,
    unitID: input.unit.id,
    attempt: input.attempt,
    createdAt: nowISO(),
    sourceFailurePacketID: input.failure.id,
    sourceClaimID: input.claim.id,
    failureType: input.failure.failureType,
    failureSignature: `${input.unit.id}:${input.failure.failureType}:attempt-${input.attempt}`,
    whatFailed: short(input.failure.mismatchSummary, 220),
    whyFailed: input.failure.suspectedCauses.slice(0, 4),
    doNotRepeat,
    nextAttemptStrategy,
    requiredSelfChecks,
    evidenceRefs: input.failure.evidenceRefs,
  }
}

function syntheticCompletionUnit(spec: LongTaskSpec): LongTaskWorkUnit {
  return {
    id: "__completion__",
    title: "Final Completion Validation",
    goal: "Validate that the long task as a whole is complete.",
    inputs: spec.materials.map((item) => item.path),
    dependsOn: [],
    expectedArtifacts: (spec.targetPaths ?? []).map((item) => item.path),
    claim: "The overall task goal is complete.",
    checkPlan: "Run final completion validators.",
    validatorIDs: spec.validators.filter((item) => item.required !== false).map((item) => item.id),
    retryBudget: 1,
    status: "active",
    attemptCount: 1,
  }
}

function operationalContextTags(input: { spec: LongTaskSpec; unit: LongTaskWorkUnit; extra?: string[] }) {
  return uniqueStrings([
    input.unit.id,
    ...(input.spec.taskFamily ? [input.spec.taskFamily] : []),
    ...(input.spec.domainTags ?? []),
    ...(input.extra ?? []),
  ])
}

function makeOperationalContextItem(input: {
  runID: string
  unit: LongTaskWorkUnit
  attempt: number
  kind: LongTaskOperationalContextItem["kind"]
  status: LongTaskOperationalContextItem["status"]
  statement: string
  rationale?: string
  refs: string[]
  tags: string[]
}): LongTaskOperationalContextItem {
  return {
    id: `opctx-${randomUUID().slice(0, 8)}`,
    runID: input.runID,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    sourceUnitID: input.unit.id,
    sourceAttempt: input.attempt,
    kind: input.kind,
    status: input.status,
    statement: short(input.statement, 240),
    rationale: input.rationale ? short(input.rationale, 220) : undefined,
    refs: uniqueStrings(input.refs),
    tags: uniqueStrings(input.tags),
  }
}

function inferOperationalKindFromLearning(kind: LongTaskLearningUnit["kind"]) {
  if (kind === "tooling_hint") return "tool_entrypoint" as const
  if (kind === "repair_pattern" || kind === "validator_hint" || kind === "rule") return "validated_method" as const
  if (kind === "exception") return "package_gap" as const
  if (kind === "failure_pattern") return "failed_path" as const
  return "confirmed_fact" as const
}

function promoteOperationalContextFromVerifiedUnit(input: {
  spec: LongTaskSpec
  runID: string
  unit: LongTaskWorkUnit
  attempt: number
  claim: LongTaskVerificationClaim
  learningUnits: LongTaskLearningUnit[]
  validatorResults: LongTaskValidatorResult[]
  selfChecksRun: string[]
}): LongTaskOperationalContextItem[] {
  const items: LongTaskOperationalContextItem[] = []

  if (!hasConcreteAnswerLeakageSurface(input.claim.statement)) {
    items.push(
      makeOperationalContextItem({
        runID: input.runID,
        unit: input.unit,
        attempt: input.attempt,
        kind: "confirmed_fact",
        status: "confirmed",
        statement: input.claim.statement,
        rationale: "Validated at the work-unit boundary before promotion into run-global context.",
        refs: input.claim.evidenceRefs,
        tags: operationalContextTags({ spec: input.spec, unit: input.unit, extra: ["verified-claim"] }),
      }),
    )
  }

  for (const unit of input.learningUnits) {
    const shouldPromote =
      unit.scope === "pattern" ||
      unit.scope === "global_candidate" ||
      unit.strength >= 2 ||
      unit.kind === "repair_pattern" ||
      unit.kind === "tooling_hint" ||
      unit.kind === "validator_hint"
    if (!shouldPromote) continue
    if (hasConcreteAnswerLeakageSurface(unit.statement)) continue
    items.push(
      makeOperationalContextItem({
        runID: input.runID,
        unit: input.unit,
        attempt: input.attempt,
        kind: inferOperationalKindFromLearning(unit.kind),
        status:
          unit.scope === "global_candidate" || unit.scope === "pattern" || unit.strength >= 2
            ? "confirmed"
            : "candidate",
        statement: unit.statement,
        rationale: `Promoted from ${unit.kind} learning after a verified unit outcome.`,
        refs: [...unit.refs, ...input.claim.evidenceRefs],
        tags: operationalContextTags({ spec: input.spec, unit: input.unit, extra: [unit.kind, unit.scope] }),
      }),
    )
  }

  for (const selfCheck of input.selfChecksRun) {
    if (hasConcreteAnswerLeakageSurface(selfCheck)) continue
    items.push(
      makeOperationalContextItem({
        runID: input.runID,
        unit: input.unit,
        attempt: input.attempt,
        kind: "validated_method",
        status: "confirmed",
        statement: `Before claiming success for ${input.unit.id}, run self-check: ${selfCheck}`,
        rationale: "Observed in a verified attempt and therefore safe to share across the current run.",
        refs: input.validatorResults.flatMap((item) => item.evidenceRefs),
        tags: operationalContextTags({ spec: input.spec, unit: input.unit, extra: ["self-check"] }),
      }),
    )
  }

  return items
}

function promoteOperationalContextFromFailure(input: {
  spec: LongTaskSpec
  runID: string
  unit: LongTaskWorkUnit
  attempt: number
  failure: LongTaskFailurePacket
  retryLesson: LongTaskRetryLesson
}): LongTaskOperationalContextItem[] {
  const isNoSignalFailure = isHardNoSignalSummary(input.failure.mismatchSummary)
  const items: LongTaskOperationalContextItem[] = [
    makeOperationalContextItem({
      runID: input.runID,
      unit: input.unit,
      attempt: input.attempt,
      kind: isNoSignalFailure ? "package_gap" : "blocking_issue",
      status: isNoSignalFailure ? "candidate" : "confirmed",
      statement: input.failure.mismatchSummary,
      rationale: isNoSignalFailure
        ? "Observed as runtime/no-signal instability; keep as candidate context and avoid hard routing conclusions."
        : "Observed as a validator-backed or execution-backed failure in the current run.",
      refs: input.failure.evidenceRefs,
      tags: operationalContextTags({ spec: input.spec, unit: input.unit, extra: [input.failure.failureType] }),
    }),
  ]

  for (const line of isNoSignalFailure ? [] : input.retryLesson.doNotRepeat) {
    items.push(
      makeOperationalContextItem({
        runID: input.runID,
        unit: input.unit,
        attempt: input.attempt,
        kind: "failed_path",
        status: "confirmed",
        statement: line,
        rationale: `Promoted from retry lesson after failure signature ${input.retryLesson.failureSignature}.`,
        refs: input.retryLesson.evidenceRefs,
        tags: operationalContextTags({ spec: input.spec, unit: input.unit, extra: ["do-not-repeat"] }),
      }),
    )
  }

  for (const line of input.retryLesson.nextAttemptStrategy) {
    items.push(
      makeOperationalContextItem({
        runID: input.runID,
        unit: input.unit,
        attempt: input.attempt,
        kind: "package_gap",
        status: "candidate",
        statement: line,
        rationale: "Candidate gap or fix strategy that should be visible to later units within the same run.",
        refs: input.retryLesson.evidenceRefs,
        tags: operationalContextTags({ spec: input.spec, unit: input.unit, extra: ["next-attempt"] }),
      }),
    )
  }

  return items
}

function shouldStopForBudgets(input: { progress: ReturnType<typeof deriveLongTaskProgressState>; spec: LongTaskSpec }) {
  const budgets = input.spec.budgets ?? DEFAULT_LONG_TASK_BUDGETS
  if (input.progress.totalUnitAttempts >= budgets.maxTotalUnitAttempts) return "exhausted_failure" as const
  if (input.progress.validatorCalls >= budgets.maxValidatorCalls) return "exhausted_failure" as const
  if (input.progress.noProgressCycles >= budgets.maxNoProgressCycles) return "stagnation_failure" as const
  return undefined
}

function normalizePlanningContextPath(inputPath: string) {
  return inputPath.replace(/\\/g, "/").toLowerCase()
}

function isCampaignRuntimePlanningContextPath(inputPath: string) {
  return normalizePlanningContextPath(inputPath).includes("/runtime-state/long-task-campaigns/")
}

function explicitCampaignPlanningContextPaths(spec: LongTaskSpec) {
  return uniqueStrings([
    spec.campaignPendingPackageRoot ?? "",
    spec.campaignExplorationTreePath ?? "",
    spec.campaignRoutingControlPath ?? "",
  ])
}

function explicitCampaignExecutionContextPaths(spec: LongTaskSpec) {
  return uniqueStrings([
    spec.campaignPendingPackageRoot ?? "",
    spec.campaignExplorationTreePath ?? "",
    spec.campaignWorkingMemoryPath ?? "",
    spec.campaignRoutingControlPath ?? "",
  ])
}

function selectLongTaskPlanningContext(spec: LongTaskSpec) {
  const initialContext = uniqueStrings(spec.initialExpertContextPaths ?? [])
  const staticContext = initialContext.filter((item) => !isCampaignRuntimePlanningContextPath(item))
  return uniqueStrings([...explicitCampaignPlanningContextPaths(spec), ...staticContext])
}

async function readRequiredRoutingRegions(spec: LongTaskSpec) {
  if (!spec.campaignRoutingControlPath) return [] as string[]
  try {
    const raw = JSON.parse(await readFile(spec.campaignRoutingControlPath, "utf8")) as Record<string, unknown>
    if (!Array.isArray(raw.requiredNextRegions)) return [] as string[]
    return raw.requiredNextRegions
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .filter((item) => item.toLowerCase().startsWith("dispatch-repair:"))
  } catch {
    return [] as string[]
  }
}

function slugifyRegionToken(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

function unitCoversRequiredRegion(unit: LongTaskWorkUnit, region: string) {
  const normalized = region.toLowerCase()
  const haystack = [
    unit.id,
    unit.title,
    unit.goal,
    unit.claim,
    unit.checkPlan,
    ...unit.inputs,
    ...unit.expectedArtifacts,
  ]
    .join(" ")
    .toLowerCase()
  return haystack.includes(normalized)
}

async function enforceRequiredRoutingCoverage(input: { spec: LongTaskSpec; graph: LongTaskWorkGraph }) {
  const requiredRegions = await readRequiredRoutingRegions(input.spec)
  if (!requiredRegions.length) return input.graph

  const next = {
    ...input.graph,
    units: [...input.graph.units],
  }
  const existingIDs = new Set(next.units.map((unit) => unit.id))
  const fallbackInputs = uniqueStrings([
    ...input.spec.materials.map((item) => item.path),
    ...(input.spec.initialExpertContextPaths ?? []),
    ...(input.spec.editablePaths ?? []),
  ])
  const fallbackArtifacts = uniqueStrings([
    ...(input.spec.targetPaths ?? []).map((item) => item.path),
    ...(input.spec.editablePaths ?? []),
  ])

  for (const region of requiredRegions) {
    const covered = next.units.some((unit) => unitCoversRequiredRegion(unit, region))
    if (covered) continue

    let baseID = `repair-${slugifyRegionToken(region) || "required-region"}`
    if (baseID.length > 50) baseID = baseID.slice(0, 50)
    let id = baseID
    let suffix = 1
    while (existingIDs.has(id)) {
      suffix += 1
      id = `${baseID}-${suffix}`
    }
    existingIDs.add(id)
    next.units.push(
      buildLongTaskWorkUnit({
        id,
        title: `Repair Required Region: ${short(region, 80)}`,
        goal: `Address required routing region and produce concrete repair evidence: ${region}`,
        inputs: fallbackInputs,
        dependsOn: [],
        expectedArtifacts: fallbackArtifacts.length > 0 ? fallbackArtifacts : [region],
        claim: `Required routing region '${region}' has explicit repair execution evidence.`,
        checkPlan: `Execute concrete repair steps for '${region}' and verify with local checks before returning the claim.`,
        validatorIDs: [],
        retryBudget: Math.min(input.spec.budgets?.maxAttemptsPerUnit ?? DEFAULT_LONG_TASK_BUDGETS.maxAttemptsPerUnit, 3),
      }),
    )
  }

  if (next.units.length !== input.graph.units.length) {
    return {
      ...next,
      plannerSummary: [
        input.graph.plannerSummary ?? "",
        `Auto-dispatch coverage injected for required routing regions: ${requiredRegions.join(" | ")}`,
      ]
        .filter(Boolean)
        .join(" "),
      updatedAt: nowISO(),
      revision: input.graph.revision + 1,
    }
  }

  return input.graph
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
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
  onPulse?: OpencodeTaskInput["onPulse"]
}) {
  const config = await loadConfig(input.configPathCwd)
  const selection = resolveModelSelection(config, "solve", input.spec.planning)
  const planningContextPaths = selectLongTaskPlanningContext(input.spec)
  const capabilityPaths = capabilityReferencePaths(input.spec)
  const capabilityFiles = capabilityAttachedFiles(input.spec)
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
    concurrencyScope: `long-task:${input.spec.id ?? input.spec.taskFamily ?? input.spec.title}`,
    referencePaths: [input.specPath, ...planningContextPaths, ...capabilityPaths],
    attachedFiles: capabilityFiles,
    permissionReadPaths: [input.specPath, ...planningContextPaths, ...capabilityPaths],
    // The planner/replanner is explicitly instructed to write graph_draft.json
    // under draftPaths.root; without this edit grant restricted mode can block
    // the draft and force a lower-quality response-text fallback graph.
    permissionEditPaths: [draftPaths.root],
    model: selection.model,
    agent: selection.agent,
    variant: selection.variant,
    runtimeScope: input.runtimeScope,
    onSpawn: input.onActivation,
    onPulse: input.onPulse,
    live: {
      stageDir: draftPaths.root,
      phase: input.phase === "plan" ? "long_task_plan" : "long_task_replan",
      taskKind: input.phase === "plan" ? "long_task_plan" : "long_task_replan",
      methodID: input.spec.reversePropagation?.recipeID,
    },
  })

  await writeTaskArtifacts(draftPaths.root, task, {
    phase: input.phase === "plan" ? "long_task_plan" : "long_task_replan",
    taskKind: input.phase === "plan" ? "long_task_plan" : "long_task_replan",
    methodID: input.spec.reversePropagation?.recipeID,
  })

  const signalHealth = analyzeTaskSignalHealth(task.result)
  const raw =
    (await extractJsonObjectFromPath(draftPaths.graphDraftPath)) ?? extractJsonObject(task.result.responseText)
  const fallbackReason = signalHealth.likelyInfrastructureFailure
    ? noSignalSummary({
        owner: input.phase === "plan" ? "planner" : "replanner",
        result: task.result,
      })
    : input.phase === "plan"
      ? "planner output was invalid"
      : "replanner output was invalid"
  const graph = normalizePlanningGraph(
    raw,
    input.spec,
    fallbackReason,
  )
  const graphWithRequiredCoverage = await enforceRequiredRoutingCoverage({
    spec: input.spec,
    graph,
  })
  await writeLongTaskWorkGraph(input.run, graphWithRequiredCoverage)
  return graphWithRequiredCoverage
}

async function executeWorkUnit(input: {
  cwd: string
  configPathCwd: string
  spec: LongTaskSpec
  run: ReturnType<typeof longTaskRunPaths>
  graph: LongTaskWorkGraph
  unit: LongTaskWorkUnit
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
  onPulse?: OpencodeTaskInput["onPulse"]
}) {
  const config = await loadConfig(input.configPathCwd)
  const selection = resolveModelSelection(config, "solve", input.spec.execution)
  const graph = bumpLongTaskWorkUnitAttempt(activateLongTaskWorkUnit(input.graph, input.unit.id), input.unit.id)
  const activeUnit = graph.units.find((item) => item.id === input.unit.id)!
  const attempt = activeUnit.attemptCount
  const attemptPaths = longTaskUnitAttemptPaths(input.run, activeUnit.id, attempt)

  const previousProgress = await readLongTaskProgressState(input.run)
  const progressBefore = deriveLongTaskProgressState({
    runID: previousProgress.runID,
    graph: input.graph,
    previous: previousProgress,
    status: previousProgress.status === "running" ? "running" : "bootstrapping",
  })
  await writeLongTaskProgressState(input.run, progressBefore)

  const bundle = await buildRetryInputBundle({
    paths: longTaskPaths(input.cwd),
    run: input.run,
    spec: input.spec,
    unitID: activeUnit.id,
  })
  await writeRetryInputBundle(attemptPaths.inputBundlePath, bundle)

  const validatorInputPaths = activeUnit.validatorIDs.map((validatorID) =>
    path.join(attemptPaths.validatorsRoot, validatorID, "validator_input.json"),
  )
  const formalPackageRoots = resolveLongTaskFormalPackageRoots(input.spec)
  const monitorCaseID = input.spec.id ?? input.spec.taskFamily ?? input.spec.title
  const prompt = buildLongTaskExecutionPrompt({
    spec: {
      ...input.spec,
      formalPackageRoots,
    },
    graph,
    unit: activeUnit,
    bundlePath: attemptPaths.inputBundlePath,
    validatorInputPaths,
  })
  const capabilityPaths = capabilityReferencePaths(input.spec)
  const capabilityFiles = capabilityAttachedFiles(input.spec)
  const editablePaths = resolveLongTaskEditablePaths(input.spec)
  const explicitCampaignContextPaths = explicitCampaignExecutionContextPaths(input.spec)
  const activateExecution = onceActivationCallback(async () => {
    const latestProgress = await readLongTaskProgressState(input.run)
    const runningProgress = deriveLongTaskProgressState({
      runID: latestProgress.runID,
      graph,
      previous: latestProgress,
      status: "running",
    })
    runningProgress.totalUnitAttempts = Math.max(
      latestProgress.totalUnitAttempts + 1,
      previousProgress.totalUnitAttempts + 1,
    )
    await writeLongTaskWorkGraph(input.run, graph)
    await writeLongTaskProgressState(input.run, runningProgress)
    await input.onActivation?.()
  })

  const task = await runOpencodeTask({
    cwd: input.cwd,
    config,
    title: `Long Task Execute ${activeUnit.id}`,
    prompt,
    concurrencyScope: `long-task:${input.spec.id ?? input.spec.taskFamily ?? input.spec.title}`,
    referencePaths: [
      ...input.spec.materials.map((item) => item.path),
      ...(input.spec.targetPaths ?? []).map((item) => item.path),
      ...(input.spec.initialExpertContextPaths ?? []),
      ...explicitCampaignContextPaths,
      attemptPaths.inputBundlePath,
      ...capabilityPaths,
      ...formalPackageRoots,
      ...input.spec.validators.filter((item) => item.type === "script").map((item) => item.path),
    ],
    attachedFiles: capabilityFiles,
    permissionReadPaths: [
      ...input.spec.materials.map((item) => item.path),
      ...(input.spec.targetPaths ?? []).map((item) => item.path),
      ...(input.spec.initialExpertContextPaths ?? []),
      ...explicitCampaignContextPaths,
      attemptPaths.inputBundlePath,
      ...capabilityPaths,
      ...formalPackageRoots,
      ...input.spec.validators.filter((item) => item.type === "script").map((item) => item.path),
    ],
    permissionEditPaths: editablePaths,
    model: selection.model,
    agent: selection.agent,
    variant: selection.variant,
    runtimeScope: input.runtimeScope,
    onSpawn: activateExecution,
    onPulse: input.onPulse,
    live: {
      stageDir: attemptPaths.executeDir,
      phase: "long_task_execute",
      taskKind: "long_task_execute",
      caseID: monitorCaseID,
      attempt,
      methodID: input.spec.reversePropagation?.recipeID,
    },
  })

  await writeTaskArtifacts(attemptPaths.executeDir, task, {
    phase: "long_task_execute",
    taskKind: "long_task_execute",
    caseID: monitorCaseID,
    attempt,
    methodID: input.spec.reversePropagation?.recipeID,
  })

  const signalHealth = analyzeTaskSignalHealth(task.result)
  const rawOutput = extractJsonObject(task.result.responseText)
  let normalized = normalizeExecutionOutput(rawOutput, activeUnit)
  if (signalHealth.likelyInfrastructureFailure) {
    const summary = noSignalSummary({
      owner: `Execution runtime for unit ${activeUnit.id}`,
      result: task.result,
    })
    normalized = {
      ...normalized,
      claimStatement: summary,
      claimedSuccess: false,
      blockers: uniqueStrings([...normalized.blockers, summary]),
      nextPriorityFix:
        normalized.nextPriorityFix ?? "Check runtime/provider health before retrying this unit execution.",
    }
  }
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

  const retryReflectionScratchUnits = makeRetryReflectionScratchUnits({
    runID: progressBefore.runID,
    unit: activeUnit,
    attempt,
    retryAck: normalized.retryAck,
    strategyChange: normalized.strategyChange,
    selfChecksRun: normalized.selfChecksRun,
  })
  for (const item of retryReflectionScratchUnits) await appendScratchUnit(input.run, item)
  await writeScratchDerivedViews(input.run)

  const validatorContracts = input.spec.validators.filter((validator) => activeUnit.validatorIDs.includes(validator.id))
  const validatorResults = []
  let progressMid = await readLongTaskProgressState(input.run)

  for (const validator of validatorContracts) {
    const validatorDir = path.join(attemptPaths.validatorsRoot, validator.id)

    // Pulse before validator to ensure heartbeat is fresh
    await input.onPulse?.()

    // Mark validator as active in progress state
    progressMid = {
      ...progressMid,
      activeValidator: {
        unitID: activeUnit.id,
        validatorID: validator.id,
        attempt,
        startedAt: nowISO(),
        validatorDir,
      },
    }
    await writeLongTaskProgressState(input.run, progressMid)

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
      runtimeScope: input.runtimeScope,
      onActivation: input.onActivation,
      onPulse: input.onPulse,
      payload: {
        runID: progressBefore.runID,
        unitID: activeUnit.id,
        attempt,
        goal: input.spec.goal,
        claim: activeUnit.claim,
        checkPlan: activeUnit.checkPlan,
        materials: input.spec.materials,
        targetPaths: input.spec.targetPaths ?? [],
        expectedArtifacts: activeUnit.expectedArtifacts,
        editablePaths,
        bundlePath: attemptPaths.inputBundlePath,
      },
    })

    // Pulse after validator to ensure heartbeat is updated
    await input.onPulse?.()

    // Clear activeValidator and increment counter
    validatorResults.push(result)
    await appendValidatorResult(input.run, result)
    progressMid = {
      ...progressMid,
      activeValidator: undefined,
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
    signalHealth,
  }
}

async function replanGraph(input: {
  cwd: string
  configPathCwd: string
  spec: LongTaskSpec
  run: ReturnType<typeof longTaskRunPaths>
  graph: LongTaskWorkGraph
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
  onPulse?: OpencodeTaskInput["onPulse"]
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
      runtimeScope: input.runtimeScope,
      onActivation: input.onActivation,
      onPulse: input.onPulse,
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
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
  onPulse?: OpencodeTaskInput["onPulse"]
}) {
  const completionSpec = await buildCompletionValidationSpec({ spec: input.spec, run: input.run })
  const completionValidatorIDs =
    input.graph.completionValidatorIDs.length > 0
      ? input.graph.completionValidatorIDs
      : completionSpec.disableCompletionValidators
        ? []
        : completionSpec.validators.filter((item) => item.required !== false).map((item) => item.id)
  const validatorContracts = completionSpec.validators.filter((validator) => completionValidatorIDs.includes(validator.id))
  const progress = await readLongTaskProgressState(input.run)
  const syntheticUnit: LongTaskWorkUnit = {
    ...syntheticCompletionUnit(completionSpec),
    validatorIDs: completionValidatorIDs,
  }
  const completionDir = path.join(input.run.root, "completion")
  const bundlePath = path.join(completionDir, "completion_bundle.json")
  const [claims, failures, scratchUnits, learningUnits, retryLessons, operationalContext, shadowMemory] =
    await Promise.all([
      readVerificationClaims(input.run),
      readFailurePackets(input.run),
      readScratchUnits(input.run),
      readLearningUnits(input.run),
      readRetryLessons(input.run),
      readOperationalContext(input.run),
      readShadowMemoryRecords(longTaskPaths(input.cwd)),
    ])
  await writeRetryInputBundle(bundlePath, {
    id: `completion-${randomUUID().slice(0, 8)}`,
    runID: progress.runID,
    unitID: syntheticUnit.id,
    createdAt: nowISO(),
    progressState: progress,
    currentUnit: syntheticUnit,
    recentClaims: claims.slice(-8),
    recentFailurePackets: failures.slice(-8),
    sameUnitRecentClaims: [],
    dependencyClaims: claims
      .filter((item) => input.graph.units.some((unit) => unit.id === item.unitID && unit.status === "verified"))
      .slice(-8),
    sameUnitRetryLessons: retryLessons.slice(-8),
    relevantScratchUnits: scratchUnits.slice(-12),
    relevantLearningUnits: learningUnits.slice(-12),
    relevantShadowMemory: shadowMemory.filter((record) => record.runID !== progress.runID).slice(-6),
    runGlobalOperationalContext: operationalContext.slice(0, 12),
    formalPackageRoots: resolveLongTaskFormalPackageRoots(completionSpec),
  })

  const config = await loadConfig(input.configPathCwd)
  const results = []
  let updatedProgress = progress
  const editablePaths = resolveLongTaskEditablePaths(completionSpec)
  for (const validator of validatorContracts) {
    const result = await runLongTaskValidator({
      cwd: input.cwd,
      config,
      contract: validator,
      spec: completionSpec,
      unit: syntheticUnit,
      runID: progress.runID,
      attempt: 1,
      validatorDir: path.join(completionDir, validator.id),
      bundlePath,
      runtimeScope: input.runtimeScope,
      onActivation: input.onActivation,
      onPulse: input.onPulse,
      payload: {
        runID: progress.runID,
        unitID: syntheticUnit.id,
        attempt: 1,
        goal: completionSpec.goal,
        claim: syntheticUnit.claim,
        checkPlan: syntheticUnit.checkPlan,
        materials: completionSpec.materials,
        targetPaths: completionSpec.targetPaths ?? [],
        expectedArtifacts: syntheticUnit.expectedArtifacts,
        editablePaths,
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
  const isHardVerified =
    summary.status === "graph_completed" &&
    summary.verificationSignal.completionGateMode === "required" &&
    summary.verificationSignal.completionGatePassed

  const existingFinalization = await readLongTaskFinalizationState(input.run)
  if (existingFinalization && existingFinalization.runID === summary.runID && existingFinalization.status === summary.status) {
    return {
      runID: summary.runID,
      runDir: input.run.root,
      status: summary.status,
      summaryPath: input.run.summaryJsonPath,
      summary,
    }
  }

  const config = await loadConfig(input.cwd)
  const paths = longTaskPaths(input.cwd)
  const archiveRecord = await appendArchiveRecord(paths, defaultArchiveRecord({ run: input.run, summary }))
  const shadowRecord = defaultShadowMemoryRecord({ run: input.run, summary, spec: input.spec })
  const persistedShadowRecord = await appendShadowMemoryRecord(paths, shadowRecord)
  const candidateAcceptance = await recordAcceptanceResult({
    cwd: input.cwd,
    config,
    sourceRunID: summary.runID,
    mode: "long",
    policyID: longTaskAcceptancePolicyID(input.spec),
    stageID: "candidate_guard",
    targetKind: "candidate_experience",
    targetID: `candidate-${summary.runID}`,
    passed: isHardVerified,
    outcome: isHardVerified ? "promote" : "hold",
    summary:
      isHardVerified
        ? "Long-task candidate satisfied completion validation and is maintainer-ready."
        : `Long-task candidate is being held after final status ${summary.status} (completion gate not fully verified).`,
    reason:
      isHardVerified
        ? "Completion validators and candidate preservation checks passed."
        : `Candidate acceptance held because completion verification signal was insufficient (status=${summary.status}, gate_mode=${summary.verificationSignal.completionGateMode}, gate_passed=${summary.verificationSignal.completionGatePassed}).`,
    reasons:
      isHardVerified
        ? []
        : [
            summary.summary || `Long-task final status: ${summary.status}.`,
            `Verification signal: gate_mode=${summary.verificationSignal.completionGateMode}, gate_passed=${summary.verificationSignal.completionGatePassed}.`,
          ],
    evidenceRefs: [
      input.run.summaryJsonPath,
      input.run.progressStatePath,
      input.run.workGraphPath,
      input.run.validatorResultsPath,
      input.run.operationalContextPath,
    ],
    details: {
      finalStatus: summary.status,
      verifiedUnits: summary.verifiedUnits,
      failedUnits: summary.failedUnits,
      blockedUnits: summary.blockedUnits,
      totalUnits: summary.totalUnits,
    },
    notes: [
      "This record captures candidate-level acceptance after the long-task run has already completed.",
      "It preserves long-task output for maintainer or governance without directly committing canonical experience.",
    ],
    mirrorPath: longTaskRunAcceptanceMirrorPath(input.run.root, "candidate_guard"),
  })
  const candidatePackage = await writeLongTaskCandidatePackage(paths, {
    id: `candidate-${summary.runID}`,
    status: isHardVerified ? "ready_for_maintainer" : "hold",
    mode: "long",
    runID: summary.runID,
    title: summary.title,
    goal: summary.goal,
    taskFamily: summary.taskFamily,
    domainTags: summary.domainTags,
    finalStatus: summary.status,
    summary: summary.summary,
    summaryPath: input.run.summaryJsonPath,
    taskPath: input.run.taskPath,
    progressStatePath: input.run.progressStatePath,
    workGraphPath: input.run.workGraphPath,
    failurePacketsPath: input.run.failurePacketsPath,
    learningUnitsPath: input.run.learningUnitsPath,
    retryLessonsPath: input.run.retryLessonsPath,
    operationalContextPath: input.run.operationalContextPath,
    shadowMemoryRecordID: persistedShadowRecord.id,
    notes:
      isHardVerified
        ? ["Verified-success long-task run preserved as a maintainer-ready candidate package."]
        : [
            "Run preserved for later maintainer review; keep as hold until higher-layer promotion decides otherwise.",
            `Verification signal did not satisfy hard completion gate (mode=${summary.verificationSignal.completionGateMode}, passed=${summary.verificationSignal.completionGatePassed}).`,
          ],
  })
  const maintenanceRequest = await writeMaintenanceRequest(maintenanceGatewayPaths(input.cwd, config), {
    id: `maint-req-long-${summary.runID}`,
    status: isHardVerified ? "ready_for_maintainer" : "hold",
    mode: "long",
    sourceRunID: summary.runID,
    title: summary.title,
    goal: summary.goal,
    taskFamily: summary.taskFamily,
    domainTags: summary.domainTags,
    summary: summary.summary,
    runtimeRoot: input.run.root,
    recipeID: input.spec.reversePropagation?.recipeID,
    maintenanceModuleID: input.spec.reversePropagation?.maintenanceModuleID,
    operationIDs: [],
    sessionReports: [],
    evidence: [
      {
        kind: "candidate_summary",
        path: input.run.summaryJsonPath,
        label: "long_task_summary",
        required: true,
      },
      {
        kind: "task_spec",
        path: input.run.taskPath,
        label: "long_task_spec",
        required: true,
      },
      {
        kind: "progress_state",
        path: input.run.progressStatePath,
        label: "long_task_progress_state",
        required: true,
      },
      {
        kind: "work_graph",
        path: input.run.workGraphPath,
        label: "long_task_work_graph",
      },
      {
        kind: "failure_packet",
        path: input.run.failurePacketsPath,
        label: "long_task_failure_packets",
      },
      {
        kind: "learning_unit",
        path: input.run.learningUnitsPath,
        label: "long_task_learning_units",
      },
      {
        kind: "retry_lesson",
        path: input.run.retryLessonsPath,
        label: "long_task_retry_lessons",
      },
      {
        kind: "candidate_summary",
        path: input.run.operationalContextPath,
        label: "long_task_operational_context",
      },
      {
        kind: "candidate_summary",
        path: input.run.operationalContextSummaryPath,
        label: "long_task_operational_context_summary",
      },
      {
        kind: "shadow_memory",
        path: paths.shadowMemoryRoot,
        label: persistedShadowRecord.id,
      },
      {
        kind: "candidate_summary",
        path: candidateAcceptance.path,
        label: "acceptance_framework_candidate_guard",
      },
    ],
    acceptancePolicyID: longTaskAcceptancePolicyID(input.spec),
    notes:
      isHardVerified
        ? ["Long-task request is maintainer-ready but still isolated from direct canonical commit."]
        : ["Long-task request is preserved as hold for later governance or maintainer review."],
    mirrorPath: path.join(input.run.root, "maintenance_request.json"),
  })
  await writeLongTaskFinalizationState(input.run, {
    runID: summary.runID,
    status: summary.status,
    completedAt: new Date().toISOString(),
    summaryPath: input.run.summaryJsonPath,
    archiveRecordID: archiveRecord.id,
    shadowMemoryRecordID: persistedShadowRecord.id,
    acceptanceRecordID: candidateAcceptance.record.id,
    acceptanceRecordPath: candidateAcceptance.path,
    candidateID: candidatePackage.candidate.id,
    candidatePath: candidatePackage.path,
    maintenanceRequestID: maintenanceRequest.request.id,
    maintenanceRequestPath: maintenanceRequest.path,
  })

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
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
  onPulse?: OpencodeTaskInput["onPulse"]
}) {
  try {
    while (true) {
      let graph = await readLongTaskWorkGraph(input.run)
      let progress = await readLongTaskProgressState(input.run)

      if (
        progress.status === "graph_completed" ||
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
            runtimeScope: input.runtimeScope,
            onActivation: input.onActivation,
            onPulse: input.onPulse,
          })
          const completionPassed = completionResults.every((result) => result.passed)
          if (completionPassed) {
            const completionSummary =
              completionResults.length > 0
                ? "All work units completed and all required completion validators passed."
                : "All work units completed. Per-round completion validation is disabled or deferred."
            return finalizeLongTaskRun({
              cwd: input.cwd,
              run: input.run,
              spec: input.spec,
              status: "graph_completed",
              summaryText: completionSummary,
            })
          }

          const failure = createFailurePacket({
            runID: progress.runID,
            unitID: "__completion__",
            attempt: 1,
            claimedSuccess: true,
            verificationPassed: false,
            mismatchSummary:
              completionResults.map((item) => item.summary).join(" | ") || "Final completion validation failed.",
            suspectedCauses: completionResults.flatMap((item) => item.details).slice(0, 6),
            evidenceRefs: completionResults.flatMap((item) => item.evidenceRefs),
            retryLevel: "subgraph_retry",
            failureType: "validator_failed",
          })
          await appendFailurePacket(input.run, failure)
          await upsertOperationalContext(input.run, [
            makeOperationalContextItem({
              runID: progress.runID,
              unit: syntheticCompletionUnit(input.spec),
              attempt: 1,
              kind: "blocking_issue",
              status: "confirmed",
              statement: failure.mismatchSummary,
              rationale: "Completion validation failed after all current work units were marked verified.",
              refs: failure.evidenceRefs,
              tags: uniqueStrings([
                "__completion__",
                ...(input.spec.taskFamily ? [input.spec.taskFamily] : []),
                ...(input.spec.domainTags ?? []),
                "completion",
              ]),
            }),
          ])
          await appendRetryJournalEntry(input.run, {
            id: `retry-${randomUUID().slice(0, 8)}`,
            runID: progress.runID,
            createdAt: nowISO(),
            level: "subgraph_retry",
            toUnitID: "__completion__",
            reason: failure.mismatchSummary,
          })

          if (
            (progress.graphReplanCount ?? 0) <
            (input.spec.budgets?.maxGraphReplans ?? DEFAULT_LONG_TASK_BUDGETS.maxGraphReplans)
          ) {
            graph = await replanGraph({
              cwd: input.cwd,
              configPathCwd: input.configPathCwd,
              spec: input.spec,
              run: input.run,
              graph,
              runtimeScope: input.runtimeScope,
              onActivation: input.onActivation,
              onPulse: input.onPulse,
            })
            const postReplanProgress = await readLongTaskProgressState(input.run)
            progress = deriveLongTaskProgressState({
              runID: postReplanProgress.runID,
              graph,
              previous: postReplanProgress,
              status: postReplanProgress.status === "running" ? "running" : "bootstrapping",
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

        if (
          (progress.graphReplanCount ?? 0) <
          (input.spec.budgets?.maxGraphReplans ?? DEFAULT_LONG_TASK_BUDGETS.maxGraphReplans)
        ) {
          graph = await replanGraph({
            cwd: input.cwd,
            configPathCwd: input.configPathCwd,
            spec: input.spec,
            run: input.run,
            graph,
            runtimeScope: input.runtimeScope,
            onActivation: input.onActivation,
            onPulse: input.onPulse,
          })
          progress = deriveLongTaskProgressState({
            runID: progress.runID,
            graph,
            previous: progress,
            status: progress.status === "running" ? "running" : "bootstrapping",
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
        runtimeScope: input.runtimeScope,
        onActivation: input.onActivation,
        onPulse: input.onPulse,
      })

      graph = execution.graph
      progress = await readLongTaskProgressState(input.run)
      progress.lastClaimID = execution.claim.id

      const executionSucceeded = execution.claim.claimedSuccess && execution.allValidatorsPassed
      const localAcceptanceEvidenceRefs = [
        path.join(execution.attemptPaths.executeDir, "response.txt"),
        ...execution.validatorResults.flatMap((item) => item.evidenceRefs),
      ]
      await recordAcceptanceResult({
        cwd: input.cwd,
        config: await loadConfig(input.cwd),
        sourceRunID: progress.runID,
        mode: "long",
        policyID: longTaskAcceptancePolicyID(input.spec),
        stageID: "local_guard",
        targetKind: "work_unit",
        targetID: longTaskLocalAcceptanceTargetID(execution.activeUnit, execution.attempt),
        passed: executionSucceeded,
        outcome: executionSucceeded ? "observe" : "retry",
        summary: executionSucceeded
          ? `Work unit ${execution.activeUnit.id} satisfied its execution and validator contract.`
          : buildWorkUnitFailureSummary({
              claim: execution.claim,
              validatorResults: execution.validatorResults,
            }),
        reason: executionSucceeded
          ? "Work-unit local acceptance passed."
          : (execution.validatorResults.find((item) => !item.passed)?.summary ??
            execution.claim.blockers[0] ??
            "Work-unit local acceptance failed."),
        reasons: executionSucceeded
          ? []
          : uniqueStrings([
              ...execution.claim.blockers,
              ...execution.validatorResults.filter((item) => !item.passed).map((item) => item.summary),
              ...execution.validatorResults.flatMap((item) => item.details),
            ]).slice(0, 8),
        evidenceRefs: localAcceptanceEvidenceRefs,
        details: {
          unitID: execution.activeUnit.id,
          attempt: execution.attempt,
          claimedSuccess: execution.claim.claimedSuccess,
          validatorsPassed: execution.allValidatorsPassed,
          validatorResults: execution.validatorResults.map((item) => ({
            validatorID: item.validatorID,
            passed: item.passed,
            summary: item.summary,
          })),
        },
        notes: [
          "This record captures local acceptance at the work-unit boundary.",
          "It does not imply candidate promotion or canonical acceptance.",
        ],
        mirrorPath: longTaskAttemptAcceptanceMirrorPath(execution.attemptPaths.root, "local_guard"),
      })

      if (executionSucceeded) {
        await upsertOperationalContext(
          input.run,
          promoteOperationalContextFromVerifiedUnit({
            spec: input.spec,
            runID: progress.runID,
            unit: execution.activeUnit,
            attempt: execution.attempt,
            claim: execution.claim,
            learningUnits: execution.normalized.learningUnits.length
              ? makeLearningUnits({
                  runID: progress.runID,
                  unit: execution.activeUnit,
                  rawUnits: execution.normalized.learningUnits,
                })
              : [],
            validatorResults: execution.validatorResults,
            selfChecksRun: execution.normalized.selfChecksRun,
          }),
        )
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
        verificationPassed: execution.allValidatorsPassed,
        mismatchSummary: buildWorkUnitFailureSummary({
          claim: execution.claim,
          validatorResults: execution.validatorResults,
        }),
        suspectedCauses: [
          ...execution.claim.blockers,
          ...execution.validatorResults.flatMap((item) => item.details),
        ].slice(0, 6),
        nextPriorityFix: execution.claim.nextPriorityFix ?? execution.normalized.nextPriorityFix,
        evidenceRefs: localAcceptanceEvidenceRefs,
        retryLevel: "work_unit_retry",
        failureType: execution.claim.claimedSuccess ? "validator_failed" : "invalid_execution_output",
      })
      await appendFailurePacket(input.run, failure)
      const retryLesson = createRetryLesson({
        runID: progress.runID,
        unit: execution.activeUnit,
        attempt: execution.attempt,
        claim: execution.claim,
        failure,
        strategyChange: execution.normalized.strategyChange,
        selfChecksRun: execution.normalized.selfChecksRun,
      })
      await appendRetryLesson(input.run, retryLesson)
      await upsertOperationalContext(
        input.run,
        promoteOperationalContextFromFailure({
          spec: input.spec,
          runID: progress.runID,
          unit: execution.activeUnit,
          attempt: execution.attempt,
          failure,
          retryLesson,
        }),
      )
      await appendRetryJournalEntry(input.run, {
        id: `retry-${randomUUID().slice(0, 8)}`,
        runID: progress.runID,
        createdAt: nowISO(),
        level: "work_unit_retry",
        fromUnitID: execution.activeUnit.id,
        toUnitID: execution.activeUnit.id,
        reason: failure.mismatchSummary,
      })

      const recentUnitFailures = (await readFailurePackets(input.run)).filter(
        (packet) => packet.unitID === execution.activeUnit.id,
      )
      if (hasConsecutiveNoSignalFailures(recentUnitFailures, NO_SIGNAL_BLOCK_FAILURE_THRESHOLD)) {
        return finalizeLongTaskRun({
          cwd: input.cwd,
          run: input.run,
          spec: input.spec,
          status: "blocked_failure",
          summaryText: `Repeated no-structured-signal execution failures (${NO_SIGNAL_BLOCK_FAILURE_THRESHOLD} consecutive) detected for unit ${execution.activeUnit.id}; stopped to avoid retry loop.`,
        })
      }

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

      if (
        (progress.graphReplanCount ?? 0) <
        (input.spec.budgets?.maxGraphReplans ?? DEFAULT_LONG_TASK_BUDGETS.maxGraphReplans)
      ) {
        graph = await replanGraph({
          cwd: input.cwd,
          configPathCwd: input.configPathCwd,
            spec: input.spec,
            run: input.run,
            graph,
            runtimeScope: input.runtimeScope,
            onActivation: input.onActivation,
            onPulse: input.onPulse,
          })
        const postReplanProgress = await readLongTaskProgressState(input.run)
        progress = deriveLongTaskProgressState({
          runID: postReplanProgress.runID,
          graph,
          previous: postReplanProgress,
          status: postReplanProgress.status === "running" ? "running" : "bootstrapping",
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return finalizeLongTaskRun({
      cwd: input.cwd,
      run: input.run,
      spec: input.spec,
      status: "blocked_failure",
      summaryText: `Long-task aborted unexpectedly: ${short(message, 240)}`,
    })
  } finally {
    await cleanupRuntimeScopeWithRetry(input.runtimeScope)
  }
}

export async function runLongTask(input: {
  cwd: string
  specPath: string
  runtimeScope?: string
  onRuntimeActivated?: OpencodeTaskInput["onSpawn"]
  onRuntimePulse?: OpencodeTaskInput["onPulse"]
}) {
  let runtimeScope = input.runtimeScope
  try {
    await loadConfig(input.cwd)
    const { spec, specPath } = await loadLongTaskSpec(input.specPath)
    const runID = createLongTaskRunID(spec.title)
    runtimeScope = runtimeScope ?? longTaskRunRuntimeScope(runID)
    const runtimeSpec = isolateLongTaskRuntimePaths({
      spec,
      sourceSpecPath: specPath,
      runtimeRoot: path.join(longTaskRunPaths(longTaskPaths(input.cwd), runID).root, "task-workspace"),
    })
    const progress = createInitialLongTaskProgressState(runID)
    const placeholderGraph = createLongTaskWorkGraph({
      plannerSummary: "Long-task run initialized before graph bootstrap.",
      completionValidatorIDs: runtimeSpec.disableCompletionValidators
        ? []
        : runtimeSpec.validators.filter((item) => item.required !== false).map((item) => item.id),
      units: [],
      revision: 0,
    })

    const initialized = await initializeLongTaskRun({
      cwd: input.cwd,
      spec: runtimeSpec,
      workGraph: placeholderGraph,
      progressState: progress,
    })
    const activateRun = onceActivationCallback(async () => {
      await updateLongTaskProgressStatus(initialized.run, "running")
      await input.onRuntimeActivated?.()
    })
    const pulseRun = async () => {
      await pulseLongTaskProgress(initialized.run)
      await input.onRuntimePulse?.()
    }

    const graph = runtimeSpec.initialGraph
      ? normalizePlanningGraph(
          runtimeSpec.initialGraph as unknown as Record<string, unknown>,
          runtimeSpec,
          "spec.initialGraph was invalid",
        )
      : await runPlanningSession({
          cwd: input.cwd,
          configPathCwd: input.cwd,
          spec: runtimeSpec,
          specPath,
          run: initialized.run,
          phase: "plan",
          runtimeScope,
          onActivation: activateRun,
          onPulse: pulseRun,
        })

    const currentProgress = await readLongTaskProgressState(initialized.run)
    const runningProgress = deriveLongTaskProgressState({
      runID: initialized.runID,
      graph,
      previous: currentProgress,
      status: currentProgress.status === "running" ? "running" : "bootstrapping",
    })
    await writeLongTaskWorkGraph(initialized.run, graph)
    await writeLongTaskProgressState(initialized.run, runningProgress)

    return continueLongTaskLoop({
      cwd: input.cwd,
      configPathCwd: input.cwd,
      spec: runtimeSpec,
      run: initialized.run,
      runtimeScope,
      onActivation: activateRun,
      onPulse: pulseRun,
    })
  } finally {
    await cleanupRuntimeScopeWithRetry(runtimeScope)
  }
}

export async function resumeLongTask(input: {
  cwd: string
  runID: string
  runtimeScope?: string
  onRuntimeActivated?: OpencodeTaskInput["onSpawn"]
  onRuntimePulse?: OpencodeTaskInput["onPulse"]
}) {
  const resolved = resolveExistingLongTaskRun(input.cwd, input.runID)
  const spec = await readLongTaskSpec(resolved.run)
  const runtimeScope = input.runtimeScope ?? longTaskRunRuntimeScope(input.runID)
  const currentProgress = await readLongTaskProgressState(resolved.run)
  await writeLongTaskProgressState(resolved.run, {
    ...currentProgress,
    ownerPID: undefined,
    ownerCommandHint: undefined,
    ownerCreationTick: undefined,
  })
  const activateRun = onceActivationCallback(async () => {
    await updateLongTaskProgressStatus(resolved.run, "running")
    await input.onRuntimeActivated?.()
  })
  const pulseRun = async () => {
    await pulseLongTaskProgress(resolved.run)
    await input.onRuntimePulse?.()
  }
  await pulseRun()
  return continueLongTaskLoop({
    cwd: input.cwd,
    configPathCwd: input.cwd,
    spec,
    run: resolved.run,
    runtimeScope,
    onActivation: activateRun,
    onPulse: pulseRun,
  })
}
