# Acceptance attempt accounting

New runEntry attempts save protocol.accounting.json before the completed
checkpoint. The checkpoint binds its hash and actual receipt. Recovery checks
both original receipt and recalculated accounting content before reuse; it does
not replace timing or usage with a second execution.

Each executor/checker invocation records reported input/output tokens separately
from newly consumed tokens. Cached execution and cached scoring retain original
reported usage with new usage zero. Missing/negative/noninteger token reports are
unreported (null), not zero. Totals expose knownTokens and unreportedInvocations;
known totals are partial when any invocation is unreported. Prices are not
guessed; fee=null and feeStatus=unpriced until a separate price schedule exists.

Elapsed time covers runtime execution/scoring plus receipt persistence before
accounting is written. Adapter invocations are not underlying HTTP request counts
or tool turns. This ledger covers acceptance adapters only: training roles,
merge authors, repair authors and backend failures before a receipt need their
own ledgers. It is not a full-run cost or token-budget enforcement report.

## Opt-in Campaign training records

New protocol Campaigns wrap planner, executor and Campaign suggestion calls with
runProtocolTrainingTask. Each invocation gets a unique protocol-invocations
directory, started claim/metadata, immutable-location raw task result and atomic
accounting.json. Same-stage legitimate diagnostic/revision calls get separate
records; this recorder does not decide retries or bypass controller recovery.
Legacy disabled branch calls the original backend without creating these files.
Backend throw records sanitized error category, elapsed time and unknown tokens.
Reported step tokens and actual model resolution use the same backend parser as
the independent driver. Missing synthetic/live usage is null, not zero. Session
incomplete reports describe observed steps, not guaranteed full charged usage.
Campaign lifecycle fixtures check ledger count equals actual training boundary
calls. This is per-invocation evidence, not yet a consolidated full-run ledger or
aggregate token-limit enforcement. Existing historical calls are not backfilled.

## Read-only consolidated resource view

summarizeResources scans a declared canonical root, refuses linked directories
and malformed invocation ledgers, and inventories original byte hashes. Only
physical training/backend invocation records are added; protocol.accounting.json
is listed but excluded because its execution/judge usage overlaps these records.
Verified completed cache wrappers are listed separately, not counted as calls.
Unclassified started claims remain visible and make completeness false; they may
be wrapper claims and must not be reported as proven additional API requests.
Identical request fingerprints in distinct invocation directories still count
separately: repeated real calls can have the same prompt. Missing tokens stay
unknown and overflow blocks totals. Fee stays null. Per-call elapsed time is not
summed as wall time. Scope remains discovered instrumented calls only, not all
legacy calls, every optional extension or exhaustive billing reconciliation.

From the worktree root:

```powershell
bun auto-evolve/scripts/report-protocol-resources.ts --root E:/absolute/run-root
```

The command prints a read-only JSON report and never resumes work or sends calls.

HTTP executor and independent HTTP judge now preserve per-invocation time/model
and usage, including reported usage on malformed/incomplete successful responses.
Fault/no-response usage stays unknown. Started-but-unaccounted records are not
silently repaired or resent to fill missing evidence.

Complete earlier development checkpoints without an accounting field remain
read-only and eligible for existing identity-checked reuse. No historical tokens
are retroactively invented, and no scoring/execution is rerun to fill missing
accounting. New checkpoints with a declared accounting hash require that file;
missing or modified accounting blocks reuse.

Raw reply/verdict evidence remains unchanged. A failure during accounting or
checkpoint persistence preserves receipt and interrupted failure evidence, and
does not silently resend potentially charged work.

## OpenCode backend invocation records

The opt-in driver writes invocation.accounting.json for success, incomplete
return and caught failure. It binds persisted task-result.json bytes, request
and host identity, model, timestamps and elapsed duration. Raw observed step
input/output, reasoning/cache tokens and native cost remain separate; currency
is unknown and fee=null. Totals propagate into acceptance accounting only when
every observed step reports that component. Missing/invalid/overflow stays unknown.
Incomplete status cannot prove a provider reported every step. Merge/repair driver
evidence retains this record too. This is not consolidated Campaign/full-run
accounting. Earlier development evidence is not rewritten.
