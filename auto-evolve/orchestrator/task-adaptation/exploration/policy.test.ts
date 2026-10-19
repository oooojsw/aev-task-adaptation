import { expect, test } from "bun:test"
import { fingerprint } from "../../protocol-plugins/identity"
import { validatePlan, type Plan } from "../plan"
import {
  explorationIdentity,
  explorationPolicy,
  requireExplorationCapabilities,
  type ExplorationPolicy,
} from "./policy"

export function plan(): Plan {
  return {
    schema: "aev.task-plan.v1",
    id: "exploration-local-fixture",
    objective: "Create a report",
    deliverable: { kind: "report", entries: ["report", "facts"] },
    resources: [
      { id: "report", path: "report.md", mutable: true, audience: "public" },
      { id: "facts", path: "facts.md", mutable: true, audience: "public" },
      { id: "source", path: "source.txt", mutable: false, audience: "public" },
      { id: "private", path: "private.txt", mutable: false, audience: "private" },
    ],
    capabilities: [],
    windows: [{ role: "checker", stage: "accept", reads: ["report"], writes: [], inline: [], actions: ["read"] }],
    workers: [],
    acceptance: {
      execution: "none",
      checks: [
        {
          id: "quality",
          target: "candidate",
          mechanism: "script",
          purpose: "Check fixture",
          required: true,
          resources: ["report"],
          feedback: "message",
        },
      ],
    },
    rejection: [{ check: "quality", actions: ["repair"] }],
    selection: { rule: "first_pass" },
    stop: { rounds: 7, calls: 100, tokens: 100000, stagnant: 2 },
  }
}

export function policy(): ExplorationPolicy {
  return {
    schema: "aev.exploration-policy.v1",
    origin: { kind: "initial" },
    replace: ["report"],
    preserve: ["facts"],
    dependencies: ["source"],
    trigger: { kind: "attempts", observations: 2 },
    allowance: {
      rounds: 3,
      minimumRounds: 2,
      authorCalls: 5,
      authorTokens: 10000,
      acceptanceCalls: 1,
      acceptanceTokens: 1000,
      deliveryCalls: 0,
      deliveryTokens: 0,
    },
    bounds: { archiveBytes: 1000000, candidateBytes: 10000, dependencyBytes: 10000 },
    safety: { reset: "declared_entries", effects: "sandbox_only" },
  }
}

test("absent policy does not enable exploration or mutate the old plan identity", () => {
  const original = plan(),
    before = fingerprint(original)
  expect(validatePlan(original).id).toBe(original.id)
  expect(explorationPolicy(undefined, original)).toBeUndefined()
  expect(explorationIdentity(undefined, original)).toBeUndefined()
  expect(fingerprint(original)).toBe(before)
})

test("policy freezes one origin, explicit replacement and finite allowance", () => {
  const cfg = policy(),
    frozen = explorationPolicy(cfg, plan())!
  expect(Object.isFrozen(frozen.allowance)).toBe(true)
  cfg.replace.push("private")
  expect(frozen.replace).toEqual(["report"])
  expect(explorationIdentity(frozen, plan())).toMatch(/^[a-f0-9]{64}$/)
})

test("rejects extra actions, unbounded budgets, invalid partitions and unsafe resources", () => {
  for (const modify of [
    (cfg: ExplorationPolicy) => Object.assign(cfg, { parallel: true }),
    (cfg: ExplorationPolicy) => {
      cfg.origin = { kind: "candidate", fingerprint: "guessed" } as never
    },
    (cfg: ExplorationPolicy) => {
      cfg.preserve = []
    },
    (cfg: ExplorationPolicy) => {
      cfg.dependencies = ["private"]
    },
    (cfg: ExplorationPolicy) => {
      cfg.dependencies = ["report"]
    },
    (cfg: ExplorationPolicy) => {
      cfg.allowance.authorTokens = Infinity
    },
    (cfg: ExplorationPolicy) => {
      cfg.allowance.authorTokens = 60000
    },
    (cfg: ExplorationPolicy) => {
      cfg.allowance.minimumRounds = 4
    },
    (cfg: ExplorationPolicy) => {
      cfg.allowance.acceptanceCalls = 0
    },
    (cfg: ExplorationPolicy) => {
      cfg.safety.effects = "external" as never
    },
  ]) {
    const cfg = policy()
    modify(cfg)
    expect(() => explorationPolicy(cfg, plan())).toThrow()
  }
})

test("candidate origin identity must be a string rather than a coercible JSON array", () => {
  const cfg = policy()
  cfg.origin = { kind: "candidate", fingerprint: "a".repeat(64), archive: process.cwd().replaceAll("\\", "/"),
    scope: { campaign: "prior", plan: "b".repeat(64), protocol: "c".repeat(64), policy: "d".repeat(64),
      budget: { root: process.cwd().replaceAll("\\", "/"), scope: "prior" } } }
  expect(explorationPolicy(cfg, plan())!.origin.kind).toBe("candidate")
  cfg.origin.fingerprint = ["a".repeat(64)] as never
  expect(() => explorationPolicy(cfg, plan())).toThrow("origin")
})

test("binary plans cannot silently acquire a numerical objective", () => {
  const cfg = policy()
  cfg.trigger = {
    kind: "metric",
    name: "score",
    direction: "max",
    minimumDelta: 0,
    patience: 2,
    minimumObservations: 2,
  }
  expect(() => explorationPolicy(cfg, plan())).toThrow("metric")
  const task = plan()
  task.acceptance.execution = "independent"
  task.selection = { rule: "best_pass", metric: "score", direction: "max" }
  expect(explorationPolicy(cfg, task)!.trigger.kind).toBe("metric")
  task.selection.direction = "min"
  expect(() => explorationPolicy(cfg, task)).toThrow("metric")
})

test("every required adapter capability is explicit; false and missing cannot be silently ignored", () => {
  const cfg = explorationPolicy(policy(), plan())!
  const capabilities = {
    fencedReaders: true,
    isolatedViews: true,
    selectedDelivery: true,
    enforcedStageBudget: true,
    verifiedOrigin: true,
    verifiedDependencies: true,
    replaySafe: true,
  }
  requireExplorationCapabilities(cfg, capabilities)
  for (const key of Object.keys(capabilities)) {
    expect(() => requireExplorationCapabilities(cfg, { ...capabilities, [key]: false })).toThrow(key)
  }
  requireExplorationCapabilities(undefined, {} as never)
})
