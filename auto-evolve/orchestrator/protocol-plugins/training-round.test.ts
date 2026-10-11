import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { buildGeneratedRoundSpec } from "../long-task-campaign/runner"
import { loadLongTaskSpec } from "../long-task/spec"
import { loadLongTaskCampaignSpec } from "../long-task-campaign/spec"
import { TRAINING_ROLES, type TrainingConfig } from "./training"

test("actual generated Campaign rounds retain frozen training and distinguish legacy budget overrides", async () => {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(root, { recursive: true })
  const specPath = path.join(root, "spec.json")
  await writeFile(path.join(root, "public.txt"), "Public task rules")
  await writeFile(specPath, JSON.stringify({ title: "Generic exploration", goal: "Learn reusable rules",
    validators: [{ id: "local", type: "prompt_json", title: "Local author check", prompt: "Check local work" }],
    materials: [{ label: "rules", path: "public.txt" }] }))
  const baseSpec = (await loadLongTaskSpec(specPath)).spec
  const campaignPath = path.join(root, "campaign.json")
  await writeFile(campaignPath, JSON.stringify({ title: "Generic Campaign", baseSpecPath: specPath,
    mode: "graph_iterative", maxRounds: 2, seedTargets: [] }))
  const campaignSpec = (await loadLongTaskCampaignSpec(campaignPath)).spec
  const input = { baseSpec, campaignSpec, roundNumber: 1, pendingPackageRoot: path.join(root, "candidate"),
    explorationTreePath: path.join(root, "tree.json"), workingMemoryPath: path.join(root, "memory.json"),
    routingControlPath: path.join(root, "routing.json"), dispatchTicketsPath: path.join(root, "tickets.json"),
    blankAgentAcceptanceDiagnosisPath: path.join(root, "diagnosis.json") }
  const legacy = buildGeneratedRoundSpec({ ...input, campaignSpec: { ...campaignSpec,
    roundBudgetOverrides: { maxTotalUnitAttempts: 19 } } })
  expect(legacy.budgets.maxTotalUnitAttempts).toBe(19)
  const training: TrainingConfig = { schema: "aev.protocol-training.v1", roles: Object.fromEntries(TRAINING_ROLES.map((role) =>
    [role, { model: `fixture/${role}`, timeoutMs: 2000 }])) as TrainingConfig["roles"], budgets: structuredClone(baseSpec.budgets) }
  baseSpec.protocolTraining = training
  baseSpec.protocolTrainingRoot = root
  baseSpec.protocolAuthorContext = { fingerprint: "a".repeat(64), projectFingerprint: "b".repeat(64),
    task: "source", phase: "source", claim: "task_execution", skill: { format: "text",
      entries: [{ id: "rules", kind: "text", path: "policy/rules.txt" }] }, checks: [] }
  for (const roundNumber of [1, 2]) {
    const actual = buildGeneratedRoundSpec({ ...input, roundNumber })
    expect(actual.protocolTraining).toEqual(training)
    expect(actual.protocolTrainingRoot).toBe(root)
    expect(actual.budgets).toEqual(training.budgets)
    expect(actual.goal).toContain("policy/rules.txt")
    expect(actual.goal).toContain("The host controller owns formal acceptance")
    expect(actual.goal).toContain("Acceptance execution is a separate configured backend")
  }
  const same = buildGeneratedRoundSpec({ ...input, campaignSpec: { ...campaignSpec,
    roundBudgetOverrides: { maxTotalUnitAttempts: training.budgets.maxTotalUnitAttempts } } })
  expect(same.budgets).toEqual(training.budgets)
  expect(() => buildGeneratedRoundSpec({ ...input, campaignSpec: { ...campaignSpec,
    roundBudgetOverrides: { maxTotalUnitAttempts: training.budgets.maxTotalUnitAttempts + 1 } } })).toThrow("frozen protocol training")
})
