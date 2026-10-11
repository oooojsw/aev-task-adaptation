import path from "node:path"
import { runSkillOptNativeEval } from "../orchestrator/skillopt-native-eval/runner"

const experimentRoot = "E:/project/SkillOpt-length-cap-runs/officeqa-clean42-opt-length5768-minimax27-20260921"
const skillPath = path.join(experimentRoot, "test-valid-unseen-172", "skill-bundle", "direct-chat-skill.full.md")
const smoke = process.argv.includes("--smoke")
const outDir = path.join(
  experimentRoot,
  "consumer-evals",
  smoke ? "kiro-claude-sonnet45-smoke" : "kiro-claude-sonnet45-valid-unseen-172",
)

if (!process.env.KIRO_GATEWAY_API_KEY?.trim()) {
  throw new Error("KIRO_GATEWAY_API_KEY is required")
}

// 只替换消费者，冻结 Skill、数据和评测器口径。
const result = await runSkillOptNativeEval({
  config: {
    enabled: true,
    projectRoot: "C:/Users/ZhuanZ/Desktop/SkillOpt",
    configPath: "configs/officeqa/default.yaml",
    splitDir: "data/officeqa_id_split",
    dataDirs: [
      "E:/project/experiment/datasets/OfficeQA_corpus/treasury_bulletins_parsed",
      "C:/Users/ZhuanZ/Desktop/SkillOpt/data/officeqa_docs_pdf_text_fallback",
    ],
    pythonCommand: "C:/Users/ZhuanZ/AppData/Local/Programs/Python/Python313/python.exe",
    targetBackend: "openai_chat",
    targetModel: "claude-sonnet-4.5",
    targetBaseUrl: "http://127.0.0.1:19876/v1",
    targetApiKeyEnv: "KIRO_GATEWAY_API_KEY",
    targetAuthFile: "",
    targetAuthProviderID: "",
    reasoningEffort: "",
    workers: smoke ? 1 : 3,
    timeoutMs: smoke ? 900_000 : 43_200_000,
  },
  skillPath,
  outDir,
  split: "valid_unseen",
  caseIDs: smoke ? ["UID0003"] : undefined,
  env: {
    AZURE_OPENAI_ENDPOINT: "http://127.0.0.1:19876/v1",
    AZURE_OPENAI_API_KEY: process.env.KIRO_GATEWAY_API_KEY,
    AZURE_OPENAI_AUTH_MODE: "openai_compatible",
    TARGET_AZURE_OPENAI_ENDPOINT: "http://127.0.0.1:19876/v1",
    TARGET_AZURE_OPENAI_API_KEY: process.env.KIRO_GATEWAY_API_KEY,
    TARGET_AZURE_OPENAI_AUTH_MODE: "openai_compatible",
  },
  runtimeScope: smoke ? "officeqa:kiro-sonnet45:smoke" : "officeqa:kiro-sonnet45:test172",
})

console.log(JSON.stringify(result, null, 2))
