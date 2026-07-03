import path from "node:path"
import { readdir, readFile, stat } from "node:fs/promises"

type JsonObject = Record<string, unknown>
type Severity = "block" | "warn"

interface PatternRule {
  id?: string
  label?: string
  pattern: string
  flags?: string[]
  severity?: Severity | "blocking" | "warning"
  message?: string
}

interface ContextRule {
  id?: string
  label?: string
  triggerPattern: string
  contextPattern: string
  window?: number
  windowWords?: number
  flags?: string[]
  severity?: Severity | "blocking" | "warning"
  message?: string
}

interface LiteralRule {
  id?: string
  label?: string
  value: string
  severity?: Severity | "blocking" | "warning"
  message?: string
}

type LiteralLike = string | LiteralRule

interface SurfaceProfile {
  id?: string
  rootRoles?: string[]
  rootLabels?: string[]
  rootPaths?: string[]
  allowedExtensions?: string[]
  ignorePathSubstrings?: string[]
  maxDepth?: number
  maxHitsPerFile?: number
  maxTotalHits?: number
  maxWarningsBeforeBlocking?: number
  forbiddenLiterals?: LiteralLike[]
  forbiddenPatterns?: PatternRule[]
  contextualForbidden?: ContextRule[]
  paperSpecificTerms?: LiteralLike[]
  paperSpecificTermSeverity?: Severity
}

interface Hit {
  severity: "block" | "warn"
  kind: string
  label: string
  file: string
  line: number
  evidence: string
  message: string
}

const DEFAULT_ALLOWED_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".py",
  ".ps1",
  ".sh",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
]

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function normalizeLower(input: string) {
  return normalizeSlash(input).toLowerCase()
}

function isObject(input: unknown): input is JsonObject {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function stringList(input: unknown) {
  if (!Array.isArray(input)) return []
  return input.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

async function readJson(filePath: string) {
  const raw = await readFile(filePath, "utf8")
  return JSON.parse(raw.replace(/^\uFEFF/, "")) as JsonObject
}

function parseArgs(argv: string[]) {
  const [, , payloadPath, ...rest] = argv
  let profilePath: string | undefined
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--profile") {
      profilePath = rest[i + 1]
      i += 1
    }
  }
  return { payloadPath, profilePath }
}

async function isDirectory(filePath: string) {
  try {
    return (await stat(filePath)).isDirectory()
  } catch {
    return false
  }
}

function resolveRoots(payload: JsonObject, profile: SurfaceProfile, profileDir: string) {
  const rootRoles = profile.rootRoles?.length ? profile.rootRoles : ["experience-workspace"]
  const rootLabels = profile.rootLabels ?? []
  const roots: string[] = []

  for (const rawRoot of profile.rootPaths ?? []) {
    if (!rawRoot.trim()) continue
    roots.push(path.isAbsolute(rawRoot) ? rawRoot : path.resolve(profileDir, rawRoot))
  }

  const targetPaths = Array.isArray(payload.targetPaths) ? payload.targetPaths : []
  for (const item of targetPaths) {
    if (!isObject(item)) continue
    const rawPath = typeof item.path === "string" ? item.path : undefined
    if (!rawPath?.trim()) continue
    const role = typeof item.role === "string" ? item.role : undefined
    const label = typeof item.label === "string" ? item.label : undefined
    if ((role && rootRoles.includes(role)) || (label && rootLabels.includes(label))) {
      roots.push(path.resolve(rawPath))
    }
  }

  return Array.from(new Set(roots.map((item) => path.resolve(item))))
}

function shouldIgnore(filePath: string, profile: SurfaceProfile) {
  const normalized = normalizeLower(filePath)
  return (profile.ignorePathSubstrings ?? []).some((item) => normalized.includes(normalizeLower(item)))
}

async function collectFiles(root: string, current: string, profile: SurfaceProfile, depth = 0): Promise<string[]> {
  if (depth > (profile.maxDepth ?? 8)) return []
  const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  const allowed = new Set(profile.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS)
  for (const entry of entries) {
    const absolute = path.join(current, entry.name)
    if (shouldIgnore(absolute, profile)) continue
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(root, absolute, profile, depth + 1)))
      continue
    }
    if (!entry.isFile()) continue
    if (!allowed.has(path.extname(entry.name).toLowerCase())) continue
    out.push(absolute)
  }
  return out.sort((left, right) => left.localeCompare(right))
}

async function readText(filePath: string) {
  try {
    return await readFile(filePath, "utf8")
  } catch {
    return await readFile(filePath, { encoding: "utf8" })
  }
}

function compilePattern(pattern: string, flags: string[] | undefined) {
  let flagText = ""
  const normalized = new Set((flags ?? []).map((item) => item.toUpperCase()))
  if (normalized.has("IGNORECASE") || normalized.has("I")) flagText += "i"
  if (normalized.has("MULTILINE") || normalized.has("M")) flagText += "m"
  if (normalized.has("DOTALL") || normalized.has("S")) flagText += "s"
  return new RegExp(pattern, flagText)
}

