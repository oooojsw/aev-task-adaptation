import { createHash } from "node:crypto"
import path from "node:path"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { loadConfig } from "../../orchestrator/schema"
import { runSkillOptMerger } from "../../orchestrator/multi-instance/skillopt-merger"

const repeatText = process.argv.find((arg) => arg.startsWith("--repeat="))?.split("=", 2)[1] ?? ""
const repeat = Number.parseInt(repeatText, 10)
if (![1, 2, 3].includes(repeat)) throw new Error("--repeat must be 1, 2, or 3")
const resumeExisting = process.argv.includes("--resume-existing")

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..")
const autoRoot = path.join(repoRoot, "auto-evolve")
const sequenceID = "20260901-spreadsheetbench-fair-aev-mergeopt-repeats"
const sourceRun = path.join(autoRoot, "runtime-state", "benchmark-runs", "20260622-171219-spreadsheetbench-official80-minimax27-hier5")
const label = String(repeat).padStart(2, "0")
const outRoot = path.join(autoRoot, "runtime-state", "benchmark-runs", `${sequenceID}-repeat-${label}`)
const mergerRoot = path.join(outRoot, "merge-and-validate", "phase2-skillopt")
const nativeTrainRoot = path.join(mergerRoot, "native-train")
const runtimeConfig = path.join(autoRoot, "进度报告", "2026-08-04-OfficeQA论文统计", "spreadsheetbench-merge-as-opt-config.yaml")
const skillOptRoot = "C:/Users/ZhuanZ/Desktop/SkillOpt"
const dataRoot = "E:/project/experiment/SpreadsheetBench/all_data_912_v0.1"

function normalizeStoredWindowsPath(value: string) {
  let normalized = value
  while (normalized.includes("\\\\")) normalized = normalized.replaceAll("\\\\", "\\")
  return path.resolve(normalized)
}

async function hashSkillTree(root: string): Promise<string> {
  const files: string[] = []
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(item)
      else if (entry.isFile()) files.push(item)
    }
  }
  await visit(root)
  files.sort()
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(path.relative(root, file).replaceAll("\\", "/"))
    hash.update("\0")
    hash.update(await readFile(file))
    hash.update("\0")
  }
  return hash.digest("hex")
}

const priorSummary = await stat(path.join(nativeTrainRoot, "summary.json")).catch(() => undefined)
const priorSkill = await stat(path.join(nativeTrainRoot, "best_skill.md")).catch(() => undefined)
if (priorSummary?.isFile() && priorSkill?.isFile()) {
  const summary = JSON.parse(await readFile(path.join(nativeTrainRoot, "summary.json"), "utf8")) as { total_steps?: number }
  if (summary.total_steps === 8) {
    console.log(JSON.stringify({ passed: true, skipped: true, repeat, outRoot, reason: "repeat already complete" }))
    process.exit(0)
  }
  if (!resumeExisting) throw new Error(`Existing incomplete output must be explicitly resumed with --resume-existing or archived: ${outRoot}`)
  console.log(JSON.stringify({ repeat, outRoot, resuming: true, checkpoint: "native-train/runtime_state.json" }))
}

const state = JSON.parse((await readFile(path.join(sourceRun, "orchestrator-state.json"), "utf8")).replace(/^\uFEFF/, "")) as {
  trainResults?: Array<{ id?: string; status?: string; campaignDir?: string }>
}
const verifiedRows = (state.trainResults ?? [])
  .filter((row) => row.status === "verified_success" && row.id && row.campaignDir)
  .sort((left, right) => String(left.id).localeCompare(String(right.id)))
const sourceSkills = verifiedRows.map((row) => ({ id: String(row.id), skillRoot: path.join(normalizeStoredWindowsPath(String(row.campaignDir)), "pending-expert-package", "current") }))
if (sourceSkills.length !== 69) throw new Error(`Expected exactly 69 frozen verified source skills, got ${sourceSkills.length}`)
const sourceManifest = await Promise.all(sourceSkills.map(async ({ id, skillRoot }) => {
  if (!(await stat(skillRoot).catch(() => undefined))?.isDirectory()) throw new Error(`Missing source skill: ${id}`)
  return { id, skillRoot, sha256: await hashSkillTree(skillRoot) }
}))

