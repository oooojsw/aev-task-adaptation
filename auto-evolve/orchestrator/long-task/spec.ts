import path from "node:path"
import type {
  LongTaskCapabilityContract,
  LongTaskBudgets,
  LongTaskInitialGraphDraft,
  LongTaskPathRef,
  LongTaskSpec,
  LongTaskValidatorContract,
} from "./contract"
import { DEFAULT_LONG_TASK_BUDGETS } from "./contract"
import { pathExists, readJsonFile } from "../fs"

export interface LoadLongTaskSpecOptions {
  allowMissingInitialExpertContextPaths?: boolean
}

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function normalizeStringArray(input: unknown) {
  if (!Array.isArray(input)) return []
  return input.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function normalizeMaybeString(input: unknown) {
  return typeof input === "string" && input.trim().length > 0 ? input.trim() : undefined
}

function normalizePathRef(raw: unknown): LongTaskPathRef | undefined {
  if (typeof raw === "string" && raw.trim()) {
    return { path: raw }
  }
  if (!isObject(raw)) return undefined
  if (typeof raw.path !== "string" || !raw.path.trim()) return undefined
  return {
    path: raw.path,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label : undefined,
    role: typeof raw.role === "string" && raw.role.trim() ? raw.role : undefined,
  }
}

function normalizePathRefs(raw: unknown) {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizePathRef).filter((item): item is LongTaskPathRef => Boolean(item))
}

function normalizeBudgets(raw: unknown): LongTaskBudgets {
  if (!isObject(raw)) return { ...DEFAULT_LONG_TASK_BUDGETS }
  return {
    maxAttemptsPerUnit:
      typeof raw.maxAttemptsPerUnit === "number" && raw.maxAttemptsPerUnit > 0
        ? raw.maxAttemptsPerUnit
        : DEFAULT_LONG_TASK_BUDGETS.maxAttemptsPerUnit,
    maxTotalUnitAttempts:
      typeof raw.maxTotalUnitAttempts === "number" && raw.maxTotalUnitAttempts > 0
        ? raw.maxTotalUnitAttempts
        : DEFAULT_LONG_TASK_BUDGETS.maxTotalUnitAttempts,
    maxGraphReplans:
      typeof raw.maxGraphReplans === "number" && raw.maxGraphReplans >= 0
        ? raw.maxGraphReplans
        : DEFAULT_LONG_TASK_BUDGETS.maxGraphReplans,
    maxValidatorCalls:
      typeof raw.maxValidatorCalls === "number" && raw.maxValidatorCalls > 0
        ? raw.maxValidatorCalls
        : DEFAULT_LONG_TASK_BUDGETS.maxValidatorCalls,
    maxNoProgressCycles:
      typeof raw.maxNoProgressCycles === "number" && raw.maxNoProgressCycles > 0
        ? raw.maxNoProgressCycles
        : DEFAULT_LONG_TASK_BUDGETS.maxNoProgressCycles,
    maxUnitsPerGraph:
      typeof raw.maxUnitsPerGraph === "number" && raw.maxUnitsPerGraph > 0
        ? raw.maxUnitsPerGraph
        : DEFAULT_LONG_TASK_BUDGETS.maxUnitsPerGraph,
  }
}

