import path from "node:path"
import process from "node:process"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { copyFile, readFile, readdir, rm, stat } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { buildActionTrace } from "./action-trace"
import type { AutoEvolveConfig, LoadedPermissionConfig } from "./schema"
import type { ToolFailure } from "./evaluator"
import {
  ensureDirectory,
  isPathWithinTruthRoot,
  pathExists,
  runtimePath,
  runtimeRoot,
  writeJsonFile,
  writeTextFile,
} from "./fs"
import { runManagedProcess } from "./managed-process"
import { OpenCodeGate } from "./opencode-gate"
import {
  resolveTaskArtifactKind,
  taskArtifactPaths,
  type TaskArtifactInput,
  type TaskArtifactStatus,
} from "./task-artifacts"
import { createTaskDescriptor } from "./task-model"

const OPENCODE_TASK_TIMEOUT_MS = 60 * 60 * 1000
const OPENCODE_PROMPT_SOFT_BUDGET_MS = 30 * 60 * 1000
const OPENCODE_TASK_SILENT_TIMEOUT_MS = (() => {
  const value = Number.parseInt(process.env.AUTO_EVOLVE_OPENCODE_SILENT_TIMEOUT_MS ?? "", 10)
  if (Number.isFinite(value) && value > 0) return value
  return 15 * 60 * 1000
})()
const OPENCODE_TASK_SILENT_TIMEOUT_AFTER_ACTIVITY_MS = (() => {
  const value = Number.parseInt(process.env.AUTO_EVOLVE_OPENCODE_SILENT_TIMEOUT_AFTER_ACTIVITY_MS ?? "", 10)
  if (Number.isFinite(value) && value > 0) return value
  // Once runtime output has started, prefer hard-timeout guard and avoid
  // prematurely terminating long silent compute windows.
  return Math.min(OPENCODE_TASK_TIMEOUT_MS, Math.max(OPENCODE_TASK_SILENT_TIMEOUT_MS, 60 * 60 * 1000))
})()
const OPENCODE_PROMPT_INLINE_TEXT_FILE_MAX_BYTES = 256 * 1024
const OPENCODE_PROMPT_INLINE_TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl", ".yaml", ".yml"])

export interface OpencodeEvent {
  type: string
  timestamp?: number
  sessionID?: string
  part?: any
  error?: any
}

export interface OpencodeRunResult {
  sessionID?: string
  exitCode: number
  finishReason?: string
  stdout: string
  stderr: string
  events: OpencodeEvent[]
  responseText: string
  toolFailures: ToolFailure[]
}

export interface OpencodeTaskRun {
  title: string
  prompt: string
  selectedModel?: string
  selectedAgent?: string
  selectedVariant?: string
  referencedPaths: string[]
  attachedFiles: string[]
  promptInlineFiles: string[]
  permissionReadPaths: string[]
  permissionEditPaths: string[]
  result: OpencodeRunResult
}

export interface OpencodeTaskInput {
  cwd: string
  config: AutoEvolveConfig
  title: string
  prompt: string
  referencePaths?: string[]
  attachedFiles?: string[]
  promptInlineFiles?: string[]
  permissionReadPaths?: string[]
  permissionEditPaths?: string[]
  model?: string
  agent?: string
  variant?: string
  runtimeScope?: string
  concurrencyScope?: string
  injectPlatformSafetyRules?: boolean
  isolateHostRuntime?: boolean
  onSpawn?: () => Promise<void> | void
  onPulse?: () => Promise<void> | void
  live?: TaskArtifactInput & {
    stageDir: string
  }
}

interface IsolatedHostRuntime {
  root: string
  env: NodeJS.ProcessEnv
}

let staleRuntimeCleanupStarted = false

function envFlag(name: string, defaultValue: boolean) {
  const raw = process.env[name]
  if (typeof raw !== "string") return defaultValue
  const normalized = raw.trim().toLowerCase()
  if (!normalized) return defaultValue
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  return defaultValue
}

function envNumber(name: string, defaultValue: number) {
  const raw = Number.parseInt(process.env[name] ?? "", 10)
  return Number.isFinite(raw) && raw > 0 ? raw : defaultValue
}

function shouldIsolateHostRuntime(input: OpencodeTaskInput) {
  if (typeof input.isolateHostRuntime === "boolean") return input.isolateHostRuntime
  return envFlag("AUTO_EVOLVE_OPENCODE_ISOLATE_RUNTIME", true)
}

function shouldCleanupOpencodeRuntime() {
  return envFlag("AUTO_EVOLVE_OPENCODE_CLEAN_RUNTIME", true)
}

function staleRuntimeTtlMs() {
  return envNumber("AUTO_EVOLVE_OPENCODE_STALE_RUNTIME_TTL_MS", 6 * 60 * 60 * 1000)
}

function normalizeAgentForRuntime(agent: string | undefined) {
  const normalized = typeof agent === "string" ? agent.trim() : ""
  if (!normalized) return undefined
  // "top" is accepted in some task packs but not always installed in runtime.
  // Falling back here avoids repeated "agent not found" noise loops.
  if (normalized.toLowerCase() === "top") return undefined
  return normalized
}

