import type {
  LongTaskProgressState,
  LongTaskWorkGraph,
  LongTaskWorkUnit,
  LongTaskWorkUnitStatus,
} from "./contract"

function nowISO() {
  return new Date().toISOString()
}

function unique<T>(items: T[]) {
  return [...new Set(items)]
}

function isTerminalStatus(status: LongTaskWorkUnitStatus) {
  return status === "verified" || status === "failed" || status === "blocked"
}

export function createLongTaskWorkGraph(input: {
  units: LongTaskWorkUnit[]
  completionValidatorIDs: string[]
  plannerSummary?: string
  revision?: number
}): LongTaskWorkGraph {
  return {
    createdAt: nowISO(),
    updatedAt: nowISO(),
    revision: input.revision ?? 1,
    plannerSummary: input.plannerSummary,
    completionValidatorIDs: unique(input.completionValidatorIDs),
    units: [...input.units],
  }
}

export function findLongTaskWorkUnit(graph: LongTaskWorkGraph, unitID: string) {
  return graph.units.find((item) => item.id === unitID)
}

export function replaceLongTaskWorkUnit(graph: LongTaskWorkGraph, nextUnit: LongTaskWorkUnit) {
  return {
    ...graph,
    updatedAt: nowISO(),
    units: graph.units.map((item) => (item.id === nextUnit.id ? nextUnit : item)),
  }
}

export function activateLongTaskWorkUnit(graph: LongTaskWorkGraph, unitID: string) {
  const unit = findLongTaskWorkUnit(graph, unitID)
  if (!unit) throw new Error(`Long-task work unit not found: ${unitID}`)
  return replaceLongTaskWorkUnit(graph, { ...unit, status: "active" })
}

export function markLongTaskWorkUnitVerified(graph: LongTaskWorkGraph, unitID: string, claimID?: string) {
  const unit = findLongTaskWorkUnit(graph, unitID)
  if (!unit) throw new Error(`Long-task work unit not found: ${unitID}`)
  return replaceLongTaskWorkUnit(graph, {
    ...unit,
    status: "verified",
    lastClaimID: claimID ?? unit.lastClaimID,
  })
}

export function markLongTaskWorkUnitFailed(graph: LongTaskWorkGraph, unitID: string, failurePacketID?: string) {
  const unit = findLongTaskWorkUnit(graph, unitID)
  if (!unit) throw new Error(`Long-task work unit not found: ${unitID}`)
  return replaceLongTaskWorkUnit(graph, {
    ...unit,
    status: "failed",
    lastFailurePacketID: failurePacketID ?? unit.lastFailurePacketID,
  })
}

export function bumpLongTaskWorkUnitAttempt(graph: LongTaskWorkGraph, unitID: string) {
  const unit = findLongTaskWorkUnit(graph, unitID)
  if (!unit) throw new Error(`Long-task work unit not found: ${unitID}`)
  return replaceLongTaskWorkUnit(graph, {
    ...unit,
    status: "active",
    attemptCount: unit.attemptCount + 1,
    lastAttemptAt: nowISO(),
  })
}

export function resetRemainingUnitsForReplan(graph: LongTaskWorkGraph) {
  return {
    ...graph,
    updatedAt: nowISO(),
    units: graph.units.map((unit) =>
      unit.status === "verified"
        ? unit
        : {
            ...unit,
            status: unit.status === "blocked" ? "blocked" : "planned",
          },
    ),
  }
}

export function mergeReplannedGraph(input: {
  current: LongTaskWorkGraph
  replannedUnits: LongTaskWorkUnit[]
  plannerSummary?: string
  completionValidatorIDs?: string[]
}) {
  const verifiedUnits = input.current.units.filter((unit) => unit.status === "verified")
  const preservedFailed = input.current.units.filter((unit) => unit.status === "failed")
  const nextUnits = [...verifiedUnits, ...preservedFailed, ...input.replannedUnits]
  const seen = new Set<string>()
  const deduped: LongTaskWorkUnit[] = []

  for (const unit of nextUnits) {
    if (seen.has(unit.id)) continue
    seen.add(unit.id)
    deduped.push(unit)
  }

  return {
    ...input.current,
    updatedAt: nowISO(),
    revision: input.current.revision + 1,
    plannerSummary: input.plannerSummary ?? input.current.plannerSummary,
    completionValidatorIDs: unique(input.completionValidatorIDs ?? input.current.completionValidatorIDs),
    units: deduped,
  } satisfies LongTaskWorkGraph
}

export function getReadyLongTaskUnits(graph: LongTaskWorkGraph) {
  const verified = new Set(graph.units.filter((unit) => unit.status === "verified").map((unit) => unit.id))
  return graph.units.filter(
    (unit) =>
      !isTerminalStatus(unit.status) &&
      unit.dependsOn.every((dependency) => verified.has(dependency)),
  )
}

export function selectNextLongTaskUnit(graph: LongTaskWorkGraph) {
  const active = graph.units.find((unit) => unit.status === "active")
  if (active) return active
  const ready = getReadyLongTaskUnits(graph)
  return ready.find((unit) => unit.status === "planned") ?? ready[0]
}

export function deriveLongTaskProgressState(input: {
  runID: string
  graph: LongTaskWorkGraph
  previous?: LongTaskProgressState
  status?: LongTaskProgressState["status"]
  finalSummary?: string
}) {
  const { runID, graph, previous } = input
  const activeUnit = graph.units.find((item) => item.status === "active")
  const completedUnitIDs = graph.units.filter((item) => item.status === "verified").map((item) => item.id)
  const blockedUnitIDs = graph.units.filter((item) => item.status === "blocked").map((item) => item.id)
  const failedUnitIDs = graph.units.filter((item) => item.status === "failed").map((item) => item.id)
  const nextPriorityUnitIDs = getReadyLongTaskUnits(graph).map((item) => item.id).slice(0, 5)

  return {
    runID,
    createdAt: previous?.createdAt ?? nowISO(),
    updatedAt: nowISO(),
    status: input.status ?? previous?.status ?? "running",
    graphRevision: graph.revision,
    activeUnitID: activeUnit?.id,
    activeAttempt: activeUnit?.attemptCount,
    completedUnitIDs,
    blockedUnitIDs,
    failedUnitIDs,
    nextPriorityUnitIDs,
    lastClaimID: previous?.lastClaimID,
    lastFailurePacketID: previous?.lastFailurePacketID,
    totalUnitAttempts: previous?.totalUnitAttempts ?? 0,
    validatorCalls: previous?.validatorCalls ?? 0,
    graphReplanCount: previous?.graphReplanCount ?? 0,
    noProgressCycles: previous?.noProgressCycles ?? 0,
    lastProgressAt: previous?.lastProgressAt,
    finalSummary: input.finalSummary ?? previous?.finalSummary,
  } satisfies LongTaskProgressState
}

