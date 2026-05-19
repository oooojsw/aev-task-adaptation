import path from "node:path"
import { autoEvolvePath, caseMetadataPath, listCaseDirectories, pathExists, readJsonFile, readTextFile } from "./fs"
import { loadDatasetSplit } from "./dataset-split"
import { experienceWorkspacePaths, resolveExperienceWorkspaceLayout, validateExperienceWorkspaceLayout } from "./experience-workspace"
import { OpenCodeGate } from "./opencode-gate"

export type CompareMode = "text_exact" | "text_contains" | "json_exact"
export type ModelPhase = "bootstrap" | "solve" | "refine" | "verify" | "regression"

export interface RuntimePathOverrides {
  knowledgeDir?: string
  runsDir?: string
}

export interface ModelSelection {
  model?: string
  agent?: string
  variant?: string
}

export interface LoadedModelConfig {
  version: number
  defaults: ModelSelection
  limits: {
    requestsPerMinute?: number
  }
  phases: Record<ModelPhase, ModelSelection>
}

export type PermissionMode = "open" | "restricted"

export interface LoadedPermissionConfig {
  version: number
  mode: PermissionMode
}

export type JudgeMode = "soft_only" | "soft_plus_hard"

export interface LoadedJudgeConfig {
  version: number
  mode: JudgeMode
  autoRunSkillIDs: string[]
}

export interface LoadedMonitorConfig {
  version: number
  enabled: boolean
  autoStart: boolean
  hostname: string
  port: number
  intervalSeconds: number
  defaultLimit: number
  openBrowserOnStart: boolean
}

export interface LoadedConcurrencyConfig {
  /** Maximum number of OpenCode child processes that may run simultaneously. */
  maxConcurrent: number
  /** Maximum number of OpenCode child processes for one logical task scope. */
  perScopeMaxConcurrent: number
  /** Maximum number of callers that may queue waiting for a permit. */
  maxQueueDepth: number
  /** Permit acquire timeout (milliseconds). */
  acquireTimeoutMs: number
  /** Optional minimum interval between consecutive spawn grants. */
  minSpawnIntervalMs: number
}

export interface AutoEvolveConfig {
  version: number
  datasetDir: string
  knowledgeDir: string
  experienceArchiveDir: string
  maintenanceGatewayDir: string
  experienceTransactionDir: string
  acceptanceFrameworkDir: string
  experienceEntryFile: string
  templateLibraryDir: string
  reversePropagationModulesDir: string
  maintenanceOpsDir: string
  judgeSkillsDir: string
  systemPromptsDir: string
  methodsDir: string
  propagationDir: string
  propagationMethodsDir: string
  optimizationDir: string
  baselineFile: string
  splitFile: string
  scriptsDir: string
  runsDir: string
  modelConfigFile: string
  judgeConfigFile: string
  permissionConfigFile: string
  monitorConfigFile: string
  defaultAgent?: string
  defaultModel?: string
  defaultVariant?: string
  defaultMethod: string
  defaultPropagationMethod: string
  maxRetriesPerCase: number
  maxMaintenanceRoundsPerAttempt: number
  roundCaseLimit: number
  regressionSampleSize: number
  modelConfigPath: string
  modelConfig: LoadedModelConfig
  judgeConfigPath: string
  judgeConfig: LoadedJudgeConfig
  permissionConfigPath: string
  permissionConfig: LoadedPermissionConfig
  monitorConfigPath: string
  monitorConfig: LoadedMonitorConfig
  concurrencyConfigFile: string
  concurrencyConfigPath: string
  concurrencyConfig: LoadedConcurrencyConfig
}

export interface CaseMaterial {
  path: string
  label?: string
}

export interface ExpectedSpec {
  path: string
  mode: CompareMode
}

export interface ExecutionSpec {
  agent?: string
  model?: string
  variant?: string
  system?: string
}

export interface CaseSpec {
  id: string
  instruction: string
  materials: CaseMaterial[]
  expected: ExpectedSpec
  execution?: ExecutionSpec
  tags?: string[]
  notes?: string
}

export interface LoadedCase {
  caseDir: string
  casePath: string
  spec: CaseSpec
}

export interface ValidationReport {
  caseCount: number
  errors: string[]
}

