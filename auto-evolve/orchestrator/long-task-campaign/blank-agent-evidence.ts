import path from "node:path"
import { mkdir, readdir, stat, readFile, writeFile, access } from "node:fs/promises"
import { constants } from "node:fs"
import type { LongTaskSpec } from "../long-task/contract"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BlankAgentEvidenceBundle {
  schema: "blank-agent-evidence/v1"
  createdAt: string
  campaignID: string
  roundNumber: number
  passID: string
  sourceRunID?: string

  finalAcceptanceResultPath: string

  blankEval: {
    runDir?: string
    resultPath?: string
    validationStageResultPath?: string
    sessionDir?: string
    sessionExecutionReportPath?: string
  }

  compactArtifacts: {
    executionCompactPath: string
    toolCallsCompactPath: string
    validationTrainingCompactPath: string
    workspaceFilesManifestPath: string
  }

  exactArtifacts: {
    sessionArtifactPaths: string[]
    validationTrainingViewPaths: string[]
    workspaceTextFilePaths: string[]
    finalAcceptancePaths: string[]
  }

  readablePaths: string[]

  blockedRefs: Array<{
    ref: string
    reason: string
  }>
}

export interface WriteBlankAgentEvidenceInput {
  cwd: string
  campaignID: string
  campaignRoot: string
  roundNumber: number
  passID: string
  sourceRunID?: string
  baseSpec: LongTaskSpec
  acceptanceRoot: string
  acceptanceResultPath: string
  finalAcceptance: {
    passed: boolean
    summary: string
    validatorResults: Array<{
      validatorID: string
      passed: boolean
      evidenceRefs?: string[]
      rawOutputPath?: string
    }>
    blankEvalRunDir?: string
    blankEvalResultPath?: string
    blankEvalValidationStageResultPath?: string
    blankEvalSessionDir?: string
    blankEvalSessionExecutionReportPath?: string
  }
}

export interface WriteBlankAgentEvidenceResult {
  bundle: BlankAgentEvidenceBundle
  bundlePath: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".jsonl", ".csv", ".tsv",
  ".log", ".yaml", ".yml", ".xml", ".html", ".htm",
  ".py", ".js", ".ts", ".mjs", ".cjs", ".ps1", ".sh",
])

const BINARY_OR_BULKY_EXTENSIONS = new Set([
  ".pdf", ".docx", ".xlsx", ".xls", ".pptx", ".zip",
  ".7z", ".rar", ".png", ".jpg", ".jpeg", ".webp", ".gif",
  ".bin", ".sqlite", ".db",
])

const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2 MB

const SESSION_ARTIFACT_FILES = [
  "prompt.txt", "stdout.log", "stderr.log", "response.txt",
  "action_trace.md", "session_execution_report.md",
  "session_learning_log.md", "session_task_manifest.md",
  "events.json", "tool_failures.json", "run.json",
  "opencode_process_log.txt",
]

// ─── Path helpers ────────────────────────────────────────────────────────────

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/")
}

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return !rel.startsWith("..") && rel !== ""
}

async function safeExactFile(candidate: string, allowedRoots: string[]): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK)
  } catch {
    return false
  }
  const absolute = path.resolve(candidate)
  const normalized = absolute.replace(/\\/g, "/").toLowerCase()

  if (!allowedRoots.some((root) => isPathInside(path.resolve(root), absolute))) return false

  if (normalized.includes("/private-answers/")) return false
  if (normalized.includes("/answer-key")) return false
  if (normalized.includes("/ground-truth")) return false
  if (normalized.includes("/hidden")) return false
  if (normalized.endsWith("/result.private.json")) return false

  const s = await stat(absolute).catch(() => undefined)
  if (!s?.isFile()) return false
  if (s.size > MAX_FILE_SIZE) return false

  return true
}

function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return TEXT_EXTENSIONS.has(ext) && !BINARY_OR_BULKY_EXTENSIONS.has(ext)
}

// ─── Session artifact collection ─────────────────────────────────────────────

function blankEvalSessionArtifactFiles(sessionExecutionReportPath: string): string[] {
  const sessionDir = path.dirname(sessionExecutionReportPath)
  return SESSION_ARTIFACT_FILES.map((f) => path.join(sessionDir, f))
}

// ─── Training view collection ────────────────────────────────────────────────

