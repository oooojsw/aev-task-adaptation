import process from "node:process"
import { spawn as nodeSpawn } from "node:child_process"
import { registerRuntimeProcess, terminateProcessTree } from "./runtime-process-registry"

export interface ManagedProcessInput {
  title: string
  command: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  stdinText?: string
  runtimeScope?: string
  timeoutMs: number
  silentTimeoutMs?: number
  silentTimeoutAfterActivityMs?: number
  pulseIntervalMs?: number
  backend?: "auto" | "direct" | "python_subprocess"
  onSpawn?: () => Promise<void> | void
  onPulse?: () => Promise<void> | void
  onStdoutChunk?: (chunk: Buffer) => void
  onStderrChunk?: (chunk: Buffer) => void
}

export interface ManagedProcessResult {
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
  if (!input.command[0]) {
    throw new Error(`Managed process ${input.title} has no executable command.`)
  }
  for (const arg of input.command) {
    if (typeof arg !== "string") {
      throw new Error(`Managed process ${input.title} has a non-string command argument.`)
    }
  }

  const backend = resolveBackend(input.backend)
  const child =
    backend === "python_subprocess"
      ? nodeSpawn("cmd.exe", ["/c", "python"], {
          cwd: input.cwd,
          env: {
            ...process.env,
            ...input.env,
          },
          stdio: ["pipe", "pipe", "pipe"],
          shell: true,
        })
      : nodeSpawn(normalizePathForSpawn(input.command[0] ?? ""), input.command.slice(1).map(normalizeArgForSpawn), {
          cwd: ensureValidCwd(input.cwd),
          env: (() => {
            const env: NodeJS.ProcessEnv = {
              ...process.env,
              ...input.env,
            }
            return env
          })(),
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        })
  let stdoutData = ""
  let stderrData = ""
  let timedOut = false
  let hardTimedOut = false
  let silentTimedOut = false
  let silentTimeoutAfterActivity = false
  let observedRuntimeOutput = false
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let silentTimeoutHandle: ReturnType<typeof setTimeout> | undefined
  let refreshSilentTimeout: (() => void) | undefined
  let startTimeouts: (() => void) | undefined

  const exitPromise = new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 0))
    child.on("error", () => resolve(1))
  })
  const timeoutPromise = new Promise<number>((resolve) => {
    let settled = false
    const killAndResolve = async (kind: "hard" | "silent") => {
      if (settled) return
      settled = true
      timedOut = true
      if (kind === "hard") hardTimedOut = true
      if (kind === "silent") {
        silentTimedOut = true
        silentTimeoutAfterActivity = observedRuntimeOutput
      }
      try {
        await terminateProcessTree(child.pid)
      } catch {}
      resolve(124)
    }
    const start = () => {
      timeoutHandle = setTimeout(async () => {
        await killAndResolve("hard")
      }, input.timeoutMs)
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
    try {
      await terminateProcessTree(child.pid)
    } catch {}
    throw error
  }

  try {
    const ms = processRegistryTimeoutMs()
    const started = Date.now()
    let registryError: unknown
    const registry = registerRuntimeProcess(input.runtimeScope, child.pid, input.title).catch((error) => {
      registryError = error
    })
    await waitRegistry(registry, ms)
    if (registryError) {
      const message = registryError instanceof Error ? registryError.message : String(registryError)
      stderrData += `[managed-process] process registry failed: ${message}\n`
    } else if (Date.now() - started >= ms) {
      stderrData += `[managed-process] process registry did not finish within ${ms}ms; continuing task execution.\n`
    }

    if (backend === "python_subprocess") {
      const wrapperPayload = JSON.stringify({
        command: input.command,
        cwd: input.cwd,
        env: input.env ?? {},
        stdin_text: input.stdinText,
      })
      child.stdin?.setDefaultEncoding("utf8")
      child.stdin?.write(wrapperPayload)
      child.stdin?.end()
    } else if (typeof input.stdinText === "string") {
      child.stdin?.setDefaultEncoding("utf8")
      child.stdin?.write(input.stdinText)
      child.stdin?.end()
    } else {
      child.stdin?.end()
    }

    await input.onSpawn?.()
    await input.onPulse?.()
  } catch (error) {
    return abortAfterSpawn(error)
  }

  const pulseHandle = setInterval(() => {
    void Promise.resolve(input.onPulse?.()).catch(() => undefined)
    if (observedRuntimeOutput) refreshSilentTimeout?.()
  }, input.pulseIntervalMs ?? 60_000)

  startTimeouts?.()
  const exitCode = await Promise.race([exitPromise, timeoutPromise])
  if (timeoutHandle) clearTimeout(timeoutHandle)
  if (silentTimeoutHandle) clearTimeout(silentTimeoutHandle)
  clearInterval(pulseHandle)

  return {
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
