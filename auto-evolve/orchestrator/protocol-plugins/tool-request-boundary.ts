import path from "node:path"
import { lstat, realpath } from "node:fs/promises"
import type { ToolRequest } from "./tool-session"
import { validateBudgetTransport } from "../task-adaptation/budget-transport"

function absolute(value: unknown): asserts value is string {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[*?\x00]/.test(value)) {
    throw new Error("Explicit non-pattern absolute tool path required")
  }
}

async function canonicalPath(file: string, allowMissing: boolean) {
  let current = path.resolve(file)
  for (;;) {
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || await realpath(current) !== current) throw new Error("Tool permission path link rejected")
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !allowMissing) throw error
      const parent = path.dirname(current)
      if (parent === current) throw new Error("Tool permission path has no existing parent")
      current = parent
    }
  }
}

export async function validateToolRequest(request: ToolRequest) {
  if (!request || typeof request.prompt !== "string" || !request.prompt.trim() ||
      typeof request.model !== "string" || !request.model.trim() || request.allowShell !== false ||
      request.maxAttempts !== 1 || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 ||
      request.timeoutMs > 12 * 60 * 60 * 1000 ||
      !Array.isArray(request.readPaths) || !request.readPaths.length ||
      !Array.isArray(request.editPaths) || !request.editPaths.length) {
    throw new Error("Explicit bounded tool request and nonempty permission lists required")
  }
  // 空读取清单可能触发旧宿主开放权限，新入口必须先阻断。
  absolute(request.workDir)
  if (request.requestBudget) {
    const cfg = validateBudgetTransport(request.requestBudget)
    // 预算和计量文件不属于Agent可读写的任务材料。
    for (const root of [request.workDir, ...request.readPaths, ...request.editPaths]) {
      const relative = path.relative(root, cfg.budget.root)
      if (!relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
        throw new Error("Provider budget must remain outside model permission roots")
      }
    }
  }
  await canonicalPath(request.workDir, false)
  if (!(await lstat(request.workDir)).isDirectory()) throw new Error("Tool workDir must be a directory")
  for (const file of request.readPaths) {
    absolute(file)
    await canonicalPath(file, false)
  }
  for (const file of request.editPaths) {
    absolute(file)
    const relative = path.relative(request.workDir, file)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Tool edit permission escaped declared workDir")
    }
    await canonicalPath(file, true)
  }
}
