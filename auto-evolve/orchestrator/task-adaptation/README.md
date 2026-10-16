# Task-driven adaptation (in development)

This opt-in extension uses the existing Long Task Campaign and Long Task Runner.
It does not replace the legacy Skill workflow or introduce a parallel demo controller.
Do not deploy this development branch as a completed general-purpose system yet.

## Implemented boundary

- `plan.ts`: strict task definition, role/stage windows, selected analysis workers,
  candidate/product checks, rejection actions, selection and stop declarations.
- `binding.ts`: filesystem binding, material hashes, independent snapshot claims,
  source drift rejection and candidate-preserving resume.
- `invocation.ts`: rebuilds actual model requests and grants from the frozen window;
  old prompts, attachments and inherited broad grants are not forwarded.
- `context.ts`: opt-in spec configuration, protocol/plan consistency checks,
  candidate initialization and actual controller role invocation construction.
- Campaign and unit runners now pass this context to the shared training boundary.
  Worker identities come from the plan. Lead writes the current candidate snapshot,
  not the initial seed. Old specs do not activate these branches.

The spec's `taskAdaptation` object has schema `aev.task-adaptation.v1`, absolute
`planPath` and `root`, available `capabilities`, and exact `entries: [{id,path}]`
matching the selected project pack. All resource paths inside the plan are relative
files under `root`; candidate entries map to the controller's current candidate root.

## Information and permissions

Each role gets only its objective, output contract and allowed resource catalog.
File contents are read on demand unless explicitly selected for bounded inline use.
Private scoring resources are checker-only; training resources do not enter the
independent executor. A window is not an OS sandbox claim: enforcement uses the
existing host's exact-file permission rules, with shell disabled and inherited
attachments removed. Search/execution actions currently stop with a missing-adapter
error rather than silently enabling an unrestricted shell.

The invocation ledger stores the exact role window and relocated candidate hashes.
Candidate relocations cannot alter private resources or omit declared deliverables.
Restoring a task validates the plan, source files and protocol entry mapping.

## Verification and remaining work

Offline tests cover the plan, bindings, invocation handoff and the real Campaign
with fixed model replies. The report fixture verifies dispatch and candidate
acceptance mechanically; it is not evidence of research quality or real-model success.
Existing Campaign tests exercise legacy learning, rejection/repair, merge, replay,
held-out evaluation and recovery.

Still required: natural-language intake and capability composition, runtime feedback
and memory visibility windows, active source-checking tools, isolated program
execution and metrics, best-version and global stop enforcement, protocol-aware
batch/merge propagation, full compatibility comparison, and three small real tasks.
Declarations in `Plan` do not by themselves prove those runtime capabilities exist.

External authoritative progress: `E:/project/AEV-task-adaptation-20261016/PROGRESS.md`.

## Development checkpoint (2026-10-16)

Runtime feedback routing is partially implemented in `feedback.ts` and controller
invocations. It is not ready for deployment. The current offline regression command
is:

```text
bun test ./auto-evolve/orchestrator/task-adaptation ./auto-evolve/orchestrator/protocol-plugins/training-invocation.test.ts ./auto-evolve/orchestrator/protocol-plugins/host-permissions.test.ts ./auto-evolve/orchestrator/protocol-plugins/campaign-lifecycle.test.ts
```

Result: 48 passed, 2 failed, 4554 assertions across 6 files. Both failures are
adapted-report rejection/repair scenarios (one and two rejected candidates).
The zero-rejection adapted scenarios and existing legacy scenarios pass in this
suite. This is an unfinished development checkpoint, not a release, a full
compatibility certification, or evidence of real-model task success. No new paid
model requests were made. Keep this branch separate from the production workflow.