function collectToolFailures(events: OpencodeEvent[]) {
  const failures: ToolFailure[] = []
  for (const event of events) {
    if (event.type !== "tool_use" || !event.part?.state || !event.part?.tool) continue
    const part = event.part
    const state = part.state
    if (state.status === "error") {
      failures.push({
        tool: part.tool,
        kind: "error",
        title: typeof state.title === "string" ? state.title : undefined,
        error: typeof state.error === "string" ? state.error : undefined,
        metadata: typeof state.metadata === "object" ? state.metadata : undefined,
      })
      continue
    }
    const exit = state.metadata?.exit
    if (typeof exit === "number" && exit !== 0) {
      failures.push({
        tool: part.tool,
        kind: "nonzero_exit",
        title: typeof state.title === "string" ? state.title : undefined,
        output: typeof state.output === "string" ? state.output : undefined,
        metadata: typeof state.metadata === "object" ? state.metadata : undefined,
      })
    }
  }
  return failures
}

function parseEvents(stdout: string) {
  const events: OpencodeEvent[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const candidates: string[] = [trimmed]
    const braceIndex = trimmed.indexOf("{")
    if (braceIndex > 0) candidates.push(trimmed.slice(braceIndex))
    for (const candidate of candidates) {
      if (!candidate.startsWith("{")) continue
      try {
        events.push(JSON.parse(candidate))
        break
      } catch {
        continue
      }
    }
  }
  return events
}

function collectResponseText(events: OpencodeEvent[]) {
  return events
    .filter((event) => event.type === "text" && typeof event.part?.text === "string")
    .map((event) => String(event.part.text))
    .join("\n\n")
    .trim()
}

function normalizePattern(input: string) {
  return path.resolve(input).replace(/\\/g, "/")
}

async function buildReadListPermissionRules(paths: string[]) {
  const rules: Record<string, "allow" | "deny"> = {
    "*": "deny",
  }

  for (const item of paths) {
    const resolved = normalizePattern(item)
    rules[resolved] = "allow"
    try {
      const info = await stat(item)
      if (info.isDirectory()) {
        rules[`${resolved}/*`] = "allow"
      }
    } catch {
      continue
    }
  }

  return rules
}

async function buildEditPermissionRules(cwd: string, paths: string[]) {
  const rules: Record<string, "allow" | "deny"> = {
    "*": "deny",
  }

  // OpenCode resolves edit paths relative to the process cwd (packages/opencode).
  // Tool permission checks may use either process-cwd-relative paths or
  // worktree-relative paths, so provide both alongside absolute paths.
  const opencodeCwd = path.join(cwd, "packages", "opencode")
  for (const item of paths) {
    const absolute = path.resolve(item)
    const relative = path.relative(opencodeCwd, absolute).replace(/\\/g, "/")
    const worktreeRelative = path.relative(cwd, absolute).replace(/\\/g, "/")
    if (relative && !relative.startsWith("..")) {
      rules[relative] = "allow"
    }
    if (worktreeRelative && !worktreeRelative.startsWith("..")) {
      rules[worktreeRelative] = "allow"
    }
    // Also allow absolute path as fallback
    rules[absolute.replace(/\\/g, "/")] = "allow"
    try {
      const info = await stat(absolute)
      if (info.isDirectory()) {
        if (relative && !relative.startsWith("..")) {
          rules[`${relative}/*`] = "allow"
        }
        if (worktreeRelative && !worktreeRelative.startsWith("..")) {
          rules[`${worktreeRelative}/*`] = "allow"
        }
        rules[`${absolute.replace(/\\/g, "/")}/*`] = "allow"
      }
    } catch {
      continue
    }
  }

  return rules
}

async function makeOverridePermissions(
  cwd: string,
  input: { readPaths: string[]; editPaths: string[]; allowShell?: boolean },
) {
  return {
    "*": "deny",
    read: await buildReadListPermissionRules(input.readPaths),
    list: await buildReadListPermissionRules(input.readPaths),
    edit: await buildEditPermissionRules(cwd, input.editPaths),
    external_directory: {
      "*": "deny",
    },
    bash: input.allowShell ? "allow" : "deny",
    glob: "deny",
    grep: "deny",
    task: "deny",
    todowrite: "deny",
    webfetch: "deny",
    websearch: "deny",
    codesearch: "deny",
    skill: "deny",
    lsp: "deny",
  } as const
}

function makeOpenPermissions() {
  return {
    "*": "allow",
  } as const
}

function filterProviderPlugins(input: unknown, model: string | undefined) {
  if (!Array.isArray(input)) return undefined
  const providerHint = model?.split("/")[0]?.toLowerCase()
  const filtered = input.filter((item) => {
    const text = JSON.stringify(item).toLowerCase()
    if (text.includes("minimax")) return true
    return !!providerHint && text.includes(providerHint)
  })
  return filtered.length ? filtered : undefined
}

function minimalProviderConfig(input: Record<string, unknown>, model: string | undefined) {
  const result: Record<string, unknown> = {}
  if (typeof input.provider === "object" && input.provider && !Array.isArray(input.provider)) {
    result.provider = input.provider
  }
  const plugin = filterProviderPlugins(input.plugin, model)
  if (plugin) result.plugin = plugin
  return result
}

function hostAuthCandidates() {
  return uniqueFiles([
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "opencode", "auth.json") : "",
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "opencode", "auth.json") : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "opencode", "auth.json") : "",
  ].filter(Boolean))
}

