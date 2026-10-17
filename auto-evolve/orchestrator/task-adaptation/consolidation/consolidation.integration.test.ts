import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { consolidationPlugins, preflightConsolidation } from "../../protocol-plugins/consolidation"
import { digest } from "./contract"

// Real Direct Chat runner + mock provider + real isolated validator process; no API credentials.
test("trusted executor verifies two independent single-turn mock cases", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aev-consolidation-e2e-"))
  const validator = path.join(dir, "validator.mjs")
  await writeFile(validator, [
    'import { readFileSync } from "node:fs"',
    'const args = process.argv',
    'const answer = readFileSync(args[args.indexOf("--candidate") + 1], "utf8").trim()',
    'const expected = args[args.indexOf("--expected") + 1]',
    'console.log(JSON.stringify({ passed: answer === expected }))',
  ].join("\n"))
  const rows = ["q1", "q2"].map((caseID, index) => ({
    schema: "direct-chat-case/v1", caseID, dataset: "test", split: "train",
    question: { text: `What is the answer for ${caseID}?`, outputInstruction: "One number" },
    materials: [{ id: "sample", title: "Visible evidence", type: "text", content: `Public material for ${caseID}` }],
    materialAudit: { caseID, expectedSources: [], includedMaterials: ["sample"], omittedSources: [], warnings: [], tokenEstimate: 4, compressionPolicy: "none" },
    privateOracle: { validatorID: "fixture", runner: "bun", scriptPath: validator,
      args: ["--candidate", "", "--expected", index === 0 ? "42" : "43"], candidateArgName: "--candidate" },
  }))
  const data = path.join(dir, "cases.jsonl")
  const models = path.join(dir, "models.json")
  await writeFile(data, rows.map(row => JSON.stringify(row)).join("\n") + "\n")
  await writeFile(models, JSON.stringify({ models: { m: { transport: "mock", mockResponse: "<answer>42</answer>",
    contextWindowTokens: 32768, maxOutputTokens: 128 } } }))
  const settings = {
    candidateID: "merged_skill", maxChars: 5000, expectedCases: 2, modelID: "m",
    datasetPath: data, datasetSHA256: digest(await readFile(data)),
    modelsPath: models, modelsSHA256: digest(await readFile(models)), concurrency: 2,
  }
  const gate = { candidateID: settings.candidateID, maxChars: 5000, expectedCases: 2,
    modelID: "m", datasetSHA256: settings.datasetSHA256 }
  const publication = Buffer.from("General rule: use the visible public material to answer.")
  const skill = [{ id: "merged_skill", kind: "text", bytes: publication,
    sha256: digest(publication), length: publication.length }]
  const plugin = await consolidationPlugins(path.join(dir, "plugin"))
  await preflightConsolidation(settings)
  const pre = await plugin.evaluate({ task: "merge", phase: "source", settings: gate,
    skill, materials: [], privateInputs: [], candidate: skill,
    check: { name: "consolidation_surface", target: "skill", stage: "before_execution", mechanism: "script" } })
  expect(pre.status).toBe("passed")
  const res = await plugin.execute({ task: "merge", phase: "source", settings, skill, materials: [] })
  expect(res.status).toBe("completed")
  const product = JSON.parse(Buffer.from(res.product!.bytes).toString("utf8"))
  expect(product).toMatchObject({ total: 2, passed: 1, failed: 1, pass_rate: 0.5,
    candidate_sha256: digest(publication) })
  const post = await plugin.evaluate({ task: "merge", phase: "source", settings: gate,
    skill, materials: [], privateInputs: [],
    candidate: [{ id: "execution-product", kind: "json", bytes: res.product!.bytes,
      sha256: digest(res.product!.bytes), length: res.product!.bytes.length }],
    check: { name: "consolidation_score", target: "product", stage: "after_execution", mechanism: "script" } })
  expect(post.status).toBe("passed")
  const report = path.join(dir, "plugin", product.runID, "direct-chat")
  const results = JSON.parse(await readFile(path.join(report, "summary.json"), "utf8"))
  expect(results.results.map((x: any) => x.attempts)).toEqual([1, 1])
  expect(results.results.map((x: any) => x.caseID).sort()).toEqual(["q1", "q2"])
  expect((await readFile(path.join(report, "results", "m", "q1", "prompt.system.txt"), "utf8"))).toContain("General rule")
  expect((await readFile(path.join(report, "results", "m", "q1", "prompt.user.txt"), "utf8"))).toContain("Public material for q1")
  expect((await readFile(path.join(report, "results", "m", "q1", "prompt.user.txt"), "utf8"))).not.toContain("--expected")
  expect(await readdir(path.join(dir, "plugin"))).toHaveLength(1)
  const bad = { ...product, pass_rate: 1 }
  const tampered = Buffer.from(JSON.stringify(bad))
  const rejected = await plugin.evaluate({ task: "merge", phase: "source", settings: gate,
    skill, materials: [], privateInputs: [],
    candidate: [{ id: "execution-product", kind: "json", bytes: tampered,
      sha256: digest(tampered), length: tampered.length }],
    check: { name: "consolidation_score", target: "product", stage: "after_execution", mechanism: "script" } })
  expect(rejected.status).toBe("scoring_error")
  const long = Buffer.from("汉".repeat(5001))
  const over = await plugin.evaluate({ task: "merge", phase: "source", settings: gate,
    skill: [{ id: "merged_skill", kind: "text", bytes: long, sha256: digest(long), length: long.length }],
    materials: [], privateInputs: [], candidate: [{ id: "merged_skill", kind: "text", bytes: long,
      sha256: digest(long), length: long.length }],
    check: { name: "consolidation_surface", target: "skill", stage: "before_execution", mechanism: "script" } })
  expect(over.status).toBe("rejected")
  await writeFile(models, "{}")
  await expect(preflightConsolidation(settings)).rejects.toThrow("changed")
})
