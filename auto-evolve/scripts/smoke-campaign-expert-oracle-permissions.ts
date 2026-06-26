import path from "node:path"
import { mkdir, rm, writeFile } from "node:fs/promises"
import {
  collectExpertOracleReadPaths,
  assertExpertOracleReadPaths,
  assertNoOracleLeakageInBlankAgentChannel,
  isAllowedExpertOraclePath,
  type OracleValidatorResult,
} from "../orchestrator/long-task-campaign/expert-oracle-evidence"
import { assertNoDirectoryReadPaths } from "../orchestrator/long-task-campaign/blank-agent-evidence"
import { assertAudienceCanReadValidationView } from "../orchestrator/validation-engine/permissions"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const repoRoot = path.resolve(import.meta.dir, "..")
const smokeRoot = path.join(repoRoot, "runtime-state", "smoke-campaign-expert-oracle")

await rm(smokeRoot, { recursive: true, force: true })
await mkdir(smokeRoot, { recursive: true })

// ─── 1. Setup: create fake result.private.json and result.training.json files ─
const validator1Dir = path.join(smokeRoot, "validator-1")
const validator2Dir = path.join(smokeRoot, "validator-2")
await mkdir(validator1Dir, { recursive: true })
await mkdir(validator2Dir, { recursive: true })

const privateViewPath = path.join(validator1Dir, "result.private.json")
const trainingViewPath = path.join(validator1Dir, "result.training.json")
const sanitizedViewPath = path.join(validator1Dir, "result.sanitized.json")
const private2ViewPath = path.join(validator2Dir, "result.private.json")

await writeFile(
  privateViewPath,
  JSON.stringify(
    {
      passed: true,
      summary: "private oracle view with answer 123.45 and path C:/tmp/private-answers/demo/answer.txt",
      details: ["private oracle content"],
    },
    null,
    2,
  ),
  "utf8",
)
await writeFile(
  trainingViewPath,
  JSON.stringify(
    { passed: true, summary: "training view with 123.45 but path <PRIVATE_ANSWER_PATH>", details: ["training"] },
    null,
    2,
  ),
  "utf8",
)
await writeFile(sanitizedViewPath, JSON.stringify({ passed: true, summary: "sanitized" }), "utf8")
await writeFile(
  private2ViewPath,
  JSON.stringify({ passed: false, summary: "another private view" }),
  "utf8",
)

// ─── 2. Test isAllowedExpertOraclePath ───────────────────────────────────────
assert(isAllowedExpertOraclePath(privateViewPath), "private view should be allowed")
assert(isAllowedExpertOraclePath(trainingViewPath), "training view should be allowed")
assert(!isAllowedExpertOraclePath(sanitizedViewPath), "sanitized view should NOT be in oracle channel")
assert(
  !isAllowedExpertOraclePath("/some/random/file.json"),
  "non-view files should not be allowed",
)
assert(
  !isAllowedExpertOraclePath("/some/dir/result.private.json/"),
  "directory should not be allowed",
)
assert(
  !isAllowedExpertOraclePath(path.join(validator1Dir, "result.private.json", "extra")),
  "trailing path should not be allowed",
)
assert(
  !isAllowedExpertOraclePath("/.runtime/foo.json"),
  ".runtime path should be rejected",
)
assert(
  !isAllowedExpertOraclePath("/foo/.opencode/bar.json"),
  ".opencode path should be rejected",
)
assert(
  !isAllowedExpertOraclePath("/foo/node_modules/bar.json"),
  "node_modules path should be rejected",
)

// ─── 3. Test collectExpertOracleReadPaths ───────────────────────────────────
const fakeValidatorResults: OracleValidatorResult[] = [
  {
    validatorID: "validator-1",
    passed: true,
    evidenceRefs: [privateViewPath, trainingViewPath, sanitizedViewPath],
    rawOutputPath: privateViewPath,
  },
  {
    validatorID: "validator-2",
    passed: false,
    evidenceRefs: [private2ViewPath, "/some/forbidden/path.json"],
  },
]

const collected = await collectExpertOracleReadPaths({ validatorResults: fakeValidatorResults })
const normalize = (p: string) => p.replace(/\\/g, "/")
assert(
  collected.paths.includes(normalize(privateViewPath)),
  `collected should include private view: ${collected.paths.join(", ")}`,
)
assert(
  collected.paths.includes(normalize(trainingViewPath)),
  `collected should include training view: ${collected.paths.join(", ")}`,
)
assert(
  collected.paths.includes(normalize(private2ViewPath)),
  `collected should include private2 view: ${collected.paths.join(", ")}`,
)
assert(
  !collected.paths.includes(normalize(sanitizedViewPath)),
  "collected should NOT include sanitized view (not a private oracle file)",
)
assert(
  !collected.paths.includes("/some/forbidden/path.json"),
  "collected should NOT include forbidden path",
)

// ─── 4. Test assertExpertOracleReadPaths accepts exact files ─────────────────
await assertExpertOracleReadPaths(collected.paths, "smoke")