function normalizeValidator(raw: unknown): LongTaskValidatorContract | undefined {
  if (!isObject(raw)) return undefined
  if (typeof raw.id !== "string" || !raw.id.trim()) return undefined
  if (typeof raw.title !== "string" || !raw.title.trim()) return undefined
  if (raw.type === "script") {
    if (typeof raw.path !== "string" || !raw.path.trim()) return undefined
    return {
      id: raw.id,
      type: "script",
      title: raw.title,
      path: raw.path,
      placement: raw.placement === "completion_only" ? "completion_only" : "unit",
      runner:
        raw.runner === "python" ||
        raw.runner === "bun" ||
        raw.runner === "node" ||
        raw.runner === "powershell" ||
        raw.runner === "direct"
          ? raw.runner
          : undefined,
      args: normalizeStringArray(raw.args),
      cwd: typeof raw.cwd === "string" && raw.cwd.trim() ? raw.cwd : undefined,
      required: typeof raw.required === "boolean" ? raw.required : true,
      blocking: typeof raw.blocking === "boolean" ? raw.blocking : false,
      inputMode: raw.inputMode === "none" ? "none" : "json_file",
      successExitCodes: Array.isArray(raw.successExitCodes)
        ? raw.successExitCodes.filter((item): item is number => typeof item === "number")
        : undefined,
      timeoutMs: typeof raw.timeoutMs === "number" && raw.timeoutMs > 0 ? raw.timeoutMs : undefined,
    }
  }
  if (raw.type === "prompt_json") {
    if (typeof raw.prompt !== "string" || !raw.prompt.trim()) return undefined
    const inputFiles = isObject(raw.inputFiles)
      ? {
          answerPath: normalizeMaybeString(raw.inputFiles.answerPath),
          candidatePath: normalizeMaybeString(raw.inputFiles.candidatePath),
          humanGuidancePath: normalizeMaybeString(raw.inputFiles.humanGuidancePath),
          contextPaths: normalizeStringArray(raw.inputFiles.contextPaths),
        }
      : undefined
    const execution = isObject(raw.execution)
      ? {
          model: typeof raw.execution.model === "string" && raw.execution.model.trim() ? raw.execution.model : undefined,
          agent: typeof raw.execution.agent === "string" && raw.execution.agent.trim() ? raw.execution.agent : undefined,
          variant:
            typeof raw.execution.variant === "string" && raw.execution.variant.trim() ? raw.execution.variant : undefined,
          system:
            typeof raw.execution.system === "string" && raw.execution.system.trim() ? raw.execution.system : undefined,
        }
      : undefined
    return {
      id: raw.id,
      type: "prompt_json",
      title: raw.title,
      prompt: raw.prompt,
      placement: raw.placement === "completion_only" ? "completion_only" : "unit",
      required: typeof raw.required === "boolean" ? raw.required : true,
      blocking: typeof raw.blocking === "boolean" ? raw.blocking : false,
      inputFiles,
      rubric: isObject(raw.rubric) ? raw.rubric : undefined,
      referencePaths: normalizeStringArray(raw.referencePaths),
      attachedFiles: normalizeStringArray(raw.attachedFiles),
      execution,
    }
  }
  return undefined
}

function normalizeValidators(raw: unknown) {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeValidator).filter((item): item is LongTaskValidatorContract => Boolean(item))
}

function normalizeCapability(raw: unknown): LongTaskCapabilityContract | undefined {
  if (!isObject(raw)) return undefined
  if (typeof raw.id !== "string" || !raw.id.trim()) return undefined
  if (typeof raw.title !== "string" || !raw.title.trim()) return undefined
  if (
    raw.kind !== "inspect" &&
    raw.kind !== "transform" &&
    raw.kind !== "validate" &&
    raw.kind !== "compare" &&
    raw.kind !== "synthesize"
  ) {
    return undefined
  }
  if (typeof raw.description !== "string" || !raw.description.trim()) return undefined
  const execution = isObject(raw.execution)
    ? {
        model: typeof raw.execution.model === "string" && raw.execution.model.trim() ? raw.execution.model : undefined,
        agent: typeof raw.execution.agent === "string" && raw.execution.agent.trim() ? raw.execution.agent : undefined,
        variant:
          typeof raw.execution.variant === "string" && raw.execution.variant.trim() ? raw.execution.variant : undefined,
        system: typeof raw.execution.system === "string" && raw.execution.system.trim() ? raw.execution.system : undefined,
      }
    : undefined

  return {
    id: raw.id,
    title: raw.title,
    kind: raw.kind,
    description: raw.description,
    referencePaths: normalizeStringArray(raw.referencePaths),
    attachedFiles: normalizeStringArray(raw.attachedFiles),
    execution,
  }
}

