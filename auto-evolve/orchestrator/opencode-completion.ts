export function completion(events: ReadonlyArray<{ type: string; part?: unknown }>, strict = false) {
  const steps = events.filter(event => event.type === "step_finish")
  const part = steps.at(-1)?.part as { reason?: unknown } | undefined
  const reason = typeof part?.reason === "string" ? part.reason : undefined
  // 工具中间步不是最终完成；新协议缺结束证据时不能晋级。
  const incomplete = reason !== undefined ? reason !== "stop" : strict
  return { reason, incomplete }
}
