import { createHash } from "node:crypto"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { loadConfig } from "../orchestrator/schema"
import { runSkillOptNativeEval } from "../orchestrator/skillopt-native-eval/runner"
import { pathExists, writeJsonFile } from "../orchestrator/fs"

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const referenceRoot = "E:/project/SkillOpt-length-cap-runs/officeqa-clean42-merge-as-old-length5768-minimax27-20260923"
const outDir = "E:/project/SkillOpt-length-cap-runs/officeqa-clean42-native-noskill-minimax27-20260923"
const keyFile = "C:/Users/ZhuanZ/Desktop/minimaxkey.txt"
const run = process.argv.includes("--run")
const resume = process.argv.includes("--resume")
if (resume && !run) throw new Error("--resume requires --run")

const referenceLaunch = JSON.parse(
  await readFile(path.join(referenceRoot, "test-valid-unseen-172", "launch.json"), "utf8"),
) as Record<string, unknown>
const referenceResults = path.join(referenceRoot, "test-valid-unseen-172", "native-output", "results.jsonl")
const project = await loadConfig(repoRoot)
const config = {
  ...project.skillOptDirectChatConfig,
  enabled: true,
  targetAuthFile: "",
  targetAuthProviderID: "",
  targetApiKeyEnv: "AEV_LENGTH_CONTROL_MINIMAX_KEY",
}
const projectRoot = path.resolve(config.projectRoot)
const resolveConfigured = (value: string) =>
  path.resolve(path.isAbsolute(value) ? value : path.join(projectRoot, value)).replace(/\\/g, "/")
const actual = {
  projectRoot: projectRoot.replace(/\\/g, "/"),
  configPath: resolveConfigured(config.configPath),
  sourceSplitDir: resolveConfigured(config.splitDir),
  dataDirs: config.dataDirs.map(resolveConfigured),
  targetBackend: config.targetBackend,
  targetModel: config.targetModel,
  targetBaseUrl: config.targetBaseUrl,
  reasoningEffort: config.reasoningEffort,
  workers: config.workers,
}
for (const [field, value] of Object.entries(actual)) {
  if (JSON.stringify(value) !== JSON.stringify(referenceLaunch[field])) {
    throw new Error(`Current ${field} differs from frozen D launch; refusing incomparable baseline`)
  }
}
if (referenceLaunch.split !== "valid_unseen" || referenceLaunch.useLocalTools !== false) {
  throw new Error("Frozen D split or tool mode is not the expected single-turn/no-tools condition")
}
if (!(await pathExists(referenceResults))) throw new Error("Frozen D per-case ledger is missing")

