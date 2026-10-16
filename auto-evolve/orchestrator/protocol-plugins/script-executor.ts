import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { writeFileAtomic, writeJsonAtomic } from "../atomic-write"
import { terminateProcessTree } from "../runtime-process-registry"
import type { ExecutorPlugin, Settings } from "./contract"
import type { Artifact, Execute } from "./runtime"

interface Config {
  command: string
  commandSHA256: string
  script: string
  scriptSHA256: string
  timeoutMs: number
  maxInputBytes: number
  maxOutputBytes: number
  executionBoundary: "trusted_host_runner"
}

function config(settings: Settings): Config {
  const keys = ["command", "commandSHA256", "script", "scriptSHA256", "timeoutMs", "maxInputBytes", "maxOutputBytes", "executionBoundary"]
  if (Object.keys(settings).some((key) => !keys.includes(key)) || keys.some((key) => settings[key] === undefined)) {
    throw new Error("Explicit script executor settings required")
  }
  const value = settings as unknown as Config
  if (typeof value.command !== "string" || !path.isAbsolute(value.command) ||
      typeof value.script !== "string" || !path.isAbsolute(value.script) ||
      !/^[a-f0-9]{64}$/.test(value.commandSHA256) || !/^[a-f0-9]{64}$/.test(value.scriptSHA256) ||
      ![value.timeoutMs, value.maxInputBytes, value.maxOutputBytes].every((n) => Number.isSafeInteger(n) && n > 0) ||
      value.timeoutMs > 3_600_000 || value.maxInputBytes > 64 * 1024 * 1024 || value.maxOutputBytes > 16 * 1024 * 1024 ||
      /\.(cmd|bat|ps1)$/i.test(value.command) || value.executionBoundary !== "trusted_host_runner") {
    throw new Error("Invalid script executor settings or execution boundary")
  }
  return value
}

async function digest(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}

export async function verifyScriptExecution(settings: Settings) {
  const cfg = config(settings)
  if (await digest(cfg.command) !== cfg.commandSHA256 || await digest(cfg.script) !== cfg.scriptSHA256) {
    throw new Error("Interpreter or execution runner fingerprint changed")
  }
}

export async function scriptExecutor(root: string): Promise<{
  descriptor: ExecutorPlugin; execute: Execute; preflight: (input: Parameters<Execute>[0]) => Promise<void>
}> {
  if (!path.isAbsolute(root)) throw new Error("Absolute execution evidence root required")
  const descriptor: ExecutorPlugin = {
    id: "script-json-executor", version: "1", implementation: await digest(fileURLToPath(import.meta.url)),
    skillFormats: ["text", "files"], productKinds: ["json"], materialKinds: ["text", "json"],
    validate(settings) { config(settings) },
  }
  const preflight = async (input: Parameters<Execute>[0]) => {
    await verifyScriptExecution(input.settings)
    const cfg = config(input.settings)
    const length = [...input.skill, ...input.materials].reduce((sum, item) => sum + item.bytes.byteLength, 0)
    if (length > cfg.maxInputBytes) throw new Error("Script execution input exceeds byte budget")
  }
  const execute: Execute = async (input) => {
    await preflight(input)
    const cfg = config(input.settings)
    const dir = path.join(root, randomUUID())
    await mkdir(dir, { recursive: true })
    async function stage(name: string, items: Artifact[]) {
      const folder = path.join(dir, name)
      await mkdir(folder)
      const result = []
      for (const [index, item] of items.entries()) {
        const file = path.join(folder, `${index}.bin`)
        await writeFileAtomic(file, Buffer.from(item.bytes))
        result.push({ id: item.id, kind: item.kind, path: file.replace(/\\/g, "/"),
          sha256: createHash("sha256").update(item.bytes).digest("hex"), bytes: item.bytes.byteLength })
      }
      return result
    }
    // 运行器由宿主冻结；候选仅作输入，不把临时目录冒充系统沙盒。
    const payload = { schema: "aev.script-execution-input.v1", task: input.task, phase: input.phase,
      candidate: await stage("candidate", input.skill), materials: await stage("materials", input.materials) }
    const file = path.join(dir, "input.json")
    await writeJsonAtomic(file, payload)
    const runnerBytes = await readFile(cfg.script)
    if (createHash("sha256").update(runnerBytes).digest("hex") !== cfg.scriptSHA256) {
      throw new Error("Execution runner changed during input preparation")
    }
    // 执行冻结副本，避免检查后原脚本变更；运行器须自包含。
    const frozenRunner = path.join(dir, `runner${path.extname(cfg.script)}`)
    await writeFileAtomic(frozenRunner, runnerBytes)
    const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" }
    for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP"]) {
      if (process.env[key]) env[key] = process.env[key]
    }
    const started = performance.now()
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string; failure: string | null }>((resolve) => {
      const child = spawn(cfg.command, [frozenRunner, file], {
        cwd: dir, env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      let size = 0
      let settled = false
      let failure: string | null = null
      let stopping: Promise<void> | undefined
      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void (async () => {
          await stopping
          resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), failure })
        })()
      }
      const stop = (reason: string) => {
        if (failure || settled) return
        failure = reason
        // 仅终止当前持有的子进程树；关闭后不再按旧PID清理。
        stopping = (async () => {
          const killed = await terminateProcessTree(child.pid).catch(() => false)
          if (!killed && child.exitCode === null && child.signalCode === null) child.kill()
        })()
        void stopping.finally(() => finish(null))
      }
      const timer = setTimeout(() => stop("timeout"), cfg.timeoutMs)
      const collect = (chunks: Buffer[], chunk: Buffer) => {
        if (failure || settled) return
        size += chunk.length
        if (size > cfg.maxOutputBytes) { stop("output_limit"); return }
        chunks.push(chunk)
      }
      child.stdout.on("data", (chunk: Buffer) => collect(out, chunk))
      child.stderr.on("data", (chunk: Buffer) => collect(err, chunk))
      child.once("error", () => { failure = "spawn_error"; finish(null) })
      child.once("close", finish)
    })
    await writeFileAtomic(path.join(dir, "stdout.txt"), result.stdout)
    await writeFileAtomic(path.join(dir, "stderr.txt"), result.stderr)
    await writeJsonAtomic(path.join(dir, "process.json"), { exitCode: result.code, failure: result.failure,
      wallMs: performance.now() - started, commandSHA256: cfg.commandSHA256, scriptSHA256: cfg.scriptSHA256,
      executionBoundary: cfg.executionBoundary })
    if (result.failure || result.code !== 0) return { status: "execution_error", message: "Execution runner failed; inspect process evidence" }
    let product: unknown
    try { product = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim()) }
    catch { return { status: "execution_error", message: "Execution runner did not return one JSON product" } }
    if (!product || typeof product !== "object" || Array.isArray(product)) {
      return { status: "execution_error", message: "Execution product must be a JSON object" }
    }
    // 输出是待判产物，不接受运行器自报passed替代正式检查。
    const bytes = Buffer.from(result.stdout.replace(/^\uFEFF/, "").trim(), "utf8")
    await writeFileAtomic(path.join(dir, "product.json"), bytes)
    return { status: "completed", product: { kind: "json", bytes } }
  }
  return { descriptor, execute, preflight }
}
