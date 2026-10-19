import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile, link } from "node:fs/promises"
import path from "node:path"
import { fingerprint } from "../../protocol-plugins/identity"
import { validatePlan, planIdentity } from "../plan"
import { checkTaskExploration, taskInvocation, type Adaptation } from "../context"
import { prepareTaskRun, type TaskRunPreparation } from "../prepare-task-run"
import { prepareExecution, type ExecutionPreparation } from "../prepare-execution"
import type { LongTaskSpec } from "../../long-task/contract"
import type { Registry } from "../../protocol-plugins/registry"
import { requireExplorationHost } from "./entry"
import { plan, policy } from "./policy.test"

test("optional policy freezes in Plan identity without adding an absent default", () => {
  const original = plan(), before = fingerprint(original)
  expect(planIdentity(original)).toBe(before)
  expect(Object.hasOwn(validatePlan(original), "exploration")).toBe(false)
  const enabled = validatePlan({ ...plan(), exploration: policy() })
  expect(planIdentity(enabled)).not.toBe(before)
  expect(Object.isFrozen(enabled.exploration)).toBe(true)
  expect(planIdentity(JSON.parse(JSON.stringify(enabled)))).toBe(planIdentity(enabled))
  expect(planIdentity({ ...plan(), exploration: { ...policy(), trigger: { kind: "attempts", observations: 3 } } }))
    .not.toBe(planIdentity(enabled))
  expect(() => validatePlan({ ...plan(), exploration: undefined })).toThrow("Explicit exploration")
  expect(() => validatePlan({ ...plan(), exploration: { ...policy(), enabled: true } })).toThrow("policy")
})

test("validating a policy does not authorize execution or self-reported Host capabilities", () => {
  const value = validatePlan({ ...plan(), exploration: policy() })
  expect(() => requireExplorationHost(value)).toThrow("Host role window missing")
  expect(() => validatePlan({ ...value, exploration: { ...policy(), fencedReaders: true } })).toThrow()
  expect(() => requireExplorationHost(validatePlan(plan()))).not.toThrow()
})

test("preset preparation rejects exploration before backend creation or any intake call", async () => {
  const root = path.join("E:/project/AEV-task-adaptation-20261016/test-evidence", `exploration-preflight-${randomUUID()}`)
  await mkdir(root, { recursive: true })
  const file = path.join(root, "plan.json")
  await writeFile(file, "\uFEFF" + JSON.stringify({ ...plan(), exploration: policy() }))
  let invoked = false
  const input = { intake: { mode: "manual_plan", planPath: file } } as TaskRunPreparation
  await expect(prepareTaskRun(input, { createRuntime: async () => { invoked = true; throw new Error("must not start") } }))
    .rejects.toThrow("Host role window missing")
  expect(invoked).toBe(false)
  // 直接准备与直接加载都不能绕过同一能力门。
  await expect(prepareExecution({ plan: { ...plan(), exploration: policy() } } as ExecutionPreparation, {} as Registry))
    .rejects.toThrow("Host role window missing")
  const adaptation: Adaptation = { schema: "aev.task-adaptation.v1", planPath: file, root, capabilities: [],
    entries: [{ id: "report", path: "report.md" }] }
  await expect(checkTaskExploration(adaptation)).rejects.toThrow("Host role window missing")
  await writeFile(file, JSON.stringify(plan()))
  await expect(checkTaskExploration(adaptation)).resolves.toBeUndefined()
  await expect(checkTaskExploration(undefined)).resolves.toBeUndefined()
})

test("a constructed role context cannot omit required Host windows", () => {
  const spec = { taskAdaptation: {}, taskAdaptationContext: { plan: { ...plan(), exploration: policy() } } } as LongTaskSpec
  expect(() => taskInvocation(spec, "lead")).toThrow("Host role window missing")
})

test("preset preflight keeps the original size and hardlink protection before backend creation", async () => {
  const root = path.join("E:/project/AEV-task-adaptation-20261016/test-evidence", `exploration-unsafe-plan-${randomUUID()}`)
  await mkdir(root, { recursive: true })
  const oversized = path.join(root, "oversized.json"), original = path.join(root, "original.json"), linked = path.join(root, "linked.json")
  await writeFile(oversized, " ".repeat(1024 * 1024 + 1))
  await writeFile(original, JSON.stringify(plan()))
  await link(original, linked)
  let invoked = false
  for (const file of [oversized, linked]) {
    await expect(prepareTaskRun({ intake: { mode: "manual_plan", planPath: file } } as TaskRunPreparation,
      { createRuntime: async () => { invoked = true; throw new Error("must not start") } }))
      .rejects.toThrow("Unsafe or oversized")
  }
  expect(invoked).toBe(false)
})
