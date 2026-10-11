import { createHash } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import path from "node:path"
import type { Check, CheckerPlugin, ExecutorPlugin, Outcome, Phase, Settings, Snapshot } from "./contract"
import { fingerprint, immutable } from "./identity"
import { identity, Registry } from "./registry"
import { verify } from "./compile"

export interface InputFile {
  id: string
  kind: string
  path: string
}

export interface Artifact {
  id: string
  kind: string
  bytes: Uint8Array
  sha256: string
  length: number
}

export interface Task {
  id: string
  skill: InputFile[]
  materials: InputFile[]
  privateInputs: InputFile[]
  allowedRoots: string[]
}

export interface PublicInputs {
  task: string
  phase: Phase
  skill: Artifact[]
  materials: Artifact[]
}

export type Execute = (input: PublicInputs & { settings: Settings }) => Promise<{
  status: "completed" | "execution_error" | "interrupted"
  product?: { kind: string; bytes: Uint8Array }
  usage?: { inputTokens?: number; outputTokens?: number }
  message?: string
}>

export type Evaluate = (input: PublicInputs & {
  candidate: Artifact[]
  privateInputs: Artifact[]
  settings: Settings
  check: Pick<Check, "name" | "target" | "stage" | "mechanism">
}) => Promise<{ status: "passed" | "rejected" | "scoring_error" | "data_error"; message: string }>

function metadata(input: Artifact[]) {
  return input.map(({ bytes: _, ...item }) => item)
}

function copy(input: Artifact[]) {
  return input.map((item) => ({ ...item, bytes: new Uint8Array(item.bytes) }))
}

