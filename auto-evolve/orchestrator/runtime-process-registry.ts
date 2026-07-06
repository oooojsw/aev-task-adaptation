import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"
import path from "node:path"
import { pathExists, runtimePath } from "./fs"
import { readFile, rm } from "node:fs/promises"
import { writeFileAtomic } from "./atomic-write"

interface RegisteredRuntimeProcess {
  pid: number
  matcher?: string
  registeredAtMs: number
  creation?: string
}

interface WindowsProcessInfo {
  pid: number
  creation?: string
  commandLine?: string
}

interface WindowsProcessLineageInfo extends WindowsProcessInfo {
  name?: string
  executablePath?: string
  parentPid?: number
}

const scopeRegistry = new Map<string, RegisteredRuntimeProcess[]>()
let loaded = false
let pendingSave: Promise<void> = Promise.resolve()
let dirty = false

function registryPath() {
  return runtimePath(process.cwd(), "active-processes.json")
}

function cloneRegistry() {
  const obj: Record<string, RegisteredRuntimeProcess[]> = {}
  for (const [scope, rows] of scopeRegistry.entries()) {
    if (!rows.length) continue
    obj[scope] = rows
  }
  return obj
}

async function loadRegistry() {
  if (loaded) return
  loaded = true
  const file = registryPath()
  if (!(await pathExists(file))) return
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, RegisteredRuntimeProcess[]>
    for (const [scope, rows] of Object.entries(raw)) {
      if (!Array.isArray(rows)) continue
      const safe = rows.filter(
        (row) =>
          !!row &&
          typeof row === "object" &&
          typeof row.pid === "number" &&
          Number.isFinite(row.pid) &&
          row.pid > 0 &&
          typeof row.registeredAtMs === "number" &&
          Number.isFinite(row.registeredAtMs),
      )
      if (safe.length > 0) scopeRegistry.set(scope, safe)
    }
  } catch {}
}

async function writeRegistry() {
  const file = registryPath()
  const body = JSON.stringify(cloneRegistry(), null, 2)
  await writeFileAtomic(file, body, { attempts: 8, baseDelayMs: 80, maxDelayMs: 2000 })
}

async function flushRegistry() {
  await loadRegistry()
  dirty = true
  pendingSave = pendingSave.catch(() => undefined).then(async () => {
    while (dirty) {
      dirty = false
      await writeRegistry()
    }
  })
  await pendingSave
}