export const DEFAULT_CONFIG: AutoEvolveConfig = {
  version: 1,
  datasetDir: "dataset/cases",
  knowledgeDir: "experience/workspace",
  experienceArchiveDir: "experience/archive",
  maintenanceGatewayDir: "runtime-state/maintenance-gateway",
  experienceTransactionDir: "runtime-state/experience-transaction",
  acceptanceFrameworkDir: "runtime-state/acceptance-framework",
  experienceEntryFile: "manifest.md",
  templateLibraryDir: "experience/templates",
  reversePropagationModulesDir: "methods/reverse-propagation-modules",
  maintenanceOpsDir: "methods/maintenance-ops",
  judgeSkillsDir: "judge-skills",
  systemPromptsDir: "prompts",
  methodsDir: "methods/recipes",
  propagationDir: "runtime-state/propagation",
  propagationMethodsDir: "methods/propagation",
  optimizationDir: "runtime-state/optimization",
  baselineFile: "baseline.md",
  splitFile: "dataset/SPLIT.md",
  scriptsDir: "scripts",
  runsDir: "runtime-state/runs",
  modelConfigFile: "model-config.json",
  judgeConfigFile: "judge-config.json",
  permissionConfigFile: "permission-config.json",
  monitorConfigFile: "monitor-config.json",
  concurrencyConfigFile: "concurrency-config.json",
  defaultAgent: undefined,
  defaultModel: "minimax-cn-coding-plan/MiniMax-M2.7",
  defaultVariant: undefined,
  defaultMethod: "sequential-refine",
  defaultPropagationMethod: "single-branch-baseline",
  maxRetriesPerCase: 3,
  maxMaintenanceRoundsPerAttempt: 3,
  roundCaseLimit: 5,
  regressionSampleSize: 3,
  modelConfigPath: "",
  modelConfig: {
    version: 1,
    defaults: {
      model: "minimax-cn-coding-plan/MiniMax-M2.7",
      agent: undefined,
      variant: undefined,
    },
    limits: {},
    phases: {
      bootstrap: {},
      solve: {},
      refine: {},
      verify: {},
      regression: {},
    },
  },
  judgeConfigPath: "",
  judgeConfig: {
    version: 1,
    mode: "soft_plus_hard",
    autoRunSkillIDs: ["exact-output", "tool-failures", "session-behavior"],
  },
  permissionConfigPath: "",
  permissionConfig: {
    version: 1,
    mode: "open",
  },
  monitorConfigPath: "",
  monitorConfig: {
    version: 1,
    enabled: true,
    autoStart: true,
    hostname: "127.0.0.1",
    port: 4219,
    intervalSeconds: 2,
    defaultLimit: 50,
    openBrowserOnStart: true,
  },
  concurrencyConfigPath: "",
  concurrencyConfig: {
    maxConcurrent: 15,
    perScopeMaxConcurrent: 5,
    maxQueueDepth: 60,
    acquireTimeoutMs: 60 * 60 * 1000,
    minSpawnIntervalMs: 0,
  },
}

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function isCompareMode(input: string): input is CompareMode {
  return input === "text_exact" || input === "text_contains" || input === "json_exact"
}

function isModelPhase(input: string): input is ModelPhase {
  return input === "bootstrap" || input === "solve" || input === "refine" || input === "verify" || input === "regression"
}

function isPermissionMode(input: string): input is PermissionMode {
  return input === "open" || input === "restricted"
}

function isJudgeMode(input: string): input is JudgeMode {
  return input === "soft_only" || input === "soft_plus_hard"
}

function inferCompareModeFromPath(filePath: string): CompareMode {
  return filePath.toLowerCase().endsWith(".json") ? "json_exact" : "text_exact"
}

function normalizeOptionalString(input: unknown) {
  return typeof input === "string" && input.trim() ? input : undefined
}

function normalizeModelSelection(input: unknown, fallback: ModelSelection = {}): ModelSelection {
  if (!isObject(input)) {
    return { ...fallback }
  }
  return {
    model: normalizeOptionalString(input.model) ?? fallback.model,
    agent: normalizeOptionalString(input.agent) ?? fallback.agent,
    variant: normalizeOptionalString(input.variant) ?? fallback.variant,
  }
}

function buildDefaultModelConfig(legacyDefaults: ModelSelection): LoadedModelConfig {
  return {
    version: 1,
    defaults: {
      model: legacyDefaults.model ?? DEFAULT_CONFIG.defaultModel,
      agent: legacyDefaults.agent ?? DEFAULT_CONFIG.defaultAgent,
      variant: legacyDefaults.variant ?? DEFAULT_CONFIG.defaultVariant,
    },
    limits: {},
    phases: {
      bootstrap: {},
      solve: {},
      refine: {},
      verify: {},
      regression: {},
    },
  }
}

async function loadJudgeConfig(configPath: string): Promise<LoadedJudgeConfig> {
  if (!(await pathExists(configPath))) {
    return { ...DEFAULT_CONFIG.judgeConfig }
  }

  const raw = await readJsonFile<Record<string, unknown>>(configPath)
  return {
    version: typeof raw.version === "number" ? raw.version : DEFAULT_CONFIG.judgeConfig.version,
    mode: typeof raw.mode === "string" && isJudgeMode(raw.mode) ? raw.mode : DEFAULT_CONFIG.judgeConfig.mode,
    autoRunSkillIDs: Array.isArray(raw.autoRunSkillIDs)
      ? raw.autoRunSkillIDs.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : DEFAULT_CONFIG.judgeConfig.autoRunSkillIDs,
  }
}

