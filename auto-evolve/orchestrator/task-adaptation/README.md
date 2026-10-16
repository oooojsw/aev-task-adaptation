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

## Script execution and program Campaign checkpoint (2026-10-16)

`protocol-plugins/script-executor.ts` adds the optional `script-json-executor@1`.
A selected protocol enables it explicitly; legacy builtin registration does not
gain an executor, and script-only selection does not load an OpenCode backend.
`selectedRuntime` checks the real interpreter and runner fingerprints before
returning a runtime. Cached execution repeats dependency and input-budget checks.

Settings require absolute `command` / `script`, their SHA-256 fingerprints,
`timeoutMs`, `maxInputBytes`, `maxOutputBytes`, and the explicit
`executionBoundary: "trusted_host_runner"`. The runner must be self-contained:
the executor copies verified runner bytes into each independent evidence working
directory before launching that frozen copy with the input JSON path. It uses no
shell and does not inherit model credential environment variables. Only declared
candidate and public material bytes are staged; private grading inputs remain
with the checker. Original IDs, kinds, hashes and byte lengths are preserved.

The runner returns one JSON object on stdout. This is a product, not a verdict.
The existing protocol runtime still requires a separate product check; it cannot
accept a runner's self-reported success as formal acceptance. Raw stdout, stderr,
process exit/failure, wall time, dependency identities and product bytes are saved.
Input overflow blocks before process launch; timeout, output overflow, process
failure and malformed products do not become ordinary correctness rejection.
Execution caching reuses an existing measurement, not a new benchmark repetition.

This backend is for trusted host runners and trusted local test candidates.
A temporary directory and reduced environment are **not** an OS sandbox: they
do not enforce host filesystem, network, memory or descendant-process privileges.
Do not advertise this backend as safe arbitrary untrusted-code execution. An
actual isolation backend and its environment preflight remain required wherever
the selected task requires that security boundary.

Offline integration now passes a software task through `prepareTask`, the actual
Planner/Executor/Workers/Lead/Reviewer Campaign chain, real Python execution,
independent correctness checking, rejection feedback, repair and reacceptance.
It verifies actual wrong and corrected outputs, timing presence, withheld private
inputs, completed-run reuse, and rejection of altered saved product evidence.
The interpretation and author model boundaries are fixed test replies, not real
semantic task understanding. The measured timing is present in the product, but
best-metric version selection, global budgets, real research source checking and
the three real tasks are not thereby implemented or verified.

Final offline regression for this checkpoint: 332 passed, 0 failed, 6693
assertions across 53 files in 55.22 seconds, exit 0 (Bun 1.3.14).
Log: `E:/project/AEV-task-adaptation-20261016/validation-program-intake-final-20261016.log`.
SHA-256: `3dcc20e36414308c38dc4016ee372c57f0631086a3d5e707e58749be62e4c0e2`.
This is not a full TypeScript typecheck, production deployment, or real-model
experiment. Earlier checkpoints and their logs remain historical evidence.

## Qualified version selection checkpoint (2026-10-16)

`selection.ts` snapshots declared candidate files only after formal acceptance.
Each version binds the task plan, exact acceptance receipt, source feedback,
round, actual file bytes and hashes. `best_pass` reads a finite numeric top-level
metric from the hash-verified executed JSON product; the host must select product
checks that validate that metric. This does not establish benchmark quality or
trust an author's unexecuted metric claim. `first_pass` keeps its first qualified
version. Ties retain the earlier version.

Both initial and resumed Campaign loops use this selection. Best-pass tasks
continue beyond the first pass and stop at the tighter task/Campaign round
budget or the declared rounds-without-improvement limit. Exploration may keep a
slower current candidate; the qualified snapshot is separate. Result/state fields
`selectedTaskVersionPath` and `taskStopReason` identify the delivery manifest and
stop reason. Consumers of this new task path must read the manifest's file map,
not assume the exploratory current package is the selected delivery. Old specs
without task adaptation retain their original decisions and result fields.

Resume revalidates every saved qualified version, original receipt/product and
snapshot bytes, and requires the saved final selection to match. Incomplete
snapshot directories block recovery for inspection; they are not overwritten.
The integration fixture actually measures a fast and deliberately slower correct
program, retains the former and stops for stagnation. Its model replies are
fixed offline boundaries. It is not a real-model optimization experiment.