function isAllowedTrainingView(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase()
  if (!normalized.endsWith("result.training.json")) return false
  if (normalized.includes("/result.private.json")) return false
  if (normalized.includes("/private-answers/")) return false
  if (normalized.includes("/ground-truth")) return false
  if (normalized.includes("/answer-key")) return false
  return true
}

async function collectTrainingViews(validatorResults: WriteBlankAgentEvidenceInput["finalAcceptance"]["validatorResults"]): Promise<string[]> {
  const views: string[] = []
  for (const vr of validatorResults) {
    for (const ref of (vr.evidenceRefs ?? [])) {
      if (isAllowedTrainingView(ref)) {
        try {
          await access(ref, constants.F_OK)
          views.push(ref)
        } catch { /* skip */ }
      }
    }
    if (vr.rawOutputPath && isAllowedTrainingView(vr.rawOutputPath)) {
      try {
        await access(vr.rawOutputPath, constants.F_OK)
        views.push(vr.rawOutputPath)
      } catch { /* skip */ }
    }
  }
  return Array.from(new Set(views))
}

// ─── Workspace text file scanning ────────────────────────────────────────────

function resolveEditableAndTargetRoots(spec: LongTaskSpec): string[] {
  const roots: string[] = []
  for (const item of (spec.editablePaths ?? [])) {
    roots.push(path.resolve(item))
  }
  for (const item of (spec.targetPaths ?? [])) {
    if (item.path) roots.push(path.resolve(item.path))
  }
  return Array.from(new Set(roots))
}

async function scanWorkspaceTextFiles(editableAndTargetRoots: string[], allowedRoots: string[]): Promise<{ textFiles: string[]; blocked: Array<{ ref: string; reason: string }> }> {
  const textFiles: string[] = []
  const blocked: Array<{ ref: string; reason: string }> = []

  const scanDirs: string[] = []
  const scanFiles: string[] = []

  for (const root of editableAndTargetRoots) {
    try {
      const s = await stat(root)
      if (s.isDirectory()) {
        scanDirs.push(root)
      } else if (s.isFile()) {
        scanFiles.push(root)
        scanDirs.push(path.dirname(root))
      }
    } catch { /* path doesn't exist, try parent */
      const parent = path.dirname(root)
      try {
        const ps = await stat(parent)
        if (ps.isDirectory()) scanDirs.push(parent)
      } catch { /* skip */ }
    }
  }

  // Collect all candidate files from scanDirs
  const candidates = new Set<string>()
  for (const dir of scanDirs) {
    const found = await scanDirRecursively(dir)
    for (const f of found) candidates.add(f)
  }
  for (const f of scanFiles) candidates.add(f)

  for (const candidate of candidates) {
    const ext = path.extname(candidate).toLowerCase()
    if (BINARY_OR_BULKY_EXTENSIONS.has(ext)) {
      blocked.push({ ref: normalizeSlashes(candidate), reason: "binary file extension" })
      continue
    }
    if (!isTextFile(candidate)) {
      continue // skip unknown extensions silently
    }
    try {
      const s = await stat(candidate)
      if (!s.isFile()) continue
      if (s.size > MAX_FILE_SIZE) {
        blocked.push({ ref: normalizeSlashes(candidate), reason: `file too large (${s.size} bytes > ${MAX_FILE_SIZE})` })
        continue
      }
    } catch { continue }

    if (await safeExactFile(candidate, allowedRoots)) {
      textFiles.push(candidate)
    }
  }

  return { textFiles: Array.from(new Set(textFiles)), blocked }
}

async function scanDirRecursively(dir: string, depth = 0): Promise<string[]> {
  if (depth > 8) return []
  const files: string[] = []
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch { return [] }

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".opencode" || entry.name === ".runtime") continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await scanDirRecursively(full, depth + 1))
    } else {
      files.push(full)
    }
  }
  return files
}

// ─── Compact tool-calls generation ───────────────────────────────────────────

interface CompactToolCall {
  index: number
  eventType: string
  tool?: string
  status?: string
  callID?: string
  title?: string
  inputPreview?: string
  outputPreview?: string
  errorPreview?: string
  pathRefs: string[]
}

