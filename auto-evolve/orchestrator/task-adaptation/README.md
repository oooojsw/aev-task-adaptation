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

Still required: verified runtime capability discovery and full protocol composition, broader runtime
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

## Task intake checkpoint (2026-10-16)

`catalogue.ts` compiles one interpretation decision into the shared `Plan` schema.
The host owns the resource list, edit targets, acceptance profiles, rejection
routes, selection metrics and finite budgets. The interpretation selects the
deliverable kind, profile combination, needed capabilities and task-specific
Workers; it cannot invent a test, weaken a check or grant private material access.
Combinations may add execution to a report requiring recomputation; conflicting
execution modes, metrics or duplicate check identities stop compilation.

`intake.ts` performs one interpretation invocation using the existing frozen
OpenCode driver. It passes absolute allowed file locations for on-demand reading,
keeps private scoring files out of the prompt and read grants, and permits only
the decision JSON to be edited. It stores source/backend/config fingerprints,
raw decision bytes, backend metadata, the compiled outcome and a completion
checkpoint. Matching completed intake reuses its result. Failed, incomplete or
changed intake is not automatically resent. An unavailable capability is a
persisted `missing_capabilities` outcome, not a silently weakened ready plan.

The callable entry point is `prepareTask(IntakeInput)`; the CLI is:

```text
bun run auto-evolve/scripts/prepare-task.ts --input <absolute-intake-config.json>
```

`IntakeInput` declares `cwd`, material `root`, independent evidence `dir`, the
host's `catalogue`, explicit `model` / `expectedModel`, `timeoutMs`,
`maxInputBytes` and `maxDecisionBytes`. `TaskCatalogue` contains the natural-language
`request`, resource inventory, deliverable entry IDs, capability descriptors,
acceptance profiles, stop limits and `maxWorkers`. See the TypeScript interfaces
for the exact schema. Catalogue files must contain no credentials; use the
existing private host configuration. The CLI prepares a plan only. It does not
start training, merge or deployment. Audit existing assets and actual capability
availability before any real invocation.

Availability flags are host declarations, not automatic infrastructure probes.
The generated plan still needs matching real protocol bindings and tool adapters;
`ready` here means plan compilation, not that every requested runtime exists.
The same-controller integration test supplies a fixed interpretation and runs
Planner, Executor, dynamic Workers, rejection, revision and formal reacceptance
through the existing Campaign. It does not prove semantic task understanding by
a real model or the quality of an actual research report.

Current full regression: 323 passed, 0 failed, 6510 assertions across 52 files.
Log: `E:/project/AEV-task-adaptation-20261016/validation-task-intake-20261016.log`.
SHA-256: `e8cc36136d2c022d685b702a03764c79e1f9b72d41e99a3c298017d4be77a0e2`.
CLI help was checked without invoking any model. Full TypeScript typechecking,
three real tasks and the remainder of the objective are still pending.
