import path from "node:path"
import { readFile, stat } from "node:fs/promises"
import { writeJsonFile } from "../fs"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OracleValidatorResult {
  validatorID: string
  passed: boolean
  evidenceRefs?: string[]
  rawOutputPath?: string
}

export interface CollectOracleReadPathsInput {
  validatorResults: OracleValidatorResult[]
}

export interface ExpertOracleReadPathsResult {
  /** Exact file paths allowed to be read by non-Blank oracle consumers. */
  paths: string[]
  /** Path -> reason it was accepted. */
  sources: Record<string, string>
}

export interface ExpertOracleBundle {
  schema: "expert-oracle-bundle/v1"
  createdAt: string
  audience: "non_blank_open_book_only"
  blankAgentPolicy: "never_expose_to_blank_agent"
  source: {
    campaignID?: string
    roundNumber?: number
    passID?: string
    resultPath?: string
  }
  oraclePaths: string[]
  sources: Record<string, string>
  usageRules: string[]
}

// ─── Path heuristics ─────────────────────────────────────────────────────────

const PRIVATE_VIEW_FILE = "result.private.json"
const TRAINING_VIEW_FILE = "result.training.json"
const MAX_ORACLE_PATHS = 64
const MAX_EMBEDDED_STRINGS = 512
const MAX_JSON_DEPTH = 12
const MAX_EMBEDDED_STRING_CHARS = 4096

const ORACLE_DIR_ALLOWED_AS_FILE = ["private-answers", "ground-truth", "answer-key"]

const FORBIDDEN_DIR_SEGMENTS = [
  ".runtime",
  ".opencode",
  "node_modules",
]

/**
 * Return true if `filePath` is an exact file (not a directory) that is allowed
 * to be read by non-Blank oracle consumers.
 *
 * Allowed:
 *  - result.private.json (exact file)
 *  - result.training.json (exact file)
 *  - exact files inside /private-answers/, /ground-truth/, /answer-key/ (with extension)
 *
 * Forbidden:
 *  - directory-level leaks (no extension or ends in known unsafe dir name)
 *  - .runtime, .opencode, node_modules leakage
 *  - non-result files under /validators/ (only result.private.json and result.training.json are allowed)
 */
export function isAllowedExpertOraclePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") return false
  const normalized = filePath.replace(/\\/g, "/").toLowerCase()
  if (normalized.length === 0) return false

  // Disallow forbidden runtime/IDE/node_modules paths.
  for (const seg of FORBIDDEN_DIR_SEGMENTS) {
    if (normalized.includes(`/${seg}/`) || normalized.endsWith(`/${seg}`)) {
      return false
    }
  }

  // Allow result.private.json / result.training.json anywhere they appear
  // (these are the explicit validation view files).
  if (normalized.endsWith(`/${PRIVATE_VIEW_FILE}`)) return true
  if (normalized.endsWith(`/${TRAINING_VIEW_FILE}`)) return true

  // Allow exact files (must have an extension) inside /private-answers/, /ground-truth/, /answer-key/.
  for (const dir of ORACLE_DIR_ALLOWED_AS_FILE) {
    if (normalized.includes(`/${dir}/`)) {
      const ext = path.extname(normalized)
      if (!ext || ext === ".") return false
      // Reject /validators/ leakage (only the result.*.json view files are allowed there).
      if (normalized.includes("/validators/")) return false
      return true
    }
  }

  return false
}

function looksPathLike(value: string) {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_EMBEDDED_STRING_CHARS) return false
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true
  if (trimmed.startsWith("/") || trimmed.startsWith("\\\\")) return true
  if (trimmed.includes("/") || trimmed.includes("\\")) return true
  return false
}

async function isExistingExactFile(filePath: string) {
  const info = await stat(filePath).catch(() => undefined)
  return !!info?.isFile()
}

function collectJsonStrings(value: unknown, out: string[], depth = 0) {
  if (out.length >= MAX_EMBEDDED_STRINGS || depth > MAX_JSON_DEPTH) return
  if (typeof value === "string") {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (out.length >= MAX_EMBEDDED_STRINGS) break
      collectJsonStrings(item, out, depth + 1)
    }
    return
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      if (out.length >= MAX_EMBEDDED_STRINGS) break
      collectJsonStrings(item, out, depth + 1)
    }
  }
}

async function collectOraclePathsInsideView(input: {
  viewPath: string
  tryAdd: (ref: string, reason: string) => Promise<void>
}) {
  const normalized = input.viewPath.replace(/\\/g, "/").toLowerCase()
  if (!normalized.endsWith(`/${PRIVATE_VIEW_FILE}`) && !normalized.endsWith(`/${TRAINING_VIEW_FILE}`)) return
  const raw = await readFile(input.viewPath, "utf8").catch(() => undefined)
  if (!raw) return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""))
  } catch {
    return
  }
  const strings: string[] = []
  collectJsonStrings(parsed, strings)
  const viewDir = path.dirname(input.viewPath)
  for (const item of strings) {
    if (!looksPathLike(item)) continue
    await input.tryAdd(item, `view:${path.basename(input.viewPath)}:embedded-path`)
    if (!path.isAbsolute(item) && (item.includes("/") || item.includes("\\"))) {
      await input.tryAdd(path.resolve(viewDir, item), `view:${path.basename(input.viewPath)}:embedded-relative-path`)
    }
  }
}

// ─── Collection ──────────────────────────────────────────────────────────────

