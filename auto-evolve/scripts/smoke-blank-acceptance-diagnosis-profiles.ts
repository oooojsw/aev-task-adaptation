import path from "node:path"
import { mkdir, rm, readFile, writeFile } from "node:fs/promises"
import { loadConfig } from "../orchestrator/schema"
import { buildCampaignWorkerPrompt } from "../orchestrator/long-task-campaign/prompts"
import {
  readBlankAgentEvidenceReadablePaths,
  writeBlankAgentEvidenceBundle,
} from "../orchestrator/long-task-campaign/blank-agent-evidence"
import type { LongTaskSpec } from "../orchestrator/long-task/contract"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(message)
    process.exit(1)
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8")
}

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const config = await loadConfig(repoRoot)
const autoProfile = config.blankAcceptanceConfig.diagnosisProfiles.auto
assert(config.blankAcceptanceConfig.enabled, "blankAcceptanceConfig should be enabled by default")
assert(autoProfile, "blankAcceptanceConfig should define auto profile")

const prompt = buildCampaignWorkerPrompt({
  title: "smoke",
  roundNumber: 1,
  role: "blank_acceptance_diagnostician",
  runTracePath: "run-trace.json",
  runTraceDigestPath: "run-trace-digest.json",
  pendingPackageRoot: "pending",
  explorationTreePath: "tree.json",
  workingMemoryPath: "memory.json",
  routingControlPath: "routing.json",
  dispatchTicketsPath: "dispatch.json",
  finalAcceptanceFeedbackPath: "final-acceptance.json",
  blankAgentEvidenceBundlePath: "bundle.json",
  blankAgentEvidenceReadPaths: ["plan-replay.compact.json"],
  blankAcceptanceDiagnosisProfile: autoProfile,
})

assert(prompt.includes("Active blank acceptance diagnosis profile: auto"), "prompt should include active profile")
assert(prompt.includes("Plan-replay diagnosis"), "prompt should include plan-replay diagnosis rules")
assert(prompt.includes("Infrastructure triage"), "prompt should include infrastructure triage rules")

const smokeRoot = path.join(repoRoot, "auto-evolve", "runtime-state", "tmp-smoke-blank-acceptance-diagnosis-profiles")
const campaignRoot = path.join(smokeRoot, "campaign")
const acceptanceRoot = path.join(campaignRoot, "rounds", "round-001", "final-acceptance", "pass-01")
const planRunRoot = path.join(acceptanceRoot, "blank-eval-plan", "plan-001")
const workspaceRoot = path.join(smokeRoot, "workspace")
const validatorDir = path.join(acceptanceRoot, "validators", "blank-eval-plan")

await rm(smokeRoot, { recursive: true, force: true })
await mkdir(planRunRoot, { recursive: true })
await mkdir(validatorDir, { recursive: true })
await mkdir(path.join(workspaceRoot, "workspace"), { recursive: true })

const planResultPath = path.join(planRunRoot, "plan-result.json")
const planSummaryPath = path.join(planRunRoot, "summary.md")
const planEvidencePath = path.join(planRunRoot, "evidence-bundle.json")
await writeJson(planResultPath, {
  schema: "blank-eval-plan-result/v1",
  mode: "parallel",
  passed: false,
  total: 3,
  passedCount: 1,
  failedCount: 2,
  skippedCount: 0,
  score: 1 / 3,
  failedCases: ["case-b", "case-c"],
  summary: "1/3 blank eval cases passed",
  evidenceBundlePath: planEvidencePath,
  summaryPath: planSummaryPath,
  caseResults: [
    { id: "case-a", passed: true, summary: "ok", resultPath: path.join(planRunRoot, "cases", "case-a", "result.json") },
    { id: "case-b", passed: false, failureKind: "answer_mismatch", summary: "wrong table range" },
    { id: "case-c", passed: false, failureKind: "validator_infrastructure", summary: "candidate file missing" },
  ],
})
await writeJson(planEvidencePath, {
  schema: "blank-eval-plan-evidence/v1",
  failedCases: ["case-b", "case-c"],
})
await writeFile(planSummaryPath, "# plan summary\n", "utf8")
await writeJson(path.join(validatorDir, "result.training.json"), {
  passed: false,
  summary: "plan replay failed",
  details: ["case-b wrong range", "case-c missing candidate"],
})
await writeFile(path.join(workspaceRoot, "workspace", "answer.json"), "{}\n", "utf8")

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

const generated = await writeBlankAgentEvidenceBundle({
  cwd: repoRoot,
  campaignID: "smoke-diagnosis-profiles",
  campaignRoot,
  roundNumber: 1,
  passID: "pass-01",
  baseSpec,
  acceptanceRoot,
  acceptanceResultPath: path.join(acceptanceRoot, "result.json"),
  finalAcceptance: {
    passed: false,
    summary: "final acceptance failed",
    validatorResults: [
      {
        validatorID: "blank-eval-plan",
        passed: false,
        evidenceRefs: [planResultPath, planEvidencePath, planSummaryPath, path.join(validatorDir, "result.training.json")],
        rawOutputPath: planResultPath,
      },
    ],
  },
})

const readable = await readBlankAgentEvidenceReadablePaths(generated.bundlePath)
const planCompactPath = readable.find((item) => item.endsWith("plan-replay.compact.json"))
assert(planCompactPath, "evidence readable paths should include plan-replay.compact.json")
const compact = JSON.parse(await readFile(planCompactPath, "utf8"))
assert(compact.schema === "blank-eval-plan-compact/v1", "plan compact schema mismatch")
assert(compact.plans?.[0]?.failedCases?.includes("case-b"), "plan compact should include failed case ids")

console.log("smoke-blank-acceptance-diagnosis-profiles passed")