// ─── 5. Test assertExpertOracleReadPaths rejects forbidden paths ─────────────
let rejected = false
try {
  await assertExpertOracleReadPaths(["/some/.runtime/foo.json"], "smoke-fail")
} catch {
  rejected = true
}
assert(rejected, ".runtime path should be rejected by assertExpertOracleReadPaths")

rejected = false
try {
  await assertExpertOracleReadPaths(["/some/dir/"], "smoke-fail")
} catch {
  rejected = true
}
assert(rejected, "directory path should be rejected by assertExpertOracleReadPaths")

rejected = false
try {
  await assertExpertOracleReadPaths(["/nonexistent/file.json"], "smoke-fail")
} catch {
  rejected = true
}
assert(rejected, "non-existent file should be rejected by assertExpertOracleReadPaths")

// ─── 6. Test that oracle paths are NOT in the blank-agent evidence channel ──
const fakeBlankAgentEvidence = [
  "/safe/path/session_artifacts.json",
  "/safe/path/validation-training.compact.json",
  privateViewPath, // FORBIDDEN: this should be rejected
]
rejected = false
try {
  assertNoDirectoryReadPaths(fakeBlankAgentEvidence, "blank-agent-evidence smoke")
} catch {
  rejected = true
}
assert(rejected, "result.private.json must NOT be in blank-agent-evidence channel")

rejected = false
try {
  assertNoOracleLeakageInBlankAgentChannel(fakeBlankAgentEvidence, "blank-agent-evidence smoke")
} catch {
  rejected = true
}
assert(rejected, "assertNoOracleLeakageInBlankAgentChannel must reject result.private.json")

// Clean oracle from blank-agent channel and verify it passes
const cleanBlankAgentEvidence = [
  "/safe/path/session_artifacts.json",
  "/safe/path/validation-training.compact.json",
]
assertNoDirectoryReadPaths(cleanBlankAgentEvidence, "blank-agent-evidence smoke clean")
assertNoOracleLeakageInBlankAgentChannel(cleanBlankAgentEvidence, "blank-agent-evidence smoke clean")

// ─── 7. Test that permissions allow non-Blank to read private, but not blank_agent ─
assertAudienceCanReadValidationView("worker", "private")
assertAudienceCanReadValidationView("lead", "private")
assertAudienceCanReadValidationView("reviewer", "private")
assertAudienceCanReadValidationView("merger", "private")
assertAudienceCanReadValidationView("repair_agent", "private")
assertAudienceCanReadValidationView("executor", "private")
assertAudienceCanReadValidationView("audit", "private")

let blankBlocked = false
try {
  assertAudienceCanReadValidationView("blank_agent", "private")
} catch {
  blankBlocked = true
}
assert(blankBlocked, "blank_agent must NOT be allowed to read private views")

let dashboardBlocked = false
try {
  assertAudienceCanReadValidationView("dashboard", "private")
} catch {
  dashboardBlocked = true
}
assert(dashboardBlocked, "dashboard must NOT be allowed to read private views")

let memoryBlocked = false
try {
  assertAudienceCanReadValidationView("memory", "private")
} catch {
  memoryBlocked = true
}
assert(memoryBlocked, "memory must NOT be allowed to read private views")

// ─── 8. Test exact-file inside /private-answers/, /ground-truth/, /answer-key/ ─
const fakeOracleAnswersDir = path.join(smokeRoot, "private-answers")
await mkdir(fakeOracleAnswersDir, { recursive: true })
const fakeAnswerFile = path.join(fakeOracleAnswersDir, "answer.txt")
await writeFile(fakeAnswerFile, "private answer", "utf8")
assert(
  isAllowedExpertOraclePath(fakeAnswerFile),
  "exact file in /private-answers/ should be allowed",
)
assert(
  !isAllowedExpertOraclePath(fakeOracleAnswersDir),
  "/private-answers/ directory should NOT be allowed",
)

const fakeGroundTruthDir = path.join(smokeRoot, "ground-truth")
await mkdir(fakeGroundTruthDir, { recursive: true })
const fakeGroundTruthFile = path.join(fakeGroundTruthDir, "ground.json")
await writeFile(fakeGroundTruthFile, "{}", "utf8")
assert(
  isAllowedExpertOraclePath(fakeGroundTruthFile),
  "exact file in /ground-truth/ should be allowed",
)

const fakeAnswerKeyDir = path.join(smokeRoot, "answer-key")
await mkdir(fakeAnswerKeyDir, { recursive: true })
const fakeAnswerKeyFile = path.join(fakeAnswerKeyDir, "key.md")
await writeFile(fakeAnswerKeyFile, "key", "utf8")
assert(isAllowedExpertOraclePath(fakeAnswerKeyFile), "exact file in /answer-key/ should be allowed")

// ─── 9. Final summary ────────────────────────────────────────────────────────
console.log(
  JSON.stringify(
    {
      passed: true,
      collectedPaths: collected.paths,
      sources: collected.sources,
      summary: {
        totalOraclePaths: collected.paths.length,
        sourcesByCount: Object.keys(collected.sources).length,
      },
    },
    null,
    2,
  ),
)
