import { createHash } from "node:crypto"
import path from "node:path"
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from "node:fs"
import { copyFile, mkdir, readFile } from "node:fs/promises"
import { loadConfig } from "../orchestrator/schema"
import { buildSkillBundle } from "../orchestrator/direct-chat/skill-bundler"
import { runSkillOptNativeEval } from "../orchestrator/skillopt-native-eval/runner"
import { writeJsonFile } from "../orchestrator/fs"

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..")
const SKILLOPT_ROOT = "E:/project/SkillOpt-length-cap"
const REFERENCE_C_ROOT = "E:/project/SkillOpt-length-cap-runs/officeqa-clean42-opt-length5768-minimax27-20260921"
const RUN_ROOT = "E:/project/SkillOpt-length-cap-runs/officeqa-fair-a-nativeopt-length5768-minimax27-20260922"
const TRAIN_ROOT = path.join(RUN_ROOT, "native-train")
const SPLIT_ROOT = path.join(SKILLOPT_ROOT, "data", "officeqa_id_split")
const INITIAL_SKILL = path.join(SKILLOPT_ROOT, "skillopt", "envs", "officeqa", "skills", "initial.md")
const CAP_BYTES = 5768

function sha256(content: Buffer | string) {
  return createHash("sha256").update(content).digest("hex")
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T
}

function splitIDs(name: "train" | "val" | "test") {
  const rows = readJson<Array<{ id?: string; uid?: string }>>(path.join(SPLIT_ROOT, name, "items.json"))
  const ids = rows.map((row) => String(row.id ?? row.uid ?? "").trim()).filter(Boolean)
  if (ids.length !== new Set(ids).size) throw new Error(`${name} split contains duplicate IDs`)
  return ids
}

async function updateState(status: string, extra: Record<string, unknown> = {}) {
  await writeJsonFile(path.join(RUN_ROOT, "state.json"), {
    schema: "auto-evolve/officeqa-fair-a-controller/v1",
    updatedAt: new Date().toISOString(),
    controllerPID: process.pid,
    status,
    runRoot: RUN_ROOT,
    ...extra,
  })
}

async function runLogged(command: string[], cwd: string, stdoutPath: string, stderrPath: string, env: Record<string, string | undefined>) {
  const stdout = openSync(stdoutPath, "a")
  const stderr = openSync(stderrPath, "a")
  try {
    const child = Bun.spawn(command, { cwd, env, stdout, stderr, windowsHide: true })
    await updateState("running", { childPID: child.pid, command: command.map((item, index) => index === 0 ? item : path.basename(item)) })
    const exitCode = await child.exited
    if (exitCode !== 0) throw new Error(`Child process failed with exit code ${exitCode}: ${command[0]}`)
  } finally {
    closeSync(stdout)
    closeSync(stderr)
  }
}