function normalizeCapabilities(raw: unknown) {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeCapability).filter((item): item is LongTaskCapabilityContract => Boolean(item))
}

function normalizeInitialGraph(raw: unknown, baseDir: string): LongTaskInitialGraphDraft | undefined {
  if (!isObject(raw) || !Array.isArray(raw.units)) return undefined
  const units = raw.units
    .filter((item): item is Record<string, unknown> => isObject(item))
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      title: typeof item.title === "string" ? item.title : "",
      goal: typeof item.goal === "string" ? item.goal : "",
      inputs: normalizeStringArray(item.inputs).map((value) => resolveMaybePath(baseDir, value)),
      depends_on: normalizeStringArray(item.depends_on),
      expected_artifacts: normalizeStringArray(item.expected_artifacts).map((value) => resolveMaybePath(baseDir, value)),
      claim: typeof item.claim === "string" ? item.claim : "",
      check_plan: typeof item.check_plan === "string" ? item.check_plan : "",
      validator_ids: normalizeStringArray(item.validator_ids),
      retry_budget: typeof item.retry_budget === "number" && item.retry_budget > 0 ? item.retry_budget : 1,
    }))
    .filter((item) => item.id.trim() && item.goal.trim())

  if (!units.length) return undefined

  return {
    planner_summary:
      typeof raw.planner_summary === "string" && raw.planner_summary.trim() ? raw.planner_summary : undefined,
    completion_validator_ids: normalizeStringArray(raw.completion_validator_ids),
    units,
  }
}

function resolveMaybePath(baseDir: string, input: string) {
  return path.isAbsolute(input) ? input : path.resolve(baseDir, input)
}

