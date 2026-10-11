import { existsSync } from "node:fs"
import path from "node:path"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

export interface NoConsoleProxyInput {
  command: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  stdinText?: string
  title: string
}

export interface NoConsoleProxy {
  child: ChildProcessWithoutNullStreams
  stdinPayload?: string
}

function findPythonw() {
  const requested = process.env.AUTO_EVOLVE_PYTHONW_EXE?.trim()
  if (requested && existsSync(requested)) return requested
  const executable = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Programs", "Python", "Python313", "pythonw.exe")
    : ""
  if (executable && existsSync(executable)) return executable
  for (const entry of (process.env.Path ?? process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(entry.replace(/^"|"$/g, ""), "pythonw.exe")
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export function spawnNoConsoleProxy(input: NoConsoleProxyInput): NoConsoleProxy {
  const pythonw = process.platform === "win32" ? findPythonw() : undefined
  if (!pythonw) {
    return {
      child: spawn(input.command[0] ?? "", input.command.slice(1), {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
      stdinPayload: input.stdinText,
    }
  }
  const wrapper = path.join(import.meta.dir, "windows-no-console-wrapper.py")
  const child = spawn(pythonw, [wrapper, "--title", input.title], {
    cwd: input.cwd,
    env: input.env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  return {
    child,
    stdinPayload: JSON.stringify({
      command: input.command,
      cwd: input.cwd,
      env: input.env ?? {},
      stdin_text: input.stdinText,
    }),
  }
}
