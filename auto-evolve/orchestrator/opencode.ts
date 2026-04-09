import path from "node:path"
import process from "node:process"
import { stat } from "node:fs/promises"
import type { AutoEvolveConfig, LoadedPermissionConfig } from "./schema"
import type { ToolFailure } from "./evaluator"
import { autoEvolvePath, ensureDirectory, pathExists, writeJsonFile } from "./fs"

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
    if (!trimmed.startsWith("{")) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      continue
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
) {
  const dir = autoEvolvePath(cwd, ".runtime", "opencode-config")
  const override: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    ...(model
      ? {
          model,
          small_model: model,
        }
      : {}),
    permission:
      permissionConfig.mode === "open"
        ? makeOpenPermissions()
        : await makeOverridePermissions(cwd, {
            readPaths: permissions.readPaths,
            editPaths: permissions.editPaths,
          }),
    mcp: {
      "claude-code": {
        enabled: false,
      },
    },
  }
  await ensureDirectory(dir)
  await writeJsonFile(path.join(dir, "opencode.json"), override)
  return dir
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

export async function runOpencodeTask(input: OpencodeTaskInput): Promise<OpencodeTaskRun> {
  const dependenciesInstalled = await pathExists(path.join(input.cwd, "node_modules"))
  if (!dependenciesInstalled) {
    throw new Error("Repository dependencies are not installed. Run `bun install` in the repo root before running auto-evolve tasks.")
  }

  const selectedModel = input.model ?? input.config.defaultModel
  const selectedAgent = input.agent ?? input.config.defaultAgent
  const referencedPaths = uniqueFiles(input.referencePaths ?? [])
  const attachedFiles = uniqueFiles(input.attachedFiles ?? [])
  const permissionReadPaths = uniqueFiles(input.permissionReadPaths ?? referencedPaths)
  const permissionEditPaths = uniqueFiles(input.permissionEditPaths ?? [])
  const overrideConfigDir = await ensureOverrideConfig(input.cwd, selectedModel, input.config.permissionConfig, {
    readPaths: permissionReadPaths,
    editPaths: permissionEditPaths,
  })

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

  if (selectedAgent) {
    args.push("--agent", selectedAgent)
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

  args.push("--", input.prompt)

  const child = Bun.spawn(args, {
    cwd: path.join(input.cwd, "packages", "opencode"),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: overrideConfigDir,
      ...(typeof input.config.modelConfig.limits.requestsPerMinute === "number"
        ? {
            OPENCODE_REQUESTS_PER_MINUTE: String(input.config.modelConfig.limits.requestsPerMinute),
          }
        : {}),
    },
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  const events = parseEvents(stdout)

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
    result: {
      sessionID: events.find((event) => typeof event.sessionID === "string")?.sessionID,
      exitCode,
      stdout,
      stderr,
      events,
      responseText: collectResponseText(events),
      toolFailures: collectToolFailures(events),
    },
  }
}
