import path from "node:path"
import { rm } from "node:fs/promises"
import { runBlankAgentSingleSessionTaskAcceptance } from "../orchestrator/acceptance-framework/task"
import {
  buildMinimalExperienceWorkspaceSeed,
  experienceWorkspacePathsFromRoot,
  restoreExperienceWorkspace,
} from "../orchestrator/experience-workspace"
import { autoEvolvePath, ensureDirectory, writeJsonFile, writeTextFile } from "../orchestrator/fs"

function stamp() {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`
}

async function seedWorkspace(root: string, token: string) {
  const workspacePaths = experienceWorkspacePathsFromRoot(root, "manifest.md")
  const seed = buildMinimalExperienceWorkspaceSeed(workspacePaths)
  seed["core/expert_rules.md"] = [
    "<!-- auto-evolve-role: rule_module -->",
    "# Task Smoke Rules",
    "",
    `- The final target file must contain ${token}.`,
    "",
  ].join("\n")
  seed["core/output_contract.md"] = [
    "<!-- auto-evolve-role: output_contract -->",
    "# Output Contract",
    "",
    `- The final answer written to the target file must include ${token}.`,
    "",
  ].join("\n")
  await restoreExperienceWorkspace(workspacePaths, seed)
  return workspacePaths
}

async function main() {
  const cwd = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()
  const token = `TASK-ACCEPTANCE-SMOKE-${stamp()}`
  const root = path.join(autoEvolvePath(cwd), "runtime-state", "acceptance-framework", "smoke-task", stamp())
  const workspaceRoot = path.join(root, "formal-workspace")
  const taskRoot = path.join(root, "task-pack")
  const materialsDir = path.join(taskRoot, "materials")
  const outputsDir = path.join(taskRoot, "outputs")
  const goalPath = path.join(taskRoot, "goal.txt")
  const sourcePath = path.join(materialsDir, "source.txt")
  const targetPath = path.join(outputsDir, "result.txt")
  const validatorPath = path.join(autoEvolvePath(cwd), "scripts", "validate-text-target-contains.ps1")
  const deploymentSpecPath = path.join(taskRoot, "deployment.json")

  await ensureDirectory(materialsDir)
  await ensureDirectory(outputsDir)
  await seedWorkspace(workspaceRoot, token)

  await writeTextFile(
    sourcePath,
    [
      "This is a task-level blank-agent acceptance smoke material.",
      `Write the token ${token} into the output file.`,
      "",
    ].join("\n"),
  )
  await writeTextFile(goalPath, `Write ${token} into the output file using only the formal expert workspace.\n`)
  await writeJsonFile(deploymentSpecPath, {
    id: "task-acceptance-smoke",
    title: "Task Acceptance Smoke",
    goal: `Write ${token} into the target file using only the formal expert surface.`,
    materials: [{ path: sourcePath, label: "smoke source" }],
    targetPaths: [{ path: targetPath, label: "smoke target", role: "target-artifact" }],
    editablePaths: [outputsDir],
    initialExpertContextPaths: [path.join(workspaceRoot, "manifest.md")],
    validators: [
      {
        id: "contains-token",
        type: "script",
        title: "Target Contains Token",
        path: validatorPath,
        runner: "powershell",
        inputMode: "json_file",
        args: [token],
        required: true,
        blocking: true,
      },
    ],
  })

  try {
    const result = await runBlankAgentSingleSessionTaskAcceptance({
      cwd,
      sourceRunID: `smoke-task-${stamp()}`,
      targetKind: "deployment_run",
      targetID: "smoke-task",
      deploymentSpecPath,
      formalSurfaceRoots: [workspaceRoot],
      harnessRoot: path.join(root, "runs"),
      policyID: "blank-agent-single-session-task-gate",
    })

    const summary = {
      passed: result.passed,
      summary: result.summary,
      runDir: result.runDir,
      acceptanceRecordPath: result.acceptanceRecordPath,
      sessionExecutionReportPath: result.sessionExecutionReportPath,
    }
    await writeJsonFile(path.join(root, "summary.json"), summary)
    console.log(JSON.stringify(summary, null, 2))

    if (!result.passed) {
      throw new Error(result.summary)
    }
  } finally {
    await rm(taskRoot, { recursive: true, force: true })
  }
}

await main()
