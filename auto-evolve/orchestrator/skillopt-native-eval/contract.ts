export type SkillOptNativeSplit = "train" | "valid_seen" | "valid_unseen" | "all"

export interface SkillOptNativeEvalConfig {
  enabled: boolean
  projectRoot: string
  configPath: string
  pythonCommand: string
  splitDir: string
  dataDirs: string[]
  targetBackend: string
  targetModel: string
  targetBaseUrl: string
  /** Optional OpenCode auth snapshot. When set, its provider key takes precedence over the ambient environment. */
  targetAuthFile: string
  targetAuthProviderID: string
  targetApiKeyEnv: string
  reasoningEffort: string
  workers: number
  timeoutMs: number
}

export interface SkillOptNativeEvalInput {
  config: SkillOptNativeEvalConfig
  skillPath: string
  split: SkillOptNativeSplit
  caseIDs?: string[]
  outDir: string
  runtimeScope?: string
  env?: NodeJS.ProcessEnv
}

export interface SkillOptNativeCaseResult {
  id: string
  hard: number
  soft: number
  passed: boolean
  failReason?: string
  agentOK?: boolean
}

export interface SkillOptNativeEvalResult {
  schema: "auto-evolve/skillopt-native-eval-result/v1"
  passed: number
  total: number
  failed: number
  skipped: number
  hard: number
  soft: number
  regressions: string[]
  durationMs: number
  nativeRunDir: string
  nativeSummaryPath: string
  nativeResultsPath: string
  cases: SkillOptNativeCaseResult[]
}