async function prepareIsolatedHostRuntime(cwd: string, runLabel: string): Promise<IsolatedHostRuntime> {
  const root = runtimePath(cwd, "opencode-isolated-env", runLabel)
  const home = path.join(root, "home")
  const xdgConfig = path.join(root, "config")
  const xdgData = path.join(root, "data")
  const xdgCache = path.join(root, "cache")
  const xdgState = path.join(root, "state")
  const opencodeData = path.join(xdgData, "opencode")
  const opencodeCache = path.join(xdgCache, "opencode")
  await Promise.all([home, xdgConfig, xdgData, xdgCache, xdgState, opencodeData, opencodeCache].map((dir) => ensureDirectory(dir)))

  for (const candidate of hostAuthCandidates()) {
    if (!(await pathExists(candidate))) continue
    await copyFile(candidate, path.join(opencodeData, "auth.json")).catch(() => undefined)
    break
  }

  // Copy host model cache so the isolated runtime can resolve models without
  // fetching https://models.dev/api.json (which often fails with ECONNRESET).
  const hostModelCache = path.join(os.homedir(), ".cache", "opencode", "models.json")
  if (await pathExists(hostModelCache)) {
    await copyFile(hostModelCache, path.join(opencodeCache, "models.json")).catch(() => undefined)
  }

  return {
    root,
    env: {
      OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_CACHE_HOME: xdgCache,
      XDG_STATE_HOME: xdgState,
      HOME: home,
      USERPROFILE: home,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      // Keep default plugins enabled (model resolution needs them).
      // Disabling them forces OpenCode to fetch models.dev/api.json which may ECONNRESET.
      // OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_CONFIG: undefined,
      OPENCODE_CONFIG_CONTENT: undefined,
      OPENCODE_PERMISSION: undefined,
      OPENCODE_TUI_CONFIG: undefined,
      OPENCODE_PLUGIN_META_FILE: path.join(xdgState, "opencode", "plugin-meta.json"),
    } satisfies NodeJS.ProcessEnv,
  }
}

async function cleanupEphemeralRuntimeDir(cwd: string, target: string | undefined) {
  if (!target || !shouldCleanupOpencodeRuntime()) return
  const root = runtimeRoot(cwd)
  const normalizedRoot = path.resolve(root)
  const normalizedTarget = path.resolve(target)
  if (normalizedTarget === normalizedRoot || !isPathWithinTruthRoot(root, target)) {
    throw new Error(`Refusing to clean runtime path outside runtime root: ${target}`)
  }
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }).catch(() => undefined)
}

async function cleanupEphemeralOpencodeRuntime(input: { cwd: string; overrideConfigDir: string; isolatedRoot?: string }) {
  await Promise.all([
    cleanupEphemeralRuntimeDir(input.cwd, input.overrideConfigDir),
    cleanupEphemeralRuntimeDir(input.cwd, input.isolatedRoot),
  ])
}

async function cleanupStaleRuntimeFamily(cwd: string, family: string, olderThanMs: number) {
  if (!shouldCleanupOpencodeRuntime()) return
  const root = runtimePath(cwd, family)
  if (!(await pathExists(root))) return
  const now = Date.now()
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const target = path.join(root, entry.name)
        const info = await stat(target).catch(() => undefined)
        if (!info) return
        if (now - info.mtimeMs < olderThanMs) return
        await cleanupEphemeralRuntimeDir(cwd, target)
      }),
  )
}

