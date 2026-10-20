import { expect, test } from "bun:test"
import { completeUsage } from "./consolidation"

test("consolidation partial usage remains unknown, including invalid and overflowing counts", () => {
  expect(completeUsage([{ inputTokens: 10, outputTokens: 2 }, { outputTokens: 3 }])).toEqual({ outputTokens: 5 })
  expect(completeUsage([{ inputTokens: 10, outputTokens: 2 }, undefined])).toEqual({})
  expect(completeUsage([])).toEqual({})
  expect(completeUsage([{ inputTokens: -1, outputTokens: 0 }])).toEqual({ outputTokens: 0 })
  expect(completeUsage([{ inputTokens: Number.MAX_SAFE_INTEGER }, { inputTokens: 1 }])).toEqual({})
  expect(completeUsage([{ inputTokens: 10, outputTokens: 2 }, { inputTokens: 20, outputTokens: 3 }])).toEqual({ inputTokens: 30, outputTokens: 5 })
})
