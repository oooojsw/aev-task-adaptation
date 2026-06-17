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
  supportsImageInputs?: boolean
  supportsFileInputs?: boolean
  imageInputMode?: DirectChatImageInputMode
  fileInputMode?: DirectChatFileInputMode
  timeoutMs?: number
  concurrency?: number
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
  ocrFallback?: {
    enabled?: boolean
    mode?: "local-umi"
    pythonBin?: string
    helperScriptPath?: string
    umiExePath?: string
    pageWindow?: number
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
    action: "kept_text" | "kept_native_asset" | "ocr_fallback"
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
    includedTokens: number
    truncated: boolean
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
  modelIDs?: string[]
  globalConcurrency?: number
  allowOmittedMaterials?: boolean
  includeNoSkillBaseline?: boolean
}

export interface DirectChatCallResult {
  content: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
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
  latencyMs: number
  attempts: number
  error: string | null
  errorCategory?: DirectChatErrorCategory
  skillMode?: "with-skill" | "no-skill"
}
