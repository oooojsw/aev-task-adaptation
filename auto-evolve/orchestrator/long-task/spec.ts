import path from "node:path"
import { readFile } from "node:fs/promises"
import type {
  LongTaskCapabilityContract,
  LongTaskBudgets,
  LongTaskInitialGraphDraft,
  LongTaskPathRef,
  LongTaskSpec,
  LongTaskValidatorEngineHints,
  LongTaskValidatorContract,
} from "./contract"
import { DEFAULT_LONG_TASK_BUDGETS } from "./contract"
import { pathExists, readJsonFile } from "../fs"
import { assertNoBlankAgentAudience } from "../validation-engine/registry"

export interface LoadLongTaskSpecOptions {
  allowMissingInitialExpertContextPaths?: boolean
}

const VALIDATOR_PROFILES_ROOT = path.resolve(import.meta.dir, "..", "..", "task-packs", "validator-profiles")

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

const VALIDATOR_FILE_ARG_FLAGS = new Set([
  "--answer",
  "--answer-path",
  "--ground-truth",
  "--ground-truth-path",
  "--candidate",
  "--candidate-path",
  "--reference",
  "--reference-path",
  "--expected",
  "--expected-path",
  "--input",
  "--input-path",
  "--output",
  "--output-path",
  "--reward",
  "--reward-path",
  "--config",
  "--config-path",
  "--rubric",
  "--rubric-path",
  "--profile",
  "--profile-path",
])

function resolveValidatorScriptArgs(baseDir: string, args: string[] | undefined) {
  if (!args?.length) return args
  const resolved: string[] = []
  let previousFlag: string | undefined
  for (const arg of args) {
    if (previousFlag && VALIDATOR_FILE_ARG_FLAGS.has(previousFlag)) {
      resolved.push(resolveMaybePath(baseDir, arg))
      previousFlag = undefined
      continue
    }
    resolved.push(arg)
    previousFlag = arg.startsWith("--") ? arg : undefined
  }
  return resolved
}

function normalizeValidatorEngineHints(raw: unknown): LongTaskValidatorEngineHints | undefined {
  if (!isObject(raw)) return undefined
  const target =
    raw.target === "surface" ||
    raw.target === "product" ||
    raw.target === "behavior" ||
    raw.target === "regression" ||
    raw.target === "transaction" ||
    raw.target === "layout"
      ? raw.target
      : undefined
  const stage =
    raw.stage === "local_training" ||
    raw.stage === "pre_blank" ||
    raw.stage === "post_blank" ||
    raw.stage === "post_merge" ||
    raw.stage === "rollback" ||
    raw.stage === "train_replay" ||
    raw.stage === "heldout_test" ||
    raw.stage === "judge"
      ? raw.stage
      : undefined
  const answerAccess =
    raw.answerAccess === "none" || raw.answerAccess === "private_oracle" || raw.answerAccess === "full_training"
      ? raw.answerAccess
      : undefined
  const rawAllowedAudiences = normalizeStringArray(raw.allowedAudiences)
  if (rawAllowedAudiences.includes("blank_agent")) {
    throw new Error(
      "validation.allowedAudiences must not include 'blank_agent'. " +
        "blank_agent is closed-book and cannot read validation result views.",
    )
  }
  const allowedAudiences = rawAllowedAudiences.filter(
    (item): item is NonNullable<LongTaskValidatorEngineHints["allowedAudiences"]>[number] =>
      item === "executor" ||
      item === "worker" ||
      item === "lead" ||
      item === "reviewer" ||
      item === "merger" ||
      item === "repair_agent" ||
      item === "dashboard" ||
      item === "memory" ||
      item === "audit",
  )
  const out: LongTaskValidatorEngineHints = {
    target,
    stage,
    answerAccess,
    allowedAudiences: allowedAudiences.length ? allowedAudiences : undefined,
    writeViews: typeof raw.writeViews === "boolean" ? raw.writeViews : undefined,
  }
  return Object.values(out).some((value) => value !== undefined) ? out : undefined
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
      validation: normalizeValidatorEngineHints(raw.validation),
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
      validation: normalizeValidatorEngineHints(raw.validation),
    }
  }
  return undefined
}

