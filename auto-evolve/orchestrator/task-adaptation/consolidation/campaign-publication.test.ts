import { expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, lstat } from "node:fs/promises"
import { selectedRuntime } from "../../protocol-plugins/selected-runtime"
import { consolidationPlugins } from "../../protocol-plugins/consolidation"
import { campaignAcceptance, verifyCompletedCampaignAcceptance } from "../../protocol-plugins/campaign-acceptance"
import { digest } from "./contract"
import { verifyPublication } from "./publication-evidence"
import { bindPlan } from "../binding"
import { taskFeedback } from "../feedback"
import { authorizeInvocation } from "../invocation"
import { fingerprint } from "../../protocol-plugins/identity"
import { DEFAULT_CONFIG } from "../../schema"
import type { Plan } from "../plan"
import { taskInvocation } from "../context"
import { loadLongTaskSpec } from "../../long-task/spec"
import { recordTaskVersion, readTaskVersions, recoverTaskVersions, selectTaskVersion } from "../selection"
import { finalizeTaskRound } from "../../long-task-campaign/round-control"
import { archiveRound } from "../exploration/evaluation"
import { explorationIdentity, type ExplorationPolicy } from "../exploration/policy"
import type { LongTaskCampaignRoundRecord } from "../../long-task-campaign/contract"
import { taskRuntimeBudgets, type TaskBudgetPolicy } from "../budget-policy"

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
    const attempt = path.join(campaign, "rounds", "round-001", "final-acceptance", "pass-01")
    const plan: Plan = { schema: "aev.task-plan.v1", id: "consolidation", objective: "Learn reusable guidance",
      deliverable: { kind: "skill", entries: ["merged"] }, capabilities: ["read"],
      resources: [{ id: "merged", path: "DIRECT_CHAT.md", audience: "public", mutable: true }],
      windows: [
        { role: "lead", stage: "revise", reads: ["merged"], writes: ["merged"], inline: [], actions: ["read", "edit"], runtime: ["feedback"] },
        { role: "worker", stage: "explore", reads: ["merged"], writes: [], inline: [], actions: ["read"], runtime: ["feedback"] },
        { role: "planner", stage: "explore", reads: ["merged"], writes: [], inline: [], actions: ["read"], runtime: ["feedback"] },
        { role: "executor", stage: "explore", reads: ["merged"], writes: ["merged"], inline: [], actions: ["read", "edit"], runtime: ["feedback"] },
        { role: "reviewer", stage: "accept", reads: ["merged"], writes: [], inline: [], actions: ["read"], runtime: ["feedback"] },
        { role: "diagnostician", stage: "revise", reads: ["merged"], writes: [], inline: [], actions: ["read"], runtime: ["feedback"] },
        { role: "checker", stage: "accept", reads: ["merged"], writes: [], inline: [], actions: ["read"] },
      ], workers: [{ id: "worker1", purpose: "Analyze failures", resources: ["merged"], actions: ["read"] }],
      acceptance: { execution: "script", checks: [
        { id: "surface", target: "candidate", mechanism: "script", purpose: "Check guidance", required: true, resources: ["merged"], feedback: "status_only" },
        { id: "score", target: "product", mechanism: "script", purpose: "Check results", required: true, resources: ["merged"], feedback: "status_only" },
      ] }, rejection: [{ check: "surface", actions: ["repair"] }, { check: "score", actions: ["repair"] }],
      selection: count === 43 ? { rule: "best_pass", metric: "pass_rate", direction: "max" } : { rule: "first_pass" },
      stop: { rounds: 2, calls: 100, tokens: 10000, stagnant: 2 } }
    const bound = await bindPlan(candidate, plan, ["read"])
    const requestBudget: TaskBudgetPolicy = { schema: "aev.task-budget-policy.v1", root: path.join(root, "budget"),
      scope: "same-task", models: [{ model: "m", dialect: "openai_chat", expectedModels: ["m"],
        maxInputTokens: 100, maxOutputTokens: 100 }] }
    const policyFingerprint = fingerprint({ windows: plan.windows, workers: plan.workers })
    const options = { campaignRoot: campaign, cwd: root, campaignID: "campaign", roundNumber: 1,
      runID: "author-run", entry: { schema: "aev.protocol-entry.v1", selectionPath, projectManifestPath, taskID: "task", phase: "source" },
      candidateRoot: candidate, attemptRoot: attempt, resultPath: path.join(attempt, "result.json"),
      taskBinding: { planFingerprint: bound.fingerprint, policyFingerprint } } as const
    const runtime = await selectedRuntime(path.join(campaign, "protocol-backends"), root, options.entry,
      undefined, taskRuntimeBudgets(requestBudget, plan.stop))
    const run = runtime.run.bind(runtime)
    runtime.run = (...args) => { executions++; return run(...args) }
    if (count === 43) {
      await expect(campaignAcceptance({ ...options, publicationCapacityBytes: 1 }, runtime)).rejects.toThrow("publication_error")
      expect(executions).toBe(1)
      await expect(readFile(path.join(attempt, "training-feedback", ".published"))).rejects.toThrow()
    }
    const result = await campaignAcceptance({ ...options, ...(count === 43 ? { recoverPublication: true } : {}) }, runtime)
    await verifyCompletedCampaignAcceptance({ ...options, budgets: taskRuntimeBudgets(requestBudget, plan.stop),
      candidateRoot: candidate.replaceAll("\\", "/"), resultPath: options.resultPath.replaceAll("\\", "/") })
    await expect(verifyCompletedCampaignAcceptance({ ...options, candidateRoot: path.join(candidate, "other") })).rejects.toThrow("identity drift")
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
        campaignID: "campaign", round: 2, passID: "pass-02", feedback: reference }
      const authorized = await authorizeInvocation(invocation, request)
      expect(authorized.request.resourceReaderGrant?.allowedCaseIDs).toHaveLength(50)
      expect(authorized.request.resourceReaderGrant?.passID).toBe("pass-02")
      expect(authorized.request.permissionReadPaths).toHaveLength(3)
      await expect(authorizeInvocation({ ...invocation, campaignID: "other" }, request)).rejects.toThrow()
      await expect(authorizeInvocation({ ...invocation, feedback: undefined, feedbackResource: (await taskFeedback(bound, reference)).feedbackResource }, request)).rejects.toThrow("Formal feedback reference required")
    }
    // 经真实spec加载的第二轮摘要不能被逐题Reader角色门禁误拦。
    const specPath = path.join(root, "round-spec.json")
    await writeFile(path.join(root, "plan.json"), JSON.stringify(plan))
    await writeFile(specPath, JSON.stringify({ title: "Round two", goal: "Consolidate reusable guidance", validators: [],
      protocolPlugins: options.entry,
      taskAdaptation: { schema: "aev.task-adaptation.v1", planPath: path.join(root, "plan.json"), root: candidate,
        capabilities: ["read"], entries: [{ id: "merged", path: "DIRECT_CHAT.md" }] },
      taskAdaptationCampaignRoot: campaign, taskAdaptationRound: 2, taskAdaptationFeedbackPath: reference.path }))
    const spec = (await loadLongTaskSpec(specPath)).spec
    spec.taskAdaptationContext = bound
    if (count === 43) {
      spec.taskAdaptation!.requestBudget = requestBudget
      const policy: ExplorationPolicy = { schema: "aev.exploration-policy.v1", origin: { kind: "initial" },
        replace: ["merged"], preserve: [], dependencies: [], trigger: { kind: "metric", name: "pass_rate",
          direction: "max", minimumDelta: 0, patience: 1, minimumObservations: 1 },
        allowance: { rounds: 1, minimumRounds: 1, authorCalls: 1, authorTokens: 100,
          acceptanceCalls: 1, acceptanceTokens: 100, deliveryCalls: 0, deliveryTokens: 0 },
        bounds: { archiveBytes: 1000000, candidateBytes: 10000, dependencyBytes: 10000 },
        safety: { reset: "declared_entries", effects: "sandbox_only" } }
      const round: LongTaskCampaignRoundRecord = { roundNumber: 1, roundID: "round-001", roundSpecPath: specPath,
        sourceRunID: options.runID, sourceRunDir: root, finalStatus: "verified_success", summary: "Local fixture",
        failurePacketCount: 0, retryLessonCount: 0, learningUnitCount: 0, roundSummaryPath: path.join(root, "summary.md"),
        snapshotPaths: [], createdAt: "2026-10-19T00:00:00.000Z", roundClosure: "closed_success",
        finalAcceptanceSignal: { executed: true, passed: true, failedValidatorIDs: [], feedbackPath: reference.path } }
      const input = { cwd: root, root: campaign, archive: path.join(campaign, "exploration/archive"),
        candidateRoot: candidate, scope: { campaign: "campaign", plan: bound.fingerprint,
          protocol: (await taskFeedback(bound, reference)).view.protocolFingerprint,
          policy: explorationIdentity(policy, bound.plan)!, budget: { root: path.join(root, "budget"), scope: "same-task" } },
        policy, round, pass: 1, branch: "original" as const, parent: null }
      const observed = await archiveRound(spec, input)
      expect(observed.observation.metric).toBe(0.86)
      expect(observed.observation.verdict).toBe("passed")
      expect(await archiveRound(spec, input)).toEqual(observed)
      for (const entries of [[], [spec.taskAdaptation!.entries[0], spec.taskAdaptation!.entries[0]],
        [{ id: "merged", path: "alias.md" }]]) {
        await expect(archiveRound({ ...spec, taskAdaptation: { ...spec.taskAdaptation!, entries } }, input)).rejects.toThrow("entry mapping drift")
      }
      await expect(archiveRound(spec, { ...input, pass: 2 })).rejects.toThrow("pass identity")
      await expect(archiveRound(spec, { ...input, scope: { ...input.scope, protocol: "0".repeat(64) } })).rejects.toThrow("content verdict")
      await expect(archiveRound(spec, { ...input, round: { ...round, roundClosure: "closed_infra_failure" } })).rejects.toThrow("normally closed")
      await expect(archiveRound(spec, { ...input, round: { ...round, sourceRunID: "other" } })).rejects.toThrow("identity drift")
      expect(executions).toBe(1)
      delete spec.taskAdaptation!.requestBudget
      const selected = await recordTaskVersion(spec, { root: campaign, candidateRoot: candidate,
        feedback: result.protocolTrainingResultPath, passed: true, round: 1, maxRounds: 2,
        snapshot: { recover: false, cap: 10000000 } })
      expect(selected?.selectedTaskVersionPath).toBeDefined()
      expect((await readTaskVersions(spec, campaign)).length).toBe(1)
      const finalized = await finalizeTaskRound(spec, { root: campaign, candidateRoot: candidate,
        acceptance: result, round: 1, maxRounds: 2, record: round })
      expect(finalized.taskSelection).toEqual(selected)
      expect(finalized.nextStatus).toBe("running")
      const published = path.join(attempt, "task.feedback.json")
      await rename(published, `${published}.readonly-held`)
      await expect(selectTaskVersion(spec, { root: campaign, round: 1, maxRounds: 2 })).rejects.toThrow("readonly verification")
      await expect(readFile(published)).rejects.toThrow()
      // 旧默认仍可发布缺失视图；严格只读路径不借此恢复文件。
      expect((await readTaskVersions(spec, campaign)).length).toBe(1)
      expect(await readFile(published)).toEqual(await readFile(`${published}.readonly-held`))
      expect(await selectTaskVersion(spec, { root: campaign, round: 1, maxRounds: 2 })).toEqual(selected)

      const alternate = path.join(root, "internal-finalizer")
      const frozen = await bindPlan(candidate, { ...plan, exploration: policy }, ["read"])
      const phase = path.join(alternate, "rounds/round-001/final-acceptance/pass-01")
      const local = await selectedRuntime(path.join(alternate, "protocol-backends"), root, options.entry)
      const accepted = await campaignAcceptance({ ...options, campaignRoot: alternate, campaignID: "internal-finalizer",
        attemptRoot: phase, resultPath: path.join(phase, "result.json"), taskBinding: {
          planFingerprint: frozen.fingerprint, policyFingerprint } }, local)
      const internal = { ...spec, taskAdaptationContext: frozen, taskAdaptationCampaignRoot: alternate }
      const close = { root: alternate, candidateRoot: candidate, acceptance: accepted, round: 1, maxRounds: 2, record: round }
      // 直接调用共同finalizer检验影子分支，不解除真实Host运行门禁。
      const created = await finalizeTaskRound(internal, close)
      const saved = created.taskSelection!.selectedTaskVersionPath!
      const stamp = await lstat(saved)
      expect((await readdir(path.join(alternate, "task-adaptation/version-intents"))).length).toBe(1)
      expect(await finalizeTaskRound(internal, close)).toEqual(created)
      expect((await lstat(saved)).mtimeMs).toBe(stamp.mtimeMs)
      await rename(saved, `${saved}.incomplete-held`)
      await expect(finalizeTaskRound(internal, close)).rejects.toThrow("explicit recovery")
      await expect(readFile(saved)).rejects.toThrow()
      await recoverTaskVersions(internal, { root: alternate, candidateRoot: candidate, cap: policy.bounds.archiveBytes })
      expect(await finalizeTaskRound(internal, close)).toEqual(created)
      const file = selected!.selectedTaskVersionPath!
      await expect(recoverTaskVersions({ ...spec, taskAdaptation: { ...spec.taskAdaptation!, entries: [] } },
        { root: campaign, candidateRoot: candidate, cap: 10000000 })).rejects.toThrow("entry mapping drift")
      await rename(file, `${file}.interrupted`)
      await expect(recordTaskVersion(spec, { root: campaign, candidateRoot: candidate,
        feedback: result.protocolTrainingResultPath, passed: true, round: 1, maxRounds: 2,
        snapshot: { recover: false, cap: 10000000 } })).rejects.toThrow("explicit recovery")
      await expect(readTaskVersions(spec, campaign)).rejects.toThrow()
      const original = await readFile(path.join(candidate, "DIRECT_CHAT.md"))
      const record = JSON.parse(await readFile(`${file}.interrupted`, "utf8"))
      const target = path.join(path.dirname(file), "files/0.bin")
      const stored = path.join(campaign, "task-adaptation")
      const staging = path.join(stored, "staging")
      await mkdir(staging, { recursive: true })
      const temp = path.join(staging, `.${fingerprint({ relative: path.relative(stored, target),
        hash: record.files[0].sha256 })}.bin.tmp-123-456-abcdef`)
      await writeFile(temp, original)
      await rename(target, path.join(root, "accepted-original-0.bin"))
      await writeFile(path.join(candidate, "DIRECT_CHAT.md"), "A later candidate must not replace the accepted snapshot.")
      expect((await recoverTaskVersions(spec, { root: campaign, candidateRoot: candidate, cap: 10000000 }))[0].path).toBe(file)
      expect(await readFile(target)).toEqual(original)
      await expect(readFile(temp)).rejects.toThrow()
      await rename(file, `${file}.capacity-held`)
      await rename(target, path.join(root, "accepted-restored-0.bin"))
      await writeFile(path.join(candidate, "DIRECT_CHAT.md"), "x".repeat(100000))
      await expect(recoverTaskVersions(spec, { root: campaign, candidateRoot: candidate,
        cap: 10000000 })).rejects.toThrow("source size drift")
      await expect(readFile(file)).rejects.toThrow()
      expect(executions).toBe(1)
      await rename(path.join(root, "accepted-restored-0.bin"), target)
      await writeFile(path.join(candidate, "DIRECT_CHAT.md"), original)
      await recoverTaskVersions(spec, { root: campaign, candidateRoot: candidate, cap: 10000000 })
      const recovered = await recordTaskVersion(spec, { root: campaign, candidateRoot: candidate,
        feedback: result.protocolTrainingResultPath, passed: true, round: 1, maxRounds: 2,
        snapshot: { recover: true, cap: 10000000 } })
      expect(recovered).toEqual(selected)
      expect(executions).toBe(1)
      const repeated = path.join(campaign, "rounds/round-002/final-acceptance")
      await mkdir(repeated, { recursive: true })
      for (const name of ["protocol.receipt.json", "protocol.completed.json", "protocol.product.bin"])
        await writeFile(path.join(repeated, name), await readFile(path.join(attempt, name)))
      const training = JSON.parse(await readFile(result.protocolTrainingResultPath, "utf8"))
      const feedback = path.join(repeated, "result.json.training.json")
      await writeFile(feedback, JSON.stringify({ ...training, roundNumber: 2,
        protocolTrainingResultPath: feedback, protocolAuditResultPath: path.join(repeated, "result.json") }))
      const repeat = await recordTaskVersion(spec, { root: campaign, candidateRoot: candidate,
        feedback, passed: true, round: 2, maxRounds: 2, snapshot: { recover: false, cap: 10000000 } })
      expect(repeat?.selectedTaskVersionPath).toBe(selected?.selectedTaskVersionPath)
      expect(repeat?.taskStopReason).toBe("round_budget")
      expect((await readTaskVersions(spec, campaign))[0].record.round).toBe(1)
      expect(executions).toBe(1)
      spec.taskAdaptation!.requestBudget = requestBudget
      const rejectedPath = path.join(campaign, "rounds/round-002/final-acceptance/pass-02")
      await writeFile(path.join(candidate, "DIRECT_CHAT.md"), "x".repeat(5001))
      const rejected = await campaignAcceptance({ ...options, roundNumber: 2, attemptRoot: rejectedPath,
        resultPath: path.join(rejectedPath, "result.json") }, runtime)
      expect(rejected.passed).toBe(false)
      expect(rejected.failureKind).toBe("product_failure")
      const rejectedRound: LongTaskCampaignRoundRecord = { ...round, roundNumber: 2, roundID: "round-002",
        roundClosure: "closed_repairable", gateFailureKind: "final_acceptance_failed",
        finalAcceptanceSignal: { executed: true, passed: false, failureKind: "product_failure",
          failedValidatorIDs: rejected.validatorResults.filter(item => !item.passed).map(item => item.validatorID),
          feedbackPath: rejected.protocolTrainingResultPath } }
      const failure = await archiveRound(spec, { ...input, pass: 2, round: rejectedRound, parent: observed.candidate.id })
      expect(failure.observation.verdict).toBe("rejected")
      expect(failure.observation.metric).toBeUndefined()
      expect((await readTaskVersions(spec, campaign))).toHaveLength(1)
      const before = executions
      const checkpoint = path.join(rejectedPath, "protocol.completed.json")
      await rename(checkpoint, `${checkpoint}.held`)
      await expect(archiveRound(spec, { ...input, pass: 2, round: rejectedRound,
        parent: observed.candidate.id })).rejects.toThrow()
      expect(executions).toBe(before)
      await rename(`${checkpoint}.held`, checkpoint)
      await writeFile(path.join(candidate, "DIRECT_CHAT.md"), original)
      await expect(archiveRound(spec, { ...input, pass: 2, round: rejectedRound,
        parent: observed.candidate.id })).rejects.toThrow("changed after acceptance")
      expect(executions).toBe(before)
      delete spec.taskAdaptation!.requestBudget
    }
    for (const role of ["planner", "executor", "reviewer", "diagnostician"] as const) {
      const invocation = taskInvocation(spec, role)!
      const authorized = await authorizeInvocation(invocation, request)
      expect(authorized.request.resourceReaderGrant).toBeUndefined()
      expect(authorized.request.permissionReadPaths).toContain(path.join(attempt, "task.feedback.json").replaceAll("\\", "/"))
      expect(authorized.request.permissionReadPaths).not.toContain(feedback.caseFeedback.manifestPath)
      await expect(authorizeInvocation({ ...invocation, feedbackResource: (await taskFeedback(bound, reference)).feedbackResource }, request)).rejects.toThrow("authorized role window")
    }
    const backends = await readdir(path.join(campaign, "protocol-backends", "consolidation"))
    expect(backends).toHaveLength(1)
  }
// Windows逐题子进程和原子落盘较慢，保留完整150题断言而不缩小用例。
}, 600000)
