import path from "node:path"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"

type AlfworldRawTask = {
  pddl_domain: string
  grammar: string
  pddl_problem: string
  solvable: boolean
  walkthrough?: string[]
}

type SelectedTask = {
  id: string
  sourcePath: string
  split: "train" | "eval_in_distribution" | "eval_out_of_distribution"
  taskText: string
  raw: AlfworldRawTask
}

const cwd = path.resolve(import.meta.dir, "..", "..")
const sourceRoot = process.env.ALFWORLD_ROOT
  ? path.resolve(process.env.ALFWORLD_ROOT)
  : path.resolve("C:/Users/ZhuanZ/Desktop/experiment/datasets/ALFWorld")
const outRoot = path.join(cwd, "auto-evolve", "task-packs", "real-long-tasks", "alfworld-learnbench")
const trainLimit = Math.max(1, Number.parseInt(process.env.ALFWORLD_TRAIN_LIMIT ?? "20", 10))
const testLimit = Math.max(1, Number.parseInt(process.env.ALFWORLD_TEST_LIMIT ?? "10", 10))

function hash01(input: string) {
  const h = createHash("sha256").update(input).digest("hex").slice(0, 12)
  const n = parseInt(h, 16)
  return n / 0xffffffffffff
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}

function extractTaskText(grammar: string) {
  const match = grammar.match(/"task"\s*:\s*\[\s*\{\s*"rhs"\s*:\s*"([^"]+)"/)
  if (!match) return "Solve the ALFWorld task by producing the correct action walkthrough."
  return match[1]!.replace(/\\n/g, "\n").trim()
}

function normalizeID(filePath: string, split: string) {
  const base = path.basename(filePath).replace(/\.tw-pddl$/i, "")
  return `${split}-${slugify(base)}`
}

async function listFiles(root: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises")
  const out: string[] = []
  async function visit(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile() && entry.name.endsWith(".tw-pddl")) out.push(full)
    }
  }
  await visit(root)
  return out
}

function sortStable(files: string[]) {
  return files.sort((left, right) => {
    const lh = hash01(left)
    const rh = hash01(right)
    return lh === rh ? left.localeCompare(right) : lh - rh
  })
}

async function readTask(file: string, split: SelectedTask["split"]): Promise<SelectedTask | undefined> {
  const raw = JSON.parse(await readFile(file, "utf8")) as AlfworldRawTask
  if (!raw.solvable || !Array.isArray(raw.walkthrough) || raw.walkthrough.length === 0) return undefined
  return {
    id: normalizeID(file, split),
    sourcePath: file,
    split,
    taskText: extractTaskText(raw.grammar),
    raw,
  }
}

function buildProblem(task: SelectedTask) {
  return {
    id: task.id,
    task: task.taskText,
    split: task.split,
    solvable: task.raw.solvable,
    pddl_domain: task.raw.pddl_domain,
    pddl_problem: task.raw.pddl_problem,
  }
}

function buildSpec(task: SelectedTask) {
  return {
    id: `alfworld-${task.id}`,
    title: `alfworld-${task.id}`,
    goal: [
      "Solve one ALFWorld multi-step planning task.",
      "Read instruction.md and problem.json, infer the ordered environment actions, and write exactly one JSON file at workspace/plan.json.",
      "The JSON schema must be: {\"actions\":[\"action 1\",\"action 2\", ...]}",
      "Actions must use the TextWorld/ALFWorld natural command style, such as `go to ...`, `open ...`, `take ... from ...`, `put ... in/on ...`, `use ...`, `heat ...`, `cool ...`, `clean ...`, or `slice ...`.",
    ].join("\n"),
    taskFamily: "alfworld-learnbench",
    domainTags: ["alfworld", "embodied-planning", "multi-step-actions", "hard-validation"],
    materials: [
      { path: "./instruction.md", label: "task instruction", role: "human-guidance" },
      { path: "./problem.json", label: "sanitized ALFWorld PDDL problem", role: "source-artifact" },
    ],
    targetPaths: [
      { path: "./workspace/plan.json", label: "action plan", role: "output" },
      { path: "./expert-workspace", label: "expert workspace", role: "experience-workspace" },
    ],
    editablePaths: ["./workspace", "./expert-workspace"],
    formalPackageRoots: ["./expert-workspace"],
    validators: [
      {
        id: "alfworld-plan-validate",
        type: "script",
        title: "ALFWorld action walkthrough validation",
        path: "../../../../../scripts/validate-alfworld-plan.py",
        runner: "python",
        placement: "completion_only",
        required: true,
        blocking: true,
        args: ["--answer", `../../private-answers/${task.id}/answer.json`, "--candidate", "./workspace/plan.json"],
        timeoutMs: 60000,
      },
    ],
    planning: { agent: "top" },
    execution: { agent: "top" },
    validation: { agent: "top" },
    initialGraph: {
      planner_summary:
        "Interpret the ALFWorld goal and PDDL state, identify object/receptacle locations and required transformations, then write the ordered action plan.",
      completion_validator_ids: ["alfworld-plan-validate"],
      units: [
        {
          id: "inspect-state",
          title: "Inspect ALFWorld State",
          goal: "Read the task and PDDL problem. Identify the goal predicates, relevant object types, candidate objects/receptacles, initial agent location, and any required toggle/clean/heat/cool/slice/pick/place operations.",
          inputs: ["./instruction.md", "./problem.json"],
          depends_on: [],
          expected_artifacts: ["./workspace/notes.md"],
          claim: "The task goal and relevant state facts are understood.",
          check_plan: "Notes list target object type, target receptacle/location if any, and required action families.",
          validator_ids: [],
          retry_budget: 2,
        },
        {
          id: "write-action-plan",
          title: "Write Action Plan",
          goal: "Write workspace/plan.json with the ordered ALFWorld action commands needed to satisfy the task.",
          inputs: ["./workspace/notes.md", "./instruction.md", "./problem.json"],
          depends_on: ["inspect-state"],
          expected_artifacts: ["./workspace/plan.json"],
          claim: "The plan JSON contains a complete ordered action sequence.",
          check_plan: "Ensure the JSON has an actions list and no explanatory text outside JSON.",
          validator_ids: [],
          retry_budget: 2,
        },
      ],
    },
    budgets: {
      maxAttemptsPerUnit: 3,
      maxTotalUnitAttempts: 6,
      maxGraphReplans: 1,
      maxValidatorCalls: 8,
      maxNoProgressCycles: 2,
      maxUnitsPerGraph: 4,
    },
  }
}

