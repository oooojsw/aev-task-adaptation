import path from "node:path"
import process from "node:process"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { spawn as nodeSpawn } from "node:child_process"
import { buildActionTrace } from "./action-trace"
import type { AutoEvolveConfig, LoadedPermissionConfig } from "./schema"
import type { ToolFailure } from "./evaluator"
import { autoEvolvePath, ensureDirectory, pathExists, writeJsonFile, writeTextFile } from "./fs"
import { registerRuntimeProcess, terminateProcessTree } from "./runtime-process-registry"
import {
  resolveTaskArtifactKind,
  taskArtifactPaths,
  type TaskArtifactInput,
  type TaskArtifactStatus,
} from "./task-artifacts"
import { createTaskDescriptor } from "./task-model"

const OPENCODE_TASK_TIMEOUT_MS = 180 * 60 * 1000
const OPENCODE_PROMPT_SOFT_BUDGET_MS = 30 * 60 * 1000
const OPENCODE_TASK_SILENT_TIMEOUT_MS = (() => {
  const value = Number.parseInt(process.env.AUTO_EVOLVE_OPENCODE_SILENT_TIMEOUT_MS ?? "", 10)
  if (Number.isFinite(value) && value > 0) return value
  return 60 * 60 * 1000
})()
const OPENCODE_TASK_SILENT_TIMEOUT_AFTER_ACTIVITY_MS = (() => {
  const value = Number.parseInt(process.env.AUTO_EVOLVE_OPENCODE_SILENT_TIMEOUT_AFTER_ACTIVITY_MS ?? "", 10)
  if (Number.isFinite(value) && value > 0) return value
  // Once runtime output has started, prefer hard-timeout guard and avoid
  // prematurely terminating long silent compute windows.
  return Math.min(OPENCODE_TASK_TIMEOUT_MS, Math.max(OPENCODE_TASK_SILENT_TIMEOUT_MS, 60 * 60 * 1000))
})()

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
  permissionReadPaths?: string[]
  permissionEditPaths?: string[]
  model?: string
  agent?: string
  variant?: string
  runtimeScope?: string
  onSpawn?: () => Promise<void> | void
  onPulse?: () => Promise<void> | void
  live?: TaskArtifactInput & {
    stageDir: string
  }
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

function buildEditPermissionRules(cwd: string, paths: string[]) {
  const rules: Record<string, "allow" | "deny"> = {
    "*": "deny",
  }

  for (const item of paths) {
    const relative = path.relative(cwd, path.resolve(item)).replace(/\\/g, "/")
    if (!relative) continue
    rules[relative] = "allow"
  }

  return rules
}

