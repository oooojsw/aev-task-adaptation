import { spawnNoConsoleProxy } from "./windows-no-console-process"

export interface HiddenChildProcessInput {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export interface HiddenChildProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Launch a captured CLI child without creating a visible Windows console window. */
export async function runHiddenChildProcess(input: HiddenChildProcessInput): Promise<HiddenChildProcessResult> {
  const proxy = spawnNoConsoleProxy({
    command: [input.command, ...input.args],
    cwd: input.cwd,
    env: input.env,
    title: `Hidden child ${input.command}`,
  })
  const child = proxy.child
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8")
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8")
  })
  const exitCode = await new Promise<number>((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      resolve(code)
    }
    timeout = typeof input.timeoutMs === "number" && input.timeoutMs > 0
      ? setTimeout(() => {
          try {
            child.kill()
          } catch {}
          finish(124)
        }, input.timeoutMs)
      : undefined
    child.once("error", (error) => {
      stderr += `${error instanceof Error ? error.stack || error.message : String(error)}\n`
      finish(1)
    })
    child.once("exit", (code) => finish(code ?? 1))
    child.stdin.end(proxy.stdinPayload)
  })
  return { exitCode, stdout, stderr }
}
