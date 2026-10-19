import { describe, expect, test } from "bun:test"
import { adaptiveFailureEvidence, classifyAdaptiveFailure } from "./adaptive-concurrency"

describe("adaptive failure classification", () => {
  test.each(["exhausted", "needs unresolved usage inspection"])("local request budget %s is not provider congestion", (reason) => {
    const text = adaptiveFailureEvidence([`Request budget ${reason}`], "") ?? '{"timeout":240000,"status":429}'
    expect(classifyAdaptiveFailure(text)).toBe("unknown")
  })

  test.each([
    ["429 Too Many Requests", "rate_limit"],
    ["502 Bad Gateway", "provider_busy"],
    ["Request timed out", "timeout"],
    ["401 unauthorized", "auth_error"],
    ["model not found", "model_unavailable"],
    ["validator answer mismatch", "unknown"],
  ] as const)("preserves provider classification: %s", (text, expected) => {
    expect(classifyAdaptiveFailure(text)).toBe(expected)
  })

  test("quoted budget wording does not override a provider failure", () => {
    expect(classifyAdaptiveFailure('429 Too Many Requests\n{"text":"Request budget exhausted"}')).toBe("rate_limit")
  })

  test("real timeout metadata cannot turn local exhaustion into a provider timeout", () => {
    expect(adaptiveFailureEvidence(["Request budget exhausted"], "")).toBe("")
    expect(adaptiveFailureEvidence(["ordinary error"], "")).toBeUndefined()
  })

  test.each([
    ["HTTP 429 Too Many Requests", "rate_limit"],
    ["Upstream request timed out", "timeout"],
  ] as const)("retains independent error events after local exhaustion: %s", (error, expected) => {
    expect(classifyAdaptiveFailure(adaptiveFailureEvidence(["Request budget exhausted", error], "")!)).toBe(expected)
  })

  test("preserves multiline errors and authoritative host timeouts", () => {
    expect(classifyAdaptiveFailure(adaptiveFailureEvidence(["Request budget exhausted", "APIError\nHTTP 429 Too Many Requests"], "")!)).toBe("rate_limit")
    expect(classifyAdaptiveFailure(adaptiveFailureEvidence(["Request budget exhausted"], "OpenCode task timed out after 240000 ms")!)).toBe("timeout")
  })
})
