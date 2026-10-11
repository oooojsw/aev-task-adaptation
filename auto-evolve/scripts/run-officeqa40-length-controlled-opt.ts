import { createHash } from "node:crypto"
import path from "node:path"
import { mkdir, readFile, readdir, stat } from "node:fs/promises"
import { runSkillOptMerger, type SkillOptSourceSkill } from "../orchestrator/multi-instance/skillopt-merger"
import { loadConfig, type LoadedMergeAsSkillOptConfig } from "../orchestrator/schema"
import { writeJsonFile } from "../orchestrator/fs"

const SOURCE_RUN = "C:/Users/ZhuanZ/Desktop/opencode re/opencode latest/auto-evolve/runtime-state/benchmark-runs/20260722-230100-officeqa40-merge-as-opt-native-minimax27"
const OUTPUT_ROOT = "E:/project/SkillOpt-length-cap-runs"
const OUTPUT_NAME = "officeqa40-length5768-minimax27-20260920"
const CAP_BYTES = 5768

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

async function readJson<T>(file: string) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) as T
}

async function isDirectory(file: string) {
  try {
    return (await stat(file)).isDirectory()
  } catch {
    return false
  }
}

async function isFreshControllerRoot(root: string) {
  if (!(await isDirectory(root))) return true
  const entries = await readdir(root)
  // 启动器先建空日志；其他任何产物都代表已有实验，禁止覆盖。
  return entries.length === 1 && entries[0] === "controller.log" && (await stat(path.join(root, "controller.log"))).size === 0
}

type HistoricalState = {
  trainResults?: Array<{ status?: string; campaignDir?: string }>
}

async function loadFrozenSources(): Promise<SkillOptSourceSkill[]> {
  const state = await readJson<HistoricalState>(path.join(SOURCE_RUN, "orchestrator-state.json"))
  const rows = state.trainResults ?? []
  if (rows.length !== 40 || rows.some((row) => row.status !== "verified_success" || !row.campaignDir)) {
    throw new Error("Historical OfficeQA source run must contain exactly 40 verified source Skills")
  }
  const sources = await Promise.all(rows.map(async (row) => {
    const campaignDir = path.resolve(String(row.campaignDir))
    const skillRoot = path.join(campaignDir, "pending-expert-package", "current")
    if (!(await isDirectory(skillRoot))) throw new Error(`Verified source Skill is missing: ${skillRoot}`)
    return { id: path.basename(campaignDir), skillRoot }
  }))
  const unique = new Set(sources.map((source) => source.id))
  if (unique.size !== 40) throw new Error("Historical OfficeQA source IDs are not unique")
  return sources
}

function nativeLengthConfig(base: LoadedMergeAsSkillOptConfig): LoadedMergeAsSkillOptConfig {
  return {
    ...base,
    enabled: true,
    projectRoot: "E:/project/SkillOpt-length-cap",
    outputRoot: OUTPUT_ROOT,
    optimizerBackend: "minimax_chat",
    optimizerModel: "MiniMax-M2.7",
    optimizerBaseUrl: "https://api.minimaxi.com/anthropic/v1",
    optimizerApiKeyEnv: "AEV_LENGTH_CONTROL_MINIMAX_KEY",
    targetBackend: "minimax_chat",
    targetModel: "MiniMax-M2.7",
    targetBaseUrl: "https://api.minimaxi.com/anthropic/v1",
    targetApiKeyEnv: "AEV_LENGTH_CONTROL_MINIMAX_KEY",
    pipelineMode: "native_train",
    nativeTrainConfigPath: "configs/officeqa/default.yaml",
    nativeTrainSplitDir: "data/officeqa_id_split",
    nativeTrainDataDirs: [
      "E:/project/experiment/datasets/OfficeQA_corpus/treasury_bulletins_parsed",
      "C:/Users/ZhuanZ/Desktop/SkillOpt/data/officeqa_docs_pdf_text_fallback",
    ],
    nativeTrainEpochs: 4,
    nativeTrainBatchSize: 40,
    nativeTrainMaxSteps: 0,
    nativeTrainEvalTest: true,
    nativeTrainTargetWorkers: 2,
    maxSkillBytes: CAP_BYTES,
    lengthRepairAttempts: 5,
  }
}

async function main() {
  const cwd = path.resolve(import.meta.dir, "..", "..")
  const out = path.join(OUTPUT_ROOT, OUTPUT_NAME)
  if (!(await isFreshControllerRoot(out))) throw new Error(`Refusing to overwrite an existing length-control run: ${out}`)
  if (!process.env.AEV_LENGTH_CONTROL_MINIMAX_KEY?.trim()) {
    throw new Error("AEV_LENGTH_CONTROL_MINIMAX_KEY is required and must be supplied only through the environment")
  }

  const sources = await loadFrozenSources()
  await mkdir(out, { recursive: true })
  const config = nativeLengthConfig((await loadConfig(cwd)).mergeConfig.asSkillOpt)
  await writeJsonFile(path.join(out, "experiment-manifest.json"), {
    schema: "auto-evolve/officeqa-length-control/v1",
    createdAt: new Date().toISOString(),
    purpose: "Control final Skill length while keeping the historical 40 verified AEV source Skills and MiniMax Opt pipeline fixed.",
    sourceRun: SOURCE_RUN,
    sourceCount: sources.length,
    sourceIDs: sources.map((source) => source.id),
    sourceDigest: sha256(sources.map((source) => `${source.id}:${source.skillRoot}`).join("\n")),
    capBytes: CAP_BYTES,
    producerModel: "MiniMax-M2.7",
    testModel: "MiniMax-M2.7",
    outputRoot: out,
    cleanHeldOutClaim: false,
    limitation: "This historical OfficeQA comparison has known source/test overlap and is a controlled length ablation, not a strict held-out generalization result.",
  })
  const outcome = await runSkillOptMerger({ cwd, runRoot: out, config, sourceSkills: sources })
  await writeJsonFile(path.join(out, "completion.json"), { completedAt: new Date().toISOString(), outcome })
  console.log(JSON.stringify({ ok: true, runRoot: out, reportPath: outcome.reportPath, mergedSkillDir: outcome.mergedSkillDir }))
}

await main()
