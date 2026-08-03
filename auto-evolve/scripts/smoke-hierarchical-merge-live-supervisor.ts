import path from "node:path"
import { readdir, rm } from "node:fs/promises"
import { autoEvolvePath, ensureDirectory, readJsonFile, writeJsonFile, writeTextFile } from "../orchestrator/fs"
import { runHierarchicalMergeLongTask, type HierarchicalGroupRunner } from "./run-hierarchical-merge-long-task"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function writeFakeSkill(root: string, id: string) {
  await writeTextFile(path.join(root, "INDEX.md"), `# ${id}\n\nRead CORE.md.\n`)
  await writeTextFile(path.join(root, "CORE.md"), `# CORE ${id}\n\nUse reusable procedures only.\n`)
  await writeJsonFile(path.join(root, "meta.json"), { schema: "auto-evolve-skill/v1", profileID: "live-supervisor-smoke" })
  await writeJsonFile(path.join(root, "surface_contract.json"), { version: 1, entry: "INDEX.md" })
  await writeTextFile(path.join(root, "open_observations.md"), "# Open Observations\n")
  await ensureDirectory(path.join(root, "casebook"))
  await writeTextFile(path.join(root, "casebook", `${id}.md`), `# ${id}\n\nReusable lesson.\n`)
}

async function writeFakeSourceTask(taskDir: string, id: string) {
  await writeTextFile(path.join(taskDir, "materials.md"), `# ${id}\n\nFake material.\n`)
  await writeJsonFile(path.join(taskDir, "spec.json"), {
    id,
    title: `Source ${id}`,
    goal: "Fake source task for live hierarchical merge smoke.",
    materials: [{ path: "./materials.md", label: "Fake material", role: "materials" }],
    targetPaths: [{ path: "./workspace", label: "workspace", role: "workspace" }],
    validators: [],
  })
}

