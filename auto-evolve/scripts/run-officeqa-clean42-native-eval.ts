import path from "node:path"
import { loadConfig } from "../orchestrator/schema"
import { buildSkillBundle } from "../orchestrator/direct-chat/skill-bundler"
import { runSkillOptNativeEval } from "../orchestrator/skillopt-native-eval/runner"

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const outRoot = "E:/project/SkillOpt-length-cap-runs/officeqa-clean42-length5768-minimax27-20260921"
const skillRoot = `${outRoot}/output-faa3bdba-6541-4aee-966f-bf2cc783fa92`

if (!process.env.AEV_LENGTH_CONTROL_MINIMAX_KEY?.trim()) {
  throw new Error("AEV_LENGTH_CONTROL_MINIMAX_KEY is required for the clean42 evaluation")
}

const projectConfig = await loadConfig(repoRoot)
const outDir = path.join(outRoot, "test-valid-unseen-172")
const bundle = await buildSkillBundle({ skillRoot, outDir: path.join(outDir, "skill-bundle") })

// 测试与本轮合并共用同一显式密钥，防止旧账号快照混入结果。
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
