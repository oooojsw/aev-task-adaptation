<!-- auto-evolve-note: implementation-plan -->
# 2026-04-13 try4 Campaign Learning Implementation

## Goal

Build a generic long-task campaign layer outside the execution kernel so that:

- one long-task experiment can run across many rounds instead of stopping at a single exhausted run
- every round leaves behind reusable learning, even if the round fails
- deployment can read the learned expert workspace, including summarized failed paths
- the current real task (`try4-expert-bootstrap`) can run with a hard round cap of 100

## Non-Goals

- Do not push task-specific Word or Excel logic into platform core
- Do not rewrite the long-task execution kernel into a task-specific runner
- Do not require platform-core validators to know reference data beyond what task packs already provide

## Architecture Decision

Add a `long-task campaign` layer above `run-long-task`.

Responsibilities:

- prepare round specs
- seed each round with prior expert workspace snapshots and prior evidence
- harvest failure packets, retry lessons, learning units, and final deployment evidence
- synthesize a campaign-level learning summary
- mirror key failure-path lessons back into the tracked expert workspace so deployment can read them
- stop on `verified_success` or at `maxRounds`

Keep responsibilities out of the execution kernel:

- work-unit solve logic remains in `orchestrator/long-task`
- deployment harness remains in `acceptance-framework`
- campaign only manages cross-run continuity

## New Concepts

### Campaign

A run-of-runs controller for one long-task family.

Fields:

- campaign id
- title
- family
- mode
- max rounds
- current round
- status
- base spec path
- round history

### Round Learning Bundle

Per round harvested evidence:

- summary
- failure packets
- retry lessons
- learning units
- selected deployment failure evidence
- expert workspace snapshot

### Campaign Failure Lessons

A cumulative Markdown summary intended for both:

- next-round learning input
- final deployment-visible expert experience

This summary must capture:

- repeated failure paths
- resolved failure paths
- still-unresolved failure paths
- the exact corrective rules that emerged from those failures

## Generic Files To Add

### Runtime state

- `auto-evolve/runtime-state/long-task-campaigns/<campaign-id>/campaign.json`
- `auto-evolve/runtime-state/long-task-campaigns/<campaign-id>/rounds/<round-id>/...`
- `auto-evolve/runtime-state/long-task-campaigns/<campaign-id>/history.jsonl`

### Task-pack side surfaces

- `expert-workspace/lessons/failure_lessons.md`
- `workspace/campaign-learning/round-<n>-summary.md`
- `workspace/campaign-learning/aggregated-failure-packets.jsonl`
- `workspace/campaign-learning/aggregated-retry-lessons.jsonl`

## Learning Guarantees

Every round must leave at least one durable learning artifact, regardless of pass/fail.

Required per round:

- round summary markdown
- round harvested evidence directory
- campaign history record

If the round changes the expert workspace, campaign must also refresh:

- `expert-workspace/change_log.md`
- `expert-workspace/lessons/failure_lessons.md`

## Deployment Visibility Requirement

Blank-agent deployment must only read formal expert workspace plus formal capabilities and task materials.

Therefore:

- campaign summaries that matter to deployment must be mirrored into tracked expert workspace
- runtime-state only stores raw evidence, not deployment dependencies

## Initial Mode Set

System alignment for now:

- short task
- long task with graph
- single-session iterative line
- graph-based iterative long-task campaign

This implementation only needs to fully execute the fourth item for `try4`, but it should be modeled generically enough to support the other long forms later.

## Implementation Steps

1. Add campaign contract and repository
2. Add campaign runner that wraps repeated `runLongTask`
3. Add generic round evidence harvester and summary synthesizer
4. Add expert-workspace lesson mirror writer
5. Add CLI command for campaign runs
6. Add task-pack campaign spec for `try4`
7. Run real experiment with `maxRounds = 100`

## Success Criteria

- campaign can start from current raw `try4` materials
- round 1 failure automatically seeds round 2
- later rounds see actual prior failure content, not only filenames
- deployment-visible expert workspace contains cumulative failed-path lessons
- system stops on `verified_success` or round 100
- no task-specific execution logic is pushed into long-task kernel
