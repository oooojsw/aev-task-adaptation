import path from "node:path"
import { rm } from "node:fs/promises"
import { extractJsonObject } from "../orchestrator/long-task/json-extract"
import {
  buildMinimalExperienceWorkspaceSeed,
  experienceWorkspacePathsFromRoot,
  restoreExperienceWorkspace,
} from "../orchestrator/experience-workspace"
import { autoEvolvePath, ensureDirectory, readJsonFile, readTextFile, writeJsonFile, writeTextFile } from "../orchestrator/fs"

function stamp() {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`
}

function repoRoot(target: string) {
  const root = path.resolve(target)
  if (path.basename(root).toLowerCase() === "auto-evolve") return path.dirname(root)
  return root
}

async function seed(root: string, token: string) {
  const paths = experienceWorkspacePathsFromRoot(root, "manifest.md")
  const files = buildMinimalExperienceWorkspaceSeed(paths)
  files["core/expert_rules.md"] = [
    "<!-- auto-evolve-role: rule_module -->",
    "# Wrapper Smoke Rules",
    "",
    `- Write ${token} into the declared target file.`,
    "",
  ].join("\n")
  files["core/output_contract.md"] = [
    "<!-- auto-evolve-role: output_contract -->",
    "# Output Contract",
    "",
    `- The target file must contain ${token}.`,
    "",
  ].join("\n")
  await restoreExperienceWorkspace(paths, files)
}

function leakWords() {
  return [
    "campaign-working-memory.json",
    "routing-control.json",
    "exploration-tree.json",
    "dispatch-tickets.json",
    "blank-agent-acceptance-diagnosis.json",
    "retry_input_bundle.json",
    "coordinator-state.json",
    "validator_input.json",
    "private-answers",
    "hidden-answer",
  ]
}

async function main() {
  const cwd = repoRoot(process.argv[2] ? path.resolve(process.argv[2]) : process.cwd())
  const token = `TASK-WRAPPER-SMOKE-${stamp()}`
  const root = path.join(autoEvolvePath(cwd), "runtime-state", "acceptance-framework", "smoke-task-wrapper", stamp())
  const task = path.join(root, "task-pack")
  const skill = path.join(root, "formal-workspace")
  const materials = path.join(task, "materials")
  const outputs = path.join(task, "outputs")
  const leaks = path.join(root, "leak-context")
  const target = path.join(outputs, "result.txt")
  const payload = path.join(root, "validator_input.json")
  const spec = path.join(task, "deployment.json")

  await ensureDirectory(materials)
  await ensureDirectory(outputs)
  await ensureDirectory(leaks)
  await seed(skill, token)
  await Promise.all(
    leakWords()
      .filter((item) => item.endsWith(".json"))
      .map((item) => writeTextFile(path.join(leaks, item), JSON.stringify({ leak: item, token }, null, 2))),
  )
  await writeTextFile(path.join(materials, "source.txt"), `The required token is ${token}.\n`)
  await writeJsonFile(spec, {
    id: "task-wrapper-smoke",
    title: "Task Wrapper Smoke",
    goal: `Write ${token} into the target file using only the formal expert surface.`,
    materials: [{ path: path.join(materials, "source.txt"), label: "source", role: "source-artifact" }],
    targetPaths: [{ path: target, label: "target", role: "target-artifact" }],
    editablePaths: [outputs],
    initialExpertContextPaths: [
      path.join(leaks, "campaign-working-memory.json"),
      path.join(leaks, "routing-control.json"),
      path.join(leaks, "exploration-tree.json"),
      path.join(leaks, "dispatch-tickets.json"),
      path.join(leaks, "blank-agent-acceptance-diagnosis.json"),
    ],
    validators: [
      {
        id: "contains-token",
        type: "script",
        title: "Target Contains Token",
        path: path.join(autoEvolvePath(cwd), "scripts", "validate-text-target-contains.ps1"),
        runner: "powershell",
        inputMode: "json_file",
        args: [token],
        required: true,
        blocking: true,
      },
    ],
  })
  await writeJsonFile(payload, {
    runID: `wrapper-smoke-${stamp()}`,
    unitID: "wrapper-smoke-unit",
    targetPaths: [{ path: skill }],
  })

  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        path.join(autoEvolvePath(cwd), "scripts", "run-blank-agent-task-deployment-acceptance.ts"),
        payload,
        spec,
        skill,
      ],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) {
      throw new Error([`wrapper validator exited ${code}`, stdout, stderr].filter(Boolean).join("\n\n"))
    }
    const parsed = extractJsonObject(stdout, { preferredKeys: ["passed", "summary", "runDir"] })
    const runDir = typeof parsed?.runDir === "string" ? parsed.runDir : undefined
    if (!runDir) throw new Error(`wrapper validator did not report runDir:\n${stdout}`)
    const run = await readJsonFile<{
      promptInlineFiles?: string[]
      permissionReadPaths?: string[]
      referencedPaths?: string[]
    }>(path.join(runDir, "session", "run.json"))
    const prompt = await readTextFile(path.join(runDir, "session", "prompt.txt"))
    const exposed = [
      ...((run.promptInlineFiles ?? []).map((item) => `promptInlineFiles:${item}`)),
      ...((run.permissionReadPaths ?? []).map((item) => `permissionReadPaths:${item}`)),
      ...((run.referencedPaths ?? []).map((item) => `referencedPaths:${item}`)),
    ].filter((item) => leakWords().some((word) => item.toLowerCase().includes(word.toLowerCase())))
    const inline = leakWords().filter((word) => {
      if (word === "private-answers" || word === "hidden-answer") return prompt.toLowerCase().includes(word)
      return prompt.includes(`/${word}`) || prompt.includes(`\\${word}`) || prompt.includes(` ${word}`)
    })
    if (exposed.length > 0 || inline.length > 0) {
      throw new Error(["wrapper leaked forbidden runtime context", ...exposed, ...inline.map((item) => `prompt:${item}`)].join("\n"))
    }
    const summary = {
      passed: parsed?.passed === true,
      summary: typeof parsed?.summary === "string" ? parsed.summary : "wrapper smoke completed",
      runDir,
      antiLeakPassed: true,
    }
    await writeJsonFile(path.join(root, "summary.json"), summary)
    console.log(JSON.stringify(summary, null, 2))
    if (!summary.passed) throw new Error(summary.summary)
  } finally {
    await rm(task, { recursive: true, force: true })
  }
}

await main()
