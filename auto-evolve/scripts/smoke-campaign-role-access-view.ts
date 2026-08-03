import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { buildCampaignRoleAccessView } from "../orchestrator/long-task-campaign/runner"

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const smokeRoot = path.join(repoRoot, "auto-evolve", "runtime-state", "tmp-smoke-campaign-role-access-view")

async function touch(file: string, content = "{}\n") {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, "utf8")
  return file
}

await rm(smokeRoot, { recursive: true, force: true })

const basePaths = [
  await touch(path.join(smokeRoot, "run-trace.json")),
  await touch(path.join(smokeRoot, "run-trace-digest.json")),
  path.join(smokeRoot, "pending-package"),
  await touch(path.join(smokeRoot, "exploration-tree.json")),
  await touch(path.join(smokeRoot, "working-memory.json")),
  await touch(path.join(smokeRoot, "routing-control.json")),
  await touch(path.join(smokeRoot, "dispatch-tickets.json")),
  await touch(path.join(smokeRoot, "blank-agent-acceptance-diagnosis.json")),
]
await mkdir(path.join(smokeRoot, "pending-package"), { recursive: true })

const optionalPaths = [
  await touch(path.join(smokeRoot, "acceptance-experience.md"), "# acceptance\n"),
  await touch(path.join(smokeRoot, "reviewer-suggestion.json")),
  undefined,
]

const evidenceBundle = await touch(path.join(smokeRoot, "blank-evidence", "bundle.json"))
const blankEvidenceReadPaths = [
  await touch(path.join(smokeRoot, "blank-evidence", "response.txt"), "response\n"),
  await touch(path.join(smokeRoot, "validators", "product", "result.training.json"), '{"passed":false}\n'),
]

const oracleBundle = await touch(path.join(smokeRoot, "expert-oracle", "bundle.json"))
const oraclePaths = [
  await touch(path.join(smokeRoot, "validators", "product", "result.private.json"), '{"answer":"hidden"}\n'),
  await touch(path.join(smokeRoot, "private-answers", "case-001", "answer.txt"), "hidden\n"),
]

const roles = ["worker:success", "worker:failure", "lead", "reviewer", "blank_acceptance_diagnostician"]
for (const role of roles) {
  const access = await buildCampaignRoleAccessView({
    role,
    basePaths,
    optionalPaths,
    blankAgentEvidenceBundlePath: evidenceBundle,
    blankAgentEvidenceReadPaths: blankEvidenceReadPaths,
    expertOracleBundlePath: oracleBundle,
    expertOracleReadPaths: oraclePaths,
    carryoverFiles: [await touch(path.join(smokeRoot, "carryover", `${role.replace(/[:]/g, "-")}.md`), "carryover\n")],
  })

  assert.deepEqual(access.referencePaths, access.permissionReadPaths, `${role}: reference/read paths must be identical`)
  for (const required of [...basePaths, ...optionalPaths.filter(Boolean), evidenceBundle, ...blankEvidenceReadPaths, oracleBundle, ...oraclePaths]) {
    assert(access.permissionReadPaths.includes(required as string), `${role}: missing required path ${required}`)
  }
}

let leakedBlankDir = false
try {
  await buildCampaignRoleAccessView({
    role: "worker:bad-blank-dir",
    basePaths,
    blankAgentEvidenceReadPaths: [path.join(smokeRoot, "blank-eval-runs")],
  })
} catch (error) {
  leakedBlankDir = String((error as Error).message).includes("blank-eval-runs")
}
assert(leakedBlankDir, "blank evidence channel must reject leaked blank-eval-runs directory")

let leakedPrivateToBlank = false
try {
  await buildCampaignRoleAccessView({
    role: "worker:bad-private-in-blank-channel",
    basePaths,
    blankAgentEvidenceReadPaths: [oraclePaths[0]],
  })
} catch (error) {
  leakedPrivateToBlank = String((error as Error).message).includes("result.private.json")
}
assert(leakedPrivateToBlank, "blank evidence channel must reject result.private.json")

let missingOracle = false
try {
  await buildCampaignRoleAccessView({
    role: "lead:missing-oracle",
    basePaths,
    expertOracleReadPaths: [path.join(smokeRoot, "private-answers", "case-404", "missing.txt")],
  })
} catch (error) {
  missingOracle = String((error as Error).message).includes("does not exist")
}
assert(missingOracle, "expert oracle channel must reject missing exact-file paths")

console.log("smoke-campaign-role-access-view: ok")
