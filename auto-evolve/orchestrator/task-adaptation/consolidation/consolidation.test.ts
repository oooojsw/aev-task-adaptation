import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CONSOLIDATION_PROFILE_ID, digest, frozenModels, publication, score, type DirectChatSummary } from "./contract"
import { freezeSources } from "./source-manifest"
import { consolidationCatalogue, consolidationProfile } from "./profile"
import { compileTask } from "../catalogue"
import { chooseTaskVersion } from "../selection"

const key = digest("candidate")
const dataset = digest("frozen-data")
function evidence(total: number, passed: number): DirectChatSummary {
  const rows = Array.from({ length: total }, (_, i) => ({
    caseID: `q${i + 1}`, modelID: "model", skillHash: key, skillMode: "with-skill", skillTier: "custom",
    passed: i < passed, score: i < passed ? 1 : 0, attempts: 1,
    errorCategory: i < passed ? "none" : "validation",
    requestAuditPath: "/run/request.json", responseAuditPath: "/run/response.json",
    validatorResultPath: "/run/validator.json",
  }))
  return { validity: { status: "valid", skillHash: key, datasetHash: dataset,
    skillTierSelection: [{ modelID: "model", selectedHash: key, truncated: false, selectedTier: "custom" }] },
    summary: [{ modelID: "model", total, passed, failed: total - passed, passRate: passed / total }], results: rows }
}
function evaluate(summary: DirectChatSummary) {
  return score({ summary, cases: summary.results.map(row => row.caseID), modelID: "model",
    skillHash: key, datasetHash: dataset })
}

test("full published Unicode Skill: 5000 boundary, NFC, whitespace and emoji", () => {
  expect(publication(Buffer.from("中".repeat(5000))).chars).toBe(5000)
  expect(() => publication(Buffer.from("中".repeat(5001)))).toThrow("exceeds")
  expect(publication(Buffer.from("\u0065\u0301 💫")).chars).toBe(2)
  expect(publication(Buffer.from("🙂".repeat(5000))).chars).toBe(5000)
  expect(() => publication(Buffer.from("🙂".repeat(5001)))).toThrow()
  expect(() => publication(Buffer.from([0xc3, 0x28]))).toThrow()
  expect(() => publication(Buffer.from("\uFEFFhello"))).toThrow()
  expect(() => publication(Buffer.from("  \n"))).toThrow()
  expect(() => publication(Buffer.from("yes"), 5001)).toThrow()
})

test("50 independent single-turn verdicts: 0, 43, 50 passes", () => {
  for (const passed of [0, 43, 50]) {
    const result = evaluate(evidence(50, passed))
    expect(result).toEqual({ total: 50, passed, failed: 50 - passed, pass_rate: passed / 50 })
  }
})

test("fail closed on tampered scores, identity, attempt count, missing cases and infrastructure", () => {
  const fixtures: Array<(s: DirectChatSummary) => void> = [
    s => { s.summary[0]!.passRate = 1 },
    s => { s.results[1]!.caseID = s.results[0]!.caseID },
    s => { s.results.pop() },
    s => { s.results[0]!.modelID = "different" },
    s => { s.results[0]!.skillHash = digest("another") },
    s => { s.results[0]!.attempts = 2 },
    s => { s.results[0]!.errorCategory = "timeout" },
    s => { s.results[0]!.requestAuditPath = undefined },
    s => { s.results[0]!.passed = true; s.results[0]!.score = 0 },
    s => { s.results[0]!.outputBudgetExceeded = true },
    s => { s.validity.status = "invalid" },
    s => { s.validity.skillTierSelection![0]!.truncated = true },
    s => { s.validity.skillTierSelection![0]!.selectedTier = "head-tail" },
    s => { s.validity.datasetHash = digest("changed") },
  ]
  for (const change of fixtures) {
    const summary = evidence(50, 43)
    change(summary)
    expect(() => evaluate(summary)).toThrow()
  }
})

test("one-turn model settings override retries and forbid truncated input", () => {
  const models = frozenModels({ models: { model: { transport: "mock" } },
    retry: { maxAttempts: 3 }, transientRecovery: { enabled: true, maxRounds: 2 } }, "model")
  expect(models.retry!.maxAttempts).toBe(1)
  expect(models.transientRecovery!.enabled).toBe(false)
  expect(models.models.model.skillInputMode).toBe("full")
  expect(() => frozenModels({ models: { model: { skillInputMode: "head-tail" } } }, "model")).toThrow()
  expect(() => frozenModels({ models: {} }, "missing")).toThrow()
})

