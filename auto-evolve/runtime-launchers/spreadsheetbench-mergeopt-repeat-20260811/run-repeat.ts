import path from "node:path"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { loadConfig } from "../../orchestrator/schema"
import { runSkillOptMerger } from "../../orchestrator/multi-instance/skillopt-merger"

const repeatArg = process.argv.find((arg) => arg.startsWith("--repeat="))?.split("=", 2)[1] ?? ""
const repeat = Number.parseInt(repeatArg, 10)
if (![1, 2, 3].includes(repeat)) throw new Error("--repeat must be 1, 2, or 3")

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..")
const autoRoot = path.join(repoRoot, "auto-evolve")
const sourceRun = path.join(
  autoRoot,
  "runtime-state",
  "benchmark-runs",
  "20260622-171219-spreadsheetbench-official80-minimax27-hier5",
)
const repeatLabel = String(repeat).padStart(2, "0")
const outRoot = path.join(
  autoRoot,
  "runtime-state",
  "benchmark-runs",
  `20260811-spreadsheetbench69-merge-as-opt-minimax27-repeat-${repeatLabel}`,
)
const mergerRoot = path.join(outRoot, "merge-and-validate", "phase2-skillopt")
const nativeTrainRoot = path.join(mergerRoot, "native-train")
const runtimeConfig = path.join(
  autoRoot,
  "进度报告",
  "2026-08-04-OfficeQA论文统计",
  "spreadsheetbench-merge-as-opt-config.yaml",
)
const skillOptRoot = "C:/Users/ZhuanZ/Desktop/SkillOpt"

function normalizeStoredWindowsPath(value: string) {
  let normalized = value
  while (normalized.includes("\\\\")) normalized = normalized.replaceAll("\\\\", "\\")
  return path.resolve(normalized)
}

const existingSummary = await stat(path.join(nativeTrainRoot, "summary.json")).catch(() => undefined)
const existingSkill = await stat(path.join(nativeTrainRoot, "best_skill.md")).catch(() => undefined)
if (existingSummary?.isFile() && existingSkill?.isFile()) {
  const summary = JSON.parse(await readFile(path.join(nativeTrainRoot, "summary.json"), "utf8")) as {
    total_steps?: number
  }
  if (summary.total_steps === 8) {
    console.log(JSON.stringify({ passed: true, skipped: true, repeat, outRoot, reason: "repeat already complete" }))
    process.exit(0)
  }
}

const state = JSON.parse(
  await readFile(path.join(sourceRun, "orchestrator-state.json"), "utf8").then((text) => text.replace(/^\uFEFF/, "")),
) as { trainResults?: Array<{ id?: string; status?: string; campaignDir?: string }> }

const verifiedRows = (state.trainResults ?? [])
  .filter((row) => row.status === "verified_success" && row.id && row.campaignDir)
  .sort((left, right) => String(left.id).localeCompare(String(right.id)))
const sourceSkills = verifiedRows.map((row) => {
  const campaignDir = normalizeStoredWindowsPath(String(row.campaignDir))
  return { id: String(row.id), skillRoot: path.join(campaignDir, "pending-expert-package", "current") }
})
if (sourceSkills.length !== 69) throw new Error(`Expected exactly 69 verified source skills, got ${sourceSkills.length}`)
await Promise.all(sourceSkills.map(async ({ id, skillRoot }) => {
  const sourceStat = await stat(skillRoot).catch(() => undefined)
  if (!sourceStat?.isDirectory()) throw new Error(`Verified source skill is missing: ${id} -> ${skillRoot}`)
}))

const requiredPaths = [
  runtimeConfig,
  path.join(skillOptRoot, "data", "spreadsheetbench_split", "train"),
  path.join(skillOptRoot, "data", "spreadsheetbench_split", "val"),
  path.join(skillOptRoot, "data", "spreadsheetbench_split", "test"),
  "E:/project/experiment/SpreadsheetBench/all_data_912_v0.1",
]
for (const requiredPath of requiredPaths) {
  if (!(await stat(requiredPath).then(() => true).catch(() => false))) {
    throw new Error(`Required path is missing: ${requiredPath}`)
  }
}

