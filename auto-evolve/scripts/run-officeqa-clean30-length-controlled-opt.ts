import { createHash } from "node:crypto"
import path from "node:path"
import { mkdir, readFile, readdir, stat } from "node:fs/promises"
import { runSkillOptMerger, type SkillOptSourceSkill } from "../orchestrator/multi-instance/skillopt-merger"
import { loadConfig, type LoadedMergeAsSkillOptConfig } from "../orchestrator/schema"
import { writeJsonFile } from "../orchestrator/fs"

const SOURCE_RUN = "C:/Users/ZhuanZ/Desktop/opencode re/opencode latest/auto-evolve/runtime-state/benchmark-runs/20260904-officeqa-clean-missing36-aev-minimax27"
const TEST_SPLIT = "C:/Users/ZhuanZ/Desktop/opencode re/opencode latest/auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench/splits/test-172-skillopt.json"
const OUTPUT_ROOT = "E:/project/SkillOpt-length-cap-runs"
const OUTPUT_NAME = "officeqa-clean30-length5768-minimax27-20260921"
const CAP_BYTES = 5768
const EXPECTED_SOURCE_COUNT = 30

type VerifiedSource = {
  id: string
  status: string
  pending: string
  attemptID?: string
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
  return entries.length === 1 && entries[0] === "controller.log" && (await stat(path.join(root, "controller.log"))).size === 0
}

async function digestDirectory(root: string) {
  const hash = createHash("sha256")
  async function visit(current: string) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      const relative = path.relative(root, absolute).replaceAll("\\", "/")
      if (entry.isDirectory()) {
        await visit(absolute)
      } else if (entry.isFile()) {
        hash.update(relative)
        hash.update("\0")
        hash.update(await readFile(absolute))
        hash.update("\0")
      } else {
        throw new Error(`Unsupported source entry: ${absolute}`)
      }
    }
  }
  await visit(root)
  return hash.digest("hex")
}

async function loadCleanSources() {
  const rows = await readJson<VerifiedSource[]>(path.join(SOURCE_RUN, "verified-training.json"))
  const testIDs = new Set(await readJson<string[]>(TEST_SPLIT))
  if (rows.length !== EXPECTED_SOURCE_COUNT) {
    throw new Error(`Expected ${EXPECTED_SOURCE_COUNT} verified sources, found ${rows.length}`)
  }
  if (rows.some((row) => row.status !== "verified_success" || !row.id || !row.pending)) {
    throw new Error("Every clean source must be a verified_success row with an ID and package path")
  }
  const unique = new Set(rows.map((row) => row.id))
  if (unique.size !== rows.length) throw new Error("Clean source IDs are not unique")
  const overlap = rows.map((row) => row.id).filter((id) => testIDs.has(id))
  // 零交集是本次实验成立的前提，不能事后靠剔题补救。
  if (overlap.length > 0) throw new Error(`Clean source/test overlap detected: ${overlap.join(",")}`)

  const manifestRows = [] as Array<VerifiedSource & { packageHash: string; packageBytes: number; fileCount: number }>
  const sources = [] as SkillOptSourceSkill[]
  for (const row of rows) {
    const skillRoot = path.resolve(row.pending)
    if (!(await isDirectory(skillRoot))) throw new Error(`Verified source package is missing: ${skillRoot}`)
    const files = await readdir(skillRoot, { recursive: true, withFileTypes: true })
    const regularFiles = files.filter((entry) => entry.isFile())
    if (regularFiles.length === 0) throw new Error(`Verified source package is empty: ${skillRoot}`)
    let packageBytes = 0
    for (const entry of regularFiles) packageBytes += (await stat(path.join(entry.parentPath, entry.name))).size
    manifestRows.push({ ...row, packageHash: await digestDirectory(skillRoot), packageBytes, fileCount: regularFiles.length })
    sources.push({ id: row.id, skillRoot })
  }
  return { sources, manifestRows, testCount: testIDs.size }
}

function aggregateOnlyConfig(base: LoadedMergeAsSkillOptConfig): LoadedMergeAsSkillOptConfig {
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
    // 本次只检验 Opt 合并，禁止再次误触有重合的 train50。
    pipelineMode: "aggregate_only",
    nativeTrainEvalTest: false,
    maxSkillBytes: CAP_BYTES,
    lengthRepairAttempts: 5,
  }
}

async function main() {
  const cwd = path.resolve(import.meta.dir, "..", "..")
  const out = path.join(OUTPUT_ROOT, OUTPUT_NAME)
  const auditOnly = process.argv.includes("--audit-only")
  if (!(await isFreshControllerRoot(out))) throw new Error(`Refusing to overwrite an existing clean run: ${out}`)
  if (!auditOnly && !process.env.AEV_LENGTH_CONTROL_MINIMAX_KEY?.trim()) {
    throw new Error("AEV_LENGTH_CONTROL_MINIMAX_KEY is required and must be supplied only through the environment")
  }

  const { sources, manifestRows, testCount } = await loadCleanSources()
  const experimentManifest = {
    schema: "auto-evolve/officeqa-clean-length-control/v1",
    createdAt: new Date().toISOString(),
    purpose: "Merge the new zero-overlap verified AEV Skills with native SkillOpt aggregation under the optMiniMax byte cap.",
    sourceRun: SOURCE_RUN,
    testSplit: TEST_SPLIT,
    sourceCount: sources.length,
    testCount,
    sourceTestOverlap: 0,
    sourceIDs: sources.map((source) => source.id),
    sourcePackages: manifestRows,
    sourceDigest: createHash("sha256").update(manifestRows.map((row) => `${row.id}:${row.packageHash}`).join("\n")).digest("hex"),
    capBytes: CAP_BYTES,
    producerModel: "MiniMax-M2.7",
    mergerModel: "MiniMax-M2.7",
    testModel: "MiniMax-M2.7",
    pipelineMode: "aggregate_only",
    cleanHeldOutClaim: true,
    limitation: "Thirty of the thirty-six zero-overlap source tasks passed acceptance; all thirty are included without score-based source selection.",
  }
  if (auditOnly) {
    console.log(JSON.stringify({ ok: true, auditOnly: true, ...experimentManifest }))
    return
  }
  await mkdir(out, { recursive: true })
  await writeJsonFile(path.join(out, "experiment-manifest.json"), experimentManifest)

  const config = aggregateOnlyConfig((await loadConfig(cwd)).mergeConfig.asSkillOpt)
  const outcome = await runSkillOptMerger({ cwd, runRoot: out, config, sourceSkills: sources })
  await writeJsonFile(path.join(out, "completion.json"), { completedAt: new Date().toISOString(), outcome })
  console.log(JSON.stringify({ ok: true, runRoot: out, reportPath: outcome.reportPath, mergedSkillDir: outcome.mergedSkillDir }))
}

await main()
