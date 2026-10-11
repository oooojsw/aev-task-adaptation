import { spawn } from "node:child_process"
import path from "node:path"
import { mkdir, readFile } from "node:fs/promises"
import { writeJsonFile } from "../orchestrator/fs"

const PROJECT_ROOT = "E:/project/SkillOpt-length-cap"
const B_ROOT = "E:/project/SkillOpt-length-cap-runs/officeqa-clean42-length5768-minimax27-20260921"
const OUT_ROOT = "E:/project/SkillOpt-length-cap-runs/officeqa-clean42-opt-length5768-minimax27-20260921"
const CAP_BYTES = 5768

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true })
    let stdout = "", stderr = ""
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

const preflightOnly = process.argv.includes("--preflight-only")
const bReport = JSON.parse((await readFile(path.join(B_ROOT, "report.json"), "utf8")).replace(/^\uFEFF/, "")) as { mergedSkillDir: string }
const warmStartPath = path.join(bReport.mergedSkillDir, "CORE.md")
const requestPath = path.join(OUT_ROOT, "request.json")
const resultPath = path.join(OUT_ROOT, "result.json")
const nativeOut = path.join(OUT_ROOT, "native-train")

if (!preflightOnly && !process.env.AEV_LENGTH_CONTROL_MINIMAX_KEY?.trim()) {
  throw new Error("AEV_LENGTH_CONTROL_MINIMAX_KEY is required for C training")
}

await mkdir(OUT_ROOT, { recursive: true })
const request = {
  schema: "auto-evolve/skillopt-merge-request/v1",
  skillContent: "",
  failurePatches: [],
  successPatches: [],
  batchSize: 8,
  workers: 1,
  updateMode: "full_rewrite_minibatch",
  metaSkillContext: "C reuses the frozen B warm-start and must not aggregate sources again.",
  skillOptConfigPath: `${PROJECT_ROOT}/configs/officeqa/default.yaml`,
  optimizer: {
    backend: "minimax_chat", model: "MiniMax-M2.7", baseUrl: "https://api.minimaxi.com/anthropic/v1",
    apiKeyEnv: "AEV_LENGTH_CONTROL_MINIMAX_KEY", reasoningEffort: "medium",
  },
  lengthPolicy: { enabled: true, maxBytes: CAP_BYTES, maxRepairAttempts: 5, unit: "utf8_bytes" },
  nativeTrain: {
    enabled: true,
    reuseWarmStartPath: warmStartPath,
    configPath: `${PROJECT_ROOT}/configs/officeqa/default.yaml`,
    splitDir: `${PROJECT_ROOT}/data/officeqa_id_split`,
    dataDirs: ["E:/project/experiment/datasets/OfficeQA_corpus/treasury_bulletins_parsed", "C:/Users/ZhuanZ/Desktop/SkillOpt/data/officeqa_docs_pdf_text_fallback"],
    outRoot: nativeOut,
    epochs: 4,
    batchSize: 40,
    maxSteps: 0,
    evalTest: false,
    targetWorkers: 3,
    targetBackend: "minimax_chat",
    targetModel: "MiniMax-M2.7",
    targetBaseUrl: "https://api.minimaxi.com/anthropic/v1",
    targetApiKeyEnv: "AEV_LENGTH_CONTROL_MINIMAX_KEY",
    slowUpdateGateWithSelection: true,
  },
}

await writeJsonFile(path.join(OUT_ROOT, "experiment-manifest.json"), {
  schema: "auto-evolve/officeqa-clean42-opt-c/v1", createdAt: new Date().toISOString(), purpose: "C: continue native Opt from the frozen B Skill without repeating aggregation.",
  parentBRoot: B_ROOT, warmStartPath, sourceCount: 42, sourceTestOverlap: 0, capBytes: CAP_BYTES,
  optimizerModel: "MiniMax-M2.7", targetModel: "MiniMax-M2.7", trainSize: 50, validationSize: 24, testSize: 172,
  epochs: 4, batchSize: 40, targetWorkers: 3, slowUpdateGateWithSelection: true, evalTestDuringTraining: false,
})
await writeJsonFile(requestPath, request)
const result = await run(
  "C:/Users/ZhuanZ/AppData/Local/Programs/Python/Python313/python.exe",
  ["C:/Users/ZhuanZ/Desktop/opencode re/opencode latest/auto-evolve/scripts/skillopt-merge-bridge.py", "--skillopt-root", PROJECT_ROOT, "--request", requestPath, "--result", resultPath, ...(preflightOnly ? ["--preflight-only"] : [])],
  PROJECT_ROOT,
  process.env,
)
await writeJsonFile(path.join(OUT_ROOT, preflightOnly ? "preflight.json" : "process-result.json"), result)
if (result.code !== 0) throw new Error(`Clean42 C bridge failed: ${result.stderr.slice(-2000)}`)
console.log(result.stdout)
