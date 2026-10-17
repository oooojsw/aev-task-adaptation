import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { consolidationPlugins, preflightConsolidation } from "../../protocol-plugins/consolidation"
import { budgetedProviderFetch } from "../budget-transport"
import { inspectBudget } from "../request-budget"
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

test("T08: modifying validator script after execution causes evaluation dependency drift rejection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aev-drift-test-"))
  const validator = path.join(dir, "validator.mjs")
  await writeFile(validator, [
    'import { readFileSync } from "node:fs"',
    'console.log(JSON.stringify({ passed: true }))',
  ].join("\n"))
  const rows = ["q1"].map((caseID) => ({
    schema: "direct-chat-case/v1", caseID, dataset: "test", split: "train",
    question: { text: "Question?", outputInstruction: "One number" },
    materials: [{ id: "m", title: "M", type: "text", content: "Content" }],
    materialAudit: { caseID, expectedSources: [], includedMaterials: ["m"], omittedSources: [], warnings: [], tokenEstimate: 2, compressionPolicy: "none" },
    privateOracle: { validatorID: "v", runner: "bun", scriptPath: validator, args: ["--candidate", ""], candidateArgName: "--candidate" },
  }))
  const data = path.join(dir, "cases.jsonl")
  const models = path.join(dir, "models.json")
  await writeFile(data, rows.map(r => JSON.stringify(r)).join("\n") + "\n")
  await writeFile(models, JSON.stringify({ models: { m: { transport: "mock", mockResponse: "<answer>42</answer>", contextWindowTokens: 4096, maxOutputTokens: 64 } } }))

  const settings = {
    candidateID: "merged_skill", maxChars: 5000, expectedCases: 1, modelID: "m",
    datasetPath: data, datasetSHA256: digest(await readFile(data)),
    modelsPath: models, modelsSHA256: digest(await readFile(models)), concurrency: 1,
  }
  const gate = { candidateID: settings.candidateID, maxChars: 5000, expectedCases: 1, modelID: "m", datasetSHA256: settings.datasetSHA256 }
  const publication = Buffer.from("Skill content")
  const skill = [{ id: "merged_skill", kind: "text", bytes: publication, sha256: digest(publication), length: publication.length }]

  const plugin = await consolidationPlugins(path.join(dir, "plugin"))
  const res = await plugin.execute({ task: "merge", phase: "source", settings, skill, materials: [] })
  expect(res.status).toBe("completed")

  // Tamper with the validator script on disk
  await writeFile(validator, [
    'console.log(JSON.stringify({ passed: false }))',
  ].join("\n"))

  // Evaluating the product now must detect that the validator dependency drifted!
  const post = await plugin.evaluate({
    task: "merge", phase: "source", settings: gate,
    skill, materials: [], privateInputs: [],
    candidate: [{ id: "execution-product", kind: "json", bytes: res.product!.bytes,
      sha256: digest(res.product!.bytes), length: res.product!.bytes.length }],
    check: { name: "consolidation_score", target: "product", stage: "after_execution", mechanism: "script" },
  })
  expect(post.status).toBe("scoring_error")
  expect(post.message).toContain("dependency drift")
})

test("T10: validator passed=true with non-zero exitCode is rejected as untrustworthy", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aev-exitcode-test-"))
  const validator = path.join(dir, "validator.mjs")
  await writeFile(validator, [
    'console.log(JSON.stringify({ passed: true }))',
    'process.exit(1)',
  ].join("\n"))
  const rows = ["q1"].map((caseID) => ({
    schema: "direct-chat-case/v1", caseID, dataset: "test", split: "train",
    question: { text: "Question?", outputInstruction: "One number" },
    materials: [{ id: "m", title: "M", type: "text", content: "Content" }],
    materialAudit: { caseID, expectedSources: [], includedMaterials: ["m"], omittedSources: [], warnings: [], tokenEstimate: 2, compressionPolicy: "none" },
    privateOracle: { validatorID: "v", runner: "bun", scriptPath: validator, args: ["--candidate", ""], candidateArgName: "--candidate" },
  }))
  const data = path.join(dir, "cases.jsonl")
  const models = path.join(dir, "models.json")
  await writeFile(data, rows.map(r => JSON.stringify(r)).join("\n") + "\n")
  await writeFile(models, JSON.stringify({ models: { m: { transport: "mock", mockResponse: "<answer>42</answer>", contextWindowTokens: 4096, maxOutputTokens: 64 } } }))

  const settings = {
    candidateID: "merged_skill", maxChars: 5000, expectedCases: 1, modelID: "m",
    datasetPath: data, datasetSHA256: digest(await readFile(data)),
    modelsPath: models, modelsSHA256: digest(await readFile(models)), concurrency: 1,
  }
  const publication = Buffer.from("Skill content")
  const skill = [{ id: "merged_skill", kind: "text", bytes: publication, sha256: digest(publication), length: publication.length }]

  const plugin = await consolidationPlugins(path.join(dir, "plugin"))
  await expect(plugin.execute({ task: "merge", phase: "source", settings, skill, materials: [] }))
    .rejects.toThrow("Direct Chat validator lacks a trustworthy structured verdict")
})

