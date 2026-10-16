import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { readFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { writeFileAtomic, writeJsonAtomic } from "../atomic-write"
import type { CheckerPlugin, Settings } from "./contract"
import type { Artifact, Evaluate } from "./runtime"

interface Config {
  command: string
  commandSHA256: string
  script: string
  scriptSHA256: string
  timeoutMs: number
  maxOutputBytes: number
}

function config(settings: Settings): Config {
  const keys = ["command", "commandSHA256", "script", "scriptSHA256", "timeoutMs", "maxOutputBytes"]
  if (Object.keys(settings).some((key) => !keys.includes(key)) || keys.some((key) => settings[key] === undefined)) {
    throw new Error("Explicit script settings required")
  }
  const value = settings as unknown as Config
  if (typeof value.command !== "string" || !path.isAbsolute(value.command) || typeof value.script !== "string" ||
      !path.isAbsolute(value.script) || !/^[a-f0-9]{64}$/.test(value.commandSHA256) || !/^[a-f0-9]{64}$/.test(value.scriptSHA256) ||
      ![value.timeoutMs, value.maxOutputBytes].every((item) => Number.isSafeInteger(item) && item > 0) ||
      value.timeoutMs > 3_600_000 || value.maxOutputBytes > 16 * 1024 * 1024 || /\.(cmd|bat|ps1)$/i.test(value.command)) {
    throw new Error("Invalid script execution settings")
  }
  return value
}

async function digest(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}

export async function verifyScriptChecker(settings: Settings) {
  const cfg = config(settings)
  if (await digest(cfg.command) !== cfg.commandSHA256 || await digest(cfg.script) !== cfg.scriptSHA256) {
    throw new Error("Interpreter or scorer fingerprint changed before cache reuse")
  }
}

export async function scriptChecker(root: string): Promise<{ descriptor: CheckerPlugin; evaluate: Evaluate;
  preflight: (input: Parameters<Evaluate>[0]) => Promise<void> }> {
  if (!path.isAbsolute(root)) throw new Error("Absolute script evidence root required")
  const descriptor: CheckerPlugin = { id: "script-json-checker", version: "1", implementation: await digest(fileURLToPath(import.meta.url)),
    targets: ["skill", "product"], mechanisms: ["script"], productKinds: ["text", "excel", "json"],
    validate(settings) { config(settings) } }
  const evaluate: Evaluate = async (input) => {
    const cfg = config(input.settings)
    if (await digest(cfg.command) !== cfg.commandSHA256 || await digest(cfg.script) !== cfg.scriptSHA256) {
      return { status: "scoring_error", message: "Interpreter or scorer fingerprint changed" }
    }
    const dir = path.join(root, randomUUID())
    await mkdir(dir, { recursive: true })
    async function stage(name: string, items: Artifact[]) {
      const result = []
      const folder = path.join(dir, name)
      await mkdir(folder)
      for (const [index, item] of items.entries()) {
        const file = path.join(folder, `${index}.bin`)
        await writeFileAtomic(file, Buffer.from(item.bytes))
        result.push({ id: item.id, kind: item.kind, path: file.replace(/\\/g, "/"),
          sha256: createHash("sha256").update(item.bytes).digest("hex"), bytes: item.bytes.byteLength })
      }
      return result
    }
    const payload = { task: input.task, phase: input.phase, check: input.check,
      candidate: await stage("candidate", input.candidate), materials: await stage("materials", input.materials),
      privateInputs: await stage("private", input.privateInputs) }
    const file = path.join(dir, "input.json")
    await writeJsonAtomic(file, payload)
    // 不继承模型密钥；脚本只得到声明的输入与最小运行环境。
    const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" }
    for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP"]) {
      if (process.env[key]) env[key] = process.env[key]
    }
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string; failed: boolean }>((resolve) => {
      const child = spawn(cfg.command, [cfg.script, file], { cwd: dir, env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] })
      const out: Buffer[] = []
      const err: Buffer[] = []
      let size = 0
      let failed = false
      let settled = false
      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), failed })
      }
      const timer = setTimeout(() => { failed = true; child.kill(); finish(null) }, cfg.timeoutMs)
      const collect = (chunks: Buffer[], chunk: Buffer) => {
        size += chunk.length
        if (size > cfg.maxOutputBytes) { failed = true; child.kill(); finish(null); return }
        chunks.push(chunk)
      }
      child.stdout.on("data", (chunk: Buffer) => collect(out, chunk))
      child.stderr.on("data", (chunk: Buffer) => collect(err, chunk))
      child.once("error", () => { failed = true; finish(null) })
      child.once("close", finish)
    })
    await writeFileAtomic(path.join(dir, "stdout.txt"), result.stdout)
    await writeFileAtomic(path.join(dir, "stderr.txt"), result.stderr)
    await writeJsonAtomic(path.join(dir, "process.json"), { exitCode: result.code, failed: result.failed,
      scriptSHA256: cfg.scriptSHA256, commandSHA256: cfg.commandSHA256 })
    if (result.failed) return { status: "scoring_error", message: "Scoring process failed or exceeded bounds" }
    let parsed
    try { parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim()) }
    catch { return { status: "scoring_error", message: "Scorer did not return one JSON verdict" } }
    if (!parsed || !["passed", "rejected", "scoring_error", "data_error"].includes(parsed.status) ||
        typeof parsed.message !== "string" || (result.code !== 0 && !(result.code === 1 && parsed.status === "rejected"))) {
      return { status: "scoring_error", message: "Scorer verdict and process status do not match" }
    }
    await writeJsonAtomic(path.join(dir, "verdict.json"), parsed)
    return { status: parsed.status, message: parsed.message }
  }
  const preflight = async (input: Parameters<Evaluate>[0]) => {
    await verifyScriptChecker(input.settings)
  }
  return { descriptor, evaluate, preflight }
}
