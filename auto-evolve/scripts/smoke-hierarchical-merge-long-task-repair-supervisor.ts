import path from "node:path"
import { rm } from "node:fs/promises"
import { ensureDirectory, readJsonFile, writeJsonFile, writeTextFile } from "../orchestrator/fs"
import { runHierarchicalMergeLongTask } from "./run-hierarchical-merge-long-task"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main() {
  const cwd = path.resolve(import.meta.dir, "..", "..")
  const root = path.join(cwd, "auto-evolve", ".tmp-smoke", "hierarchical-msl-repair-supervisor")
  const sourcePack = path.join(root, "source-pack")
  const sourceRuns = path.join(root, "source-runs")
  const outRoot = path.join(root, "out")
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

  let replayCalls = 0
  const report = await runHierarchicalMergeLongTask({
    cwd,
    taskPackRoot: sourcePack,
    splitPath,
    campaignManifestPath: manifestPath,
    outRoot,
    label: "smoke-msl-repair-supervisor",
    taskProfile: "multi_skill_merge_v2",
    accessSystem: "profile_v2",
    groupSize: 2,
    groupConcurrency: 1,
    replayConcurrency: 2,
    mountBlankReplay: true,
    maxReplayRepairAttempts: 2,
    runner: async (input) => ({
      ok: true,
      exitCode: 0,
      status: "verified_success",
      campaignID: `smoke-${input.group.groupID}`,
      campaignDir: path.join(root, "campaigns", input.group.groupID),
      outputSkillPath: path.join(path.dirname(input.group.specPath), "workspace", "merged-skill"),
      summary: "smoke campaign completed",
    }),
    replayRunner: async (input) => {
      replayCalls += 1
      await ensureDirectory(input.outDir)
      const repairTargetsPath = path.join(input.outDir, "repair-targets.json")
      const reportPath = path.join(input.outDir, "msl-replay-report.json")
      const failedCaseIDs = replayCalls === 1 ? ["case-b"] : []
      await writeJsonFile(repairTargetsPath, {
        schema: "merge-long-task-repair-targets/v1",
        failedCaseIDs,
        targets: failedCaseIDs.map((caseID) => ({ caseID })),
      })
      await writeJsonFile(reportPath, { passed: failedCaseIDs.length === 0, failedCaseIDs })
      return {
        passed: failedCaseIDs.length === 0,
        reportPath,
        repairTargetsPath,
        failedCaseIDs,
        missingResults: [],
        caseResults: ids.map((id) => ({ id, passed: !failedCaseIDs.includes(id) })),
        validatorResult: {} as never,
      }
    },
  })

  assert(report.status === "complete", "hierarchy must complete after the repair replay passes")
  assert(replayCalls === 2, "supervisor must replay once before and once after repair")
  assert(typeof report.finalSkillPath === "string" && report.finalSkillPath.includes("repairs"), "final skill must come from the repair campaign")
  const firstGroup = report.levels[0]?.groups?.[0]
  assert(firstGroup?.replay?.passed === true, "group replay must be promoted only after repair passes")
  assert(firstGroup?.replay?.repairAttempts?.length === 1, "exactly one repair campaign should be recorded")
  const repairSpec = await readJsonFile<any>(
    path.join(
      outRoot,
      "repairs",
      "level-01",
      "merge-group-001",
      "attempt-01",
      "task-pack",
      "tasks",
      "merge-group-001",
      "spec.json",
    ),
  )
  assert(repairSpec.taskProfile?.id === "multi_skill_merge_v2", "repair must preserve task profile")
  assert(repairSpec.taskProfile?.accessSystem === "profile_v2", "repair must preserve access system")

  console.log(JSON.stringify({ ok: true, replayCalls, finalSkillPath: report.finalSkillPath }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