function startStaleOpencodeRuntimeCleanup(cwd: string) {
  if (staleRuntimeCleanupStarted) return
  staleRuntimeCleanupStarted = true
  const ttl = staleRuntimeTtlMs()
  void Promise.all([
    cleanupStaleRuntimeFamily(cwd, "opencode-config", ttl),
    cleanupStaleRuntimeFamily(cwd, "opencode-isolated-env", ttl),
  ]).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Stale OpenCode runtime cleanup failed: ${message}`)
  })
}

async function ensureOverrideConfig(
  cwd: string,
  model: string | undefined,
  permissionConfig: LoadedPermissionConfig,
  permissions: { readPaths: string[]; editPaths: string[] },
  runLabel: string,
  injectPlatformSafetyRules = true,
  isolateHostRuntime = false,
) {
  const dir = runtimePath(cwd, "opencode-config", runLabel)
  const runtimeAgentsFallback = [
    "# AUTO-EVOLVE RUNTIME INSTRUCTIONS",
    "",
    "This session is launched by the auto-evolve orchestrator.",
    "Follow the task prompt and required output contract strictly.",
    "If the task requires structured output (for example JSON-only), return structured output only.",
    "Do not depend on host-level user config or host-level custom agent definitions.",
  ].join("\n")
  const runtimeSafetyRules = [
    "# AUTO-EVOLVE PLATFORM SAFETY RULES",
    "",
    "These rules are injected by auto-evolve and apply to orchestrator-managed sessions unless explicitly disabled by the caller.",
    "- The runtime shell is Windows PowerShell. Use PowerShell-native commands.",
    "- Do not use Unix shell syntax such as `ls -la`, `||`, `&&`, `grep`, `find`, or bash-only redirection patterns.",
    "- Do not rely on `rg`, `grep`, `glob`, or tool-based file search. On this platform those paths may be denied or backed by an unavailable rg.exe.",
    "- File listing fallback: `Get-ChildItem -LiteralPath <path> -Recurse -File`.",
    "- Text search fallback: `Get-ChildItem -LiteralPath <path> -Recurse -File | Select-String -Pattern <pattern>`.",
    "- Path checks fallback: `Test-Path -LiteralPath <path>`.",
    "- JSON read fallback: `Get-Content -LiteralPath <path> -Raw -Encoding UTF8 | ConvertFrom-Json`.",
    "- Document and spreadsheet handling must be headless-only.",
    "- Do not launch Word, Excel, Explorer, or any desktop GUI.",
    "- Do not use `Start-Process`, `Invoke-Item`, file association opens, `explorer.exe`, `WINWORD`, `EXCEL`, or equivalent GUI-launch paths.",
  ].join("\n")
  const systemConfigDirCandidates = [
    process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "opencode") : "",
    path.join(os.homedir(), ".config", "opencode"),
  ].filter(Boolean)
  const systemConfigDir =
    (
      await Promise.all(
        systemConfigDirCandidates.map(async (candidate) => ((await pathExists(candidate)) ? candidate : "")),
      )
    ).find(Boolean) || ""

  let systemBaseConfig: Record<string, unknown> = {}
  if (systemConfigDir) {
    const systemConfigPath = path.join(systemConfigDir, "opencode.json")
    if (await pathExists(systemConfigPath)) {
      try {
        const parsed = JSON.parse(await readFile(systemConfigPath, "utf8"))
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          systemBaseConfig = parsed as Record<string, unknown>
        }
      } catch {}
    }
  }

  const runtimeAgentsMd = (() => {
    if (!injectPlatformSafetyRules || !systemConfigDir) return runtimeAgentsFallback
    const systemAgentsPath = path.join(systemConfigDir, "AGENTS.md")
    return systemAgentsPath
  })()

  let agentsContent = runtimeAgentsFallback
  if (typeof runtimeAgentsMd === "string" && runtimeAgentsMd.endsWith(".md") && (await pathExists(runtimeAgentsMd))) {
    try {
      const loaded = await readFile(runtimeAgentsMd, "utf8")
      if (loaded.trim().length > 0) agentsContent = loaded
    } catch {}
  }
  if (injectPlatformSafetyRules) {
    agentsContent = `${runtimeSafetyRules}\n\n${agentsContent}`
  }

  const override: Record<string, unknown> = {
    // Always pass the full system config. Isolated runtime already handles
    // sandboxing via separate HOME/XDG dirs + restricted permissions.
    // Stripping to minimalProviderConfig breaks model resolution (ECONNRESET on models.dev).
    ...systemBaseConfig,
    $schema: "https://opencode.ai/config.json",
    ...(model
      ? {
          model,
          small_model: model,
        }
      : {}),
    // Keep runtime deterministic: always use built-in stable primary agent.
    // Remove empty agents from system config so OpenCode loads its built-in agents.
    agents: undefined,
    default_agent: "build",
    permission:
      permissionConfig.mode === "open" && permissions.readPaths.length === 0
        ? makeOpenPermissions()
        : await makeOverridePermissions(cwd, {
            readPaths: permissions.readPaths,
            editPaths: permissions.editPaths,
            // Allow shell when we have explicit read paths (blank agent, workers with capabilities).
            // Deny shell only when truly open (no restrictions).
            allowShell: permissions.readPaths.length > 0 || isolateHostRuntime,
          }),
  }
  await ensureDirectory(dir)
  await writeJsonFile(path.join(dir, "opencode.json"), override)
  await writeTextFile(path.join(dir, "AGENTS.md"), agentsContent.trimEnd() + "\n")
  return dir
}

async function ensureRuntimeEnvironment(_cwd: string, _runLabel: string) {
  const env: Record<string, string> = {
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  }

  // Test if the VPN proxy (port 7890) is actually running.
  // If it's down, we MUST clear proxy env vars — otherwise OpenCode
  // tries to route through the dead proxy and can't reach ANY API,
  // including domestic Chinese services like MiniMax.
  const proxyReachable = await new Promise<boolean>((resolve) => {
    const sock = (() => {
      try { return require("node:net").createConnection({ host: "127.0.0.1", port: 7890 }) } catch { return null }
    })()
    if (!sock) { resolve(false); return }
    const done = (v: boolean) => { try { sock.end() } catch {}; resolve(v) }
    sock.on("connect", () => done(true))
    sock.on("error", () => done(false))
    setTimeout(() => done(false), 600)
  })

  const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"]
  if (proxyReachable) {
    // Proxy is alive — pass through the existing settings.
    for (const key of proxyKeys) {
      const value = process.env[key]
      if (value) env[key] = value
    }
  } else {
    // Proxy is dead — explicitly clear so we don't inherit from process.env.
    // MiniMax is a domestic Chinese API and must be reached directly.
    for (const key of proxyKeys) {
      env[key] = ""
    }
  }

  // If a valid models.json cache exists, disable the fetch of models.dev/api.json.
  // This makes OpenCode resilient to VPN drops — it reads from cache instead of
  // from the network, which is unreachable from China without VPN.
  const cachePath = path.join(os.homedir(), ".cache", "opencode", "models.json")
  try {
    if (await pathExists(cachePath)) {
      const raw = await readFile(cachePath, "utf8")
      const trimmed = raw.trim()
      if (trimmed.length > 0 && trimmed.startsWith("{")) {
        env.OPENCODE_DISABLE_MODELS_FETCH = "true"
      }
    }
  } catch {
    // If we can't read the cache, leave models fetch enabled (will need VPN).
  }

  return env
}

function slugifyTitle(input: string) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "task"
  )
}

function buildRunLabel(title: string, attempt: number) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  return `${stamp}-${slugifyTitle(title)}-attempt-${attempt}-${randomUUID().slice(0, 8)}`
}

function formatLocalTimestamp(input: Date) {
  return input.toLocaleString("zh-CN", {
    hour12: false,
    timeZoneName: "short",
  })
}

function buildRuntimeBudgetPromptPrefix(input: { runStart: Date }) {
  const softDeadline = new Date(input.runStart.getTime() + OPENCODE_PROMPT_SOFT_BUDGET_MS)
  return [
    "[Runtime Budget Contract | Mandatory]",
    "You must treat this as a hard working contract for the current session.",
    "",
    "Runtime budget for this session:",
    "- Soft convergence deadline: 30 minutes from run start (mandatory target).",
    `- Run start (local): ${formatLocalTimestamp(input.runStart)}`,
    `- Run start (ISO): ${input.runStart.toISOString()}`,
    `- 30-minute soft deadline (local): ${formatLocalTimestamp(softDeadline)}`,
    `- 30-minute soft deadline (ISO): ${softDeadline.toISOString()}`,
    "",
    "Mandatory execution policy:",
    "1. Maintain a tool_call_count counter starting from your first tool call.",
    "2. At every 25th tool call (25/50/75/...), run an immediate time checkpoint.",
    "3. Preferred checkpoint command: `Get-Date -Format o`.",
    '4. Fallback checkpoint command: `python -c \"from datetime import datetime; print(datetime.now().astimezone().isoformat())\"`.',
    "5. If remaining time to the 30-minute soft deadline is <= 8 minutes: do not open new branches; converge only on this session's required deliverable.",
    "6. If remaining time <= 5 minutes: stop exploration; run only minimum required checks for this session and prepare structured output.",
    "7. If remaining time <= 2 minutes: return structured result immediately. If incomplete, return explicit blockers. Never claim success with blockers.",
    "8. Never break output protocol (for example JSON-only sessions must still return JSON-only output).",
    "",
    "[运行时预算硬约束 | 必须遵守]",
    "你必须把下面规则当作当前 session 的硬约束。",
    "",
    "当前 session 预算：",
    "- 软收敛截止：开始后 30 分钟（强制目标）",
    `- 开始时间（本地）：${formatLocalTimestamp(input.runStart)}`,
    `- 开始时间（ISO）：${input.runStart.toISOString()}`,
    `- 30分钟软截止（本地）：${formatLocalTimestamp(softDeadline)}`,
    `- 30分钟软截止（ISO）：${softDeadline.toISOString()}`,
    "",
    "强制执行策略：",
    "1. 从第一次工具调用开始维护 tool_call_count。",
    "2. 每到第 25 次工具调用（25/50/75/...）必须立刻做时间自检。",
    "3. 优先命令：`Get-Date -Format o`。",
    '4. 备选命令：`python -c \"from datetime import datetime; print(datetime.now().astimezone().isoformat())\"`。',
    "5. 距离 30 分钟软截止 <= 8 分钟：禁止开新分支，只允许收敛到本 session 必需产物。",
    "6. 距离软截止 <= 5 分钟：停止探索，只做本 session 最小必要校验并准备结构化输出。",
    "7. 距离软截止 <= 2 分钟：立即返回结构化结果；未完成必须明确 blockers，严禁伪成功。",
    "8. 不能破坏输出协议（例如 JSON-only 场景必须继续 JSON-only）。",
  ].join("\n")
}

