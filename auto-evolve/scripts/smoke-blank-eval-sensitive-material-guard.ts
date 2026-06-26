import path from "node:path"
import { rm } from "node:fs/promises"
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
  const cwd = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(import.meta.dir, "..", "..")
  const root = path.join(autoEvolvePath(cwd), "runtime-state", "tmp-smoke-blank-eval-sensitive-material-guard", stamp())
  const task = path.join(root, "task")
  const privateAnswers = path.join(task, "private-answers")
  const skill = path.join(root, "skill")
  const workspace = path.join(task, "workspace")
  const output = path.join(workspace, "answer.txt")
  const specPath = path.join(task, "spec.json")

  await ensureDirectory(privateAnswers)
  await ensureDirectory(skill)
  await ensureDirectory(workspace)
  await writeTextFile(path.join(task, "source.txt"), "Allowed material.\n")
  await writeTextFile(path.join(privateAnswers, "answer.json"), "{\"answer\":\"secret\"}\n")
  await writeTextFile(path.join(skill, "INDEX.md"), "# Smoke Skill\n\nNo model should run in this smoke.\n")
  await writeJsonFile(specPath, {
    id: "blank-eval-sensitive-material-guard",
    title: "Blank Eval Sensitive Material Guard",
    goal: "This smoke intentionally points materials at a directory containing private answers and must fail before model startup.",
    taskFamily: "blank-eval-smoke",
    materials: [{ path: task, label: "task root", role: "material" }],
    targetPaths: [{ path: output, label: "answer", role: "target-artifact" }],
    editablePaths: [workspace],
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

  let rejected = false
  try {
    await runBlankEval({
      cwd,
      specPath,
      skillRoots: [skill],
      runRoot: path.join(root, "runs"),
      sourceID: "blank-eval-sensitive-material-guard",
      mode: "smoke",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    rejected = message.includes("Blank Eval sandbox refuses sensitive input path")
    if (!rejected) throw error
  }

  if (!rejected) throw new Error("Blank Eval did not reject a material directory containing private answers.")
  if (!(await pathExists(path.join(privateAnswers, "answer.json")))) {
    throw new Error("Smoke private answer fixture was unexpectedly deleted.")
  }

  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ passed: true, rejectedSensitiveMaterial: true }, null, 2))
}

await main()
