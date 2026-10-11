# Explicit pipeline runtime configuration

## Explicit source replay depth (2026-10-11)

ProjectBatchConfig optionally accepts replayStages. Absence preserves the existing
opt-in batch defaults; explicit stages must include initial_replay, contain only
initial_replay/repair_promote/final_full_replay/strict_acceptance_gate, and include
repair_promote when repairAttempts is positive. A complete strict replay selection:

```json
"replayStages": ["initial_replay", "repair_promote", "final_full_replay", "strict_acceptance_gate"]
```

Repair author receives the selected runtime/backend, not a silently recreated
default backend. Offline batch integration now covers rejection, append-only
repair, full replay, held-out test, completed-run reuse, scorer fault blocking,
and held-out rejection without author work. Learning/model boundaries still use
fixed fixtures; real Campaign lifecycle and mid-repair crash recovery are pending.

Development-only integration; complete source/merge/replay/test acceptance is not
yet certified. No live model call is implied by this document.

The multi-instance CLI and benchmark accept `--protocol-run-config <absolute-json>`.
Project inputs and acceptance phases remain in the frozen source spec's
`protocolPlugins` entry; this file selects merge and optional repair authors only.
It does not replace the selected executor or judge.

```json
{
  "schema": "aev.protocol-pipeline.v1",
  "mergeAuthor": {
    "model": "your-provider/your-model",
    "expectedModel": "your-provider/actual-model",
    "timeoutMs": 600000,
    "maxInputBytes": 1000000
  },
  "repairAuthor": {
    "model": "your-provider/your-model",
    "expectedModel": "your-provider/actual-model",
    "timeoutMs": 600000,
    "maxInputBytes": 1000000,
    "mode": "append_only"
  }
}
```

Models above are placeholders, not verified model identities. Do not embed secrets.
If repairAuthor is absent, explicitly use `--repair-attempts 0`. Author timeout and
maxInputBytes are invocation limits, not output Skill length or total run token caps.
Existing round/concurrency/stage controls remain separate.

The configuration freezes before new training. Removing or changing it on recovery,
an incomplete claim, or an orphan snapshot blocks rather than rebuilding defaults.
No option means legacy behavior for legacy runs; a frozen protocol source cannot
silently use legacy merging. Benchmark currently supports this branch only with
the flat scripted merge adapter; other adapters reject before training rather than
changing the selected strategy. Supporting their protocol boundaries remains work.

Successful source harvesting binds actual final acceptance, copied declared entries
and receipt fingerprints. Merger author reads staged Skill entries, not private
answers or whole campaign roots. Source-only verification remains a Skill-check
claim; it is not promoted into a task-execution claim.

Completed merge recovery verifies author evidence, output and protocol verdict.
Interrupted author calls require inspection and are never automatically resent.

## Generic project preparation (development only)

`prepare-protocol-project --manifest <absolute-manifest> --selection <absolute-selection>
--out <new-directory> --training-goal-file <goal-file>` prepares task specs without
model execution. Train/test roles come from the frozen project; validation IDs are
recorded as excluded, never silently reassigned. Task directories use numeric slots
so arbitrary project IDs cannot become path traversal. Training specs contain public
materials only; private scorer bindings remain in the project manifest. Existing
destinations block, including partial preparation; no overwrite or automatic resume.
This command prepares specs, not a full batch learning pipeline. Generic Campaign
dispatch and whole-pipeline acceptance are still pending.

The coordinator now has a `protocol_project` engine bridge to the existing
graph-iterative Campaign runner. Launch configuration is frozen; recorded Campaign
identity is resumed, not replaced, and incomplete launches require inspection.
Live attachments remain running. Generic instance IDs use hash-based storage slots
without changing legacy directories. This bridge is boundary-fixture tested only;
the generic batch CLI and actual complete fanout/harvest pipeline are not yet verified.

## Generic batch entry (development milestone)

`run-protocol-project --config <batch-config.json> --out <absolute-run-root>`
connects prepared tasks to learning, merge, optional source replay/repair and test.
Use the same config and output directory to continue; never create a replacement
run to bypass an incomplete claim. Configuration:

```json
{
  "schema": "aev.project-batch.v1",
  "tasksPath": "E:/example/prepared/project-tasks.json",
  "rounds": 4,
  "fanoutLimit": 1,
  "requireAllSources": true,
  "sourceReplay": true,
  "replayMustPass": true,
  "repairAttempts": 0,
  "finalTest": true,
  "pipeline": {
    "schema": "aev.protocol-pipeline.v1",
    "mergeAuthor": {
      "model": "provider/model",
      "expectedModel": "provider/model",
      "timeoutMs": 600000,
      "maxInputBytes": 200000
    }
  }
}
```

No inline secrets. Model values are placeholders. The training Campaign retains
the existing training-side host configuration; this entry does not yet provide a
complete per-role model/budget configuration. Merge currently uses the declared
entry merge adapter, not all legacy merge strategies. Repair currently requires
an explicit append-only author. Unsupported settings block rather than substitute.
`requireAllSources` gates training-source admission; `replayMustPass` separately
gates replay before deployment. Tests never receive a repair author.

Batch invocation has an exclusive claim. Normal exit releases only its own nonce;
crash remnants require owner/evidence inspection, never blind deletion or PID-only
takeover. Source specs, inventory, protocol, config and final candidate are checked
on recovery. A completed batch adds no model calls. Offline integration exercises
actual harvest/merge/replay/test with fixed learner/author replies. Real Campaign
interior, NBA equivalence, resource ledger, other merge adapters and deployment
acceptance remain pending; this milestone is not full project acceptance.

## Opt-in training roles and work budgets

`prepare-protocol-project` additionally accepts `--training-config <file>`.
Schema `aev.protocol-training.v1`: `roles` explicitly includes planner, executor,
worker, lead, reviewer and diagnostician, each with `model` and finite `timeoutMs`;
optional `agent`/`variant` use the existing model resolver. `budgets` includes all
six existing LongTask work-count limits. These are not total-token/output budgets.
Campaign freezes selection and host/config/private-profile fingerprint, checking
them before requests. Inner specs retain the binding. Adding config to an existing
unconfigured Campaign, removing frozen config or changing model/budget/host blocks.
Absent config retains old selection and no additional runtimeBudget request field.
Source tasks alone carry training config; test execution uses its own protocol.
Timeout uses the original OpenCode watchdog. Actual complete Campaign, owned-process
cancellation and resource accounting remain pending. Offline role-builder tests
replace host/config/artifact boundaries and do not prove real model invocation.
