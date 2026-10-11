import { createHash } from "node:crypto"
import path from "node:path"
import { mkdir, readFile, readdir, stat } from "node:fs/promises"
import { runSkillOptMerger, type SkillOptSourceSkill } from "../orchestrator/multi-instance/skillopt-merger"
import { loadConfig, type LoadedMergeAsSkillOptConfig } from "../orchestrator/schema"
import { writeJsonFile } from "../orchestrator/fs"

const ROOT = "C:/Users/ZhuanZ/Desktop/opencode re/opencode latest/auto-evolve"
const CLEAN36_RUN = `${ROOT}/runtime-state/benchmark-runs/20260904-officeqa-clean-missing36-aev-minimax27`
const LEGACY_SNAPSHOT_ROOT = `${ROOT}/runtime-state/benchmark-runs/20260722-230100-officeqa40-merge-as-opt-native-minimax27/source-skill-snapshots`
const CAMPAIGN_ROOT = `${ROOT}/runtime-state/long-task-campaigns`
const TEST_SPLIT = `${ROOT}/task-packs/real-long-tasks/officeqa-pro-learnbench/splits/test-172-skillopt.json`
const OUTPUT_ROOT = "E:/project/SkillOpt-length-cap-runs"
const OUTPUT_NAME = "officeqa-clean42-length5768-minimax27-20260921"
const CAP_BYTES = 5768

const RETAINED_ACCEPTED_IDS = [
  "UID0002", "UID0017", "UID0028", "UID0033", "UID0049", "UID0056",
  "UID0073", "UID0085", "UID0087", "UID0092", "UID0115", "UID0122",
] as const

type VerifiedSource = { id: string; status: string; pending: string; attemptID?: string }
type LegacyEvidence = {
  id: string
  skillRoot: string
  skillRootKind: "frozen_snapshot" | "accepted_round_snapshot"
  campaignPath: string
  acceptanceResultPath: string
  acceptanceSummary: string
}

async function hasInstructionalSkillFile(root: string) {
  if (!(await isDirectory(root))) return false
  const files = await readdir(root, { recursive: true, withFileTypes: true })
  return files.some((entry) => entry.isFile() && /^(CORE|SKILL|INDEX)\.(md|txt)$/i.test(entry.name))
}

async function readJson<T>(file: string) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) as T
}

async function isDirectory(file: string) {
  try { return (await stat(file)).isDirectory() } catch { return false }
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
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) {
        hash.update(relative); hash.update("\0"); hash.update(await readFile(absolute)); hash.update("\0")
      } else throw new Error(`Unsupported source entry: ${absolute}`)
    }
  }
  await visit(root)
  return hash.digest("hex")
}

async function findLegacyEvidence(id: string): Promise<LegacyEvidence> {
  const frozenSkillRoot = path.resolve(LEGACY_SNAPSHOT_ROOT, id, "pending-expert-package", "current")
  const names = await readdir(CAMPAIGN_ROOT, { withFileTypes: true })
  const candidates: LegacyEvidence[] = []
  for (const entry of names) {
    if (!entry.isDirectory() || !entry.name.toLowerCase().includes(id.toLowerCase())) continue
    const campaignPath = path.join(CAMPAIGN_ROOT, entry.name, "campaign.json")
    try {
      const campaign = await readJson<{ status?: string; lastFinalAcceptancePassed?: boolean; lastFinalAcceptanceResultPath?: string }>(campaignPath)
      if (campaign.status !== "verified_success" || campaign.lastFinalAcceptancePassed !== true || !campaign.lastFinalAcceptanceResultPath) continue
      const result = await readJson<{ passed?: boolean; summary?: string }>(campaign.lastFinalAcceptanceResultPath)
      if (result.passed === true) {
        const acceptedRoundRoot = path.resolve(campaign.lastFinalAcceptanceResultPath, "..", "..", "..")
        const acceptedRoundSkillRoot = path.join(acceptedRoundRoot, "pending-package")
        // 优先冻结副本；旧目录被后续清空时回退到验收轮快照。
        const skillRoot = (await hasInstructionalSkillFile(frozenSkillRoot)) ? frozenSkillRoot : acceptedRoundSkillRoot
        const skillRootKind = skillRoot === frozenSkillRoot ? "frozen_snapshot" : "accepted_round_snapshot"
        if (await hasInstructionalSkillFile(skillRoot)) {
          candidates.push({ id, skillRoot, skillRootKind, campaignPath, acceptanceResultPath: campaign.lastFinalAcceptanceResultPath, acceptanceSummary: result.summary ?? "" })
        }
      }
    } catch { /* A broken historical record cannot become a source. */ }
  }
  if (candidates.length === 0) throw new Error(`No final-acceptance-passed evidence found for legacy source: ${id}`)
  return candidates.sort((a, b) => a.campaignPath.localeCompare(b.campaignPath))[0]!
}

