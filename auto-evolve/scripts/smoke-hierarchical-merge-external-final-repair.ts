import path from "node:path"
import { rm } from "node:fs/promises"
import { ensureDirectory, readJsonFile, writeJsonFile, writeTextFile } from "../orchestrator/fs"
import { runHierarchicalMergeLongTask } from "./run-hierarchical-merge-long-task"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function seed(root: string) {
  const sourcePack = path.join(root, "source-pack")
  const sourceRuns = path.join(root, "source-runs")
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
  return { sourcePack, splitPath, manifestPath, ids }
}

async function main() {
  const cwd = path.resolve(import.meta.dir, "..", "..")
  const root = path.join(cwd, "auto-evolve", ".tmp-smoke", "hierarchical-msl-external-final-repair")
  await rm(root, { recursive: true, force: true })
  const seeded = await seed(root)
  const phases: string[] = []

  const report = await runHierarchicalMergeLongTask({
    cwd,
    taskPackRoot: seeded.sourcePack,
    splitPath: seeded.splitPath,
    campaignManifestPath: seeded.manifestPath,
    outRoot: path.join(root, "out"),
    label: "smoke-msl-external-final-repair",
    taskProfile: "multi_skill_merge_v2",
    accessSystem: "profile_v2",
    groupSize: 2,
    groupConcurrency: 1,
    replayConcurrency: 2,
    mountBlankReplay: false,
    maxReplayRepairAttempts: 2,
    runner: async (input) => {
      const skillRoot = path.join(path.dirname(input.group.specPath), "workspace", "merged-skill")
      await writeTextFile(path.join(skillRoot, "INDEX.md"), "# merged\n")
      await writeTextFile(path.join(skillRoot, "CORE.md"), `# core\n\n${input.group.groupID}\n`)
      return {
        ok: true,
        status: "verified_success",
        campaignID: `smoke-${input.group.groupID}`,
        campaignDir: path.join(root, "campaigns", input.group.groupID),
        outputSkillPath: skillRoot,
      }
    },
    externalFinalAcceptance: {
      caseIDs: seeded.ids,
      stages: ["initial_replay", "repair_promote", "final_full_replay", "strict_acceptance_gate"],
      successCriterion: "all_pass",
      maxRepairAttempts: 2,
      runner: async (input) => {
        phases.push(`${input.phase}:${input.caseIDs.join(",")}`)
        await ensureDirectory(input.outDir)
        const failed = input.phase === "initial_replay" ? new Set(["case-b"]) : new Set<string>()
        const cases = input.caseIDs.map((id) => ({
          id,
          passed: !failed.has(id),
          summary: failed.has(id) ? "mock failure" : "mock pass",
          resultPath: path.join(input.outDir, `${id}.json`),
        }))
        for (const item of cases) await writeJsonFile(item.resultPath, item)
        return {
          passed: cases.filter((item) => item.passed).length,
          total: cases.length,
          failed: cases.filter((item) => !item.passed).length,
          cases,
          resultPath: path.join(input.outDir, "summary.json"),
        }
      },
    },
  })

  assert(report.status === "complete", "external final repair hierarchy must complete")
  assert(report.externalFinalAcceptance?.accepted === true, "external final acceptance must pass")
  assert(report.externalFinalAcceptance?.acceptanceStatus === "final_replay_passed", "final replay status must be accurate")
  assert(report.externalFinalAcceptance?.repairAttempts === 1, "exactly one repair campaign must run")
  assert(report.finalSkillPath?.includes("repairs"), "the promoted Skill must come from the repair campaign")
  assert(
    phases.join("|") ===
      "initial_replay:case-a,case-b|focused_replay:case-b|protected_replay:case-a|final_full_replay:case-a,case-b",
    `unexpected external acceptance sequence: ${phases.join("|")}`,
  )
  const repairTargets = await readJsonFile<any>(
    path.join(root, "out", "external-final-acceptance", "repair-targets", "attempt-01", "repair-targets.json"),
  )
  assert(repairTargets.failedCaseIDs.join(",") === "case-b", "repair targets must contain only the failed case")
  assert(repairTargets.targets[0]?.sourceSkillFiles?.length > 0, "repair target must retain frozen leaf Skill files")

  const regressionPhases: string[] = []
  const regressionReport = await runHierarchicalMergeLongTask({
    cwd,
    taskPackRoot: seeded.sourcePack,
    splitPath: seeded.splitPath,
    campaignManifestPath: seeded.manifestPath,
    outRoot: path.join(root, "regression-cycle"),
    label: "smoke-msl-external-regression-cycle",
    taskProfile: "multi_skill_merge_v2",
    accessSystem: "profile_v2",
    groupSize: 2,
    mountBlankReplay: false,
    maxReplayRepairAttempts: 2,
    runner: async (input) => {
      const skillRoot = path.join(path.dirname(input.group.specPath), "workspace", "merged-skill")
      await writeTextFile(path.join(skillRoot, "INDEX.md"), "# merged\n")
      return { ok: true, status: "verified_success", outputSkillPath: skillRoot }
    },
    externalFinalAcceptance: {
      caseIDs: seeded.ids,
      stages: ["initial_replay", "repair_promote"],
      successCriterion: "all_pass",
      maxRepairAttempts: 2,
      runner: async (input) => {
        regressionPhases.push(`${input.phase}:${input.caseIDs.join(",")}`)
        const failID =
          input.phase === "initial_replay"
            ? "case-b"
            : input.phase === "protected_replay" && input.repairAttempt === 1
              ? "case-a"
              : undefined
        const cases = input.caseIDs.map((id) => ({ id, passed: id !== failID, summary: id === failID ? "mock regression" : "mock pass" }))
        return {
          passed: cases.filter((item) => item.passed).length,
          total: cases.length,
          failed: cases.filter((item) => !item.passed).length,
          cases,
        }
      },
    },
  })
  assert(regressionReport.externalFinalAcceptance?.accepted === true, "regression cycle must recover")
  assert(regressionReport.externalFinalAcceptance?.repairAttempts === 2, "regressed protected case must trigger a second repair")
  assert(
    regressionPhases.join("|") ===
      "initial_replay:case-a,case-b|focused_replay:case-b|protected_replay:case-a|focused_replay:case-a|protected_replay:case-b",
    `protected regression did not flow back correctly: ${regressionPhases.join("|")}`,
  )

  let missingFailed = false
  try {
    await runHierarchicalMergeLongTask({
      cwd,
      taskPackRoot: seeded.sourcePack,
      splitPath: seeded.splitPath,
      campaignManifestPath: seeded.manifestPath,
      outRoot: path.join(root, "missing-result"),
      label: "smoke-msl-external-missing-result",
      taskProfile: "multi_skill_merge_v2",
      accessSystem: "profile_v2",
      groupSize: 2,
      mountBlankReplay: false,
      runner: async (input) => {
        const skillRoot = path.join(path.dirname(input.group.specPath), "workspace", "merged-skill")
        await writeTextFile(path.join(skillRoot, "INDEX.md"), "# merged\n")
        return { ok: true, status: "verified_success", outputSkillPath: skillRoot }
      },
      externalFinalAcceptance: {
        caseIDs: seeded.ids,
        stages: ["initial_replay"],
        successCriterion: "all_pass",
        runner: async () => ({
          passed: 1,
          total: 2,
          failed: 1,
          cases: [{ id: "case-a", passed: true }],
        }),
      },
    })
  } catch (error) {
    missingFailed = String(error).includes("omitted case")
  }
  assert(missingFailed, "missing external case results must fail closed")

  console.log(JSON.stringify({ ok: true, phases, regressionPhases, finalSkillPath: report.finalSkillPath, missingFailed }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
