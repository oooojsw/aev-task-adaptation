import { expect, test } from "bun:test"
import { compile } from "./compile"
import { Runtime } from "./runtime"
import { trainingCheckMessage } from "./training-feedback"
import type { Check, Selection } from "./contract"

function snapshot(feedback?: Check["feedback"]) {
  const runtime = new Runtime().addChecker({ id: "checker", version: "1", implementation: "a".repeat(64),
    targets: ["skill"], mechanisms: ["script"], productKinds: ["text"], validate() {} }, async () => ({ status: "passed", message: "ok" }))
  const selection: Selection = { schema: "aev.protocol-plugins.v1",
    project: { id: "project", version: "1", skillFormats: ["text"], productKinds: ["text"], materialKinds: [] },
    run: { skillFormat: "text", productKind: "text", materialKinds: [] },
    protocol: { id: "protocol", version: "1", phases: { source: { claim: "skill_check", checks: [{
      id: "checker", version: "1", settings: {}, name: "quality", target: "skill", stage: "before_execution",
      mechanism: "script", required: true, ...(feedback ? { feedback } : {}) }] } } } }
  return compile(selection, runtime.registry)
}

test("feedback defaults to status while raw oracle remains outside training text", () => {
  const raw = { name: "quality", target: "skill" as const, status: "rejected" as const,
    message: "PRIVATE_EXPECTED_ANSWER: 20260; internal oracle path" }
  expect(trainingCheckMessage(snapshot(), "source", raw)).toBe("Declared skill check quality: rejected")
  expect(trainingCheckMessage(snapshot("status_only"), "source", raw)).not.toContain("20260")
  expect(raw.message).toContain("20260")
  expect(trainingCheckMessage(snapshot("checker_message"), "source", raw)).toBe(raw.message)
})

test("even authorized checker text does not expose infrastructure errors", () => {
  const protocol = snapshot("checker_message")
  for (const status of ["scoring_error", "data_error", "interrupted"] as const) {
    expect(trainingCheckMessage(protocol, "source", { name: "quality", target: "skill", status,
      message: "PRIVATE_ERROR_DETAILS" })).not.toContain("PRIVATE")
  }
  expect(() => trainingCheckMessage(protocol, "source", { name: "unknown", target: "skill",
    status: "rejected", message: "raw" })).toThrow("identity mismatch")
  expect(() => snapshot("guess" as Check["feedback"])).toThrow("feedback policy")
})