async function loadSources() {
  const cleanRows = await readJson<VerifiedSource[]>(path.join(CLEAN36_RUN, "verified-training.json"))
  if (cleanRows.length !== 30 || cleanRows.some((row) => row.status !== "verified_success" || !row.id || !row.pending)) {
    throw new Error("Expected exactly 30 current clean36 verified source packages")
  }
  const legacyRows = await Promise.all(RETAINED_ACCEPTED_IDS.map(findLegacyEvidence))
  const all = [
    ...cleanRows.map((row) => ({ id: row.id, skillRoot: path.resolve(row.pending), provenance: "clean36-current" })),
    ...legacyRows.map((row) => ({ id: row.id, skillRoot: row.skillRoot, provenance: "retained14-legacy-final-acceptance", ...row })),
  ]
  const testIDs = new Set(await readJson<string[]>(TEST_SPLIT))
  const ids = new Set(all.map((row) => row.id))
  if (all.length !== 42 || ids.size !== 42) throw new Error(`Expected 42 unique sources, found ${all.length} rows / ${ids.size} IDs`)
  const overlap = [...ids].filter((id) => testIDs.has(id))
  // 训练源与172测试零交集是本轮论文结论的前提。
  if (overlap.length > 0) throw new Error(`Clean42 source/test overlap detected: ${overlap.join(",")}`)

  const manifestRows = [] as Array<typeof all[number] & { packageHash: string; packageBytes: number; fileCount: number }>
  for (const row of all) {
    if (!(await isDirectory(row.skillRoot))) throw new Error(`Source package is missing: ${row.id}`)
    const files = (await readdir(row.skillRoot, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile())
    if (files.length === 0) throw new Error(`Source package is empty: ${row.id}`)
    let packageBytes = 0
    for (const file of files) packageBytes += (await stat(path.join(file.parentPath, file.name))).size
    manifestRows.push({ ...row, packageHash: await digestDirectory(row.skillRoot), packageBytes, fileCount: files.length })
  }
  return { sources: all.map(({ id, skillRoot }) => ({ id, skillRoot })), manifestRows, testCount: testIDs.size }
}

function aggregateOnlyConfig(base: LoadedMergeAsSkillOptConfig): LoadedMergeAsSkillOptConfig {
  return {
    ...base, enabled: true, projectRoot: "E:/project/SkillOpt-length-cap", outputRoot: OUTPUT_ROOT,
    optimizerBackend: "minimax_chat", optimizerModel: "MiniMax-M2.7", optimizerBaseUrl: "https://api.minimaxi.com/anthropic/v1", optimizerApiKeyEnv: "AEV_LENGTH_CONTROL_MINIMAX_KEY",
    targetBackend: "minimax_chat", targetModel: "MiniMax-M2.7", targetBaseUrl: "https://api.minimaxi.com/anthropic/v1", targetApiKeyEnv: "AEV_LENGTH_CONTROL_MINIMAX_KEY",
    pipelineMode: "aggregate_only", nativeTrainEvalTest: false, maxSkillBytes: CAP_BYTES, lengthRepairAttempts: 5,
  }
}

async function main() {
  const cwd = path.resolve(import.meta.dir, "..", "..")
  const out = path.join(OUTPUT_ROOT, OUTPUT_NAME)
  const auditOnly = process.argv.includes("--audit-only")
  if (!(await isFreshControllerRoot(out))) throw new Error(`Refusing to overwrite an existing clean42 run: ${out}`)
  if (!auditOnly && !process.env.AEV_LENGTH_CONTROL_MINIMAX_KEY?.trim()) throw new Error("AEV_LENGTH_CONTROL_MINIMAX_KEY is required through the environment")
  const { sources, manifestRows, testCount } = await loadSources()
  const experimentManifest = {
    schema: "auto-evolve/officeqa-clean42-length-control/v1", createdAt: new Date().toISOString(),
    purpose: "Aggregate all available independently accepted Skills from the task-disjoint clean50 pool under the optMiniMax byte cap, without native post-aggregation training.",
    sourceCount: sources.length, sourceComposition: { clean36CurrentAccepted: 30, retained14LegacyFinalAccepted: 12, excluded: ["UID0007", "UID0014"] },
    testSplit: TEST_SPLIT, testCount, sourceTestOverlap: 0, sourceIDs: sources.map((source) => source.id), sourcePackages: manifestRows,
    sourceDigest: createHash("sha256").update(manifestRows.map((row) => `${row.id}:${row.packageHash}`).join("\n")).digest("hex"),
    capBytes: CAP_BYTES, producerModel: "MiniMax-M2.7", mergerModel: "MiniMax-M2.7", testModel: "MiniMax-M2.7", pipelineMode: "aggregate_only", cleanHeldOutClaim: true,
    limitation: "This B artifact uses all 42 presently evidenced accepted source Skills from a 50-task, task-disjoint pool. It does not retrain single-task Skills or execute native post-aggregation Opt updates.",
  }
  if (auditOnly) { console.log(JSON.stringify({ ok: true, auditOnly: true, ...experimentManifest })); return }
  await mkdir(out, { recursive: true }); await writeJsonFile(path.join(out, "experiment-manifest.json"), experimentManifest)
  const outcome = await runSkillOptMerger({ cwd, runRoot: out, config: aggregateOnlyConfig((await loadConfig(cwd)).mergeConfig.asSkillOpt), sourceSkills: sources as SkillOptSourceSkill[] })
  await writeJsonFile(path.join(out, "completion.json"), { completedAt: new Date().toISOString(), outcome })
  console.log(JSON.stringify({ ok: true, runRoot: out, reportPath: outcome.reportPath, mergedSkillDir: outcome.mergedSkillDir }))
}

await main()