/**
 * Collect exact-file oracle read paths from a list of validator results.
 *
 * - Inspects each result's `evidenceRefs` and `rawOutputPath`.
 * - Filters to files matching `isAllowedExpertOraclePath`.
 * - Dedupes paths.
 * - Records why each path was kept (`sources`).
 */
export async function collectExpertOracleReadPaths(
  input: CollectOracleReadPathsInput,
): Promise<ExpertOracleReadPathsResult> {
  const paths: string[] = []
  const sources: Record<string, string> = {}
  const seen = new Set<string>()

  const tryAdd = async (ref: string, reason: string) => {
    if (paths.length >= MAX_ORACLE_PATHS) return
    if (!isAllowedExpertOraclePath(ref)) return
    // Normalize to forward slashes for cross-platform dedup.
    const key = ref.replace(/\\/g, "/")
    if (seen.has(key)) return
    if (!(await isExistingExactFile(ref))) return
    seen.add(key)
    paths.push(key)
    sources[key] = reason
  }

  for (const vr of input.validatorResults) {
    for (const ref of vr.evidenceRefs ?? []) {
      await tryAdd(ref, `validator:${vr.validatorID}:evidenceRef`)
      await collectOraclePathsInsideView({
        viewPath: ref,
        tryAdd: (innerRef, reason) => tryAdd(innerRef, `validator:${vr.validatorID}:${reason}`),
      })
    }
    if (vr.rawOutputPath) {
      await tryAdd(vr.rawOutputPath, `validator:${vr.validatorID}:rawOutputPath`)
      await collectOraclePathsInsideView({
        viewPath: vr.rawOutputPath,
        tryAdd: (innerRef, reason) => tryAdd(innerRef, `validator:${vr.validatorID}:${reason}`),
      })
    }
  }

  return { paths, sources }
}

export async function writeExpertOracleBundle(input: {
  outPath: string
  campaignID?: string
  roundNumber?: number
  passID?: string
  resultPath?: string
  oracle: ExpertOracleReadPathsResult
}): Promise<{ bundle: ExpertOracleBundle; bundlePath: string }> {
  const bundle: ExpertOracleBundle = {
    schema: "expert-oracle-bundle/v1",
    createdAt: new Date().toISOString(),
    audience: "non_blank_open_book_only",
    blankAgentPolicy: "never_expose_to_blank_agent",
    source: {
      campaignID: input.campaignID,
      roundNumber: input.roundNumber,
      passID: input.passID,
      resultPath: input.resultPath,
    },
    oraclePaths: input.oracle.paths,
    sources: input.oracle.sources,
    usageRules: [
      "This bundle is only for non-blank open-book learning, diagnosis, repair, review, and merge work.",
      "Blank agents must never receive this bundle or any path listed inside it.",
      "Use oracle evidence to understand expected-vs-actual mismatches and repair the skill.",
      "Do not copy private answer paths, hidden answer values, validator-only truth, or exact oracle literals into the expert package.",
      "Translate oracle evidence into generalized source-location, derivation, output-shape, and self-check guidance.",
    ],
  }
  await writeJsonFile(input.outPath, bundle)
  return { bundle, bundlePath: input.outPath }
}

// ─── Assertions ──────────────────────────────────────────────────────────────

/**
 * Assert that each path in `paths` is an exact file (not a directory) and
 * conforms to `isAllowedExpertOraclePath`. Throws on first violation.
 */
export async function assertExpertOracleReadPaths(
  paths: string[],
  label: string,
): Promise<void> {
  for (const p of paths) {
    if (!isAllowedExpertOraclePath(p)) {
      throw new Error(`${label}: path is not an allowed exact oracle file: ${p}`)
    }
    const normalized = p.replace(/\\/g, "/").toLowerCase()
    // Disallow forbidden runtime/IDE/node_modules paths.
    for (const seg of FORBIDDEN_DIR_SEGMENTS) {
      if (normalized.includes(`/${seg}/`) || normalized.endsWith(`/${seg}`)) {
        throw new Error(`${label}: forbidden segment '${seg}' leaked: ${p}`)
      }
    }
    // Reject /validators/ non-view files.
    if (normalized.includes("/validators/")) {
      if (
        !normalized.endsWith(`/${PRIVATE_VIEW_FILE}`) &&
        !normalized.endsWith(`/${TRAINING_VIEW_FILE}`)
      ) {
        throw new Error(`${label}: non-view file under /validators/ leaked: ${p}`)
      }
    }
    // Verify the path actually exists and is a file.
    const s = await stat(p).catch(() => undefined)
    if (!s) {
      throw new Error(`${label}: oracle path does not exist: ${p}`)
    }
    if (!s.isFile()) {
      throw new Error(`${label}: oracle path is not an exact file: ${p}`)
    }
  }
}

/**
 * Assert that none of the paths in `paths` look like oracle/answer leakage.
 * Used as a defensive check for the Blank Agent evidence channel: even if a
 * caller accidentally puts an oracle path here, the assertion will reject it.
 */
export function assertNoOracleLeakageInBlankAgentChannel(
  paths: string[],
  label: string,
): void {
  for (const p of paths) {
    const normalized = p.replace(/\\/g, "/").toLowerCase()
    if (normalized.endsWith(`/${PRIVATE_VIEW_FILE}`)) {
      throw new Error(`${label}: result.private.json must not be in blank-agent-evidence channel: ${p}`)
    }
    for (const dir of ORACLE_DIR_ALLOWED_AS_FILE) {
      if (normalized.includes(`/${dir}/`)) {
        throw new Error(`${label}: ${dir} path must not be in blank-agent-evidence channel: ${p}`)
      }
    }
  }
}
