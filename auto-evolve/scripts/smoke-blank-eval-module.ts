import path from "node:path"
import { runBlankEval } from "../orchestrator/blank-eval/runner"
import { autoEvolvePath, ensureDirectory, writeJsonFile, writeTextFile } from "../orchestrator/fs"
import { runCoordinatorPhase3Validate } from "../orchestrator/multi-instance/validator"
import type { CoordinatorState } from "../orchestrator/multi-instance/contract"

function pad(value: number, width = 2) {
  return String(value).padStart(width, "0")
}

function stamp() {
  const now = new Date()
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`
}

async function main() {
  const cwd = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(import.meta.dir, "..", "..")
  const token = `BLANK-EVAL-SMOKE-${stamp()}`
  const root = path.join(autoEvolvePath(cwd), "runtime-state", "blank-eval-smoke", stamp())
  const task = path.join(root, "task")
  const skill = path.join(root, "merged-skill")
  const materials = path.join(task, "materials")
  const workspace = path.join(task, "workspace")
  const output = path.join(workspace, "audit-point-output.md")
  const spec = path.join(task, "spec.json")

  await ensureDirectory(materials)
  await ensureDirectory(workspace)
  await ensureDirectory(skill)

  await writeTextFile(path.join(skill, "INDEX.md"), ["# Smoke Skill", "", "Use CORE.md. Write the required token into the declared output file.", ""].join("\n"))
  await writeTextFile(path.join(skill, "CORE.md"), ["# Smoke Skill Core", "", `The output must contain this exact token: ${token}`, ""].join("\n"))
  await writeJsonFile(path.join(skill, "meta.json"), { schema: "blank-eval-smoke-skill/v1", token })
  await writeTextFile(path.join(materials, "source.txt"), [`Material says the required token is ${token}.`, ""].join("\n"))
  await writeTextFile(path.join(task, "human-guidance.md"), "Write exactly one concise result file. Do not create a skill package.\n")
  await writeJsonFile(spec, {
    id: "blank-eval-smoke",
    title: "Blank Eval Smoke",
    goal: `Read the allowed skill and material, then write ${token} into workspace/audit-point-output.md.`,
    taskFamily: "blank-eval-smoke",
    materials: [
      { path: path.join(materials, "source.txt"), label: "source", role: "material" },
      { path: path.join(task, "human-guidance.md"), label: "human guidance", role: "human-guidance" },
    ],
    targetPaths: [{ path: output, label: "audit point output", role: "target-artifact" }],
    editablePaths: [workspace],
    validators: [
      {
        id: "contains-token",
        type: "script",
        title: "Output Contains Token",
        path: path.join(autoEvolvePath(cwd), "scripts", "validate-text-target-contains.ps1"),
        runner: "powershell",
        inputMode: "json_file",
        args: [token],
        required: true,
        blocking: true,
        timeoutMs: 60_000,
      },
    ],
  })

  const result = await runBlankEval({
    cwd,
    specPath: spec,
    skillRoots: [skill],
    runRoot: path.join(root, "runs"),
    sourceID: "blank-eval-smoke",
    mode: "smoke",
  })
  const state: CoordinatorState = {
    id: `blank-eval-smoke-${stamp()}`,
    label: "Blank Eval Phase3 Smoke",
    phase: "phase2_merge",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runRoot: path.join(root, "phase3"),
    mergedSkillDir: skill,
    options: { skillsbenchRoot: task, rounds: 1, fanoutLimit: 1 },
    instances: [
      {
        id: "smoke-instance",
        sourceTaskRoot: task,
        engine: "skillsbench",
        role: "train",
        status: "passed",
        rounds: 1,
        harvestedSkillPath: skill,
      },
    ],
    log: [],
  }
  await ensureDirectory(state.runRoot)
  const phase3 = await runCoordinatorPhase3Validate({
    cwd,
    state,
    rounds: 1,
    validateLimit: 1,
  })
  const summary = {
    passed: result.passed && phase3.passed === 1,
    summary: result.summary,
    runDir: result.runDir,
    resultPath: result.resultPath,
    phase3,
    output,
  }
  await writeJsonFile(path.join(root, "summary.json"), summary)
  console.log(JSON.stringify(summary, null, 2))
  if (!summary.passed) throw new Error(`${result.summary}; phase3 passed ${phase3.passed}/${phase3.total}`)
}

await main()