function normalizeMatcher(input: string | undefined) {
  if (typeof input !== "string") return undefined
  const trimmed = input.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export async function registerRuntimeProcess(scope: string | undefined, pid: number | undefined | null, matcher?: string) {
  if (!scope || typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return
  await loadRegistry()
  const creation = await readWindowsCreation(pid)
  const records = scopeRegistry.get(scope) ?? []
  if (!records.some((item) => item.pid === pid)) {
    records.push({
      pid,
      matcher: normalizeMatcher(matcher),
      registeredAtMs: Date.now(),
      creation,
    })
    scopeRegistry.set(scope, records)
    await flushRegistry()
  }
}
async function readWindowsCreation(pid: number) {
  if (process.platform !== "win32") return undefined
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const script = `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.Ticks`
    const child = Bun.spawn(["powershell", "-NoProfile", "-Command", script], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    if (exitCode === 0) {
      const out = stdout.trim()
      if (out.length > 0) return out
    }
    if (attempt < 2) await sleep(100 * attempt)
  }
  return undefined
}

async function batchQueryWindowsProcesses(pids: number[]) {
  const map = new Map<number, WindowsProcessInfo>()
  const ids = Array.from(new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0)))
  if (process.platform !== "win32" || ids.length === 0) return map

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$ids = @(${ids.join(",")})`,
    "$procs = Get-Process -Id $ids -ErrorAction SilentlyContinue",
    "foreach ($p in @($procs)) {",
    "  $cmd = ''",
    "  try {",
    "    $wmi = Get-CimInstance Win32_Process -Filter \"ProcessId = $($p.Id)\" -ErrorAction SilentlyContinue",
    "    if ($null -ne $wmi -and $null -ne $wmi.CommandLine) { $cmd = $wmi.CommandLine }",
    "  } catch {}",
    "  [PSCustomObject]@{ Id = $p.Id; Ticks = $p.StartTime.Ticks; CommandLine = $cmd } | ConvertTo-Json -Compress",
    "}",
  ].join("; ")

  const child = Bun.spawn(["powershell", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (exitCode !== 0) return map

  for (const line of stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    try {
      const raw = JSON.parse(line) as { Id?: unknown; Ticks?: unknown; CommandLine?: unknown }
      const pid = Number(raw.Id)
      if (!Number.isFinite(pid) || pid <= 0) continue
      map.set(pid, {
        pid,
        creation: typeof raw.Ticks === "number" || typeof raw.Ticks === "string" ? String(raw.Ticks) : undefined,
        commandLine: typeof raw.CommandLine === "string" && raw.CommandLine.trim().length > 0 ? raw.CommandLine : undefined,
      })
    } catch {}
  }

  return map
}

async function isProcessAlive(pid: number | undefined | null) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function isSameProcess(record: RegisteredRuntimeProcess) {
  if (!(await isProcessAlive(record.pid))) return false
  if (process.platform !== "win32") return true
  if (!record.creation || record.creation.trim().length === 0) return true
  const current = await readWindowsCreation(record.pid)
  if (!current) return false
  return current === record.creation
}

function isSameWindowsProcess(record: RegisteredRuntimeProcess, info: WindowsProcessInfo | undefined) {
  if (!info) return false
  if (!record.creation || record.creation.trim().length === 0) return true
  return info.creation === record.creation
}

function protectedDesktopOpenCodeRoots() {
  const raw = process.env.AUTO_EVOLVE_PROTECTED_OPENCODE_ROOTS?.trim()
  const roots = raw ? raw.split(";") : ["E:\\OpenCode"]
  return roots.map((item) => path.resolve(item.trim()).toLowerCase()).filter(Boolean)
}

function pathOrCommandMatchesProtectedRoot(input: string | undefined, roots: string[]) {
  if (!input) return false
  const normalized = input.replace(/\//g, "\\").toLowerCase()
  return roots.some((root) => normalized.includes(root.replace(/\//g, "\\")))
}

async function readWindowsProcessLineage(pid: number) {
  const rows: WindowsProcessLineageInfo[] = []
  if (process.platform !== "win32" || !Number.isFinite(pid) || pid <= 0) return rows

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$targetPid = ${Math.floor(pid)}`,
    "for ($i = 0; $i -lt 12 -and $targetPid -gt 0; $i++) {",
    "  $p = Get-CimInstance Win32_Process -Filter \"ProcessId = $targetPid\" -ErrorAction SilentlyContinue",
    "  if ($null -eq $p) { break }",
    "  [PSCustomObject]@{ Id = $p.ProcessId; Name = $p.Name; ParentProcessId = $p.ParentProcessId; CommandLine = $p.CommandLine; ExecutablePath = $p.ExecutablePath; CreationDate = $p.CreationDate } | ConvertTo-Json -Compress",
    "  $targetPid = [int]$p.ParentProcessId",
    "}",
  ].join("; ")

  const child = Bun.spawn(["powershell", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (exitCode !== 0) return rows

  for (const line of stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    try {
      const raw = JSON.parse(line) as {
        Id?: unknown
        Name?: unknown
        ParentProcessId?: unknown
        CommandLine?: unknown
        ExecutablePath?: unknown
        CreationDate?: unknown
      }
      const parsedPid = Number(raw.Id)
      if (!Number.isFinite(parsedPid) || parsedPid <= 0) continue
      rows.push({
        pid: parsedPid,
        name: typeof raw.Name === "string" ? raw.Name : undefined,
        parentPid: typeof raw.ParentProcessId === "number" ? raw.ParentProcessId : Number(raw.ParentProcessId),
        commandLine: typeof raw.CommandLine === "string" ? raw.CommandLine : undefined,
        executablePath: typeof raw.ExecutablePath === "string" ? raw.ExecutablePath : undefined,
        creation: typeof raw.CreationDate === "string" ? raw.CreationDate : undefined,
      })
    } catch {}
  }
  return rows
}

export async function isProtectedDesktopOpenCodeProcess(pid: number | undefined | null) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false
  if (process.platform !== "win32") return false

  const roots = protectedDesktopOpenCodeRoots()
  if (roots.length === 0) return false
  const lineage = await readWindowsProcessLineage(pid)
  const protectedLineageHit = lineage.some((row) => {
    const name = row.name?.toLowerCase() ?? ""
    if (name !== "opencode.exe" && name !== "opencode-cli.exe") return false
    return pathOrCommandMatchesProtectedRoot(row.executablePath, roots) || pathOrCommandMatchesProtectedRoot(row.commandLine, roots)
  })
  return protectedLineageHit
}

