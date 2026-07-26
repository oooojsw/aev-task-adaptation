import path from "node:path"
import { rm, stat } from "node:fs/promises"
import { runBlankEval } from "../orchestrator/blank-eval/runner"
import { autoEvolvePath, ensureDirectory, pathExists, writeJsonFile, writeTextFile } from "../orchestrator/fs"

function pad(value: number, width = 2) {
  return String(value).padStart(width, "0")
}

function stamp() {
  const now = new Date()
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`
}

async function main() {
  const candidateCwd = process.argv[2] ? path.resolve(process.argv[2]) : undefined
  const cwd =
    candidateCwd && (await stat(candidateCwd).then((info) => info.isDirectory()).catch(() => false))
      ? candidateCwd
      : path.resolve(import.meta.dir, "..", "..")
  const root = path.join(autoEvolvePath(cwd), "runtime-state", "tmp-smoke-blank-eval-reset-guard", stamp())
  const task = path.join(root, "task")
  const materials = path.join(task, "materials")
  const skill = path.join(root, "skill")
  const victim = path.join(root, "outside-sandbox-victim.txt")
  const specPath = path.join(task, "spec.json")

  await ensureDirectory(materials)
  await ensureDirectory(skill)
  await writeTextFile(path.join(materials, "source.txt"), "This smoke should fail before any model call.\n")
  await writeTextFile(path.join(skill, "INDEX.md"), "# Smoke Skill\n\nNo model should run in this smoke.\n")
  await writeTextFile(victim, "must survive\n")
  await writeJsonFile(specPath, {
    id: "blank-eval-reset-sandbox-guard",
    title: "Blank Eval Reset Sandbox Guard",
    goal: "This smoke intentionally points output outside the sandbox and must be rejected before model startup.",
    taskFamily: "blank-eval-smoke",
    materials: [{ path: path.join(materials, "source.txt"), label: "source", role: "material" }],
    targetPaths: [{ path: victim, label: "victim", role: "target-artifact" }],
    editablePaths: [victim],
    validators: [
      {
        id: "not-reached",
        type: "script",
        title: "Not Reached",
        path: path.join(autoEvolvePath(cwd), "scripts", "validate-text-target-contains.ps1"),
        runner: "powershell",
        inputMode: "json_file",
        args: ["never-called"],
        required: true,
        blocking: true,
      },
    ],
  })

  const result = await runBlankEval({
    cwd,
    specPath,
    skillRoots: [skill],
    runRoot: path.join(root, "runs"),
    sourceID: "blank-eval-reset-sandbox-guard",
    mode: "smoke",
  })
  if (!(await pathExists(victim))) throw new Error("Outside-sandbox victim was deleted.")
  const publicSpecPath = path.join(result.runDir, "sandbox", "materials", "spec.json")
  const publicSpec = JSON.parse(await Bun.file(publicSpecPath).text()) as {
    targetPaths?: Array<{ path?: string }>
    editablePaths?: string[]
  }
  const sandboxRoot = path.join(result.runDir, "sandbox")
  for (const item of [...(publicSpec.targetPaths ?? []).map((row) => row.path ?? ""), ...(publicSpec.editablePaths ?? [])]) {
    const rel = path.relative(sandboxRoot, path.resolve(item))
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Public blank-eval path escaped sandbox: ${item}`)
    }
  }

  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ passed: true, remappedOutsideSandboxTarget: true }, null, 2))
}

await main()
