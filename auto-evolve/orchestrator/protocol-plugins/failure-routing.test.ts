import { expect, test } from "bun:test"
import { protocolRepairDirective } from "./failure-routing"

test("ordinary product rejection routes Skill correction, not validator repair or author acceptance", () => {
  const result = protocolRepairDirective({ name: "answer", target: "product", required: true, status: "rejected" })!
  expect(result.key).toBe("skill:product:answer")
  expect(result.title).toBe("Revise Skill after product rejection answer")
  expect(result.actionableFix).toContain("Host alone")
  expect(result.actionableFix).toContain("Do not repair the checker or launch formal acceptance")
})

test("Skill rejection and platform faults have different repair objects; optional rejection adds no required work", () => {
  const skill = protocolRepairDirective({ name: "surface", target: "skill", required: true, status: "rejected" })!
  expect(skill.key).toBe("skill:skill:surface")
  for (const status of ["scoring_error", "execution_error", "data_error"] as const) {
    const fault = protocolRepairDirective({ name: "check", target: "product", required: true, status })!
    expect(fault.key).toBe("acceptance-fault:check")
    expect(fault.actionableFix).toContain("Do not revise Skill")
  }
  expect(protocolRepairDirective({ name: "optional", target: "product", required: false, status: "rejected" })).toBeUndefined()
  expect(protocolRepairDirective({ name: "pass", target: "skill", required: true, status: "passed" })).toBeUndefined()
})
