import { expect, test } from "bun:test"
import { buildLongTaskPlanningPrompt, buildLongTaskExecutionPrompt, buildLongTaskReplanPrompt } from "../long-task/prompts"
import type { LongTaskSpec, LongTaskWorkGraph, LongTaskWorkUnit } from "../long-task/contract"

const entry = { schema: "aev.protocol-entry.v1" as const, selectionPath: "E:/fixture/selection.json",
  projectManifestPath: "E:/fixture/manifest.json", taskID: "generic", phase: "source" as const }
const spec = { title: "Author work", goal: "Produce reusable guidance", materials: [], validators: [], protocolPlugins: entry } as LongTaskSpec
const unit = { id: "revise", title: "Revise", goal: "Revise candidate", claim: "Candidate written", checkPlan: "Inspect own artifacts",
  expectedArtifacts: [], validatorIDs: [], attemptCount: 1, retryBudget: 1 } as unknown as LongTaskWorkUnit
const graph = { units: [unit], completionValidatorIDs: [] } as unknown as LongTaskWorkGraph

test("new planner executor and replanner distinguish author completion from later host acceptance", () => {
  const prompts = [buildLongTaskPlanningPrompt({ spec, specPath: "E:/fixture/spec.json", planningOutputPath: "E:/fixture/plan.json" }),
    buildLongTaskExecutionPrompt({ spec, graph, unit, bundlePath: "E:/fixture/bundle.json", validatorInputPaths: [] }),
    buildLongTaskReplanPrompt({ spec, graph, unresolvedUnits: [unit], failurePacketSummaries: [], replanOutputPath: "E:/fixture/replan.json" })]
  for (const prompt of prompts) {
    expect(prompt).toContain("parent is waiting for your response before it can grade")
    expect(prompt).toContain("do not execute or await that step")
    expect(prompt).toContain("claimed_success describes completion of this author unit")
  }
})

test("held-out phase cannot be dispatched as new author learning via prompt entry", () => {
  const heldOut = { ...spec, protocolPlugins: { ...entry, phase: "test" as const } }
  expect(() => buildLongTaskPlanningPrompt({ spec: heldOut, specPath: "E:/fixture/spec.json", planningOutputPath: "E:/fixture/plan.json" }))
    .toThrow("Held-out test cannot become an author work graph")
  expect(() => buildLongTaskExecutionPrompt({ spec: heldOut, graph, unit, bundlePath: "E:/fixture/bundle.json", validatorInputPaths: [] }))
    .toThrow("Held-out test cannot become an author work graph")
})
