import path from "node:path"
import { mkdir, rm, writeFile, stat } from "node:fs/promises"
import { writeBlankAgentEvidenceBundle, readLatestBlankAgentEvidenceBundlePath, readBlankAgentEvidenceReadablePaths, assertNoDirectoryReadPaths } from "../orchestrator/long-task-campaign/blank-agent-evidence"
import type { LongTaskSpec } from "../orchestrator/long-task/contract"

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const smokeRoot = path.join(repoRoot, "auto-evolve", "runtime-state", "tmp-smoke-blank-evidence")

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), "utf8")
}

const campaignID = "smoke-blank-evidence"
const campaignRoot = path.join(smokeRoot, campaignID)
const acceptanceRoot = path.join(campaignRoot, "rounds", "round-001", "final-acceptance", "pass-01")
const blankEvalRunDir = path.join(acceptanceRoot, "blank-eval-runs", "blank-eval-fake")
const sessionDir = path.join(blankEvalRunDir, "session")

// === Setup fake campaign structure ===
await rm(smokeRoot, { recursive: true, force: true })
await mkdir(campaignRoot, { recursive: true })
await mkdir(sessionDir, { recursive: true })

// === Write fake session artifacts ===
const sessionFiles: Record<string, string> = {
  "prompt.txt": "fake prompt\n",
  "stdout.log": "fake stdout\n",
  "stderr.log": "fake stderr\n",
  "response.txt": JSON.stringify({ passed: true, summary: "Looks good" }) + "\n",
  "action_trace.md": "# trace\n",
  "session_execution_report.md": "# exec report\n",
  "session_learning_log.md": "# learning\n",
  "session_task_manifest.md": "# manifest\n",
  "events.json": JSON.stringify([
    { type: "tool_use", name: "read", id: "t1", input: { file: "workspace/answer.json" } },
    { type: "tool_result", tool: "read", tool_use_id: "t1", content: "answer content", is_error: false },
  ]) + "\n",
  "tool_failures.json": "[]\n",
  "run.json": JSON.stringify({ runID: "fake", status: "ok" }) + "\n",
  "opencode_process_log.txt": "log\n",
}
for (const [name, content] of Object.entries(sessionFiles)) {
  await writeFile(path.join(sessionDir, name), content, "utf8")
}

// === Write fake validation training view ===
const validatorDir = path.join(acceptanceRoot, "validators", "product-check")
await mkdir(validatorDir, { recursive: true })
const trainingView = {
  passed: false,
  blocking: true,
  summary: "answer missing",
  details: ["workspace/answer.json not found"],
  evidence_refs: ["workspace/answer.json"],
}
await writeJson(path.join(validatorDir, "result.training.json"), trainingView)
await writeJson(path.join(validatorDir, "result.private.json"), { passed: true, secret: "real-answer-507" })

// === Write fake workspace files ===
const workspaceRoot = path.join(smokeRoot, "fake-task-workspace")
await mkdir(path.join(workspaceRoot, "workspace"), { recursive: true })
await writeFile(path.join(workspaceRoot, "workspace", "answer.json"), "{}\n", "utf8")
await writeFile(path.join(workspaceRoot, "workspace", "step1_calc.txt"), "100+200=300\n", "utf8")
await writeFile(path.join(workspaceRoot, "workspace", "extracted.csv"), "a,b,c\n1,2,3\n", "utf8")
await writeFile(path.join(workspaceRoot, "workspace", "source.pdf"), "%PDF-1.4 fake binary\n", "utf8")
await writeFile(path.join(workspaceRoot, "workspace", "huge.log"), "x".repeat(3 * 1024 * 1024), "utf8") // 3MB

// === Write final acceptance result ===
const acceptanceResultPath = path.join(acceptanceRoot, "result.json")
await writeJson(acceptanceResultPath, {
  campaignID,
  roundNumber: 1,
  passed: false,
  summary: "Blank-agent acceptance failed",
  validatorResults: [
    {
      validatorID: "product-check",
      passed: false,
      evidenceRefs: [
        path.join(validatorDir, "result.training.json"),
        path.join(validatorDir, "result.private.json"),
      ],
      rawOutputPath: path.join(validatorDir, "result.training.json"),
    },
  ],
})

const fakeSpec: LongTaskSpec = {
  title: "smoke task",
  goal: "smoke",
  materials: [],
  targetPaths: [{ path: path.join(workspaceRoot, "workspace", "answer.json") }],
  editablePaths: [path.join(workspaceRoot, "workspace")],
  validators: [],
  planning: {},
  execution: {},
  validation: {},
}

const result = await writeBlankAgentEvidenceBundle({
  cwd: repoRoot,
  campaignID,
  campaignRoot,
  roundNumber: 1,
  passID: "pass-01",
  sourceRunID: "smoke-run",
  baseSpec: fakeSpec,
  acceptanceRoot,
  acceptanceResultPath,
  finalAcceptance: {
    passed: false,
    summary: "Blank-agent acceptance failed",
    validatorResults: [
      {
        validatorID: "product-check",
        passed: false,
        evidenceRefs: [
          path.join(validatorDir, "result.training.json"),
          path.join(validatorDir, "result.private.json"),
        ],
        rawOutputPath: path.join(validatorDir, "result.training.json"),
      },
    ],
    blankEvalRunDir,
    blankEvalResultPath: path.join(blankEvalRunDir, "result.json"),
    blankEvalValidationStageResultPath: path.join(acceptanceRoot, "stage-result.json"),
    blankEvalSessionDir: sessionDir,
    blankEvalSessionExecutionReportPath: path.join(sessionDir, "session_execution_report.md"),
  },
})