function withRuntimeBudgetPrompt(input: { prompt: string; runStart: Date }) {
  return `${buildRuntimeBudgetPromptPrefix({ runStart: input.runStart })}\n\n${input.prompt}`
}

function isInfrastructureCrash(result: Pick<OpencodeRunResult, "exitCode" | "stderr" | "events" | "responseText">) {
  const stderr = result.stderr.toLowerCase()
  if (stderr.includes("oh no: bun has crashed")) return true
  if (stderr.includes("panic(main thread)")) return true
  if (stderr.includes("segmentation fault")) return true
  if (stderr.includes("runtime bootstrap failed")) return true
  if (stderr.includes("infrastructure bootstrap failed")) return true
  if (stderr.includes("silent output timeout")) return true
  // Network-level infrastructure failures
  if (stderr.includes("econnreset") || stderr.includes("econnrefused") || stderr.includes("enotfound")) return true
  // OpenCode startup failure: process exited but produced no events and no response
  if (result.exitCode === 124 && result.events.length === 0) return true
  if (result.exitCode === 1 && result.events.length === 0 && stderr === "") return true
  if (result.exitCode !== 0 && result.events.length === 0 && stderr.includes("bun")) return true
  // Silent failure: process ran but produced no tool calls and no response text at all
  if (result.events.length === 0 && result.responseText.length === 0 && stderr.startsWith("")) return true
  if (result.events.length > 0 && !result.responseText.length) {
    const hasTextOrToolEvent = result.events.some((e) => e.type === "text" || (e.type === "tool_use" && e.part?.tool))
    if (!hasTextOrToolEvent) return true
  }
  const hasStepFinish = result.events.some((e) => e.type === "step_finish")
  if (result.exitCode === 1 && result.events.length > 0 && !hasStepFinish && stderr === "") return true
  return false
}

function uniqueFiles(files: string[]) {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const file of files) {
    const resolved = path.resolve(file)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    ordered.push(resolved)
  }
  return ordered
}

