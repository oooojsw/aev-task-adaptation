import { expect, test } from "bun:test"
import { mkdtemp, writeFile, readFile, link } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { publishTrainingFeedbackResource } from "./feedback-publisher"
import { verifyPublication } from "./publication-evidence"

const cases = Array.from({ length: 50 }, (_, i) => ({ caseID: `case_${i}`, prompt: `Public question ${i}`,
  modelResponse: `Actual answer ${i}`, passed: i < 43, score: i < 43 ? 1 : 0 }))

test("publication reuses only exact contents and validates marker, body and every case", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-publication-"))
  const input = { targetDir: root, campaignID: "campaign", round: 1, cases, expectedCaseIDs: cases.map(item => item.caseID) }
  const first = await publishTrainingFeedbackResource(input)
  expect((await publishTrainingFeedbackResource(input)).manifest.manifestSHA256).toBe(first.manifest.manifestSHA256)
  await expect(publishTrainingFeedbackResource({ ...input, cases: cases.map((item, i) => i ? item : { ...item, modelResponse: "changed" }) })).rejects.toThrow("different content")
  await expect(publishTrainingFeedbackResource({ ...input, expectedCaseIDs: ["wrong"] })).rejects.toThrow("case set")
  await writeFile(path.join(root, ".published"), "0".repeat(64))
  await expect(verifyPublication(first.manifestPath)).rejects.toThrow("marker")
  await writeFile(path.join(root, ".published"), first.manifest.manifestSHA256)
  const file = path.join(root, first.manifest.cases[0].path)
  await writeFile(file, "changed")
  await expect(publishTrainingFeedbackResource(input)).rejects.toThrow("digest")
})

test("publication rejects linked files, Windows reserved names, races and interrupted attempts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-publication-negative-"))
  const input = { targetDir: path.join(root, "race"), campaignID: "campaign", round: 1, cases }
  const results = await Promise.allSettled([publishTrainingFeedbackResource(input), publishTrainingFeedbackResource(input)])
  expect(results.some(item => item.status === "fulfilled")).toBe(true)
  const saved = await verifyPublication(path.join(input.targetDir, "manifest.json"))
  expect(saved.cases).toHaveLength(50)
  await link(path.join(input.targetDir, saved.cases[0].path), path.join(root, "alias.json"))
  await expect(verifyPublication(path.join(input.targetDir, "manifest.json"))).rejects.toThrow("unlinked")
  await expect(publishTrainingFeedbackResource({ ...input, targetDir: path.join(root, "reserved"), cases: [{ ...cases[0], caseID: "CON" }] })).rejects.toThrow("dangerous")
  const partial = { ...input, targetDir: path.join(root, "partial"), maxTotalBytes: 1 }
  await expect(publishTrainingFeedbackResource(partial)).rejects.toThrow("capacity_exceeded")
  await expect(publishTrainingFeedbackResource(partial)).rejects.toThrow("explicit recovery")
  await expect(readFile(path.join(partial.targetDir, ".published"))).rejects.toThrow()
})
