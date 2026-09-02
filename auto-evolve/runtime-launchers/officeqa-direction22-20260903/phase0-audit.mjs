import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const repo = resolve(import.meta.dir, "../..", "..")
const autoEvolve = join(repo, "auto-evolve")
const pack = join(autoEvolve, "task-packs", "real-long-tasks", "officeqa-pro-learnbench")
const sourceRun = join(autoEvolve, "runtime-state", "benchmark-runs", "20260722-230100-officeqa40-merge-as-opt-native-minimax27")
const out = join(autoEvolve, "runtime-state", "external-experiments", "officeqa-direction22-20260903")
mkdirSync(out, { recursive: true })

const json = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
const listFiles = (root) => {
  const result = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === ".test-tmp" || entry.name === "node_modules") continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else result.push(full)
    }
  }
  walk(root)
  return result.sort()
}
const split = (name) => json(join(pack, "splits", name))
const train = split("train-50-skillopt.json")
const officialTest = split("test-172-skillopt.json")
const verifiedRows = json(join(sourceRun, "verified-training.json"))

const sources = verifiedRows.map((row) => {
  const snapshotCampaign = json(join(row.cdir, "campaign.json"))
  const originalCampaign = resolve(snapshotCampaign.sourceSkillPath, "..", "..")
  const round = join(originalCampaign, "rounds", "round-001")
  const skill = resolve(row.pending)
  const sourceFiles = listFiles(skill)
  const traceFiles = [
    join(round, "run-trace.json"),
    join(round, "campaign-lead", "action_trace.md"),
    join(round, "campaign-lead", "response.txt"),
  ].filter(statSafe)
  const unverifiedCandidates = [
    join(round, "campaign-lead", "response.txt"),
    join(round, "campaign-lead", "action_trace.md"),
  ].filter(statSafe)
  return {
    uid: String(row.id),
    verifiedStatus: row.status,
    snapshotCampaign: resolve(row.cdir),
    originalCampaign,
    verifiedSkillRoot: skill,
    verifiedSkillFiles: sourceFiles.map((file) => ({ path: file, sha256: sha256(file) })),
    hasRawTrace: traceFiles.some((file) => /run-trace\.json$/i.test(file)),
    rawTraceFiles: traceFiles,
    hasAcceptanceEvidence: statSafe(join(round, "final-acceptance", "result.json")),
    hasValidatorEvidence: [
      join(round, "final-acceptance", "pass-01", "result.json"),
      join(round, "final-acceptance", "pass-01", "blank-eval-runs"),
    ].every(statSafe),
    unverifiedCandidateFiles: unverifiedCandidates,
  }
})

const sourceIds = new Set(sources.map((item) => item.uid))
const testOverlap = officialTest.filter((uid) => sourceIds.has(String(uid)))
const cleanTest = officialTest.filter((uid) => !sourceIds.has(String(uid)))
const validation = cleanTest.slice(0, 10)
const heldOutTest = cleanTest.slice(10)
const config = {
  protocol: "direction22-stage1",
  dataset: "OfficeQA",
  sourceRun: "20260722-230100-officeqa40-merge-as-opt-native-minimax27",
  sourceCount: sources.length,
  requestedN: [10, 40],
  seeds: ["seed-01", "seed-02", "seed-03"],
  routes: ["trajectory-direct", "unverified-base-skill", "verified-base-skill"],
  validationPolicy: "fixed-10-clean-UIDs-not-in-source",
  officialTestCount: officialTest.length,
  sourceTestOverlapCount: testOverlap.length,
  cleanTestCount: cleanTest.length,
  testLeakagePolicy: "overlap-is-not-scored-as-held-out-evidence",
  model: "siliconflow-qwen3-6-35b-a3b",
  provider: "siliconflow-cn",
  baseURL: "https://api.siliconflow.cn/v1",
  toolMode: "native-singleturn-no-tools-oracle-pages",
  outputLimit: 16384,
  createdAt: new Date().toISOString(),
}
const manifest = {
  schema: "officeqa-direction22-phase0/v1",
  config,
  trainUIDs: train,
  officialTestUIDs: officialTest,
  sourceUIDs: [...sourceIds],
  sourceTestOverlap: testOverlap,
  cleanValidationUIDs: validation,
  cleanHeldOutTestUIDs: heldOutTest,
  sourceCompleteness: {
    total: sources.length,
    rawTrace: sources.filter((item) => item.hasRawTrace).length,
    acceptance: sources.filter((item) => item.hasAcceptanceEvidence).length,
    validator: sources.filter((item) => item.hasValidatorEvidence).length,
    verifiedSkill: sources.filter((item) => item.verifiedStatus === "verified_success").length,
  },
  sources,
}
manifest.configHash = createHash("sha256").update(JSON.stringify(config)).digest("hex")
writeFileSync(join(out, "phase0-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8")
writeFileSync(join(out, "phase0-summary.json"), JSON.stringify({
  configHash: manifest.configHash,
  sourceCompleteness: manifest.sourceCompleteness,
  officialTestCount: officialTest.length,
  sourceTestOverlapCount: testOverlap.length,
  cleanValidationCount: validation.length,
  cleanHeldOutTestCount: heldOutTest.length,
  phase1Ready: sources.every((item) => item.hasRawTrace && item.hasAcceptanceEvidence && item.hasValidatorEvidence),
}, null, 2) + "\n", "utf8")
console.log(JSON.stringify({ output: out, configHash: manifest.configHash, sourceCompleteness: manifest.sourceCompleteness, officialTest: officialTest.length, overlap: testOverlap.length, cleanValidation: validation.length, cleanHeldOutTest: heldOutTest.length, phase1Ready: sources.every((item) => item.hasRawTrace && item.hasAcceptanceEvidence && item.hasValidatorEvidence) }))

function statSafe(file) {
  try { return statSync(file).isFile() } catch { return false }
}
