import path from "node:path"
import { mkdir, readFile, writeFile, cp, rm } from "node:fs/promises"
import { createHash } from "node:crypto"

type DatasetRow = {
  id: string | number
  instruction: string
  spreadsheet_path: string
  instruction_type?: string
  answer_position: string
  answer_sheet?: string | null
  data_position?: string
}

const cwd = path.resolve(import.meta.dir, "..", "..")
const sourceRoot = process.env.SPREADSHEETBENCH_ROOT
  ? path.resolve(process.env.SPREADSHEETBENCH_ROOT)
  : path.resolve("C:/Users/ZhuanZ/Desktop/experiment/SpreadsheetBench/all_data_912_v0.1")
const outRoot = path.join(cwd, "auto-evolve", "task-packs", "real-long-tasks", "spreadsheetbench-learnbench")
const trainLimitEnv = process.env.SPREADSHEETBENCH_TRAIN_LIMIT
const testLimitEnv = process.env.SPREADSHEETBENCH_TEST_LIMIT
const trainLimit = Number.parseInt(trainLimitEnv ?? "40", 10)
const testLimit = Number.parseInt(testLimitEnv ?? "10", 10)
const splitRatio = Number.parseFloat(process.env.SPREADSHEETBENCH_SPLIT_RATIO ?? "0.8")
const splitMode = (process.env.SPREADSHEETBENCH_SPLIT_MODE ?? "stable-hash").trim().toLowerCase()
const skillOptSplitRoot = process.env.SPREADSHEETBENCH_SKILLOPT_SPLIT_ROOT
  ? path.resolve(process.env.SPREADSHEETBENCH_SKILLOPT_SPLIT_ROOT)
  : path.resolve("C:/Users/ZhuanZ/Desktop/SkillOpt/data/spreadsheetbench_id_split")

function hash01(input: string) {
  const h = createHash("sha256").update(input).digest("hex").slice(0, 12)
  const n = parseInt(h, 16)
  return n / 0xffffffffffff
}

function normID(v: string | number) {
  return String(v).trim()
}

function sortedByStableHash(rows: DatasetRow[]) {
  return rows
    .map((row) => ({ row, h: hash01(normID(row.id)), id: normID(row.id) }))
    .sort((a, b) => (a.h === b.h ? a.id.localeCompare(b.id) : a.h - b.h))
    .map((x) => ({ ...x.row, id: x.id }))
}

type SkillOptSplitItem = {
  id: string
  spreadsheet_path?: string
  instruction_type?: string
}

async function readSkillOptSplitIDs(split: "train" | "val" | "test") {
  const splitPath = path.join(skillOptSplitRoot, split, "items.json")
  const items = JSON.parse(await readFile(splitPath, "utf8")) as SkillOptSplitItem[]
  return items.map((item) => normID(item.id))
}

function rowsByIDs(rowsByID: Map<string, DatasetRow & { id: string }>, ids: string[], splitName: string) {
  const missing = ids.filter((id) => !rowsByID.has(id))
  if (missing.length > 0) {
    throw new Error(
      `SpreadsheetBench SkillOpt ${splitName} split has ${missing.length} IDs missing from sourceRoot dataset.json: ${missing
        .slice(0, 20)
        .join(", ")}`,
    )
  }
  return ids.map((id) => rowsByID.get(id)!)
}

