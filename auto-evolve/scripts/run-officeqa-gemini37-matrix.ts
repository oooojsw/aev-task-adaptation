import crypto from "node:crypto"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { pathExists } from "../orchestrator/fs"
import { runSkillOptNativeEval } from "../orchestrator/skillopt-native-eval/runner"

const outRoot = "E:/project/SkillOpt-length-cap-runs/officeqa-gemini37flash-medium-manager-20260924"
const mode = process.argv.includes("--smoke") ? "smoke" : process.argv.includes("--full") ? "full" : ""
if (!mode) throw new Error("Choose --smoke or --full")

const selected = process.argv.find((arg) => arg.startsWith("--condition="))?.split("=", 2)[1]
const conditions = [
  {
    id: "no-skill",
    skillPath: "E:/project/SkillOpt-length-cap-runs/officeqa-clean42-native-noskill-minimax27-20260923/empty-skill.md",
  },
  {
    id: "native-opt-a",
    skillPath: "E:/project/SkillOpt-length-cap-runs/officeqa-fair-a-nativeopt-length5768-minimax27-20260922/test-valid-unseen-172/skill-bundle/direct-chat-skill.full.md",
  },
  {
    id: "aev-native-d",
    skillPath: "E:/project/SkillOpt-length-cap-runs/officeqa-clean42-merge-as-old-length5768-minimax27-20260923/test-valid-unseen-172/skill-bundle/direct-chat-skill.full.md",
  },
  {
    id: "aev-opt-c",
    skillPath: "E:/project/SkillOpt-length-cap-runs/officeqa-clean42-opt-length5768-minimax27-20260921/test-valid-unseen-172/skill-bundle/direct-chat-skill.full.md",
  },
]
if (selected && !conditions.some((item) => item.id === selected)) throw new Error(`Unknown condition: ${selected}`)

for (const condition of conditions.filter((item) => !selected || item.id === selected)) {
  const outDir = path.join(outRoot, mode, condition.id)
  const skillSha256 = crypto.createHash("sha256").update(await readFile(condition.skillPath)).digest("hex")
  const launchPath = path.join(outDir, "launch.json")
  if (await pathExists(launchPath)) {
    const previous = JSON.parse(await readFile(launchPath, "utf8")) as Record<string, unknown>
    if (previous.skillSha256 !== skillSha256 || previous.targetModel !== "gemini-3.7-flash-medium" ||
        previous.targetBackend !== "qwen_chat" || previous.targetBaseUrl !== "http://127.0.0.1:8045/v1" ||
        previous.useLocalTools !== false || previous.split !== "valid_unseen") {
      throw new Error(`Existing run has incompatible inputs: ${outDir}`)
    }
  }

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
      targetBackend: "qwen_chat",
      targetModel: "gemini-3.7-flash-medium",
      targetBaseUrl: "http://127.0.0.1:8045/v1",
      targetApiKeyEnv: "",
      targetAuthFile: "",
      targetAuthProviderID: "",
      reasoningEffort: "medium",
      workers: mode === "smoke" ? 1 : 3,
      timeoutMs: mode === "smoke" ? 1_800_000 : 43_200_000,
    },
    skillPath: condition.skillPath,
    split: "valid_unseen",
    caseIDs: mode === "smoke" ? ["UID0003", "UID0010", "UID0013"] : undefined,
    outDir,
    env: {
      QWEN_CHAT_BASE_URL: "http://127.0.0.1:8045/v1",
      QWEN_CHAT_API_KEY: "",
      QWEN_CHAT_ENABLE_THINKING: "false",
      QWEN_CHAT_MAX_TOKENS: "8000",
      QWEN_CHAT_TIMEOUT_SECONDS: "300",
      PYTHONIOENCODING: "utf-8",
      PYTHONDONTWRITEBYTECODE: "1",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      http_proxy: "",
      https_proxy: "",
    },
    runtimeScope: `officeqa:gemini37-manager:${mode}:${condition.id}`,
  })

  const rows = (await readFile(result.nativeResultsPath, "utf8"))
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  const expected = mode === "smoke" ? 3 : 172
  if (rows.length !== expected || new Set(rows.map((row) => row.id)).size !== expected) {
    throw new Error(`${condition.id}: expected ${expected} unique results, got ${rows.length}`)
  }
  if (rows.some((row) => row.use_local_tools !== false)) {
    throw new Error(`${condition.id}: results did not use no-tools protocol`)
  }
  console.log(`${condition.id}: ${result.passed}/${result.total} hard, out=${outDir}`)
}
