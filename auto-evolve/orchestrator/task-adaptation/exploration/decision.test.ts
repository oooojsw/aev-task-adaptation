import { expect, test } from "bun:test"
import { decide, type DecisionInput, type Observation } from "./decision"

const hash = (n: number) => n.toString(16).padStart(64, "0")
function observation(round: number, branch: Observation["branch"] = "original", metric?: number): Observation {
  return {
    campaign: "fixture",
    round,
    closure: hash(round),
    branch,
    candidate: hash(round + 100),
    verdict: "rejected",
    ...(metric === undefined ? {} : { metric }),
  }
}
function input(): DecisionInput {
  return {
    campaign: "fixture",
    observations: [observation(1), observation(2)],
    branch: "original",
    activated: false,
    firstPass: false,
    qualified: false,
    stopped: false,
    fault: false,
    unresolved: false,
    hardStop: false,
    originReady: true,
    remaining: { rounds: 5, calls: 100, tokens: 100000 },
    policy: {
      schema: "aev.exploration-policy.v1",
      origin: { kind: "initial" },
      replace: ["report"],
      preserve: [],
      dependencies: [],
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
    },
  }
}

test("closed rounds deduplicate on resume without mutating history or decision", () => {
  const cfg = input(),
    before = JSON.stringify(cfg)
  const first = decide(cfg)
  expect(first.action).toBe("activate")
  expect(decide(cfg)).toEqual(first)
  expect(JSON.stringify(cfg)).toBe(before)
  cfg.observation = structuredClone(cfg.observations[1])
  expect(decide(cfg).observations).toHaveLength(2)
  expect(decide(cfg).identity).toBe(first.identity)
  cfg.observation.closure = hash(999)
  expect(() => decide(cfg)).toThrow("conflict")
})

test("safety, unresolved requests and first pass precede exploration", () => {
  for (const [key, action, reason] of [
    ["stopped", "finish", "user_stop"],
    ["fault", "hold", "infrastructure"],
    ["unresolved", "hold", "unresolved_request"],
    ["hardStop", "finish", "global_limit"],
  ] as const) {
    const cfg = input()
    cfg[key] = true
    expect(decide(cfg)).toMatchObject({ action, reason })
  }
  const cfg = input()
  cfg.firstPass = cfg.qualified = true
  expect(decide(cfg).reason).toBe("first_pass")
  cfg.unresolved = true
  expect(decide(cfg).action).toBe("hold")
})

test("minimum complete cycles and available rounds are required before activation", () => {
  for (const [unit, amount] of [
    ["calls", 11],
    ["tokens", 21999],
    ["rounds", 1],
  ] as const) {
    const cfg = input()
    cfg.remaining[unit] = amount
    expect(decide(cfg).action).toBe("finish")
  }
  const cfg = input()
  cfg.remaining = { rounds: 2, calls: 12, tokens: 22000 }
  expect(decide(cfg).action).toBe("activate")
  cfg.originReady = false
  expect(decide(cfg).reason).toBe("origin_unavailable")
})

test("alternative receives local grace but never a second restart or extended hard allowance", () => {
  const cfg = input()
  cfg.activated = true
  cfg.branch = "alternative"
  expect(decide(cfg).action).toBe("continue")
  cfg.observations = [...cfg.observations, observation(3, "alternative")]
  expect(decide(cfg).action).toBe("continue")
  cfg.observations = [...cfg.observations, observation(4, "alternative")]
  expect(decide(cfg).reason).toBe("restart_used")
  cfg.observations = [...cfg.observations, observation(5, "alternative")]
  expect(decide(cfg).reason).toBe("alternative_limit")
})

test("metric patience requires real improvement; equal scores and repeated candidates consume patience", () => {
  const cfg = input()
  cfg.policy = {
    ...cfg.policy,
    trigger: { kind: "metric", name: "score", direction: "max", minimumDelta: 0, patience: 2, minimumObservations: 2 },
  }
  cfg.observations = [observation(1, "original", 10), observation(2, "original", 10)]
  expect(decide(cfg).action).toBe("continue")
  cfg.observations = [...cfg.observations, observation(3, "original", 10)]
  expect(decide(cfg).action).toBe("activate")
  cfg.observations = [...cfg.observations.slice(0, 2), observation(3, "original", 11)]
  expect(decide(cfg).action).toBe("continue")
  cfg.observations[2].candidate = cfg.observations[0].candidate
  expect(decide(cfg).action).toBe("activate")
})

test("metric minimization and minimum delta are deterministic", () => {
  const cfg = input()
  cfg.policy = {
    ...cfg.policy,
    trigger: {
      kind: "metric",
      name: "latency",
      direction: "min",
      minimumDelta: 2,
      patience: 1,
      minimumObservations: 2,
    },
  }
  cfg.observations = [observation(1, "original", 10), observation(2, "original", 9)]
  expect(decide(cfg).action).toBe("activate")
  cfg.observations[1].metric = 8
  expect(decide(cfg).action).toBe("continue")
})

test("explicitly absent metrics and JSON-restored observations share one identity", () => {
  const cfg = input(),
    first = decide(cfg)
  cfg.observations = cfg.observations.map((item) => ({ ...item, metric: undefined }))
  expect(decide(cfg)).toEqual(first)
  cfg.observation = { ...cfg.observations[1], metric: undefined }
  expect(decide(cfg)).toEqual(first)
  expect(decide(JSON.parse(JSON.stringify(cfg)))).toEqual(first)
})

test("global empty call or token balances stop both branches before a local trigger", () => {
  for (const branch of ["original", "alternative"] as const) {
    for (const unit of ["calls", "tokens"] as const) {
      const cfg = input()
      cfg.branch = branch
      cfg.activated = branch === "alternative"
      cfg.observations = branch === "original" ? [observation(1)] : []
      cfg.remaining[unit] = 0
      expect(decide(cfg).reason).toBe("global_limit")
      cfg.unresolved = true
      expect(decide(cfg).action).toBe("hold")
      cfg.stopped = true
      expect(decide(cfg).reason).toBe("user_stop")
    }
  }
  const cfg = input()
  cfg.firstPass = cfg.qualified = cfg.hardStop = true
  expect(decide(cfg).reason).toBe("first_pass")
  cfg.fault = true
  expect(decide(cfg).reason).toBe("infrastructure")
})

test("conflicting, nonfinite and backwards histories fail closed", () => {
  for (const change of [
    (cfg: DecisionInput) => {
      cfg.observations = [observation(1), { ...observation(2), closure: hash(1) }]
    },
    (cfg: DecisionInput) => {
      cfg.activated = true
    },
    (cfg: DecisionInput) => {
      cfg.branch = "alternative"
    },
    (cfg: DecisionInput) => {
      cfg.observations = [observation(2), observation(1)]
    },
    (cfg: DecisionInput) => {
      cfg.observations = [observation(1, "alternative"), observation(2)]
    },
    (cfg: DecisionInput) => {
      cfg.observations = [observation(1, "original", NaN)]
    },
    (cfg: DecisionInput) => {
      cfg.remaining.tokens = Infinity
    },
    (cfg: DecisionInput) => {
      cfg.observation = { ...observation(3), campaign: "other" }
    },
  ]) {
    const cfg = input()
    change(cfg)
    expect(() => decide(cfg)).toThrow()
  }
})
