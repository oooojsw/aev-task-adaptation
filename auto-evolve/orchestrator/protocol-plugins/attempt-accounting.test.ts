import { expect, test } from "bun:test"
import { attemptAccounting } from "./attempt-accounting"
import type { Snapshot } from "./contract"
import type { Runtime } from "./runtime"

const snapshot = { fingerprint: "a".repeat(64), selection: { protocol: { phases: { test: {
  claim: "task_execution", executor: { id: "executor", version: "1" }, checks: [{ name: "score", target: "product", id: "judge", version: "1" }] } } } } } as Snapshot
const receipt = { schema: "aev.protocol-receipt.v1", task: "task", phase: "test", claim: "task_execution",
  protocolFingerprint: snapshot.fingerprint, status: "passed", message: "ok", executed: true,
  executionAttempted: true, executionReused: false, evidence: { skill: [], materials: [], privateInputs: [] },
  usage: { inputTokens: 20, outputTokens: 3 }, checks: [{ name: "score", target: "product",
    stage: "after_execution", mechanism: "judge", required: true, status: "passed", message: "ok",
    inputFingerprint: "b".repeat(64), usage: { inputTokens: 7, outputTokens: 2 }, reused: false }] } as Awaited<ReturnType<Runtime["run"]>>

test("accounting separates fresh and reused executor and judge token reports", () => {
  const first = attemptAccounting(snapshot, "test", receipt, 123)
  expect(first.input).toEqual({ knownTokens: 27, unreportedInvocations: 0 })
  expect(first.output).toEqual({ knownTokens: 5, unreportedInvocations: 0 })
  const rescored = attemptAccounting(snapshot, "test", { ...receipt, executionReused: true }, 10)
  expect(rescored.input.knownTokens).toBe(7)
  expect(rescored.invocations[0].reportedInputTokens).toBe(20)
  expect(rescored.invocations[0].newInputTokens).toBe(0)
  const reused = attemptAccounting(snapshot, "test", { ...receipt, executionReused: true,
    checks: [{ ...receipt.checks[0], reused: true }] }, 1)
  expect(reused.input.knownTokens).toBe(0)
  expect(reused.output.knownTokens).toBe(0)
  expect(reused.fee).toBeNull()
})

test("missing malformed usage is unreported, not free; identity mismatch blocks", () => {
  const { usage: _, ...withoutUsage } = receipt
  const missing = attemptAccounting(snapshot, "test", { ...withoutUsage,
    checks: [{ ...receipt.checks[0], usage: { inputTokens: -1, outputTokens: 1.5 } }] }, 10)
  expect(missing.input).toEqual({ knownTokens: 0, unreportedInvocations: 2 })
  expect(missing.invocations[0].newOutputTokens).toBeNull()
  expect(() => attemptAccounting(snapshot, "source", receipt, 10)).toThrow("identity")
  expect(() => attemptAccounting(snapshot, "test", receipt, -1)).toThrow("identity")
})
