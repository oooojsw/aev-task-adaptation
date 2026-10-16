import type { TaskCatalogue, Decision } from "./catalogue"

export function catalogue(): TaskCatalogue {
  const check = (id: string, target: "candidate" | "product", mechanism: "script" | "judge") => ({
    id, target, mechanism, purpose: `Verify ${id}`, required: true, resources: ["candidate", "rubric"], feedback: "status_only" as const,
  })
  return { id: "sample", request: "Investigate the supplied source and write an evidence-supported report",
    resources: [{ id: "candidate", path: "candidate.txt", audience: "public", mutable: true },
      { id: "source", path: "source.txt", audience: "public", mutable: false },
      { id: "rubric", path: "private.txt", audience: "private", mutable: false }],
    entries: ["candidate"], maxWorkers: 3, stop: { rounds: 3, calls: 40, tokens: 100000, stagnant: 2 },
    capabilities: [{ id: "files", version: "1", description: "Read source files and edit declared deliverables", actions: ["read", "edit"], available: true },
      { id: "source-check", version: "1", description: "Compare claims with sources", actions: ["verify_source"], available: true },
      { id: "program", version: "1", description: "Run correctness checks and measure performance", actions: ["execute"], available: true },
      { id: "independent", version: "1", description: "Execute reusable instructions independently", actions: [], available: true }],
    profiles: [
      { id: "report", description: "Check coverage, sources, counterexamples, and uncertainty", kinds: ["report"], requires: ["files", "source-check"],
        acceptance: { execution: "none", checks: [check("support", "candidate", "judge")] },
        rejection: [{ check: "support", actions: ["verify_source", "research"] }], selection: { rule: "first_pass" } },
      { id: "recompute", description: "Recompute report claims using an actual execution", kinds: ["report"], requires: ["files", "program"],
        acceptance: { execution: "script", checks: [check("recomputed", "product", "script")] },
        rejection: [{ check: "recomputed", actions: ["recompute"] }], selection: { rule: "first_pass" } },
      { id: "skill", description: "Check reusable instructions and an independent execution", kinds: ["skill"], requires: ["files", "independent"],
        acceptance: { execution: "independent", checks: [check("surface", "candidate", "script"), check("answer", "product", "script")] },
        rejection: [{ check: "surface", actions: ["repair"] }, { check: "answer", actions: ["research", "repair"] }], selection: { rule: "first_pass" } },
      { id: "software", description: "Require correctness then minimize measured execution time", kinds: ["software", "strategy"], requires: ["files", "program"],
        acceptance: { execution: "script", checks: [check("correctness", "product", "script")] },
        rejection: [{ check: "correctness", actions: ["repair", "recompute"] }], selection: { rule: "best_pass", metric: "elapsed_ms", direction: "min" } },
    ] }
}

export function decision(kind: Decision["kind"] = "report"): Decision {
  return { kind, profiles: [kind === "strategy" ? "software" : kind], needs: [],
    workers: kind === "report" ? [{ id: "sources", purpose: "Check direct support for each claim", resources: ["source"], actions: ["read", "verify_source"] }] : [],
    rationale: `Choose the ${kind} deliverable with its declared evidence requirements` }
}