test("T06/T07: stableRequestID prevents duplicate dispatch in same budget and ensures idempotence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aev-idempotence-"))
  let dispatches = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      dispatches++
      return Response.json({
        model: "mock-llm",
        choices: [{ message: { content: "answer" } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })
    },
  })

  try {
    const budgetConfig = {
      schema: "aev.budget-transport.v1" as const,
      budget: { root: path.join(dir, "ledger"), scope: "idempotent-scope", calls: 10, tokens: 50000 },
      role: "independent",
      dialect: "openai_chat" as const,
      expectedModels: ["mock-llm"],
      maxInputTokens: 4096,
      maxOutputTokens: 128,
    }

    const body = JSON.stringify({
      model: "mock-llm",
      messages: [{ role: "user", content: "test" }],
      max_tokens: 128,
    })

    const stableID = "campaign1__round1__case1__m1__attempt1"

    // First call with stableID succeeds
    const resp1 = await budgetedProviderFetch(
      server.url.toString(),
      { method: "POST", headers: { "content-type": "application/json" }, body },
      budgetConfig,
      4096,
      fetch,
      stableID,
    )
    expect(resp1.ok).toBe(true)
    expect(dispatches).toBe(1)

    // Second call with same stableID in same budget MUST fail closed with prior reservation
    await expect(budgetedProviderFetch(
      server.url.toString(),
      { method: "POST", headers: { "content-type": "application/json" }, body },
      budgetConfig,
      4096,
      fetch,
      stableID,
    )).rejects.toThrow("Prior request reservation exists; inspect before retry")

    // Real HTTP dispatches remains 1 (zero duplicate dispatch)
    expect(dispatches).toBe(1)
  } finally {
    await server.stop(true)
  }
})

test("T04: unbudgeted non-mock model or insufficient token ceiling aborts before dispatch with 0 HTTP POSTs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aev-t04-test-"))
  let dispatches = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      dispatches++
      return Response.json({
        model: "llm",
        choices: [{ message: { content: "ans" } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })
    },
  })

  try {
    const validator = path.join(dir, "validator.mjs")
    await writeFile(validator, 'console.log(JSON.stringify({ passed: true }))\n')
    const rows = ["q1"].map((caseID) => ({
      schema: "direct-chat-case/v1", caseID, dataset: "test", split: "train",
      question: { text: "Q", outputInstruction: "number" },
      materials: [{ id: "m", title: "M", type: "text", content: "Content" }],
      materialAudit: { caseID, expectedSources: [], includedMaterials: ["m"], omittedSources: [], warnings: [], tokenEstimate: 2, compressionPolicy: "none" },
      privateOracle: { validatorID: "v", runner: "bun", scriptPath: validator, args: ["--candidate", ""], candidateArgName: "--candidate" },
    }))
    const data = path.join(dir, "cases.jsonl")
    const models = path.join(dir, "models.json")
    await writeFile(data, rows.map(r => JSON.stringify(r)).join("\n") + "\n")
    await writeFile(models, JSON.stringify({
      models: {
        m: {
          transport: "openai-compatible",
          baseURL: server.url.toString(),
          model: "llm",
          apiKey: "sk-fake",
          contextWindowTokens: 4096,
          maxOutputTokens: 64,
        },
      },
    }))

    const settings = {
      candidateID: "merged_skill", maxChars: 5000, expectedCases: 1, modelID: "m",
      datasetPath: data, datasetSHA256: digest(await readFile(data)),
      modelsPath: models, modelsSHA256: digest(await readFile(models)), concurrency: 1,
    }
    const pub = Buffer.from("Skill content")
    const skill = [{ id: "merged_skill", kind: "text", bytes: pub, sha256: digest(pub), length: pub.length }]

    // 1. Without budget: fails closed before any HTTP dispatch
    const pluginWithoutBudget = await consolidationPlugins(path.join(dir, "plugin-nobudget"))
    await expect(pluginWithoutBudget.execute({ task: "merge", phase: "source", settings, skill, materials: [] }))
      .rejects.toThrow()
    expect(dispatches).toBe(0)

    // 2. Insufficient tokens in budget: fails before HTTP dispatch
    const budgetConfig = {
      schema: "aev.budget-transport.v1" as const,
      budget: { root: path.join(dir, "ledger-small"), scope: "scope-small", calls: 10, tokens: 50 },
      role: "independent",
      dialect: "openai_chat" as const,
      expectedModels: ["llm"],
      maxInputTokens: 4096,
      maxOutputTokens: 64,
    }
    const body = JSON.stringify({ model: "llm", messages: [{ role: "user", content: "hi" }], max_tokens: 64 })
    await expect(budgetedProviderFetch(
      server.url.toString(),
      { method: "POST", headers: { "content-type": "application/json" }, body },
      budgetConfig,
      4096,
      fetch,
      "t04-test-req",
    )).rejects.toThrow("Request budget exhausted")
    expect(dispatches).toBe(0)
  } finally {
    await server.stop(true)
  }
})

