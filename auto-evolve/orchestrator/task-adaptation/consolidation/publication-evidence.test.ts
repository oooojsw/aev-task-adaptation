import { expect, test } from "bun:test"
import { mkdtemp, writeFile, readFile, link, readdir, stat } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { publishTrainingFeedbackResource } from "./feedback-publisher"
import { verifyPublication } from "./publication-evidence"
import { withPublicationLock } from "./publication-lock"

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

test("explicit same-identity recovery completes remaining cases without rewriting prior files or invoking a provider", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-publication-recovery-"))
  const input = { targetDir: root, campaignID: "campaign", round: 1, cases }
  // 先用同一序列化器获得精确前25题容量，不靠猜测文件大小。
  const full = await publishTrainingFeedbackResource({ ...input, targetDir: path.join(root, "reference") })
  const limit = full.manifest.cases.slice(0, 25).reduce((sum, item) => sum + item.bytes, 0)
  const partial = { ...input, targetDir: path.join(root, "partial"), maxTotalBytes: limit }
  await expect(publishTrainingFeedbackResource(partial)).rejects.toThrow("capacity_exceeded")
  expect((await readdir(path.join(partial.targetDir, "cases"))).length).toBe(25)
  await expect(readFile(path.join(partial.targetDir, ".published"))).rejects.toThrow()
  const before = await readFile(path.join(partial.targetDir, "cases", "case_case_0.json"))
  await expect(publishTrainingFeedbackResource({ ...partial, maxTotalBytes: 1000000, cases: cases.map((item, i) => i ? item : { ...item, modelResponse: "changed" }), recoverIncomplete: true })).rejects.toThrow("identity")
  const recovered = await publishTrainingFeedbackResource({ ...partial, maxTotalBytes: 1000000, recoverIncomplete: true })
  expect(recovered.manifest.cases).toHaveLength(50)
  expect(await readFile(path.join(partial.targetDir, "cases", "case_case_0.json"))).toEqual(before)
  expect((await verifyPublication(recovered.manifestPath)).passedCases).toBe(43)
  expect((await publishTrainingFeedbackResource({ ...partial, maxTotalBytes: 1000000 })).manifest.manifestSHA256).toBe(recovered.manifest.manifestSHA256)
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

test("hard-killed publisher and recovery release their mutex without a failure marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-publication-hardkill-"))
  const input = { targetDir: root, campaignID: "campaign", round: 1, cases }
  for (const mode of ["fresh", "recover"]) {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/publication-interruption.ts"), root, mode],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    try {
      const reader = child.stdout.getReader()
      const signal = await Promise.race([reader.read(), child.exited.then(async code => {
        throw new Error(`Fixture exited ${code}: ${await new Response(child.stderr).text()}`)
      }), Bun.sleep(15000).then(() => { throw new Error("Fixture checkpoint timed out") })])
      expect(new TextDecoder().decode(signal.value)).toContain("checkpoint")
      reader.releaseLock()
      await expect(publishTrainingFeedbackResource({ ...input, recoverIncomplete: true })).rejects.toThrow("writer active")
      await expect(readFile(path.join(root, "publication.failed.json"))).rejects.toThrow()
    } finally {
      // 此句柄由夹具直接创建，不按PID猜测或终止其他运行。
      child.kill()
      await child.exited
    }
  }
  const before = await readFile(path.join(root, "cases/case_case_0.json"))
  const saved = await publishTrainingFeedbackResource({ ...input, recoverIncomplete: true })
  expect(saved.manifest.cases).toHaveLength(50)
  expect(await readFile(path.join(root, "cases/case_case_0.json"))).toEqual(before)
  expect((await verifyPublication(saved.manifestPath)).passedCases).toBe(43)
}, 45000)

test("live or unknown owner cannot be recovered without a failure marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-publication-owner-"))
  const input = { targetDir: root, campaignID: "campaign", round: 1, cases }
  await expect(publishTrainingFeedbackResource({ ...input, maxTotalBytes: 1 })).rejects.toThrow("capacity")
  const { unlink } = await import("node:fs/promises")
  await unlink(path.join(root, "publication.failed.json"))
  await expect(publishTrainingFeedbackResource({ ...input, recoverIncomplete: true })).rejects.toThrow("not proven terminated")
  await writeFile(path.join(root, "publication.started.claim"), "{}")
  await expect(publishTrainingFeedbackResource({ ...input, recoverIncomplete: true })).rejects.toThrow("requires inspection")
})

test("mutex is released after an ordinary exception and rejects linked lock files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-publication-mutex-"))
  await expect(withPublicationLock(root, async () => { throw new Error("fixture") })).rejects.toThrow("fixture")
  expect(await withPublicationLock(root, async () => 7)).toBe(7)
  await link(path.join(root, "publication.mutex.sqlite"), path.join(root, "alias"))
  await expect(withPublicationLock(root, async () => 0)).rejects.toThrow("unlinked")
})

test("initialization can recover after intent or atomic claim without any case or failure file", async () => {
  for (const stage of ["publication.intent.json", "publication.started.claim"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "aev-publication-init-"))
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/publication-interruption.ts"), root, "fresh", stage],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    try {
      const reader = child.stdout.getReader()
      const checkpoint = await Promise.race([reader.read(), Bun.sleep(15000).then(() => { throw new Error("Initialization checkpoint timed out") })])
      expect(new TextDecoder().decode(checkpoint.value)).toContain("checkpoint")
      reader.releaseLock()
      await expect(readFile(path.join(root, "publication.failed.json"))).rejects.toThrow()
    } finally { child.kill(); await child.exited }
    const result = await publishTrainingFeedbackResource({ targetDir: root, campaignID: "campaign", round: 1, cases, recoverIncomplete: true })
    expect((await verifyPublication(result.manifestPath)).totalCases).toBe(50)
  }
}, 45000)

test("another recovery failure preserves original failure diagnostics and file identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-publication-failures-"))
  const input = { targetDir: root, campaignID: "campaign", round: 1, cases, maxTotalBytes: 1 }
  await expect(publishTrainingFeedbackResource(input)).rejects.toThrow("capacity")
  const file = path.join(root, "publication.failed.json")
  const data = JSON.parse(await readFile(file, "utf8"))
  await writeFile(file, JSON.stringify({ ...data, diagnostic: "original diagnostic retained" }))
  const before = await readFile(file)
  const stamp = await stat(file)
  await expect(publishTrainingFeedbackResource({ ...input, recoverIncomplete: true })).rejects.toThrow("capacity")
  expect(await readFile(file)).toEqual(before)
  expect((await stat(file)).ino).toBe(stamp.ino)
  expect((await stat(file)).mtimeMs).toBe(stamp.mtimeMs)
  expect(await readdir(path.join(root, "publication.failures"))).toHaveLength(2)
  const failures = await Promise.all((await readdir(path.join(root, "publication.failures"))).map(async name =>
    JSON.parse(await readFile(path.join(root, "publication.failures", name), "utf8"))))
  expect(new Set(failures.map(item => item.attempt)).size).toBe(2)
  expect(failures.every(item => item.reason === "capacity_exceeded" && item.stage && Date.parse(item.at))).toBe(true)
})
