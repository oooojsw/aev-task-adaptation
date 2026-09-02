import path from "node:path"
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { loadConfig } from "../../orchestrator/schema"
import { runSkillOptMerger } from "../../orchestrator/multi-instance/skillopt-merger"

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..")
const autoRoot = path.join(repoRoot, "auto-evolve")
const sourceRun = path.join(
  autoRoot,
  "runtime-state",
  "benchmark-runs",
  "20260622-171219-spreadsheetbench-official80-minimax27-hier5",
)
const outRoot = path.join(
  autoRoot,
  "runtime-state",
  "benchmark-runs",
  "20260804-spreadsheetbench69-merge-as-opt-minimax27",
)
const mergerRoot = path.join(outRoot, "merge-and-validate", "phase2-skillopt")
const runtimeConfig = path.join(import.meta.dir, "spreadsheetbench-merge-as-opt-config.yaml")
const skillOptRoot = "C:/Users/ZhuanZ/Desktop/SkillOpt"

function normalizeStoredWindowsPath(value: string) {
  let normalized = value
  while (normalized.includes("\\\\")) normalized = normalized.replaceAll("\\\\", "\\")
  return path.resolve(normalized)
}

const state = JSON.parse(
  await readFile(path.join(sourceRun, "orchestrator-state.json"), "utf8").then((text) => text.replace(/^\uFEFF/, "")),
) as {
  trainResults?: Array<{ id?: string; status?: string; campaignDir?: string }>
}

const verifiedRows = (state.trainResults ?? [])
  .filter((row) => row.status === "verified_success" && row.id && row.campaignDir)
  .sort((left, right) => String(left.id).localeCompare(String(right.id)))

console.error(`[preflight] ledger verified rows: ${verifiedRows.length}`)
const sourceSkills = verifiedRows.map((row) => {
  const campaignDir = normalizeStoredWindowsPath(String(row.campaignDir))
  const skillRoot = path.join(campaignDir, "pending-expert-package", "current")
  return { id: String(row.id), skillRoot }
})
await Promise.all(sourceSkills.map(async ({ id, skillRoot }) => {
  const skillStat = await stat(skillRoot).catch(() => undefined)
  if (!skillStat?.isDirectory()) {
    throw new Error(`Verified source skill directory is missing: ${id} -> ${skillRoot}`)
  }
}))
console.error(`[preflight] source directories verified: ${sourceSkills.length}`)
if (sourceSkills.length !== 69) {
  throw new Error(`Expected exactly 69 verified SpreadsheetBench source skills, got ${sourceSkills.length}`)
}

const requiredPaths = [
  runtimeConfig,
  path.join(skillOptRoot, "data", "spreadsheetbench_split", "train"),
  path.join(skillOptRoot, "data", "spreadsheetbench_split", "val"),
  path.join(skillOptRoot, "data", "spreadsheetbench_split", "test"),
  "E:/project/experiment/SpreadsheetBench/all_data_912_v0.1",
]
for (const required of requiredPaths) {
  if (!(await stat(required).then(() => true).catch(() => false))) {
    throw new Error(`Required merge-as-opt path does not exist: ${required}`)
  }
}
console.error(`[preflight] split, config, and data roots verified: ${requiredPaths.length}`)

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
  if (!itemStat?.isDirectory()) throw new Error(`SpreadsheetBench material directory is missing: ${row.id} -> ${itemRoot}`)
}))
console.error("[preflight] split identity and 400 material directories verified")

await mkdir(outRoot, { recursive: true })
const audit = {
  schema: "auto-evolve/spreadsheetbench-merge-as-opt-launch/v1",
  createdAt: new Date().toISOString(),
  sourceBenchmarkRun: sourceRun,
  sourceSkillCount: sourceSkills.length,
  sourceSkillIDs: sourceSkills.map((item) => item.id),
  sourceSkills,
  split: { train: 80, validation: 40, testHeldOut: 280 },
  splitUniqueAndDisjoint: true,
  materialDirectoriesVerified: 400,
  sourcePolicy: "69 verified_success AEV Skills only; held-out test is not used during merge-as-opt training",
  model: "MiniMax-M2.7",
  epochs: 4,
  batchSize: 40,
  targetWorkers: 2,
  outputRoot: outRoot,
  mergeRoot: mergerRoot,
}
await writeFile(path.join(outRoot, "launch-audit.json"), JSON.stringify(audit, null, 2), "utf8")

if (process.argv.includes("--audit-only")) {
  console.log(JSON.stringify({ passed: true, mode: "audit-only", ...audit }, null, 2))
  process.exit(0)
}

const existingMergerEntries = await readdir(mergerRoot).catch(() => [])
if (existingMergerEntries.some((name) => name.startsWith("request-") || name === "report.json")) {
  throw new Error(`Refusing duplicate merge-as-opt launch in non-empty merger root: ${mergerRoot}`)
}
const launchLockPath = path.join(outRoot, "launch.lock")
const launchLock = await open(launchLockPath, "wx").catch(() => undefined)
if (!launchLock) throw new Error(`Another merge-as-opt launcher already claimed this run: ${launchLockPath}`)
await launchLock.writeFile(JSON.stringify({ pid: process.pid, claimedAt: new Date().toISOString() }), "utf8")
await launchLock.close()

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
  JSON.stringify({ completedAt: new Date().toISOString(), ...result }, null, 2),
  "utf8",
)
console.log(JSON.stringify(result, null, 2))
