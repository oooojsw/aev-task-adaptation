import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { TRAINING_ROLES, validateTraining, trainingExecution, trainingRuntimeBudget, freezeTraining, verifyTraining, type TrainingConfig } from "./training"
import type { LongTaskSpec } from "../long-task/contract"
import type { AutoEvolveConfig } from "../schema"
import { loadLongTaskSpec } from "../long-task/spec"

function config(): TrainingConfig {
  return { schema: "aev.protocol-training.v1", roles: Object.fromEntries(TRAINING_ROLES.map((role, index) =>
    [role, { model: `fixture/${role}`, timeoutMs: 1000 + index }])) as TrainingConfig["roles"],
    budgets: { maxAttemptsPerUnit: 2, maxTotalUnitAttempts: 8, maxGraphReplans: 1, maxValidatorCalls: 10, maxNoProgressCycles: 2, maxUnitsPerGraph: 5 } }
}

test("all training roles route independent explicit models and finite invocation budgets", () => {
  const training = config()
  const spec = { protocolTraining: training } as LongTaskSpec
  for (const [index, role] of TRAINING_ROLES.entries()) {
    expect(trainingExecution(spec, role, { model: "legacy/default" })).toEqual({ model: `fixture/${role}` })
    expect(trainingRuntimeBudget(spec, role)?.hardTimeoutMs).toBe(1000 + index)
  }
  const fallback = { model: "original", system: "Original system" }
  expect(trainingExecution({} as LongTaskSpec, "lead", fallback)).toBe(fallback)
  expect(trainingRuntimeBudget({} as LongTaskSpec, "lead")).toBeUndefined()
  expect(() => validateTraining({ ...training, roles: { ...training.roles, lead: undefined } })).toThrow()
  expect(() => validateTraining({ ...training, budgets: { ...training.budgets, maxTotalUnitAttempts: Infinity } })).toThrow()
})

test("role deadlines stay independent, explicit overrides validate and do not leak into model selection", () => {
  const training = config()
  training.roles.lead.timeoutMs = 3 * 3600000
  const spec = {protocolTraining: training} as LongTaskSpec
  expect(trainingRuntimeBudget(spec, "lead")).toEqual({profile: "long", softDeadlineMs: 7200000,
    hardTimeoutMs: 10800000, silentTimeoutMs: 1800000, silentTimeoutAfterActivityMs: 5400000})
  training.roles.lead.runtimeBudget = {softDeadlineMs: 3600000, silentTimeoutMs: 600000}
  expect(trainingRuntimeBudget(spec, "lead")?.softDeadlineMs).toBe(3600000)
  expect(trainingExecution(spec, "lead")).toEqual({model: "fixture/lead"})
  training.roles.lead.runtimeBudget.hardTimeoutMs = 1000
  expect(() => validateTraining(training)).toThrow("Conflicting")
  delete training.roles.lead.runtimeBudget.hardTimeoutMs
  training.roles.lead.runtimeBudget.softDeadlineMs = 20000000
  expect(() => validateTraining(training)).toThrow("exceeds")
})

test("frozen training blocks role/budget/host drift and removed configuration", async () => {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(root, { recursive: true })
  let host = "a".repeat(64)
  const driver = async () => ({ implementation: host, preflight: async () => {}, invoke: async () => { throw new Error("No model call") } })
  const training = config()
  const dir = await freezeTraining(root, training, root, driver)
  expect(await freezeTraining(root, training, root, driver)).toBe(dir)
  const spec = { protocolTraining: training, protocolTrainingRoot: dir } as LongTaskSpec
  await verifyTraining(spec, root, {} as AutoEvolveConfig, driver)
  const original = await readFile(path.join(dir!, "training.snapshot.json"))
  const changed = structuredClone(training)
  changed.roles.lead.model = "other/lead"
  await expect(freezeTraining(root, changed, root, driver)).rejects.toThrow("drift")
  await expect(freezeTraining(root, undefined, root, driver)).rejects.toThrow("removed")
  host = "b".repeat(64)
  await expect(verifyTraining(spec, root, {} as AutoEvolveConfig, driver)).rejects.toThrow("drift")
  expect(await readFile(path.join(dir!, "training.snapshot.json"))).toEqual(original)
})

test("actual spec loader retains training roles and applies work budgets without legacy mixing", async () => {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, "public.txt"), "Public")
  const file = path.join(root, "spec.json")
  const spec = { title: "Generic", goal: "Learn", validators: [], materials: [{ label: "public", path: "public.txt" }],
    protocolPlugins: { schema: "aev.protocol-entry.v1", selectionPath: path.join(root, "selection.json"),
      projectManifestPath: path.join(root, "manifest.json"), taskID: "task", phase: "source" }, protocolTraining: config() }
  await writeFile(file, JSON.stringify(spec))
  const loaded = (await loadLongTaskSpec(file)).spec
  expect(loaded.protocolTraining).toEqual(config())
  expect(loaded.budgets).toEqual(config().budgets)
  await writeFile(file, JSON.stringify({ ...spec, budgets: { maxTotalUnitAttempts: 999 } }))
  await expect(loadLongTaskSpec(file)).rejects.toThrow("Conflicting")
  await writeFile(file, JSON.stringify({ ...spec, protocolPlugins: undefined }))
  await expect(loadLongTaskSpec(file)).rejects.toThrow("requires protocol")
})