function normalizeValidators(raw: unknown) {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeValidator).filter((item): item is LongTaskValidatorContract => Boolean(item))
}

function mergeValidatorsKeepLast(validators: LongTaskValidatorContract[]) {
  const index = new Map<string, number>()
  validators.forEach((item, i) => index.set(item.id, i))
  return validators.filter((item, i) => index.get(item.id) === i)
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

function isUseRef(raw: unknown): raw is { use: string } {
  if (!isObject(raw)) return false
  return typeof raw.use === "string" && raw.use.trim().length > 0
}

async function resolveValidatorProfilePath(baseDir: string, profileRef: string) {
  if (!profileRef.trim()) return undefined
  if (path.isAbsolute(profileRef)) {
    return profileRef.endsWith(".json") ? profileRef : `${profileRef}.json`
  }
  if (profileRef.endsWith(".json") || profileRef.includes(path.sep) || profileRef.includes("/")) {
    const maybeLocal = resolveMaybePath(baseDir, profileRef)
    if (await pathExists(maybeLocal)) return maybeLocal
    const normalizedRef = profileRef.replace(/\\/g, "/").replace(/^\/+/, "")
    return path.resolve(VALIDATOR_PROFILES_ROOT, normalizedRef.endsWith(".json") ? normalizedRef : `${normalizedRef}.json`)
  }
  return path.resolve(VALIDATOR_PROFILES_ROOT, `${profileRef}.json`)
}

async function materializePromptPath(baseDir: string, raw: Record<string, unknown>) {
  if (raw.type !== "prompt_json") return raw
  const hasPrompt = typeof raw.prompt === "string" && raw.prompt.trim().length > 0
  if (hasPrompt) return raw
  const promptPath = typeof raw.promptPath === "string" && raw.promptPath.trim().length > 0 ? raw.promptPath : undefined
  if (!promptPath) return raw
  const resolved = resolveMaybePath(baseDir, promptPath)
  const promptRaw = await readFile(resolved, "utf8").catch(() => undefined)
  if (typeof promptRaw !== "string" || !promptRaw.trim().length) return raw
  return {
    ...raw,
    prompt: promptRaw.trim(),
  }
}

function materializeValidatorEntryPaths(baseDir: string, raw: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...raw }
  if (out.type === "script") {
    if (typeof out.path === "string" && out.path.trim().length > 0) {
      out.path = resolveMaybePath(baseDir, out.path)
    }
    if (typeof out.cwd === "string" && out.cwd.trim().length > 0) {
      out.cwd = resolveMaybePath(baseDir, out.cwd)
    }
    if (Array.isArray(out.args)) {
      out.args = resolveValidatorScriptArgs(
        baseDir,
        out.args.filter((item): item is string => typeof item === "string" && item.trim().length > 0),
      )
    }
  }
  if (out.type === "prompt_json") {
    if (Array.isArray(out.referencePaths)) {
      out.referencePaths = out.referencePaths
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => resolveMaybePath(baseDir, item))
    }
    if (Array.isArray(out.attachedFiles)) {
      out.attachedFiles = out.attachedFiles
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => resolveMaybePath(baseDir, item))
    }
    if (isObject(out.inputFiles)) {
      const nextInputFiles: Record<string, unknown> = { ...out.inputFiles }
      if (typeof nextInputFiles.answerPath === "string" && nextInputFiles.answerPath.trim().length > 0) {
        nextInputFiles.answerPath = resolveMaybePath(baseDir, nextInputFiles.answerPath)
      }
      if (typeof nextInputFiles.candidatePath === "string" && nextInputFiles.candidatePath.trim().length > 0) {
        nextInputFiles.candidatePath = resolveMaybePath(baseDir, nextInputFiles.candidatePath)
      }
      if (
        typeof nextInputFiles.humanGuidancePath === "string" &&
        nextInputFiles.humanGuidancePath.trim().length > 0
      ) {
        nextInputFiles.humanGuidancePath = resolveMaybePath(baseDir, nextInputFiles.humanGuidancePath)
      }
      if (Array.isArray(nextInputFiles.contextPaths)) {
        nextInputFiles.contextPaths = nextInputFiles.contextPaths
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((item) => resolveMaybePath(baseDir, item))
      }
      out.inputFiles = nextInputFiles
    }
  }
  return out
}

