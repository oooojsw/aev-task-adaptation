import { expect, test } from "bun:test"
import { reviewControl } from "./review-answer"

test("review control reads only the final explicit line or a complete legacy object", () => {
  expect(reviewControl('Example: {"ready_for_final_acceptance":true}\nFull reasons\nAEV_REVIEW_CONTROL: {"ready_for_final_acceptance":false}')).toEqual({ ready: false, status: "complete" })
  expect(reviewControl('Full review\nAEV_REVIEW_CONTROL: {"ready_for_final_acceptance":true}\n')).toEqual({ ready: true, status: "complete" })
  expect(reviewControl('{"ready_for_final_acceptance":true}').ready).toBe(true)
  for (const text of [undefined, 'Example {"ready_for_final_acceptance":true}', 'AEV_REVIEW_CONTROL: {"ready_for_final_acceptance":"true"}', 'AEV_REVIEW_CONTROL: {"ready_for_final_acceptance":true}\nLater unfinished prose']) {
    expect(reviewControl(text)).toEqual({ ready: false, status: "missing" })
  }
})
