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

test("G2: atomic pre-dispatch request budget limits concurrent HTTP dispatches and fails closed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aev-consolidation-budget-"))
  const validator = path.join(dir, "validator.mjs")
  await writeFile(validator, [
    'console.log(JSON.stringify({ passed: true }))',
  ].join("\n"))

  let httpDispatches = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      httpDispatches++
      return Response.json({
        model: "mock-llm",
        choices: [{ message: { content: "answer is 42" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    },
  })

  try {
    const cases = Array.from({ length: 5 }, (_, i) => `case_${i + 1}`)
    const rows = cases.map(caseID => ({
      schema: "direct-chat-case/v1", caseID, dataset: "budget-test", split: "train",
      question: { text: `Question for ${caseID}`, outputInstruction: "number" },
      materials: [{ id: "m1", title: "mat", type: "text", content: "data" }],
      materialAudit: { caseID, expectedSources: [], includedMaterials: ["m1"], omittedSources: [], warnings: [], tokenEstimate: 2, compressionPolicy: "none" },
      privateOracle: { validatorID: "v", runner: "bun", scriptPath: validator,
        args: ["--candidate", ""], candidateArgName: "--candidate" },
    }))
    const data = path.join(dir, "cases.jsonl")
    const models = path.join(dir, "models.json")
    await writeFile(data, rows.map(r => JSON.stringify(r)).join("\n") + "\n")
    await writeFile(models, JSON.stringify({
      models: {
        "http-model": {
          transport: "openai-compatible",
          baseURL: server.url.toString(),
          model: "mock-llm",
          apiKey: "sk-mock-key",
          contextWindowTokens: 4096,
          maxOutputTokens: 128,
        },
      },
    }))

    const settings = {
      candidateID: "merged_skill", maxChars: 5000, expectedCases: 5, modelID: "http-model",
      datasetPath: data, datasetSHA256: digest(await readFile(data)),
      modelsPath: models, modelsSHA256: digest(await readFile(models)), concurrency: 5,
    }
    const publication = Buffer.from("Skill rules")
    const skill = [{ id: "merged_skill", kind: "text", bytes: publication,
      sha256: digest(publication), length: publication.length }]

    // 1. Without budget configured: non-mock model must fail closed
    const unbudgetedPlugin = await consolidationPlugins(path.join(dir, "unbudgeted"))
    await expect(unbudgetedPlugin.execute({ task: "merge", phase: "source", settings, skill, materials: [] }))
      .rejects.toThrow()
    expect(httpDispatches).toBe(0)

    // 2. With budget configured: calls=3, tokens=100000 across 5 concurrent cases
    const budgetRoot = path.join(dir, "budget-ledger")
    const budgetConfig = {
      root: budgetRoot,
      scope: "consolidation-test",
      calls: 3,
      tokens: 100000,
    }
    const budgetedPlugin = await consolidationPlugins(path.join(dir, "budgeted"), {
      budget: { config: budgetConfig, tokenCeiling: 4096, role: "independent" },
    })

    // Execute with 5 cases concurrently; calls limit is 3
    // Must fail closed because cases 4 and 5 were blocked before dispatch
    await expect(budgetedPlugin.execute({ task: "merge", phase: "source", settings, skill, materials: [] }))
      .rejects.toThrow()

    // Key assertion: server must have received AT MOST 3 HTTP dispatches!
    expect(httpDispatches).toBe(3)
  } finally {
    await server.stop(true)
  }
})

test("T03: dual campaigns concurrent in same process with distinct budgets have zero crosstalk", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aev-consolidation-dual-"))
  const validator = path.join(dir, "validator.mjs")
  await writeFile(validator, 'console.log(JSON.stringify({ passed: true }))\n')

  let dispatchesA = 0
  let dispatchesB = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async req => {
      const body = await req.json()
      if (body.model === "model-a") dispatchesA++
      else dispatchesB++
      return Response.json({
        model: body.model,
        choices: [{ message: { content: "ans" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    },
  })

  try {
    const makeData = async (prefix: string, modelName: string) => {
      const rows = ["q1", "q2"].map(caseID => ({
        schema: "direct-chat-case/v1", caseID: `${prefix}_${caseID}`, dataset: "test", split: "train",
        question: { text: "Q", outputInstruction: "num" },
        materials: [{ id: "m", title: "m", type: "text", content: "data" }],
        materialAudit: { caseID: `${prefix}_${caseID}`, expectedSources: [], includedMaterials: ["m"], omittedSources: [], warnings: [], tokenEstimate: 2, compressionPolicy: "none" },
        privateOracle: { validatorID: "v", runner: "bun", scriptPath: validator, args: ["--candidate", ""], candidateArgName: "--candidate" },
      }))
      const dataFile = path.join(dir, `${prefix}_cases.jsonl`)
      const modelsFile = path.join(dir, `${prefix}_models.json`)
      await writeFile(dataFile, rows.map(r => JSON.stringify(r)).join("\n") + "\n")
      await writeFile(modelsFile, JSON.stringify({
        models: {
          [modelName]: {
            transport: "openai-compatible",
            baseURL: server.url.toString(),
            model: modelName,
            apiKey: "sk-key",
            contextWindowTokens: 4096,
            maxOutputTokens: 128,
          },
        },
      }))
      return { dataFile, modelsFile }
    }

    const setA = await makeData("a", "model-a")
    const setB = await makeData("b", "model-b")

    const budgetA = { root: path.join(dir, "ledger-a"), scope: "scope-a", calls: 2, tokens: 50000 }
    const budgetB = { root: path.join(dir, "ledger-b"), scope: "scope-b", calls: 2, tokens: 50000 }

    const pluginA = await consolidationPlugins(path.join(dir, "plugin-a"), {
      budget: { config: budgetA, tokenCeiling: 4096, role: "independent" },
    })
    const pluginB = await consolidationPlugins(path.join(dir, "plugin-b"), {
      budget: { config: budgetB, tokenCeiling: 4096, role: "independent" },
    })

    const pub = Buffer.from("Skill")
    const skill = [{ id: "merged_skill", kind: "text", bytes: pub, sha256: digest(pub), length: pub.length }]

    const settingsA = {
      candidateID: "merged_skill", maxChars: 5000, expectedCases: 2, modelID: "model-a",
      datasetPath: setA.dataFile, datasetSHA256: digest(await readFile(setA.dataFile)),
      modelsPath: setA.modelsFile, modelsSHA256: digest(await readFile(setA.modelsFile)), concurrency: 2,
    }
    const settingsB = {
      candidateID: "merged_skill", maxChars: 5000, expectedCases: 2, modelID: "model-b",
      datasetPath: setB.dataFile, datasetSHA256: digest(await readFile(setB.dataFile)),
      modelsPath: setB.modelsFile, modelsSHA256: digest(await readFile(setB.modelsFile)), concurrency: 2,
    }

    // Run both campaigns concurrently in the same process
    const [resA, resB] = await Promise.all([
      pluginA.execute({ task: "merge", phase: "source", settings: settingsA, skill, materials: [] }),
      pluginB.execute({ task: "merge", phase: "source", settings: settingsB, skill, materials: [] }),
    ])

    expect(resA.status).toBe("completed")
    expect(resB.status).toBe("completed")
    expect(dispatchesA).toBe(2)
    expect(dispatchesB).toBe(2)

    // Verify neither process.env nor cross-campaign ledgers leaked
    expect(process.env.OPENCODE_AEV_REQUEST_BUDGET_FILE).toBeUndefined()
  } finally {
    await server.stop(true)
  }
})
