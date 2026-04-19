import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"

interface RegisteredRuntimeProcess {
  pid: number
  matcher?: string
  registeredAtMs: number
}

const scopeRegistry = new Map<string, RegisteredRuntimeProcess[]>()
const PROCESS_REUSE_SAFE_WINDOW_MS = 2 * 60 * 60 * 1000
const PROCESS_MISMATCH_FORCE_KILL_WINDOW_MS = 15 * 60 * 1000

function normalizeMatcher(input: string | undefined) {
  if (typeof input !== "string") return undefined
  const trimmed = input.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function registerRuntimeProcess(scope: string | undefined, pid: number | undefined | null, matcher?: string) {
  if (!scope || typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return
  const records = scopeRegistry.get(scope) ?? []
  if (!records.some((item) => item.pid === pid)) {
    records.push({
      pid,
      matcher: normalizeMatcher(matcher),
      registeredAtMs: Date.now(),
    })
    scopeRegistry.set(scope, records)
  }
}

async function readWindowsCommandLine(pid: number) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$proc = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
      "if ($null -eq $proc) { exit 2 }",
      "Write-Output ($proc.CommandLine ?? '')",
    ].join("; ")
    const child = Bun.spawn(["powershell", "-NoProfile", "-Command", script], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    if (exitCode === 0) {
      const normalized = stdout.trim()
      if (normalized.length > 0) return normalized
    }
    if (attempt < 3) await sleep(100 * attempt)
  }
  return undefined
}

async function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function terminateProcessTree(pid: number) {
  if (pid === process.pid) return false
  if (!(await isProcessAlive(pid))) return false

  if (process.platform === "win32") {
    const child = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    await child.exited.catch(() => 1)
    await sleep(150)
    return !(await isProcessAlive(pid))
  }

  try {
    process.kill(pid, "SIGTERM")
  } catch {}
  await sleep(150)
  if (await isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  return !(await isProcessAlive(pid))
}

export function campaignRoundRuntimeScope(campaignID: string, roundNumber: number) {
  return `campaign:${campaignID}:round:${String(roundNumber).padStart(3, "0")}`
}

export function longTaskRunRuntimeScope(runID: string) {
  return `long-task:${runID}`
}

export async function cleanupRuntimeProcessScope(scope: string | undefined) {
  if (!scope) {
    return {
      scope: undefined,
      trackedCount: 0,
      killedCount: 0,
      skippedCount: 0,
      remainingCount: 0,
    }
  }

  const records = scopeRegistry.get(scope) ?? []
  const remaining: RegisteredRuntimeProcess[] = []

  let killedCount = 0
  let skippedCount = 0

  for (const record of records) {
    if (record.pid === process.pid) {
      skippedCount += 1
      remaining.push(record)
      continue
    }
    const alive = await isProcessAlive(record.pid)
    if (!alive) continue

    if (record.matcher && process.platform === "win32") {
      const commandLine = await readWindowsCommandLine(record.pid)
      if (commandLine) {
        const matches = commandLine.toLowerCase().includes(record.matcher.toLowerCase())
        if (!matches) {
          // Be stricter right after registration: PID reuse is unlikely in a short window,
          // so prefer cleanup to avoid orphan runtime children after round finalization.
          const ageMs = Date.now() - record.registeredAtMs
          if (ageMs > PROCESS_MISMATCH_FORCE_KILL_WINDOW_MS) {
            skippedCount += 1
            remaining.push(record)
            continue
          }
        }
      } else {
        // If commandline introspection fails on Windows, avoid leaking recent
        // tracked processes forever. For old registrations, keep conservative.
        const ageMs = Date.now() - record.registeredAtMs
        if (ageMs > PROCESS_REUSE_SAFE_WINDOW_MS) {
          skippedCount += 1
          remaining.push(record)
          continue
        }
      }
    }

    const killed = await terminateProcessTree(record.pid)
    if (killed) {
      killedCount += 1
    } else {
      skippedCount += 1
      if (await isProcessAlive(record.pid)) remaining.push(record)
    }
  }

  if (remaining.length > 0) {
    scopeRegistry.set(scope, remaining)
  } else {
    scopeRegistry.delete(scope)
  }

  return {
    scope,
    trackedCount: records.length,
    killedCount,
    skippedCount,
    remainingCount: remaining.length,
  }
}
