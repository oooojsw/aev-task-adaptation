import { expect, test } from "bun:test"
import { completion } from "./opencode-completion"

test("final stop supersedes intermediate tool and length steps", () => {
  expect(completion([{ type: "step_finish", part: { reason: "tool-calls" } },
    { type: "step_finish", part: { reason: "length" } },
    { type: "step_finish", part: { reason: "stop" } }], true)).toEqual({ reason: "stop", incomplete: false })
})
test("truncation, unfinished tools and unknown endings cannot complete", () => {
  for (const reason of ["length", "tool-calls", "error", "content-filter", "unknown"]) {
    expect(completion([{ type: "step_finish", part: { reason } }], true)).toEqual({ reason, incomplete: true })
  }
  expect(completion([], true).incomplete).toBe(true)
  expect(completion([{ type: "step_finish", part: {} }], true).incomplete).toBe(true)
  expect(completion([], false).incomplete).toBe(false)
})