export async function loadLongTaskSpec(
  specPath: string,
  options?: LoadLongTaskSpecOptions,
): Promise<{ spec: LongTaskSpec; specPath: string; missingInitialExpertContextPaths: string[] }> {
  const resolvedSpecPath = path.resolve(specPath)
  const raw = await readJsonFile<Record<string, unknown>>(resolvedSpecPath)
  const baseDir = path.dirname(resolvedSpecPath)

  const materials = normalizePathRefs(raw.materials).map((item) => ({
    ...item,
    path: resolveMaybePath(baseDir, item.path),
  }))
  const targetPaths = normalizePathRefs(raw.targetPaths).map((item) => ({
    ...item,
    path: resolveMaybePath(baseDir, item.path),
  }))
  const editablePaths = normalizeStringArray(raw.editablePaths).map((item) => resolveMaybePath(baseDir, item))
  const preservePreseededEditablePaths = normalizeStringArray(raw.preservePreseededEditablePaths).map((item) =>
    resolveMaybePath(baseDir, item),
  )
  const initialExpertContextPaths = normalizeStringArray(raw.initialExpertContextPaths).map((item) =>
    resolveMaybePath(baseDir, item),
  )
  const formalPackageRoots = normalizeStringArray(raw.formalPackageRoots).map((item) => resolveMaybePath(baseDir, item))
  const campaignPendingPackageRoot = normalizeMaybeString(raw.campaignPendingPackageRoot)
  const campaignExplorationTreePath = normalizeMaybeString(raw.campaignExplorationTreePath)
  const campaignWorkingMemoryPath = normalizeMaybeString(raw.campaignWorkingMemoryPath)
  const campaignRoutingControlPath = normalizeMaybeString(raw.campaignRoutingControlPath)
  const validators = normalizeValidators(raw.validators).map((validator) =>
    validator.type === "script"
      ? {
          ...validator,
          path: resolveMaybePath(baseDir, validator.path),
          cwd: validator.cwd ? resolveMaybePath(baseDir, validator.cwd) : undefined,
        }
      : {
          ...validator,
          inputFiles: validator.inputFiles
            ? {
                answerPath: validator.inputFiles.answerPath
                  ? resolveMaybePath(baseDir, validator.inputFiles.answerPath)
                  : undefined,
                candidatePath: validator.inputFiles.candidatePath
                  ? resolveMaybePath(baseDir, validator.inputFiles.candidatePath)
                  : undefined,
                humanGuidancePath: validator.inputFiles.humanGuidancePath
                  ? resolveMaybePath(baseDir, validator.inputFiles.humanGuidancePath)
                  : undefined,
                contextPaths: (validator.inputFiles.contextPaths ?? []).map((item) => resolveMaybePath(baseDir, item)),
              }
            : undefined,
          referencePaths: (validator.referencePaths ?? []).map((item) => resolveMaybePath(baseDir, item)),
          attachedFiles: (validator.attachedFiles ?? []).map((item) => resolveMaybePath(baseDir, item)),
        },
  )
  const capabilities = normalizeCapabilities(raw.capabilities).map((capability) => ({
    ...capability,
    referencePaths: (capability.referencePaths ?? []).map((item) => resolveMaybePath(baseDir, item)),
    attachedFiles: (capability.attachedFiles ?? []).map((item) => resolveMaybePath(baseDir, item)),
  }))
  const disableCompletionValidators =
    typeof raw.disableCompletionValidators === "boolean" ? raw.disableCompletionValidators : false

  const planning = isObject(raw.planning)
    ? {
        model: typeof raw.planning.model === "string" ? raw.planning.model : undefined,
        agent: typeof raw.planning.agent === "string" ? raw.planning.agent : undefined,
        variant: typeof raw.planning.variant === "string" ? raw.planning.variant : undefined,
        system: typeof raw.planning.system === "string" ? raw.planning.system : undefined,
      }
    : undefined
  const execution = isObject(raw.execution)
    ? {
        model: typeof raw.execution.model === "string" ? raw.execution.model : undefined,
        agent: typeof raw.execution.agent === "string" ? raw.execution.agent : undefined,
        variant: typeof raw.execution.variant === "string" ? raw.execution.variant : undefined,
        system: typeof raw.execution.system === "string" ? raw.execution.system : undefined,
      }
    : undefined
  const validation = isObject(raw.validation)
    ? {
        model: typeof raw.validation.model === "string" ? raw.validation.model : undefined,
        agent: typeof raw.validation.agent === "string" ? raw.validation.agent : undefined,
        variant: typeof raw.validation.variant === "string" ? raw.validation.variant : undefined,
        system: typeof raw.validation.system === "string" ? raw.validation.system : undefined,
      }
    : undefined

  const spec: LongTaskSpec = {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : undefined,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : "Long Task",
    goal: typeof raw.goal === "string" && raw.goal.trim() ? raw.goal : "",
    taskFamily: typeof raw.taskFamily === "string" && raw.taskFamily.trim() ? raw.taskFamily : undefined,
    domainTags: normalizeStringArray(raw.domainTags),
    materials,
    targetPaths,
    editablePaths: editablePaths.length ? editablePaths : targetPaths.map((item) => item.path),
    preservePreseededEditablePaths,
    initialExpertContextPaths,
    formalPackageRoots,
    campaignPendingPackageRoot: campaignPendingPackageRoot
      ? resolveMaybePath(baseDir, campaignPendingPackageRoot)
      : undefined,
    campaignExplorationTreePath: campaignExplorationTreePath
      ? resolveMaybePath(baseDir, campaignExplorationTreePath)
      : undefined,
    campaignWorkingMemoryPath: campaignWorkingMemoryPath ? resolveMaybePath(baseDir, campaignWorkingMemoryPath) : undefined,
    campaignRoutingControlPath: campaignRoutingControlPath
      ? resolveMaybePath(baseDir, campaignRoutingControlPath)
      : undefined,
    capabilities,
    validators,
    planning,
    execution,
    validation,
    budgets: normalizeBudgets(raw.budgets),
    disableCompletionValidators,
    shadowMemoryScope: isObject(raw.shadowMemoryScope)
      ? {
          namespace:
            typeof raw.shadowMemoryScope.namespace === "string" && raw.shadowMemoryScope.namespace.trim()
              ? raw.shadowMemoryScope.namespace
              : typeof raw.taskFamily === "string" && raw.taskFamily.trim()
                ? raw.taskFamily
                : "long-task",
          tags: normalizeStringArray(raw.shadowMemoryScope.tags),
          retrievalMode:
            raw.shadowMemoryScope.retrievalMode === "related_only" ||
            raw.shadowMemoryScope.retrievalMode === "manual"
              ? raw.shadowMemoryScope.retrievalMode
              : "isolated",
        }
      : undefined,
    reversePropagation: isObject(raw.reversePropagation)
      ? {
          recipeID:
            typeof raw.reversePropagation.recipeID === "string" && raw.reversePropagation.recipeID.trim()
              ? raw.reversePropagation.recipeID
              : undefined,
          maintenanceModuleID:
            typeof raw.reversePropagation.maintenanceModuleID === "string" &&
            raw.reversePropagation.maintenanceModuleID.trim()
              ? raw.reversePropagation.maintenanceModuleID
              : undefined,
          acceptancePolicyID:
            typeof raw.reversePropagation.acceptancePolicyID === "string" &&
            raw.reversePropagation.acceptancePolicyID.trim()
              ? raw.reversePropagation.acceptancePolicyID
              : undefined,
          constraintPolicyIDs: normalizeStringArray(raw.reversePropagation.constraintPolicyIDs),
        }
      : undefined,
    initialGraph: normalizeInitialGraph(raw.initialGraph, baseDir),
    notes: typeof raw.notes === "string" && raw.notes.trim() ? raw.notes : undefined,
  }

  if (!spec.goal.trim()) {
    throw new Error(`Long-task spec is missing a non-empty goal: ${resolvedSpecPath}`)
  }
  if (!spec.materials.length) {
    throw new Error(`Long-task spec must include at least one material: ${resolvedSpecPath}`)
  }
  if (!spec.validators.length) {
    throw new Error(`Long-task spec must include at least one validator: ${resolvedSpecPath}`)
  }

  const missingInitialExpertContextPaths: string[] = []
  const verifiedInitialExpertContextPaths: string[] = []
  for (const ref of spec.initialExpertContextPaths) {
    if (await pathExists(ref)) {
      verifiedInitialExpertContextPaths.push(ref)
      continue
    }
    if (options?.allowMissingInitialExpertContextPaths) {
      missingInitialExpertContextPaths.push(ref)
      continue
    }
    throw new Error(`Long-task spec references a missing input path: ${ref}`)
  }
  spec.initialExpertContextPaths = verifiedInitialExpertContextPaths

  for (const ref of [
    ...spec.materials.map((item) => item.path),
    ...(spec.campaignPendingPackageRoot ? [spec.campaignPendingPackageRoot] : []),
    ...(spec.campaignExplorationTreePath ? [spec.campaignExplorationTreePath] : []),
    ...(spec.campaignWorkingMemoryPath ? [spec.campaignWorkingMemoryPath] : []),
    ...(spec.campaignRoutingControlPath ? [spec.campaignRoutingControlPath] : []),
  ]) {
    if (!(await pathExists(ref))) {
      throw new Error(`Long-task spec references a missing input path: ${ref}`)
    }
  }
  for (const capability of spec.capabilities ?? []) {
    for (const ref of [...(capability.referencePaths ?? []), ...(capability.attachedFiles ?? [])]) {
      if (!(await pathExists(ref))) {
        throw new Error(`Long-task spec references a missing capability path: ${ref}`)
      }
    }
  }
  for (const validator of spec.validators) {
    if (validator.type === "script" && !(await pathExists(validator.path))) {
      throw new Error(`Long-task spec references a missing validator script: ${validator.path}`)
    }
  }

  return {
    spec,
    specPath: resolvedSpecPath,
    missingInitialExpertContextPaths,
  }
}