export async function terminateProcessTree(pid: number | undefined | null) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false
  if (pid === process.pid) return false
  if (!(await isProcessAlive(pid))) return false

  if (process.platform === "win32") {
    if (await isProtectedDesktopOpenCodeProcess(pid)) return false
    const child = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
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
  await loadRegistry()
  if (!scope) {
    return {
      scope: undefined,
      trackedCount: 0,
      killedCount: 0,
      skippedCount: 0,
      mismatchCount: 0,
      unreadableCount: 0,
      remainingCount: 0,
    }
  }

  const records = scopeRegistry.get(scope) ?? []
  const remaining: RegisteredRuntimeProcess[] = []

  let killedCount = 0
  let skippedCount = 0
  let mismatchCount = 0
  let unreadableCount = 0
  const windowsInfo =
    process.platform === "win32"
      ? await batchQueryWindowsProcesses(records.filter((record) => record.pid !== process.pid).map((record) => record.pid))
      : new Map<number, WindowsProcessInfo>()

  for (const record of records) {
    if (record.pid === process.pid) {
      skippedCount += 1
      remaining.push(record)
      continue
    }
    const same =
      process.platform === "win32" ? isSameWindowsProcess(record, windowsInfo.get(record.pid)) : await isSameProcess(record)
    if (!same) continue

    if (record.matcher && process.platform === "win32") {
      const commandLine = windowsInfo.get(record.pid)?.commandLine
      if (commandLine) {
        const matches = commandLine.toLowerCase().includes(record.matcher.toLowerCase())
        if (!matches) {
          mismatchCount += 1
          remaining.push(record)
          continue
        }
      } else {
        unreadableCount += 1
        remaining.push(record)
        continue
      }
    }

    if (await isProtectedDesktopOpenCodeProcess(record.pid)) {
      skippedCount += 1
      continue
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
  await flushRegistry()

  return {
    scope,
    trackedCount: records.length,
    killedCount,
    skippedCount,
    mismatchCount,
    unreadableCount,
    remainingCount: remaining.length,
  }
}

export async function cleanupAllRuntimeProcesses() {
  await loadRegistry()
  const scopes = Array.from(scopeRegistry.keys())
  let trackedCount = 0
  let killedCount = 0
  let skippedCount = 0
  let mismatchCount = 0
  let unreadableCount = 0
  let remainingCount = 0

  for (const scope of scopes) {
    const result = await cleanupRuntimeProcessScope(scope)
    trackedCount += result.trackedCount
    killedCount += result.killedCount
    skippedCount += result.skippedCount
    mismatchCount += result.mismatchCount
    unreadableCount += result.unreadableCount
    remainingCount += result.remainingCount
  }

  return {
    scopeCount: scopes.length,
    trackedCount,
    killedCount,
    skippedCount,
    mismatchCount,
    unreadableCount,
    remainingCount,
  }
}
