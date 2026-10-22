const names = new Set(["Error", "TypeError", "AbortError", "TimeoutError", "SystemError", "FetchError", "SocketError"])
const codes = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ConnectionClosed", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ERR_STREAM_PREMATURE_CLOSE"])

export function transportFailure(error: unknown) {
  const chain: { name: string; code?: string; hint?: string }[] = []
  const seen = new Set<unknown>()
  for (let value = error; value && typeof value === "object" && chain.length < 4 && !seen.has(value);) {
    seen.add(value)
    const row = value as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown }
    const message = typeof row.message === "string" ? row.message : ""
    chain.push({ name: typeof row.name === "string" && names.has(row.name) ? row.name : "OtherError",
      ...(typeof row.code === "string" && codes.has(row.code) ? { code: row.code } : {}),
      ...(/socket.*closed|connection.*closed|connection reset/i.test(message) ? { hint: "connection_closed" } :
        /timed?\s*out|timeout/i.test(message) ? { hint: "timeout" } :
        /fetch failed|unable to connect/i.test(message) ? { hint: "connection_failed" } : {}) })
    value = row.cause
  }
  return chain
}

export function diagnosedFetch(transport: typeof fetch): typeof fetch {
  return new Proxy(transport, {
    async apply(target, receiver, args) {
      const start = Date.now()
      try {
        return await Reflect.apply(target, receiver, args)
      } catch (error) {
        // 先保存首个传输错误；不记正文密钥，不重试，不覆盖原异常。
        try {
          console.error("[provider-transport-diagnostic] " + JSON.stringify({ at: new Date().toISOString(),
            phase: "before_headers", elapsedMs: Date.now() - start, signalAborted: args[1]?.signal?.aborted === true,
            chain: transportFailure(error) }))
        } catch {}
        throw error
      }
    },
  })
}
