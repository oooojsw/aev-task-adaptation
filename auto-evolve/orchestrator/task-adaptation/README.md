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

Still required: natural-language intake and capability composition, broader runtime
memory visibility windows, active source-checking tools, isolated program
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

Historical first checkpoint result: 48 passed, 2 failed, 4554 assertions across 6 files. Both failures were
adapted-report rejection/repair scenarios (one and two rejected candidates).
The zero-rejection adapted scenarios and existing legacy scenarios pass in this
suite. This is an unfinished development checkpoint, not a release, a full
compatibility certification, or evidence of real-model task success. No new paid
model requests were made. Keep this branch separate from the production workflow.

## Feedback and advice checkpoint (2026-10-16)

The missing runtime authorization handoff in `boundWindow` is fixed. Explicit
`runtime` entries can select `feedback`, `analysis`, and `review`; absent entries
grant nothing. The independent executor cannot receive these training-side views.

`feedback.ts` binds the task, phase, frozen protocol, candidate identities and
original verdict. Checker text requires both plan and protocol permission. Ordinary
rejections carry declared actions; platform faults do not become content repairs.

`advice.ts` publishes bounded views of normalized Worker/Reviewer suggestions.
It checks the source round/path and declared Worker identity, drops arbitrary refs
and raw-response paths, and records source and published-view fingerprints. Lead
receives only explicitly allowed exact files, on demand, not a directory grant or
an inline dump. Advice never establishes acceptance. Later rounds read normalized
Reviewer advice rather than the original backend response.

Current regression command:

```text
bun test ./auto-evolve/orchestrator/task-adaptation ./auto-evolve/orchestrator/protocol-plugins
```

Result: 307 passed, 0 failed, 6300 assertions across 50 files (Bun 1.3.14).
The isolated worktree reuses the already installed `remeda@2.26.0` through a local
ignored dependency junction; no production dependency or configuration was changed.
Log: `E:/project/AEV-task-adaptation-20261016/validation-feedback-advice-20261016.log`.
SHA-256: `ffb6e64905a394c479fe8b43ad91094583a8828a960cba99e3b7637ae7c12bdd`.
This is offline controller/compatibility evidence, not a TypeScript typecheck,
real-model success, full objective completion, or production deployment.
