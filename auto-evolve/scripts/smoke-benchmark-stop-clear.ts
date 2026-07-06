import assert from "node:assert/strict"
import { clearPausedStopMarkerForResume, type BenchmarkState } from "./run-benchmark-orchestrator"

function minimalState(stop?: BenchmarkState["stop"]): BenchmarkState {
  return {
    runID: "smoke-stop-clear",
    phase: "training",
    updatedAt: new Date(0).toISOString(),
    config: {} as BenchmarkState["config"],
    trainIDs: [],
    testIDs: [],
    trainResults: [],
    stop,
  }
}

const paused = minimalState({
  status: "paused_by_user",
  requestedAt: "2026-07-06T00:00:00.000Z",
  stoppedAt: "2026-07-06T00:01:00.000Z",
  reason: "smoke",
})
assert.equal(clearPausedStopMarkerForResume(paused), true)
assert.equal(paused.stop, undefined)

const other = minimalState({
  status: "manual_hold",
  reason: "not a stale pause marker",
})
assert.equal(clearPausedStopMarkerForResume(other), false)
assert.equal(other.stop?.status, "manual_hold")

const empty = minimalState()
assert.equal(clearPausedStopMarkerForResume(empty), false)
assert.equal(empty.stop, undefined)

console.log("smoke-benchmark-stop-clear: ok")