async function main() {
  mkdirSync(RUN_ROOT, { recursive: true })
  const resume = process.argv.includes("--resume")
  const existing = readdirSync(RUN_ROOT).filter((name) => !["controller.log", "controller.stderr.log"].includes(name))
  if (existing.length && !resume) throw new Error(`Refusing to overwrite an existing fair-A run: ${RUN_ROOT}`)
  if (resume && (!existsSync(path.join(TRAIN_ROOT, "runtime_state.json")) || !existsSync(path.join(RUN_ROOT, "experiment-manifest.json")))) {
    throw new Error(`Fair-A resume requires the existing manifest and runtime checkpoint: ${RUN_ROOT}`)
  }
  const key = process.env.AEV_LENGTH_CONTROL_MINIMAX_KEY?.trim()
  if (!key) throw new Error("AEV_LENGTH_CONTROL_MINIMAX_KEY is missing")

  const trainIDs = splitIDs("train")
  const valIDs = splitIDs("val")
  const testIDs = splitIDs("test")
  const trainTestOverlap = trainIDs.filter((id) => new Set(testIDs).has(id))
  const valTestOverlap = valIDs.filter((id) => new Set(testIDs).has(id))
  if (trainIDs.length !== 50 || valIDs.length !== 24 || testIDs.length !== 172 || trainTestOverlap.length || valTestOverlap.length) {
    throw new Error(`Split audit failed: train=${trainIDs.length}, val=${valIDs.length}, test=${testIDs.length}, overlaps=${trainTestOverlap.length}/${valTestOverlap.length}`)
  }

  const initial = readFileSync(INITIAL_SKILL)
  if (initial.byteLength > CAP_BYTES) throw new Error(`Native initial Skill exceeds ${CAP_BYTES} bytes`)
  const configPath = path.join(RUN_ROOT, "fair-a-config.json")
  if (!resume) {
    const reference = readJson<{ config: Record<string, unknown> }>(path.join(REFERENCE_C_ROOT, "native-train", "summary.json"))
    const config = {
      ...reference.config,
      skill_init: INITIAL_SKILL,
      out_root: TRAIN_ROOT,
      eval_test: false,
      train_size: 50,
      num_epochs: 4,
      batch_size: 40,
      max_steps: 0,
      workers: 3,
      max_api_workers: 3,
      skill_max_bytes: CAP_BYTES,
      skill_length_repair_attempts: 5,
      slow_update_gate_with_selection: true,
    }
    delete config.steps_per_epoch
    delete config.batches_per_epoch
    delete config.samples_per_epoch
    delete config.skill_length_policy
    await writeJsonFile(configPath, config)
    await writeJsonFile(path.join(RUN_ROOT, "experiment-manifest.json"), {
      schema: "auto-evolve/officeqa-fair-a/v1",
      createdAt: new Date().toISOString(),
      purpose: "Strict fair native-Opt baseline for comparison with AEV warm-start plus Opt.",
      condition: "A_native_initial_plus_opt",
      optimizerModel: "MiniMax-M2.7",
      targetModel: "MiniMax-M2.7",
      split: { train: 50, val: 24, test: 172, trainTestOverlap: 0, valTestOverlap: 0 },
      budget: { epochs: 4, steps: 8, batchSize: 40, workers: 3, maxToolTurns: 24 },
      lengthGate: { unit: "utf8_bytes", maxBytes: CAP_BYTES, repairAttempts: 5 },
      acceptance: { useGate: true, slowUpdateGateWithSelection: true },
      initialSkill: { path: INITIAL_SKILL, bytes: initial.byteLength, sha256: sha256(initial) },
      referenceCConfig: path.join(REFERENCE_C_ROOT, "native-train", "summary.json"),
      finalEvaluation: "valid_unseen 172, SkillOpt native single-turn no-tools",
    })
  } else {
    const config = readJson<Record<string, unknown>>(configPath)
    // 恢复时拒绝口径漂移，只允许沿用原Run。
    if (config.skill_init !== INITIAL_SKILL || config.out_root !== TRAIN_ROOT || config.train_size !== 50 || config.skill_max_bytes !== CAP_BYTES || config.slow_update_gate_with_selection !== true) {
      throw new Error("Existing fair-A config no longer matches the frozen resume protocol")
    }
  }

  // 首次运行真请求预检；恢复沿用已成功的同Run凭据证据。
  if (!resume) {
    await updateState("preflight", { resume })
    await runLogged(
      ["python", path.join(REPO_ROOT, "auto-evolve", "scripts", "preflight-minimax-length-control.py")],
      REPO_ROOT,
      path.join(RUN_ROOT, "preflight.stdout.log"),
      path.join(RUN_ROOT, "preflight.stderr.log"),
      { ...process.env, AEV_LENGTH_CONTROL_SKILLOPT_ROOT: SKILLOPT_ROOT, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    )
  }

  // A只替换原生起点，其他训练口径复用C。
  mkdirSync(TRAIN_ROOT, { recursive: true })
  await updateState("training")
  await runLogged(
    ["python", path.join(SKILLOPT_ROOT, "scripts", "train.py"), "--config", configPath],
    SKILLOPT_ROOT,
    path.join(RUN_ROOT, "training.stdout.log"),
    path.join(RUN_ROOT, "training.stderr.log"),
    { ...process.env, MINIMAX_API_KEY: key, MINIMAX_BASE_URL: "https://api.minimaxi.com/anthropic/v1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
  )

  const summaryPath = path.join(TRAIN_ROOT, "summary.json")
  const bestSkill = path.join(TRAIN_ROOT, "best_skill.md")
  if (!existsSync(summaryPath) || !existsSync(bestSkill)) throw new Error("Training completed without summary.json or best_skill.md")
  const best = readFileSync(bestSkill)
  if (best.byteLength > CAP_BYTES) throw new Error(`Frozen best Skill exceeds ${CAP_BYTES} bytes: ${best.byteLength}`)

  const outDir = path.join(RUN_ROOT, "test-valid-unseen-172")
  const skillRoot = path.join(outDir, "final-skill-input")
  await mkdir(skillRoot, { recursive: true })
  await copyFile(bestSkill, path.join(skillRoot, "CORE.md"))
  const projectConfig = await loadConfig(REPO_ROOT)
  const bundle = await buildSkillBundle({ skillRoot, outDir: path.join(outDir, "skill-bundle") })
  // 最终测试只读取冻结最佳版，测试集不参与选优。
  await updateState("testing", { bestSkillBytes: best.byteLength, bestSkillSha256: sha256(best) })
  const result = await runSkillOptNativeEval({
    config: {
      ...projectConfig.skillOptDirectChatConfig,
      enabled: true,
      targetAuthFile: "",
      targetAuthProviderID: "",
      targetApiKeyEnv: "AEV_LENGTH_CONTROL_MINIMAX_KEY",
      workers: 3,
    },
    skillPath: bundle.bundlePath,
    split: "valid_unseen",
    outDir,
  })
  await updateState("complete", { result })
  await writeJsonFile(path.join(RUN_ROOT, "completion.json"), { completedAt: new Date().toISOString(), result })
}

try {
  await main()
} catch (error) {
  mkdirSync(RUN_ROOT, { recursive: true })
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  await updateState("failed", { error: message })
  throw error
}