const splitRoot = path.join(skillOptRoot, "data", "spreadsheetbench_split")
const splitItems = {} as Record<string, Array<{ id?: string | number; spreadsheet_path?: string }>>
for (const split of ["train", "val", "test"]) {
  splitItems[split] = JSON.parse(await readFile(path.join(splitRoot, split, "items.json"), "utf8"))
}
const expectedCounts = { train: 80, val: 40, test: 280 }
for (const [split, expected] of Object.entries(expectedCounts)) {
  const rows = splitItems[split]
  const ids = rows.map((row) => String(row.id ?? "").trim())
  if (rows.length !== expected || new Set(ids).size !== expected || ids.some((id) => !id)) {
    throw new Error(`SpreadsheetBench ${split} split must contain ${expected} unique non-empty IDs`)
  }
}
const allSplitIDs = Object.values(splitItems).flat().map((row) => String(row.id))
if (new Set(allSplitIDs).size !== 400) throw new Error("SpreadsheetBench train/val/test splits overlap")
const dataRoot = "E:/project/experiment/SpreadsheetBench/all_data_912_v0.1"
await Promise.all(Object.values(splitItems).flat().map(async (row) => {
  const relative = String(row.spreadsheet_path ?? "").replaceAll("/", path.sep)
  const itemRoot = path.resolve(dataRoot, relative)
  const itemStat = await stat(itemRoot).catch(() => undefined)
  if (!itemStat?.isDirectory()) throw new Error(`SpreadsheetBench material is missing: ${row.id} -> ${itemRoot}`)
}))

await mkdir(outRoot, { recursive: true })
await writeFile(
  path.join(outRoot, "launch-audit.json"),
  JSON.stringify({
    schema: "auto-evolve/spreadsheetbench-merge-as-opt-repeat-launch/v1",
    createdAt: new Date().toISOString(),
    repeat,
    repeatsTotal: 3,
    sourceBenchmarkRun: sourceRun,
    sourceSkillCount: sourceSkills.length,
    sourceSkillIDs: sourceSkills.map((item) => item.id),
    split: { train: 80, validation: 40, testHeldOut: 280 },
    splitUniqueAndDisjoint: true,
    materialDirectoriesVerified: 400,
    sourcePolicy: "69 verified_success AEV Skills only; held-out test is not used during training",
    model: "MiniMax-M2.7",
    epochs: 4,
    batchSize: 40,
    targetWorkers: 2,
    outputRoot: outRoot,
    mergeRoot: mergerRoot,
    generationPolicy: "Unmodified production runSkillOptMerger native_train flow and original config",
  }, null, 2),
  "utf8",
)

const authPath = path.join(autoRoot, ".opencode-private", "data", "opencode", "auth.json")
const auth = JSON.parse(await readFile(authPath, "utf8").then((text) => text.replace(/^\uFEFF/, ""))) as Record<
  string,
  { key?: string }
>
const credential = auth["minimax-cn-coding-plan"]?.key?.trim()
if (!credential) throw new Error("Isolated MiniMax Coding Plan credential is missing")
process.env.MINIMAX_API_KEY = credential

const projectConfig = await loadConfig(repoRoot)
const result = await runSkillOptMerger({
  cwd: repoRoot,
  runRoot: mergerRoot,
  sourceSkills,
  config: {
    ...projectConfig.mergeConfig.asSkillOpt,
    enabled: true,
    projectRoot: skillOptRoot,
    configPath: runtimeConfig,
    pipelineMode: "native_train",
    nativeTrainConfigPath: runtimeConfig,
    nativeTrainSplitDir: "data/spreadsheetbench_split",
    nativeTrainDataDirs: [],
    nativeTrainEpochs: 4,
    nativeTrainBatchSize: 40,
    nativeTrainMaxSteps: 0,
    nativeTrainEvalTest: false,
    nativeTrainTargetWorkers: 2,
    batchSize: 8,
    workers: 2,
    optimizerBackend: "minimax_chat",
    optimizerModel: "MiniMax-M2.7",
    optimizerBaseUrl: "https://api.minimaxi.com/anthropic/v1",
    optimizerApiKeyEnv: "MINIMAX_API_KEY",
    reasoningEffort: "medium",
    targetBackend: "minimax_chat",
    targetModel: "MiniMax-M2.7",
    targetBaseUrl: "https://api.minimaxi.com/anthropic/v1",
    targetApiKeyEnv: "MINIMAX_API_KEY",
    timeoutMs: 64_800_000,
  },
})

await writeFile(
  path.join(outRoot, "merge-complete.json"),
  JSON.stringify({ completedAt: new Date().toISOString(), repeat, ...result }, null, 2),
  "utf8",
)
console.log(JSON.stringify({ repeat, outRoot, ...result }, null, 2))
