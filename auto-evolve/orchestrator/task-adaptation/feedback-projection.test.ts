import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { feedbackProjection } from "./feedback-projection"

test("Host rebind projects exact historical bytes without changing a verdict or overwriting history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aev-feedback-rebind-"))
  try {
    await mkdir(path.join(root, "task-adaptation"))
    const file = path.join(root, "task.feedback.json")
    const saved = { planFingerprint: "a".repeat(64), status: "rejected", issues: ["length"] }
    const view = { ...saved, planFingerprint: "b".repeat(64) }
    await writeFile(file, JSON.stringify(saved))
    await expect(feedbackProjection(root, file, saved, view)).rejects.toThrow()
    const bytes = await readFile(file)
    await writeFile(path.join(root, "task-adaptation/feedback-rebind.json"), JSON.stringify({
      schema: "aev.feedback-rebind.v1", from: saved.planFingerprint, to: view.planFingerprint,
      views: [{ path: "task.feedback.json", sha256: createHash("sha256").update(bytes).digest("hex") }] }))
    expect(await feedbackProjection(root, file, saved, view)).toEndWith(`task.feedback.${view.planFingerprint}.json`)
    expect(await readFile(file)).toEqual(bytes)
    await expect(feedbackProjection(root, file, saved, { ...view, status: "passed" })).rejects.toThrow("drift")
    await expect(feedbackProjection(root, file, saved, { ...view, planFingerprint: "c".repeat(64) })).rejects.toThrow()
    await writeFile(file, JSON.stringify({ ...saved, issues: [] }))
    await expect(feedbackProjection(root, file, saved, view)).rejects.toThrow("Host rebind")
  } finally { await rm(root, { recursive: true, force: true }) }
})