function normalizeSeverity(input: PatternRule["severity"] | LiteralRule["severity"] | undefined, fallback: Severity): Severity {
  if (input === "blocking") return "block"
  if (input === "warning") return "warn"
  if (input === "block" || input === "warn") return input
  return fallback
}

function lineNumber(text: string, offset: number) {
  return text.slice(0, offset).split(/\r?\n/).length
}

function addHit(input: {
  hits: Hit[]
  profile: SurfaceProfile
  severity: "block" | "warn"
  kind: string
  label: string
  file: string
  line: number
  evidence: string
  message: string
}) {
  const maxTotal = input.profile.maxTotalHits ?? 40
  const maxPerFile = input.profile.maxHitsPerFile ?? 8
  if (input.hits.length >= maxTotal) return
  if (input.hits.filter((hit) => hit.file === input.file).length >= maxPerFile) return
  input.hits.push({
    severity: input.severity,
    kind: input.kind,
    label: input.label,
    file: input.file,
    line: input.line,
    evidence: input.evidence.trim().slice(0, 240),
    message: input.message,
  })
}

function scanForbiddenPatterns(input: { hits: Hit[]; profile: SurfaceProfile; file: string; text: string }) {
  for (const rule of input.profile.forbiddenPatterns ?? []) {
    if (!rule.pattern) continue
    const pattern = compilePattern(rule.pattern, rule.flags)
    for (const match of input.text.matchAll(new RegExp(pattern, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))) {
      addHit({
        hits: input.hits,
        profile: input.profile,
        severity: normalizeSeverity(rule.severity, "block"),
        kind: "forbidden-pattern",
        label: rule.label ?? rule.id ?? rule.pattern,
        file: input.file,
        line: lineNumber(input.text, match.index ?? 0),
        evidence: match[0],
        message: rule.message ?? "Forbidden paper-review skill surface pattern matched.",
      })
    }
  }
}

function extractContext(text: string, index: number, window: number) {
  return text.slice(Math.max(0, index - window), Math.min(text.length, index + window))
}

function extractWordContext(text: string, index: number, windowWords: number) {
  const before = text
    .slice(0, index)
    .split(/\s+/)
    .filter(Boolean)
    .slice(-windowWords)
    .join(" ")
  const after = text
    .slice(index)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, windowWords + 1)
    .join(" ")
  return `${before} ${after}`.trim()
}

function scanContextualRules(input: { hits: Hit[]; profile: SurfaceProfile; file: string; text: string }) {
  for (const rule of input.profile.contextualForbidden ?? []) {
    const trigger = compilePattern(rule.triggerPattern, rule.flags)
    const contextPattern = compilePattern(rule.contextPattern, rule.flags)
    const globalTrigger = new RegExp(trigger, trigger.flags.includes("g") ? trigger.flags : `${trigger.flags}g`)
    for (const match of input.text.matchAll(globalTrigger)) {
      const index = match.index ?? 0
      const context =
        typeof rule.windowWords === "number" && rule.windowWords > 0
          ? extractWordContext(input.text, index, rule.windowWords)
          : extractContext(input.text, index, rule.window ?? 120)
      if (!contextPattern.test(context)) continue
      addHit({
        hits: input.hits,
        profile: input.profile,
        severity: normalizeSeverity(rule.severity, "block"),
        kind: "contextual-forbidden",
        label: rule.label ?? rule.id ?? rule.triggerPattern,
        file: input.file,
        line: lineNumber(input.text, index),
        evidence: context,
        message: rule.message ?? "Paper-specific value appears in answer-like context.",
      })
    }
  }
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function literalRule(raw: LiteralLike, fallbackSeverity: Severity): LiteralRule | undefined {
  if (typeof raw === "string") {
    const value = raw.trim()
    return value ? { value, label: value, severity: fallbackSeverity } : undefined
  }
  if (!raw.value?.trim()) return undefined
  return {
    ...raw,
    value: raw.value.trim(),
    label: raw.label ?? raw.value.trim(),
    severity: normalizeSeverity(raw.severity, fallbackSeverity),
  }
}

function compileLiteral(term: string) {
  const escaped = escapeRegExp(term).replace(/\s+/g, "\\s+")
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "gi")
}

function scanLiterals(input: {
  hits: Hit[]
  profile: SurfaceProfile
  file: string
  text: string
  kind: string
  values: LiteralLike[] | undefined
  fallbackSeverity: Severity
  fallbackMessage: string
}) {
  for (const raw of input.values ?? []) {
    const rule = literalRule(raw, input.fallbackSeverity)
    if (!rule) continue
    const pattern = compileLiteral(rule.value)
    for (const match of input.text.matchAll(pattern)) {
      addHit({
        hits: input.hits,
        profile: input.profile,
        severity: normalizeSeverity(rule.severity, input.fallbackSeverity),
        kind: input.kind,
        label: rule.label ?? rule.value,
        file: input.file,
        line: lineNumber(input.text, match.index ?? 0),
        evidence: match[0],
        message: rule.message ?? input.fallbackMessage,
      })
    }
  }
}

