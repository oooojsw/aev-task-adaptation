import type { BudgetTransportConfig } from "../task-adaptation/budget-transport"

export type DirectChatTransport = "openai-compatible" | "mock"
export type DirectChatImageInputMode = "none" | "openai-image-url"
export type DirectChatFileInputMode = "none" | "openai-file-data" | "siliconflow-image-url-pdf"
export type DirectChatErrorCategory =
  | "none"
  | "auth"
  | "quota"
  | "context_length"
  | "rate_limit"
  | "provider_5xx"
  | "timeout"
  | "network"
  | "bad_request"
  | "parse"
  | "answer_extraction"
  | "validation"
  | "config"
  | "unknown"

export interface DirectChatModelConfig {
  id: string
  provider?: string
  transport: DirectChatTransport
  baseURL?: string
  apiKeyEnv?: string
  apiKey?: string
  opencodeAuthProviderID?: string
  model?: string
  temperature?: number
  maxOutputTokens?: number
  contextWindowTokens?: number
  promptBudgetTokens?: number
  skillBudgetTokens?: number
  materialBudgetTokens?: number
  skillInputMode?: "full" | "head-tail" | "core-files"
  skillHeadRatio?: number
  supportsImageInputs?: boolean
  supportsFileInputs?: boolean
  imageInputMode?: DirectChatImageInputMode
  fileInputMode?: DirectChatFileInputMode
  timeoutMs?: number
  concurrency?: number
  minIntervalMs?: number
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  outputTokenParameter?: "max_tokens" | "max_completion_tokens" | "max_output_tokens"
  mockResponse?: string
  requestBodyExtra?: Record<string, unknown>
}

export interface DirectChatModelsConfig {
  models: Record<string, Omit<DirectChatModelConfig, "id"> & { id?: string }>
  concurrency?: {
    global?: number
  }
  retry?: {
    maxAttempts?: number
    backoffMs?: number
  }
  skillInput?: {
    mode?: "full" | "head-tail" | "core-files"
    headRatio?: number
  }
  defaultRunMode?: string
  runModes?: Record<string, {
    description?: string
    skillMode?: "with-skill" | "no-skill" | "paired"
    skillInputMode?: "full" | "head-tail" | "core-files"
    officeqaMaterialMode?: "native-pdf" | "skillopt-oracle-json"
    allowOmittedMaterials?: boolean
    includeNoSkillBaseline?: boolean
    noSkillOnly?: boolean
    globalConcurrency?: number
  }>
  transientRecovery?: {
    enabled?: boolean
    maxRounds?: number
    delayMs?: number
    categories?: DirectChatErrorCategory[]
  }
  ocrFallback?: {
    enabled?: boolean
    mode?: "local-umi"
    pythonBin?: string
    helperScriptPath?: string
    umiExePath?: string
    pageWindow?: number
    cacheRoot?: string
    pdfRenderDpi?: number
  }
}

export interface DirectChatMessage {
  role: "system" | "user" | "assistant"
  content: string | Array<Record<string, any>>
}

export interface SkillBundleFile {
  path: string
  sha256: string
  bytes: number
}

export interface SkillBundleManifest {
  schema: "skill-bundle-manifest/v1"
  sourceSkillRoot: string
  bundlePath: string
  archiveBundlePath?: string
  publicationMode?: "explicit" | "compiled"
  publicationSha256?: string
  publicationBytes?: number
  publicationTiers?: Array<{
    id: "full" | "core-files"
    path: string
    sha256: string
    bytes: number
    sourceFiles: string[]
  }>
  includedSections?: Array<{ file: string; heading: string }>
  excludedSections?: Array<{ file: string; heading: string; reason: string }>
  files: SkillBundleFile[]
  excludedFiles: string[]
  createdAt: string
}

export interface DirectChatMaterial {
  id: string
  title: string
  type: "text" | "markdown" | "table" | "document_asset" | "image_asset" | "source_pointer"
  content: string
  sourcePathInternal?: string
  metadata?: {
    sourceIndex?: number
    pageHint?: number
    pageWindow?: number
    extractedPages?: number[]
    extractionEngine?: string
    originalCharCount?: number
    truncatedAtExtraction?: boolean
    imagePathInternal?: string
    assetPathInternal?: string
    mimeType?: string
    requiresModelImageCapability?: boolean
    requiresModelFileCapability?: boolean
    ocrFallbackEngine?: string
    ocrSourceMaterialID?: string
    ocrSourcePathInternal?: string
    ocrCachePath?: string
  }
}

