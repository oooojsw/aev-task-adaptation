import path from "node:path"
import process from "node:process"
import { openSync } from "node:fs"
import { spawn } from "node:child_process"
import { ensureDirectory, pathExists, readJsonFile, runtimePath, writeJsonFile } from "./fs"
import type { AutoEvolveConfig } from "./schema"

interface DashboardState {
  version: number
  pid: number
  url: string
  hostname: string
  port: number
  startedAt: number
  logFile: string
}

export interface MonitorEnsureResult {
  enabled: boolean
  url?: string
  reused: boolean
  started: boolean
}

function dashboardUrl(hostname: string, port: number) {
  const effectiveHost = hostname === "0.0.0.0" ? "127.0.0.1" : hostname
  return `http://${effectiveHost}:${port}`
}

async function isDashboardHealthy(url: string) {
  try {
    const response = await fetch(`${url}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return false
    const data = (await response.json()) as { healthy?: boolean }
    return data.healthy === true
  } catch {
    return false
  }
}

async function waitForDashboard(url: string, timeoutMs = 15000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await isDashboardHealthy(url)) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

function openBrowser(url: string) {
  if (process.platform === "win32") {
    const child = spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    })
    child.unref()
    return
  }
  if (process.platform === "darwin") {
    const child = spawn("open", [url], {
      detached: true,
      stdio: "ignore",
    })
    child.unref()
    return
  }
  const child = spawn("xdg-open", [url], {
    detached: true,
    stdio: "ignore",
  })
  child.unref()
}

async function readDashboardState(statePath: string) {
  if (!(await pathExists(statePath))) return undefined
  try {
    return await readJsonFile<DashboardState>(statePath)
  } catch {
    return undefined
  }
}

export async function ensureExperimentMonitor(cwd: string, config: AutoEvolveConfig): Promise<MonitorEnsureResult> {
  const monitor = config.monitorConfig
  if (!monitor.enabled || !monitor.autoStart) {
    return {
      enabled: false,
      reused: false,
      started: false,
    }
  }

  const url = dashboardUrl(monitor.hostname, monitor.port)
  if (await isDashboardHealthy(url)) {
    return {
      enabled: true,
      url,
      reused: true,
      started: false,
    }
  }

  const runtimeDir = runtimePath(cwd, "monitor")
  const statePath = path.join(runtimeDir, "session-dashboard.json")
  const logFile = path.join(runtimeDir, "session-dashboard.log")
  await ensureDirectory(runtimeDir)

  const existingState = await readDashboardState(statePath)
  if (existingState?.url === url && (await isDashboardHealthy(existingState.url))) {
    return {
      enabled: true,
      url: existingState.url,
      reused: true,
      started: false,
    }
  }

  const stdoutFd = openSync(logFile, "a")
  const stderrFd = openSync(logFile, "a")
  const child = spawn(
    process.execPath,
    [
      "run",
      "auto-evolve/monitor-server.ts",
      "--hostname",
      monitor.hostname,
      "--port",
      String(monitor.port),
      "--interval",
      String(monitor.intervalSeconds),
      "--limit",
      String(monitor.defaultLimit),
      "--no-open",
    ],
    {
      cwd,
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
      env: process.env,
    },
  )
  child.unref()

  const healthy = await waitForDashboard(url)
  if (!healthy) {
    throw new Error(`Session dashboard failed to start at ${url}. Check ${logFile}`)
  }

  await writeJsonFile(statePath, {
    version: 1,
    pid: child.pid ?? -1,
    url,
    hostname: monitor.hostname,
    port: monitor.port,
    startedAt: Date.now(),
    logFile,
  } satisfies DashboardState)

  if (monitor.openBrowserOnStart) {
    openBrowser(url)
  }

  return {
    enabled: true,
    url,
    reused: false,
    started: true,
  }
}