function extractPathRefs(value: unknown): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "")
  // Match Windows paths (C:\...) and Unix paths (/... or ./... or ../...)
  const matches = text.match(/[A-Za-z]:[\\/][^"'`\r\n<>|]+|(?:\.{0,2}[\\/])?[\w .()-]+(?:[\\/][\w .()[\]-]+)+/g) ?? []
  return Array.from(new Set(matches.map((item) => normalizeSlashes(item.trim()))))
}

async function collectPathRefsFromEvents(eventsPath: string): Promise<CompactToolCall[]> {
  let raw: string
  try {
    raw = (await readFile(eventsPath, "utf8")).toString()
  } catch { return [] }

  let events: Array<{ type?: string; [k: string]: unknown }>
  try {
    events = JSON.parse(raw)
  } catch { return [] }

  if (!Array.isArray(events)) return []

  const calls: CompactToolCall[] = []
  let index = 0
  for (const evt of events) {
    index++
    const call: CompactToolCall = {
      index,
      eventType: String(evt.type ?? "unknown"),
    }

    if (evt.type === "tool_use") {
      call.tool = String(evt.name ?? "")
      call.callID = String(evt.id ?? "")
      const inputStr = typeof evt.input === "string" ? evt.input : JSON.stringify(evt.input ?? "")
      call.inputPreview = inputStr.length > 2000 ? inputStr.substring(0, 2000) + "..." : inputStr
      call.pathRefs = extractPathRefs(evt.input)
    } else if (evt.type === "tool_result") {
      call.tool = String(evt.tool_name ?? evt.tool ?? "")
      call.callID = String(evt.tool_use_id ?? "")
      call.status = typeof evt.is_error === "boolean" ? (evt.is_error ? "error" : "success") : undefined
      const contentStr = typeof evt.content === "string" ? evt.content : JSON.stringify(evt.content ?? "")
      call.outputPreview = contentStr.length > 2000 ? contentStr.substring(0, 2000) + "..." : contentStr
      call.pathRefs = extractPathRefs(evt.content)
      if (evt.error) {
        const errStr = typeof evt.error === "string" ? evt.error : JSON.stringify(evt.error)
        call.errorPreview = errStr.length > 2000 ? errStr.substring(0, 2000) + "..." : errStr
        call.pathRefs.push(...extractPathRefs(evt.error))
      }
    } else if (evt.type === "text") {
      const textStr = String(evt.text ?? "")
      if (textStr.length > 200) {
        call.inputPreview = textStr.substring(0, 200) + "..."
      }
      call.pathRefs = extractPathRefs(evt.text)
    }

    call.pathRefs = Array.from(new Set(call.pathRefs))
    calls.push(call)
  }

  return calls
}

// ─── Compact execution document ──────────────────────────────────────────────

function buildExecutionCompactMd(bundle: BlankAgentEvidenceBundle, finalAcceptance: WriteBlankAgentEvidenceInput["finalAcceptance"]): string {
  const lines = [
    "# Blank Agent Execution Evidence",
    "",
    "## Final Acceptance",
    `- result: ${bundle.finalAcceptanceResultPath}`,
    `- passed: ${finalAcceptance.passed}`,
    `- summary: ${finalAcceptance.summary}`,
    "",
    "## Blank Eval",
    `- runDir: ${bundle.blankEval.runDir ?? "(not available)"}`,
    `- resultPath: ${bundle.blankEval.resultPath ?? "(not available)"}`,
    `- validationStageResultPath: ${bundle.blankEval.validationStageResultPath ?? "(not available)"}`,
    `- sessionDir: ${bundle.blankEval.sessionDir ?? "(not available)"}`,
    `- sessionExecutionReportPath: ${bundle.blankEval.sessionExecutionReportPath ?? "(not available)"}`,
    "",
    "## How to read this evidence",
    "1. Start with validation-training.compact.json.",
    "2. Then read tool-calls.compact.json.",
    "3. Then open exact session artifacts or workspace text files only when needed.",
    "",
    "## Key Session Artifacts",
  ]

  for (const p of bundle.exactArtifacts.sessionArtifactPaths) {
    lines.push(`- ${path.basename(p)}: ${normalizeSlashes(p)}`)
  }

  lines.push("")
  lines.push("## Workspace Text Files Created By Blank Agent")
  if (bundle.exactArtifacts.workspaceTextFilePaths.length > 0) {
    for (const p of bundle.exactArtifacts.workspaceTextFilePaths) {
      lines.push(`- ${normalizeSlashes(p)}`)
    }
  } else {
    lines.push("- (none detected)")
  }

  if (bundle.blockedRefs.length > 0) {
    lines.push("")
    lines.push("## Blocked Refs")
    for (const b of bundle.blockedRefs.slice(0, 20)) {
      lines.push(`- ref: ${b.ref}`)
      lines.push(`  reason: ${b.reason}`)
    }
  }

  return lines.join("\n") + "\n"
}

// ─── Validation-training compact ─────────────────────────────────────────────

interface ValidationTrainingCompact {
  schema: "validation-training-compact/v1"
  views: Array<{
    path: string
    validatorID: string
    passed: boolean
    summary: string
    detailsPreview: string[]
    evidenceRefs: string[]
  }>
}

async function buildValidationTrainingCompact(validatorResults: WriteBlankAgentEvidenceInput["finalAcceptance"]["validatorResults"]): Promise<ValidationTrainingCompact> {
  const views: ValidationTrainingCompact["views"] = []

  for (const vr of validatorResults) {
    const trainingPath = vr.evidenceRefs?.find(isAllowedTrainingView)
    if (!trainingPath) continue

    let content: Record<string, unknown> = {}
    try {
      const raw = (await readFile(trainingPath, "utf8")).toString().replace(/^﻿/, "")
      content = JSON.parse(raw)
    } catch { continue }

    const details: unknown[] = Array.isArray(content.details) ? content.details : []
    const detailsPreview = details.slice(0, 5).map((d) => {
      const s = typeof d === "string" ? d : JSON.stringify(d)
      return s.length > 500 ? s.substring(0, 500) + "..." : s
    })

    const evidenceRefs: string[] = (Array.isArray(content.evidence_refs) || Array.isArray(content.evidenceRefs)
      ? (content.evidence_refs ?? content.evidenceRefs)
      : []
    ).map((r: unknown) => normalizeSlashes(String(r)))

    views.push({
      path: normalizeSlashes(trainingPath),
      validatorID: vr.validatorID,
      passed: !!content.passed,
      summary: String(content.summary ?? content.message ?? "").substring(0, 500),
      detailsPreview,
      evidenceRefs,
    })
  }

  return { schema: "validation-training-compact/v1", views }
}

// ─── Workspace files manifest ────────────────────────────────────────────────

interface WorkspaceFilesManifest {
  schema: "workspace-files-manifest/v1"
  files: Array<{ path: string; size: number }>
  blocked: Array<{ ref: string; reason: string }>
}

// ─── Main write function ─────────────────────────────────────────────────────

export async function writeBlankAgentEvidenceBundle(input: WriteBlankAgentEvidenceInput): Promise<WriteBlankAgentEvidenceResult> {
  const now = new Date().toISOString()
  const evidenceRoot = path.join(input.campaignRoot, "blank-agent-evidence")
  const roundEvidenceRoot = path.join(evidenceRoot, "rounds", `round-${String(input.roundNumber).padStart(3, "0")}`, input.passID)

  await mkdir(roundEvidenceRoot, { recursive: true })

  const bundle: BlankAgentEvidenceBundle = {
    schema: "blank-agent-evidence/v1",
    createdAt: now,
    campaignID: input.campaignID,
    roundNumber: input.roundNumber,
    passID: input.passID,
    sourceRunID: input.sourceRunID,
    finalAcceptanceResultPath: normalizeSlashes(input.acceptanceResultPath),
    blankEval: {
      runDir: input.finalAcceptance.blankEvalRunDir ? normalizeSlashes(input.finalAcceptance.blankEvalRunDir) : undefined,
      resultPath: input.finalAcceptance.blankEvalResultPath ? normalizeSlashes(input.finalAcceptance.blankEvalResultPath) : undefined,
      validationStageResultPath: input.finalAcceptance.blankEvalValidationStageResultPath ? normalizeSlashes(input.finalAcceptance.blankEvalValidationStageResultPath) : undefined,
      sessionDir: input.finalAcceptance.blankEvalSessionDir ? normalizeSlashes(input.finalAcceptance.blankEvalSessionDir) : undefined,
      sessionExecutionReportPath: input.finalAcceptance.blankEvalSessionExecutionReportPath ? normalizeSlashes(input.finalAcceptance.blankEvalSessionExecutionReportPath) : undefined,
    },
    compactArtifacts: {
      executionCompactPath: "",
      toolCallsCompactPath: "",
      validationTrainingCompactPath: "",
      workspaceFilesManifestPath: "",
    },
    exactArtifacts: {
      sessionArtifactPaths: [],
      validationTrainingViewPaths: [],
      workspaceTextFilePaths: [],
      finalAcceptancePaths: [normalizeSlashes(input.acceptanceResultPath)],
    },
    readablePaths: [],
    blockedRefs: [],
  }

  // 1. Session artifacts
  if (input.finalAcceptance.blankEvalSessionExecutionReportPath) {
    const candidates = blankEvalSessionArtifactFiles(input.finalAcceptance.blankEvalSessionExecutionReportPath)
    const allowedRoots = [
      input.campaignRoot,
      input.acceptanceRoot,
      ...(input.finalAcceptance.blankEvalRunDir ? [input.finalAcceptance.blankEvalRunDir] : []),
      ...(input.finalAcceptance.blankEvalSessionDir ? [input.finalAcceptance.blankEvalSessionDir] : []),
    ].map((r) => path.resolve(r))

    for (const c of candidates) {
      try {
        await access(c, constants.F_OK)
        bundle.exactArtifacts.sessionArtifactPaths.push(normalizeSlashes(c))
      } catch { /* file doesn't exist */ }
    }
  }

  // 2. Training views
  const trainingViews = await collectTrainingViews(input.finalAcceptance.validatorResults)
  bundle.exactArtifacts.validationTrainingViewPaths = trainingViews.map(normalizeSlashes)

  // 3. Workspace text files
  const editableAndTargetRoots = resolveEditableAndTargetRoots(input.baseSpec)
  const allowedRootsForWorkspace = [
    input.campaignRoot,
    input.acceptanceRoot,
    ...(input.finalAcceptance.blankEvalRunDir ? [input.finalAcceptance.blankEvalRunDir] : []),
    ...(input.finalAcceptance.blankEvalSessionDir ? [input.finalAcceptance.blankEvalSessionDir] : []),
    ...editableAndTargetRoots,
    evidenceRoot,
  ].map((r) => path.resolve(r))

  const { textFiles, blocked: workspaceBlocked } = await scanWorkspaceTextFiles(editableAndTargetRoots, allowedRootsForWorkspace)
  bundle.exactArtifacts.workspaceTextFilePaths = textFiles.map(normalizeSlashes)
  bundle.blockedRefs.push(...workspaceBlocked)

  // 4. Collect compact tool-calls from events
  const eventsPath = input.finalAcceptance.blankEvalSessionDir
    ? path.join(input.finalAcceptance.blankEvalSessionDir, "events.json")
    : undefined
  let compactToolCalls: CompactToolCall[] = []
  if (eventsPath) {
    try {
      await access(eventsPath, constants.F_OK)
      compactToolCalls = await collectPathRefsFromEvents(eventsPath)
    } catch { /* no events file */ }
  }

  // 5. Build validation-training compact
  const trainingCompact = await buildValidationTrainingCompact(input.finalAcceptance.validatorResults)

  // 6. Write compact artifacts
  const executionCompactPath = path.join(roundEvidenceRoot, "execution.compact.md")
  const toolCallsCompactPath = path.join(roundEvidenceRoot, "tool-calls.compact.json")
  const validationTrainingCompactPath = path.join(roundEvidenceRoot, "validation-training.compact.json")
  const workspaceFilesManifestPath = path.join(roundEvidenceRoot, "workspace-files.manifest.json")

  await writeFile(executionCompactPath, buildExecutionCompactMd(bundle, input.finalAcceptance), "utf8")
  await writeFile(toolCallsCompactPath, JSON.stringify(compactToolCalls, null, 2) + "\n", "utf8")
  await writeFile(validationTrainingCompactPath, JSON.stringify(trainingCompact, null, 2) + "\n", "utf8")

  const manifest: WorkspaceFilesManifest = {
    schema: "workspace-files-manifest/v1",
    files: textFiles.map((f) => ({ path: normalizeSlashes(f), size: 0 })),
    blocked: workspaceBlocked,
  }
  // Fill sizes
  for (const item of manifest.files) {
    try {
      const s = await stat(item.path)
      item.size = s.size
    } catch { /* skip */ }
  }
  await writeFile(workspaceFilesManifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8")

  bundle.compactArtifacts = {
    executionCompactPath: normalizeSlashes(executionCompactPath),
    toolCallsCompactPath: normalizeSlashes(toolCallsCompactPath),
    validationTrainingCompactPath: normalizeSlashes(validationTrainingCompactPath),
    workspaceFilesManifestPath: normalizeSlashes(workspaceFilesManifestPath),
  }

  // 7. Build readablePaths
  const bundlePath = path.join(roundEvidenceRoot, "bundle.json")
  const readable = new Set<string>()
  readable.add(normalizeSlashes(bundlePath))
  readable.add(bundle.compactArtifacts.executionCompactPath)
  readable.add(bundle.compactArtifacts.toolCallsCompactPath)
  readable.add(bundle.compactArtifacts.validationTrainingCompactPath)
  readable.add(bundle.compactArtifacts.workspaceFilesManifestPath)
  for (const p of bundle.exactArtifacts.sessionArtifactPaths) readable.add(p)
  for (const p of bundle.exactArtifacts.validationTrainingViewPaths) readable.add(p)
  for (const p of bundle.exactArtifacts.workspaceTextFilePaths) readable.add(p)
  for (const p of bundle.exactArtifacts.finalAcceptancePaths) readable.add(p)

  bundle.readablePaths = Array.from(readable)

  // 8. Assert no directories in readablePaths
  assertNoDirectoryReadPaths(bundle.readablePaths, "blank-agent-evidence readablePaths")

  // 9. Write bundle
  await writeFile(bundlePath, JSON.stringify(bundle, null, 2) + "\n", "utf8")

  // 10. Update campaign-level latest
  const latestDir = path.join(evidenceRoot)
  await mkdir(latestDir, { recursive: true })
  await writeFile(path.join(latestDir, "latest.json"), JSON.stringify(bundle, null, 2) + "\n", "utf8")

  const indexPath = path.join(latestDir, "index.jsonl")
  const indexEntry = JSON.stringify({
    createdAt: now,
    roundNumber: input.roundNumber,
    passID: input.passID,
    passed: input.finalAcceptance.passed,
    bundlePath: normalizeSlashes(bundlePath),
  }) + "\n"
  try {
    const existing = (await readFile(indexPath, "utf8")).toString()
    await writeFile(indexPath, existing + indexEntry, "utf8")
  } catch {
    await writeFile(indexPath, indexEntry, "utf8")
  }

  return { bundle, bundlePath: normalizeSlashes(bundlePath) }
}

// ─── Read helpers ────────────────────────────────────────────────────────────

export async function readLatestBlankAgentEvidenceBundlePath(campaignRoot: string): Promise<string | undefined> {
  const latestPath = path.resolve(campaignRoot, "blank-agent-evidence", "latest.json")
  try {
    await access(latestPath, constants.F_OK)
    return normalizeSlashes(latestPath)
  } catch {
    return undefined
  }
}

export async function readBlankAgentEvidenceReadablePaths(bundlePath: string): Promise<string[]> {
  try {
    const raw = (await readFile(bundlePath, "utf8")).toString().replace(/^﻿/, "")
    const bundle: BlankAgentEvidenceBundle = JSON.parse(raw)
    return bundle.readablePaths ?? []
  } catch (err) {
    console.error("[readBlankAgentEvidenceReadablePaths] failed for", bundlePath, (err as Error).message)
    return []
  }
}

export function normalizeEvidencePathForPrompt(pathValue: string): string {
  return normalizeSlashes(pathValue)
}

// ─── Assertion ───────────────────────────────────────────────────────────────

export function assertNoDirectoryReadPaths(paths: string[], label: string) {
  const knownUnsafeDirs = [
    "blank-eval-runs",
    "clean-skill-roots",
    "validation-expert-workspace",
    "validators",
    "private-answers",
    "ground-truth",
    "answer-key",
  ]
  for (const p of paths) {
    const normalized = p.replace(/\\/g, "/").toLowerCase()

    // Check each path segment for known unsafe directories
    const segments = normalized.split("/")
    for (const unsafe of knownUnsafeDirs) {
      if (segments.includes(unsafe)) {
        // Only block validators/ as a directory (not for result.training.json which is the allowed training view)
        if (unsafe === "validators" && normalized.endsWith("result.training.json")) continue
        // Only block private-answers/ground-truth/answer-key as directories
        if (unsafe === "private-answers" || unsafe === "ground-truth" || unsafe === "answer-key") {
          throw new Error(`${unsafe} leaked: ${p}`)
        }
        // For blank-eval-runs, clean-skill-roots, validation-expert-workspace, validators: only block if it IS a directory
        // (heuristic: the path doesn't have a file extension, OR the last segment is a known dir name)
        const lastSegment = segments[segments.length - 1]
        if (lastSegment === unsafe || !lastSegment.includes(".")) {
          throw new Error(`Unsafe evidence read directory (${unsafe}): ${p}`)
        }
      }
    }

    if (normalized.endsWith("result.private.json")) throw new Error(`Private view leaked: ${p}`)
  }
}
