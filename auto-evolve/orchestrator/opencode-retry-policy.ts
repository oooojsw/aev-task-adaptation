export function infrastructureAttempts(value?: number) {
  // 旧链路默认三次；新验收可显式单次，避免不明中断自动重发。
  if (value === undefined) return 3
  if (!Number.isSafeInteger(value) || value < 1 || value > 3) throw new Error("Infrastructure attempts must be 1..3")
  return value
}
