import { spawn } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"

export type ProcessOwnership = "owned" | "wrong_owner" | "unknown_owner" | "dead"

export interface ProcessIdentityInput {
  pid: unknown
  /** Legacy strict hints. Prefer requiredCommandHints/requiredAnyCommandHints for new call sites. */
  commandHints?: string[]
  /** Every hint listed here must appear in the command line when it is readable. */
  requiredCommandHints?: string[]
  /** At least one hint listed here must appear in the command line when it is readable. */
  requiredAnyCommandHints?: string[]
  /** Optional hints never prove identity by themselves. They are only extra supporting evidence. */
  optionalCommandHints?: string[]
  expectedCreationTick?: string
  heartbeatAt?: string
  updatedAt?: string
  staleAfterMs?: number
}

export interface ProcessIdentityResult {
  pid?: number
  alive: boolean
  ownership: ProcessOwnership
  commandLine?: string
  creationTick?: string
  reason: string
}

interface WindowsProcessIdentity {
  commandLine?: string
  creationTick?: string
}

let currentProcessCreationTick: Promise<string | undefined> | undefined

function parsePID(pid: unknown) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return undefined
  return Math.floor(pid)
}

function isSignalAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function parseMs(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function isFresh(input: ProcessIdentityInput) {
  if (!input.staleAfterMs || input.staleAfterMs <= 0) return undefined
  const reference = parseMs(input.heartbeatAt) ?? parseMs(input.updatedAt)
  if (typeof reference !== "number") return undefined
  return Date.now() - reference <= input.staleAfterMs
}

function normalizedHints(hints: string[] | undefined) {
  return (hints ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean)
}

export function isGenericProcessOwnerHint(commandHint: string | undefined) {
  const normalized = commandHint?.trim().toLowerCase()
  return (
    normalized === "run-long-task-campaign" ||
    normalized === "resume-long-task-campaign" ||
    normalized === "run-long-task"
  )
}

export function strongProcessOwnerHints(hints: Array<string | undefined>) {
  return hints.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0 && !isGenericProcessOwnerHint(item),
  )
}

export function optionalProcessOwnerHints(hints: Array<string | undefined>) {
  return hints.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0 && isGenericProcessOwnerHint(item),
  )
}

function commandContains(commandLine: string, hint: string) {
  return commandLine.includes(hint.replace(/\//g, "\\"))
}

function evaluateCommandHints(commandLine: string | undefined, input: ProcessIdentityInput) {
  const legacyHints = normalizedHints(input.commandHints)
  const requiredAll = normalizedHints(input.requiredCommandHints)
  const requiredAny = normalizedHints(input.requiredAnyCommandHints)
  const optional = normalizedHints(input.optionalCommandHints)
  const usesNewHints = requiredAll.length > 0 || requiredAny.length > 0 || optional.length > 0
  if (!commandLine) return undefined
  const normalized = commandLine.replace(/\//g, "\\").toLowerCase()
  if (usesNewHints) {
    // Optional hints are supporting evidence only; they must never prove ownership alone.
    if (requiredAll.length === 0 && requiredAny.length === 0) return undefined
    if (requiredAll.some((hint) => !commandContains(normalized, hint))) return false
    if (requiredAny.length > 0 && !requiredAny.some((hint) => commandContains(normalized, hint))) return false
    return true
  }
  if (legacyHints.length === 0) return true
  return legacyHints.every((hint) => commandContains(normalized, hint))
}

async function readWindowsProcessIdentity(pid: number): Promise<WindowsProcessIdentity | undefined> {
  if (process.platform !== "win32") return undefined
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
    "if ($null -ne $p) {",
    "  $ticks = ''",
    "  try { $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue; if ($null -ne $gp) { $ticks = [string]$gp.StartTime.Ticks } } catch {}",
    "  $cmd = ''",
    "  if ($null -ne $p.CommandLine) { $cmd = [string]$p.CommandLine }",
    "  [PSCustomObject]@{ CommandLine = $cmd; CreationTick = $ticks } | ConvertTo-Json -Compress",
    "}",
  ].join("; ")
  const child = spawn("powershell", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  })
  let stdout = ""
  child.stdout?.setEncoding("utf8")
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk)
  })
  const exitCode = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(1))
    child.on("exit", (code) => resolve(code ?? 1))
  })
  if (exitCode !== 0) return undefined
  const out = stdout.trim()
  if (!out) return undefined
  try {
    const raw = JSON.parse(out) as { CommandLine?: unknown; CreationTick?: unknown }
    return {
      commandLine: typeof raw.CommandLine === "string" && raw.CommandLine.trim().length > 0 ? raw.CommandLine : undefined,
      creationTick:
        typeof raw.CreationTick === "string" && raw.CreationTick.trim().length > 0 ? raw.CreationTick.trim() : undefined,
    }
  } catch {
    return { commandLine: out }
  }
}

export async function readCurrentProcessCreationTick() {
  if (process.platform !== "win32") return undefined
  currentProcessCreationTick ??= readWindowsProcessIdentity(process.pid).then((info) => info?.creationTick)
  return currentProcessCreationTick
}

export async function identifyProcessOwner(input: ProcessIdentityInput): Promise<ProcessIdentityResult> {
  const pid = parsePID(input.pid)
  if (!pid) return { alive: false, ownership: "dead", reason: "missing or invalid pid" }
  if (pid === process.pid) return { pid, alive: true, ownership: "owned", reason: "current process" }
  if (!isSignalAlive(pid)) return { pid, alive: false, ownership: "dead", reason: "pid is not alive" }

  const hasHints =
    normalizedHints(input.commandHints).length > 0 ||
    normalizedHints(input.requiredCommandHints).length > 0 ||
    normalizedHints(input.requiredAnyCommandHints).length > 0 ||
    normalizedHints(input.optionalCommandHints).length > 0
  if (process.platform !== "win32") {
    return { pid, alive: true, ownership: hasHints ? "unknown_owner" : "owned", reason: "non-windows signal check only" }
  }

  let identity: WindowsProcessIdentity | undefined
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    identity = await readWindowsProcessIdentity(pid)
    if (identity?.commandLine || identity?.creationTick) break
    if (attempt < 2) await sleep(80)
  }
  const commandLine = identity?.commandLine
  const creationTick = identity?.creationTick

  const expectedCreationTick = input.expectedCreationTick?.trim()
  if (expectedCreationTick && creationTick && creationTick !== expectedCreationTick) {
    return { pid, alive: true, ownership: "wrong_owner", commandLine, creationTick, reason: "creation tick did not match" }
  }

  const matched = evaluateCommandHints(commandLine, input)
  if (matched === true) return { pid, alive: true, ownership: "owned", commandLine, creationTick, reason: "identity matched" }
  if (matched === false) return { pid, alive: true, ownership: "wrong_owner", commandLine, creationTick, reason: "required command identity did not match" }

  const fresh = isFresh(input)
  if (fresh === true) return { pid, alive: true, ownership: "unknown_owner", creationTick, reason: "command line unreadable but heartbeat is fresh" }
  if (fresh === false) return { pid, alive: true, ownership: "wrong_owner", creationTick, reason: "command line unreadable and heartbeat is stale" }
  return { pid, alive: true, ownership: "unknown_owner", creationTick, reason: "command line unreadable" }
}