export interface DirectChatMaterialRoutingAudit {
  schema: "direct-chat-material-routing-audit/v1"
  caseID: string
  modelID: string
  routes: Array<{
    materialID: string
    title: string
    type: DirectChatMaterial["type"]
    action: "kept_text" | "kept_native_asset" | "rendered_pdf_pages" | "ocr_fallback"
    reason: string
    engine?: string
    cacheHit?: boolean
    cachePath?: string
    outputMaterialID?: string
  }>
}

export interface DirectChatValidatorOracle {
  validatorID: string
  runner?: string
  scriptPath?: string
  args?: string[]
  candidateArgName?: string
  answerPath?: string
  rewardPath?: string
  tolerance?: number
}

export interface DirectChatCaseBundle {
  schema: "direct-chat-case/v1"
  caseID: string
  dataset: string
  split: string
  taskRoot?: string
  question: {
    text: string
    answerFormat?: string
    outputInstruction: string
  }
  materials: DirectChatMaterial[]
  privateOracle?: DirectChatValidatorOracle
  materialAudit: DirectChatMaterialAudit
  metadata?: Record<string, unknown>
}

export interface DirectChatPromptAudit {
  schema: "direct-chat-prompt-audit/v1"
  caseID: string
  modelID: string
  promptBudgetTokens: number
  estimatedPromptTokens: number
  skill: {
    originalTokens: number
    sanitizedTokens?: number
    includedTokens: number
    truncated: boolean
    selectionTruncated?: boolean
    sourceOriginalTokens?: number
    tier?: string
    sha256?: string
  }
  materials: Array<{
    id: string
    title: string
    type: string
    originalTokens: number
    includedTokens: number
    truncated: boolean
    pageHint?: number
    extractedPages?: number[]
  }>
  warnings: string[]
}

export interface DirectChatMaterialAudit {
  caseID: string
  expectedSources: string[]
  includedMaterials: string[]
  omittedSources: string[]
  warnings: string[]
  tokenEstimate: number
  compressionPolicy: string
}

export interface DirectChatDatasetManifest {
  schema: "direct-chat-dataset-manifest/v1"
  dataset: string
  split: string
  caseCount: number
  bundlePath: string
  privateAnswerRoot?: string
  materialAuditSummary: {
    casesWithOmittedSources: number
    casesWithWarnings: number
  }
  createdAt: string
}

export interface DirectChatRunConfig {
  skillBundlePath: string
  datasetBundlePath: string
  outDir: string
  models: DirectChatModelsConfig
  runModeID?: string
  runModeDescription?: string
  modelIDs?: string[]
  caseIDs?: string[]
  globalConcurrency?: number
  allowOmittedMaterials?: boolean
  includeNoSkillBaseline?: boolean
  noSkillOnly?: boolean
  /** Reuse completed per-case result.json files in outDir after interruption. */
  resumeExisting?: boolean
  skillInputMode?: "full" | "head-tail" | "core-files"
  preflightOnly?: boolean
  /** Keep legacy reports unchanged unless an internal trusted evaluation opts out. */
  updateMasterReport?: boolean
  /** Host-owned explicit per-run request budget transport to prevent process.env cross-campaign contention */
  requestBudgetTransport?: BudgetTransportConfig
  enforceRequestBudget?: boolean
}

export interface DirectChatCallResult {
  content: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    totalTokens?: number
  }
  resolvedModel?: string
  finishReason?: string
  raw?: unknown
}

export interface DirectChatCaseResult {
  schema: "direct-chat-result/v1"
  caseID: string
  modelID: string
  provider?: string
  passed: boolean
  score: number
  answer: string
  rawResponsePath: string
  validatorResultPath?: string
  usage?: DirectChatCallResult["usage"]
  resolvedModel?: string
  finishReason?: string
  responseAuditPath?: string
  requestAuditPath?: string
  outputBudgetExceeded?: boolean
  latencyMs: number
  attempts: number
  error: string | null
  errorCategory?: DirectChatErrorCategory
  skillMode?: "with-skill" | "no-skill"
  skillTier?: "full" | "head-tail" | "core-files" | "custom" | "none"
  skillHash?: string
}
