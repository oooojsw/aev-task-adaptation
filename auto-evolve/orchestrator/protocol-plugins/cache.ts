import { mkdir, open, readFile } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { writeJsonAtomic } from "../atomic-write"
import { canonical, fingerprint } from "./identity"
import { identity } from "./registry"
import type { Identity, Json, Settings } from "./contract"
import type { Artifact, Evaluate, Execute } from "./runtime"

type Plugin = Identity & { implementation: string; validate?: (settings: Settings) => void }
interface Stored {
  schema: "aev.plugin-cache.v1"
  request: string
  body: Json
  bodyFingerprint: string
}

function inputs(items: Artifact[]) {
  return items.map((item) => ({ id: item.id, kind: item.kind,
    sha256: createHash("sha256").update(item.bytes).digest("hex"), length: item.bytes.byteLength }))
}

async function claim(root: string, key: string) {
  if (!path.isAbsolute(root) || !/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid cache location or identity")
  const dir = path.join(root, key)
  await mkdir(dir, { recursive: true })
  try {
    await readFile(path.join(dir, "completed.json"))
    try { await readFile(path.join(dir, "started.claim")) }
    catch { throw new Error("Unclaimed plugin receipt; inspect before reuse") }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
  try {
    // 原子认领；并发或残缺调用不能被自动重复发出。
    const file = await open(path.join(dir, "started.claim"), "wx")
    await file.close()
    return { dir }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
  }
  let cached: Stored
  try {
    cached = JSON.parse((await readFile(path.join(dir, "completed.json"), "utf8")).replace(/^\uFEFF/, ""))
  } catch {
    throw new Error("Prior plugin attempt pending/incomplete; inspect before retry")
  }
  if (cached.schema !== "aev.plugin-cache.v1" || cached.request !== key ||
      cached.bodyFingerprint !== fingerprint(cached.body)) throw new Error("Plugin cache receipt drift")
  return { dir, cached }
}

async function store(dir: string, key: string, body: Json) {
  const receipt: Stored = { schema: "aev.plugin-cache.v1", request: key, body, bodyFingerprint: fingerprint(body) }
  await writeJsonAtomic(path.join(dir, "completed.json"), receipt)
}

function plugin(value: Plugin) {
  identity(value)
  if (!/^[a-f0-9]{64}$/.test(value.implementation)) throw new Error("Actual plugin implementation identity required")
  // 校验函数属于执行接口，不属于可序列化的版本与能力指纹。
  const { validate: _, ...descriptor } = value
  return JSON.parse(canonical(descriptor)) as Plugin
}

export function cachedExecution(root: string, descriptor: Plugin, handler: Execute,
  preflight?: (input: Parameters<Execute>[0]) => Promise<void>): Execute {
  const version = plugin(descriptor)
  return async (input) => {
    // 缓存命中也要核验外部依赖，不能绕过后端身份检查。
    await preflight?.(input)
    // 执行身份不含评分器；只改评分器可以复用原答卷。
    const key = fingerprint({ plugin: version, task: input.task, phase: input.phase, settings: input.settings,
      skill: inputs(input.skill), materials: inputs(input.materials) })
    const entry = await claim(path.join(root, "execution"), key)
    if (entry.cached) {
      const body = entry.cached.body as Record<string, Json>
      if (body.status !== "completed" || typeof body.kind !== "string" || typeof body.base64 !== "string" ||
          !body.base64.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.base64)) {
        throw new Error("Invalid cached execution product")
      }
      return { status: "completed", product: { kind: body.kind, bytes: Buffer.from(body.base64, "base64") },
        ...(body.usage ? { usage: body.usage as { inputTokens?: number; outputTokens?: number } } : {}), reused: true }
    }
    try {
      const result = await handler(input)
      if (!result || result.status !== "completed" || !result.product ||
          !(result.product.bytes instanceof Uint8Array) || !result.product.bytes.byteLength) {
        await writeJsonAtomic(path.join(entry.dir, "failure.json"), {
          request: key, status: result?.status ?? "execution_error", outcome: "inspect_before_retry",
        })
        return result ?? { status: "execution_error", message: "Invalid executor reply" }
      }
      await store(entry.dir, key, { status: "completed", kind: result.product.kind,
        base64: Buffer.from(result.product.bytes).toString("base64"), ...(result.usage ? { usage: result.usage } : {}) })
      return { ...result, reused: false }
    } catch (err) {
      await writeJsonAtomic(path.join(entry.dir, "failure.json"), {
        request: key, status: "execution_error", outcome: "inspect_before_retry",
      })
      throw err
    }
  }
}

export function cachedScoring(root: string, descriptor: Plugin, handler: Evaluate,
  preflight?: (input: Parameters<Evaluate>[0]) => Promise<void>): Evaluate {
  const version = plugin(descriptor)
  return async (input) => {
    // 评分脚本变化时阻断旧判定复用，不自动重发执行请求。
    await preflight?.(input)
    const key = fingerprint({ plugin: version, task: input.task, phase: input.phase, settings: input.settings,
      check: input.check, candidate: inputs(input.candidate), skill: inputs(input.skill),
      materials: inputs(input.materials), privateInputs: inputs(input.privateInputs) })
    const entry = await claim(path.join(root, "scoring"), key)
    if (entry.cached) {
      const result = entry.cached.body as Record<string, Json>
      if (!["passed", "rejected"].includes(String(result.status)) || typeof result.message !== "string") {
        throw new Error("Invalid cached scoring receipt")
      }
      return { status: result.status as "passed" | "rejected", message: result.message,
        ...(result.usage ? { usage: result.usage as { inputTokens?: number; outputTokens?: number } } : {}), reused: true }
    }
    try {
      const result = await handler(input)
      if (!result || !["passed", "rejected"].includes(result.status) || typeof result.message !== "string") {
        await writeJsonAtomic(path.join(entry.dir, "failure.json"), {
          request: key, status: result?.status ?? "scoring_error", outcome: "inspect_before_retry",
        })
        return result ?? { status: "scoring_error", message: "Invalid scoring reply" }
      }
      await store(entry.dir, key, { status: result.status, message: result.message, ...(result.usage ? { usage: result.usage } : {}) })
      return result
    } catch (err) {
      await writeJsonAtomic(path.join(entry.dir, "failure.json"), {
        request: key, status: "scoring_error", outcome: "inspect_before_retry",
      })
      throw err
    }
  }
}
