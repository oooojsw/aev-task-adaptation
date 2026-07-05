import path from "node:path"
import { rm } from "node:fs/promises"
import { ensureDirectory, readJsonFile, writeJsonFile, writeTextFile } from "../orchestrator/fs"
import { loadLongTaskSpec } from "../orchestrator/long-task/spec"
import { createMergeLongTaskPack } from "./create-merge-long-task-pack"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function writeFakeSkill(root: string, id: string) {
  await writeTextFile(
    path.join(root, "INDEX.md"),
    `# ${id}\n\n## How To Use\n\nRead CORE.md.\n\n## Read Order\n\n1. CORE.md\n\n## Output Requirements\n\nWrite the requested output.\n`,
  )
  await writeTextFile(
    path.join(root, "CORE.md"),
    `# CORE\n\n## Material Navigation Rules\n\nUse visible materials.\n\n## Extraction Rules\n\nExtract from files.\n\n## Calculation Or Transformation Rules\n\nUse formulas, not memorized answers.\n\n## Output Discipline\n\nWrite exactly where asked.\n\n## Failure Lessons\n\nNone.\n`,
  )
  await writeJsonFile(path.join(root, "meta.json"), {
    schema: "auto-evolve-skill/v1",
    profileID: "smoke",
    createdAt: new Date().toISOString(),
  })
  await writeJsonFile(path.join(root, "surface_contract.json"), {
    version: 1,
    entry: "INDEX.md",
    documents: ["INDEX.md", "CORE.md"],
  })
  await writeTextFile(path.join(root, "open_observations.md"), "# Open Observations\n")
  await ensureDirectory(path.join(root, "casebook"))
  await writeTextFile(path.join(root, "casebook", "case.md"), "# Case\n\nReusable note.\n")
}

async function writeFakeSourceTask(taskDir: string, id: string) {
  await writeTextFile(path.join(taskDir, "materials.md"), `# ${id}\n\nFake material.\n`)
  await writeJsonFile(path.join(taskDir, "spec.json"), {
    id,
    title: `Source ${id}`,
    goal: "Fake source task for merge-as-long-task smoke.",
    materials: [{ path: "./materials.md", label: "Fake material", role: "materials" }],
    targetPaths: [{ path: "./workspace", label: "workspace", role: "workspace" }],
    validators: [
      {
        id: "fake-product-validator",
        type: "script",
        title: "Fake product validator",
        path: "../../../scripts/validate-skill-structure-profile.ts",
        runner: "bun",
        placement: "completion_only",
        required: false,
        blocking: false,
        args: ["--help"],
      },
    ],
  })
}