const { bundle, bundlePath } = result

// === Normalize helper: forward slashes for comparison ===
function toFwd(p: string) { return p.replace(/\\/g, "/") }
const readableSet = new Set(bundle.readablePaths.map(toFwd))

// === Assertions: must contain ===
const mustContain = [
  toFwd(bundlePath),
  toFwd(bundle.compactArtifacts.executionCompactPath),
  toFwd(bundle.compactArtifacts.toolCallsCompactPath),
  toFwd(bundle.compactArtifacts.validationTrainingCompactPath),
  toFwd(bundle.compactArtifacts.workspaceFilesManifestPath),
  toFwd(path.join(validatorDir, "result.training.json")),
  toFwd(path.join(sessionDir, "response.txt")),
  toFwd(path.join(sessionDir, "events.json")),
  toFwd(path.join(sessionDir, "tool_failures.json")),
  toFwd(path.join(sessionDir, "session_execution_report.md")),
  toFwd(path.join(workspaceRoot, "workspace", "answer.json")),
  toFwd(path.join(workspaceRoot, "workspace", "step1_calc.txt")),
  toFwd(path.join(workspaceRoot, "workspace", "extracted.csv")),
]
for (const p of mustContain) {
  if (!readableSet.has(p)) fail(`Expected readablePaths to contain: ${p}`)
}

// === Assertions: must NOT contain ===
const mustNotContain = [
  toFwd(path.join(validatorDir, "result.private.json")),
  toFwd(path.join(workspaceRoot, "workspace", "source.pdf")),
  toFwd(path.join(workspaceRoot, "workspace", "huge.log")),
  toFwd(blankEvalRunDir), // directory
  toFwd(validatorDir), // directory
  toFwd(acceptanceRoot), // directory
]
for (const p of mustNotContain) {
  if (readableSet.has(p)) fail(`Expected readablePaths to NOT contain: ${p}`)
}

// === Assertion: latest.json exists ===
const latestPath = await readLatestBlankAgentEvidenceBundlePath(campaignRoot)
if (!latestPath) fail("Expected latest.json to exist")
const latestReadPaths = await readBlankAgentEvidenceReadablePaths(latestPath)
if (latestReadPaths.length !== bundle.readablePaths.length) {
  fail(`Expected latest.json readablePaths to match bundle readablePaths (${latestReadPaths.length} vs ${bundle.readablePaths.length})`)
}

// === Assertion: tool-calls.compact.json has full pathRefs ===
const toolCallsPath = bundle.compactArtifacts.toolCallsCompactPath
const toolCallsContent = JSON.parse(await Bun.file(toolCallsPath).text())
if (!Array.isArray(toolCallsContent) || toolCallsContent.length === 0) {
  fail("Expected tool-calls.compact.json to be a non-empty array")
}
const firstToolCall = toolCallsContent[0]
if (!firstToolCall.pathRefs || !firstToolCall.pathRefs.includes("workspace/answer.json")) {
  fail(`Expected first tool call pathRefs to include "workspace/answer.json", got: ${JSON.stringify(firstToolCall.pathRefs)}`)
}

// === Assertion: validation-training.compact.json exists and has no private data ===
const trainingCompactContent = JSON.parse(await Bun.file(bundle.compactArtifacts.validationTrainingCompactPath).text())
if (trainingCompactContent.schema !== "validation-training-compact/v1") {
  fail("Expected validation-training.compact schema to be validation-training-compact/v1")
}
const trainingJson = JSON.stringify(trainingCompactContent)
if (trainingJson.includes("real-answer-507") || trainingJson.includes("secret")) {
  fail("Validation-training compact must NOT include private data")
}

// === Assertion: assertNoDirectoryReadPaths throws on directory ===
let threw = false
try {
  assertNoDirectoryReadPaths([blankEvalRunDir, bundlePath], "smoke")
} catch (err) {
  threw = true
}
if (!threw) fail("Expected assertNoDirectoryReadPaths to throw on directory input")

// === Assertion: assertNoDirectoryReadPaths passes on exact files ===
try {
  assertNoDirectoryReadPaths(mustContain, "smoke")
} catch (err) {
  fail(`Expected assertNoDirectoryReadPaths to pass on exact files, threw: ${(err as Error).message}`)
}

console.log(
  JSON.stringify(
    {
      passed: true,
      bundlePath,
      readablePathsCount: bundle.readablePaths.length,
      sessionArtifactsCount: bundle.exactArtifacts.sessionArtifactPaths.length,
      trainingViewsCount: bundle.exactArtifacts.validationTrainingViewPaths.length,
      workspaceTextFilesCount: bundle.exactArtifacts.workspaceTextFilePaths.length,
      blockedRefsCount: bundle.blockedRefs.length,
    },
    null,
    2,
  ),
)
