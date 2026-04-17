import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"

interface RegisteredRuntimeProcess {
  pid: number
  matcher?: string
}

const scopeRegistry = new Map<string, RegisteredRuntimeProcess[]>()

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
    })
    scopeRegistry.set(scope, records)
  }
}

async function readWindowsCommandLine(pid: number) {
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
  if (exitCode !== 0) return undefined
  return stdout.trim()
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

export async function cleanupRuntimeProcessScope(scope: string | undefined) {
  if (!scope) {
    return {
      scope: undefined,
      trackedCount: 0,
      killedCount: 0,
      skippedCount: 0,
    }
  }

  const records = scopeRegistry.get(scope) ?? []
  scopeRegistry.delete(scope)

  let killedCount = 0
  let skippedCount = 0

  for (const record of records) {
    if (record.pid === process.pid) {
      skippedCount += 1
      continue
    }
    const alive = await isProcessAlive(record.pid)
    if (!alive) continue

    if (record.matcher && process.platform === "win32") {
      const commandLine = await readWindowsCommandLine(record.pid)
      if (!commandLine || !commandLine.includes(record.matcher)) {
        skippedCount += 1
        continue
      }
    }

    const killed = await terminateProcessTree(record.pid)
    if (killed) {
      killedCount += 1
    } else {
      skippedCount += 1
    }
  }

  return {
    scope,
    trackedCount: records.length,
    killedCount,
    skippedCount,
  }
}
