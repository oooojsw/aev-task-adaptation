# 2026-04-14 Long-Task Shared Context Redesign

## Goal

Redesign long-task shared memory so that:

- unit-local observations stay local unless promoted
- a run-global operational context is visible to every later unit by default
- the formal expert package can be updated earlier and treated as a live shared surface
- campaign carryover becomes promoted cross-run memory plus a next-round seed, not just raw aggregate logs
- acceptance remains judge-only and never rewrites experience content

## Current Problems

1. Successful local lessons are recorded but often never propagated because retry bundles heavily filter learning units.
2. Completion validation currently runs with an almost empty retry bundle, so the final gate cannot see the run's accumulated operational context.
3. Campaign carryover is mostly append-only raw aggregates, which means the next round gets logs rather than a promoted operational memory.
4. Formal expert package authoring happens too late, so many nodes do not benefit from already stabilized knowledge inside the same run.

## Target Design

### 1. Unit-Local Working Context

- Keep scratch units, local failures, local reflections, and local learning units.
- Do not auto-broadcast raw local notes to the whole run.

### 2. Run-Global Operational Context

- Introduce a dedicated operational-context record type and storage.
- Promote stable facts, validated methods, blockers, failed paths, tool entrypoints, and package gaps into this shared layer.
- Include this layer in every retry bundle by default.
- Include this layer in completion validation bundles as well.

### 3. Formal Expert Package As Live Shared Surface

- Treat the expert workspace as a live shared surface instead of a final-only artifact.
- Surface formal package roots explicitly in execution prompts so later units know what to read and update.

### 4. Campaign Evolution Memory

- Keep raw round harvest for traceability.
- Add promoted campaign operational memory derived from round harvest and run-global context.
- Generate a next-round seed context from promoted cross-run memory.
- Feed promoted campaign memory and seed context into the next generated round spec.

## Implementation Steps

1. Extend long-task contracts with:
   - run-global operational context records
   - formal package root references
   - retry bundle support for operational context
2. Extend long-task repository with:
   - operational context files
   - read/write/append/promote helpers
   - retry bundle construction that always includes run-global context
3. Extend long-task runner with:
   - automatic promotion after each unit execution
   - completion bundles that include shared operational context
4. Extend long-task prompts so every execution unit sees:
   - formal package roots
   - run-global operational context
5. Extend campaign contracts and repository with:
   - promoted campaign operational memory
   - next-round seed context
6. Extend campaign runner so every round:
   - harvests raw results
   - promotes cross-run operational memory
   - writes the next-round seed context
   - feeds promoted memory into the next generated spec
7. Add a smoke test that proves a local lesson becomes visible as run-global context in a later retry bundle.

## Verification

- `bun run auto-evolve/cli.ts validate`
- smoke test for long-task shared context propagation
- one short-task execution sanity check
- one long-task/campaign execution using the existing try4 task pack
- if long-task exceeds foreground timeout, switch to half-hour monitoring and automatic restart policy
