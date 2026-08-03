import assert from "node:assert/strict"
import path from "node:path"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { compileRoleAccess } from "../orchestrator/task-profile-access/compiler"
import {
  buildMultiSkillMergeRoleAccess,
  MULTI_SKILL_MERGE_PROFILE_ID,
} from "../orchestrator/task-profiles/multi-skill-merge"

async function expectFailure(action: () => Promise<unknown>, pattern: RegExp) {
  let message = ""
  try {
    await action()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.match(message, pattern)
}

const root = await mkdtemp(path.join(tmpdir(), "aev-profile-v2-smoke-"))
try {
  const taskRoot = path.join(root, "task")
  const sourceRoot = path.join(taskRoot, "materials", "source-skills")
  const candidateRoot = path.join(root, "campaign", "pending", "current")
  const nextCandidateRoot = path.join(root, "campaign", "round-001", "pending-next")
  const stageDir = path.join(root, "campaign", "round-001", "workers", "inventory")
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(candidateRoot, { recursive: true }),
    mkdir(nextCandidateRoot, { recursive: true }),
    mkdir(stageDir, { recursive: true }),
  ])
  const taskEntry = path.join(taskRoot, "00-task-entry.md")
  const sourceIndex = path.join(sourceRoot, "INDEX.md")
  const candidateIndex = path.join(candidateRoot, "INDEX.md")
  await Promise.all([
    writeFile(taskEntry, "# Merge task\n"),
    writeFile(sourceIndex, "# Frozen source\n"),
    writeFile(candidateIndex, "# Candidate\n"),
  ])

  const auditor = await buildMultiSkillMergeRoleAccess({
    role: "merge_source_inventory_auditor",
    context: {
      stageDir,
      sourceRoots: [sourceRoot],
      taskDefinitionPaths: [taskEntry],
      candidateReadRoot: candidateRoot,
    },
  })
  assert.equal(auditor.profileID, MULTI_SKILL_MERGE_PROFILE_ID)
  assert.ok(auditor.permissionReadPaths.includes(path.resolve(sourceRoot)))
  assert.equal(auditor.permissionEditPaths.length, 0)
  assert.ok(auditor.referencePaths.includes(path.join(stageDir, "access-manifest.json")))

  const leadStage = path.join(root, "campaign", "round-001", "campaign-lead")
  const lead = await buildMultiSkillMergeRoleAccess({
    role: "merge_lead",
    context: {
      stageDir: leadStage,
      sourceRoots: [sourceRoot],
      taskDefinitionPaths: [taskEntry],
      candidateReadRoot: candidateRoot,
      candidateWriteRoots: [nextCandidateRoot],
    },
  })
  assert.deepEqual(lead.permissionEditPaths, [path.resolve(nextCandidateRoot)])
  assert.ok(!lead.permissionEditPaths.includes(path.resolve(sourceRoot)))

  const plannerStage = path.join(root, "campaign", "round-001", "plan")
  const planner = await buildMultiSkillMergeRoleAccess({
    role: "merge_planner",
    context: {
      stageDir: plannerStage,
      sourceRoots: [sourceRoot],
      taskDefinitionPaths: [taskEntry],
      plannerWriteRoots: [plannerStage],
    },
  })
  assert.deepEqual(planner.permissionEditPaths, [path.resolve(plannerStage)])
  assert.ok(planner.permissionReadPaths.includes(path.resolve(sourceRoot)))
  assert.ok(!planner.permissionEditPaths.includes(path.resolve(sourceRoot)))

  await expectFailure(
    () =>
      compileRoleAccess({
        profileID: "escape-smoke",
        policy: {
          roleID: "escape",
          readableViews: ["bad"],
          writableViews: [],
          referenceViews: ["bad"],
          allowedSensitivities: ["public"],
        },
        views: [
          {
            id: "bad",
            paths: [path.join(root, "outside.txt")],
            entryPaths: [path.join(root, "outside.txt")],
            boundaryRoots: [taskRoot],
            sensitivity: "public",
            access: "read_only",
          },
        ],
      }),
    /escapes declared boundaries/,
  )

  await expectFailure(
    () =>
      compileRoleAccess({
        profileID: "source-write-smoke",
        policy: {
          roleID: "bad-writer",
          readableViews: ["source"],
          writableViews: ["source"],
          referenceViews: ["source"],
          allowedSensitivities: ["training"],
        },
        views: [
          {
            id: "source",
            paths: [sourceRoot],
            entryPaths: [sourceIndex],
            boundaryRoots: [sourceRoot],
            sensitivity: "training",
            access: "read_only",
          },
        ],
      }),
    /cannot write read-only view/,
  )

  await expectFailure(
    () =>
      compileRoleAccess({
        profileID: "oracle-smoke",
        policy: {
          roleID: "closed-role",
          readableViews: ["oracle"],
          writableViews: [],
          referenceViews: ["oracle"],
          allowedSensitivities: ["public"],
        },
        views: [
          {
            id: "oracle",
            paths: [sourceIndex],
            entryPaths: [sourceIndex],
            boundaryRoots: [sourceRoot],
            sensitivity: "private_oracle",
            access: "read_only",
          },
        ],
      }),
    /cannot access private_oracle/,
  )

  const linkPath = path.join(taskRoot, "linked-source")
  try {
    await symlink(sourceRoot, linkPath, "junction")
    const linkedEntry = path.join(linkPath, "INDEX.md")
    await expectFailure(
      () =>
        compileRoleAccess({
          profileID: "link-smoke",
          policy: {
            roleID: "link-reader",
            readableViews: ["linked"],
            writableViews: [],
            referenceViews: ["linked"],
            allowedSensitivities: ["training"],
          },
          views: [
            {
              id: "linked",
              paths: [linkedEntry],
              entryPaths: [linkedEntry],
              boundaryRoots: [taskRoot],
              sensitivity: "training",
              access: "read_only",
            },
          ],
        }),
      /symlink or junction/,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/privilege|permitted|1314/i.test(message)) throw error
  }

  console.log(
    JSON.stringify({
      ok: true,
      profile: MULTI_SKILL_MERGE_PROFILE_ID,
      checks: [
        "worker-readonly",
        "lead-write-boundary",
        "planner-graph-only-write-boundary",
        "path-escape-fail-closed",
        "source-write-denied",
        "oracle-sensitivity-denied",
        "symlink-component-denied-when-supported",
      ],
    }),
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
