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
- Persistent execution/scoring caches with separate identities, byte-based input
  hashes, exclusive claims, and no automatic resend after incomplete attempts.
- Generic one-turn HTTP text backend for two explicit transport dialects, actual
  model/finish checks, separate input/output budgets and persistent raw evidence.
- Generic JSON-script checker with interpreter/script fingerprints, bounded
  captured subprocess execution, minimal environment and explicit input staging.
- NBA's existing local last-answer scoring rule as a separate project script,
  tested through a real local Python subprocess using synthetic answers/labels.

Private-input separation here is the handler input contract, NOT a claim of
OS-level sandbox isolation. A real tool backend must implement and verify its
own environment and permissions. The runner fingerprints actual input bytes;
plugins receive copies so their mutations do not change subsequent scoring inputs.

## Still required for the full objective

- Actual NBA dataset preparation and upstream scorer equivalence verification.
  The explicit project-pack loader and NBA public-prompt/private-label converter
  now exist, tested with synthetic datasets; this is not a completed live campaign.
- OpenCode tool-execution adapter and independent model-judge adapter.
- Real-provider verification, unified resource ledger integration and explicit
  audited recovery authorization for incomplete calls.
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
cd auto-evolve/orchestrator/protocol-plugins
bun test . ../../projects/nba/pack.test.ts
```

The current tests exercise this foundation, not the whole AEV system. They do not
prove legacy compatibility at execution level, model performance, or NBA end-to-end
readiness. Test evidence is stored outside the repository and must not be committed.
