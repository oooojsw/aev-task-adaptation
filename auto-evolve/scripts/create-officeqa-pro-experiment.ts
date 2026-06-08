import path from "node:path"
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"

const cwd = path.resolve(import.meta.dir, "..", "..")
const auto = path.join(cwd, "auto-evolve")
const outRoot = path.join(auto, "task-packs", "real-long-tasks", "officeqa-pro-learnbench")
const defaultCsvPath = path.join("C:", "Users", "ZhuanZ", "Desktop", "experiment", "datasets", "OfficeQA_pro", "officeqa_pro.csv")
const csvPath = process.env.OFFICEQA_PRO_CSV
  ? path.resolve(process.env.OFFICEQA_PRO_CSV)
  : defaultCsvPath
// Optional: precise UID list (one UID per line, or extracted from a Markdown/JSON file via regex).
// When set, the script materializes exactly these UIDs (in CSV order) instead of using stable-hash slicing.
const uidsFile = process.env.OFFICEQA_PRO_UIDS_FILE
  ? path.resolve(process.env.OFFICEQA_PRO_UIDS_FILE)
  : null
// DRY_RUN: when set, the script does NOT write/overwrite any file, remove any
// directory, or copy any PDF. It only prints the planned actions and exits.
// Recommended: keep this on whenever you are about to regenerate task specs.
const dryRun = process.env.OFFICEQA_PRO_DRY_RUN === "1"
// MISSING_ONLY: when set, only UIDs whose task directory does not exist get
// materialized. Already-materialized task directories are skipped entirely
// (no spec.json rewrite, no answer.txt overwrite, no PDF re-copy). This is
// the safe way to top up a true-training-set list against an existing pack.
const missingOnly = process.env.OFFICEQA_PRO_MISSING_ONLY === "1"
// PRESERVE_EXISTING: when set, existing task directory runtime artifacts
// (workspace/, expert-workspace/, validation-expert-workspace/, materials/*.pdf)
// are snapshotted to <outRoot>/.task-snapshots/<timestamp>/<UID>/ before any
// destructive operation. Defaults to 1 (safe); opt out with =0.
const preserveExisting = process.env.OFFICEQA_PRO_PRESERVE_EXISTING !== "0"
const corpusPdfRoot = path.join(
  "C:",
  "Users",
  "ZhuanZ",
  "Desktop",
  "experiment",
  "datasets",
  "OfficeQA_corpus_public",
  "treasury_bulletin_pdfs",
)
const rewardPath = path.join("C:", "Users", "ZhuanZ", "Desktop", "experiment", "datasets", "OfficeQA_code", "reward.py")
const trainLimit = Math.max(1, Number.parseInt(process.env.OFFICEQA_PRO_TRAIN_LIMIT ?? "20", 10))
const testLimit = Math.max(1, Number.parseInt(process.env.OFFICEQA_PRO_TEST_LIMIT ?? "10", 10))
const taskLimit = Math.max(1, Number.parseInt(process.env.OFFICEQA_PRO_TASK_LIMIT ?? String(trainLimit + testLimit), 10))
const campaignMaxRounds = Math.max(1, Number.parseInt(process.env.OFFICEQA_PRO_CAMPAIGN_ROUNDS ?? "4", 10))
const surfaceBlocking = process.env.OFFICEQA_PRO_SURFACE_BLOCKING === "1"

