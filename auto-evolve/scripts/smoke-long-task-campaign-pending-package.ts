import path from "node:path"
import { autoEvolvePath, ensureDirectory, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "../orchestrator/fs"
import { runLongTaskCampaign } from "../orchestrator/long-task-campaign/runner"
import { buildMinimalExperienceWorkspaceSeed, experienceWorkspacePathsFromRoot, writeExperienceWorkspaceSnapshot } from "../orchestrator/experience-workspace"

function stamp() {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`
}

async function mustExist(target: string, label: string) {
  if (!(await pathExists(target))) {
    throw new Error(`Missing ${label}: ${target}`)
  }
}

async function main() {
  const cwd = process.cwd()
  const smokeID = `campaign-pending-smoke-${stamp()}`
  const root = autoEvolvePath(cwd, "runtime-state", "campaign-pending-smoke", smokeID)
  const materialsRoot = path.join(root, "materials")
  const seedRoot = path.join(root, "seed-expert-workspace")
  const liveExpertRoot = path.join(root, "expert-workspace")
  const workspaceRoot = path.join(root, "workspace")
  const materialPath = path.join(materialsRoot, "source.txt")
  const taskEntryPath = path.join(root, "00-task-entry.md")
  const goalPath = path.join(root, "goal.txt")
  const specPath = path.join(root, "spec.json")
  const campaignSpecPath = path.join(root, "campaign.json")

  await ensureDirectory(root)
  await ensureDirectory(materialsRoot)
  await ensureDirectory(workspaceRoot)
  await writeTextFile(materialPath, "Campaign smoke material: derive a tiny expert workspace from this source.\n")
  await writeTextFile(taskEntryPath, "# Task Entry\n\n- Build a tiny formal expert workspace.\n")
  await writeTextFile(goalPath, "Learn a tiny expert workspace that can be reviewed and carried across rounds.\n")
  await writeExperienceWorkspaceSnapshot(
    seedRoot,
    buildMinimalExperienceWorkspaceSeed(experienceWorkspacePathsFromRoot(seedRoot, "manifest.md")),
  )

  await writeJsonFile(specPath, {
    title: "campaign-pending-smoke",
    goal: "Learn a tiny formal expert workspace so that campaign pending-package and exploration-tree mechanics can be exercised.",
    taskFamily: "campaign-pending-smoke",
    domainTags: ["smoke", "campaign"],
    materials: [{ path: materialPath, label: "source", role: "source-artifact" }],
    targetPaths: [{ path: liveExpertRoot, label: "expert workspace", role: "experience-workspace" }],
    editablePaths: [liveExpertRoot, workspaceRoot],
    initialExpertContextPaths: [taskEntryPath, goalPath],
    validators: [
      {
        id: "workspace-layout",
        type: "script",
        title: "Workspace layout valid",
        path: path.join(cwd, "auto-evolve", "scripts", "validate-experience-workspace-layout.ts"),
        runner: "bun",
        placement: "completion_only",
        required: true,
        blocking: true,
      },
    ],
    initialGraph: {
      planner_summary: "Smoke graph with one inspect unit and one synthesis unit.",
      completion_validator_ids: ["workspace-layout"],
      units: [
        {
          id: "inspect-source",
          title: "Inspect source",
          goal: "Read the source and task files and leave concise notes in workspace.",
          inputs: [materialPath, taskEntryPath, goalPath],
          depends_on: [],
          expected_artifacts: [workspaceRoot],
          claim: "The source material obligations are captured for later synthesis.",
          check_plan: "Write concise structured notes into workspace.",
          validator_ids: [],
          retry_budget: 1,
        },
        {
          id: "synthesize-expert-workspace",
          title: "Synthesize expert workspace",
          goal: "Produce a minimal governed expert workspace from the source material and notes.",
          inputs: [workspaceRoot, seedRoot],
          depends_on: ["inspect-source"],
          expected_artifacts: [path.join(liveExpertRoot, "manifest.md"), path.join(liveExpertRoot, "change_log.md")],
          claim: "The expert workspace is good enough for governed layout validation.",
          check_plan: "Write or update the tracked expert workspace so it remains a valid governed expert surface.",
          validator_ids: [],
          retry_budget: 1,
        },
      ],
    },
    budgets: {
      maxAttemptsPerUnit: 1,
      maxTotalUnitAttempts: 3,
      maxGraphReplans: 1,
      maxValidatorCalls: 4,
      maxNoProgressCycles: 2,
      maxUnitsPerGraph: 4,
    },
  })

  await writeJsonFile(campaignSpecPath, {
    title: "campaign-pending-smoke-campaign",
    taskFamily: "campaign-pending-smoke",
    mode: "graph_iterative",
    baseSpecPath: specPath,
    maxRounds: 1,
    seedTargets: [
      {
        targetPath: liveExpertRoot,
        seedPath: seedRoot,
        kind: "experience_workspace",
        resetOnStart: true,
      },
    ],
    notes: "Smoke campaign for pending-package/exploration-tree redesign.",
  })

  const result = await runLongTaskCampaign({
    cwd,
    specPath: campaignSpecPath,
  })

  const campaignDir = result.campaignDir
  const campaignState = await readJsonFile<Record<string, unknown>>(path.join(campaignDir, "campaign.json"))
  const generatedRoundSpec = await readJsonFile<Record<string, unknown>>(
    path.join(campaignDir, "rounds", "round-001", "generated-spec.json"),
  )

  await mustExist(path.join(campaignDir, "pending-expert-package", "current", "manifest.md"), "pending current manifest")
  await mustExist(path.join(campaignDir, "exploration-tree.json"), "exploration tree json")
  await mustExist(path.join(campaignDir, "rounds", "round-001", "run-trace.json"), "round run trace")

  if (await pathExists(path.join(campaignDir, "exploration-tree.md"))) {
    throw new Error("Campaign should not emit exploration-tree.md when JSON is the only tree source of truth")
  }

  if (await pathExists(path.join(campaignDir, "rounds", "round-001", "reviewer", "review-suggestion.json"))) {
    throw new Error("Round 1 should not emit a reviewer suggestion before campaign package iteration has begun")
  }

  if (typeof generatedRoundSpec.campaignPendingPackageRoot !== "string") {
    throw new Error("Generated round spec is missing campaignPendingPackageRoot")
  }
  if (typeof generatedRoundSpec.campaignExplorationTreePath !== "string") {
    throw new Error("Generated round spec is missing campaignExplorationTreePath")
  }
  if (generatedRoundSpec.disableCompletionValidators !== true) {
    throw new Error("Generated round spec should disable per-round completion validators")
  }
  const completionValidatorIDs = generatedRoundSpec.initialGraph?.completion_validator_ids
  if (!Array.isArray(completionValidatorIDs) || completionValidatorIDs.length !== 0) {
    throw new Error("Generated round spec should clear initial-graph completion validators")
  }
  if (campaignState.status !== "round_limit_reached") {
    throw new Error(`Expected single-round smoke campaign to stop at round_limit_reached, received ${String(campaignState.status)}`)
  }

  console.log(
    JSON.stringify(
      {
        passed: true,
        smokeID,
        campaignDir,
        status: campaignState.status,
        roundsCompleted: result.roundsCompleted,
        generatedRoundSpec: {
          campaignPendingPackageRoot: generatedRoundSpec.campaignPendingPackageRoot,
          campaignExplorationTreePath: generatedRoundSpec.campaignExplorationTreePath,
        },
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
