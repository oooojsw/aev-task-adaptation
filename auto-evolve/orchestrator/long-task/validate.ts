import path from "node:path"
import { pathExists, readJsonFile } from "../fs"
import type { LongTaskRunPaths, LongTaskPaths } from "./repository"
import type { LongTaskProgressState, LongTaskWorkGraph } from "./contract"

export interface LongTaskValidationReport {
  errors: string[]
}

export async function validateLongTaskLayout(paths: LongTaskPaths): Promise<LongTaskValidationReport> {
  const errors: string[] = []
  for (const target of [paths.root, paths.runsRoot, paths.archiveRoot, paths.shadowMemoryRoot, paths.candidatesRoot]) {
    if (!(await pathExists(target))) {
      errors.push(`Long-task directory is missing: ${target}`)
    }
  }

  for (const target of [
    path.join(paths.archiveRoot, "index.jsonl"),
    path.join(paths.shadowMemoryRoot, "index.jsonl"),
  ]) {
    if (!(await pathExists(target))) {
      errors.push(`Long-task index file is missing: ${target}`)
    }
  }

  return { errors }
}

export async function validateLongTaskRun(run: LongTaskRunPaths): Promise<LongTaskValidationReport> {
  const errors: string[] = []
  for (const target of [
    run.root,
    run.taskPath,
    run.workGraphPath,
    run.progressStatePath,
    run.claimsPath,
    run.validatorResultsPath,
    run.failurePacketsPath,
    run.scratchUnitsPath,
    run.scratchIndexPath,
    run.scratchSummaryPath,
    run.learningUnitsPath,
    run.retryJournalPath,
    run.summaryJsonPath,
    run.summaryMdPath,
    run.bundlesRoot,
    run.unitsRoot,
    run.planRoot,
    run.replanRoot,
  ]) {
    if (!(await pathExists(target))) {
      errors.push(`Long-task run artifact is missing: ${target}`)
    }
  }

  if (errors.length > 0) {
    return { errors }
  }

  const graph = await readJsonFile<LongTaskWorkGraph>(run.workGraphPath)
  const progress = await readJsonFile<LongTaskProgressState>(run.progressStatePath)
  const unitIDs = new Set(graph.units.map((item) => item.id))

  if (graph.revision < 0) {
    errors.push("Long-task work graph revision cannot be negative.")
  }
  if (!graph.completionValidatorIDs.length) {
    errors.push("Long-task work graph must declare completionValidatorIDs.")
  }

  for (const unit of graph.units) {
    if (!unit.id.trim()) errors.push("Long-task work unit has an empty id.")
    if (!unit.goal.trim()) errors.push(`Long-task work unit ${unit.id} has an empty goal.`)
    if (!unit.claim.trim()) errors.push(`Long-task work unit ${unit.id} has an empty claim.`)
    if (!unit.validatorIDs.length) {
      errors.push(`Long-task work unit ${unit.id} must declare at least one validator.`)
    }
    for (const dependency of unit.dependsOn) {
      if (!unitIDs.has(dependency)) {
        errors.push(`Long-task work unit ${unit.id} depends on unknown unit: ${dependency}`)
      }
    }
  }

  for (const unitID of [
    ...progress.completedUnitIDs,
    ...progress.blockedUnitIDs,
    ...progress.failedUnitIDs,
    ...progress.nextPriorityUnitIDs,
    ...(progress.activeUnitID ? [progress.activeUnitID] : []),
  ]) {
    if (!unitIDs.has(unitID)) {
      errors.push(`Long-task progress state references unknown unit: ${unitID}`)
    }
  }

  return { errors }
}