async function resolveValidatorProfileEntries(baseDir: string, refs: string[], chain: string[] = []): Promise<unknown[]> {
  const out: unknown[] = []
  for (const ref of refs) {
    const resolvedPath = await resolveValidatorProfilePath(baseDir, ref)
    if (!resolvedPath) continue
    if (!(await pathExists(resolvedPath))) {
      throw new Error(`Validator profile does not exist: ${resolvedPath}`)
    }
    const key = resolvedPath.toLowerCase()
    if (chain.includes(key)) {
      throw new Error(`Validator profile cycle detected: ${[...chain, key].join(" -> ")}`)
    }
    const rawDoc = await readJsonFile<Record<string, unknown>>(resolvedPath)
    const rawValidators = Array.isArray(rawDoc.validators) ? rawDoc.validators : []
    const profileDir = path.dirname(resolvedPath)
    for (const rawItem of rawValidators) {
      if (isUseRef(rawItem)) {
        const nested = await resolveValidatorProfileEntries(profileDir, [rawItem.use], [...chain, key])
        out.push(...nested)
        continue
      }
      if (isObject(rawItem)) {
        const withPrompt = await materializePromptPath(profileDir, rawItem)
        out.push(materializeValidatorEntryPaths(profileDir, withPrompt))
      }
    }
  }
  return out
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
  const validatorProfiles = normalizeStringArray(raw.validatorProfiles)
  const blankEvalValidatorProfiles = normalizeStringArray(raw.blankEvalValidatorProfiles)
  const profileValidatorEntries = await resolveValidatorProfileEntries(baseDir, validatorProfiles)
  const inlineValidatorEntries = Array.isArray(raw.validators)
    ? await Promise.all(
        raw.validators.map(async (item) => (isObject(item) ? materializePromptPath(baseDir, item) : item)),
      )
    : []
  const mergedValidatorEntries = [...profileValidatorEntries, ...inlineValidatorEntries]

  // Reject validator profiles that grant `blank_agent` access at load time.
  for (const entry of mergedValidatorEntries) {
    if (isObject(entry) && entry && "validation" in entry) {
      const audiences = (entry as { validation?: { allowedAudiences?: unknown } }).validation?.allowedAudiences
      if (Array.isArray(audiences) && audiences.includes("blank_agent")) {
        const id = (entry as { id?: string }).id ?? "(unknown-validator)"
        throw new Error(
          `Validator '${id}' has allowedAudiences containing 'blank_agent'. ` +
            `blank_agent cannot read any validation result view. ` +
            `Remove 'blank_agent' from allowedAudiences; use audit / dashboard / memory for monitoring instead.`,
        )
      }
    }
  }
  const validators = mergeValidatorsKeepLast(normalizeValidators(mergedValidatorEntries)).map((validator) =>
    validator.type === "script"
      ? {
          ...validator,
          path: resolveMaybePath(baseDir, validator.path),
          cwd: validator.cwd ? resolveMaybePath(baseDir, validator.cwd) : undefined,
          args: resolveValidatorScriptArgs(baseDir, validator.args),
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
    validatorProfiles,
    blankEvalValidatorProfiles,
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
