import path from "node:path"
import { mkdir } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { runManagedProcess } from "../managed-process"
import { writeJsonAtomic } from "../atomic-write"

export function readinessEnvironment(root: string, source: NodeJS.ProcessEnv = process.env) {
  const env: NodeJS.ProcessEnv = {}
  const allowed = new Set(["systemroot", "windir", "comspec", "path", "pathext", "temp", "tmp", "tmpdir", "lang", "lc_all"])
  for (const [key, value] of Object.entries(source)) if (allowed.has(key.toLowerCase()) && value !== undefined) env[key] = value
  const local = (name: string) => path.join(root, name).replaceAll("\\", "/")
  return Object.assign(env, {
    HOME: local("home"), USERPROFILE: local("home"), APPDATA: local("config"), LOCALAPPDATA: local("data"),
    XDG_CONFIG_HOME: local("config"), XDG_DATA_HOME: local("data"), XDG_CACHE_HOME: local("cache"),
    OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_CONFIG_CONTENT: "{}",
  })
}

export async function preflightSourceHost(input: { cwd: string; evidenceRoot: string },
  run: typeof runManagedProcess = runManagedProcess) {
  if (!path.isAbsolute(input.cwd) || !path.isAbsolute(input.evidenceRoot)) throw new Error("Absolute host readiness paths required")
  const root = path.join(input.evidenceRoot, "source-host-readiness")
  await mkdir(root, { recursive: true })
  const command = [process.execPath, "run", "--cwd", "packages/opencode", "--conditions=browser", "src/index.ts", "--help"]
  const env = readinessEnvironment(root)
  for (const name of ["home", "config", "data", "cache"]) await mkdir(path.join(root, name), { recursive: true })
  const startedAt = new Date().toISOString()
  const result = await run({ title: "AEV source host readiness (no model)", command, cwd: input.cwd,
    inheritEnv: false, env, timeoutMs: 60000, silentTimeoutMs: 60000 })
  const sha = (value: string) => createHash("sha256").update(value).digest("hex")
  const help = `${result.stdout}\n${result.stderr}`
  const ready = result.exitCode === 0 && !result.timedOut && /Commands:/.test(help) && /Options:/.test(help)
  // 仅证明CLI可加载，不把帮助页当模型或验收能力证明。
  const evidence = {
    schema: "aev.source-host-readiness.v1", startedAt, finishedAt: new Date().toISOString(),
    command, cwd: input.cwd, ready, exitCode: result.exitCode, timedOut: result.timedOut,
    stdoutSHA256: sha(result.stdout), stderrSHA256: sha(result.stderr),
    stdout: result.stdout, stderr: result.stderr, modelRequests: 0,
    environmentPolicy: "explicit-os-allowlist-and-isolated-config",
  }
  // 重启后的预检留新记录，不覆盖上一轮启动故障证据。
  const receipt = path.join(root, `attempt-${randomUUID()}.json`)
  await writeJsonAtomic(receipt, evidence)
  await writeJsonAtomic(path.join(root, "result.json"), { ...evidence, receipt })
  if (!ready) throw new Error("Source host readiness failed before model request; inspect source-host-readiness/result.json")
}