const surfaceGeneralizationConfig = {
  rootRoles: ["experience-workspace"],
  rootPaths: [],
  allowedExtensions: [".md", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".py", ".ps1", ".sh", ".js", ".mjs", ".cjs", ".ts"],
  ignorePathSubstrings: ["node_modules", ".git", "__pycache__", "/workspace/", "\\workspace\\"],
  requiredFiles: ["README.md"],
  forbiddenPatterns: [
    {
      label: "explicit-ground-truth-container",
      pattern: "\\b(ground[-_ ]?truth|official answer|hidden answer|gold answer|gold label)\\b",
      flags: ["IGNORECASE"],
    },
    {
      label: "private-answer-path",
      pattern: "\\bprivate-answers\\b|--answer-path",
      flags: ["IGNORECASE"],
    },
    {
      label: "camelcase-answer-container",
      pattern: "\\b(expectedAnswer|groundTruth|officialAnswer|hiddenAnswer|goldAnswer)\\b",
      flags: ["IGNORECASE"],
    },
    {
      label: "locked-answer-container",
      pattern: "\\b(validated answer|locked answer value)\\b",
      flags: ["IGNORECASE"],
    },
    {
      label: "no-rederive-answer",
      pattern: "\\b(do not re-derive|do not rederive|do not recompute|use the answer|copy the answer)\\b",
      flags: ["IGNORECASE"],
    },
    {
      label: "answer-file-contains-literal",
      pattern: "answer\\.txt\\s+(?:contains|must contain|is)\\s+[`\\\"']?[-+]?\\d[\\d,]*(?:\\.\\d+)?%?[`\\\"']?",
      flags: ["IGNORECASE"],
    },
    {
      label: "final-answer-literal",
      pattern: "\\b(?:final|correct|validated|locked|expected)\\s+answer\\s*(?:is|=|:)\\s*[`\\\"']?[-+]?\\d[\\d,]*(?:\\.\\d+)?%?[`\\\"']?",
      flags: ["IGNORECASE"],
    },
  ],
  structuredDangerKeys: [
    "expectedAnswer",
    "groundTruth",
    "ground_truth",
    "officialAnswer",
    "official_answer",
    "hiddenAnswer",
    "hidden_answer",
    "gold",
    "goldAnswer",
    "gold_answer",
    "solution",
  ],
  structuredConditionalKeys: ["answer", "finalAnswer", "final_answer", "target", "label"],
  answerContextTerms: [
    "answer",
    "expected",
    "validated",
    "locked",
    "correct",
    "official",
    "ground truth",
    "ground-truth",
    "gold",
    "solution",
    "final",
    "do not re-derive",
    "do not rederive",
    "copy",
  ],
  benignNumericContextTerms: [
    "page",
    "table",
    "row",
    "column",
    "year",
    "month",
    "months",
    "round",
    "decimal",
    "tolerance",
    "pdf",
    "ocr",
    "sheet",
    "section",
    "chapter",
    "line",
    "format",
    "example",
  ],
  numericContextWindow: 100,
  maxHitsPerFile: 6,
  maxTotalHits: 30,
}

type Row = {
  uid: string
  question: string
  answer: string
  source_docs: string
  source_files: string
  difficulty: string
}

function hash01(input: string) {
  const h = createHash("sha256").update(input).digest("hex").slice(0, 12)
  const n = parseInt(h, 16)
  return n / 0xffffffffffff
}

function sortedByStableHash(rows: Row[]) {
  return rows
    .map((row) => ({ row, h: hash01(row.uid), id: row.uid }))
    .sort((a, b) => (a.h === b.h ? a.id.localeCompare(b.id) : a.h - b.h))
    .map((x) => x.row)
}

function parseCsv(raw: string): Row[] {
  const rows: string[][] = []
  let cur = ""
  let row: string[] = []
  let quoted = false
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    const next = raw[i + 1]
    if (ch === '"' && quoted && next === '"') {
      cur += '"'
      i += 1
      continue
    }
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (ch === "," && !quoted) {
      row.push(cur)
      cur = ""
      continue
    }
    if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && next === "\n") i += 1
      row.push(cur)
      if (row.some((cell) => cell.length > 0)) rows.push(row)
      row = []
      cur = ""
      continue
    }
    cur += ch
  }
  row.push(cur)
  if (row.some((cell) => cell.length > 0)) rows.push(row)

  const header = rows.shift()
  if (!header) return []
  return rows.map((cells) => Object.fromEntries(header.map((key, idx) => [key, cells[idx] ?? ""])) as Row)
}

function splitLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
}

// Extract unique UID tokens (UID followed by 4 digits) from arbitrary text.
// Handles Markdown files (extracts from tables, bullet lists, headings),
// JSON arrays, and plain newline-separated UID lists.
function extractUids(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const re = /\bUID\d{4}\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (!seen.has(m[0])) {
      seen.add(m[0])
      out.push(m[0])
    }
  }
  return out
}

function pdfNameFromSourceFile(sourceFile: string) {
  return sourceFile.replace(/\.txt$/i, ".pdf")
}

