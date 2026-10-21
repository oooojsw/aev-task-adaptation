import path from "node:path"
import { mkdir, open, readFile, lstat } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import type { OpencodeTaskInput, OpencodeTaskRun } from "../opencode"
import { writeJsonAtomic } from "../atomic-write"
import { fingerprint } from "./identity"
import { backendUsage } from "./backend-usage"
import { authorizeInvocation, type Invocation } from "../task-adaptation/invocation"
import { completion } from "../opencode-completion"

export class ProtocolTrainingIncompleteError extends Error {
  readonly code = "protocol_training_incomplete"
}

export async function runProtocolTrainingTask(options: { enabled: boolean; stageDir: string; role: string; adaptation?: Invocation },
  request: OpencodeTaskInput, invoke: (request: OpencodeTaskInput) => Promise<OpencodeTaskRun>): Promise<OpencodeTaskRun> {
  if (!options.enabled) {
    if (options.adaptation) throw new Error("Task adaptation requires protocol training boundary")
    return invoke(request)
  }
  const adapted = options.adaptation ? await authorizeInvocation(options.adaptation, request) : undefined
  if (adapted) {
    if (options.role !== options.adaptation!.role) throw new Error("Adapted training role mismatch")
    request = adapted.request
  }
  // 新训练与独立执行使用同一冻结源码宿主，旧入口保持不变。
  const external = new Set<string>()
  for (const file of [...request.permissionReadPaths ?? [], ...request.permissionEditPaths ?? []]) {
    const info = await lstat(file).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      return null
    })
    external.add(info?.isDirectory() ? file : path.dirname(file))
  }
  request = { ...request, sourceHost: true, permissionExternalPaths: [...external] }
  const dir = path.join(options.stageDir, "protocol-invocations", randomUUID())
  await mkdir(dir, { recursive: true })
  if (request.localSearch) request = { ...request, localSearchEvidenceRoot: path.join(dir, "local-search") }
  if (request.recompute) request = { ...request, recomputeEvidenceRoot: path.join(dir, "recompute") }
  if (request.resourceReaderGrant) request = { ...request, resourceReaderEvidenceRoot: path.join(dir, "resource-reader") }
  // 同阶段可有多次正常修订，每次留独立账，恢复仍由控制器决定。
  const claim = await open(path.join(dir, "started.claim"), "wx")
  await claim.close()
  const startedAt = new Date().toISOString()
  const clock = performance.now()
  const requestFingerprint = fingerprint({ role: options.role, title: request.title, prompt: request.prompt,
    model: request.model ?? null, variant: request.variant ?? null, runtimeBudget: request.runtimeBudget ?? null, sourceHost: true,
    ...(request.requestBudget ? { requestBudget: request.requestBudget } : {}),
    ...(request.localSearch ? { localSearch: request.localSearch } : {}),
    ...(request.recompute ? { recompute: request.recompute } : {}),
    ...(request.resourceReaderGrant ? { resourceReader: { resourceID: request.resourceReaderGrant.resourceID, sessionID: request.resourceReaderGrant.sessionID } } : {}),
    references: request.referencePaths ?? [], reads: request.permissionReadPaths ?? [], edits: request.permissionEditPaths ?? [],
    ...(adapted ? { taskWindow: adapted.scope, allowShell: request.allowShell, isolateHostRuntime: request.isolateHostRuntime,
      infrastructureAttempts: request.infrastructureAttempts, permissionMode: request.config.permissionConfig.mode } : {}) })
  const identity = { schema: "aev.training-invocation-accounting.v1", role: options.role, requestFingerprint,
    requestedModel: request.model ?? null, gate: request.requestBudget?.gate ?? null,
    startedAt, reused: false, fee: null }
  await writeJsonAtomic(path.join(dir, "started.json"), identity)
  if (adapted) await writeJsonAtomic(path.join(dir, "task-window.json"), adapted.scope)
  const persist = async (fields: Record<string, unknown>) => writeJsonAtomic(path.join(dir, "accounting.json"), {
    ...identity, finishedAt: new Date().toISOString(), elapsedMs: Math.max(0, Math.round(performance.now() - clock)), ...fields,
  })
  let recorded = false
  try {
    const task = await invoke(request)
    const raw = path.join(dir, "task-result.json")
    await writeJsonAtomic(raw, task)
    const reported = backendUsage(task.result.events)
    const ending = task.result.finishReason ?? completion(task.result.events).reason
    const incomplete = task.result.exitCode !== 0 || (ending !== undefined && ending !== "stop")
    const resolved = task.result.modelResolution
    await persist({ status: incomplete ? "incomplete" : "completed", exitCode: task.result.exitCode, finishReason: ending ?? null,
      actualModel: resolved ? `${resolved.providerID}/${resolved.modelID}` : null,
      inputTokens: reported.inputTokens, outputTokens: reported.outputTokens, steps: reported.steps,
      usageSource: reported.steps.length ? "step_finish" : "missing",
      rawResultSha256: createHash("sha256").update(await readFile(raw)).digest("hex"),
      errorKind: incomplete ? "backend_incomplete" : null })
    recorded = true
    // 超时或截断不是普通答错；禁止解析残片后自动重规划烧额度。
    if (incomplete) throw new ProtocolTrainingIncompleteError(`Protocol training ${options.role} incomplete; inspect saved task-result.json before retry (exit=${task.result.exitCode}, finish=${ending ?? "unknown"})`)
    return task
  } catch (error) {
    // 账本不复制上游异常原文，防止错误信息携带凭证。
    if (!recorded) await persist({ status: "infrastructure_error", actualModel: null, inputTokens: null, outputTokens: null,
      steps: [], usageSource: "missing", errorKind: "backend_or_persistence_error" })
    throw error
  }
}
