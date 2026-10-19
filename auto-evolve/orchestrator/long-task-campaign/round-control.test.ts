import { expect, test } from "bun:test"
import type { LongTaskSpec } from "../long-task/contract"
import type { LongTaskCampaignRoundRecord } from "./contract"
import { finalizeTaskRound, roundOutcome } from "./round-control"

function input() {
  return { round: 1, maxRounds: 3, record: { roundClosure: "closed_blocked", gateFailureKind: "final_acceptance_failed",
    gateFailureSummary: "prior", runVerificationSignal: { completionGateMode: "required", completionGatePassed: true } } as LongTaskCampaignRoundRecord }
}

test("normal close retains no-adaptation success, refusal and round limit semantics", () => {
  const base = input()
  expect(roundOutcome(base)).toMatchObject({ nextStatus: "running", lastRoundClosure: "closed_blocked",
    lastGateFailureSummary: "prior", lastRunHardVerified: true })
  expect(roundOutcome({ ...base, acceptance: { passed: false, summary: "repair" } })).toMatchObject({
    nextStatus: "running", lastRoundClosure: "closed_repairable", lastGateFailureKind: "final_acceptance_failed",
    lastGateFailureSummary: "repair" })
  expect(roundOutcome({ ...base, acceptance: { passed: true, summary: "passed" } })).toMatchObject({ nextStatus: "verified_success", lastRoundClosure: "closed_success" })
  expect(roundOutcome({ ...base, round: 3 })).toMatchObject({ nextStatus: "round_limit_reached" })
})

test("formal selection controls stopping, not the latest acceptance alone", () => {
  const base = input()
  const selected = { selectedTaskVersionPath: "best.json", taskStopReason: undefined, stop: false, passed: true }
  expect(roundOutcome({ ...base, acceptance: { passed: true, summary: "qualified" }, selection: selected }).nextStatus).toBe("running")
  expect(roundOutcome({ ...base, acceptance: { passed: false, summary: "rejected" }, selection: { ...selected, stop: true } }).nextStatus).toBe("verified_success")
  expect(roundOutcome({ ...base, selection: { ...selected, passed: false, stop: true } }).nextStatus).toBe("round_limit_reached")
})

test("infrastructure and dataset failures outrank previous qualified delivery", () => {
  const base = input(), selection = { selectedTaskVersionPath: "best.json", taskStopReason: "stagnant", stop: true, passed: true }
  for (const failureKind of ["infrastructure_failure", "dataset_failure"] as const) {
    const result = roundOutcome({ ...base, selection, acceptance: { passed: false, summary: "fault", failureKind } })
    expect(result.nextStatus).toBe("failed")
    expect(result.lastGateFailureKind).toBe(failureKind)
    expect(result.lastRoundClosure).toBe(failureKind === "dataset_failure" ? "closed_dataset_failure" : "closed_infra_failure")
  }
})

test("hard verification is true only for the required completed gate", () => {
  for (const signal of [undefined, { completionGateMode: "required", completionGatePassed: false },
    { completionGateMode: "advisory", completionGatePassed: true }]) {
    const result = roundOutcome({ ...input(), record: { runVerificationSignal: signal } as LongTaskCampaignRoundRecord })
    expect(result.lastRunHardVerified).not.toBe(true)
  }
})

test("actual shared finalizer leaves legacy task selection absent", async () => {
  const result = await finalizeTaskRound({} as LongTaskSpec, { ...input(), root: "unused", candidateRoot: "unused",
    acceptance: { passed: true, summary: "done" } })
  expect(result.taskSelection).toBeUndefined()
  expect(result.nextStatus).toBe("verified_success")
})