async function main() {
  const cwd = path.resolve(import.meta.dir, "..", "..")
  const root = path.join(cwd, "auto-evolve", ".tmp-smoke", "hierarchical-merge-live-supervisor")
  await rm(root, { recursive: true, force: true })
  const sourcePack = path.join(root, "source-pack")
  const runRoot = path.join(root, "runs")
  const outRoot = path.join(root, "live-out")
  const campaignRoot = path.join(autoEvolvePath(cwd, "runtime-state", "long-task-campaigns"))
  const campaignEntries = await readdir(campaignRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of campaignEntries) {
    if (
      entry.isDirectory() &&
      (entry.name.startsWith("smoke-live-supervisor-") || entry.name.startsWith("smoke-recovery-"))
    ) {
      await rm(path.join(campaignRoot, entry.name), { recursive: true, force: true })
    }
  }
  const ids = Array.from({ length: 10 }, (_, index) => `case-${String(index + 1).padStart(3, "0")}`)

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

  let running = 0
  let maxRunning = 0
  let recoveryInjected = false
  let resumeObserved = false
  const fakeRunner: HierarchicalGroupRunner = async (input) => {
    running += 1
    maxRunning = Math.max(maxRunning, running)
    await ensureDirectory(input.logDir)
    await writeJsonFile(path.join(input.logDir, "fake-run.json"), {
      level: input.level,
      groupID: input.group.groupID,
      campaignPath: input.campaignPath,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    running -= 1
    if (!recoveryInjected && input.level === 1 && input.group.groupID === "merge-group-001") {
      recoveryInjected = true
      const campaignID = "smoke-live-supervisor-recovery-merge-group-001"
      const campaignDir = path.join(autoEvolvePath(cwd, "runtime-state", "long-task-campaigns"), campaignID)
      await ensureDirectory(campaignDir)
      await writeJsonFile(path.join(campaignDir, "campaign.json"), {
        id: campaignID,
        status: "recovery_pending",
        baseSpecPath: path.resolve(input.group.specPath),
        updatedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      })
      return { ok: true, exitCode: 0, summary: "fake recovery pending" }
    }
    if (input.resume && input.campaignID === "smoke-live-supervisor-recovery-merge-group-001") {
      resumeObserved = true
      const campaignDir = path.join(autoEvolvePath(cwd, "runtime-state", "long-task-campaigns"), input.campaignID)
      await writeFakeSkill(path.join(campaignDir, "pending-expert-package", "current"), "recovered-merge-group-001")
      await writeJsonFile(path.join(campaignDir, "campaign.json"), {
        id: input.campaignID,
        status: "verified_success",
        baseSpecPath: path.resolve(input.group.specPath),
        updatedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      })
      return { ok: true, exitCode: 0, summary: "fake recovered" }
    }
    const campaignID = `smoke-live-supervisor-level-${input.level}-${input.group.groupID}`
    const campaignDir = path.join(autoEvolvePath(cwd, "runtime-state", "long-task-campaigns"), campaignID)
    await ensureDirectory(campaignDir)
    await writeFakeSkill(path.join(campaignDir, "pending-expert-package", "current"), `level-${input.level}-${input.group.groupID}`)
    await writeJsonFile(path.join(campaignDir, "campaign.json"), {
      id: campaignID,
      status: "verified_success",
      baseSpecPath: path.resolve(input.group.specPath),
      updatedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    })
    return { ok: true, exitCode: 0, summary: "fake ok" }
  }

  const report = await runHierarchicalMergeLongTask({
    cwd,
    taskPackRoot: sourcePack,
    splitPath,
    campaignManifestPath: manifestPath,
    outRoot,
    label: "live-supervisor-smoke",
    taskProfile: "multi_skill_merge_v2",
    accessSystem: "profile_v2",
    levels: [
      { level: 1, groupSize: 5, groupConcurrency: 2 },
      { level: 2, groupSize: 2, groupConcurrency: 1 },
    ],
    levelPlanningMode: "configured_levels",
    finalizationMode: "merge_remaining_to_one",
    // This smoke verifies todo/active/watch supervision and hierarchy
    // promotion. Replay and repair have their own deterministic smoke.
    mountBlankReplay: false,
    runner: fakeRunner,
  })

  assert(report.status === "complete", `expected complete, got ${report.status}`)
  assert(report.taskProfile === "multi_skill_merge_v2", "report must preserve task profile")
  assert(report.accessSystem === "profile_v2", "report must preserve access system")
  assert(report.levels.length === 2, `expected 2 levels, got ${report.levels.length}`)
  assert(report.levels[0]?.groupCount === 2, "level 1 should have 2 groups")
  assert(report.levels[1]?.groupCount === 1, "level 2 should have 1 final group")
  assert(maxRunning <= 2, `fake runner exceeded configured concurrency, maxRunning=${maxRunning}`)
  assert(recoveryInjected, "smoke did not inject recovery_pending group")
  assert(resumeObserved, "supervisor did not resume recovery_pending group")
  assert(
    String(report.finalSkillPath).includes("pending-expert-package/current"),
    `finalSkillPath should prefer promoted pending package, got ${report.finalSkillPath}`,
  )

  const state = await readJsonFile<any>(path.join(outRoot, "hierarchical-live-state.json"))
  assert(state.schema === "hierarchical-merge-long-task-live-state/v1", "live state schema missing")
  assert(state.taskProfile === "multi_skill_merge_v2", "live state must preserve task profile")
  assert(state.accessSystem === "profile_v2", "live state must preserve access system")
  assert(state.levels[0]?.groups[0]?.status, "live state group status missing")
  assert(
    state.levels.some((level: any) => level.groups.some((group: any) => group.outputSkillPath)),
    "live state should record outputSkillPath for promoted groups",
  )

  console.log(JSON.stringify({ ok: true, levels: report.levels.length, maxRunning, finalSkillPath: report.finalSkillPath }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
