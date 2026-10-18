import process from "node:process"
import { spawn as nodeSpawn } from "node:child_process"
import { registerRuntimeProcess, terminateProcessTree } from "./runtime-process-registry"
import { spawnNoConsoleProxy } from "./windows-no-console-process"

export interface ManagedProcessInput {
  title: string
  command: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  inheritEnv?: boolean
  stdinText?: string
  runtimeScope?: string
  timeoutMs: number
  deadlineAt?: number
  silentTimeoutMs?: number
  silentTimeoutAfterActivityMs?: number
  pulseIntervalMs?: number
  backend?: "auto" | "direct" | "python_subprocess"
  onSpawn?: (signal?: AbortSignal) => Promise<void> | void
  onPulse?: (signal?: AbortSignal) => Promise<void> | void
  onStdoutChunk?: (chunk: Buffer) => void
  onStderrChunk?: (chunk: Buffer) => void
}

export interface ManagedProcessResult {
  processPID?: number
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  hardTimedOut: boolean
  silentTimedOut: boolean
  silentTimeoutAfterActivity: boolean
  observedRuntimeOutput: boolean
}

function resolveBackend(backend: ManagedProcessInput["backend"]) {
  if (backend && backend !== "auto") return backend
  return process.platform === "win32" ? "direct" : "direct"
}

// Normalize paths for libuv compatibility on Windows (MSYS2/Git Bash environment).
// On Windows, forward slashes are more reliable than backslashes when passing
// paths as command-line arguments through chain spawns (bun.exe → node → CreateProcessW).
// Backslashes can be consumed as escape sequences or mangled by intermediate layers.
function normalizePathForSpawn(p: string): string {
  if (process.platform !== "win32") return p
  // Convert MSYS2-style paths (/c/...) to Windows paths (C:/...)
  let normalized = p.replace(/^\/([a-z])\//i, (match, drive) => `${drive.toUpperCase()}:/`)
  // Normalize all separators to forward slashes
  normalized = normalized.replace(/\\/g, "/")
  // Collapse double slashes (but keep the leading C://)
  normalized = normalized.replace(/([^:])\/+/g, "$1/")
  return normalized
}

function normalizeArgForSpawn(arg: string): string {
  if (process.platform !== "win32") return arg
  if (!arg.includes("\\") && !/^\/[a-z]\//i.test(arg)) return arg
  return normalizePathForSpawn(arg)
}

// Ensure the cwd directory exists before spawning.
// On Windows, libuv's CreateProcessW fails with ENOENT if cwd doesn't exist,
// even when the exe itself is valid. We fall back to a parent dir.
function ensureValidCwd(p: string): string {
  if (process.platform !== "win32") return p
  const fs = require("node:fs")
  let normalized = normalizePathForSpawn(p)
  // Check each path component from deepest to shallowest
  while (normalized.length >= 3) {
    try {
      const stat = fs.statSync(normalized)
      if (stat.isDirectory()) return normalized
    } catch {
      // Try parent
      const parent = normalized.replace(/\/[^/]+$/, "")
      if (parent === normalized) break
      normalized = parent
    }
  }
  return "C:/"
}

function processRegistryTimeoutMs() {
  const raw = Number(process.env.AUTO_EVOLVE_PROCESS_REGISTRY_TIMEOUT_MS)
  if (Number.isFinite(raw) && raw > 0) return raw
  return 5_000
}

function isBrokenStdinPipe(error: unknown) {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : ""
  const message = error instanceof Error ? error.message : String(error)
  return (
    code === "EPIPE" ||
    code === "ERR_STREAM_DESTROYED" ||
    /broken pipe|stream.*destroyed|write after end/i.test(message)
  )
}

async function writeStdinAndEnd(
  stdin: NodeJS.WritableStream | null | undefined,
  text: string | undefined,
): Promise<{ ok: boolean; message?: string }> {
  if (!stdin) {
    if (typeof text === "string" && text.length > 0) {
      return { ok: false, message: "stdin pipe was unavailable before payload could be written" }
    }
    return { ok: true }
  }
  try {
    stdin.setDefaultEncoding("utf8")
    if (typeof text !== "string") {
      stdin.end()
      return { ok: true }
    }
    return await new Promise((resolve) => {
      let settled = false
      const finish = (result: { ok: boolean; message?: string }) => {
        if (settled) return
        settled = true
        stdin.off?.("error", onError)
        resolve(result)
      }
      const onError = (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        if (isBrokenStdinPipe(error)) {
          finish({ ok: false, message: `stdin pipe closed while writing payload: ${detail}` })
          return
        }
        finish({ ok: false, message: `stdin write failed: ${detail}` })
      }
      stdin.once?.("error", onError)
      try {
        stdin.write(text, (error?: Error | null) => {
          if (error) {
            onError(error)
            return
          }
          try {
            stdin.end()
          } catch (endError) {
            onError(endError)
            return
          }
          finish({ ok: true })
        })
      } catch (error) {
        onError(error)
      }
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (isBrokenStdinPipe(error)) {
      return { ok: false, message: `stdin pipe closed before payload could be written: ${detail}` }
    }
    return { ok: false, message: `stdin setup failed: ${detail}` }
  }
}

async function waitRegistry(promise: Promise<void>, ms: number) {
  let handle: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        handle = setTimeout(resolve, ms)
      }),
    ])
  } finally {
    if (handle) clearTimeout(handle)
  }
}