This checkpoint does not yet enforce the plan's global model-call/token budgets,
provide a generic performance metric extractor beyond numeric JSON properties,
or implement arbitrary task-plan revision and best-version reuse across changed
acceptance standards. These remain part of the full objective.

## Active source-checking backend checkpoint (2026-10-16)

`active-tool-judge@1` is an opt-in formal checker using the existing frozen tool
driver. Its own fresh workspace grants read access to the actual candidate,
declared materials and selected private criteria; only its verdict workspace is
editable and Shell remains disabled. Criteria go directly to the checker, never
through an author role. Source and criterion IDs have distinct namespaces.
The checker can read the full permitted files on demand rather than receiving
their text inline. It returns a JSON verdict with actionable reasons and exact
evidence quotes; unknown source IDs, invented quotes or missing evidence cannot
pass. Quotes are checked against provided bytes, not judged automatically for
semantic relevance. The model's reasoning and research quality still need real
task validation. This backend does not grant web search or arbitrary execution.

`active_judge` in a task plan must bind to this specific real checker, not silently
fall back to a passive model judge. The selected runtime loads the tool host even
when there is no independent executor and the phase only checks content. Actual
protocol tests distinguish that formal checking call from task execution.
Read/edit grants are application-level controls, not an OS sandbox guarantee.
Private quote evidence stays in checker artifacts; author-facing feedback still
uses the existing explicit status/message disclosure rules.

Full offline regression: 342 passed, 0 failed, 6944 assertions across 55 files,
61.16 seconds, exit 0 (Bun 1.3.14). Log:
`E:/project/AEV-task-adaptation-20261016/validation-active-checker-final-20261016.log`.
SHA-256: `41509de8ee4ae4e646b778fdbd23fb2007f54f927149070676502dcc58f6867e`.
The active backend boundary is fixed in these tests; no real research task,
real model call, full typecheck or production deployment is claimed.

## Actual checker and execution input scopes (2026-10-16)

Protocol checks may select `skillInputs` and `materialInputs` independently of
their existing `privateInputs`. An execution phase may declare `executionInputs`
with candidate and material IDs. Omitted selectors preserve the historical
all-public-input behavior; explicit empty material lists send no materials.
Missing IDs block before any checker or executor invocation. Selectors are part
of the frozen protocol identity and actual checker input fingerprints.

Adapted Campaigns compare these actual scopes with the task plan before any
author work: candidate IDs, checker source/criterion IDs, physical source files,
feedback disclosure, independent execution window and backend must agree.
Matching a filename or resource ID alone is insufficient. The task catalogue
generates an independent input window for script execution as well as Agent
execution. Neither receives private grading inputs. Legacy configurations
without task adaptation retain their previous selection behavior.

This is input-routing validation, not an OS security sandbox. Global request
budgets, complete executable configuration generation and the three real task
acceptance runs remain separate unfinished requirements.

## Executable configuration preparation (2026-10-16)

`prepare-task-run.ts` connects the existing one-time task interpretation to
`prepare-execution.ts`. Host-owned bindings still choose the actual checker,
executor, formats, explicit role models and work budgets; the interpreting model
cannot invent these. Missing required bindings return `missing_bindings` rather
than weakening the selected acceptance rules.

Preparation copies the frozen candidate seed and permitted resources into a new
input bundle, generates the project manifest, scoped protocol, plan and ordinary
Long Task spec, and verifies their agreement. Source materials are not edited.
It freezes complete output coverage, hashes, source identity and plugin identity;
unchanged preparation reuses outputs, while incomplete or modified evidence
blocks recovery rather than regenerating over it. Only the configured
interpretation stage may call a model; preparation itself never calls a checker,
executor or Campaign. The previous plan-only CLI remains available unchanged.

```
bun run auto-evolve/scripts/prepare-task-run.ts --input <absolute-config.json>
```

The config contains `intake` (the existing intake config) and `execution` (the
explicit `ExecutionPreparation` fields other than root, plan and capabilities,
which come from the frozen intake). The command returns an ordinary `specPath`;
it does not launch training. `ready` means structurally prepared, not a claim
that an actual model/task has passed or that global request budgets are enforced.
Host availability, safe execution, dependency checks and the final same-controller
real task runs remain necessary. Offline tests pass the generated Skill/report/
software specs through the real spec loader, protocol entry preparation and task
binding, without API requests.
