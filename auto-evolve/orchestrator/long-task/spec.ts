import path from "node:path"
import type {
  LongTaskBudgets,
  LongTaskPathRef,
  LongTaskSpec,
  LongTaskValidatorContract,
} from "./contract"
import { DEFAULT_LONG_TASK_BUDGETS } from "./contract"
import { pathExists, readJsonFile } from "../fs"

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function normalizeStringArray(input: unknown) {
  if (!Array.isArray(input)) return []
  return input.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
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
    }
  }
  if (raw.type === "prompt_json") {
    if (typeof raw.prompt !== "string" || !raw.prompt.trim()) return undefined
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
      required: typeof raw.required === "boolean" ? raw.required : true,
      blocking: typeof raw.blocking === "boolean" ? raw.blocking : false,
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

function resolveMaybePath(baseDir: string, input: string) {
  return path.isAbsolute(input) ? input : path.resolve(baseDir, input)
}

export async function loadLongTaskSpec(specPath: string): Promise<{ spec: LongTaskSpec; specPath: string }> {
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
  const initialExpertContextPaths = normalizeStringArray(raw.initialExpertContextPaths).map((item) =>
    resolveMaybePath(baseDir, item),
  )
  const validators = normalizeValidators(raw.validators).map((validator) =>
    validator.type === "script"
      ? {
          ...validator,
          path: resolveMaybePath(baseDir, validator.path),
          cwd: validator.cwd ? resolveMaybePath(baseDir, validator.cwd) : undefined,
        }
      : {
          ...validator,
          referencePaths: (validator.referencePaths ?? []).map((item) => resolveMaybePath(baseDir, item)),
          attachedFiles: (validator.attachedFiles ?? []).map((item) => resolveMaybePath(baseDir, item)),
        },
  )

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
    initialExpertContextPaths,
    validators,
    planning,
    execution,
    validation,
    budgets: normalizeBudgets(raw.budgets),
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
          constraintPolicyIDs: normalizeStringArray(raw.reversePropagation.constraintPolicyIDs),
        }
      : undefined,
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

  for (const ref of [...spec.materials.map((item) => item.path), ...spec.initialExpertContextPaths]) {
    if (!(await pathExists(ref))) {
      throw new Error(`Long-task spec references a missing input path: ${ref}`)
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
  }
}