function scanForbiddenLiterals(input: { hits: Hit[]; profile: SurfaceProfile; file: string; text: string }) {
  scanLiterals({
    ...input,
    kind: "forbidden-literal",
    values: input.profile.forbiddenLiterals,
    fallbackSeverity: "block",
    fallbackMessage: "Forbidden literal found in the reusable skill surface.",
  })
}

function scanPaperSpecificTerms(input: { hits: Hit[]; profile: SurfaceProfile; file: string; text: string }) {
  scanLiterals({
    ...input,
    kind: "paper-specific-term",
    values: input.profile.paperSpecificTerms,
    fallbackSeverity: input.profile.paperSpecificTermSeverity ?? "block",
    fallbackMessage:
      "Paper-specific title/method/dataset term found in the reusable skill surface. Move this into candidate output or scratch evidence, not the formal skill.",
  })
}

async function scanRoot(root: string, profile: SurfaceProfile) {
  const hits: Hit[] = []
  if (!(await isDirectory(root))) {
    return {
      root,
      scannedFiles: 0,
      hits: [
        {
          severity: "block" as const,
          kind: "missing-root",
          label: "missing-root",
          file: root,
          line: 1,
          evidence: root,
          message: "Skill surface root does not exist or is not a directory.",
        },
      ],
    }
  }
  const files = await collectFiles(root, root, profile)
  for (const file of files) {
    const relative = normalizeSlash(path.relative(root, file))
    const text = `FileNameContext: ${relative}\n${await readText(file)}`
    scanForbiddenLiterals({ hits, profile, file: relative, text })
    scanForbiddenPatterns({ hits, profile, file: relative, text })
    scanContextualRules({ hits, profile, file: relative, text })
    scanPaperSpecificTerms({ hits, profile, file: relative, text })
  }
  return { root, scannedFiles: files.length, hits }
}

function print(result: Record<string, unknown>, exitCode: number) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(exitCode)
}

async function main() {
  const { payloadPath, profilePath } = parseArgs(Bun.argv)
  if (!payloadPath || !profilePath) {
    print(
      {
        passed: false,
        blocking: true,
        failureKind: "surface_failure",
        summary:
          "Missing validator input path or --profile path. Usage: bun run validate-paper-review-surface-generalization.ts <validator-input.json> --profile <profile.json>",
        details: [],
      },
      1,
    )
  }

  const payload = await readJson(path.resolve(payloadPath))
  const resolvedProfile = path.resolve(profilePath)
  const profile = (await readJson(resolvedProfile)) as SurfaceProfile
  const roots = resolveRoots(payload, profile, path.dirname(resolvedProfile))
  if (!roots.length) {
    print(
      {
        passed: false,
        blocking: true,
        failureKind: "surface_failure",
        summary: "No paper-review skill surface roots were resolved.",
        details: ["Expected targetPaths with role=experience-workspace, or profile.rootPaths."],
        profileID: profile.id,
      },
      1,
    )
  }

  const rootResults = await Promise.all(roots.map((root) => scanRoot(root, profile)))
  const hits = rootResults.flatMap((item) => item.hits)
  const blockingHits = hits.filter((hit) => hit.severity === "block")
  const warnings = hits.filter((hit) => hit.severity === "warn")
  const warningLimit = profile.maxWarningsBeforeBlocking ?? 0
  const warningsEscalated = warningLimit > 0 && warnings.length >= warningLimit
  const passed = blockingHits.length === 0 && !warningsEscalated
  print(
    {
      passed,
      blocking: !passed,
      failureKind: passed ? undefined : "surface_failure",
      summary: passed
        ? `Paper-review surface generalization ${profile.id ?? path.basename(resolvedProfile)} passed.`
        : `Paper-review surface generalization ${profile.id ?? path.basename(resolvedProfile)} failed with ${blockingHits.length} blocking hit(s)${
            warningsEscalated ? ` and ${warnings.length} warning(s) escalated by profile policy` : ""
          }.`,
      details: [
        ...rootResults.map((item, index) => `root[${index}]=${item.root}; scanned_files=${item.scannedFiles}`),
        ...blockingHits.map(
          (hit) => `[BLOCK] ${hit.kind}/${hit.label} ${hit.file}:${hit.line} ${hit.message} :: ${hit.evidence}`,
        ),
        ...warnings.map(
          (hit) => `[WARN] ${hit.kind}/${hit.label} ${hit.file}:${hit.line} ${hit.message} :: ${hit.evidence}`,
        ),
      ],
      profileID: profile.id,
      roots,
      warningLimit,
      warningsEscalated,
      blockingHits,
      warnings,
    },
    passed ? 0 : 1,
  )
}

if (import.meta.main && !process.execArgv.includes("--check")) {
  await main()
}
