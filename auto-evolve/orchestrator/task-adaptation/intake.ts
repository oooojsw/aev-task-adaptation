import path from "node:path"
import { readFile, mkdir, open, realpath, access, lstat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { writeJsonAtomic, writeFileAtomic } from "../atomic-write"
import { opencodeDriver } from "../protocol-plugins/opencode-driver"
import type { InvokeTool } from "../protocol-plugins/tool-session"
import { canonical, fingerprint } from "../protocol-plugins/identity"
import { compileTask, interpretationPrompt, validateCatalogue, type TaskCatalogue, type Decision } from "./catalogue"
import { resolveResource } from "./binding"
import { approvePresetPlan } from "./approved-plan"

interface Driver { implementation: string; preflight(): Promise<void>; invoke: InvokeTool }
export interface IntakeCommon {
  cwd: string
  root: string
  dir: string
  catalogue: TaskCatalogue
}

// auto 延续原来的必填协议，兼容现有任务配置和模型调用回执。
export type AutoIntakeInput = IntakeCommon & {
  mode?: "auto"
  requestBudget?: import("./budget-transport").BudgetTransportConfig
  model: string
  expectedModel: string
  timeoutMs: number
  maxInputBytes: number
  maxDecisionBytes: number
  maxDecisionRepairs?: number
  decision?: never
  decisionPath?: never
  planPath?: never
}

export type ManualDecisionInput = IntakeCommon & {
  mode: "manual_decision"
  decision?: Decision
  decisionPath?: string
  maxDecisionBytes?: number
  requestBudget?: never
  planPath?: never
}

export type ManualPlanInput = IntakeCommon & {
  mode: "manual_plan"
  planPath: string
  requestBudget?: never
  decision?: never
  decisionPath?: never
}

export type IntakeInput = AutoIntakeInput | ManualDecisionInput | ManualPlanInput

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const json = (bytes: Buffer) => JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""))

