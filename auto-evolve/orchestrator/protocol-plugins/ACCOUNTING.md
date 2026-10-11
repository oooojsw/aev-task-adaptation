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

Complete earlier development checkpoints without an accounting field remain
read-only and eligible for existing identity-checked reuse. No historical tokens
are retroactively invented, and no scoring/execution is rerun to fill missing
accounting. New checkpoints with a declared accounting hash require that file;
missing or modified accounting blocks reuse.

Raw reply/verdict evidence remains unchanged. A failure during accounting or
checkpoint persistence preserves receipt and interrupted failure evidence, and
does not silently resend potentially charged work.