async function makeOverridePermissions(cwd: string, input: { readPaths: string[]; editPaths: string[] }) {
  return {
    "*": "deny",
    read: await buildReadListPermissionRules(input.readPaths),
    list: await buildReadListPermissionRules(input.readPaths),
    edit: buildEditPermissionRules(cwd, input.editPaths),
    external_directory: {
      "*": "deny",
    },
    bash: "deny",
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

async function ensureOverrideConfig(
  cwd: string,
  model: string | undefined,
  permissionConfig: LoadedPermissionConfig,
  permissions: { readPaths: string[]; editPaths: string[] },
  runLabel: string,
) {
  const dir = autoEvolvePath(cwd, ".runtime", "opencode-config", runLabel)
  const runtimeAgentsFallback = [
    "# AUTO-EVOLVE RUNTIME INSTRUCTIONS",
    "",
    "This session is launched by the auto-evolve orchestrator.",
    "Follow the task prompt and required output contract strictly.",
    "If the task requires structured output (for example JSON-only), return structured output only.",
    "Do not depend on host-level user config or host-level custom agent definitions.",
  ].join("\n")
  const systemConfigDirCandidates = [
    process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "opencode") : "",
    path.join(os.homedir(), ".config", "opencode"),
  ].filter(Boolean)
  const systemConfigDir =
    (await Promise.all(
      systemConfigDirCandidates.map(async (candidate) => ((await pathExists(candidate)) ? candidate : "")),
    )).find(Boolean) || ""

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
    if (!systemConfigDir) return runtimeAgentsFallback
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

  const override: Record<string, unknown> = {
    ...systemBaseConfig,
    $schema: "https://opencode.ai/config.json",
    ...(model
      ? {
          model,
          small_model: model,
        }
      : {}),
    // Keep runtime deterministic: always use built-in stable primary agent.
    default_agent: "build",
    permission:
      permissionConfig.mode === "open"
        ? makeOpenPermissions()
        : await makeOverridePermissions(cwd, {
            readPaths: permissions.readPaths,
            editPaths: permissions.editPaths,
          }),
  }
  await ensureDirectory(dir)
  await writeJsonFile(path.join(dir, "opencode.json"), override)
  await writeTextFile(path.join(dir, "AGENTS.md"), agentsContent.trimEnd() + "\n")
  return dir
}

async function ensureRuntimeEnvironment(_cwd: string, _runLabel: string) {
  // Keep project-level overrides disabled, but preserve host provider state
  // so MiniMax provider/model resolution stays available at runtime.
  return {
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  } as const
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

function isInfrastructureCrash(result: Pick<OpencodeRunResult, "exitCode" | "stderr" | "events">) {
  const stderr = result.stderr.toLowerCase()
  if (stderr.includes("oh no: bun has crashed")) return true
  if (stderr.includes("panic(main thread)")) return true
  if (stderr.includes("segmentation fault")) return true
  if (stderr.includes("runtime bootstrap failed")) return true
  if (stderr.includes("infrastructure bootstrap failed")) return true
  if (stderr.includes("silent output timeout")) return true
  if (result.exitCode === 124 && result.events.length === 0) return true
  if (result.exitCode === 1 && result.events.length === 0 && stderr === "") return true
  return result.exitCode !== 0 && result.events.length === 0 && stderr.includes("bun")
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
  const overrideConfigDir = await ensureOverrideConfig(
    input.cwd,
    selectedModel,
    input.config.permissionConfig,
    {
      readPaths: permissionReadPaths,
      editPaths: permissionEditPaths,
    },
    runLabel,
  )
  const runtimeEnv = await ensureRuntimeEnvironment(input.cwd, runLabel)

  const args = [
    process.execPath,
    "run",
    "src/index.ts",
    "run",
    "--pure",
    "--format",
    "json",
    "--dir",
    input.cwd,
    "--title",
    input.title,
  ]

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

  const child = nodeSpawn(process.execPath, args.slice(1), {
    cwd: path.join(input.cwd, "packages", "opencode"),
    // Feed prompt via stdin so long prompts do not inflate command-line length on Windows.
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...runtimeEnv,
      OPENCODE_CONFIG_DIR: overrideConfigDir,
      ...(typeof input.config.modelConfig.limits.requestsPerMinute === "number"
        ? {
            OPENCODE_REQUESTS_PER_MINUTE: String(input.config.modelConfig.limits.requestsPerMinute),
          }
        : {}),
    },
  })
  registerRuntimeProcess(input.runtimeScope, child.pid, input.title)
  started = true
  const promptWrite = Promise.resolve()
    .then(async () => {
      if (!child.stdin) return
      child.stdin.setDefaultEncoding("utf8")
      child.stdin.write(runtimePrompt)
      child.stdin.end()
    })
    .catch((error) => {
      throw new Error(
        `Failed to stream prompt to OpenCode stdin: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  const abortAfterSpawn = async (cause: unknown): Promise<never> => {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    stderrData = [stderrData, `OpenCode runtime bootstrap failed after spawn: ${error.message}`]
      .filter(Boolean)
      .join("\n\n")
    try {
      await terminateProcessTree(child.pid)
    } catch {}
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
        exitCode: 1,
      })
    } catch {}
    throw error
  }
  try {
    await promptWrite
    await input.onSpawn?.()
    await input.onPulse?.()
    await flush()
  } catch (error) {
    return abortAfterSpawn(error)
  }

  let timedOut = false
  let hardTimedOut = false
  let silentTimedOut = false
  let silentTimeoutAfterActivity = false
  let observedRuntimeOutput = false
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let silentTimeoutHandle: ReturnType<typeof setTimeout> | undefined
  let pulseHandle: ReturnType<typeof setInterval> | undefined
  let refreshSilentTimeout: (() => void) | undefined

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

    timeoutHandle = setTimeout(async () => {
      await killAndResolve("hard")
    }, OPENCODE_TASK_TIMEOUT_MS)

    refreshSilentTimeout = () => {
      if (silentTimeoutHandle) clearTimeout(silentTimeoutHandle)
      const silentTimeoutMs = observedRuntimeOutput
        ? OPENCODE_TASK_SILENT_TIMEOUT_AFTER_ACTIVITY_MS
        : OPENCODE_TASK_SILENT_TIMEOUT_MS
      silentTimeoutHandle = setTimeout(async () => {
        await killAndResolve("silent")
      }, silentTimeoutMs)
    }
    refreshSilentTimeout()
  })

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutData += chunk.toString()
    observedRuntimeOutput = true
    lastOutputAt = new Date().toISOString()
    refreshSilentTimeout?.()
    scheduleFlush()
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrData += chunk.toString()
    observedRuntimeOutput = true
    lastOutputAt = new Date().toISOString()
    refreshSilentTimeout?.()
    scheduleFlush()
  })

  pulseHandle = setInterval(() => {
    void Promise.resolve(input.onPulse?.()).catch(() => undefined)
    if (observedRuntimeOutput) refreshSilentTimeout?.()
    scheduleFlush()
  }, 60_000)

  let exitCode = await Promise.race([exitPromise, timeoutPromise])
  if (timeoutHandle) clearTimeout(timeoutHandle)
  if (silentTimeoutHandle) clearTimeout(silentTimeoutHandle)
  if (pulseHandle) clearInterval(pulseHandle)
  if (flushHandle) {
    clearTimeout(flushHandle)
    flushHandle = undefined
  }

  const stdout = stdoutData
  const stderr = stderrData

  const events = parseEvents(stdout)
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
  const normalizedStderr = timedOut ? [...timeoutNotes, stderr].filter(Boolean).join("\n\n") : stderr
  stderrData = normalizedStderr
  await flush(exitCode)

  return {
    sessionID: events.find((event) => typeof event.sessionID === "string")?.sessionID,
    exitCode,
    finishReason: undefined,
    stdout,
    stderr: normalizedStderr,
    events,
    responseText: collectResponseText(events),
    toolFailures: collectToolFailures(events),
  } satisfies OpencodeRunResult
}

export async function runOpencodeTask(input: OpencodeTaskInput): Promise<OpencodeTaskRun> {
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
  const permissionReadPaths = uniqueFiles(input.permissionReadPaths ?? referencedPaths)
  const permissionEditPaths = uniqueFiles(input.permissionEditPaths ?? [])

  const infrastructureNotes: string[] = []
  let result: OpencodeRunResult | undefined
  const maxAttempts = 3

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let current: OpencodeRunResult
    try {
      current = await runOpencodeTaskOnce(
        input,
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
    title: input.title,
    prompt: input.prompt,
    selectedModel,
    selectedAgent,
    selectedVariant: input.variant,
    referencedPaths,
    attachedFiles,
    permissionReadPaths,
    permissionEditPaths,
    result,
  }
}
