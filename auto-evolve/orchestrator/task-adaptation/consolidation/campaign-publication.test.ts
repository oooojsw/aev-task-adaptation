import { expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises"
import { Runtime } from "../../protocol-plugins/runtime"
import { consolidationPlugins } from "../../protocol-plugins/consolidation"
import { campaignAcceptance } from "../../protocol-plugins/campaign-acceptance"
import { digest } from "./contract"
import { verifyPublication } from "./publication-evidence"
import { bindPlan } from "../binding"
import { taskFeedback } from "../feedback"
import { authorizeInvocation } from "../invocation"
import { fingerprint } from "../../protocol-plugins/identity"
import { DEFAULT_CONFIG } from "../../schema"
import type { Plan } from "../plan"

test("formal Campaign publishes exact 50-case mock executions at 0, 43 and 50 passes", async () => {
  for (const count of [0, 43, 50]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "aev-formal-publication-"))
    const campaign = path.join(root, "campaign")
    const candidate = path.join(root, "candidate")
    await mkdir(candidate)
    await writeFile(path.join(candidate, "DIRECT_CHAT.md"), "Read public materials and return the requested answer.")
    await writeFile(path.join(root, "public.txt"), "Public input")
    const validator = path.join(root, "validator.mjs")
    await writeFile(validator, 'console.log(JSON.stringify({passed: process.argv.includes("pass")}))')
    const cases = Array.from({ length: 50 }, (_, index) => ({ schema: "direct-chat-case/v1", caseID: `case_${index}`,
      dataset: "synthetic", split: "train", question: { text: `Question ${index}`, outputInstruction: "Return one number" },
      materials: [{ id: "m", title: "Public material", type: "text", content: `Public ${index}` }],
      materialAudit: { caseID: `case_${index}`, expectedSources: [], includedMaterials: ["m"], omittedSources: [], warnings: [], tokenEstimate: 4, compressionPolicy: "none" },
      privateOracle: { validatorID: "v", runner: "bun", scriptPath: validator,
        args: ["--candidate", "", index < count ? "pass" : "fail"], candidateArgName: "--candidate" } }))
    const dataset = path.join(root, "cases.jsonl")
    const models = path.join(root, "models.json")
    await writeFile(dataset, cases.map(item => JSON.stringify(item)).join("\n") + "\n")
    await writeFile(models, JSON.stringify({ models: { m: { transport: "mock", mockResponse: "<answer>42</answer>", contextWindowTokens: 32768, maxOutputTokens: 128 } } }))
    const common = { candidateID: "merged", maxChars: 5000, expectedCases: 50, modelID: "m", datasetSHA256: digest(await readFile(dataset)) }
    const settings = { ...common, datasetPath: dataset, modelsPath: models, modelsSHA256: digest(await readFile(models)), concurrency: 2 }
    const plugin = await consolidationPlugins(path.join(campaign, "protocol-backends", "consolidation"))
    let executions = 0
    const runtime = new Runtime().addChecker(plugin.checker, plugin.evaluate).addExecutor(plugin.executor, (...args) => {
      executions++
      return plugin.execute(...args)
    })
    const project = { id: "consolidation-test", version: "1", skillFormats: ["text"], productKinds: ["json"], materialKinds: ["text"] }
    const selection = { schema: "aev.protocol-plugins.v1", project, run: { skillFormat: "text", productKind: "json", materialKinds: ["text"] },
      protocol: { id: "consolidation", version: "1", phases: { source: { claim: "task_execution",
        executor: { id: plugin.executor.id, version: "1", settings }, checks: [
          { id: plugin.checker.id, version: "1", settings: common, name: "surface", target: "skill", stage: "before_execution", required: true, mechanism: "script" },
          { id: plugin.checker.id, version: "1", settings: common, name: "score", target: "product", stage: "after_execution", required: true, mechanism: "script" },
        ] } } } }
    const selectionPath = path.join(root, "selection.json")
    const projectManifestPath = path.join(root, "project.json")
    await writeFile(selectionPath, JSON.stringify(selection))
    await writeFile(projectManifestPath, JSON.stringify({ schema: "aev.project-pack.v1", project,
      skill: { format: "text", entries: [{ id: "merged", kind: "text", path: "DIRECT_CHAT.md" }] },
      tasks: [{ id: "task", split: "train", materials: [{ id: "q", kind: "text", path: "public.txt" }], privateInputs: [] }] }))
    const attempt = path.join(campaign, "rounds", "round-001", "final-acceptance")
    const plan: Plan = { schema: "aev.task-plan.v1", id: "consolidation", objective: "Learn reusable guidance",
      deliverable: { kind: "skill", entries: ["merged"] }, capabilities: ["read"],
      resources: [{ id: "merged", path: "DIRECT_CHAT.md", audience: "public", mutable: true }],
      windows: [
        { role: "lead", stage: "revise", reads: ["merged"], writes: ["merged"], inline: [], actions: ["read", "edit"], runtime: ["feedback"] },
        { role: "worker", stage: "explore", reads: ["merged"], writes: [], inline: [], actions: ["read"], runtime: ["feedback"] },
        { role: "checker", stage: "accept", reads: ["merged"], writes: [], inline: [], actions: ["read"] },
      ], workers: [{ id: "worker1", purpose: "Analyze failures", resources: ["merged"], actions: ["read"] }],
      acceptance: { execution: "script", checks: [
        { id: "surface", target: "candidate", mechanism: "script", purpose: "Check guidance", required: true, resources: ["merged"], feedback: "status_only" },
        { id: "score", target: "product", mechanism: "script", purpose: "Check results", required: true, resources: ["merged"], feedback: "status_only" },
      ] }, rejection: [{ check: "surface", actions: ["repair"] }, { check: "score", actions: ["repair"] }],
      selection: { rule: "first_pass" }, stop: { rounds: 2, calls: 100, tokens: 10000, stagnant: 2 } }
    const bound = await bindPlan(candidate, plan, ["read"])
    const policyFingerprint = fingerprint({ windows: plan.windows, workers: plan.workers })
    const options = { campaignRoot: campaign, cwd: root, campaignID: "campaign", roundNumber: 1,
      runID: "author-run", entry: { schema: "aev.protocol-entry.v1", selectionPath, projectManifestPath, taskID: "task", phase: "source" },
      candidateRoot: candidate, attemptRoot: attempt, resultPath: path.join(attempt, "result.json"),
      taskBinding: { planFingerprint: bound.fingerprint, policyFingerprint } } as const
    if (count === 43) {
      await expect(campaignAcceptance({ ...options, publicationCapacityBytes: 1 }, runtime)).rejects.toThrow("publication_error")
      expect(executions).toBe(1)
      await expect(readFile(path.join(attempt, "training-feedback", ".published"))).rejects.toThrow()
    }
    const result = await campaignAcceptance({ ...options, ...(count === 43 ? { recoverPublication: true } : {}) }, runtime)
    expect(executions).toBe(1)
    expect(result.passed).toBe(true)
    const feedback = JSON.parse(await readFile(path.join(attempt, "protocol.training-feedback.json"), "utf8"))
    const manifest = await verifyPublication(feedback.caseFeedback.manifestPath, feedback.caseFeedback.manifestSHA256)
    expect(manifest.passedCases).toBe(count)
    expect(manifest.totalCases).toBe(50)
    for (const index of [0, 24, 49]) {
      const row = JSON.parse(await readFile(path.join(attempt, "training-feedback", manifest.cases[index].path), "utf8"))
      expect(row.prompt).toContain(`Question ${index}`)
      expect(row.modelResponse).toBe("42")
      expect(row.passed).toBe(index < count)
      expect(JSON.stringify(row)).not.toContain("validator.mjs")
    }
    expect(result.blankAgentEvidenceReadPaths).not.toContain(feedback.caseFeedback.manifestPath)
    const reference = { root: campaign, path: result.protocolTrainingResultPath, task: "task", phase: "source" as const }
    expect((await taskFeedback(bound, reference)).feedbackResource?.resourceID).toBe(manifest.resourceID)
    const request = { cwd: root, config: DEFAULT_CONFIG, title: "Feedback test", prompt: "unused" }
    for (const role of ["lead", "worker"] as const) {
      const invocation = { bound, role, stage: role === "lead" ? "revise" as const : "explore" as const,
        ...(role === "worker" ? { worker: "worker1" } : {}), output: "Review guidance", maxInlineBytes: 100,
        campaignID: "campaign", round: 2, feedback: reference }
      const authorized = await authorizeInvocation(invocation, request)
      expect(authorized.request.resourceReaderGrant?.allowedCaseIDs).toHaveLength(50)
      expect(authorized.request.permissionReadPaths).toHaveLength(3)
      await expect(authorizeInvocation({ ...invocation, campaignID: "other" }, request)).rejects.toThrow()
      await expect(authorizeInvocation({ ...invocation, feedback: undefined, feedbackResource: (await taskFeedback(bound, reference)).feedbackResource }, request)).rejects.toThrow("Formal feedback reference required")
    }
    const backends = await readdir(path.join(campaign, "protocol-backends", "consolidation"))
    expect(backends).toHaveLength(1)
  }
}, 60000)
