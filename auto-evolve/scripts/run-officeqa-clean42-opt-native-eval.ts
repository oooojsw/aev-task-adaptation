import { createHash } from "node:crypto"
import path from "node:path"
import { copyFile, mkdir, readFile } from "node:fs/promises"
import { loadConfig } from "../orchestrator/schema"
import { buildSkillBundle } from "../orchestrator/direct-chat/skill-bundler"
import { runSkillOptNativeEval } from "../orchestrator/skillopt-native-eval/runner"
import { writeJsonFile } from "../orchestrator/fs"

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const runRoot = "E:/project/SkillOpt-length-cap-runs/officeqa-clean42-opt-length5768-minimax27-20260921"
const sourceSkill = path.join(runRoot, "native-train", "best_skill.md")
const outDir = path.join(runRoot, "test-valid-unseen-172")
const skillRoot = path.join(outDir, "final-skill-input")
const targetSkill = path.join(skillRoot, "CORE.md")
const maxBytes = 5768

if (!process.env.AEV_LENGTH_CONTROL_MINIMAX_KEY?.trim()) {
  throw new Error("AEV_LENGTH_CONTROL_MINIMAX_KEY is required for the C final evaluation")
}

const content = await readFile(sourceSkill)
if (content.byteLength > maxBytes) {
  throw new Error(`Final Skill exceeds ${maxBytes} bytes: ${content.byteLength}`)
}

await mkdir(skillRoot, { recursive: true })
await copyFile(sourceSkill, targetSkill)
await writeJsonFile(path.join(outDir, "evaluation-manifest.json"), {
  schema: "auto-evolve/officeqa-clean42-opt-final-eval/v1",
  createdAt: new Date().toISOString(),
  sourceSkill,
  sourceBytes: content.byteLength,
  sourceSha256: createHash("sha256").update(content).digest("hex"),
  split: "valid_unseen",
  expectedCases: 172,
  targetModel: "MiniMax-M2.7",
  mode: "SkillOpt native single-turn no-tools",
})

const projectConfig = await loadConfig(repoRoot)
const bundle = await buildSkillBundle({
  skillRoot,
  outDir: path.join(outDir, "skill-bundle"),
})

// 最终测试只装载冻结最佳 Skill，避免训练中间文件泄漏。
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

console.log(JSON.stringify(result, null, 2))