function artifact(id: string, kind: string, bytes: Uint8Array): Artifact {
  return { id, kind, bytes: new Uint8Array(bytes), length: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex") }
}

async function load(files: InputFile[], roots: string[]) {
  const ids = new Set<string>()
  const result: Artifact[] = []
  for (const file of files) {
    if (!file || !file.id || ids.has(file.id) || !file.kind || !path.isAbsolute(file.path)) throw new Error("Invalid or duplicate input binding")
    ids.add(file.id)
    const resolved = await realpath(file.path)
    // 实际路径再核边界，避免符号链接把输入绑定带出允许目录。
    if (!roots.some((root) => {
      const rel = path.relative(root, resolved)
      return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
    })) throw new Error("Input outside declared roots")
    result.push(artifact(file.id, file.kind, await readFile(resolved)))
  }
  return result.sort((a, b) => a.id.localeCompare(b.id))
}

export class Runtime {
  readonly registry = new Registry()
  private executors = new Map<string, Execute>()
  private checkers = new Map<string, Evaluate>()

  addExecutor(plugin: ExecutorPlugin, handler: Execute) {
    if (typeof handler !== "function") throw new Error("Executor handler required")
    this.registry.addExecutor(plugin)
    this.executors.set(identity(plugin), handler)
    return this
  }

  addChecker(plugin: CheckerPlugin, handler: Evaluate) {
    if (typeof handler !== "function") throw new Error("Checker handler required")
    this.registry.addChecker(plugin)
    this.checkers.set(identity(plugin), handler)
    return this
  }

  async run(snapshot: Snapshot, phase: Phase, task: Task) {
    const resolved = verify(snapshot, this.registry)
    const plan = resolved.selection.protocol.phases[phase]
    if (!plan) throw new Error(`Undeclared phase: ${phase}`)
    if (!task || !task.id || !Array.isArray(task.skill) || !task.skill.length || !Array.isArray(task.materials) ||
        !Array.isArray(task.privateInputs) || !Array.isArray(task.allowedRoots) || !task.allowedRoots.length ||
        task.allowedRoots.some((root) => !path.isAbsolute(root))) throw new Error("Explicit task input bindings required")
    const roots = await Promise.all(task.allowedRoots.map((root) => realpath(root)))
    const skill = await load(task.skill, roots)
    const materials = await load(task.materials, roots)
    const privateInputs = await load(task.privateInputs, roots)
    if (materials.some((item) => !resolved.selection.run.materialKinds.includes(item.kind))) throw new Error("Task material kind mismatch")
    for (const check of plan.checks) {
      for (const id of check.privateInputs ?? []) {
        if (!privateInputs.some((item) => item.id === id)) throw new Error(`Missing declared private binding: ${id}`)
      }
      if (!this.checkers.has(identity(check))) throw new Error(`Missing checker handler: ${check.id}`)
    }
    if (plan.executor && !this.executors.has(identity(plan.executor))) throw new Error(`Missing executor handler: ${plan.executor.id}`)
    const evidence = { skill: metadata(skill), materials: metadata(materials), privateInputs: metadata(privateInputs) }
    const checks: Array<{ name: string; required: boolean; status: Outcome; message: string; inputFingerprint: string }> = []
    let product: Artifact | undefined
    let usage: { inputTokens?: number; outputTokens?: number } | undefined
    const publicInputs = () => ({ task: task.id, phase, skill: copy(skill), materials: copy(materials) })
    const receipt = (status: Outcome, message: string, executed: boolean, attempted = false) => ({
      schema: "aev.protocol-receipt.v1" as const, task: task.id, phase, claim: plan.claim,
      protocolFingerprint: resolved.fingerprint, status, message, executed, executionAttempted: attempted, evidence,
      checks, ...(product ? { product: metadata([product])[0] } : {}), ...(usage ? { usage } : {}),
    })
    const evaluate = async (stage: Check["stage"]) => {
      for (const check of plan.checks.filter((item) => item.stage === stage)) {
        const candidate = check.target === "skill" ? skill : product ? [product] : []
        if (!candidate.length) return "data_error" as const
        const selected = privateInputs.filter((item) => check.privateInputs?.includes(item.id))
        const key = fingerprint({ checker: this.registry.checker(check).implementation,
          binding: check, candidate: metadata(candidate), materials: metadata(materials), privateInputs: metadata(selected) })
        let result
        try {
          result = await this.checkers.get(identity(check))!({ ...publicInputs(), candidate: copy(candidate),
            privateInputs: copy(selected), settings: immutable(check.settings),
            check: { name: check.name, target: check.target, stage: check.stage, mechanism: check.mechanism } })
          if (!result || !["passed", "rejected", "scoring_error", "data_error"].includes(result.status) ||
              typeof result.message !== "string") throw new Error("Invalid checker receipt")
        } catch {
          // 插件异常是评分故障，不将故障当作Skill失败。
          result = { status: "scoring_error" as const, message: "Checker failed; inspect plugin evidence" }
        }
        checks.push({ name: check.name, required: check.required, ...result, inputFingerprint: key })
        if (result.status === "scoring_error" || result.status === "data_error") return result.status
        if (check.required && result.status === "rejected") return "rejected" as const
      }
      return "passed" as const
    }
    const pre = await evaluate("before_execution")
    if (pre !== "passed") return receipt(pre, "Pre-execution checks did not pass", false)
    if (plan.claim === "skill_check") return receipt("passed", "Declared skill checks passed; task not executed", false)
    let result
    try {
      result = await this.executors.get(identity(plan.executor!))!({ ...publicInputs(), settings: immutable(plan.executor!.settings) })
    } catch {
      return receipt("execution_error", "Executor failed; inspect backend evidence", false, true)
    }
    if (!result || !["completed", "execution_error", "interrupted"].includes(result.status)) {
      return receipt("execution_error", "Invalid execution receipt", false, true)
    }
    if (result.status !== "completed") return receipt(result.status, "Execution did not complete", false, true)
    if (!result.product || result.product.kind !== resolved.selection.run.productKind ||
        !(result.product.bytes instanceof Uint8Array) || !result.product.bytes.byteLength) {
      return receipt("execution_error", "Missing or incompatible execution product", false, true)
    }
    product = artifact("execution-product", result.product.kind, result.product.bytes)
    usage = result.usage
    const post = await evaluate("after_execution")
    return receipt(post, post === "passed" ? "Declared execution and scoring passed" : "Post-execution checks did not pass", true, true)
  }
}
