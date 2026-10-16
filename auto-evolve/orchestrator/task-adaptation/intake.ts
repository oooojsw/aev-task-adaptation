import path from "node:path"
import { readFile, mkdir, open, realpath, access } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { writeJsonAtomic, writeFileAtomic } from "../atomic-write"
import { opencodeDriver } from "../protocol-plugins/opencode-driver"
import type { InvokeTool } from "../protocol-plugins/tool-session"
import { canonical, fingerprint } from "../protocol-plugins/identity"
import { compileTask, interpretationPrompt, validateCatalogue, type TaskCatalogue, type Decision } from "./catalogue"
import { resolveResource } from "./binding"

interface Driver { implementation: string; preflight(): Promise<void>; invoke: InvokeTool }
export interface IntakeInput {
  requestBudget?: import("./budget-transport").BudgetTransportConfig
  cwd: string
  root: string
  dir: string
  catalogue: TaskCatalogue
  model: string
  expectedModel: string
  timeoutMs: number
  maxInputBytes: number
  maxDecisionBytes: number
  maxDecisionRepairs?: number
}

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const json = (bytes: Buffer) => JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""))

export async function prepareTask(input: IntakeInput, dependencies?: { createDriver: (options: { cwd: string; evidenceRoot: string }) => Promise<Driver> }) {
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