async function prepareTaskAuto(input: AutoIntakeInput, dependencies?: { createDriver: (options: { cwd: string; evidenceRoot: string }) => Promise<Driver> }) {
  if (![input.cwd, input.root, input.dir].every(file => typeof file === "string" && path.isAbsolute(file)) ||
    ![input.model, input.expectedModel].every(text => typeof text === "string" && text.trim()) ||
    ![input.timeoutMs, input.maxInputBytes, input.maxDecisionBytes].every(number => Number.isSafeInteger(number) && number > 0) ||
    input.timeoutMs > 43200000 || input.maxDecisionBytes > 1048576 ||
    input.maxDecisionRepairs !== undefined && (!Number.isSafeInteger(input.maxDecisionRepairs) || input.maxDecisionRepairs < 0 || input.maxDecisionRepairs > 2)) throw new Error("Explicit bounded task intake required")
  const catalogue = validateCatalogue(input.catalogue)
  const root = await realpath(input.root)
  if (root.toLowerCase() !== path.resolve(input.root).toLowerCase()) throw new Error("Linked intake material root rejected")
  const relative = path.relative(root, input.dir)
  if (!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new Error("Intake output must be outside task materials")
  const resources = async () => Promise.all(catalogue.resources.map(async item => {
    const file = await resolveResource(root, item.path)
    const bytes = await readFile(file)
    return { id: item.id, path: file.replaceAll("\\", "/"), bytes: bytes.length, sha256: hash(bytes) }
  }))
  const files = await resources()
  await mkdir(input.dir, { recursive: true })
  const dir = await realpath(input.dir)
  if (dir.toLowerCase() !== path.resolve(input.dir).toLowerCase()) throw new Error("Linked intake output root rejected")
  const workspace = path.join(dir, "workspace")
  await mkdir(workspace, { recursive: true })
  if ((await realpath(workspace)).toLowerCase() !== path.resolve(workspace).toLowerCase()) throw new Error("Linked intake workspace rejected")
  const output = path.join(workspace, "decision.json")
  const reads = files.filter(file => catalogue.resources.find(item => item.id === file.id)!.audience !== "private")
  const prompt = interpretationPrompt(catalogue, output.replaceAll("\\", "/"), reads)
  if (Buffer.byteLength(prompt) + reads.reduce((sum, file) => sum + file.bytes, 0) > input.maxInputBytes) throw new Error("Task intake input byte budget exceeded")
  const driver = await (dependencies?.createDriver ?? opencodeDriver)({ cwd: input.cwd, evidenceRoot: path.join(dir, "backend") })
  if (!/^[a-f0-9]{64}$/.test(driver.implementation)) throw new Error("Frozen intake backend identity required")
  await driver.preflight()
  const source = await Promise.all(["./intake.ts", "./catalogue.ts", "./plan.ts", "./binding.ts"].map(async file => hash(await readFile(fileURLToPath(new URL(file, import.meta.url))))))
  const binding = fingerprint({ catalogue, root, files, cwd: input.cwd, backend: driver.implementation, source,
    model: input.model, expectedModel: input.expectedModel, timeoutMs: input.timeoutMs,
    maxInputBytes: input.maxInputBytes, maxDecisionBytes: input.maxDecisionBytes, prompt,
    ...(input.maxDecisionRepairs !== undefined ? { maxDecisionRepairs: input.maxDecisionRepairs } : {}),
    ...(input.requestBudget ? { requestBudget: input.requestBudget } : {}) })
  const snapshot = path.join(dir, "intake.snapshot.json")
  const completed = path.join(dir, "intake.completed.json")
  const result = path.join(dir, "intake.result.json")
  const plan = path.join(dir, "task-plan.json")
  let fresh = true
  try { const claim = await open(path.join(dir, "intake.started.claim"), "wx"); await claim.close() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    fresh = false
    if (json(await readFile(await resolveResource(dir, "intake.snapshot.json"))).binding !== binding) throw new Error("Task intake identity drift")
  }
  if (!fresh) {
    // 半完成或失败调用必须核查，不让断点恢复变成重复计费。
    try { await access(path.join(dir, "intake.failure.json")); throw new Error("Task intake failed; inspect before recovery") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    const saved = json(await readFile(await resolveResource(dir, "intake.completed.json")))
    const receipt = json(await readFile(await resolveResource(dir, "intake.backend-result.json")))
    const decision = await readFile(await resolveResource(dir, "workspace/decision.json"))
    const value = compileTask(catalogue, json(decision) as Decision)
    if (saved.binding !== binding || saved.backend !== fingerprint(receipt) || !receipt.completed || receipt.actualModel !== input.expectedModel ||
      saved.decisionSHA256 !== hash(decision) || saved.result !== fingerprint(value) ||
      canonical(json(await readFile(await resolveResource(dir, "intake.result.json")))) !== canonical(value) ||
      (value.status === "ready" && saved.planSHA256 !== hash(await readFile(await resolveResource(dir, "task-plan.json"))))) throw new Error("Completed task intake evidence drift")
    return { ...value, dir, ...(value.status === "ready" ? { planPath: plan } : {}), reused: true }
  }
  for (const file of [snapshot, completed, result, plan, output, path.join(dir, "intake.backend-result.json"), path.join(dir, "intake.failure.json")]) {
    try { await access(file); throw new Error("Unclaimed task intake evidence exists") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  await writeJsonAtomic(snapshot, { schema: "aev.task-intake-snapshot.v1", binding, backend: driver.implementation })
  await writeJsonAtomic(output, null)
  try {
    await mkdir(path.join(dir, "decision-attempts"))
    let correction = ""
    for (let attempt = 0; attempt <= (input.maxDecisionRepairs ?? 0); attempt++) {
      const signal = AbortSignal.timeout(input.timeoutMs)
      const actualPrompt = prompt + correction
      if (Buffer.byteLength(actualPrompt) + reads.reduce((sum, file) => sum + file.bytes, 0) > input.maxInputBytes) throw new Error("Task intake repair input byte budget exceeded")
      const reply = await driver.invoke({ workDir: workspace, prompt: actualPrompt, model: input.model, readPaths: [...reads.map(file => file.path), output],
        ...(input.requestBudget ? { requestBudget: input.requestBudget } : {}),
        editPaths: [output], allowShell: false, maxAttempts: 1, timeoutMs: input.timeoutMs }, signal)
      const receipt = JSON.parse(JSON.stringify(reply))
      await writeJsonAtomic(path.join(dir, "intake.backend-result.json"), receipt)
      if (!reply.completed || reply.actualModel !== input.expectedModel || signal.aborted) throw new Error("Task intake backend incomplete or model mismatch")
      await driver.preflight()
      if (canonical(await resources()) !== canonical(files)) throw new Error("Task intake material drift during interpretation")
      const decision = await readFile(await resolveResource(dir, "workspace/decision.json"))
      const attemptDir = path.join(dir, "decision-attempts", String(attempt + 1))
      await mkdir(attemptDir)
      await writeJsonAtomic(path.join(attemptDir, "backend-result.json"), receipt)
      await writeFileAtomic(path.join(attemptDir, "decision.json"), decision)
      if (decision.length > input.maxDecisionBytes) throw new Error("Task decision exceeds byte budget")
      let value: ReturnType<typeof compileTask>
      try { value = compileTask(catalogue, json(decision) as Decision) }
      catch (error) {
        // 只修完整回复中的方案错误；故障或未知计费不自动重发。
        if (attempt >= (input.maxDecisionRepairs ?? 0)) throw error
        const message = error instanceof Error ? error.message.replace(/[\x00-\x1f]/g, " ").slice(0, 500) : "Invalid decision"
        await writeJsonAtomic(path.join(attemptDir, "validation.json"), { status: "invalid_decision", message })
        correction = `\nPlatform decision validation rejected your completed proposal: ${JSON.stringify(message)}. Correct only the decision JSON. Use exact declared IDs. Your intake edit restrictions do not imply missing author capabilities. Do not perform the underlying task or change its criteria.`
        continue
      }
      await writeJsonAtomic(result, value)
      if (value.status === "ready") await writeJsonAtomic(plan, value.plan)
      await writeJsonAtomic(completed, { schema: "aev.task-intake-completed.v1", binding, decisionSHA256: hash(decision),
        result: fingerprint(value), backend: fingerprint(receipt), ...(value.status === "ready" ? { planSHA256: hash(await readFile(plan)) } : {}) })
      return { ...value, dir, ...(value.status === "ready" ? { planPath: plan } : {}), reused: false }
    }
    throw new Error("Task decision repair limit reached")
  } catch (error) {
    await writeJsonAtomic(path.join(dir, "intake.failure.json"), { status: "incomplete", binding, errorKind: "task_intake_error" })
    throw error
  }
}

// 原始 auto 分支保持单独的执行与恢复语义；手动分支不得构造伪造的 backend-result。
export async function prepareTask(input: IntakeInput, dependencies?: {
  createDriver: (options: { cwd: string; evidenceRoot: string }) => Promise<Driver>
}) {
  if (input.mode === undefined || input.mode === "auto") return prepareTaskAuto(input, dependencies)
  if (input.mode !== "manual_decision" && input.mode !== "manual_plan") throw new Error("Unknown task intake mode")
  return prepareTaskManual(input)
}

const MAX_PRESET_BYTES = 1024 * 1024
const MAX_MANUAL_MATERIAL_BYTES = 128 * 1024 * 1024

async function readTrustedJsonFile(file: string, maxBytes: number) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("Absolute manual source path required")
  const actual = await realpath(file)
  if (path.resolve(actual).toLowerCase() !== path.resolve(file).toLowerCase()) throw new Error("Linked manual source rejected")
  const stat = await lstat(file)
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error("Unsafe or oversized manual source")
  const bytes = await readFile(file)
  if (bytes.length > maxBytes) throw new Error("Manual source byte budget exceeded")
  return { bytes, value: json(bytes) as unknown, path: actual.replaceAll("\\", "/") }
}

async function prepareTaskManual(input: ManualDecisionInput | ManualPlanInput) {
  if (![input.cwd, input.root, input.dir].every(file => typeof file === "string" && path.isAbsolute(file))) {
    throw new Error("Absolute manual task paths required")
  }
  // 手动轨道绝不接受误传的模型请求预算或 LLM 相关参数。
  if ((input as { requestBudget?: unknown }).requestBudget !== undefined ||
    ["model", "expectedModel", "timeoutMs", "maxInputBytes", "maxDecisionRepairs"].some(
      key => Object.prototype.hasOwnProperty.call(input, key))) throw new Error("Manual intake cannot use automatic model fields")
  if (input.mode === "manual_plan" && ["maxDecisionBytes", "decision", "decisionPath"].some(
    key => Object.prototype.hasOwnProperty.call(input, key))) {
    throw new Error("Manual Plan contains incompatible decision fields")
  }
  if (input.mode === "manual_decision" && Object.prototype.hasOwnProperty.call(input, "planPath")) {
    throw new Error("Manual Decision cannot specify Plan path")
  }
  const catalogue = validateCatalogue(input.catalogue)
  const root = await realpath(input.root)
  if (root.toLowerCase() !== path.resolve(input.root).toLowerCase()) throw new Error("Linked intake material root rejected")
  const relation = path.relative(root, input.dir)
  if (!relation || (!path.isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${path.sep}`))) {
    throw new Error("Intake output must be outside task materials")
  }
  const resources = async () => {
    const items = await Promise.all(catalogue.resources.map(async item => {
      const file = await resolveResource(root, item.path)
      const bytes = await readFile(file)
      return { id: item.id, path: file.replaceAll("\\", "/"), bytes: bytes.length, sha256: hash(bytes) }
    }))
    if (items.reduce((total, item) => total + item.bytes, 0) > MAX_MANUAL_MATERIAL_BYTES) {
      throw new Error("Manual intake material byte budget exceeded")
    }
    return items
  }
  const files = await resources()
  const sourceLimit = input.mode === "manual_decision" ? input.maxDecisionBytes ?? MAX_PRESET_BYTES : MAX_PRESET_BYTES
  if (!Number.isSafeInteger(sourceLimit) || sourceLimit <= 0 || sourceLimit > MAX_PRESET_BYTES) {
    throw new Error("Invalid manual source byte limit")
  }
  let source: { bytes: Buffer; value: unknown; path: string | null }
  if (input.mode === "manual_decision") {
    if ((input.decision === undefined) === (input.decisionPath === undefined)) {
      throw new Error("Specify exactly one manual decision source")
    }
    if (input.decisionPath !== undefined) {
      source = await readTrustedJsonFile(input.decisionPath, sourceLimit)
    } else {
      const bytes = Buffer.from(canonical(input.decision))
      if (bytes.length > sourceLimit) throw new Error("Manual decision byte budget exceeded")
      source = { bytes, value: json(bytes), path: null }
    }
  } else {
    if (typeof input.planPath !== "string") throw new Error("Manual Plan path required")
    source = await readTrustedJsonFile(input.planPath, sourceLimit)
  }
  // 验证在认领前完成；无效配置不得生成可被误认为已启动的 claim。
  const value = input.mode === "manual_decision"
    ? compileTask(catalogue, source.value as Decision)
    : approvePresetPlan(source.value, catalogue)
  await mkdir(input.dir, { recursive: true })
  const dir = await realpath(input.dir)
  if (dir.toLowerCase() !== path.resolve(input.dir).toLowerCase()) throw new Error("Linked intake output root rejected")
  if (source.path) {
    const relativeSource = path.relative(dir, source.path)
    if (!relativeSource || (!path.isAbsolute(relativeSource) && relativeSource !== ".." &&
      !relativeSource.startsWith(`..${path.sep}`))) throw new Error("Manual source cannot be inside intake evidence directory")
  }
  const workspace = path.join(dir, "workspace")
  await mkdir(workspace, { recursive: true })
  if ((await realpath(workspace)).toLowerCase() !== path.resolve(workspace).toLowerCase()) {
    throw new Error("Linked intake workspace rejected")
  }
  const evidenceName = input.mode === "manual_decision" ? "decision.json" : "approved-plan.json"
  const evidencePath = path.join(workspace, evidenceName)
  const savedRelative = `workspace/${evidenceName}`
  const planPath = path.join(dir, "task-plan.json")
  const sourceFiles = ["./intake.ts", "./catalogue.ts", "./plan.ts", "./binding.ts", "./approved-plan.ts"]
  const implementation = await Promise.all(sourceFiles.map(async file =>
    hash(await readFile(fileURLToPath(new URL(file, import.meta.url))))))
  const sourceEvidence = { mode: input.mode, path: source.path, sha256: hash(source.bytes), bytes: source.bytes.length }
  const binding = fingerprint({ catalogue, root, files, cwd: input.cwd, source: implementation, sourceEvidence })
  const snapshot = path.join(dir, "intake.snapshot.json")
  const completed = path.join(dir, "intake.completed.json")
  const resultPath = path.join(dir, "intake.result.json")
  let fresh = true
  try { const claim = await open(path.join(dir, "intake.started.claim"), "wx"); await claim.close() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    fresh = false
    const saved = json(await readFile(await resolveResource(dir, "intake.snapshot.json")))
    if (saved.schema !== "aev.task-intake-snapshot.v1" || saved.mode !== input.mode || saved.binding !== binding) {
      throw new Error("Task manual intake identity drift")
    }
  }
  if (!fresh) {
    try { await access(path.join(dir, "intake.failure.json")); throw new Error("Task intake failed; inspect before recovery") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    const receipt = json(await readFile(await resolveResource(dir, "intake.completed.json")))
    const evidence = await readFile(await resolveResource(dir, savedRelative))
    const savedResult = json(await readFile(await resolveResource(dir, "intake.result.json")))
    const savedValue = input.mode === "manual_decision"
      ? compileTask(catalogue, json(evidence) as Decision)
      : approvePresetPlan(json(evidence), catalogue)
    if (receipt.schema !== "aev.task-intake-completed.v1" || receipt.mode !== input.mode ||
      receipt.binding !== binding || receipt.sourceSHA256 !== hash(source.bytes) ||
      receipt.evidenceSHA256 !== hash(evidence) ||
      receipt.result !== fingerprint(value) || canonical(savedValue) !== canonical(value) ||
      canonical(savedResult) !== canonical(value) ||
      (value.status === "ready" && receipt.planSHA256 !== hash(await readFile(await resolveResource(dir, "task-plan.json"))))) {
      throw new Error("Completed manual intake evidence drift")
    }
    if (value.status === "ready" && canonical(json(await readFile(await resolveResource(dir, "task-plan.json")))) !== canonical(value.plan)) {
      throw new Error("Completed manual Plan differs from approved result")
    }
    return { ...value, dir, ...(value.status === "ready" ? { planPath } : {}), reused: true }
  }
  for (const file of [snapshot, completed, resultPath, planPath, evidencePath,
    path.join(dir, "intake.backend-result.json"), path.join(dir, "intake.failure.json")]) {
    try { await access(file); throw new Error("Unclaimed task intake evidence exists") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  await writeJsonAtomic(snapshot, { schema: "aev.task-intake-snapshot.v1", mode: input.mode,
    binding, source: sourceEvidence })
  try {
    // 留存原始文件内容，不能捏造后端调用成功回执。
    await writeFileAtomic(evidencePath, source.bytes)
    if (source.path && hash((await readTrustedJsonFile(source.path, sourceLimit)).bytes) !== sourceEvidence.sha256) {
      throw new Error("Manual source changed during intake")
    }
    if (canonical(await resources()) !== canonical(files)) throw new Error("Manual intake materials drifted")
    await writeJsonAtomic(resultPath, value)
    if (value.status === "ready") await writeJsonAtomic(planPath, value.plan)
    await writeJsonAtomic(completed, { schema: "aev.task-intake-completed.v1", mode: input.mode,
      binding, sourceSHA256: sourceEvidence.sha256,
      evidenceSHA256: hash(await readFile(evidencePath)), result: fingerprint(value),
      ...(value.status === "ready" ? { planSHA256: hash(await readFile(planPath)) } : {}) })
    return { ...value, dir, ...(value.status === "ready" ? { planPath } : {}), reused: false }
  } catch (error) {
    await writeJsonAtomic(path.join(dir, "intake.failure.json"), {
      status: "incomplete", mode: input.mode, binding, errorKind: "task_manual_intake_error" })
    throw error
  }
}
