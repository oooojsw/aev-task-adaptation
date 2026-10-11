import path from "node:path"
import { mkdir, open, readFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import type { OpencodeTaskInput, OpencodeTaskRun } from "../opencode"
import { writeJsonAtomic } from "../atomic-write"
import { fingerprint } from "./identity"
import { backendUsage } from "./backend-usage"

export async function runProtocolTrainingTask(options: { enabled: boolean; stageDir: string; role: string },
  request: OpencodeTaskInput, invoke: (request: OpencodeTaskInput) => Promise<OpencodeTaskRun>): Promise<OpencodeTaskRun> {
  if (!options.enabled) return invoke(request)
  const dir = path.join(options.stageDir, "protocol-invocations", randomUUID())
  await mkdir(dir, { recursive: true })
  // 同阶段可有多次正常修订，每次留独立账，恢复仍由控制器决定。
  const claim = await open(path.join(dir, "started.claim"), "wx")
  await claim.close()
  const startedAt = new Date().toISOString()
  const clock = performance.now()
  const requestFingerprint = fingerprint({ role: options.role, title: request.title, prompt: request.prompt,
    model: request.model ?? null, variant: request.variant ?? null, runtimeBudget: request.runtimeBudget ?? null,
    references: request.referencePaths ?? [], reads: request.permissionReadPaths ?? [], edits: request.permissionEditPaths ?? [] })
  const identity = { schema: "aev.training-invocation-accounting.v1", role: options.role, requestFingerprint,
    requestedModel: request.model ?? null, startedAt, reused: false, fee: null }
  await writeJsonAtomic(path.join(dir, "started.json"), identity)
  const persist = async (fields: Record<string, unknown>) => writeJsonAtomic(path.join(dir, "accounting.json"), {
    ...identity, finishedAt: new Date().toISOString(), elapsedMs: Math.max(0, Math.round(performance.now() - clock)), ...fields,
  })
  try {
    const task = await invoke(request)
    const raw = path.join(dir, "task-result.json")
    await writeJsonAtomic(raw, task)
    const reported = backendUsage(task.result.events)
    const resolved = task.result.modelResolution
    await persist({ status: task.result.exitCode === 0 ? "completed" : "incomplete", exitCode: task.result.exitCode,
      actualModel: resolved ? `${resolved.providerID}/${resolved.modelID}` : null,
      inputTokens: reported.inputTokens, outputTokens: reported.outputTokens, steps: reported.steps,
      usageSource: reported.steps.length ? "step_finish" : "missing",
      rawResultSha256: createHash("sha256").update(await readFile(raw)).digest("hex"),
      errorKind: task.result.exitCode === 0 ? null : "backend_incomplete" })
    return task
  } catch (error) {
    // 账本不复制上游异常原文，防止错误信息携带凭证。
    await persist({ status: "infrastructure_error", actualModel: null, inputTokens: null, outputTokens: null,
      steps: [], usageSource: "missing", errorKind: "backend_or_persistence_error" })
    throw error
  }
}
