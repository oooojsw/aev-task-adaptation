import path from "node:path"

export function aevPathPattern(permission: string, pattern: string, worktree: string, enabled: boolean) {
  if (!enabled || !["read", "edit", "list", "external_directory"].includes(permission)) return pattern
  // 新宿主统一相对路径坐标，不扩大允许目录；旧会话不变。
  return path.resolve(worktree, pattern)
}