async function buildPromptInlineFileSection(files: string[]) {
  const blocks: string[] = []
  for (const file of uniqueFiles(files)) {
    const ext = path.extname(file).toLowerCase()
    if (!OPENCODE_PROMPT_INLINE_TEXT_EXTENSIONS.has(ext)) continue

    try {
      const info = await stat(file)
      if (!info.isFile()) continue
      if (info.size > OPENCODE_PROMPT_INLINE_TEXT_FILE_MAX_BYTES) {
        blocks.push(
          [
            `--- REQUIRED FILE TOO LARGE TO INLINE: ${file} ---`,
            `size_bytes: ${info.size}`,
            `max_inline_bytes: ${OPENCODE_PROMPT_INLINE_TEXT_FILE_MAX_BYTES}`,
            "--- END REQUIRED FILE NOTICE ---",
          ].join("\n"),
        )
        continue
      }

      const content = await readFile(file, "utf8")
      blocks.push(
        [
          `--- BEGIN REQUIRED FILE: ${file} ---`,
          content.trimEnd(),
          `--- END REQUIRED FILE: ${file} ---`,
        ].join("\n"),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      blocks.push(
        [
          `--- REQUIRED FILE COULD NOT BE LOADED: ${file} ---`,
          message,
          "--- END REQUIRED FILE NOTICE ---",
        ].join("\n"),
      )
    }
  }

  if (!blocks.length) return ""
  return [
    "[Required Files Inlined At Session Start]",
    "The following required files have already been loaded into this prompt as plain text.",
    "Use these contents directly. Do not spend tool calls reading these same files before applying them.",
    "",
    ...blocks,
  ].join("\n")
}

function liveStatus(input: { started: boolean; exitCode?: number }): TaskArtifactStatus {
  if (typeof input.exitCode === "number") {
    return input.exitCode === 0 ? "done" : "error"
  }
  return input.started ? "running" : "bootstrapping"
}

async function writeLiveTask(input: {
  task: OpencodeTaskInput
  model: string | undefined
  agent: string | undefined
  refs: string[]
  files: string[]
  reads: string[]
  edits: string[]
  stdout: string
  stderr: string
  started: boolean
  startedAt: string
  lastOutputAt?: string
  exitCode?: number
}) {
  if (!input.task.live) return
  await ensureDirectory(input.task.live.stageDir)
  const paths = taskArtifactPaths(input.task.live.stageDir)
  const events = parseEvents(input.stdout)
  const response = collectResponseText(events)
  const now = new Date().toISOString()
  const descriptor = createTaskDescriptor({
    kind: resolveTaskArtifactKind(input.task.live),
    title: input.task.title,
    phase: input.task.live.phase,
    caseID: input.task.live.caseID,
    attempt: input.task.live.attempt,
    maintenanceRound: input.task.live.maintenanceRound,
    methodID: input.task.live.methodID,
  })
  await writeTextFile(paths.promptPath, input.task.prompt + "\n")
  await writeTextFile(paths.stdoutPath, input.stdout)
  await writeTextFile(paths.stderrPath, input.stderr)
  await writeTextFile(paths.responsePath, response.trim() + "\n")
  await writeTextFile(paths.actionTracePath, buildActionTrace(events))
  await writeJsonFile(paths.eventsPath, events)
  await writeJsonFile(paths.toolFailuresPath, collectToolFailures(events))
  await writeJsonFile(paths.runJsonPath, {
    title: input.task.title,
    task: descriptor,
    sessionID: events.find((event) => typeof event.sessionID === "string")?.sessionID,
    exitCode: typeof input.exitCode === "number" ? input.exitCode : null,
    status: liveStatus({
      started: input.started,
      exitCode: input.exitCode,
    }),
    startedAt: input.startedAt,
    updatedAt: now,
    lastOutputAt: input.lastOutputAt ?? now,
    model: input.model ?? null,
    agent: input.agent ?? null,
    variant: input.task.variant ?? null,
    referencedPaths: input.refs,
    attachedFiles: input.files,
    promptInlineFiles: input.task.promptInlineFiles ?? [],
    permissionReadPaths: input.reads,
    permissionEditPaths: input.edits,
  })
}

async function runOpencodeTaskOnce(
  input: OpencodeTaskInput,
  selectedModel: string | undefined,
  selectedAgent: string | undefined,
  referencedPaths: string[],
  attachedFiles: string[],
  permissionReadPaths: string[],
  permissionEditPaths: string[],
  attempt: number,
) {
  const runLabel = buildRunLabel(input.title, attempt)
  const isolateHostRuntime = shouldIsolateHostRuntime(input)
  const overrideConfigDir = await ensureOverrideConfig(
    input.cwd,
    selectedModel,
    input.config.permissionConfig,
    {
      readPaths: permissionReadPaths,
      editPaths: permissionEditPaths,
    },
    runLabel,
    input.injectPlatformSafetyRules !== false,
    isolateHostRuntime,
  )
  const isolatedRuntime = isolateHostRuntime ? await prepareIsolatedHostRuntime(input.cwd, runLabel) : undefined
  const runtimeEnv = {
    ...(await ensureRuntimeEnvironment(input.cwd, runLabel)),
    ...(isolatedRuntime?.env ?? {}),
  }

  const opencodeCmd = await resolveOpencodeCommand(input.cwd)
  const dirArg = process.platform === "win32" ? input.cwd.replace(/\\/g, "/") : input.cwd
  const args = [opencodeCmd, "run", "--pure", "--format", "json", "--dir", dirArg, "--title", input.title]

  const runtimeAgent = normalizeAgentForRuntime(selectedAgent)

  if (runtimeAgent) {
    args.push("--agent", runtimeAgent)
  }
  if (selectedModel) {
    args.push("--model", selectedModel)
  }
  if (input.variant) {
    args.push("--variant", input.variant)
  }

  for (const file of attachedFiles) {
    args.push("--file", file)
  }

  const runStart = new Date()
  const startedAt = runStart.toISOString()
  const runtimePrompt = withRuntimeBudgetPrompt({ prompt: input.prompt, runStart })
  args.push("--", runtimePrompt)
  let started = false
  let lastOutputAt: string | undefined
  let stdoutData = ""
  let stderrData = ""
  let flushHandle: ReturnType<typeof setTimeout> | undefined
  let flushTail = Promise.resolve()
  let lastLiveWriteFailureMessage: string | undefined
  const recordLiveWriteFailure = async (cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    const message = `Live artifact flush failed: ${error.message}`
    if (message === lastLiveWriteFailureMessage) return
    lastLiveWriteFailureMessage = message
    stderrData = [stderrData, message].filter(Boolean).join("\n\n")
    console.warn(message)
    if (!input.live) return
    try {
      await ensureDirectory(input.live.stageDir)
      await writeTextFile(taskArtifactPaths(input.live.stageDir).stderrPath, stderrData)
    } catch {}
  }
  const flush = (exitCode?: number) => {
    flushTail = flushTail
      .catch(() => undefined)
      .then(async () => {
        try {
          await writeLiveTask({
            task: input,
            model: selectedModel,
            agent: selectedAgent,
            refs: referencedPaths,
            files: attachedFiles,
            reads: permissionReadPaths,
            edits: permissionEditPaths,
            stdout: stdoutData,
            stderr: stderrData,
            started,
            startedAt,
            lastOutputAt,
            exitCode,
          })
          lastLiveWriteFailureMessage = undefined
        } catch (error) {
          await recordLiveWriteFailure(error)
        }
      })
    return flushTail
  }
  const scheduleFlush = () => {
    if (!input.live) return
    if (flushHandle) return
    flushHandle = setTimeout(() => {
      flushHandle = undefined
      void flush()
    }, 200)
  }

  await flush()

  let cleanupDone = false
  const cleanupRuntime = async () => {
    if (cleanupDone) return
    cleanupDone = true
    await cleanupEphemeralOpencodeRuntime({
      cwd: input.cwd,
      overrideConfigDir,
      isolatedRoot: isolatedRuntime?.root,
    })
  }

  let managed: Awaited<ReturnType<typeof runManagedProcess>> | undefined
  try {
    started = true
    managed = await runManagedProcess({
      title: input.title,
      command: args,
      cwd: path.join(input.cwd, "packages", "opencode"),
      env: {
        ...runtimeEnv,
        OPENCODE_CONFIG_DIR: overrideConfigDir,
        ...(typeof input.config.modelConfig.limits.requestsPerMinute === "number"
          ? {
              OPENCODE_REQUESTS_PER_MINUTE: String(input.config.modelConfig.limits.requestsPerMinute),
            }
          : {}),
      },
      stdinText: undefined,
      runtimeScope: input.runtimeScope,
      timeoutMs: OPENCODE_TASK_TIMEOUT_MS,
      silentTimeoutMs: OPENCODE_TASK_SILENT_TIMEOUT_MS,
      silentTimeoutAfterActivityMs: OPENCODE_TASK_SILENT_TIMEOUT_AFTER_ACTIVITY_MS,
      onSpawn: async () => {
        await input.onSpawn?.()
        await input.onPulse?.()
        await flush()
      },
      onPulse: input.onPulse,
      onStdoutChunk: (chunk) => {
        stdoutData += chunk.toString()
        lastOutputAt = new Date().toISOString()
        scheduleFlush()
      },
      onStderrChunk: (chunk) => {
        stderrData += chunk.toString()
        lastOutputAt = new Date().toISOString()
        scheduleFlush()
      },
    })
  } finally {
    if (flushHandle) {
      clearTimeout(flushHandle)
      flushHandle = undefined
    }
    await flushTail.catch(() => undefined)
    await cleanupRuntime()
  }

  if (!managed) {
    throw new Error("OpenCode process exited without a managed process result.")
  }

  const timedOut = managed.timedOut
  const hardTimedOut = managed.hardTimedOut
  const silentTimedOut = managed.silentTimedOut
  const silentTimeoutAfterActivity = managed.silentTimeoutAfterActivity
  const observedRuntimeOutput = managed.observedRuntimeOutput
  const exitCode = managed.exitCode
  const stdout = stdoutData
  const stderr = stderrData

  const events = parseEvents(stdout)
  const eventErrors = events
    .filter((event) => event.type === "error")
    .map((event) => {
      const message = event.error?.data?.message ?? event.error?.message ?? event.error?.name
      return typeof message === "string" && message.trim() ? message.trim() : JSON.stringify(event.error ?? event)
    })
    .filter(Boolean)
  const timeoutNotes: string[] = []
  if (hardTimedOut) {
    timeoutNotes.push(
      `OpenCode task timed out after ${OPENCODE_TASK_TIMEOUT_MS} ms and the full process tree was terminated.`,
    )
  }
  if (silentTimedOut) {
    const phaseText = silentTimeoutAfterActivity
      ? "after runtime output started"
      : "before any runtime output was observed"
    timeoutNotes.push(
      `OpenCode task hit silent output timeout (${phaseText}) and the full process tree was terminated.`,
    )
  }
  const normalizedStderr = [
    ...(timedOut ? timeoutNotes : []),
    ...eventErrors.map((item) => `OpenCode emitted error event: ${item}`),
    stderr,
  ]
    .filter(Boolean)
    .join("\n\n")
  const normalizedExitCode = exitCode === 0 && eventErrors.length > 0 ? 1 : exitCode
  stderrData = normalizedStderr
  await flush(normalizedExitCode)

  return {
    sessionID: events.find((event) => typeof event.sessionID === "string")?.sessionID,
    exitCode: normalizedExitCode,
    finishReason: undefined,
    stdout,
    stderr: normalizedStderr,
    events,
    responseText: collectResponseText(events),
    toolFailures: collectToolFailures(events),
  } satisfies OpencodeRunResult
}

export async function runOpencodeTask(input: OpencodeTaskInput): Promise<OpencodeTaskRun> {
  startStaleOpencodeRuntimeCleanup(input.cwd)

  const dependenciesInstalled = await pathExists(path.join(input.cwd, "node_modules"))
  if (!dependenciesInstalled) {
    throw new Error(
      "Repository dependencies are not installed. Run `bun install` in the repo root before running auto-evolve tasks.",
    )
  }

  const selectedModel = input.model ?? input.config.defaultModel
  const selectedAgent = normalizeAgentForRuntime(input.agent ?? input.config.defaultAgent)
  const referencedPaths = uniqueFiles(input.referencePaths ?? [])
  const attachedFiles = uniqueFiles(input.attachedFiles ?? [])
  const promptInlineFiles = uniqueFiles(input.promptInlineFiles ?? [])
  const permissionReadPaths = uniqueFiles(input.permissionReadPaths ?? referencedPaths)
  const permissionEditPaths = uniqueFiles(input.permissionEditPaths ?? [])
  const promptInlineSection = await buildPromptInlineFileSection(promptInlineFiles)
  const effectiveInput: OpencodeTaskInput = {
    ...input,
    prompt: promptInlineSection ? `${promptInlineSection}\n\n${input.prompt}` : input.prompt,
    promptInlineFiles,
  }

  const infrastructureNotes: string[] = []
  let result: OpencodeRunResult | undefined
  const maxAttempts = 3

  // Acquire a global gate permit before spawning OpenCode. This caps total
  // concurrent OpenCode children across the whole process, regardless of
  // which workflow (single campaign, multi-instance fan-out, batch maintainer)
  // is calling. The permit is held across all retry attempts because retries
  // are tightly coupled to a single logical task.
  const gate = OpenCodeGate.instance()
  const permit = await gate.acquire({
    caller: input.title,
    scope: input.concurrencyScope ?? input.runtimeScope ?? input.title,
    root: input.cwd,
  })

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let current: OpencodeRunResult
      try {
        current = await runOpencodeTaskOnce(
          effectiveInput,
          selectedModel,
          selectedAgent,
          referencedPaths,
          attachedFiles,
          permissionReadPaths,
          permissionEditPaths,
          attempt,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        current = {
          exitCode: 1,
          stdout: "",
          stderr: `OpenCode infrastructure bootstrap failed on attempt ${attempt}: ${message}`,
          events: [],
          responseText: "",
          toolFailures: [],
        }
      }

      if (!isInfrastructureCrash(current) || attempt === maxAttempts) {
        result = current
        break
      }

      infrastructureNotes.push(
        `Infrastructure crash detected on OpenCode launch attempt ${attempt}; retrying automatically.`,
      )
      await sleep(750 * attempt)
    }
  } finally {
    try {
      await permit.release()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`OpenCodeGate release failed: ${message}`)
    }
  }

  if (!result) {
    throw new Error("OpenCode task execution did not produce a result.")
  }

  if (infrastructureNotes.length > 0) {
    result = {
      ...result,
      stderr: `${infrastructureNotes.join("\n")}\n\n${result.stderr}`.trim(),
    }
  }

  return {
    title: effectiveInput.title,
    prompt: effectiveInput.prompt,
    selectedModel,
    selectedAgent,
    selectedVariant: input.variant,
    referencedPaths,
    attachedFiles,
    promptInlineFiles,
    permissionReadPaths,
    permissionEditPaths,
    result,
  }
}

async function resolveOpencodeCommand(cwd: string) {
  const envPath = process.env.OPENCODE_BIN_PATH?.trim()
  if (envPath) return envPath
  if (process.platform === "win32") {
    const localExe = path.join(cwd, "packages", "opencode", "node_modules", "opencode-windows-x64", "bin", "opencode.exe")
    if (await pathExists(localExe)) return localExe
    const localBaselineExe = path.join(
      cwd,
      "packages",
      "opencode",
      "node_modules",
      "opencode-windows-x64-baseline",
      "bin",
      "opencode.exe",
    )
    if (await pathExists(localBaselineExe)) return localBaselineExe
  }
  const localBin = path.join(cwd, "node_modules", ".bin", process.platform === "win32" ? "opencode.cmd" : "opencode")
  if (await pathExists(localBin)) return localBin
  if (process.platform === "win32") {
    const roamingCmd = path.join(os.homedir(), "AppData", "Roaming", "npm", "opencode.cmd")
    if (await pathExists(roamingCmd)) return roamingCmd
  }
  return "opencode"
}
