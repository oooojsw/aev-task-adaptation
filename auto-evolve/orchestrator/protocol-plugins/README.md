# Opt-in project and acceptance protocol plugins

Status: foundation under development, not installed in the production host.

The existing AEV entrypoints and legacy behaviour are unchanged. These modules
are developed in an isolated Git worktree from a verified current-source backup.
This directory does not replace the existing acceptance framework or Blank Eval.

## Implemented

- Explicit project, protocol, run-format and plugin identities.
- Independent executor/checker registration with declared capabilities.
- Strict compatibility checks; no implicit OpenCode fallback.
- Required-check coverage and skill-only versus task-execution claims.
- Canonical, immutable protocol snapshots with implementation fingerprints.
- Exclusive snapshot creation and drift-checked resume.
- An adapter-facing phase runner with explicit file bindings, actual byte hashes,
  selected private inputs for checkers, separate failure categories, and independent
  pre-execution checks, execution and post-execution scoring.
- Offline unit and failure-injection tests; no model or provider requests.

Private-input separation here is the handler input contract, NOT a claim of
OS-level sandbox isolation. A real tool backend must implement and verify its
own environment and permissions. The runner fingerprints actual input bytes;
plugins receive copies so their mutations do not change subsequent scoring inputs.

## Still required for the full objective

- Concrete project adapter, including NBA, task/split manifest and official scorer.
- Real execution and script/judge backend adapters with budget validation,
  transport controls, persistent raw receipts and resource ledger integration.
- Execution-reply versus scoring-receipt caching and interrupted-call recovery.
- Explicit opt-in routing in campaign, merge, replay and frozen-test entrypoints.
- Training feedback/diagnosis integration and candidate-content change evidence.
- Legacy fixed-receipt regression and complete integration/robustness tests.
- Bounded real-backend verification after asset reuse and request-scope audit.
- Verified deployment and clean-mainline synchronization, with a rollback guide.

Snapshots freeze data and declared implementation identity. Plugin adapter code
must compute an implementation hash from its actual code/dependencies; manually
invented version labels are not sufficient. The test plugins use synthetic hashes
because they are fixtures, not live execution plugins.

## Test

```powershell
bun test ./auto-evolve/orchestrator/protocol-plugins/
```

The current tests exercise this foundation, not the whole AEV system. They do not
prove legacy compatibility at execution level, model performance, or NBA end-to-end
readiness. Test evidence is stored outside the repository and must not be committed.
