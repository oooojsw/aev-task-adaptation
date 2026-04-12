import path from "node:path"
import { pathExists, readJsonFile } from "../fs"
import type { LongTaskRunPaths, LongTaskPaths } from "./repository"
import type {
  LongTaskCapabilityContract,
  LongTaskProgressState,
  LongTaskSpec,
  LongTaskValidatorContract,
  LongTaskWorkGraph,
} from "./contract"

export interface LongTaskValidationReport {
  errors: string[]
}

function hasDuplicates(values: string[]) {
  return new Set(values).size !== values.length
}

function normalizeStringArray(values: string[] | undefined) {
  return (values ?? []).filter((value) => value.trim().length > 0)
}

async function validateCapabilityContract(errors: string[], capability: LongTaskCapabilityContract) {
  if (!capability.id.trim()) {
    errors.push("Long-task capability has an empty id.")
  }
  if (!capability.title.trim()) {
    errors.push(`Long-task capability ${capability.id || "(unknown)"} has an empty title.`)
  }
  if (!capability.description.trim()) {
    errors.push(`Long-task capability ${capability.id || "(unknown)"} has an empty description.`)
  }

  for (const ref of [...normalizeStringArray(capability.referencePaths), ...normalizeStringArray(capability.attachedFiles)]) {
    if (!(await pathExists(ref))) {
      errors.push(`Long-task capability ${capability.id} references a missing path: ${ref}`)
    }
  }
}

async function validateValidatorContract(errors: string[], validator: LongTaskValidatorContract) {
  if (!validator.id.trim()) {
    errors.push("Long-task validator has an empty id.")
  }
  if (!validator.title.trim()) {
    errors.push(`Long-task validator ${validator.id || "(unknown)"} has an empty title.`)
  }

  if (validator.type === "script") {
    if (!(await pathExists(validator.path))) {
      errors.push(`Long-task validator ${validator.id} references a missing script: ${validator.path}`)
    }
    if (validator.cwd && !(await pathExists(validator.cwd))) {
      errors.push(`Long-task validator ${validator.id} references a missing cwd: ${validator.cwd}`)
    }
    return
  }

  if (!validator.prompt.trim()) {
    errors.push(`Long-task validator ${validator.id} has an empty prompt.`)
  }
  for (const ref of [...normalizeStringArray(validator.referencePaths), ...normalizeStringArray(validator.attachedFiles)]) {
    if (!(await pathExists(ref))) {
      errors.push(`Long-task validator ${validator.id} references a missing path: ${ref}`)
    }
  }
}

export async function validateLongTaskSpec(spec: LongTaskSpec): Promise<LongTaskValidationReport> {
  const errors: string[] = []

  if (!spec.title.trim()) errors.push("Long-task spec title cannot be empty.")
  if (!spec.goal.trim()) errors.push("Long-task spec goal cannot be empty.")
  if (!spec.materials.length) errors.push("Long-task spec must include at least one material.")
  if (!spec.validators.length) errors.push("Long-task spec must include at least one validator.")

  if (hasDuplicates(spec.validators.map((validator) => validator.id))) {
    errors.push("Long-task spec has duplicate validator ids.")
  }
  if (hasDuplicates((spec.capabilities ?? []).map((capability) => capability.id))) {
    errors.push("Long-task spec has duplicate capability ids.")
  }

  for (const ref of [
    ...spec.materials.map((item) => item.path),
    ...(spec.initialExpertContextPaths ?? []),
  ]) {
    if (!(await pathExists(ref))) {
      errors.push(`Long-task spec references a missing path: ${ref}`)
    }
  }

  for (const ref of [...(spec.targetPaths ?? []).map((item) => item.path), ...(spec.editablePaths ?? [])]) {
    if (!ref.trim()) {
      errors.push("Long-task spec contains an empty target/editable path.")
    }
  }

  for (const capability of spec.capabilities ?? []) {
    await validateCapabilityContract(errors, capability)
  }

  for (const validator of spec.validators) {
    await validateValidatorContract(errors, validator)
  }

  if (spec.shadowMemoryScope) {
    if (!spec.shadowMemoryScope.namespace.trim()) {
      errors.push("Long-task shadowMemoryScope namespace cannot be empty.")
    }
    if (
      spec.shadowMemoryScope.retrievalMode !== "isolated" &&
      spec.shadowMemoryScope.retrievalMode !== "related_only" &&
      spec.shadowMemoryScope.retrievalMode !== "manual"
    ) {
      errors.push(`Long-task shadowMemoryScope retrievalMode is invalid: ${spec.shadowMemoryScope.retrievalMode}`)
    }
  }

  return { errors }
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

  const spec = await readJsonFile<LongTaskSpec>(run.taskPath)
  const graph = await readJsonFile<LongTaskWorkGraph>(run.workGraphPath)
  const progress = await readJsonFile<LongTaskProgressState>(run.progressStatePath)
  errors.push(...(await validateLongTaskSpec(spec)).errors)

  const unitIDs = new Set(graph.units.map((item) => item.id))
  const validatorIDs = new Set(spec.validators.map((item) => item.id))

  if (graph.revision < 0) {
    errors.push("Long-task work graph revision cannot be negative.")
  }
  if (!graph.completionValidatorIDs.length) {
    errors.push("Long-task work graph must declare completionValidatorIDs.")
  }
  for (const validatorID of graph.completionValidatorIDs) {
    if (!validatorIDs.has(validatorID)) {
      errors.push(`Long-task work graph references an unknown completion validator: ${validatorID}`)
    }
  }
  if (progress.runID !== path.basename(run.root)) {
    errors.push(`Long-task progress state runID does not match run directory: ${progress.runID}`)
  }
  if (progress.graphRevision !== graph.revision) {
    errors.push(
      `Long-task progress graph revision ${progress.graphRevision} does not match work graph revision ${graph.revision}.`,
    )
  }
  if (progress.activeUnitID && !progress.activeAttempt) {
    errors.push("Long-task progress state has an activeUnitID but no activeAttempt.")
  }

  for (const unit of graph.units) {
    if (!unit.id.trim()) errors.push("Long-task work unit has an empty id.")
    if (!unit.goal.trim()) errors.push(`Long-task work unit ${unit.id} has an empty goal.`)
    if (!unit.claim.trim()) errors.push(`Long-task work unit ${unit.id} has an empty claim.`)
    if (!unit.checkPlan.trim()) errors.push(`Long-task work unit ${unit.id} has an empty checkPlan.`)
    if (unit.retryBudget <= 0) errors.push(`Long-task work unit ${unit.id} has a non-positive retryBudget.`)
    if (unit.attemptCount < 0) errors.push(`Long-task work unit ${unit.id} has a negative attemptCount.`)
    for (const dependency of unit.dependsOn) {
      if (!unitIDs.has(dependency)) {
        errors.push(`Long-task work unit ${unit.id} depends on unknown unit: ${dependency}`)
      }
    }
    for (const validatorID of unit.validatorIDs) {
      if (!validatorIDs.has(validatorID)) {
        errors.push(`Long-task work unit ${unit.id} references an unknown validator: ${validatorID}`)
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
