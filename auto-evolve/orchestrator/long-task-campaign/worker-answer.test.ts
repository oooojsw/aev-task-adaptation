import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { finalWorkerAnswer, publishWorkerAnswer, readWorkerAnswer, workerDelivery } from "./worker-answer"
import type { OpencodeRunResult } from "../opencode"

function fixture(): OpencodeRunResult {
  return { exitCode: 0, sessionID: "s", stdout: "TOOL_LOG", stderr: "", responseText: "MIXED_TRANSCRIPT",
    toolFailures: [], events: [
      { type: "assistant_message", message: { id: "summary", role: "assistant", summary: true } },
      { type: "text", sessionID: "s", part: { id: "summary-text", messageID: "summary", text: "COMPACTION_SUMMARY" } },
      { type: "step_finish", part: { messageID: "summary", reason: "stop" } },
      { type: "assistant_message", message: { id: "tool", role: "assistant", summary: false } },
      { type: "text", sessionID: "s", part: { messageID: "tool", text: "I'll read the files" } },
      { type: "tool_use", part: { messageID: "tool", tool: "read", state: { output: "TOOL_SECRET" } } },
      { type: "step_finish", part: { messageID: "tool", reason: "tool-calls" } },
      { type: "assistant_message", message: { id: "final", role: "assistant", summary: false } },
      { type: "reasoning", sessionID: "s", part: { messageID: "final", text: "HIDDEN_REASONING" } },
      { type: "text", sessionID: "s", part: { id: "a", messageID: "final", text: "# Findings\nPlain text, not JSON." } },
      { type: "text", sessionID: "s", part: { id: "a", messageID: "final", text: "# Findings\nPlain text, not JSON." } },
      { type: "text", sessionID: "s", part: { id: "b", messageID: "final", text: "Evidence and recommendations." } },
      { type: "text", sessionID: "other", part: { messageID: "final", text: "OTHER_SESSION" } },
      { type: "step_finish", part: { messageID: "final", reason: "stop" } },
    ] }
}

test("only the complete final message is delivered without parsing or transcript contamination", () => {
  expect(finalWorkerAnswer(fixture())).toEqual({ text: "# Findings\nPlain text, not JSON.\n\nEvidence and recommendations." })
})

for (const reason of ["length", "tool-calls", "content-filter"]) {
  test(`unfinished ${reason} is not silently replaced by earlier text`, () => {
    const result = fixture()
    result.events.at(-1)!.part.reason = reason
    expect(finalWorkerAnswer(result)).toEqual({ reason: `worker_not_finished:${reason}` })
  })
}

test("summary, legacy unclassified, empty and failed results are explicit unavailable deliveries", () => {
  const summary = fixture()
  summary.events.find(event => event.message?.id === "final")!.message!.summary = true
  expect(finalWorkerAnswer(summary).reason).toBe("summary_is_not_worker_delivery")
  const legacy = fixture()
  legacy.events = legacy.events.filter(event => event.type !== "assistant_message")
  expect(finalWorkerAnswer(legacy).reason).toBe("final_message_identity_missing")
  const empty = fixture()
  empty.events = empty.events.filter(event => event.type !== "text")
  expect(finalWorkerAnswer(empty).reason).toBe("final_answer_empty")
  const failed = fixture()
  failed.exitCode = 1
  expect(finalWorkerAnswer(failed).reason).toBe("worker_execution_failed")
})

test("saved final answer survives reload, preserves long content and rejects tampering", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aev-worker-final-"))
  const result = fixture()
  const body = "完整分析\n".repeat(20000)
  result.events = result.events.filter(event => event.type !== "text")
  result.events.splice(-1, 0, { type: "text", sessionID: "s", part: { id: "body", messageID: "final", text: body } })
  const metadata = await publishWorkerAnswer(dir, result)
  expect(metadata.status).toBe("complete")
  expect(await readWorkerAnswer(dir, JSON.parse(JSON.stringify(metadata)))).toBe(body)
  expect(await workerDelivery(dir, JSON.parse(JSON.stringify(metadata)))).toBe(path.join(dir, "final-answer.txt"))
  expect(await Bun.file(await workerDelivery(dir)).text()).toContain("no automatic replay")
  await writeFile(path.join(dir, "final-answer.txt"), "changed")
  await expect(readWorkerAnswer(dir, metadata)).rejects.toThrow("fingerprint drift")
  await expect(readWorkerAnswer(dir, { ...metadata, file: "../private.txt" as "final-answer.txt" })).rejects.toThrow("identity")
})

test("another session cannot replace the worker terminal status", () => {
  const result = fixture()
  result.events.push({ type: "step_finish", sessionID: "other", part: { messageID: "other", reason: "length" } })
  expect(finalWorkerAnswer(result).text).toContain("Plain text, not JSON.")
})
