// smoke-campaign-worker-blank-evidence-permissions
//
// Step 14 of the Blank Agent Evidence Bundle plan.
// Verifies that, given a generated evidence bundle, the 4 worker roles'
// permissionReadPaths stay clean:
//   - include the bundle's exact files (not directories)
//   - never include the unsafe directories:
//     blank-eval-runs, clean-skill-roots, validation-expert-workspace,
//     validators (except result.training.json), private-answers, ground-truth,
//     answer-key, result.private.json
//   - assertNoDirectoryReadPaths actually fires when a directory is leaked
//
// This smoke does NOT spawn opencode. It only validates the permission
// construction pattern by reading the bundle, building the per-role
// permissionReadPaths the same way the runner does, and asserting the
// invariants.

import path from "node:path"
import { mkdir, rm, writeFile } from "node:fs/promises"
import {
  writeBlankAgentEvidenceBundle,
  readBlankAgentEvidenceReadablePaths,
  assertNoDirectoryReadPaths,
} from "../orchestrator/long-task-campaign/blank-agent-evidence"
import type { LongTaskSpec } from "../orchestrator/long-task/contract"

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const smokeRoot = path.join(repoRoot, "auto-evolve", "runtime-state", "tmp-smoke-evidence-permissions")

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), "utf8")
}

// ---------- Setup fake campaign that produces a real evidence bundle ----------
const campaignID = "smoke-evidence-permissions"
const campaignRoot = path.join(smokeRoot, campaignID)
const acceptanceRoot = path.join(campaignRoot, "rounds", "round-001", "final-acceptance", "pass-01")
const blankEvalRunDir = path.join(acceptanceRoot, "blank-eval-runs", "blank-eval-fake")
const sessionDir = path.join(blankEvalRunDir, "session")
const workspaceRoot = path.join(smokeRoot, "fake-task-workspace")

await rm(smokeRoot, { recursive: true, force: true })
await mkdir(campaignRoot, { recursive: true })
await mkdir(sessionDir, { recursive: true })
await mkdir(path.join(workspaceRoot, "workspace"), { recursive: true })

// session artifacts
const sessionFiles: Record<string, string> = {
  "prompt.txt": "fake prompt\n",
  "stdout.log": "fake stdout\n",
  "stderr.log": "fake stderr\n",
  "response.txt": JSON.stringify({ passed: true, summary: "ok" }) + "\n",
  "action_trace.md": "# trace\n",
  "session_execution_report.md": "# exec\n",
  "session_learning_log.md": "# learning\n",
  "session_task_manifest.md": "# manifest\n",
  "events.json": JSON.stringify([
    { type: "tool_use", name: "read", id: "t1", input: { file: "workspace/answer.json" } },
  ]) + "\n",
  "tool_failures.json": "[]\n",
  "run.json": JSON.stringify({ runID: "fake", status: "ok" }) + "\n",
  "opencode_process_log.txt": "log\n",
}
for (const [name, content] of Object.entries(sessionFiles)) {
  await writeFile(path.join(sessionDir, name), content, "utf8")
}

// validator: include both training and private views
const validatorDir = path.join(acceptanceRoot, "validators", "product-check")
await mkdir(validatorDir, { recursive: true })
await writeJson(path.join(validatorDir, "result.training.json"), {
  passed: false,
  blocking: true,
  summary: "answer missing",
  details: ["workspace/answer.json not found"],
  evidence_refs: ["workspace/answer.json"],
})
await writeJson(path.join(validatorDir, "result.private.json"), {
  passed: true,
  secret: "real-answer-507",
})

// workspace files
await writeFile(path.join(workspaceRoot, "workspace", "answer.json"), "{}\n", "utf8")
await writeFile(path.join(workspaceRoot, "workspace", "step1_calc.txt"), "100+200=300\n", "utf8")

// spec with editable paths
const baseSpec: LongTaskSpec = {
  title: "smoke spec",
  goal: "test",
  materials: [],
  targetPaths: [{ path: path.join(workspaceRoot, "workspace", "answer.json") }],
  editablePaths: [path.join(workspaceRoot, "workspace")],
  validators: [],
  planning: {},
  execution: {},
  validation: {},
}

const acceptanceResultPath = path.join(acceptanceRoot, "result.json")
const generated = await writeBlankAgentEvidenceBundle({
  cwd: repoRoot,
  campaignID,
  campaignRoot,
  roundNumber: 1,
  passID: "pass-01",
  sourceRunID: "smoke-fake-run",
  baseSpec,
  acceptanceRoot,
  acceptanceResultPath,
  finalAcceptance: {
    passed: false,
    summary: "blank-agent acceptance failed",
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
    blankEvalResultPath: path.join(acceptanceRoot, "blank-eval-result.json"),
    blankEvalValidationStageResultPath: path.join(acceptanceRoot, "validators", "stage-result.json"),
    blankEvalSessionDir: sessionDir,
    blankEvalSessionExecutionReportPath: path.join(sessionDir, "session_execution_report.md"),
  },
})
const evidenceReadable = await readBlankAgentEvidenceReadablePaths(generated.bundlePath)

if (evidenceReadable.length === 0) {
  fail("Expected bundle to produce at least one readable path.")
}

