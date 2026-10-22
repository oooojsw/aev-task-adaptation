import { test, expect } from "bun:test"
import { diagnosedFetch, transportFailure } from "../../src/provider/transport-diagnostics"

test("success preserves response identity and dispatch count", async () => {
  const response = new Response("same")
  let calls = 0
  const transport = Object.assign(async () => { calls++; return response }, { preconnect: () => {} }) as typeof fetch
  const wrapper = diagnosedFetch(transport)
  expect(wrapper.preconnect).toBe(transport.preconnect)
  expect(await wrapper("http://localhost/")).toBe(response)
  expect(calls).toBe(1)
})

test("failure preserves original error and never repeats request", async () => {
  const error = Object.assign(new TypeError("fetch failed private-secret"), { cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }) })
  let calls = 0
  const transport = Object.assign(async () => { calls++; throw error }, { preconnect: () => {} }) as typeof fetch
  const original = console.error
  const logs: string[] = []
  console.error = (...args) => { logs.push(args.join(" ")) }
  try {
    await expect(diagnosedFetch(transport)("http://user:password@localhost/?key=secret", { headers: { Authorization: "Bearer secret" } })).rejects.toBe(error)
    expect(calls).toBe(1)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("ECONNRESET")
    expect(logs[0]).not.toMatch(/private-secret|password|Bearer|key=/)
  } finally { console.error = original }
})

test("diagnostic write failure cannot replace original transport error", async () => {
  const error = new Error("original")
  const original = console.error
  console.error = () => { throw new Error("logger failed") }
  try {
    const transport = Object.assign(async () => { throw error }, { preconnect: () => {} }) as typeof fetch
    await expect(diagnosedFetch(transport)("http://localhost/")).rejects.toBe(error)
  } finally { console.error = original }
})

test("unknown fields and cyclic causes do not expose raw values", () => {
  const error = { name: "secret", code: "key-value", message: "api-key-is-secret", cause: undefined as unknown }
  error.cause = error
  expect(transportFailure(error)).toEqual([{ name: "OtherError" }])
})
