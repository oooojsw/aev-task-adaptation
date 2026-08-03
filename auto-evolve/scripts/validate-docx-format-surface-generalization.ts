import path from "node:path"
import { readdir, readFile, stat } from "node:fs/promises"

type JsonObject = Record<string, unknown>

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
  oraclePath?: string
  forbiddenLiterals?: string[]
  forbiddenPatterns?: string[]
  forbiddenPathSubstrings?: string[]
  oracleLeakSources?: Array<"source" | "gold" | "reference">
}

interface Hit {
  file: string
  line: number
  kind: string
  label: string
  evidence: string
}

const DEFAULT_ALLOWED_EXTENSIONS = [".md", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".py", ".ps1", ".sh", ".js", ".mjs", ".cjs", ".ts"]

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function normalizeLower(input: string) {
  return normalizeSlash(input).toLowerCase()
}

function isObject(input: unknown): input is JsonObject {
  return typeof input === "object" && input !== null && !Array.isArray(input)
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

function resolveMaybeRelative(raw: string, base: string) {
  return path.isAbsolute(raw) ? raw : path.resolve(base, raw)
}

function resolveRoots(payload: JsonObject, profile: SurfaceProfile, profileDir: string) {
  const rootRoles = profile.rootRoles?.length ? profile.rootRoles : ["experience-workspace"]
  const rootLabels = profile.rootLabels ?? []
  const roots: string[] = []
  for (const raw of profile.rootPaths ?? []) {
    if (raw.trim()) roots.push(resolveMaybeRelative(raw, profileDir))
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

function shouldIgnore(relativePath: string, profile: SurfaceProfile) {
  const normalized = normalizeSlash(relativePath).toLowerCase()
  return (profile.ignorePathSubstrings ?? []).some((item) => {
    const token = normalizeSlash(String(item)).toLowerCase().replace(/^\/+/, "")
    if (!token) return false
    return normalized === token || normalized.startsWith(`${token}/`) || normalized.includes(`/${token}/`)
  })
}

async function collectFiles(root: string, current: string, profile: SurfaceProfile, depth = 0): Promise<string[]> {
  if (depth > (profile.maxDepth ?? 8)) return []
  const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
  const allowed = new Set(profile.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS)
  const out: string[] = []
  for (const entry of entries) {
    const absolute = path.join(current, entry.name)
    const relative = normalizeSlash(path.relative(root, absolute)) || entry.name
    if (shouldIgnore(relative, profile)) continue
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

function lineNumber(text: string, index: number) {
  return text.slice(0, index).split(/\r?\n/).length
}

function redact(value: string) {
  const compact = value.replace(/\s+/g, " ").trim()
  if (compact.length <= 20) return `${compact.slice(0, 3)}...[redacted]`
  return `${compact.slice(0, 12)}...[redacted:${compact.length}]`
}

function addHit(hits: Hit[], profile: SurfaceProfile, hit: Hit) {
  const maxTotal = profile.maxTotalHits ?? 40
  const maxPerFile = profile.maxHitsPerFile ?? 8
  if (hits.length >= maxTotal) return
  if (hits.filter((item) => item.file === hit.file).length >= maxPerFile) return
  hits.push(hit)
}

function collectOracleLiterals(oracle: JsonObject) {
  const out: string[] = []
  const collectPathHints = (value: unknown) => {
    if (typeof value !== "string") return
    const normalized = normalizeSlash(value)
    const base = path.basename(normalized)
    for (const token of [normalized, base]) {
      const clean = token.replace(/\s+/g, " ").trim()
      if (clean.length >= 6) out.push(clean)
    }
    for (const match of normalized.matchAll(/\b(?:docx-format-)?(?:0\d{3}|1\d{3}|2\d{3}|3\d{3})\b/gi)) {
      out.push(match[0])
    }
  }
  const collectText = (value: unknown) => {
    if (typeof value === "string") {
      const normalized = value.replace(/\s+/g, " ").trim()
      if (normalized.length >= 36) out.push(normalized)
      return
    }
    if (Array.isArray(value)) {
      value.forEach(collectText)
      return
    }
    if (isObject(value)) {
      for (const item of Object.values(value)) collectText(item)
    }
  }
  collectText(oracle["forbidden_template_content"])
  collectText(oracle["comments_oracle"])
  collectPathHints(oracle["source"])
  collectPathHints(oracle["format_reference"])
  collectPathHints(oracle["gold"])
  return Array.from(new Set(out)).slice(0, 500)
}

function scanText(input: {
  file: string
  text: string
  profile: SurfaceProfile
  oracleLiterals: string[]
  hits: Hit[]
}) {
  const relative = input.file
  const combined = `FILENAME_IS: ${normalizeSlash(input.file)}\n${input.text}`
  const lower = combined.toLowerCase()
  const literalRules = [
    "private-answers",
    "optional-gold.docx",
    "gold.docx",
    "v13.docx",
    "gold-format-signature",
    "comments-oracle",
    "images-oracle",
    "forbidden-template-content",
    ...(input.profile.forbiddenPathSubstrings ?? []),
    ...(input.profile.forbiddenLiterals ?? []),
  ]
  for (const literal of literalRules) {
    if (!literal.trim()) continue
    const index = lower.indexOf(literal.toLowerCase())
    if (index >= 0) {
      addHit(input.hits, input.profile, {
        file: relative,
        line: lineNumber(combined, index),
        kind: "literal",
        label: literal,
        evidence: redact(literal),
      })
    }
  }
  for (const literal of input.oracleLiterals) {
    const index = combined.indexOf(literal)
    if (index >= 0) {
      addHit(input.hits, input.profile, {
        file: relative,
        line: lineNumber(combined, index),
        kind: "oracle_literal",
        label: "private oracle text",
        evidence: redact(literal),
      })
    }
  }
  const hardcodedPathPattern = String.raw`[A-Za-z]:[\\/][^\s"'<>]+`
  const patterns = [
    String.raw`[A-Za-z]:[\\/][^\s"'<>]+`,
    String.raw`删除第\s*\d+\s*(?:到|-|~)\s*\d+\s*段`,
    String.raw`第\s*\d+\s*(?:到|-|~)\s*\d+\s*段`,
    String.raw`\[[0-9,\-\s]+\]\s*(?:放到|移动到|插入到)`,
    ...(input.profile.forbiddenPatterns ?? []),
  ]
  for (const pattern of patterns) {
    const re = new RegExp(pattern, "giu")
    for (const match of combined.matchAll(re)) {
      const matchedText = match[0] ?? ""
      if (pattern === hardcodedPathPattern && matchedText.includes("://")) continue
      addHit(input.hits, input.profile, {
        file: relative,
        line: lineNumber(combined, match.index ?? 0),
        kind: "pattern",
        label: pattern,
        evidence: redact(matchedText || pattern),
      })
    }
  }
}

async function main() {
  const { payloadPath, profilePath } = parseArgs(process.argv)
  if (!payloadPath) {
    console.log(JSON.stringify({ passed: false, blocking: true, summary: "missing validator payload path", details: [], failureKind: "validator_infrastructure" }))
    process.exit(1)
  }
  const payload = await readJson(payloadPath)
  const profileFile = profilePath ? resolveMaybeRelative(profilePath, path.dirname(payloadPath)) : undefined
  const profileDir = profileFile ? path.dirname(profileFile) : path.dirname(payloadPath)
  const profile = profileFile ? ((await readJson(profileFile)) as SurfaceProfile) : {}
  const oraclePath = profile.oraclePath ? resolveMaybeRelative(profile.oraclePath, profileDir) : undefined
  const oracle = oraclePath
    ? await readJson(oraclePath).catch(() => undefined)
    : undefined
  const oracleLiterals = oracle ? collectOracleLiterals(oracle) : []
  const roots = resolveRoots(payload, profile, profileDir)
  const hits: Hit[] = []
  for (const root of roots) {
    const rootStat = await stat(root).catch(() => undefined)
    if (!rootStat?.isDirectory()) continue
    const files = await collectFiles(root, root, profile)
    for (const file of files) {
      const raw = await readFile(file, "utf8").catch(() => "")
      scanText({
        file: normalizeSlash(path.relative(root, file)) || path.basename(file),
        text: raw,
        profile,
        oracleLiterals,
        hits,
      })
    }
  }
  if (roots.length > 0 && hits.length === 0) {
    const existingRoots = []
    for (const root of roots) {
      const rootStat = await stat(root).catch(() => undefined)
      if (rootStat?.isDirectory()) existingRoots.push(root)
    }
    if (existingRoots.length > 0) {
      let scannedFileCount = 0
      for (const root of existingRoots) {
        scannedFileCount += (await collectFiles(root, root, profile)).length
      }
      if (scannedFileCount === 0) {
        hits.push({
          file: "<surface-root>",
          line: 1,
          kind: "pattern",
          label: "no-scanned-files",
          evidence: "surface validator scanned zero files; fail closed",
        })
      }
    }
  }
  const passed = hits.length === 0
  console.log(
    JSON.stringify(
      {
        passed,
        blocking: true,
        summary: passed
          ? `DOCX format skill surface validation passed (${roots.length} root(s)).`
          : `DOCX format skill surface validation blocked ${hits.length} leak/specificity hit(s).`,
        details: hits.map((hit) => `${hit.file}:${hit.line} ${hit.kind}:${hit.label} evidence=${hit.evidence}`),
        failureKind: passed ? undefined : "surface_leak",
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.log(JSON.stringify({ passed: false, blocking: true, summary: `DOCX surface validator crashed: ${message}`, details: [message], failureKind: "validator_infrastructure" }))
  process.exit(1)
})
