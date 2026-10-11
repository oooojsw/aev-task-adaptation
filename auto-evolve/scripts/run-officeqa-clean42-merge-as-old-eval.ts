import { createHash } from "node:crypto"
import path from "node:path"
import { copyFile, mkdir, readFile } from "node:fs/promises"
import { loadConfig } from "../orchestrator/schema"
import { buildSkillBundle } from "../orchestrator/direct-chat/skill-bundler"
import { runSkillOptNativeEval } from "../orchestrator/skillopt-native-eval/runner"
import { writeJsonFile, pathExists } from "../orchestrator/fs"

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const runRoot = "E:/project/SkillOpt-length-cap-runs/officeqa-clean42-merge-as-old-length5768-minimax27-20260923"
const sourceSkill = path.join(runRoot, "final-skill-input", "CORE.md")
const outDir = path.join(runRoot, "test-valid-unseen-172")
const skillRoot = path.join(outDir, "final-skill-input")
const targetSkill = path.join(skillRoot, "CORE.md")
const maxBytes = 5768

// Ensure key is populated from minimaxkey.txt line 2 if not in env
const keyFile = "C:/Users/ZhuanZ/Desktop/minimaxkey.txt"
if (!process.env.AEV_LENGTH_CONTROL_MINIMAX_KEY?.trim() && (await pathExists(keyFile))) {
  const lines = (await readFile(keyFile, "utf8")).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length >= 2) {
    process.env.AEV_LENGTH_CONTROL_MINIMAX_KEY = lines[1]
  }
}

if (!process.env.AEV_LENGTH_CONTROL_MINIMAX_KEY?.trim()) {
  throw new Error("AEV_LENGTH_CONTROL_MINIMAX_KEY is required for the merge-as-old clean42 evaluation")
}

if (!(await pathExists(sourceSkill))) {
  throw new Error(`Source merged skill does not exist yet: ${sourceSkill}`)
}

const content = await readFile(sourceSkill)
if (content.byteLength > maxBytes) {
  throw new Error(`Final Skill exceeds ${maxBytes} bytes: ${content.byteLength}`)
}

await mkdir(skillRoot, { recursive: true })
await copyFile(sourceSkill, targetSkill)
await writeJsonFile(path.join(outDir, "evaluation-manifest.json"), {
  schema: "auto-evolve/officeqa-clean42-merge-as-old-final-eval/v1",
  createdAt: new Date().toISOString(),
  sourceSkill,
  sourceBytes: content.byteLength,
  sourceSha256: createHash("sha256").update(content).digest("hex"),
  split: "valid_unseen",
  expectedCases: 172,
  targetModel: "MiniMax-M2.7",
  mode: "SkillOpt native single-turn no-tools",
  hardCap: maxBytes,
})

const projectConfig = await loadConfig(repoRoot)
const bundle = await buildSkillBundle({
  skillRoot,
  outDir: path.join(outDir, "skill-bundle"),
})

console.log(`Starting 172-case evaluation on MiniMax M2.7 with skill: ${bundle.bundlePath}`)
const result = await runSkillOptNativeEval({
  config: {
    ...projectConfig.skillOptDirectChatConfig,
    enabled: true,
    targetAuthFile: "",
    targetAuthProviderID: "",
    targetApiKeyEnv: "AEV_LENGTH_CONTROL_MINIMAX_KEY",
  },
  skillPath: bundle.bundlePath,
  split: "valid_unseen",
  outDir,
})

console.log("\nEvaluation completed successfully!")
console.log(JSON.stringify(result, null, 2))
