import path from "node:path"
import { rm } from "node:fs/promises"
import { ensureDirectory, readJsonFile, writeJsonFile, writeTextFile } from "../orchestrator/fs"
import { runMergeLongTaskReplay } from "../orchestrator/merge-long-task-replay"
import { createMergeLongTaskPack } from "./create-merge-long-task-pack"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main() {
  const cwd = path.resolve(import.meta.dir, "..", "..")
  const root = path.join(cwd, "auto-evolve", ".tmp-smoke", "merge-long-task-replay-isolation")
  const sourcePack = path.join(root, "source-pack")
  const sourceRuns = path.join(root, "source-runs")
  const outPack = path.join(root, "merge-pack")
  await rm(root, { recursive: true, force: true })

  const ids = ["case-a", "case-b"]
  for (const id of ids) {
    const taskDir = path.join(sourcePack, "tasks", id)
    const skillDir = path.join(sourceRuns, id, "pending-expert-package", "current")
    await writeTextFile(path.join(taskDir, "instruction.md"), `# ${id}\n`)
    await writeJsonFile(path.join(taskDir, "spec.json"), {
      id,
      title: id,
      goal: `solve ${id}`,
      materials: [{ path: "./instruction.md", role: "instructions" }],
      targetPaths: [{ path: "./workspace/answer.txt", role: "answer" }],
      editablePaths: ["./workspace/answer.txt"],
      validators: [],
    })
    await writeTextFile(path.join(skillDir, "INDEX.md"), `# ${id}\n\nRead CORE.md.\n`)
    await writeTextFile(path.join(skillDir, "CORE.md"), `# CORE\n\nReusable lesson for ${id}.\n`)
  }
  const splitPath = path.join(root, "split.json")
  const manifestPath = path.join(root, "manifest.json")
  await writeJsonFile(splitPath, { ids })
  await writeJsonFile(manifestPath, {
    items: ids.map((id) => ({
      id,
      status: "verified_success",
      campaignDir: path.join(sourceRuns, id),
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
    mountBlankReplay: false,
  })
  const group = generated.groups[0]!
  const candidateSkillRoot = path.join(path.dirname(group.specPath), "workspace", "merged-skill")
  let validatorCalls = 0
  const validatorRunner = async () => {
    validatorCalls += 1
    return ({
      descriptor: {} as never,
      result: {
        id: "validator-smoke",
        runID: "smoke",
        unitID: "msl-supervisor-replay",
        attempt: 1,
        validatorID: "msl-supervisor-blank-replay",
        validatorType: "engine",
        createdAt: new Date().toISOString(),
        passed: false,
        blocking: true,
        failureKind: "product_failure",
        summary: "one replay case failed",
        details: [],
        evidenceRefs: [],
      },
      raw: {
        caseResults: [
          { id: "case-a", passed: true, summary: "passed" },
          {
            id: "case-b",
            passed: false,
            summary: "failed",
            resultPath: path.join(root, "case-b-result.json"),
            evidenceBundlePath: path.join(root, "case-b-evidence.json"),
          },
        ],
      },
      views: {} as never,
    }) as never
  }
  const replay = await runMergeLongTaskReplay({
    cwd,
    mergeSpecPath: group.specPath,
    candidateSkillRoot,
    outDir: path.join(root, "acceptance"),
    concurrency: 2,
    validatorRunner,
  })
  assert(!replay.passed, "failed replay must fail closed")
  assert(JSON.stringify(replay.failedCaseIDs) === JSON.stringify(["case-b"]), "failed case ID must be preserved")
  const targets = await readJsonFile<any>(replay.repairTargetsPath)
  assert(targets.targets.length === 1, "repair targets must include only failed cases")
  assert(targets.targets[0].caseID === "case-b", "repair target must point to the failed case")
  assert(Array.isArray(targets.targets[0].sourceSkillFiles) && targets.targets[0].sourceSkillFiles.length === 2, "repair target must expose exact frozen leaf files")
  assert(
    targets.targets[0].sourceSkillFiles.every((item: string) => item.includes("source-leaf-skills")),
    "repair target must resolve to task-local frozen leaf skills",
  )
  const reusedReplay = await runMergeLongTaskReplay({
    cwd,
    mergeSpecPath: group.specPath,
    candidateSkillRoot,
    outDir: path.join(root, "acceptance"),
    concurrency: 2,
    validatorRunner,
  })
  assert(reusedReplay.reused === true, "completed replay must be reused after supervisor restart")
  assert(validatorCalls === 1, "reusing a completed replay must not call the validator again")

  console.log(
    JSON.stringify(
      {
        ok: true,
        failedCaseIDs: replay.failedCaseIDs,
        repairTargetsPath: replay.repairTargetsPath,
        replayReused: reusedReplay.reused,
        validatorCalls,
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
