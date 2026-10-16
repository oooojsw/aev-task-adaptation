import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath } from "node:fs/promises"
import { writeJsonAtomic } from "../atomic-write"
import { resolveResource } from "./binding"
import { fingerprint } from "../protocol-plugins/identity"

export interface RecomputeScope { schema: "aev.recompute.v1"; task: string; role: string }
export interface RecomputeConfig extends RecomputeScope { evidenceRoot: string }
export type Expression = number | { op: "add" | "sub" | "mul" | "div" | "pow" | "sqrt" | "min" | "max" | "sum" | "mean"; args: Expression[] }
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export function validateRecomputeScope(value: unknown): RecomputeScope {
  const cfg = value as RecomputeScope
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) ||
    Object.keys(cfg).some(key => !["schema", "task", "role"].includes(key)) || cfg.schema !== "aev.recompute.v1" ||
    !/^[a-f0-9]{64}$/.test(cfg.task) || typeof cfg.role !== "string" || !/^[a-z_]{1,40}$/.test(cfg.role)) throw new Error("Invalid recompute scope")
  return structuredClone(cfg)
}

export function computeExpression(expression: unknown): number {
  let nodes = 0
  function evaluate(value: unknown, depth: number): number {
    if (++nodes > 256 || depth > 16) throw new Error("Recompute complexity limit exceeded")
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["op", "args"].includes(key))) throw new Error("Invalid recompute expression")
    const item = value as { op: string; args: unknown[] }
    const unary = item.op === "sqrt"
    const binary = ["sub", "div", "pow"].includes(item.op)
    if (!["add", "sub", "mul", "div", "pow", "sqrt", "min", "max", "sum", "mean"].includes(item.op) ||
      !Array.isArray(item.args) || !item.args.length || item.args.length > 128 ||
      unary && item.args.length !== 1 || binary && item.args.length !== 2) throw new Error("Invalid recompute operation or arity")
    const values = item.args.map(arg => evaluate(arg, depth + 1))
    const [a, b] = values
    let result: number
    switch (item.op) {
      case "add": case "sum": result = values.reduce((sum, number) => sum + number, 0); break
      case "mean": result = values.reduce((sum, number) => sum + number, 0) / values.length; break
      case "mul": result = values.reduce((product, number) => product * number, 1); break
      case "sub": result = a - b; break
      case "div": if (b === 0) throw new Error("Recompute division by zero"); result = a / b; break
      case "pow": if (Math.abs(b) > 1024) throw new Error("Recompute exponent limit exceeded"); result = a ** b; break
      case "sqrt": result = Math.sqrt(a); break
      case "min": result = Math.min(...values); break
      case "max": result = Math.max(...values); break
      default: throw new Error("Unknown recompute operation")
    }
    if (!Number.isFinite(result)) throw new Error("Nonfinite recompute result")
    return result
  }
  // 固定算术树，不解释代码、不读取文件，也不替代来源核查。
  return evaluate(expression, 0)
}

export function validateRecomputeAccess(value: RecomputeScope, reads: string[], edits: string[], evidenceRoot: string) {
  validateRecomputeScope(value)
  if (!path.isAbsolute(evidenceRoot)) throw new Error("Absolute recompute evidence root required")
  for (const grant of [...reads, ...edits]) {
    const tail = path.relative(grant, evidenceRoot)
    if (!tail || !path.isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${path.sep}`)) throw new Error("Recompute evidence must be outside model grants")
  }
}

export async function recompute(value: RecomputeConfig, expression: unknown, signal?: AbortSignal) {
  const { evidenceRoot, ...raw } = value
  const scope = validateRecomputeScope(raw)
  if (typeof evidenceRoot !== "string" || !path.isAbsolute(evidenceRoot)) throw new Error("Absolute recompute evidence root required")
  signal?.throwIfAborted()
  const result = computeExpression(expression)
  await mkdir(evidenceRoot, { recursive: true })
  if (path.resolve(await realpath(evidenceRoot)).toLowerCase() !== path.resolve(evidenceRoot).toLowerCase()) throw new Error("Linked recompute evidence rejected")
  signal?.throwIfAborted()
  const evidence = { schema: "aev.recompute-receipt.v1", scope: fingerprint(scope), task: scope.task, role: scope.role,
    expression, result, arithmetic: "IEEE-754-binary64", inputOrigin: "model_arguments_not_source_verified" }
  const receipt = fingerprint(evidence)
  await writeJsonAtomic(path.join(evidenceRoot, `${randomUUID()}.json`), { ...evidence, fingerprint: receipt })
  return { result, receipt, arithmetic: evidence.arithmetic, inputOrigin: evidence.inputOrigin }
}

export async function recomputeEnvironment(config: RecomputeConfig | undefined, dir: string) {
  if (!config) return { OPENCODE_AEV_RECOMPUTE_FILE: undefined, OPENCODE_AEV_RECOMPUTE_SHA256: undefined }
  const { evidenceRoot, ...scope } = config
  validateRecomputeAccess(scope, [], [], evidenceRoot)
  if (!path.isAbsolute(dir)) throw new Error("Absolute private recompute config required")
  const file = path.join(dir, "recompute.json")
  await writeJsonAtomic(file, config)
  return { OPENCODE_AEV_RECOMPUTE_FILE: file.replaceAll("\\", "/"), OPENCODE_AEV_RECOMPUTE_SHA256: sha(await readFile(file)) }
}

export async function recomputeFromEnvironment(expression: unknown, env: Record<string, string | undefined>, signal?: AbortSignal) {
  const file = env.OPENCODE_AEV_RECOMPUTE_FILE
  const expected = env.OPENCODE_AEV_RECOMPUTE_SHA256
  if (!file || !path.isAbsolute(file) || !expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("Explicit frozen recompute binding required")
  await resolveResource(path.dirname(file), path.basename(file))
  const info = await lstat(file)
  if (!info.isFile() || info.nlink !== 1 || info.size > 16000) throw new Error("Invalid private recompute config")
  const bytes = await readFile(file)
  if (bytes.length > 16000 || sha(bytes) !== expected) throw new Error("Recompute binding drift")
  return recompute(JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")), expression, signal)
}