async function main() {
  const cwd = path.resolve(import.meta.dir, "..", "..")
  const root = path.join(cwd, "auto-evolve", ".tmp-smoke", "merge-as-long-task-pack")
  await rm(root, { recursive: true, force: true })
  const sourcePack = path.join(root, "source-pack")
  const runRoot = path.join(root, "runs")
  const outPack = path.join(root, "generated-merge-pack")
  const unsafeOutPack = path.join(root, "unsafe-existing-pack")
  const ids = ["case-a", "case-b"]

  for (const id of ids) {
    await writeFakeSourceTask(path.join(sourcePack, "tasks", id), id)
    await writeFakeSkill(path.join(runRoot, id, "pending-expert-package", "current"), id)
  }

  const splitPath = path.join(root, "split.json")
  const manifestPath = path.join(root, "campaign-manifest.json")
  await writeJsonFile(splitPath, { ids })
  await writeJsonFile(manifestPath, {
    items: ids.map((id) => ({
      id,
      status: "verified_success",
      campaignDir: path.join(runRoot, id),
      specPath: path.join(sourcePack, "tasks", id, "spec.json"),
    })),
  })

  const generated = await createMergeLongTaskPack({
    cwd,
    taskPackRoot: sourcePack,
    splitPath,
    campaignManifestPath: manifestPath,
    outTaskPack: outPack,
    groupSize: 2,
    maxGroups: 1,
    blankAcceptanceMode: "merge-final-full-replay",
  })

  assert(generated.groups.length === 1, "expected one generated merge group")
  assert(generated.blankAcceptanceScenario === "merge_initial_replay", "expected default merge_initial_replay autoMount scenario")
  assert(generated.blankAcceptanceMode === "merge-final-full-replay", "expected default auto-mounted final replay mode")
  assert(
    generated.validatorProfiles.includes("skill-surface/standard-hard-v1") &&
      generated.validatorProfiles.includes("merge-surface/standard-v1"),
    "expected merged surface validator profiles",
  )

  const loaded = await loadLongTaskSpec(generated.groups[0].specPath)
  const spec = loaded.spec
  const campaignSpecPath = path.join(path.dirname(generated.groups[0].specPath), "campaign.json")
  const campaignSpec = await readJsonFile<Record<string, unknown>>(campaignSpecPath)
  assert(typeof campaignSpec.title === "string" && campaignSpec.title, "campaign spec must include title")
  assert(campaignSpec.taskFamily === "merge-long-task", "campaign spec must include merge-long-task family")
  assert(campaignSpec.mode === "graph_iterative", "campaign spec must use graph_iterative mode")
  assert(campaignSpec.baseSpecPath === "./spec.json", "campaign spec must point to ./spec.json")
  assert(campaignSpec.maxRounds === 3, "campaign spec must include maxRounds")
  assert(Array.isArray(campaignSpec.seedTargets) && campaignSpec.seedTargets.length === 1, "campaign spec must seed pending package")
  const seedTarget = campaignSpec.seedTargets[0] as Record<string, unknown>
  assert(seedTarget.targetPath === "./workspace/merged-skill", "campaign seed target must point to merged skill")
  assert(seedTarget.seedPath === "./workspace/merged-skill", "campaign seed path must point to merged skill")
  assert(seedTarget.kind === "experience_workspace", "campaign seed must be an experience workspace")
  assert(seedTarget.resetOnStart === false, "campaign seed must not reset already-running merged skill work")
  const validatorIDs = spec.validators.map((item) => item.id)
  assert(validatorIDs.includes("skill-structure-hard"), "missing skill structure validator")
  assert(validatorIDs.includes("merge-surface-generalization-hard"), "missing merge surface validator")
  const blankPlan = spec.validators.find((item) => item.type === "blank_eval_plan")
  assert(blankPlan, "missing blank eval plan validator")
  assert(blankPlan.validation?.allowedAudiences?.includes("blank_agent") !== true, "blank_agent must not see validators")
  assert(spec.targetPaths?.some((item) => item.role === "experience-workspace"), "missing experience-workspace target")
  const graphCompletionIDs = spec.initialGraph?.completion_validator_ids ?? []
  assert(
    validatorIDs.every((id) => graphCompletionIDs.includes(id)),
    `initial graph completion validators must include all loaded validators. graph=${graphCompletionIDs.join(",")} loaded=${validatorIDs.join(",")}`,
  )

  let unknownProfileFailed = false
  try {
    await createMergeLongTaskPack({
      cwd,
      taskPackRoot: sourcePack,
      splitPath,
      campaignManifestPath: manifestPath,
      outTaskPack: path.join(root, "bad-profile-pack"),
      surfaceProfileSet: "missing-profile-set",
    })
  } catch (error) {
    unknownProfileFailed = String(error).includes("Unknown validationConfig.profileSets")
  }
  assert(unknownProfileFailed, "unknown surface profile set should fail closed")

  await ensureDirectory(unsafeOutPack)
  await writeTextFile(path.join(unsafeOutPack, "human-note.txt"), "do not delete me")
  let unsafeOutputFailed = false
  try {
    await createMergeLongTaskPack({
      cwd,
      taskPackRoot: sourcePack,
      splitPath,
      campaignManifestPath: manifestPath,
      outTaskPack: unsafeOutPack,
    })
  } catch (error) {
    unsafeOutputFailed = String(error).includes("Refusing to delete non-empty directory")
  }
  assert(unsafeOutputFailed, "non-empty unmarked output directory should not be deleted")

  const missingManifestPath = path.join(root, "missing-manifest.json")
  await writeJsonFile(missingManifestPath, {
    items: [
      {
        id: "case-a",
        status: "verified_success",
        campaignDir: path.join(runRoot, "case-a"),
        specPath: path.join(sourcePack, "tasks", "case-a", "spec.json"),
      },
    ],
  })
  let missingManifestFailed = false
  try {
    await createMergeLongTaskPack({
      cwd,
      taskPackRoot: sourcePack,
      splitPath,
      campaignManifestPath: missingManifestPath,
      outTaskPack: path.join(root, "missing-manifest-pack"),
    })
  } catch (error) {
    missingManifestFailed = String(error).includes("Campaign manifest is missing")
  }
  assert(missingManifestFailed, "missing manifest rows should fail closed by default")

  const duplicateSplitPath = path.join(root, "duplicate-split.json")
  await writeJsonFile(duplicateSplitPath, { ids: ["case-a", "case-a"] })
  let duplicateSplitFailed = false
  try {
    await createMergeLongTaskPack({
      cwd,
      taskPackRoot: sourcePack,
      splitPath: duplicateSplitPath,
      campaignManifestPath: manifestPath,
      outTaskPack: path.join(root, "duplicate-split-pack"),
    })
  } catch (error) {
    duplicateSplitFailed = String(error).includes("Split contains duplicate ID")
  }
  assert(duplicateSplitFailed, "duplicate split IDs should fail closed")

  const duplicateManifestPath = path.join(root, "duplicate-manifest.json")
  await writeJsonFile(duplicateManifestPath, {
    items: [
      {
        id: "case-a",
        status: "verified_success",
        campaignDir: path.join(runRoot, "case-a"),
        specPath: path.join(sourcePack, "tasks", "case-a", "spec.json"),
      },
      {
        id: "case-a",
        status: "verified_success",
        campaignDir: path.join(runRoot, "case-a"),
        specPath: path.join(sourcePack, "tasks", "case-a", "spec.json"),
      },
    ],
  })
  let duplicateManifestFailed = false
  try {
    await createMergeLongTaskPack({
      cwd,
      taskPackRoot: sourcePack,
      splitPath,
      campaignManifestPath: duplicateManifestPath,
      outTaskPack: path.join(root, "duplicate-manifest-pack"),
    })
  } catch (error) {
    duplicateManifestFailed = String(error).includes("Campaign manifest contains duplicate ID")
  }
  assert(duplicateManifestFailed, "duplicate manifest IDs should fail closed")

  const reportOnly = await createMergeLongTaskPack({
    cwd,
    taskPackRoot: sourcePack,
    splitPath,
    campaignManifestPath: manifestPath,
    outTaskPack: path.join(root, "report-only-pack"),
    blankAcceptanceScenario: "merge_report_only",
    groupSize: 2,
    maxGroups: 1,
  })
  const reportLoaded = await loadLongTaskSpec(reportOnly.groups[0].specPath)
  const reportBlankPlan = reportLoaded.spec.validators.find((item) => item.type === "blank_eval_plan")
  assert(reportOnly.blankAcceptanceMode === "merge-replay-report", "merge_report_only should auto-mount report mode")
  assert(reportBlankPlan?.blocking === false, "report-only auto-mounted blank eval plan should be non-blocking")

  let unknownScenarioFailed = false
  try {
    await createMergeLongTaskPack({
      cwd,
      taskPackRoot: sourcePack,
      splitPath,
      campaignManifestPath: manifestPath,
      outTaskPack: path.join(root, "unknown-scenario-pack"),
      blankAcceptanceScenario: "typo-scenario",
    })
  } catch (error) {
    unknownScenarioFailed = String(error).includes("Unknown blank acceptance autoMount scenario")
  }
  assert(unknownScenarioFailed, "unknown blank acceptance autoMount scenario should fail closed")

  let invalidSelectionFailed = false
  try {
    await createMergeLongTaskPack({
      cwd,
      taskPackRoot: sourcePack,
      splitPath,
      campaignManifestPath: manifestPath,
      outTaskPack: path.join(root, "invalid-selection-pack"),
      inputSelection: "verified-only" as never,
    })
  } catch (error) {
    invalidSelectionFailed = String(error).includes("Invalid merge inputSelection")
  }
  assert(invalidSelectionFailed, "invalid merge inputSelection should fail closed")

  let invalidGroupSizeFailed = false
  try {
    await createMergeLongTaskPack({
      cwd,
      taskPackRoot: sourcePack,
      splitPath,
      campaignManifestPath: manifestPath,
      outTaskPack: path.join(root, "invalid-group-size-pack"),
      groupSize: 0,
    })
  } catch (error) {
    invalidGroupSizeFailed = String(error).includes("Invalid merge group size")
  }
  assert(invalidGroupSizeFailed, "invalid merge group size should fail closed")

  let invalidReplayConcurrencyFailed = false
  try {
    await createMergeLongTaskPack({
      cwd,
      taskPackRoot: sourcePack,
      splitPath,
      campaignManifestPath: manifestPath,
      outTaskPack: path.join(root, "invalid-replay-concurrency-pack"),
      replayConcurrency: 0,
    })
  } catch (error) {
    invalidReplayConcurrencyFailed = String(error).includes("Invalid replay concurrency")
  }
  assert(invalidReplayConcurrencyFailed, "invalid replay concurrency should fail closed")

  console.log(
    JSON.stringify(
      {
        ok: true,
        generated: generated.groups[0],
        blankAcceptanceScenario: generated.blankAcceptanceScenario,
        blankAcceptanceMode: generated.blankAcceptanceMode,
        validators: validatorIDs,
        graphCompletionIDs,
        negativeChecks: {
          unknownProfileFailed,
          unsafeOutputFailed,
          missingManifestFailed,
          duplicateSplitFailed,
          duplicateManifestFailed,
          unknownScenarioFailed,
          invalidSelectionFailed,
          invalidGroupSizeFailed,
          invalidReplayConcurrencyFailed,
        },
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