function buildPythonWrapperCode() {
  return [
    "import json, os, subprocess, sys",
    "payload = json.loads(sys.stdin.buffer.read().decode('utf-8'))",
    "cmd = payload['command']",
    "cwd = payload.get('cwd') or None",
    "stdin_text = payload.get('stdin_text')",
    "env = os.environ.copy()",
    "extra_env = payload.get('env') or {}",
    "for key, value in extra_env.items():",
    "    if value is None:",
    "        env.pop(key, None)",
    "    else:",
    "        env[str(key)] = str(value)",
    "proc = subprocess.Popen(",
    "    cmd,",
    "    cwd=cwd,",
    "    stdout=subprocess.PIPE,",
    "    stderr=subprocess.PIPE,",
    "    stdin=subprocess.PIPE if stdin_text is not None else None,",
    "    env=env,",
    ")",
    "stdout_bytes, stderr_bytes = proc.communicate(",
    "    None if stdin_text is None else stdin_text.encode('utf-8')",
    ")",
    "sys.stdout.buffer.write(stdout_bytes)",
    "sys.stderr.buffer.write(stderr_bytes)",
    "sys.exit(proc.returncode)",
  ].join("\n")
}

export async function runManagedProcess(input: ManagedProcessInput): Promise<ManagedProcessResult> {
  if (input.deadlineAt !== undefined && (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= Date.now())) {
    throw new Error("Managed process deadline expired before spawn")
  }
  if (!input.command[0]) {
    throw new Error(`Managed process ${input.title} has no executable command.`)
  }
  for (const arg of input.command) {
    if (typeof arg !== "string") {
      throw new Error(`Managed process ${input.title} has a non-string command argument.`)
    }
  }

  const backend = resolveBackend(input.backend)
  // 隔离预检只继承显式环境，旧调用仍保持原来的环境合并。
  const environment = input.inheritEnv === false ? { ...input.env } : { ...process.env, ...input.env }
  const proxy =
    process.platform === "win32"
      ? spawnNoConsoleProxy({
          command: input.command,
          cwd: ensureValidCwd(input.cwd),
          env: environment,
          stdinText: input.stdinText,
          title: input.title,
        })
      : backend === "python_subprocess"
        ? nodeSpawn("python", ["-c", buildPythonWrapperCode()], {
            cwd: ensureValidCwd(input.cwd),
            env: environment,
            stdio: ["pipe", "pipe", "pipe"],
            shell: false,
            windowsHide: true,
          })
        : nodeSpawn(normalizePathForSpawn(input.command[0] ?? ""), input.command.slice(1).map(normalizeArgForSpawn), {
            cwd: ensureValidCwd(input.cwd),
            env: environment,
            stdio: ["pipe", "pipe", "pipe"],
            shell: false,
            windowsHide: true,
          })
  const child = "child" in proxy ? proxy.child : proxy
  let stdoutData = ""
  let stderrData = ""
  let timedOut = false
  let hardTimedOut = false
  let silentTimedOut = false
  let silentTimeoutAfterActivity = false
  let observedRuntimeOutput = false
  let closed = false
  const controller = input.deadlineAt === undefined ? undefined : new AbortController()
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let silentTimeoutHandle: ReturnType<typeof setTimeout> | undefined
  let refreshSilentTimeout: (() => void) | undefined
  let startTimeouts: (() => void) | undefined

  const exitPromise = new Promise<number>((resolve) => {
    child.on("exit", (code) => {
      closed = true
      resolve(code ?? 0)
    })
    child.on("error", () => {
      closed = true
      resolve(1)
    })
  })
  const timeoutPromise = new Promise<number>((resolve) => {
    let settled = false
    const killAndResolve = async (kind: "hard" | "silent") => {
      if (settled) return
      settled = true
      timedOut = true
      controller?.abort()
      if (kind === "hard") hardTimedOut = true
      if (kind === "silent") {
        silentTimedOut = true
        silentTimeoutAfterActivity = observedRuntimeOutput
      }
      let terminated = false
      try {
        terminated = await terminateProcessTree(child.pid)
      } catch {}
      // 终止未确认时保持调用和gate，不能放行另一个写者。
      if (controller && !terminated && !closed) {
        stderrData += "[managed-process] termination unconfirmed; awaiting actual child exit.\n"
        await exitPromise
      }
      resolve(124)
    }
    const start = () => {
      timeoutHandle = setTimeout(
        async () => {
          await killAndResolve("hard")
        },
        input.deadlineAt === undefined
          ? input.timeoutMs
          : Math.max(0, Math.min(input.timeoutMs, input.deadlineAt - Date.now())),
      )
    }
    const startSilent = () => {
      if (typeof input.silentTimeoutMs !== "number" || input.silentTimeoutMs <= 0) return
      refreshSilentTimeout = () => {
        if (silentTimeoutHandle) clearTimeout(silentTimeoutHandle)
        const nextSilentTimeoutMs =
          observedRuntimeOutput &&
          typeof input.silentTimeoutAfterActivityMs === "number" &&
          input.silentTimeoutAfterActivityMs > 0
            ? input.silentTimeoutAfterActivityMs
            : input.silentTimeoutMs
        silentTimeoutHandle = setTimeout(async () => {
          await killAndResolve("silent")
        }, nextSilentTimeoutMs)
      }
      refreshSilentTimeout()
    }
    startTimeouts = () => {
      start()
      startSilent()
    }
  })

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutData += chunk.toString("utf8")
    observedRuntimeOutput = true
    refreshSilentTimeout?.()
    input.onStdoutChunk?.(chunk)
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrData += chunk.toString("utf8")
    observedRuntimeOutput = true
    refreshSilentTimeout?.()
    input.onStderrChunk?.(chunk)
  })

  const abortAfterSpawn = async (cause: unknown): Promise<never> => {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    controller?.abort()
    let terminated = false
    try {
      terminated = await terminateProcessTree(child.pid)
    } catch {}
    if (controller && !terminated && !closed) await exitPromise
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (silentTimeoutHandle) clearTimeout(silentTimeoutHandle)
    throw error
  }

  // 有绝对期限的调用在任何异步启动步骤前计时，旧调用保持旧时序。
  if (input.deadlineAt !== undefined) startTimeouts?.()
  try {
    const initialize = async () => {
      const ms = processRegistryTimeoutMs()
      const started = Date.now()
      let registryError: unknown
      const registry = registerRuntimeProcess(input.runtimeScope, child.pid, input.title).catch((error) => {
        registryError = error
      })
      await waitRegistry(registry, ms)
      if (timedOut || (input.deadlineAt !== undefined && closed)) return
      if (registryError) {
        const message = registryError instanceof Error ? registryError.message : String(registryError)
        stderrData += `[managed-process] process registry failed: ${message}\n`
      } else if (Date.now() - started >= ms) {
        stderrData += `[managed-process] process registry did not finish within ${ms}ms; continuing task execution.\n`
      }

      const stdinPayload =
        "stdinPayload" in proxy
          ? proxy.stdinPayload
          : backend === "python_subprocess"
            ? JSON.stringify({
                command: input.command,
                cwd: input.cwd,
                env: input.env ?? {},
                stdin_text: input.stdinText,
              })
            : input.stdinText
      const stdinWrite = await writeStdinAndEnd(child.stdin, stdinPayload)
      if (timedOut || (input.deadlineAt !== undefined && closed)) return
      if (!stdinWrite.ok) {
        stderrData += `[managed-process] ${stdinWrite.message}. Treating child as a controlled process failure instead of crashing orchestrator.\n`
      }

      await input.onSpawn?.(controller?.signal)
      if (timedOut || (input.deadlineAt !== undefined && closed)) return
      await input.onPulse?.(controller?.signal)
    }
    if (input.deadlineAt === undefined) await initialize()
    else await Promise.race([initialize(), timeoutPromise, exitPromise])
  } catch (error) {
    return abortAfterSpawn(error)
  }

  const pulseHandle = setInterval(() => {
    if (timedOut) return
    void Promise.resolve(input.onPulse?.(controller?.signal)).catch(() => undefined)
    if (observedRuntimeOutput) refreshSilentTimeout?.()
  }, input.pulseIntervalMs ?? 60_000)

  if (input.deadlineAt === undefined) startTimeouts?.()
  const code = await Promise.race([exitPromise, timeoutPromise])
  if (input.deadlineAt !== undefined && timedOut) {
    await timeoutPromise
    await exitPromise
  }
  const exitCode = input.deadlineAt !== undefined && timedOut ? 124 : code
  if (timeoutHandle) clearTimeout(timeoutHandle)
  if (silentTimeoutHandle) clearTimeout(silentTimeoutHandle)
  clearInterval(pulseHandle)

  return {
    ...(input.deadlineAt !== undefined ? { processPID: child.pid } : {}),
    exitCode,
    stdout: stdoutData,
    stderr: stderrData,
    timedOut,
    hardTimedOut,
    silentTimedOut,
    silentTimeoutAfterActivity,
    observedRuntimeOutput,
  }
}