// ---------- Build per-role permissionReadPaths the same way runner.ts does ----------
// We mimic the patterns: workers/lead/reviewer/diagnosis each get the
// base shared refs + evidence bundle + evidence read paths.
const baseSharedRefs = [
  path.join(campaignRoot, "run-trace.json"),
  path.join(campaignRoot, "run-trace-digest.json"),
  path.join(campaignRoot, "pending-current"),
  path.join(campaignRoot, "exploration-tree.json"),
  path.join(campaignRoot, "working-memory.json"),
  path.join(campaignRoot, "routing-control.json"),
  path.join(campaignRoot, "dispatch-tickets.json"),
  path.join(campaignRoot, "blank-agent-acceptance-diagnosis.json"),
  path.join(acceptanceRoot, "result.json"),
]
const baseRoleInputs = {
  campaignWorker: { ...baseSharedRefs },
  campaignLead: { ...baseSharedRefs },
  campaignReviewer: { ...baseSharedRefs },
  diagnosis: { ...baseSharedRefs },
}
for (const role of Object.values(baseRoleInputs)) {
  role.permissionReadPaths = [
    ...baseSharedRefs,
    generated.bundlePath,
    ...evidenceReadable,
  ]
}

// ---------- Invariant 1: every role's permissionReadPaths include the bundle's exact files ----------
for (const [role, bag] of Object.entries(baseRoleInputs)) {
  if (!bag.permissionReadPaths.includes(generated.bundlePath)) {
    fail(`[${role}] expected permissionReadPaths to include bundle path ${generated.bundlePath}`)
  }
  for (const required of evidenceReadable) {
    if (!bag.permissionReadPaths.includes(required)) {
      fail(`[${role}] expected permissionReadPaths to include evidence file ${required}`)
    }
  }
}

// ---------- Invariant 2: every role's permissionReadPaths pass assertNoDirectoryReadPaths ----------
for (const [role, bag] of Object.entries(baseRoleInputs)) {
  try {
    assertNoDirectoryReadPaths(bag.permissionReadPaths, `${role} smoke permissionReadPaths`)
  } catch (error) {
    fail(`[${role}] assertNoDirectoryReadPaths threw: ${(error as Error).message}`)
  }
}

// ---------- Invariant 3: unsafe directories must NOT appear ----------
// Use the SAME heuristic as assertNoDirectoryReadPaths: only flag a path
// when its last segment is a known unsafe directory name (or has no file
// extension). Exact files INSIDE unsafe directories (e.g. session/prompt.txt
// under blank-eval-runs/) are evidence artifacts and must remain readable.
const unsafeDirMarkers = [
  "blank-eval-runs",
  "clean-skill-roots",
  "validation-expert-workspace",
  "validators",
  "private-answers",
  "ground-truth",
  "answer-key",
]
const isUnsafeDirPath = (p: string): boolean => {
  const norm = p.replace(/\\/g, "/").toLowerCase()
  if (norm.endsWith("result.private.json")) return true
  for (const marker of unsafeDirMarkers) {
    const segments = norm.split("/")
    const last = segments[segments.length - 1]
    if (last === marker) return true // path IS a directory
    if (marker === "private-answers" || marker === "ground-truth" || marker === "answer-key") {
      if (norm.includes(`/${marker}/`)) return true
    }
    if (marker === "validators" && !norm.endsWith("result.training.json")) {
      if (last === marker || (!last.includes(".") && norm.includes(`/${marker}/`))) return true
    }
  }
  return false
}
for (const [role, bag] of Object.entries(baseRoleInputs)) {
  const offending = bag.permissionReadPaths.find((p) => isUnsafeDirPath(p))
  if (offending) {
    fail(`[${role}] permissionReadPaths leaked unsafe path: ${offending}`)
  }
}

// ---------- Invariant 4: assertNoDirectoryReadPaths actually throws on a leaked directory ----------
const badPaths = [
  ...baseSharedRefs,
  generated.bundlePath,
  ...evidenceReadable,
  path.join(acceptanceRoot, "blank-eval-runs"), // unsafe directory
]
let didThrow = false
try {
  assertNoDirectoryReadPaths(badPaths, "smoke-leaked-dir")
} catch (error) {
  didThrow = true
  const msg = (error as Error).message
  if (!msg.includes("blank-eval-runs")) {
    fail(`assertNoDirectoryReadPaths threw but for wrong reason: ${msg}`)
  }
}
if (!didThrow) fail("assertNoDirectoryReadPaths did NOT throw when blank-eval-runs directory was leaked.")

// ---------- Invariant 5: assertNoDirectoryReadPaths throws on result.private.json ----------
const privateLeak = [
  ...baseSharedRefs,
  path.join(validatorDir, "result.private.json"),
]
let didThrowPrivate = false
try {
  assertNoDirectoryReadPaths(privateLeak, "smoke-leaked-private")
} catch (error) {
  didThrowPrivate = true
  if (!(error as Error).message.includes("Private view leaked")) {
    fail(`assertNoDirectoryReadPaths should have flagged private view, got: ${(error as Error).message}`)
  }
}
if (!didThrowPrivate) fail("assertNoDirectoryReadPaths did NOT throw when result.private.json was leaked.")

// ---------- Invariant 6: assertNoDirectoryReadPaths accepts validators/<id>/result.training.json ----------
const trainingOk = [
  ...baseSharedRefs,
  path.join(validatorDir, "result.training.json"),
]
try {
  assertNoDirectoryReadPaths(trainingOk, "smoke-training-ok")
} catch (error) {
  fail(`assertNoDirectoryReadPaths should accept result.training.json but threw: ${(error as Error).message}`)
}

console.log(
  JSON.stringify(
    {
      passed: true,
      roles: Object.keys(baseRoleInputs),
      evidenceReadableCount: evidenceReadable.length,
      bundlePath: generated.bundlePath,
      unsafeMarkersChecked: unsafeDirMarkers.length,
    },
    null,
    2,
  ),
)
