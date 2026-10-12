import { expect, test } from "bun:test"
import { permitsAuthorOperation } from "./author-operation"
import { normalizePlanningGraph, enforceRequiredRoutingCoverage } from "../long-task/runner"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { LongTaskSpec } from "../long-task/contract"

const spec = { title: "Generic", goal: "Learn reusable rules", materials: [], validators: [],
  protocolPlugins: { schema: "aev.protocol-entry.v1", taskID: "source", phase: "source", selectionPath: "E:/fixture/selection.json", projectManifestPath: "E:/fixture/manifest.json" } } as LongTaskSpec
const unit = (id: string, operation?: string) => ({ id, operation, title: id, goal: "Prepare declared output",
  inputs: [], depends_on: [], expected_artifacts: [], claim: "Draft ready", check_plan: "Inspect own artifacts", validator_ids: [] })

test("host operations and missing model declarations are not author units", () => {
  for (const operation of ["protocol_check", "independent_execution", "host_acceptance", "wait_host", "unknown", undefined]) {
    expect(permitsAuthorOperation(unit("x", operation))).toBe(false)
  }
  expect(permitsAuthorOperation(unit("x", "author_work"))).toBe(true)
  expect(permitsAuthorOperation(unit("x"), true)).toBe(true)
})

test("real graph normalizer keeps author artifacts regardless of names and removes declared host operations", () => {
  const graph = normalizePlanningGraph({ units: [unit("write-result.json", "author_work"), unit("generic-a", "host_acceptance"), unit("generic-b", "wait_host")] }, spec, "invalid")
  expect(graph.units.map(item => item.id)).toEqual(["write-result.json"])
  expect(graph.units[0].checkPlan).toContain("never wait for the parent")
  const fallback = normalizePlanningGraph({ units: [unit("arbitrary", "independent_execution")] }, spec, "invalid author ownership")
  expect(fallback.units).toHaveLength(1)
  expect(fallback.units[0].goal).toContain("Prepare or revise declared candidate Skill")
  expect(fallback.units[0].checkPlan).toContain("Do not execute or await host acceptance")
})

test("legacy graph behavior and trusted new initial graph stay separate", () => {
  const old = { ...spec, protocolPlugins: undefined }
  expect(normalizePlanningGraph({ units: [unit("ordinary")] }, old, "invalid").units[0].id).toBe("ordinary")
  expect(normalizePlanningGraph({ units: [unit("provided")] }, spec, "invalid", true).units[0].id).toBe("provided")
})

test("author dependency on a removed host unit uses safe author fallback rather than waiting for missing work", () => {
  const author = { ...unit("draft", "author_work"), depends_on: ["accept"] }
  const graph = normalizePlanningGraph({ units: [author, unit("accept", "host_acceptance")] }, spec, "invalid")
  expect(graph.units).toHaveLength(1)
  expect(graph.units[0].dependsOn).toEqual([])
  expect(graph.units[0].goal).toContain("Prepare or revise declared candidate Skill")
})

test("automatic required-region coverage is author-only even when routing text mentions acceptance", async () => {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(root, { recursive: true })
  const route = path.join(root, "routing.json")
  await writeFile(route, JSON.stringify({ requiredNextRegions: ["dispatch-repair:prepare-host-acceptance"] }))
  const graph = normalizePlanningGraph({ units: [unit("draft", "author_work")] }, spec, "invalid")
  const result = await enforceRequiredRoutingCoverage({ spec: { ...spec, campaignRoutingControlPath: route }, graph })
  expect(result.units).toHaveLength(2)
  expect(result.units[1].goal).toContain("not executed or awaited here")
  expect(result.units[1].checkPlan).toContain("after return")
})
