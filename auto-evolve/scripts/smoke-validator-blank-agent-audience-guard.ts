import path from "node:path"
import { rm } from "node:fs/promises"
import { loadLongTaskSpec } from "../orchestrator/long-task/spec"
import { autoEvolvePath, ensureDirectory, writeJsonFile, writeTextFile } from "../orchestrator/fs"

function pad(value: number, width = 2) {
  return String(value).padStart(width, "0")
}

function stamp() {
  const now = new Date()
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`
}

async function main() {
  const cwd = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(import.meta.dir, "..", "..")
  const root = path.join(autoEvolvePath(cwd), "runtime-state", "tmp-smoke-validator-blank-agent-audience", stamp())
  const task = path.join(root, "task")
  const material = path.join(task, "material.txt")
  const output = path.join(task, "workspace", "answer.txt")
  const specPath = path.join(task, "spec.json")
  await ensureDirectory(path.dirname(output))
  await writeTextFile(material, "allowed material\n")
  await writeJsonFile(specPath, {
    id: "validator-blank-agent-audience-guard",
    title: "Validator Blank Agent Audience Guard",
    goal: "This smoke should fail during spec loading.",
    taskFamily: "smoke",
    materials: [{ path: material, label: "material", role: "material" }],
    targetPaths: [{ path: output, label: "answer", role: "target-artifact" }],
    editablePaths: [path.dirname(output)],
    validators: [
      {
        id: "bad-audience",
        type: "script",
        title: "Bad Audience",
        path: path.join(autoEvolvePath(cwd), "scripts", "validate-text-target-contains.ps1"),
        runner: "powershell",
        inputMode: "json_file",
        args: ["never-called"],
        required: true,
        blocking: true,
        validation: {
          allowedAudiences: ["blank_agent"],
        },
      },
    ],
  })

  let rejected = false
  try {
    await loadLongTaskSpec(specPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    rejected = message.includes("allowedAudiences") && message.includes("blank_agent")
    if (!rejected) throw error
  }
  if (!rejected) throw new Error("Spec loader did not reject validator.allowedAudiences containing blank_agent.")
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ passed: true, rejectedBlankAgentAudience: true }, null, 2))
}

await main()
