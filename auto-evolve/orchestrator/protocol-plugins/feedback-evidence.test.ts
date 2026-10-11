import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID, createHash } from "node:crypto"
import { protocolFeedbackEvidence, previousProtocolFeedback } from "./feedback-evidence"

test("training feedback grants only the exact real product, rejects drift and private path substitution", async () => {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(root, { recursive: true })
  const file = path.join(root, "protocol.product.txt")
  const viewFile = path.join(root, "protocol.training-feedback.json")
  const feedbackFile = path.join(root, "result.json.training.json")
  const product = Buffer.from("Actual generated answer")
  const view = { schema: "aev.training-feedback.v1", product: { kind: "text", path: file, length: product.length,
    sha256: createHash("sha256").update(product).digest("hex") } }
  await writeFile(file, product)
  await writeFile(viewFile, JSON.stringify(view))
  expect(await protocolFeedbackEvidence(feedbackFile)).toEqual([viewFile, file])
  await writeFile(file, "Tampered answer")
  await expect(protocolFeedbackEvidence(feedbackFile)).rejects.toThrow("hash drift")
  await writeFile(file, product)
  await writeFile(viewFile, JSON.stringify({ ...view, product: { ...view.product, path: path.join(root, "private/gold.json") } }))
  await expect(protocolFeedbackEvidence(feedbackFile)).rejects.toThrow("path drift")
  expect(await protocolFeedbackEvidence()).toEqual([])
})

test("Skill-only feedback has no fabricated execution product", async () => {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(root, { recursive: true })
  const view = path.join(root, "protocol.training-feedback.json")
  await writeFile(view, JSON.stringify({ schema: "aev.training-feedback.v1", claim: "skill_check" }))
  expect(await protocolFeedbackEvidence(path.join(root, "result.json.training.json"))).toEqual([view])
})

test("cross-round feedback binds task and selected phase and refuses outside paths", async () => {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  const acceptance = path.join(root, "rounds/round-001/final-acceptance")
  const pass = path.join(acceptance, "pass-02")
  await mkdir(pass, { recursive: true })
  const feedback = path.join(pass, "result.json.training.json")
  const view = path.join(pass, "protocol.training-feedback.json")
  await writeFile(feedback, "{}")
  await writeFile(view, JSON.stringify({ schema: "aev.training-feedback.v1", task: "merge-task", phase: "merge" }))
  const result = { acceptanceMode: "protocol_plugins", roundNumber: 1, protocolTrainingResultPath: feedback }
  await writeFile(path.join(acceptance, "result.json"), JSON.stringify(result))
  expect(await previousProtocolFeedback(root, 1, "merge-task", "merge")).toBeUndefined()
  expect(await previousProtocolFeedback(root, 2, "merge-task", "merge")).toBe(feedback)
  await expect(previousProtocolFeedback(root, 2, "different-task", "merge")).rejects.toThrow("task mismatch")
  await expect(previousProtocolFeedback(root, 2, "merge-task", "source")).rejects.toThrow("task mismatch")
  await writeFile(path.join(acceptance, "result.json"), JSON.stringify({ ...result, protocolTrainingResultPath: path.join(root, "private/gold.json") }))
  await expect(previousProtocolFeedback(root, 2, "merge-task", "merge")).rejects.toThrow("path escape")
})