const referenceRows = (await readFile(referenceResults, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Record<string, unknown>)
const ids = referenceRows.map((row) => String(row.id))
if (ids.length !== 172 || new Set(ids).size !== 172) {
  throw new Error(`Frozen D case ledger is not 172 unique IDs: ${ids.length}`)
}

console.log("Asset reuse: D skill and 172-case results are frozen; old no-skill 66/172 is protocol-incompatible.")
console.log(`Preflight: identical D configuration, ${ids.length} unique cases, MiniMax only.`)
console.log(`New no-skill output: ${outDir}`)
if (!run) process.exit(0)
const outputExists = await pathExists(outDir)
if (outputExists !== resume) {
  throw new Error(outputExists
    ? `Output already exists; use --run --resume only after auditing the existing ledger: ${outDir}`
    : `Cannot resume missing output directory: ${outDir}`)
}

if (resume) {
  const manifest = JSON.parse(await readFile(path.join(outDir, "experiment-manifest.json"), "utf8")) as Record<string, unknown>
  const previousLaunch = JSON.parse(await readFile(path.join(outDir, "launch.json"), "utf8")) as Record<string, unknown>
  const emptyPath = path.join(outDir, "empty-skill.md")
  const priorRowsPath = path.join(outDir, "native-output", "results.jsonl")
  if (manifest.schema !== "auto-evolve/officeqa-clean42-native-noskill-control/v1" ||
      manifest.referenceResultsSha256 !== createHash("sha256").update(await readFile(referenceResults)).digest("hex") ||
      manifest.targetModel !== "MiniMax-M2.7" ||
      manifest.expectedCases !== 172 ||
      previousLaunch.skillSha256 !== createHash("sha256").update("").digest("hex") ||
      previousLaunch.outputDir !== path.resolve(outDir, "native-output").replace(/\\/g, "/") ||
      (await readFile(emptyPath, "utf8")) !== "") {
    throw new Error("Existing no-Skill run does not match frozen inputs; refusing resume")
  }
  const priorRows = (await readFile(priorRowsPath, "utf8"))
    .split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const referenceIDs = new Set(ids)
  const priorIDs = priorRows.map((row) => String(row.id))
  if (priorRows.length >= 172 || new Set(priorIDs).size !== priorIDs.length ||
      priorIDs.some((id) => !referenceIDs.has(id))) {
    throw new Error("Existing result ledger is complete, duplicated, or contains unexpected UIDs")
  }
  console.log(`Resuming same output with ${priorRows.length}/172 unique cases; completed cases will not be re-requested.`)
}

const keyLines = (await readFile(keyFile, "utf8"))
  .replace(/^\uFEFF/, "")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
if (keyLines.length < 2) throw new Error("MiniMax key file has no second nonempty line")
process.env.AEV_LENGTH_CONTROL_MINIMAX_KEY = keyLines[1]

// Empty Skill is the only experimental change; resume preserves earlier case evidence.
if (!resume) await mkdir(outDir, { recursive: true })
const emptySkill = path.join(outDir, "empty-skill.md")
if (!resume) await writeFile(emptySkill, "", "utf8")
if (!resume) await writeJsonFile(path.join(outDir, "experiment-manifest.json"), {
  schema: "auto-evolve/officeqa-clean42-native-noskill-control/v1",
  createdAt: new Date().toISOString(),
  referenceLaunch: path.join(referenceRoot, "test-valid-unseen-172", "launch.json"),
  referenceResults,
  referenceResultsSha256: createHash("sha256").update(await readFile(referenceResults)).digest("hex"),
  emptySkill,
  split: "valid_unseen",
  expectedCases: 172,
  targetModel: "MiniMax-M2.7",
  productionModel: "none",
  mode: "SkillOpt native single-turn no-tools",
  sourceMutationPolicy: "read_only_external_project",
  keySlot: "minimaxkey.txt second nonempty line",
})

const result = await runSkillOptNativeEval({
  config,
  skillPath: emptySkill,
  split: "valid_unseen",
  outDir,
})
if (result.total !== 172) throw new Error(`Expected 172 cases, got ${result.total}`)

const baselineRows = (await readFile(result.nativeResultsPath, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Record<string, unknown>)
const byID = new Map(baselineRows.map((row) => [String(row.id), row]))
const fields = ["question", "ground_truth", "source_files", "resolved_source_paths", "target_user_prompt"]
const mismatches: string[] = []
for (const reference of referenceRows) {
  const baseline = byID.get(String(reference.id))
  if (!baseline) {
    mismatches.push(`${reference.id}: missing`)
    continue
  }
  for (const field of fields) {
    if (JSON.stringify(reference[field]) !== JSON.stringify(baseline[field])) {
      mismatches.push(`${reference.id}: ${field}`)
    }
  }
}
await writeJsonFile(path.join(outDir, "protocol-audit.json"), {
  schema: "auto-evolve/officeqa-noskill-protocol-audit/v1",
  comparedCases: referenceRows.length,
  comparedFields: fields,
  mismatches,
  comparable: mismatches.length === 0,
})
if (mismatches.length) throw new Error(`No-skill run differs from frozen D on ${mismatches.length} fields; results are not comparable`)
console.log(`No-skill result: ${result.passed}/${result.total}; question/gold/material/user-prompt audit passed.`)