function buildCampaign(taskID: string) {
  return {
    title: `alfworld-campaign-${taskID}`,
    taskFamily: "alfworld-learnbench",
    mode: "graph_iterative",
    baseSpecPath: "./spec.json",
    maxRounds: 3,
    seedTargets: [
      {
        targetPath: "./expert-workspace",
        seedPath: "../../seed-expert-workspace",
        kind: "experience_workspace",
        resetOnStart: true,
      },
    ],
  }
}

async function writeTask(task: SelectedTask) {
  const taskDir = path.join(outRoot, "tasks", task.id)
  const privateAnswerDir = path.join(outRoot, "private-answers", task.id)
  await mkdir(taskDir, { recursive: true })
  await mkdir(privateAnswerDir, { recursive: true })
  for (const runtimeName of ["workspace", "expert-workspace", "validation-expert-workspace"]) {
    await rm(path.join(taskDir, runtimeName), { recursive: true, force: true })
  }
  await mkdir(path.join(taskDir, "workspace"), { recursive: true })
  await mkdir(path.join(taskDir, "expert-workspace"), { recursive: true })
  await writeFile(
    path.join(taskDir, "instruction.md"),
    [
      `ALFWorld task ${task.id}`,
      "",
      task.taskText,
      "",
      "Write the final action sequence to workspace/plan.json.",
      "Use only the visible task and problem facts. Do not assume access to hidden walkthroughs.",
      "",
    ].join("\n"),
    "utf8",
  )
  await writeFile(path.join(taskDir, "problem.json"), JSON.stringify(buildProblem(task), null, 2), "utf8")
  await writeFile(
    path.join(privateAnswerDir, "answer.json"),
    JSON.stringify({ walkthrough: task.raw.walkthrough }, null, 2) + "\n",
    "utf8",
  )
  await writeFile(path.join(taskDir, "spec.json"), JSON.stringify(buildSpec(task), null, 2), "utf8")
  await writeFile(path.join(taskDir, "campaign.json"), JSON.stringify(buildCampaign(task.id), null, 2), "utf8")
}

async function loadSelected(split: SelectedTask["split"], limit: number) {
  const root = path.join(sourceRoot, split)
  const files = sortStable(await listFiles(root))
  const out: SelectedTask[] = []
  for (const file of files) {
    const task = await readTask(file, split)
    if (!task) continue
    out.push(task)
    if (out.length >= limit) break
  }
  return out
}

async function main() {
  const train = await loadSelected("train", trainLimit)
  const test = await loadSelected("eval_in_distribution", testLimit)
  await mkdir(path.join(outRoot, "tasks"), { recursive: true })
  await mkdir(path.join(outRoot, "private-answers"), { recursive: true })
  await mkdir(path.join(outRoot, "splits"), { recursive: true })
  await mkdir(path.join(outRoot, "seed-expert-workspace"), { recursive: true })
  await writeFile(
    path.join(outRoot, "seed-expert-workspace", "README.md"),
    [
      "# ALFWorld Seed Workspace",
      "",
      "Task: infer multi-step TextWorld/ALFWorld action plans from visible task and PDDL facts.",
      "Never store hidden walkthrough answers in this workspace. Store reusable planning heuristics only.",
    ].join("\n"),
    "utf8",
  )
  await writeFile(
    path.join(outRoot, "seed-expert-workspace", "change_log.md"),
    "# Seed change log\n\n- init\n",
    "utf8",
  )
  for (const task of [...train, ...test]) await writeTask(task)
  await writeFile(path.join(outRoot, "splits", "train-selected.json"), JSON.stringify(train.map((x) => x.id), null, 2), "utf8")
  await writeFile(path.join(outRoot, "splits", "test-selected.json"), JSON.stringify(test.map((x) => x.id), null, 2), "utf8")
  await writeFile(path.join(outRoot, "splits", "train-20.json"), JSON.stringify(train.map((x) => x.id), null, 2), "utf8")
  await writeFile(path.join(outRoot, "splits", "test-10.json"), JSON.stringify(test.map((x) => x.id), null, 2), "utf8")
  await writeFile(
    path.join(outRoot, "dataset-summary.json"),
    JSON.stringify(
      {
        sourceRoot,
        trainSelected: train.length,
        testSelected: test.length,
        note: "Sanitized problem.json excludes walkthrough; private-answers contains hidden walkthrough for product validation.",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  )
  console.log(JSON.stringify({ outRoot, trainSelected: train.length, testSelected: test.length }, null, 2))
}

await main()