function normalizeMaterials(raw: unknown): CaseMaterial[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(isObject)
    .map((item) => ({
      path: typeof item.path === "string" ? item.path : "",
      label: typeof item.label === "string" ? item.label : undefined,
    }))
    .filter((item) => item.path.length > 0)
}

function normalizeCaseSpec(raw: unknown, fallbackCaseID: string): CaseSpec {
  if (!isObject(raw)) throw new Error("Case file must be a JSON object.")

  const expectedRaw = isObject(raw.expected) ? raw.expected : {}
  const compareRuleRaw = isObject(raw.compare_rule) ? raw.compare_rule : {}
  const expectedPath =
    typeof expectedRaw.path === "string"
      ? expectedRaw.path
      : typeof raw.expected_path === "string"
        ? raw.expected_path
        : ""
  if (!expectedPath) throw new Error("Case is missing expected.path.")

  const modeCandidate =
    typeof expectedRaw.mode === "string"
      ? expectedRaw.mode
      : typeof compareRuleRaw.mode === "string"
        ? compareRuleRaw.mode
        : inferCompareModeFromPath(expectedPath)

  if (!isCompareMode(modeCandidate)) {
    throw new Error(`Unsupported compare mode: ${String(modeCandidate)}`)
  }

  const executionRaw = isObject(raw.execution) ? raw.execution : {}

  return {
    id: typeof raw.id === "string" ? raw.id : fallbackCaseID,
    instruction:
      typeof raw.instruction === "string"
        ? raw.instruction
        : "Solve the case with the attached materials and return only the final answer.",
    materials: normalizeMaterials(raw.materials),
    expected: {
      path: expectedPath,
      mode: modeCandidate,
    },
    execution: {
      agent: typeof executionRaw.agent === "string" ? executionRaw.agent : undefined,
      model: typeof executionRaw.model === "string" ? executionRaw.model : undefined,
      variant: typeof executionRaw.variant === "string" ? executionRaw.variant : undefined,
      system: typeof executionRaw.system === "string" ? executionRaw.system : undefined,
    },
    tags: Array.isArray(raw.tags) ? raw.tags.filter((item): item is string => typeof item === "string") : undefined,
    notes: typeof raw.notes === "string" ? raw.notes : undefined,
  }
}

function validateCaseShape(spec: CaseSpec): string[] {
  const errors: string[] = []
  if (!spec.id.trim()) errors.push("Case id cannot be empty.")
  if (!spec.instruction.trim()) errors.push(`Case ${spec.id}: instruction cannot be empty.`)
  if (!spec.materials.length) errors.push(`Case ${spec.id}: at least one material is required.`)
  if (!spec.expected.path.trim()) errors.push(`Case ${spec.id}: expected.path cannot be empty.`)
  return errors
}

