# Multi-Skill Consolidation — developer/test-agent handoff

Status: **opt-in implementation requiring full Bun/integration validation**. This is one normal `kind: "skill"` Task-Adaptation Campaign; it is *not* a post-learning legacy Phase 2 merge.

## Host setup

Install `consolidationProfile("merged_skill", "skill-write")` in a host-controlled `TaskCatalogue`. Its `entries` must be the single resource ID `merged_skill` backed by the editable candidate `DIRECT_CHAT.md`. The host capability must grant `read/edit`. `auto`, `manual_decision`, and `manual_plan` continue to select this Profile using their existing mechanisms.

Bind the selected executor with `id: "consolidation-direct-chat", version: "1"` and exactly these settings:

```json
{
  "candidateID": "merged_skill",
  "maxChars": 5000,
  "expectedCases": 50,
  "modelID": "chosen-model",
  "datasetPath": "/absolute/host-controlled/direct-chat-cases.jsonl",
  "datasetSHA256": "<frozen_sha256>",
  "modelsPath": "/absolute/host-controlled/direct-chat-models.json",
  "modelsSHA256": "<frozen_sha256>",
  "concurrency": 2
}
```

Bind **both** `consolidation_surface` and `consolidation_score` checks to `id: "consolidation-checker", version: "1"` with exactly these common settings:

```json
{
  "candidateID": "merged_skill",
  "maxChars": 5000,
  "expectedCases": 50,
  "modelID": "chosen-model",
  "datasetSHA256": "<frozen_sha256>"
}
```

For the task plan, choose `selection: { "rule": "best_pass", "metric": "pass_rate", "direction": "max" }`. The trusted Direct Chat dataset is **not a creator-readable resource**: its private oracle scripts and hidden expected answers remain in host-controlled files. The creator receives source Skill files and allowed public materials through ordinary Task-Adaptation resources. Optional `freezeSources(root, manifest, caseIDs)` validates source Skill IDs, paths, and SHA-256 before those resources are bound.

The host-owned dataset must use the repo's `direct-chat-case/v1` JSONL format, **unique safe case IDs**, complete materials, and private oracle scripts that **print structured JSON `{"passed": boolean}`**. An exit code alone is not an acceptable validator verdict for this task.

The accepted Skill has **exactly one** publication entry containing all text injected as the model's Skill, ≤5000 NFC-normalized Unicode non-whitespace codepoints. The evaluator creates `DIRECT_CHAT.md`, tests the full publication with **no** head-tail/core-files alternative, and disables baseline, candidate reuse, Direct Chat recovery and request retry. Every case is an independent one-turn prompt; the trust boundary performs deterministic grading.

`consolidation_surface` checks length before evaluation. `consolidation_score` verifies identity, uniqueness, single request attempts, per-case and aggregate counts, complete evidence, validator JSON, hashes and the top-level `pass_rate`. Only formally accepted versions enter the existing `best_pass` store.

## Commands for the second Agent

Run from the repository checkout (Bun and dependencies installed):

```bash
bun test ./auto-evolve/orchestrator/task-adaptation/consolidation/consolidation.test.ts
bun test ./auto-evolve/orchestrator/task-adaptation/consolidation/consolidation.integration.test.ts
bun test ./auto-evolve/orchestrator/task-adaptation
bun test ./auto-evolve/orchestrator/protocol-plugins
bun test ./auto-evolve/orchestrator/direct-chat
```

Focused test coverage included:

- 0/50, 43/50, 50/50 verified score math; duplicate/missing case, altered model/Skill/dataset hashes, mismatched aggregate, retry, input truncation, incomplete trace or infra-failure category rejected.
- Unicode 5000-character boundary, NFC, emoji, invalid UTF-8, BOM, source hash drift, out-of-root paths and symlink rejection.
- No-cost **real Direct Chat runner + mock provider + separate Bun validator processes** for 2 independent cases, with expected rate 1/2, original prompt material trace, preflight hashes, and forged-product rejection.

To complete integration acceptance (not yet claimed as run/passed), the second Agent should:

1. Run the checked-in tests, fix TypeScript/Bun/environment discrepancies, and report full command outputs. The current authoring environment has Node but **no Bun and no GitHub checkout**, so full suite status is **unverified**.
2. Exercise real `Runtime.run` + `prepareTaskRun` with a host-built Catalogue and the two required Protocol checks. Assert a 5001-char candidate is rejected **before any model call**; 5000 is accepted. Inspect each prompt to confirm no hidden oracle or answer.
3. Verify the existing `chooseTaskVersion`/Campaign path retains the second formally accepted round when pass rates are 38/50 → 43/50 → 41/50, including resumed Campaign and delivery; all checks must pass before selection.
4. Fault-inject one case's provider timeout, validator crash without JSON, missing materials, duplicate source/case IDs, forged score, changed frozen dataset, and incomplete 50-result output; each should fail closed, not become an ordinary answer failure.
5. Confirm `auto/manual_decision/manual_plan` and legacy `merge-as-old/merge-as-long-task/merge-as-opt` defaults, standalone Direct Chat CLI reports and non-Skill Task-Adaptation workflows do not regress.

## Explicit operational restrictions

- Do **not** run real paid-model consolidation yet. This Direct Chat backend uses model APIs **outside the existing OpenCode wire-budget reservation path**; a unified, durable global calls/token budget gate has **not** been verified for this backend. The host must wire it before declaring paid operation production-safe.
- Mock tests are not proof of live 50-case accuracy or real API costs. Provider-internal hidden retries also require transport-level verification.
- Original 50 cases are an optimization/training score, **not an independent generalization metric**; held-out final assessment should be separate and once-only.
- Strict runtime identity, source resources and approval must remain **host-owned**; no task author control over dataset, model paths, hidden answers or score scripts.
- Main plan is in PR #2: `auto-evolve/进度记录/2026-10-17-多Skill归纳优化任务改造计划.md`. This implementation PR is review/test-first.