function buildSpec(row: DatasetRow & { id: string }) {
  const validatorArgs = [
    "--answer",
    `../../private-answers/${row.id}/answer.xlsx`,
    "--candidate",
    "./workspace/answer.json",
    ...(typeof row.answer_sheet === "string" && row.answer_sheet.trim()
      ? ["--sheet", row.answer_sheet.trim()]
      : []),
    "--range",
    row.answer_position,
  ]
  return {
    id: `spreadsheetbench-${row.id}`,
    title: `spreadsheetbench-${row.id}`,
    goal: [
      "Solve one spreadsheet task from SpreadsheetBench.",
      "Read the input workbook and produce exactly one JSON file at workspace/answer.json.",
      "The JSON schema must be:",
      '{"answer_sheet":"<sheet>","answer_position":"<range>","values":[["..."]]}',
      "The values matrix must match the expected answer cells exactly.",
    ].join("\n"),
    taskFamily: "spreadsheetbench-learnbench",
    domainTags: ["spreadsheet", "hard-validation", "answer-range"],
    materials: [
      { path: "./instruction.md", label: "task instruction", role: "human-guidance" },
      { path: "./input.xlsx", label: "input workbook", role: "source-artifact" },
    ],
    targetPaths: [
      { path: "./workspace/answer.json", label: "answer matrix", role: "output" },
      { path: "./expert-workspace", label: "expert workspace", role: "experience-workspace" },
    ],
    editablePaths: ["./workspace", "./expert-workspace"],
    formalPackageRoots: ["./expert-workspace"],
    validators: [
      {
        id: "spreadsheet-hard-validate",
        type: "script",
        title: "Spreadsheet answer matrix validation",
        path: "../../../../../scripts/validate-spreadsheetbench-answer.py",
        runner: "python",
        placement: "completion_only",
        required: true,
        blocking: true,
        args: validatorArgs,
        timeoutMs: 120000,
      },
    ],
    planning: { agent: "top" },
    execution: { agent: "top" },
    validation: { agent: "top" },
    initialGraph: {
      planner_summary: "Read workbook, infer required result cells, and output exact matrix JSON.",
      completion_validator_ids: ["spreadsheet-hard-validate"],
      units: [
        {
          id: "inspect-input",
          title: "Inspect Input Workbook",
          goal: "Inspect input.xlsx and identify how to compute the target answer range from instruction.",
          inputs: ["./instruction.md", "./input.xlsx"],
          depends_on: [],
          expected_artifacts: ["./workspace/notes.md"],
          claim: "Computation logic and target range interpretation are clear.",
          check_plan: "Notes include target sheet, range dimensions, and computation method.",
          validator_ids: [],
          retry_budget: 2,
        },
        {
          id: "write-answer-json",
          title: "Write Answer JSON",
          goal: "Write workspace/answer.json with answer_sheet, answer_position, and values matrix.",
          inputs: ["./workspace/notes.md", "./instruction.md", "./input.xlsx"],
          depends_on: ["inspect-input"],
          expected_artifacts: ["./workspace/answer.json"],
          claim: "Answer JSON exists and matrix dimensions match the target range.",
          check_plan: "Run a quick self-check on matrix rows/cols before finalizing.",
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
    title: `spreadsheetbench-campaign-${taskID}`,
    taskFamily: "spreadsheetbench-learnbench",
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

async function ensureTask(row: DatasetRow & { id: string }) {
  const taskDir = path.join(outRoot, "tasks", row.id)
  const privateAnswerDir = path.join(outRoot, "private-answers", row.id)
  await mkdir(taskDir, { recursive: true })
  await mkdir(privateAnswerDir, { recursive: true })
  for (const runtimeName of ["workspace", "expert-workspace", "validation-expert-workspace"]) {
    await rm(path.join(taskDir, runtimeName), { recursive: true, force: true })
  }
  const sourceDir = path.join(sourceRoot, row.spreadsheet_path)
  const inputName = `1_${row.id}_input.xlsx`
  const answerName = `1_${row.id}_answer.xlsx`
  await cp(path.join(sourceDir, inputName), path.join(taskDir, "input.xlsx"), { force: true })
  await cp(path.join(sourceDir, answerName), path.join(privateAnswerDir, "answer.xlsx"), { force: true })
  await rm(path.join(taskDir, "answer.xlsx"), { force: true })
  await writeFile(path.join(taskDir, "instruction.md"), row.instruction.trim() + "\n", "utf8")
  await writeFile(path.join(taskDir, "human-guidance.md"), row.instruction.trim() + "\n", "utf8")
  await writeFile(path.join(taskDir, "spec.json"), JSON.stringify(buildSpec(row), null, 2), "utf8")
  await writeFile(path.join(taskDir, "campaign.json"), JSON.stringify(buildCampaign(row.id), null, 2), "utf8")
  return taskDir
}

async function main() {
  const datasetPath = path.join(sourceRoot, "dataset.json")
  const raw = JSON.parse(await readFile(datasetPath, "utf8")) as DatasetRow[]
  const rows = sortedByStableHash(raw)
  let trainAll: (DatasetRow & { id: string })[]
  let valAll: (DatasetRow & { id: string })[] = []
  let testAll: (DatasetRow & { id: string })[]
  let trainSelected: (DatasetRow & { id: string })[]
  let valSelected: (DatasetRow & { id: string })[] = []
  let testSelected: (DatasetRow & { id: string })[]

  if (splitMode === "skillopt") {
    const rowsByID = new Map(rows.map((row) => [normID(row.id), { ...row, id: normID(row.id) }]))
    const trainIDs = await readSkillOptSplitIDs("train")
    const valIDs = await readSkillOptSplitIDs("val")
    const testIDs = await readSkillOptSplitIDs("test")
    trainAll = rowsByIDs(rowsByID, trainIDs, "train")
    valAll = rowsByIDs(rowsByID, valIDs, "val")
    testAll = rowsByIDs(rowsByID, testIDs, "test")
    const trainLimitValue = trainLimitEnv ? trainLimit : trainAll.length
    const testLimitValue = testLimitEnv ? testLimit : testAll.length
    trainSelected = trainAll.slice(0, Math.max(1, Math.min(trainLimitValue, trainAll.length)))
    valSelected = valAll
    testSelected = testAll.slice(0, Math.max(1, Math.min(testLimitValue, testAll.length)))
  } else {
    const cut = Math.floor(rows.length * splitRatio)
    trainAll = rows.slice(0, cut)
    testAll = rows.slice(cut)
    trainSelected = trainAll.slice(0, Math.max(1, Math.min(trainLimit, trainAll.length)))
    testSelected = testAll.slice(0, Math.max(1, Math.min(testLimit, testAll.length)))
  }

  await mkdir(path.join(outRoot, "splits"), { recursive: true })
  await mkdir(path.join(outRoot, "tasks"), { recursive: true })
  await mkdir(path.join(outRoot, "seed-expert-workspace"), { recursive: true })
  await writeFile(
    path.join(outRoot, "seed-expert-workspace", "manifest.md"),
    [
      "# SpreadsheetBench Seed Workspace",
      "",
      "Task: produce exact answer matrix JSON for the required answer sheet/range.",
      "Always include one clear method note before final answer output.",
    ].join("\n"),
    "utf8",
  )
  await writeFile(
    path.join(outRoot, "seed-expert-workspace", "change_log.md"),
    "# Seed change log\n\n- init\n",
    "utf8",
  )

  const rowsToMaterialize = new Map<string, DatasetRow & { id: string }>()
  for (const row of splitMode === "skillopt" ? [...trainAll, ...valAll, ...testAll] : [...trainSelected, ...testSelected]) {
    rowsToMaterialize.set(row.id, row)
  }
  for (const row of rowsToMaterialize.values()) {
    await ensureTask(row)
  }

  await writeFile(path.join(outRoot, "splits", "train-all.json"), JSON.stringify(trainAll.map((x) => x.id), null, 2), "utf8")
  if (splitMode === "skillopt") {
    await writeFile(
      path.join(outRoot, "splits", "train-skillopt-official.json"),
      JSON.stringify(trainAll.map((x) => x.id), null, 2),
      "utf8",
    )
    await writeFile(
      path.join(outRoot, "splits", "val-skillopt-official.json"),
      JSON.stringify(valAll.map((x) => x.id), null, 2),
      "utf8",
    )
    await writeFile(
      path.join(outRoot, "splits", "test-skillopt-official.json"),
      JSON.stringify(testAll.map((x) => x.id), null, 2),
      "utf8",
    )
  }
  await writeFile(path.join(outRoot, "splits", "test-all.json"), JSON.stringify(testAll.map((x) => x.id), null, 2), "utf8")
  await writeFile(path.join(outRoot, "splits", "train-selected.json"), JSON.stringify(trainSelected.map((x) => x.id), null, 2), "utf8")
  if (splitMode === "skillopt") {
    await writeFile(
      path.join(outRoot, "splits", "val-selected.json"),
      JSON.stringify(valSelected.map((x) => x.id), null, 2),
      "utf8",
    )
  }
  await writeFile(path.join(outRoot, "splits", "test-selected.json"), JSON.stringify(testSelected.map((x) => x.id), null, 2), "utf8")
  await writeFile(
    path.join(outRoot, "dataset-summary.json"),
    JSON.stringify(
      {
        sourceRoot,
        splitMode,
        skillOptSplitRoot: splitMode === "skillopt" ? skillOptSplitRoot : undefined,
        datasetSize: rows.length,
        splitRatio,
        trainAll: trainAll.length,
        valAll: valAll.length,
        testAll: testAll.length,
        trainSelected: trainSelected.length,
        valSelected: valSelected.length,
        testSelected: testSelected.length,
        materializedTasks: rowsToMaterialize.size,
      },
      null,
      2,
    ),
    "utf8",
  )
  console.log(
    JSON.stringify(
      {
        outRoot,
        splitMode,
        datasetSize: rows.length,
        trainAll: trainAll.length,
        valAll: valAll.length,
        testAll: testAll.length,
        trainSelected: trainSelected.length,
        valSelected: valSelected.length,
        testSelected: testSelected.length,
        materializedTasks: rowsToMaterialize.size,
      },
      null,
      2,
    ),
  )
}

await main()