export async function loadConfig(cwd: string, runtimePaths?: RuntimePathOverrides) {
  const configPath = autoEvolvePath(cwd, "config.json")
  const raw = await readJsonFile<Record<string, unknown>>(configPath)
  const legacyDefaults: ModelSelection = {
    model: normalizeOptionalString(raw.defaultModel) ?? DEFAULT_CONFIG.defaultModel,
    agent: normalizeOptionalString(raw.defaultAgent) ?? DEFAULT_CONFIG.defaultAgent,
    variant: normalizeOptionalString(raw.defaultVariant) ?? DEFAULT_CONFIG.defaultVariant,
  }
  const modelConfigFile =
    typeof raw.modelConfigFile === "string" && raw.modelConfigFile.trim()
      ? raw.modelConfigFile
      : DEFAULT_CONFIG.modelConfigFile
  const permissionConfigFile =
    typeof raw.permissionConfigFile === "string" && raw.permissionConfigFile.trim()
      ? raw.permissionConfigFile
      : DEFAULT_CONFIG.permissionConfigFile
  const judgeConfigFile =
    typeof raw.judgeConfigFile === "string" && raw.judgeConfigFile.trim()
      ? raw.judgeConfigFile
      : DEFAULT_CONFIG.judgeConfigFile
  const monitorConfigFile =
    typeof raw.monitorConfigFile === "string" && raw.monitorConfigFile.trim()
      ? raw.monitorConfigFile
      : DEFAULT_CONFIG.monitorConfigFile
  const concurrencyConfigFile =
    typeof raw.concurrencyConfigFile === "string" && raw.concurrencyConfigFile.trim()
      ? raw.concurrencyConfigFile
      : DEFAULT_CONFIG.concurrencyConfigFile
  const modelConfigPath = autoEvolvePath(cwd, modelConfigFile)
  const permissionConfigPath = autoEvolvePath(cwd, permissionConfigFile)
  const judgeConfigPath = autoEvolvePath(cwd, judgeConfigFile)
  const monitorConfigPath = autoEvolvePath(cwd, monitorConfigFile)
  const concurrencyConfigPath = autoEvolvePath(cwd, concurrencyConfigFile)
  let modelConfig = buildDefaultModelConfig(legacyDefaults)
  if (await pathExists(modelConfigPath)) {
    const rawModelConfig = await readJsonFile<Record<string, unknown>>(modelConfigPath)
    const rawDefaults = normalizeModelSelection(rawModelConfig.defaults, modelConfig.defaults)
    const rawPhases = isObject(rawModelConfig.phases) ? rawModelConfig.phases : {}
    const rawLimits = isObject(rawModelConfig.limits) ? rawModelConfig.limits : {}
    const phases = { ...modelConfig.phases }
    for (const [phaseName, value] of Object.entries(rawPhases)) {
      if (!isModelPhase(phaseName)) continue
      phases[phaseName] = normalizeModelSelection(value)
    }
    modelConfig = {
      version: typeof rawModelConfig.version === "number" ? rawModelConfig.version : modelConfig.version,
      defaults: rawDefaults,
      limits: {
        requestsPerMinute:
          typeof rawLimits.requestsPerMinute === "number" && rawLimits.requestsPerMinute > 0
            ? rawLimits.requestsPerMinute
            : undefined,
      },
      phases,
    }
  }
  let permissionConfig: LoadedPermissionConfig = {
    version: 1,
    mode: "open",
  }
  if (await pathExists(permissionConfigPath)) {
    const rawPermissionConfig = await readJsonFile<Record<string, unknown>>(permissionConfigPath)
    permissionConfig = {
      version:
        typeof rawPermissionConfig.version === "number"
          ? rawPermissionConfig.version
          : permissionConfig.version,
      mode:
        typeof rawPermissionConfig.mode === "string" && isPermissionMode(rawPermissionConfig.mode)
          ? rawPermissionConfig.mode
          : permissionConfig.mode,
    }
  }
  const judgeConfig = await loadJudgeConfig(judgeConfigPath)
  let monitorConfig: LoadedMonitorConfig = {
    version: 1,
    enabled: true,
    autoStart: true,
    hostname: "127.0.0.1",
    port: 4219,
    intervalSeconds: 2,
    defaultLimit: 50,
    openBrowserOnStart: true,
  }
  if (await pathExists(monitorConfigPath)) {
    const rawMonitorConfig = await readJsonFile<Record<string, unknown>>(monitorConfigPath)
    monitorConfig = {
      version:
        typeof rawMonitorConfig.version === "number"
          ? rawMonitorConfig.version
          : monitorConfig.version,
      enabled: typeof rawMonitorConfig.enabled === "boolean" ? rawMonitorConfig.enabled : monitorConfig.enabled,
      autoStart:
        typeof rawMonitorConfig.autoStart === "boolean" ? rawMonitorConfig.autoStart : monitorConfig.autoStart,
      hostname:
        typeof rawMonitorConfig.hostname === "string" && rawMonitorConfig.hostname.trim()
          ? rawMonitorConfig.hostname
          : monitorConfig.hostname,
      port:
        typeof rawMonitorConfig.port === "number" && rawMonitorConfig.port > 0
          ? rawMonitorConfig.port
          : monitorConfig.port,
      intervalSeconds:
        typeof rawMonitorConfig.intervalSeconds === "number" && rawMonitorConfig.intervalSeconds > 0
          ? rawMonitorConfig.intervalSeconds
          : monitorConfig.intervalSeconds,
      defaultLimit:
        typeof rawMonitorConfig.defaultLimit === "number" && rawMonitorConfig.defaultLimit > 0
          ? rawMonitorConfig.defaultLimit
          : monitorConfig.defaultLimit,
      openBrowserOnStart:
        typeof rawMonitorConfig.openBrowserOnStart === "boolean"
          ? rawMonitorConfig.openBrowserOnStart
          : monitorConfig.openBrowserOnStart,
    }
  }
  let concurrencyConfig: LoadedConcurrencyConfig = { ...DEFAULT_CONFIG.concurrencyConfig }
  if (await pathExists(concurrencyConfigPath)) {
    const rawConcurrencyConfig = await readJsonFile<Record<string, unknown>>(concurrencyConfigPath)
    concurrencyConfig = {
      maxConcurrent:
        typeof rawConcurrencyConfig.maxConcurrent === "number" && rawConcurrencyConfig.maxConcurrent > 0
          ? Math.floor(rawConcurrencyConfig.maxConcurrent)
          : concurrencyConfig.maxConcurrent,
      perScopeMaxConcurrent:
        typeof rawConcurrencyConfig.perScopeMaxConcurrent === "number" && rawConcurrencyConfig.perScopeMaxConcurrent > 0
          ? Math.floor(rawConcurrencyConfig.perScopeMaxConcurrent)
          : concurrencyConfig.perScopeMaxConcurrent,
      maxQueueDepth:
        typeof rawConcurrencyConfig.maxQueueDepth === "number" && rawConcurrencyConfig.maxQueueDepth > 0
          ? Math.floor(rawConcurrencyConfig.maxQueueDepth)
          : concurrencyConfig.maxQueueDepth,
      acquireTimeoutMs:
        typeof rawConcurrencyConfig.acquireTimeoutMs === "number" && rawConcurrencyConfig.acquireTimeoutMs > 0
          ? Math.floor(rawConcurrencyConfig.acquireTimeoutMs)
          : concurrencyConfig.acquireTimeoutMs,
      minSpawnIntervalMs:
        typeof rawConcurrencyConfig.minSpawnIntervalMs === "number" && rawConcurrencyConfig.minSpawnIntervalMs >= 0
          ? Math.floor(rawConcurrencyConfig.minSpawnIntervalMs)
          : concurrencyConfig.minSpawnIntervalMs,
    }
  }
  // Apply the loaded concurrency limits to the global gate. This is the only
  // place loadConfig has side-effects on a singleton — it's intentional so
  // that any code path that calls loadConfig (CLI commands, smoke tests,
  // adapters) automatically receives correct concurrency behavior.
  OpenCodeGate.configure({
    maxConcurrent: concurrencyConfig.maxConcurrent,
    perScopeMaxConcurrent: concurrencyConfig.perScopeMaxConcurrent,
    maxQueueDepth: concurrencyConfig.maxQueueDepth,
    acquireTimeoutMs: concurrencyConfig.acquireTimeoutMs,
    minSpawnIntervalMs: concurrencyConfig.minSpawnIntervalMs,
  })
  const config: AutoEvolveConfig = {
    version: typeof raw.version === "number" ? raw.version : DEFAULT_CONFIG.version,
    datasetDir: typeof raw.datasetDir === "string" ? raw.datasetDir : DEFAULT_CONFIG.datasetDir,
    knowledgeDir:
      runtimePaths?.knowledgeDir ??
      (typeof raw.knowledgeDir === "string" ? raw.knowledgeDir : DEFAULT_CONFIG.knowledgeDir),
    experienceArchiveDir:
      typeof raw.experienceArchiveDir === "string" && raw.experienceArchiveDir.trim()
        ? raw.experienceArchiveDir
        : DEFAULT_CONFIG.experienceArchiveDir,
    maintenanceGatewayDir:
      typeof raw.maintenanceGatewayDir === "string" && raw.maintenanceGatewayDir.trim()
        ? raw.maintenanceGatewayDir
        : DEFAULT_CONFIG.maintenanceGatewayDir,
    experienceTransactionDir:
      typeof raw.experienceTransactionDir === "string" && raw.experienceTransactionDir.trim()
        ? raw.experienceTransactionDir
        : DEFAULT_CONFIG.experienceTransactionDir,
    acceptanceFrameworkDir:
      typeof raw.acceptanceFrameworkDir === "string" && raw.acceptanceFrameworkDir.trim()
        ? raw.acceptanceFrameworkDir
        : DEFAULT_CONFIG.acceptanceFrameworkDir,
    experienceEntryFile:
      typeof raw.experienceEntryFile === "string" && raw.experienceEntryFile.trim()
        ? raw.experienceEntryFile
        : DEFAULT_CONFIG.experienceEntryFile,
    templateLibraryDir:
      typeof raw.templateLibraryDir === "string" ? raw.templateLibraryDir : DEFAULT_CONFIG.templateLibraryDir,
    reversePropagationModulesDir:
      typeof raw.reversePropagationModulesDir === "string" && raw.reversePropagationModulesDir.trim()
        ? raw.reversePropagationModulesDir
        : DEFAULT_CONFIG.reversePropagationModulesDir,
    maintenanceOpsDir:
      typeof raw.maintenanceOpsDir === "string" && raw.maintenanceOpsDir.trim()
        ? raw.maintenanceOpsDir
        : DEFAULT_CONFIG.maintenanceOpsDir,
    judgeSkillsDir:
      typeof raw.judgeSkillsDir === "string" && raw.judgeSkillsDir.trim()
        ? raw.judgeSkillsDir
        : DEFAULT_CONFIG.judgeSkillsDir,
    systemPromptsDir:
      typeof raw.systemPromptsDir === "string" && raw.systemPromptsDir.trim()
        ? raw.systemPromptsDir
        : DEFAULT_CONFIG.systemPromptsDir,
    methodsDir: typeof raw.methodsDir === "string" ? raw.methodsDir : DEFAULT_CONFIG.methodsDir,
    propagationDir:
      typeof raw.propagationDir === "string" && raw.propagationDir.trim()
        ? raw.propagationDir
        : DEFAULT_CONFIG.propagationDir,
    propagationMethodsDir:
      typeof raw.propagationMethodsDir === "string" && raw.propagationMethodsDir.trim()
        ? raw.propagationMethodsDir
        : DEFAULT_CONFIG.propagationMethodsDir,
    optimizationDir:
      typeof raw.optimizationDir === "string" && raw.optimizationDir.trim()
        ? raw.optimizationDir
        : DEFAULT_CONFIG.optimizationDir,
    baselineFile: typeof raw.baselineFile === "string" ? raw.baselineFile : DEFAULT_CONFIG.baselineFile,
    splitFile: typeof raw.splitFile === "string" ? raw.splitFile : DEFAULT_CONFIG.splitFile,
    scriptsDir: typeof raw.scriptsDir === "string" ? raw.scriptsDir : DEFAULT_CONFIG.scriptsDir,
    runsDir: runtimePaths?.runsDir ?? (typeof raw.runsDir === "string" ? raw.runsDir : DEFAULT_CONFIG.runsDir),
    modelConfigFile,
    judgeConfigFile,
    permissionConfigFile,
    monitorConfigFile,
    defaultAgent: modelConfig.defaults.agent,
    defaultModel: modelConfig.defaults.model,
    defaultVariant: modelConfig.defaults.variant,
    defaultMethod:
      typeof raw.defaultMethod === "string" && raw.defaultMethod.trim() ? raw.defaultMethod : DEFAULT_CONFIG.defaultMethod,
    defaultPropagationMethod:
      typeof raw.defaultPropagationMethod === "string" && raw.defaultPropagationMethod.trim()
        ? raw.defaultPropagationMethod
        : DEFAULT_CONFIG.defaultPropagationMethod,
    maxRetriesPerCase:
      typeof raw.maxRetriesPerCase === "number" ? raw.maxRetriesPerCase : DEFAULT_CONFIG.maxRetriesPerCase,
    maxMaintenanceRoundsPerAttempt:
      typeof raw.maxMaintenanceRoundsPerAttempt === "number" && raw.maxMaintenanceRoundsPerAttempt > 0
        ? raw.maxMaintenanceRoundsPerAttempt
        : DEFAULT_CONFIG.maxMaintenanceRoundsPerAttempt,
    roundCaseLimit: typeof raw.roundCaseLimit === "number" ? raw.roundCaseLimit : DEFAULT_CONFIG.roundCaseLimit,
    regressionSampleSize:
      typeof raw.regressionSampleSize === "number" ? raw.regressionSampleSize : DEFAULT_CONFIG.regressionSampleSize,
    modelConfigPath,
    modelConfig,
    judgeConfigPath,
    judgeConfig,
    permissionConfigPath,
    permissionConfig,
    monitorConfigPath,
    monitorConfig,
    concurrencyConfigFile,
    concurrencyConfigPath,
    concurrencyConfig,
  }

  return { ...config, configPath }
}

