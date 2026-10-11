# Explicit interrupted batch lease recovery

An interrupted batch supervisor may leave project-batch.invocation.claim.
Inspect that file and its nonce first. Do not delete it or kill a PID based on
its number alone. The optional recovery command only archives a stopped owner's
lease and evidence; it never starts learning, scoring, backend retries or cleanup.

```powershell
bun run auto-evolve/cli.ts recover-protocol-batch-lease --out "E:/project/example-run" --expected-nonce "nonce-from-inspected-lease"
```

New leases record current owner creation tick when available. Recovery requires
process-identity proof of dead owner or an observed creation tick different from
the recorded one (PID reuse). Live, unknown and weak-hint mismatch owners block.
Old leases lacking creation tick can recover only when owner is dead; live PID
with insufficient identity does not justify unlocking. Process liveness uses the
existing shared identity module, not a naked PID check in the scheduler.

Before archive, recovery checks the nonce, rechecks owner and exact lease content,
and verifies root/evidence paths are not redirected by links. inspection.json,
original-lease.json and completed.json preserve the operation. No original run
results are edited. Then invoke the original run-protocol-project with the exact
original --config and --out to resume completed stages.

This does not authorize resend of an incomplete author/executor/checker request.
If that stage lacks complete evidence, normal stage guards still block. A complete
model reply without its adapter checkpoint requires separate backend-specific
inspection; unlocking the supervisor is not proof that replaying it is free.
Missing/changed protocol, project, input or model configuration remains a blocker.

The command is explicit and never invoked by ordinary health checks. It does not
terminate any process or remove locks for legacy runs. Tests use synthetic leases,
fixed identity replies, and actual CLI checks against dead and live local owners;
no remote model requests occur.
