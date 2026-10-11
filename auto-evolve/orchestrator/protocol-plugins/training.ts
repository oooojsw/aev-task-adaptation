import path from "node:path"
import { mkdir, open, readFile, access, realpath } from "node:fs/promises"
import { canonical, immutable } from "./identity"
import { writeJsonAtomic } from "../atomic-write"
import { opencodeDriver } from "./opencode-driver"
import type { LongTaskBudgets, LongTaskSpec } from "../long-task/contract"
import type { AutoEvolveConfig, ExecutionSpec } from "../schema"
import type { OpencodeRuntimeBudget } from "../opencode"

export const TRAINING_ROLES = ["planner", "executor", "worker", "lead", "reviewer", "diagnostician"] as const
export type TrainingRole = typeof TRAINING_ROLES[number]
export interface TrainingConfig {
  schema: "aev.protocol-training.v1"
  roles: Record<TrainingRole, { model: string; agent?: string; variant?: string; timeoutMs: number }>
  budgets: LongTaskBudgets
}

export function validateTraining(value: unknown): TrainingConfig {
  const cfg = structuredClone(value) as TrainingConfig
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) || cfg.schema !== "aev.protocol-training.v1" ||
      Object.keys(cfg).some((key) => !["schema", "roles", "budgets"].includes(key)) ||
      !cfg.roles || typeof cfg.roles !== "object" || Array.isArray(cfg.roles) ||
      Object.keys(cfg.roles).some((key) => !TRAINING_ROLES.includes(key as TrainingRole))) throw new Error("Invalid explicit training config")
  for (const role of TRAINING_ROLES) {
    const item = cfg.roles[role]
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["model", "agent", "variant", "timeoutMs"].includes(key)) ||
        typeof item.model !== "string" || !item.model.trim() || /agt_codex_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}/.test(item.model) ||
        !Number.isSafeInteger(item.timeoutMs) || item.timeoutMs < 1 || item.timeoutMs > 43_200_000 ||
        [item.agent, item.variant].some((value) => value !== undefined && (typeof value !== "string" || !value.trim()))) throw new Error(`Explicit training role required: ${role}`)
  }
  const keys = ["maxAttemptsPerUnit", "maxTotalUnitAttempts", "maxGraphReplans", "maxValidatorCalls", "maxNoProgressCycles", "maxUnitsPerGraph"]
  if (!cfg.budgets || typeof cfg.budgets !== "object" || Array.isArray(cfg.budgets) || Object.keys(cfg.budgets).some((key) => !keys.includes(key)) ||
      keys.some((key) => { const n = cfg.budgets[key as keyof LongTaskBudgets]; return !Number.isSafeInteger(n) || n < (key === "maxGraphReplans" ? 0 : 1) })) throw new Error("Explicit complete training work budgets required")
  return immutable(cfg)
}

export function trainingExecution(spec: LongTaskSpec, role: TrainingRole, fallback?: ExecutionSpec): ExecutionSpec | undefined {
  if (!spec.protocolTraining) return fallback
  const { timeoutMs: _, ...selection } = validateTraining(spec.protocolTraining).roles[role]
  return selection
}

export function trainingRuntimeBudget(spec: LongTaskSpec, role: TrainingRole): OpencodeRuntimeBudget | undefined {
  if (!spec.protocolTraining) return undefined
  const timeout = validateTraining(spec.protocolTraining).roles[role].timeoutMs
  return { profile: "long", softDeadlineMs: timeout, hardTimeoutMs: timeout, silentTimeoutMs: timeout, silentTimeoutAfterActivityMs: timeout }
}

export async function freezeTraining(root: string, config: TrainingConfig | undefined, cwd: string,
  createDriver: typeof opencodeDriver = opencodeDriver) {
  if (![root, cwd].every((value) => typeof value === "string" && path.isAbsolute(value))) throw new Error("Absolute training roots required")
  const dir = path.join(root, "protocol-training")
  if (!config) {
    try { await access(dir) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
    throw new Error("Training config removed from existing run")
  }
  const training = validateTraining(config)
  await mkdir(dir, { recursive: true })
  if (await realpath(dir) !== path.resolve(dir)) throw new Error("Training snapshot root link rejected")
  const driver = await createDriver({ cwd, evidenceRoot: path.join(dir, "host") })
  await driver.preflight()
  const body = { schema: "aev.training-snapshot.v1", training, host: driver.implementation }
  const file = path.join(dir, "training.snapshot.json")
  try { const claim = await open(path.join(dir, "training.started.claim"), "wx"); await claim.close() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const saved = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))
    if (canonical(saved) !== canonical(body)) throw new Error("Training model/budget/host drift")
    return dir
  }
  // 训练配置与宿主一起冻结，恢复不能悄悄使用新默认模型。
  try { await access(file); throw new Error("Unclaimed training snapshot") }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  await writeJsonAtomic(file, body)
  return dir
}

export async function verifyTraining(spec: LongTaskSpec, cwd: string, config: AutoEvolveConfig,
  createDriver: typeof opencodeDriver = opencodeDriver) {
  if (!spec.protocolTraining) return
  if (!spec.protocolTrainingRoot || !path.isAbsolute(spec.protocolTrainingRoot)) throw new Error("Frozen training context required")
  const saved = JSON.parse((await readFile(path.join(spec.protocolTrainingRoot, "training.snapshot.json"), "utf8")).replace(/^\uFEFF/, ""))
  const driver = await createDriver({ cwd, evidenceRoot: path.join(spec.protocolTrainingRoot, "host"), load: async () => structuredClone(config) })
  await driver.preflight()
  if (canonical(saved) !== canonical({ schema: "aev.training-snapshot.v1", training: validateTraining(spec.protocolTraining), host: driver.implementation })) {
    throw new Error("Training model/budget/host drift before invocation")
  }
}
