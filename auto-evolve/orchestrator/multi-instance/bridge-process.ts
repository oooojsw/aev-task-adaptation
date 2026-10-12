import { spawn } from "node:child_process"
import { identifyProcessOwner } from "../process-identity"
import { terminateProcessTree } from "../runtime-process-registry"

export async function runBridgeProcess(input: {
  command: string[]; cwd: string; timeoutMs: number
}) {
  const started = Date.now()
  const child = spawn(input.command[0]!, input.command.slice(1), {
    cwd: input.cwd,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    // Unix 独立进程组用于清理后代，不影响宿主。
    detached: process.platform !== "win32",
  })
  let stdout = "", stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", resolve)
  })
  const close = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  // 启动失败可能先于身份查询返回，立即登记拒绝处理。
  void exit.catch(() => undefined)
  void close.catch(() => undefined)
  const hints = input.command.slice(1).filter((value) => value.length > 0)
  const initial = process.platform === "win32"
    ? await identifyProcessOwner({ pid: child.pid, requiredCommandHints: hints }) : undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      close.then((code) => ({ code, timedOut: false })),
      new Promise<{ code: null; timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ code: null, timedOut: true }), Math.max(0, input.timeoutMs - (Date.now() - started)))
      }),
    ])
    if (result.timedOut) {
      // 归属不明禁止杀；清理失败明确阻断，不伪装超时成功。
      if (process.platform === "win32") {
        const owner = await identifyProcessOwner({ pid: child.pid,
          expectedCreationTick: initial?.creationTick, requiredCommandHints: hints })
        if (owner.ownership !== "owned" || !await terminateProcessTree(child.pid)) {
          throw new Error(`Bridge timeout cleanup incomplete: ${owner.ownership}`)
        }
      } else {
        try { process.kill(-child.pid!, "SIGKILL") }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
      }
      let guard: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([exit, new Promise((_, reject) => {
          guard = setTimeout(() => reject(new Error("Bridge timeout cleanup did not exit")), 3000)
        })])
      } finally { clearTimeout(guard) }
    }
    return { exitCode: result.code, timedOut: result.timedOut, stdout, stderr }
  } finally {
    clearTimeout(timer)
    child.stdout.destroy()
    child.stderr.destroy()
  }
}