test("T06: failed request marks attempt as unknown and blocks further requests without refund", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aev-t06-test-"))
  let dispatches = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      dispatches++
      // Simulate broken 500 response without valid usage or body
      return new Response(null, { status: 500, statusText: "Internal Error" })
    },
  })

  try {
    const budgetConfig = {
      schema: "aev.budget-transport.v1" as const,
      budget: { root: path.join(dir, "ledger"), scope: "t06-scope", calls: 5, tokens: 10000 },
      role: "independent",
      dialect: "openai_chat" as const,
      expectedModels: ["mock-llm"],
      maxInputTokens: 4096,
      maxOutputTokens: 128,
    }

    const body = JSON.stringify({
      model: "mock-llm",
      messages: [{ role: "user", content: "test" }],
      max_tokens: 128,
    })

    const stableID = "req-fail-1"

    // Call fails because 500 with empty body triggers settleRequest with undefined usage
    const resp = await budgetedProviderFetch(
      server.url.toString(),
      { method: "POST", headers: { "content-type": "application/json" }, body },
      budgetConfig,
      4096,
      fetch,
      stableID,
    )
    expect(resp.status).toBe(500)
    await resp.text()
    expect(dispatches).toBe(1)

    // Inspect budget: attempt status must be 'unknown', reservation retained (not refunded)
    const inspection = await inspectBudget(budgetConfig.budget)
    expect(inspection.unknownAttempts).toBe(1)
    expect(inspection.outstandingTokens).toBe(4096 + 128)

    // Subsequent request on same budget is strictly blocked due to unresolved status
    await expect(budgetedProviderFetch(
      server.url.toString(),
      { method: "POST", headers: { "content-type": "application/json" }, body },
      budgetConfig,
      4096,
      fetch,
      "req-after-fail",
    )).rejects.toThrow("Request budget needs unresolved usage inspection")

    // Real HTTP dispatches stays at 1 (no extra dispatch)
    expect(dispatches).toBe(1)
  } finally {
    await server.stop(true)
  }
})

test("T08b: modifying external material asset after execution causes evaluation dependency drift rejection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aev-asset-drift-"))
  const validator = path.join(dir, "validator.mjs")
  await writeFile(validator, 'console.log(JSON.stringify({ passed: true }))\n')

  const assetFile = path.join(dir, "document-asset.txt")
  await writeFile(assetFile, "Initial reference text content\n")

  const rows = ["q1"].map((caseID) => ({
    schema: "direct-chat-case/v1", caseID, dataset: "test", split: "train",
    question: { text: "Question with external asset?", outputInstruction: "One number" },
    materials: [{
      id: "asset_mat",
      title: "External Asset",
      type: "text",
      content: "External Asset Content",
      sourcePathInternal: assetFile,
    }],
    materialAudit: { caseID, expectedSources: [], includedMaterials: ["asset_mat"], omittedSources: [], warnings: [], tokenEstimate: 4, compressionPolicy: "none" },
    privateOracle: { validatorID: "v", runner: "bun", scriptPath: validator, args: ["--candidate", ""], candidateArgName: "--candidate" },
  }))
  const data = path.join(dir, "cases.jsonl")
  const models = path.join(dir, "models.json")
  await writeFile(data, rows.map(r => JSON.stringify(r)).join("\n") + "\n")
  await writeFile(models, JSON.stringify({ models: { m: { transport: "mock", mockResponse: "<answer>42</answer>", contextWindowTokens: 4096, maxOutputTokens: 64 } } }))

  const settings = {
    candidateID: "merged_skill", maxChars: 5000, expectedCases: 1, modelID: "m",
    datasetPath: data, datasetSHA256: digest(await readFile(data)),
    modelsPath: models, modelsSHA256: digest(await readFile(models)), concurrency: 1,
  }
  const gate = { candidateID: settings.candidateID, maxChars: 5000, expectedCases: 1, modelID: "m", datasetSHA256: settings.datasetSHA256 }
  const publication = Buffer.from("Skill content")
  const skill = [{ id: "merged_skill", kind: "text", bytes: publication, sha256: digest(publication), length: publication.length }]

  const plugin = await consolidationPlugins(path.join(dir, "plugin"))
  const res = await plugin.execute({ task: "merge", phase: "source", settings, skill, materials: [] })
  expect(res.status).toBe("completed")

  // Tamper with the external asset file
  await writeFile(assetFile, "Modified reference text content that drifted!\n")

  // Evaluating must fail with dependency drift
  const post = await plugin.evaluate({
    task: "merge", phase: "source", settings: gate,
    skill, materials: [], privateInputs: [],
    candidate: [{ id: "execution-product", kind: "json", bytes: res.product!.bytes,
      sha256: digest(res.product!.bytes), length: res.product!.bytes.length }],
    check: { name: "consolidation_score", target: "product", stage: "after_execution", mechanism: "script" },
  })
  expect(post.status).toBe("scoring_error")
  expect(post.message).toContain("dependency drift")
})