test("consolidation profile reuses kind skill and best_pass", () => {
  const profile = consolidationProfile("merged_skill", "skill-write")
  expect(profile.id).toBe(CONSOLIDATION_PROFILE_ID)
  expect(profile.kinds).toEqual(["skill"])
  expect(profile.selection).toEqual({ rule: "best_pass", metric: "pass_rate", direction: "max" })
  expect(profile.acceptance.execution).toBe("script")
  expect(profile.acceptance.checks.map(row => row.target)).toEqual(["candidate", "product"])
})

test("50 frozen source Skill paths are read-only and hash bound", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "consolidation-source-"))
  await mkdir(path.join(root, "skills"))
  const cases = Array.from({ length: 50 }, (_, i) => `q${i + 1}`)
  const sources = await Promise.all(cases.map(async (id, i) => {
    const name = `skills/skill-${i + 1}.md`
    const bytes = Buffer.from(`Reusable method ${i + 1}`)
    await writeFile(path.join(root, name), bytes)
    return { id: `source-${i + 1}`, caseID: id, path: name, sha256: digest(bytes) }
  }))
  const manifest = path.join(root, "sources.json")
  await writeFile(manifest, JSON.stringify({ schema: "aev.consolidation-sources.v1", sources }))
  const valid = await freezeSources(root, "sources.json", cases)
  expect(valid.length).toBe(50)
  await writeFile(path.join(root, "DIRECT_CHAT.md"), "A first candidate.")
  const cat = await consolidationCatalogue({
    root, manifest: "sources.json", cases, id: "consolidate-50",
    objective: "Consolidate source Skills and improve single-turn answers",
    stop: { rounds: 3, calls: 500, tokens: 100000, stagnant: 2 },
  })
  expect(cat.resources).toHaveLength(52)
  const compiled = compileTask(cat, { kind: "skill",
    profiles: [CONSOLIDATION_PROFILE_ID], needs: [], workers: [], rationale: "Trust frozen sources and acceptance" })
  expect(compiled.status).toBe("ready")
  if (compiled.status === "ready") {
    expect(compiled.plan.selection).toEqual({ rule: "best_pass", metric: "pass_rate", direction: "max" })
    expect(compiled.plan.resources.filter(item => item.audience === "training")).toHaveLength(51)
    expect(compiled.plan.windows.find(w => w.role === "independent")?.reads).toEqual(["merged_skill"])
  }
  await writeFile(path.join(root, sources[0]!.path), "tampered")
  await expect(freezeSources(root, "sources.json", cases)).rejects.toThrow("hash drift")
  sources[0]!.path = "../escape.md"
  await writeFile(manifest, JSON.stringify({ schema: "aev.consolidation-sources.v1", sources }))
  await expect(freezeSources(root, "sources.json", cases)).rejects.toThrow("Invalid source")
  sources[0]!.path = "skills/link.md"
  try {
    await symlink(path.join(root, "skills", "skill-2.md"), path.join(root, "skills", "link.md"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return
    throw error
  }
  await writeFile(manifest, JSON.stringify({ schema: "aev.consolidation-sources.v1", sources }))
  await expect(freezeSources(root, "sources.json", cases)).rejects.toThrow("Invalid linked")
  expect((await readFile(manifest, "utf8")).length).toBeGreaterThan(0)
})

 
test("existing best_pass selector retains second of three accepted rounds (38 → 43 → 41)", () => {
  const spec = { taskAdaptationContext: { plan: {
    selection: { rule: "best_pass", metric: "pass_rate", direction: "max" },
    stop: { rounds: 3, stagnant: 2 },
  } } }
  const versions = [38, 43, 41].map((count, i) => ({
    record: { round: i + 1, metric: count / 50 },
    path: `accepted-round-${i + 1}`,
  }))
  const selected = chooseTaskVersion(spec as never, versions as never, 3, 3)
  expect(selected.selectedTaskVersionPath).toBe("accepted-round-2")
  expect(selected.taskStopReason).toBe("round_budget")
})