async function writeTask(row: Row) {
  const id = row.uid
  const taskDir = path.join(outRoot, "tasks", id)
  if (dryRun) {
    // Defensive: writeTask must not run during dry-run. main() short-circuits
    // before this, but keep an extra guard so a future refactor can't bypass it.
    return id
  }
  const materialsDir = path.join(taskDir, "materials")
  const privateAnswerDir = path.join(outRoot, "private-answers", id)
  // PRESERVE_EXISTING: snapshot existing runtime artifacts to .task-snapshots/<ts>/<UID>/
  // BEFORE the destructive rm below, so e.g. a real R4 workspace/answer.txt can be recovered.
  if (preserveExisting) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const snapshotDir = path.join(outRoot, ".task-snapshots", stamp, id)
    const runtimeDirs = ["workspace", "expert-workspace", "validation-expert-workspace", "materials"]
    for (const runtimeName of runtimeDirs) {
      const src = path.join(taskDir, runtimeName)
      const dst = path.join(snapshotDir, runtimeName)
      try {
        const { existsSync, statSync } = await import("node:fs")
        if (!existsSync(src)) continue
        const stat = statSync(src)
        await mkdir(path.dirname(dst), { recursive: true })
        if (stat.isDirectory()) {
          const { cp } = await import("node:fs/promises")
          await cp(src, dst, { recursive: true, force: true })
        } else {
          await copyFile(src, dst)
        }
      } catch {
        // best-effort snapshot
      }
    }
  }
  for (const runtimeName of ["workspace", "expert-workspace", "validation-expert-workspace"]) {
    await rm(path.join(taskDir, runtimeName), { recursive: true, force: true })
  }
  await mkdir(path.join(taskDir, "workspace"), { recursive: true })
  await mkdir(path.join(taskDir, "expert-workspace"), { recursive: true })
  await mkdir(materialsDir, { recursive: true })
  await mkdir(privateAnswerDir, { recursive: true })
  await writeFile(path.join(privateAnswerDir, "answer.txt"), row.answer.trim() + "\n", "utf8")

  const sourceFiles = splitLines(row.source_files)
  const copiedPdfs: string[] = []
  for (const sourceFile of sourceFiles) {
    const pdfName = pdfNameFromSourceFile(sourceFile)
    const src = path.join(corpusPdfRoot, pdfName)
    const dst = path.join(materialsDir, pdfName)
    await copyFile(src, dst)
    copiedPdfs.push(`./materials/${pdfName}`)
  }

  const instruction = [
    `OfficeQA Pro task ${id}`,
    "",
    "Answer the question using only the provided Treasury Bulletin PDF material(s).",
    "Write the final answer to workspace/answer.txt.",
    "The answer file must contain only the final answer value, with no explanation.",
    "For example, write `2,602` rather than a sentence.",
    "",
    `Question: ${row.question}`,
    "",
    `Difficulty: ${row.difficulty}`,
    "",
    "Source document URLs:",
    ...splitLines(row.source_docs).map((item) => `- ${item}`),
    "",
    "Local source PDFs:",
    ...copiedPdfs.map((item) => `- ${item}`),
    "",
  ].join("\n")
  await writeFile(path.join(taskDir, "instruction.md"), instruction, "utf8")

  const materials = [
    { path: "./instruction.md", label: "task instruction", role: "human-guidance" },
    ...copiedPdfs.map((pdf) => ({ path: pdf, label: path.basename(pdf), role: "source-artifact" })),
  ]

  const spec = {
    id: `officeqa-pro-${id}`,
    title: `officeqa-pro-${id}`,
    goal:
      "Solve one OfficeQA Pro grounded reasoning question. Read the Treasury Bulletin PDF material(s), perform the needed multi-step reasoning/calculation, and write only the final answer to workspace/answer.txt.",
    taskFamily: "officeqa-pro-learnbench",
    domainTags: ["officeqa", "pdf", "grounded-reasoning", "hard-validation"],
    materials,
    targetPaths: [
      { path: "./workspace/answer.txt", label: "final answer", role: "output" },
      { path: "./expert-workspace", label: "expert workspace", role: "experience-workspace" },
    ],
    editablePaths: ["./workspace", "./expert-workspace"],
    formalPackageRoots: ["./expert-workspace"],
    validators: [
      {
        id: "officeqa-answer-validate",
        type: "script",
        title: "OfficeQA answer validation",
        path: "../../../../../scripts/validate-officeqa-answer.py",
        runner: "python",
        placement: "completion_only",
        required: true,
        blocking: true,
        args: [
          "--answer-path",
          `../../private-answers/${id}/answer.txt`,
          "--candidate",
          "./workspace/answer.txt",
          "--reward",
          rewardPath,
          "--tolerance",
          "0.01",
        ],
        timeoutMs: 120000,
      },
    ],
    planning: { agent: "top" },
    execution: { agent: "top" },
    validation: { agent: "top" },
    initialGraph: {
      planner_summary: "Read the provided Treasury Bulletin PDF(s), locate the relevant table/page, compute the requested value, and output the direct answer.",
      completion_validator_ids: ["officeqa-answer-validate"],
      units: [
        {
          id: "inspect-source-docs",
          title: "Inspect Source Documents",
          goal: "Open/read the provided PDF material(s), identify the exact table/page/values needed for the question, and write concise notes.",
          inputs: ["./instruction.md", ...copiedPdfs],
          depends_on: [],
          expected_artifacts: ["./workspace/notes.md"],
          claim: "The source location and required values are identified.",
          check_plan: "Notes cite the relevant PDF(s), page/table context, and extracted values.",
          validator_ids: [],
          retry_budget: 2,
        },
        {
          id: "compute-answer",
          title: "Compute Direct Answer",
          goal: "Perform the required reasoning or calculation and write only the final answer to workspace/answer.txt.",
          inputs: ["./workspace/notes.md", "./instruction.md", ...copiedPdfs],
          depends_on: ["inspect-source-docs"],
          expected_artifacts: ["./workspace/answer.txt"],
          claim: "The direct answer is written with no explanation text.",
          check_plan: "Answer file contains only the final answer value.",
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
  await writeFile(path.join(taskDir, "spec.json"), JSON.stringify(spec, null, 2), "utf8")

  const campaign = {
    title: `officeqa-pro-campaign-${id}`,
    taskFamily: "officeqa-pro-learnbench",
    mode: "graph_iterative",
    baseSpecPath: "./spec.json",
    maxRounds: campaignMaxRounds,
    seedTargets: [
      {
        targetPath: "./expert-workspace",
        seedPath: "../../seed-expert-workspace",
        kind: "experience_workspace",
        resetOnStart: true,
      },
    ],
      surfaceGeneralization: {
        enabled: true,
        validatorPath: "../../../../../scripts/validate-officeqa-experience-surface.py",
        configPath: "../../configs/surface-generalization.json",
        // Hard gate for single-round smoke/test/final-acceptance runs:
        // fail fast on unsafe skill surfaces. Multi-round training campaigns
        // keep this non-blocking so the failure becomes next-round feedback.
        blocking: surfaceBlocking,
        timeoutMs: 60000,
      },
  }
  await writeFile(path.join(taskDir, "campaign.json"), JSON.stringify(campaign, null, 2), "utf8")
  return id
}

async function main() {
  const allRows = parseCsv(await readFile(csvPath, "utf8"))
  let rows: Row[]
  let explicitUids: string[] | null = null
  if (uidsFile) {
    const uidsText = await readFile(uidsFile, "utf8")
    explicitUids = extractUids(uidsText)
    if (explicitUids.length === 0) {
      throw new Error(`OFFICEQA_PRO_UIDS_FILE=${uidsFile} but no UID tokens found in it.`)
    }
    const byUid = new Map(allRows.map((r) => [r.uid, r]))
    rows = []
    const missing: string[] = []
    for (const uid of explicitUids) {
      const row = byUid.get(uid)
      if (row) rows.push(row)
      else missing.push(uid)
    }
    if (missing.length > 0) {
      throw new Error(
        `OFFICEQA_PRO_UIDS_FILE specified ${explicitUids.length} UIDs but ${missing.length} are missing from CSV ${csvPath}: ${missing.join(", ")}`,
      )
    }
  } else {
    rows = sortedByStableHash(allRows).slice(0, taskLimit)
  }
  const trainSelected = rows.slice(0, Math.min(trainLimit, rows.length))
  const testSelected = rows.slice(trainSelected.length, Math.min(trainSelected.length + testLimit, rows.length))

  if (dryRun) {
    // Dry-run: print the plan, do NOT touch the filesystem.
    // Probe existing task dirs so the user sees the actual skip count.
    const { existsSync } = await import("node:fs")
    const existing = rows.filter((r) => existsSync(path.join(outRoot, "tasks", r.uid))).map((r) => r.uid)
    const wouldCreate = missingOnly ? rows.length - existing.length : rows.length
    console.log(
      JSON.stringify(
        {
          mode: "DRY_RUN",
          dryRun,
          preserveExisting,
          csvPath,
          uidsFile: uidsFile ?? null,
          explicitUids: explicitUids?.length ?? null,
          trainSelected,
          testSelected,
          wouldCreateTaskDirs: wouldCreate,
          wouldSkipExisting: missingOnly ? existing.length : 0,
          existingSkippedUIDs: missingOnly ? existing : [],
          wouldWriteSplit: explicitUids
            ? `train-${explicitUids.length}-skillopt.json`
            : taskLimit === 5
              ? "first-five.json"
              : `first-${taskLimit}.json`,
          wouldWriteSeedWorkspace: true,
          wouldWriteConfigs: true,
          wouldOverwriteExistingAnswerTxt: !preserveExisting,
          note: "No files were written. Re-run with OFFICEQA_PRO_DRY_RUN unset (or =0) to actually materialize tasks.",
        },
        null,
        2,
      ),
    )
    return
  }

  await mkdir(path.join(outRoot, "seed-expert-workspace"), { recursive: true })
  await writeFile(
    path.join(outRoot, "seed-expert-workspace", "README.md"),
    "OfficeQA Pro seed workspace. Keep reusable document-reading and calculation lessons here.\n",
    "utf8",
  )
  await mkdir(path.join(outRoot, "splits"), { recursive: true })
  await mkdir(path.join(outRoot, "configs"), { recursive: true })
  await writeFile(
    path.join(outRoot, "configs", "surface-generalization.json"),
    JSON.stringify(surfaceGeneralizationConfig, null, 2),
    "utf8",
  )
  const ids: string[] = []
  const skippedExisting: string[] = []
  for (const row of rows) {
    const existingTaskDir = path.join(outRoot, "tasks", row.uid)
    let exists = false
    try {
      const { existsSync } = await import("node:fs")
      exists = existsSync(existingTaskDir)
    } catch {
      exists = false
    }
    if (missingOnly && exists) {
      skippedExisting.push(row.uid)
      ids.push(row.uid)
      continue
    }
    ids.push(await writeTask(row))
  }
  const trainIDs = trainSelected.map((row) => row.uid)
  const testIDs = testSelected.map((row) => row.uid)
  const splitName = explicitUids
    ? `train-${explicitUids.length}-skillopt.json`
    : taskLimit === 5
      ? "first-five.json"
      : `first-${taskLimit}.json`
  await writeFile(path.join(outRoot, "splits", splitName), JSON.stringify(ids, null, 2), "utf8")
  await writeFile(path.join(outRoot, "splits", "train-selected.json"), JSON.stringify(trainIDs, null, 2), "utf8")
  await writeFile(path.join(outRoot, "splits", "test-selected.json"), JSON.stringify(testIDs, null, 2), "utf8")
  await writeFile(path.join(outRoot, "splits", "train-20.json"), JSON.stringify(trainIDs.slice(0, 20), null, 2), "utf8")
  await writeFile(path.join(outRoot, "splits", "test-10.json"), JSON.stringify(testIDs.slice(0, 10), null, 2), "utf8")
  if (taskLimit === 5) {
    await writeFile(path.join(outRoot, "splits", "first-5.json"), JSON.stringify(ids, null, 2), "utf8")
  }
  await writeFile(
    path.join(outRoot, "dataset-summary.json"),
    JSON.stringify(
      {
        dataset: "OfficeQA Pro",
        sourceCsv: csvPath,
        uidsFile: uidsFile ?? null,
        splitFile: splitName,
        trainSelected: trainIDs,
        testSelected: testIDs,
        campaignMaxRounds,
        surfaceBlocking,
        selected: ids,
        generatedAt: new Date().toISOString(),
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
        csvPath,
        uidsFile,
        explicitUids: explicitUids?.length ?? null,
        preserveExisting,
        trainSelected: trainIDs,
        testSelected: testIDs,
        ids,
      },
      null,
      2,
    ),
  )
}

await main()
