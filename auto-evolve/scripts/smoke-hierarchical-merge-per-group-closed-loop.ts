import path from "node:path"
import { rm } from "node:fs/promises"
import { ensureDirectory, readJsonFile, writeJsonFile, writeTextFile } from "../orchestrator/fs"
import { loadConfig } from "../orchestrator/schema"
import { runHierarchicalMergeLongTask } from "./run-hierarchical-merge-long-task"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function seed(root: string, count: number) {
  const sourcePack = path.join(root, "source-pack")
  const sourceRuns = path.join(root, "source-runs")
  const ids = Array.from({ length: count }, (_, index) => `case-${String(index + 1).padStart(2, "0")}`)
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
    await writeTextFile(path.join(skillDir, "INDEX.md"), `# ${id}\n`)
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
  const root = path.join(cwd, "auto-evolve", ".tmp-smoke", "hierarchical-msl-per-group-closed-loop")
  await rm(root, { recursive: true, force: true })
  const seeded = await seed(root, 10)
  const projectConfig = await loadConfig(path.join(cwd, "auto-evolve"))
  assert(projectConfig.mergeConfig.asLongTask.preset === "msl_layer_closed_loop", "formal config must select the layer preset")
  assert(projectConfig.mergeConfig.asLongTask.acceptanceTiming === "per_group", "formal config must select per_group acceptance")
  assert(projectConfig.mergeConfig.asLongTask.acceptanceConcurrency === 5, "formal config must load acceptance concurrency")
  assert(
    projectConfig.mergeConfig.asLongTask.replayPolicy === "closed_loop_stable_guard",
    "formal config must select the closed-loop stable guard",
  )
  assert(projectConfig.mergeConfig.asLongTask.finalConfirmation.enabled, "formal config must enable immutable final confirmation")
  const phases: Array<{ phase: string; ids: string[]; repairAttempt: number }> = []
  const finalPhases: Array<{ phase: string; ids: string[] }> = []

  const report = await runHierarchicalMergeLongTask({
    cwd,
    taskPackRoot: seeded.sourcePack,
    splitPath: seeded.splitPath,
    campaignManifestPath: seeded.manifestPath,
    outRoot: path.join(root, "out"),
    label: "smoke-msl-per-group-closed-loop",
    taskProfile: "multi_skill_merge_v2",
    accessSystem: "profile_v2",
    groupSize: 5,
    groupConcurrency: 2,
    replayConcurrency: 5,
    mountBlankReplay: false,
    maxReplayRepairAttempts: 2,
    runner: async (input) => {
      const skillRoot = path.join(path.dirname(input.group.specPath), "workspace", "merged-skill")
      await writeTextFile(path.join(skillRoot, "INDEX.md"), `# ${input.group.groupID}\n`)
      await writeTextFile(path.join(skillRoot, "CORE.md"), `# CORE\n\n${input.group.groupID}\n`)
      return {
        ok: true,
        status: "verified_success",
        campaignID: `smoke-${input.group.groupID}`,
        campaignDir: path.join(root, "campaigns", input.group.groupID),
        outputSkillPath: skillRoot,
      }
    },
    perGroupAcceptance: {
      stages: ["initial_replay", "repair_promote"],
      successCriterion: "all_pass",
      maxRepairAttempts: 2,
      runner: async (input) => {
        phases.push({ phase: input.phase, ids: [...input.caseIDs], repairAttempt: input.repairAttempt })
        await ensureDirectory(input.outDir)
        const failID = input.phase === "initial_replay" ? input.caseIDs.at(-1) : undefined
        const cases = input.caseIDs.map((id) => ({
          id,
          passed: id !== failID,
          summary: id === failID ? "mock product failure" : "mock pass",
        }))
        return {
          passed: cases.filter((item) => item.passed).length,
          total: cases.length,
          failed: cases.filter((item) => !item.passed).length,
          cases,
        }
      },
    },
    externalFinalAcceptance: {
      caseIDs: seeded.ids,
      stages: ["initial_replay", "strict_acceptance_gate"],
      successCriterion: "all_pass",
      maxRepairAttempts: 0,
      runner: async (input) => {
        finalPhases.push({ phase: input.phase, ids: [...input.caseIDs] })
        const cases = input.caseIDs.map((id) => ({ id, passed: true, summary: "immutable confirmation pass" }))
        return { passed: cases.length, total: cases.length, failed: 0, cases }
      },
    },
  })

  assert(report.status === "complete", `expected complete, got ${report.status}`)
  assert(report.hierarchyBuilt === true, "hierarchyBuilt must be true")
  assert(report.acceptanceCompleted === true, "acceptanceCompleted must be true")
  assert(report.accepted === true, "accepted must be true")
  assert(report.levels.length === 2, `expected two levels, got ${report.levels.length}`)
  assert(report.levels[0]?.groupCount === 2, "level 1 must contain two groups")
  assert(report.levels[0]?.successCount === 2, "both level-1 groups must pass their own replay")
  assert(report.levels[1]?.groupCount === 1, "level 2 must contain the final group")
  assert(report.levels[1]?.successCount === 1, "final group must pass its own replay")

  const initialScopes = phases.filter((item) => item.phase === "initial_replay").map((item) => item.ids.length).sort((a, b) => a - b)
  assert(initialScopes.join(",") === "5,5,10", `unexpected per-group scopes: ${initialScopes.join(",")}`)
  const focusedScopes = phases.filter((item) => item.phase === "focused_replay").map((item) => item.ids.length)
  assert(focusedScopes.length === 3 && focusedScopes.every((count) => count === 1), "each group must retest only its failed case")
  const protectedScopes = phases.filter((item) => item.phase === "protected_replay").map((item) => item.ids.length).sort((a, b) => a - b)
  assert(protectedScopes.join(",") === "4,4,9", `unexpected protected scopes: ${protectedScopes.join(",")}`)
  assert(finalPhases.length === 1, "immutable final confirmation must run exactly once")
  assert(finalPhases[0]?.phase === "initial_replay", "immutable final confirmation must not enter repair")
  assert(finalPhases[0]?.ids.length === 10, "immutable final confirmation must cover all source cases")

  const levelOneState = await readJsonFile<any>(
    path.join(root, "out", "acceptance", "level-01", "merge-group-001", "closed-loop-state.json"),
  )
  assert(levelOneState.phase === "accepted", "accepted group state must be durable")
  assert(levelOneState.pendingFailureCaseIDs.length === 0, "accepted group cannot retain failures")
  assert(
    typeof levelOneState.candidateSkillFingerprint === "string" && levelOneState.candidateSkillFingerprint.length === 64,
    "accepted group state must preserve a SHA-256 candidate fingerprint",
  )
  const levelOneRepairTargets = await readJsonFile<any>(
    path.join(
      root,
      "out",
      "acceptance",
      "level-01",
      "merge-group-001",
      "repair-targets",
      "attempt-01",
      "repair-targets.json",
    ),
  )
  assert(levelOneRepairTargets.failedCaseIDs.length === 1, "repair must target only the failed case")
  assert(levelOneRepairTargets.protectedCaseIDs.length === 4, "repair must carry all previously stable cases as protected evidence")
  assert(
    typeof levelOneRepairTargets.candidateSkillFingerprint === "string" &&
      levelOneRepairTargets.candidateSkillFingerprint.length === 64,
    "repair targets must bind to the exact candidate Skill version",
  )

  let infrastructureFailedClosed = false
  let repairRuns = 0
  try {
    await runHierarchicalMergeLongTask({
      cwd,
      taskPackRoot: seeded.sourcePack,
      splitPath: seeded.splitPath,
      campaignManifestPath: seeded.manifestPath,
      outRoot: path.join(root, "infra-failure"),
      label: "smoke-msl-per-group-infra-failure",
      taskProfile: "multi_skill_merge_v2",
      accessSystem: "profile_v2",
      groupSize: 5,
      mountBlankReplay: false,
      runner: async (input) => {
        if (input.group.groupID.includes("repair")) repairRuns += 1
        const skillRoot = path.join(path.dirname(input.group.specPath), "workspace", "merged-skill")
        await writeTextFile(path.join(skillRoot, "INDEX.md"), "# merged\n")
        return { ok: true, status: "verified_success", outputSkillPath: skillRoot }
      },
      perGroupAcceptance: {
        stages: ["initial_replay", "repair_promote"],
        successCriterion: "all_pass",
        maxRepairAttempts: 2,
        runner: async (input) => ({
          passed: 0,
          total: input.caseIDs.length,
          failed: input.caseIDs.length,
          cases: input.caseIDs.map((id) => ({ id, passed: false, summary: "provider timeout" })),
          infrastructureFailures: input.caseIDs.map((id) => ({ id, summary: "provider timeout" })),
        }),
      },
    })
  } catch (error) {
    infrastructureFailedClosed = String(error).includes("refusing to start Skill repair")
  }
  assert(infrastructureFailedClosed, "infrastructure failures must fail closed before repair")
  assert(repairRuns === 0, "infrastructure failures must not start a repair campaign")

  const exhaustedReport = await runHierarchicalMergeLongTask({
      cwd,
      taskPackRoot: seeded.sourcePack,
      splitPath: seeded.splitPath,
      campaignManifestPath: seeded.manifestPath,
      outRoot: path.join(root, "acceptance-exhausted"),
      label: "smoke-msl-per-group-acceptance-exhausted",
      taskProfile: "multi_skill_merge_v2",
      accessSystem: "profile_v2",
      groupSize: 10,
      mountBlankReplay: false,
      runner: async (input) => {
        const skillRoot = path.join(path.dirname(input.group.specPath), "workspace", "merged-skill")
        await writeTextFile(path.join(skillRoot, "INDEX.md"), "# merged\n")
        return { ok: true, status: "verified_success", outputSkillPath: skillRoot }
      },
      perGroupAcceptance: {
        stages: ["initial_replay", "repair_promote"],
        successCriterion: "all_pass",
        maxRepairAttempts: 1,
        runner: async (input) => ({
          passed: 0,
          total: input.caseIDs.length,
          failed: input.caseIDs.length,
          cases: input.caseIDs.map((id) => ({ id, passed: false, summary: "persistent product failure" })),
        }),
      },
    })
  const exhaustedFailedClosed = exhaustedReport.status === "acceptance_exhausted"
  assert(exhaustedFailedClosed, "an exhausted group must stop hierarchy promotion")
  assert(exhaustedReport.accepted === false, "an exhausted hierarchy cannot be accepted")
  assert(exhaustedReport.hierarchyFailure?.failedGroupCount === 1, "exhausted report must count the failed group")
  const exhaustedState = await readJsonFile<any>(
    path.join(
      root,
      "acceptance-exhausted",
      "acceptance",
      "level-01",
      "merge-group-001",
      "closed-loop-state.json",
    ),
  )
  assert(exhaustedState.phase === "acceptance_exhausted", "repair budget exhaustion must be durable")
  assert(exhaustedState.pendingFailureCaseIDs.length === 10, "exhausted state must preserve pending failures")

  const failFastSeeded = await seed(path.join(root, "fail-fast-source"), 15)
  let failFastOriginalGroupRuns = 0
  let failFastAcceptanceCalls = 0
  const runFailFast = async () =>
    runHierarchicalMergeLongTask({
      cwd,
      taskPackRoot: failFastSeeded.sourcePack,
      splitPath: failFastSeeded.splitPath,
      campaignManifestPath: failFastSeeded.manifestPath,
      outRoot: path.join(root, "acceptance-fail-fast"),
      label: "smoke-msl-per-group-acceptance-fail-fast",
      taskProfile: "multi_skill_merge_v2",
      accessSystem: "profile_v2",
      groupSize: 5,
      groupConcurrency: 1,
      mountBlankReplay: false,
      maxReplayRepairAttempts: 1,
      runner: async (input) => {
        if (!input.group.specPath.replace(/\\/g, "/").includes("/repairs/")) failFastOriginalGroupRuns += 1
        const skillRoot = path.join(path.dirname(input.group.specPath), "workspace", "merged-skill")
        await writeTextFile(path.join(skillRoot, "INDEX.md"), "# merged\n")
        return { ok: true, status: "verified_success", outputSkillPath: skillRoot }
      },
      perGroupAcceptance: {
        stages: ["initial_replay", "repair_promote"],
        successCriterion: "all_pass",
        maxRepairAttempts: 1,
        runner: async (input) => {
          failFastAcceptanceCalls += 1
          return {
            passed: 0,
            total: input.caseIDs.length,
            failed: input.caseIDs.length,
            cases: input.caseIDs.map((id) => ({ id, passed: false, summary: "persistent product failure" })),
          }
        },
      },
    })
  const firstFailFastReport = await runFailFast()
  const failFastTriggered = firstFailFastReport.status === "acceptance_exhausted"
  assert(failFastTriggered, "an exhausted group must fail the current hierarchy level")
  assert(
    failFastOriginalGroupRuns === 1,
    `fail-fast must not launch later groups, got ${failFastOriginalGroupRuns} original group runs`,
  )
  const callsAfterFirstFailure = failFastAcceptanceCalls
  const resumedFailFastReport = await runFailFast()
  const resumedFailureReused = resumedFailFastReport.status === "acceptance_exhausted"
  assert(resumedFailureReused, "resuming an exhausted group must preserve the terminal failure")
  assert(
    failFastAcceptanceCalls === callsAfterFirstFailure,
    "resuming an exhausted group must reuse its terminal report without another model evaluation",
  )
  const failFastState = await readJsonFile<any>(
    path.join(root, "acceptance-fail-fast", "hierarchical-live-state.json"),
  )
  assert(failFastState.levels[0].failedCount === 1, "only the attempted exhausted group is failed")
  assert(failFastState.levels[0].notStartedCount === 2, "later fail-fast groups must be reported as not started")
  assert(
    failFastState.levels[0].groups.filter((item: any) => item.status === "not_started").length === 2,
    "unlaunched groups must never be mislabeled as product failures",
  )

  const repairRetrySeeded = await seed(path.join(root, "repair-retry-source"), 5)
  const repairRetryOut = path.join(root, "repair-retry")
  let repairCampaignRuns = 0
  let repairRetryInitialCalls = 0
  const runRepairRetry = async (maxRepairAttempts: number) =>
    runHierarchicalMergeLongTask({
      cwd,
      taskPackRoot: repairRetrySeeded.sourcePack,
      splitPath: repairRetrySeeded.splitPath,
      campaignManifestPath: repairRetrySeeded.manifestPath,
      outRoot: repairRetryOut,
      label: "smoke-msl-repair-campaign-retry",
      taskProfile: "multi_skill_merge_v2",
      accessSystem: "profile_v2",
      groupSize: 5,
      groupConcurrency: 1,
      mountBlankReplay: false,
      maxReplayRepairAttempts: maxRepairAttempts,
      runner: async (input) => {
        const isRepair = input.group.specPath.replace(/\\/g, "/").includes("/repairs/")
        const skillRoot = path.join(path.dirname(input.group.specPath), "workspace", "merged-skill")
        await writeTextFile(path.join(skillRoot, "INDEX.md"), "# merged\n")
        if (!isRepair) return { ok: true, status: "verified_success", outputSkillPath: skillRoot }
        repairCampaignRuns += 1
        return repairCampaignRuns === 1
          ? { ok: false, status: "round_limit_reached", outputSkillPath: skillRoot }
          : { ok: true, status: "verified_success", outputSkillPath: skillRoot }
      },
      perGroupAcceptance: {
        stages: ["initial_replay", "repair_promote"],
        successCriterion: "all_pass",
        maxRepairAttempts,
        runner: async (input) => {
          if (input.phase === "initial_replay") repairRetryInitialCalls += 1
          const failedID = repairRetrySeeded.ids.at(-1)!
          const passAll = input.phase !== "initial_replay"
          const cases = input.caseIDs.map((id) => ({
            id,
            passed: passAll || id !== failedID,
            summary: passAll || id !== failedID ? "pass" : "needs repair",
          }))
          const result = {
            passed: cases.filter((item) => item.passed).length,
            total: cases.length,
            failed: cases.filter((item) => !item.passed).length,
            cases,
          }
          const resultPath = path.join(input.outDir, "result.json")
          await writeJsonFile(resultPath, result)
          return { ...result, resultPath }
        },
      },
    })
  const interruptedRepair = await runRepairRetry(1)
  assert(interruptedRepair.status === "acceptance_exhausted", "first failed repair must consume its one-attempt budget")
  const interruptedReportPath = path.join(
    repairRetryOut,
    "acceptance",
    "level-01",
    "merge-group-001",
    "report.json",
  )
  const interruptedReport = await readJsonFile<any>(interruptedReportPath)
  interruptedReport.acceptanceStatus = "replay_failed"
  interruptedReport.maxRepairAttempts = 2
  await writeJsonFile(interruptedReportPath, interruptedReport)
  const resumedRepair = await runRepairRetry(2)
  assert(resumedRepair.accepted === true, "resume must continue after one repair campaign reaches its round limit")
  assert(repairCampaignRuns === 2, "the failed repair campaign must be followed by the next outer repair attempt")
  assert(repairRetryInitialCalls === 1, "resuming a premature repair failure must not repeat initial replay")

  let immutableRepairRuns = 0
  const immutableFailure = await runHierarchicalMergeLongTask({
    cwd,
    taskPackRoot: seeded.sourcePack,
    splitPath: seeded.splitPath,
    campaignManifestPath: seeded.manifestPath,
    outRoot: path.join(root, "immutable-final-failure"),
    label: "smoke-msl-immutable-final-failure",
    taskProfile: "multi_skill_merge_v2",
    accessSystem: "profile_v2",
    groupSize: 10,
    mountBlankReplay: false,
    runner: async (input) => {
      if (input.group.groupID.includes("repair")) immutableRepairRuns += 1
      const skillRoot = path.join(path.dirname(input.group.specPath), "workspace", "merged-skill")
      await writeTextFile(path.join(skillRoot, "INDEX.md"), "# merged\n")
      return { ok: true, status: "verified_success", outputSkillPath: skillRoot }
    },
    perGroupAcceptance: {
      stages: ["initial_replay", "repair_promote"],
      successCriterion: "all_pass",
      maxRepairAttempts: 1,
      runner: async (input) => ({
        passed: input.caseIDs.length,
        total: input.caseIDs.length,
        failed: 0,
        cases: input.caseIDs.map((id) => ({ id, passed: true, summary: "group pass" })),
      }),
    },
    externalFinalAcceptance: {
      caseIDs: seeded.ids,
      stages: ["initial_replay", "strict_acceptance_gate"],
      successCriterion: "all_pass",
      maxRepairAttempts: 0,
      runner: async (input) => ({
        passed: input.caseIDs.length - 1,
        total: input.caseIDs.length,
        failed: 1,
        cases: input.caseIDs.map((id, index) => ({
          id,
          passed: index !== input.caseIDs.length - 1,
          summary: index === input.caseIDs.length - 1 ? "immutable confirmation failure" : "pass",
        })),
      }),
    },
  })
  assert(immutableFailure.hierarchyBuilt === true, "immutable failure must preserve the built hierarchy")
  assert(immutableFailure.acceptanceCompleted === true, "immutable failure still completed acceptance")
  assert(immutableFailure.accepted === false, "immutable failure cannot be accepted")
  assert(immutableFailure.status === "acceptance_failed", "immutable failure must have a distinct terminal status")
  assert(immutableRepairRuns === 0, "immutable final confirmation must never launch repair")

  console.log(
    JSON.stringify(
      {
        ok: true,
        initialScopes,
        focusedScopes,
        protectedScopes,
        finalPhases,
        infrastructureFailedClosed,
        exhaustedFailedClosed,
        failFastOriginalGroupRuns,
        resumedFailureReused,
        immutableFinalStatus: immutableFailure.status,
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
