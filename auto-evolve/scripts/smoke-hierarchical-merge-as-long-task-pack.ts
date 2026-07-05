import path from "node:path"
import { rm } from "node:fs/promises"
import { ensureDirectory, readJsonFile, writeJsonFile, writeTextFile } from "../orchestrator/fs"
import { createHierarchicalMergeLongTaskPacks } from "./create-hierarchical-merge-long-task-pack"

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
    `# CORE ${id}\n\n## Material Navigation Rules\n\nUse visible materials.\n\n## Extraction Rules\n\nExtract reusable facts.\n\n## Calculation Or Transformation Rules\n\nUse procedures, not memorized answers.\n\n## Output Discipline\n\nWrite exactly where asked.\n`,
  )
  await writeJsonFile(path.join(root, "meta.json"), {
    schema: "auto-evolve-skill/v1",
    profileID: "hierarchical-smoke",
    createdAt: new Date().toISOString(),
  })
  await writeJsonFile(path.join(root, "surface_contract.json"), {
    version: 1,
    entry: "INDEX.md",
    documents: ["INDEX.md", "CORE.md"],
  })
  await writeTextFile(path.join(root, "open_observations.md"), "# Open Observations\n")
  await ensureDirectory(path.join(root, "casebook"))
  await writeTextFile(path.join(root, "casebook", `${id}.md`), `# ${id}\n\nReusable lesson.\n`)
}

async function writeFakeSourceTask(taskDir: string, id: string) {
  await writeTextFile(path.join(taskDir, "materials.md"), `# ${id}\n\nFake material.\n`)
  await writeJsonFile(path.join(taskDir, "spec.json"), {
    id,
    title: `Source ${id}`,
    goal: "Fake source task for hierarchical merge-as-long-task smoke.",
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
  const root = path.join(cwd, "auto-evolve", ".tmp-smoke", "hierarchical-merge-as-long-task-pack")
  await rm(root, { recursive: true, force: true })
  const sourcePack = path.join(root, "source-pack")
  const runRoot = path.join(root, "runs")
  const outRoot = path.join(root, "hierarchical-out")
  const ids = Array.from({ length: 25 }, (_, index) => `case-${String(index + 1).padStart(3, "0")}`)

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

  const summary = await createHierarchicalMergeLongTaskPacks({
    cwd,
    taskPackRoot: sourcePack,
    splitPath,
    campaignManifestPath: manifestPath,
    outRoot,
    label: "hierarchical-smoke",
    maxInputs: 25,
    replayConcurrency: 5,
    levelPlanningMode: "configured_levels",
    finalizationMode: "merge_remaining_to_one",
    levels: [
      { level: 1, groupSize: 5, groupConcurrency: 5, blankReplayConcurrency: 5 },
      { level: 2, groupSize: 3, groupConcurrency: 2, blankReplayConcurrency: 3 },
      { level: 3, groupSize: 2, groupConcurrency: 1, blankReplayConcurrency: 2 },
    ],
  })

  assert(summary.levels.length === 3, `expected three levels, got ${summary.levels.length}`)
  assert(summary.levels[0]?.groupCount === 5, `expected level 1 to generate 5 groups`)
  assert(summary.levels[1]?.groupCount === 2, `expected level 2 to generate 2 groups`)
  assert(summary.levels[2]?.groupCount === 1, `expected level 3 to generate 1 final group`)
  assert(summary.levels[1]?.groupSize === 3, "level 2 should use per-level groupSize=3")
  assert(summary.levels[2]?.groupConcurrency === 1, "level 3 should record per-level groupConcurrency=1")

  const finalSpecPath = summary.finalSpecPath
  assert(typeof finalSpecPath === "string" && finalSpecPath, "summary must include finalSpecPath")
  const finalTaskDir = path.dirname(finalSpecPath)
  const finalMaterialsDir = path.join(finalTaskDir, "materials")
  const finalManifest = await readJsonFile<any>(path.join(finalMaterialsDir, "input-manifest.json"))
  const finalReplayPlan = await readJsonFile<any>(path.join(finalMaterialsDir, "replay-plan.json"))

  assert(Array.isArray(finalManifest.items), "final input manifest must contain items")
  assert(finalManifest.items.length === 2, `final manifest should contain 2 group skills, got ${finalManifest.items.length}`)
  const sourceCases = finalManifest.items.flatMap((item: any) => Array.isArray(item.sourceCases) ? item.sourceCases : [])
  assert(new Set(sourceCases).size === 25, `final manifest should carry 25 unique source cases, got ${new Set(sourceCases).size}`)
  assert(Array.isArray(finalReplayPlan.cases), "final replay plan must contain cases")
  assert(finalReplayPlan.cases.length === 25, `final replay should expand to 25 original cases, got ${finalReplayPlan.cases.length}`)
  assert(new Set(finalReplayPlan.cases.map((item: any) => item.id)).size === 25, "final replay plan contains duplicate case IDs")

  const level1ReplayPlan = await readJsonFile<any>(
    path.join(outRoot, "level-01", "task-pack", "tasks", "merge-group-001", "materials", "replay-plan.json"),
  )
  assert(level1ReplayPlan.cases.length === 5, "level 1 group replay should only contain its 5 source cases")

  const writtenSummary = await readJsonFile<any>(path.join(outRoot, "hierarchical-summary.json"))
  assert(writtenSummary.schema === "hierarchical-merge-long-task-pack-summary/v1", "summary marker missing")

  const singleSplitPath = path.join(root, "single-split.json")
  const singleOutRoot = path.join(root, "single-out")
  await writeJsonFile(singleSplitPath, { ids: [ids[0]] })
  const singleSummary = await createHierarchicalMergeLongTaskPacks({
    cwd,
    taskPackRoot: sourcePack,
    splitPath: singleSplitPath,
    campaignManifestPath: manifestPath,
    outRoot: singleOutRoot,
    label: "hierarchical-single-smoke",
    singleInputMode: "promote",
  })
  assert(singleSummary.status === "single_input_promoted", `single input should be promoted, got ${singleSummary.status}`)
  assert(typeof singleSummary.finalSkillPath === "string" && singleSummary.finalSkillPath, "single input promote must record finalSkillPath")

  console.log(
    JSON.stringify(
      {
        ok: true,
        levels: summary.levels.map((level: any) => ({
          level: level.level,
          inputCount: level.inputCount,
          groupCount: level.groupCount,
        })),
        finalReplayCases: finalReplayPlan.cases.length,
        finalManifestItems: finalManifest.items.length,
        singleInputStatus: singleSummary.status,
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
