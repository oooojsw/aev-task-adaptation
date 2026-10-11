import crypto from "node:crypto"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { pathExists } from "../orchestrator/fs"
import { runSkillOptNativeEval } from "../orchestrator/skillopt-native-eval/runner"

const outRoot = "E:/project/SkillOpt-length-cap-runs/officeqa-kiro-sonnet45-nosearch-20260924"
const mode = process.argv.includes("--smoke") ? "smoke" : process.argv.includes("--full") ? "full" : ""
if (!mode) throw new Error("Choose --smoke or --full")
if (!process.env.KIRO_GATEWAY_API_KEY?.trim()) throw new Error("KIRO_GATEWAY_API_KEY is required")

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
if (selected && !conditions.some((condition) => condition.id === selected)) {
  throw new Error(`Unknown condition: ${selected}`)
}

for (const condition of conditions.filter((item) => !selected || item.id === selected)) {
  const outDir = path.join(outRoot, mode, condition.id)
  const skillSha256 = crypto.createHash("sha256").update(await readFile(condition.skillPath)).digest("hex")
  const launchPath = path.join(outDir, "launch.json")
  if (await pathExists(launchPath)) {
    const previous = JSON.parse(await readFile(launchPath, "utf8")) as Record<string, unknown>
    if (previous.skillSha256 !== skillSha256 || previous.targetModel !== "claude-sonnet-4.5" ||
        previous.targetBaseUrl !== "http://127.0.0.1:19877/v1" || previous.useLocalTools !== false ||
        previous.split !== "valid_unseen") {
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
      targetBackend: "openai_chat",
      targetModel: "claude-sonnet-4.5",
      targetBaseUrl: "http://127.0.0.1:19877/v1",
      targetApiKeyEnv: "KIRO_GATEWAY_API_KEY",
      targetAuthFile: "",
      targetAuthProviderID: "",
      reasoningEffort: "",
      workers: mode === "smoke" ? 1 : 3,
      timeoutMs: mode === "smoke" ? 1_800_000 : 43_200_000,
    },
    skillPath: condition.skillPath,
    split: "valid_unseen",
    caseIDs: mode === "smoke" ? ["UID0003", "UID0010", "UID0013"] : undefined,
    outDir,
    env: {
      AZURE_OPENAI_ENDPOINT: "http://127.0.0.1:19877/v1",
      AZURE_OPENAI_API_KEY: process.env.KIRO_GATEWAY_API_KEY,
      AZURE_OPENAI_AUTH_MODE: "openai_compatible",
      TARGET_AZURE_OPENAI_ENDPOINT: "http://127.0.0.1:19877/v1",
      TARGET_AZURE_OPENAI_API_KEY: process.env.KIRO_GATEWAY_API_KEY,
      TARGET_AZURE_OPENAI_AUTH_MODE: "openai_compatible",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      http_proxy: "",
      https_proxy: "",
    },
    runtimeScope: `officeqa:kiro-sonnet45-nosearch:${mode}:${condition.id}`,
  })

  const rows = (await readFile(result.nativeResultsPath, "utf8"))
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  const expected = mode === "smoke" ? 3 : 172
  if (rows.length !== expected || new Set(rows.map((row) => row.id)).size !== expected) {
    throw new Error(`${condition.id}: expected ${expected} unique results, got ${rows.length}`)
  }
  const contaminated = rows.filter((row) => String(row.response ?? "").includes("<web_search>"))
  if (contaminated.length) {
    throw new Error(`${condition.id}: web_search appeared in ${contaminated.length} no-tool result(s)`)
  }
  console.log(`${condition.id}: ${result.passed}/${result.total} hard, web_search=0, out=${outDir}`)
}
