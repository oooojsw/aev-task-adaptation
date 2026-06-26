import path from "node:path"
import { stat } from "node:fs/promises"

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

// ─── Path heuristics ─────────────────────────────────────────────────────────

const PRIVATE_VIEW_FILE = "result.private.json"
const TRAINING_VIEW_FILE = "result.training.json"

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

  const tryAdd = (ref: string, reason: string) => {
    if (!isAllowedExpertOraclePath(ref)) return
    // Normalize to forward slashes for cross-platform dedup.
    const key = ref.replace(/\\/g, "/")
    if (seen.has(key)) return
    seen.add(key)
    paths.push(key)
    sources[key] = reason
  }

  for (const vr of input.validatorResults) {
    for (const ref of vr.evidenceRefs ?? []) {
      tryAdd(ref, `validator:${vr.validatorID}:evidenceRef`)
    }
    if (vr.rawOutputPath) {
      tryAdd(vr.rawOutputPath, `validator:${vr.validatorID}:rawOutputPath`)
    }
  }

  return { paths, sources }
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