export async function loadAllCases(cwd: string, config: AutoEvolveConfig) {
  const caseDirs = await listCaseDirectories(cwd, config)
  const cases: LoadedCase[] = []

  for (const caseDir of caseDirs) {
    const casePath = caseMetadataPath(caseDir)
    const raw = await readJsonFile(casePath)
    const spec = normalizeCaseSpec(raw, path.basename(caseDir))
    cases.push({ caseDir, casePath, spec })
  }

  return cases.sort((left, right) => left.spec.id.localeCompare(right.spec.id))
}

export async function loadCaseByID(cwd: string, config: AutoEvolveConfig, caseID: string) {
  const cases = await loadAllCases(cwd, config)
  const match = cases.find((item) => item.spec.id === caseID)
  if (!match) throw new Error(`Case not found: ${caseID}`)
  return match
}

export async function validateAllCases(cwd: string, config: AutoEvolveConfig): Promise<ValidationReport> {
  const errors: string[] = []
  const datasetRoot = autoEvolvePath(cwd, config.datasetDir)
  if (!(await pathExists(datasetRoot))) errors.push(`Dataset directory is missing: ${datasetRoot}`)
  const workspace = experienceWorkspacePaths(cwd, config)
  if (!(await pathExists(workspace.root))) {
    errors.push(`Experience workspace directory is missing: ${workspace.root}`)
  } else {
    try {
      const layout = await resolveExperienceWorkspaceLayout(workspace)
      if (!(await pathExists(layout.entryPath))) {
        errors.push(`Experience workspace entry file is missing: ${layout.entryPath}`)
      }
      const workspaceValidation = validateExperienceWorkspaceLayout(layout)
      errors.push(...workspaceValidation.errors.map((item) => `Experience workspace is invalid: ${item}`))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`Experience workspace layout is invalid: ${message}`)
    }
  }
  const templateLibraryRoot = autoEvolvePath(cwd, config.templateLibraryDir)
  if (!(await pathExists(templateLibraryRoot))) {
    errors.push(`Template library directory is missing: ${templateLibraryRoot}`)
  }
  const experienceArchiveRoot = autoEvolvePath(cwd, config.experienceArchiveDir)
  if (!(await pathExists(experienceArchiveRoot))) {
    errors.push(`Experience archive directory is missing: ${experienceArchiveRoot}`)
  }
  const maintenanceGatewayRoot = autoEvolvePath(cwd, config.maintenanceGatewayDir)
  if (!(await pathExists(maintenanceGatewayRoot))) {
    errors.push(`Maintenance gateway directory is missing: ${maintenanceGatewayRoot}`)
  }
  const experienceTransactionRoot = autoEvolvePath(cwd, config.experienceTransactionDir)
  if (!(await pathExists(experienceTransactionRoot))) {
    errors.push(`Experience transaction directory is missing: ${experienceTransactionRoot}`)
  }
  const acceptanceFrameworkRoot = autoEvolvePath(cwd, config.acceptanceFrameworkDir)
  if (!(await pathExists(acceptanceFrameworkRoot))) {
    errors.push(`Acceptance framework directory is missing: ${acceptanceFrameworkRoot}`)
  }
  const propagationRoot = autoEvolvePath(cwd, config.propagationDir)
  if (!(await pathExists(propagationRoot))) {
    errors.push(`Propagation directory is missing: ${propagationRoot}`)
  }
  const propagationMethodsRoot = autoEvolvePath(cwd, config.propagationMethodsDir)
  if (!(await pathExists(propagationMethodsRoot))) {
    errors.push(`Propagation-methods directory is missing: ${propagationMethodsRoot}`)
  }
  const optimizationRoot = autoEvolvePath(cwd, config.optimizationDir)
  if (!(await pathExists(optimizationRoot))) {
    errors.push(`Optimization directory is missing: ${optimizationRoot}`)
  }
  const reversePropagationModulesRoot = autoEvolvePath(cwd, config.reversePropagationModulesDir)
  if (!(await pathExists(reversePropagationModulesRoot))) {
    errors.push(`Reverse-propagation modules directory is missing: ${reversePropagationModulesRoot}`)
  }
  const maintenanceOpsRoot = autoEvolvePath(cwd, config.maintenanceOpsDir)
  if (!(await pathExists(maintenanceOpsRoot))) {
    errors.push(`Maintenance-ops directory is missing: ${maintenanceOpsRoot}`)
  }
  const judgeSkillsRoot = autoEvolvePath(cwd, config.judgeSkillsDir)
  if (!(await pathExists(judgeSkillsRoot))) {
    errors.push(`Judge-skills directory is missing: ${judgeSkillsRoot}`)
  }
  const baselinePath = autoEvolvePath(cwd, config.baselineFile)
  if (!(await pathExists(baselinePath))) errors.push(`Baseline file is missing: ${baselinePath}`)
  const splitPath = autoEvolvePath(cwd, config.splitFile)
  if (!(await pathExists(splitPath))) errors.push(`Dataset split file is missing: ${splitPath}`)
  const methodsRoot = autoEvolvePath(cwd, config.methodsDir)
  if (!(await pathExists(methodsRoot))) errors.push(`Methods directory is missing: ${methodsRoot}`)
  const defaultPropagationMethodPath = autoEvolvePath(
    cwd,
    config.propagationMethodsDir,
    `${config.defaultPropagationMethod}.md`,
  )
  if (!(await pathExists(defaultPropagationMethodPath))) {
    errors.push(`Default propagation method definition is missing: ${defaultPropagationMethodPath}`)
  }
  const systemPromptsRoot = autoEvolvePath(cwd, config.systemPromptsDir)
  if (!(await pathExists(systemPromptsRoot))) {
    errors.push(`System prompts directory is missing: ${systemPromptsRoot}`)
  }
  if (!(await pathExists(config.modelConfigPath))) errors.push(`Model config file is missing: ${config.modelConfigPath}`)
  if (!(await pathExists(config.judgeConfigPath))) errors.push(`Judge config file is missing: ${config.judgeConfigPath}`)
  if (!(await pathExists(config.permissionConfigPath))) {
    errors.push(`Permission config file is missing: ${config.permissionConfigPath}`)
  }
  if (!(await pathExists(config.monitorConfigPath))) {
    errors.push(`Monitor config file is missing: ${config.monitorConfigPath}`)
  }
  const defaultMethodRoot = autoEvolvePath(cwd, config.methodsDir, config.defaultMethod)
  if (!(await pathExists(defaultMethodRoot))) {
    errors.push(`Default method directory is missing: ${defaultMethodRoot}`)
  }
  for (const file of [
    autoEvolvePath(cwd, config.methodsDir, config.defaultMethod, "METHOD.md"),
    autoEvolvePath(cwd, config.methodsDir, config.defaultMethod, "prompts", "bootstrap.md"),
    autoEvolvePath(cwd, config.methodsDir, config.defaultMethod, "prompts", "solve.md"),
    autoEvolvePath(cwd, config.methodsDir, config.defaultMethod, "prompts", "maintain_extension.md"),
    autoEvolvePath(cwd, config.methodsDir, config.defaultMethod, "prompts", "judge_extension.md"),
    autoEvolvePath(cwd, config.systemPromptsDir, "knowledge-maintainer-core.md"),
    autoEvolvePath(cwd, config.systemPromptsDir, "batch-knowledge-maintainer-core.md"),
    autoEvolvePath(cwd, config.systemPromptsDir, "soft-judge-core.md"),
    autoEvolvePath(cwd, config.reversePropagationModulesDir, "direct-rewrite.md"),
    autoEvolvePath(cwd, config.reversePropagationModulesDir, "add-only-memory.md"),
    autoEvolvePath(cwd, config.maintenanceOpsDir, "inspect_workspace.md"),
    autoEvolvePath(cwd, config.maintenanceOpsDir, "append_to_existing_module.md"),
    autoEvolvePath(cwd, config.judgeSkillsDir, "INDEX.md"),
    autoEvolvePath(cwd, config.methodsDir, "add-only", "METHOD.md"),
    autoEvolvePath(cwd, config.methodsDir, "add-only", "prompts", "bootstrap.md"),
    autoEvolvePath(cwd, config.methodsDir, "add-only", "prompts", "solve.md"),
    autoEvolvePath(cwd, config.methodsDir, "add-only", "prompts", "maintain_extension.md"),
    autoEvolvePath(cwd, config.methodsDir, "add-only", "prompts", "judge_extension.md"),
    autoEvolvePath(cwd, config.methodsDir, "parallel-batch-5-add-only", "METHOD.md"),
    autoEvolvePath(cwd, config.methodsDir, "parallel-batch-5-add-only", "FLOW.md"),
    autoEvolvePath(cwd, config.methodsDir, "parallel-batch-5-add-only", "prompts", "bootstrap.md"),
    autoEvolvePath(cwd, config.methodsDir, "parallel-batch-5-add-only", "prompts", "solve.md"),
    autoEvolvePath(cwd, config.methodsDir, "parallel-batch-5-add-only", "prompts", "judge_extension.md"),
    autoEvolvePath(cwd, config.methodsDir, "parallel-batch-5-add-only", "prompts", "batch_maintain_extension.md"),
  ]) {
    if (!(await pathExists(file))) errors.push(`Method file is missing: ${file}`)
  }

  let cases: LoadedCase[] = []
  try {
    cases = await loadAllCases(cwd, config)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(message)
  }

  for (const item of cases) {
    const shapeErrors = validateCaseShape(item.spec)
    errors.push(...shapeErrors)

    for (const material of item.spec.materials) {
      const resolved = path.join(item.caseDir, material.path)
      if (!(await pathExists(resolved))) {
        errors.push(`Case ${item.spec.id}: material file is missing: ${resolved}`)
      }
    }

    const expectedPath = path.join(item.caseDir, item.spec.expected.path)
    if (!(await pathExists(expectedPath))) {
      errors.push(`Case ${item.spec.id}: expected file is missing: ${expectedPath}`)
    } else if (item.spec.expected.mode === "json_exact") {
      try {
        JSON.parse(await readTextFile(expectedPath))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`Case ${item.spec.id}: expected JSON is invalid: ${message}`)
      }
    }
  }

  if (!errors.length || cases.length) {
    try {
      const split = await loadDatasetSplit(cwd, config)
      const caseIDs = new Set(cases.map((item) => item.spec.id))
      const duplicates = split.train.filter((id) => split.test.includes(id))
      for (const id of duplicates) {
        errors.push(`Dataset split duplicates case in both train and test: ${id}`)
      }
      for (const id of [...split.train, ...split.test]) {
        if (!caseIDs.has(id)) {
          errors.push(`Dataset split references unknown case: ${id}`)
        }
      }
      if (!split.train.length) errors.push(`Dataset split has no train cases: ${split.splitPath}`)
      if (!split.test.length) errors.push(`Dataset split has no test cases: ${split.splitPath}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(message)
    }
  }

  return {
    caseCount: cases.length,
    errors,
  }
}