const splitRoot = path.join(skillOptRoot, "data", "spreadsheetbench_split")
const splitCounts: Record<string, number> = {}
const allIDs: string[] = []
for (const split of ["train", "val", "test"]) {
  const rows = JSON.parse(await readFile(path.join(splitRoot, split, "items.json"), "utf8")) as Array<{ id?: string | number; spreadsheet_path?: string }>
  splitCounts[split] = rows.length
  for (const row of rows) {
    if (!String(row.id ?? "").trim()) throw new Error(`Blank ${split} split ID`)
    const material = path.resolve(dataRoot, String(row.spreadsheet_path ?? "").replaceAll("/", path.sep))
    if (!(await stat(material).catch(() => undefined))?.isDirectory()) throw new Error(`Missing material for ${row.id}`)
    allIDs.push(String(row.id))
  }
}
if (splitCounts.train !== 80 || splitCounts.val !== 40 || splitCounts.test !== 280 || new Set(allIDs).size !== 400) {
  throw new Error(`Invalid official split: ${JSON.stringify(splitCounts)}`)
}

const authPath = path.join(autoRoot, ".opencode-private", "data", "opencode", "auth.json")
const auth = JSON.parse((await readFile(authPath, "utf8")).replace(/^\uFEFF/, "")) as Record<string, { key?: string }>
const credential = auth["minimax-cn-coding-plan"]?.key?.trim()
if (!credential) throw new Error("Isolated MiniMax Coding Plan credential is missing")

await mkdir(outRoot, { recursive: true })
await writeFile(path.join(outRoot, "launch-audit.json"), JSON.stringify({
  schema: "auto-evolve/fair-aev-merge-as-opt-repeat/v1",
  createdAt: new Date().toISOString(), sequenceID, repeat, repeatsTotal: 3,
  sourcePolicy: "Read-only frozen 69 verified_success AEV skills; source tree hashes recorded before training.",
  sourceBenchmarkRun: sourceRun, sourceManifest,
  split: { train: 80, validation: 40, testHeldOut: 280, disjoint: true },
  model: "MiniMax-M2.7", epochs: 4, batchSize: 40, targetWorkers: 2,
  configPath: runtimeConfig, outputRoot: outRoot,
  reportingPolicy: "All three repeats must be reported; no best-repeat selection for paper conclusions."
}, null, 2), "utf8")

process.env.MINIMAX_API_KEY = credential
const projectConfig = await loadConfig(repoRoot)
const result = await runSkillOptMerger({
  cwd: repoRoot,
  runRoot: mergerRoot,
  sourceSkills,
  config: {
    ...projectConfig.mergeConfig.asSkillOpt,
    enabled: true, projectRoot: skillOptRoot, configPath: runtimeConfig,
    pipelineMode: "native_train", nativeTrainConfigPath: runtimeConfig, nativeTrainSplitDir: "data/spreadsheetbench_split",
    nativeTrainDataDirs: [], nativeTrainEpochs: 4, nativeTrainBatchSize: 40, nativeTrainMaxSteps: 0,
    nativeTrainEvalTest: false, nativeTrainTargetWorkers: 2, batchSize: 8, workers: 2,
    optimizerBackend: "minimax_chat", optimizerModel: "MiniMax-M2.7", optimizerBaseUrl: "https://api.minimaxi.com/anthropic/v1", optimizerApiKeyEnv: "MINIMAX_API_KEY", reasoningEffort: "medium",
    targetBackend: "minimax_chat", targetModel: "MiniMax-M2.7", targetBaseUrl: "https://api.minimaxi.com/anthropic/v1", targetApiKeyEnv: "MINIMAX_API_KEY", timeoutMs: 64_800_000,
  },
})
await writeFile(path.join(outRoot, "merge-complete.json"), JSON.stringify({ completedAt: new Date().toISOString(), repeat, ...result }, null, 2), "utf8")
console.log(JSON.stringify({ repeat, outRoot, ...result }, null, 2))
