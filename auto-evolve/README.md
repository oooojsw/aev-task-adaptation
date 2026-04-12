# Auto Evolve

This directory contains a usable scaffold for a dataset-driven loop that treats OpenCode as the execution engine.

## What Exists Now

- `cli.ts`
  - `init`
  - `validate`
  - `bootstrap`
  - `run-case`
  - `run-round`
- `config.json`
  - project-local defaults for dataset, experience workspace, methods, scripts, and runtime state
- `permission-config.json`
  - runtime permission switch for OpenCode
  - `open`: do not enforce auto-evolve-side permission limits
  - `restricted`: enforce the per-phase read/write boundaries built by auto-evolve
- `baseline.md`
  - user-authored starting guidance
  - treated as context, not as system control logic
- `dataset/SPLIT.md`
  - fixed train/test split
- `experience/workspace/`
  - editable Markdown-first expert memory files
- `methods/recipes/`
  - Markdown-first method packs
  - current baseline: `sequential-refine`
  - future scaffold: `adversarial-test`
- `dataset/cases/`
  - case folders with `case.json`, `material/`, and `expected/`
- `task-packs/real-long-tasks/`
  - real long-task packages with materials, goals, validators, and task-local runtime sidecars
- `runtime-state/runs/`
  - run artifacts written by `bootstrap` and `run-case`
- `runtime-state/maintenance-gateway/`
  - normalized maintenance requests from runtime kernels
- `runtime-state/experience-transaction/`
  - transaction records for verification, acceptance, and rollback decisions

## Execution Flow

1. `bootstrap`
   - calls OpenCode itself
   - uses the fixed train split from `dataset/SPLIT.md`
   - reads `baseline.md` as optional user guidance
   - asks it to generate or refresh the Markdown experience workspace from labeled material/result pairs
2. `run-case`
   - first solve round: a fresh OpenCode run reads the experience workspace and solves the current case
   - in `learn` mode, if the solve fails, a second OpenCode run reads the failure context and updates the experience workspace
   - in `eval` mode, solve is evaluated but no refine step is allowed
   - the case is retried until it passes or `maxRetriesPerCase` is reached
3. `run-round`
   - traverses a limited number of cases in order
   - defaults to `roundCaseLimit = 5` so routine testing stays lightweight
   - supports `--split train|test|all`
   - defaults to `train`
   - `test` automatically runs in evaluation mode
   - can be overridden with `--limit`

## Command Examples

```bash
bun run auto-evolve/cli.ts init
bun run auto-evolve/cli.ts validate
bun run auto-evolve/cli.ts bootstrap --force --method sequential-refine
bun run auto-evolve/cli.ts run-case --case case-001 --method sequential-refine --mode learn --split train
bun run auto-evolve/cli.ts run-round --method sequential-refine --split train --limit 5
bun run auto-evolve/cli.ts run-round --method sequential-refine --split test --limit 5
```

## Case Shape

Use `task-packs/templates/case.example.json` as the starting point.

Minimal shape:

```json
{
  "id": "case-001",
  "instruction": "Return valid JSON only.",
  "materials": [
    {
      "path": "material/input.txt",
      "label": "primary material"
    }
  ],
  "expected": {
    "path": "expected/output.json",
    "mode": "json_exact"
  }
}
```

## Current MVP Boundaries

- `bootstrap`, `solve`, and `refine` all call the existing OpenCode CLI in JSON event mode.
- The persistent knowledge target is the Markdown experience workspace under `experience/workspace/`.
- Prompt instructions are now loaded from Markdown method files under `methods/recipes/`.
- The user baseline is loaded from `baseline.md`.
- The dataset split is loaded from `dataset/SPLIT.md`.
- The evaluator currently supports:
  - `text_exact`
  - `text_contains`
  - `json_exact`
- The solve phase is intended to be read-only; if it edits any experience-workspace file, the run is marked as failed and the files are restored.
- The current default method is `sequential-refine`.
- Runtime permissions are controlled by `permission-config.json`.
- The current default is `open`, which means auto-evolve does not restrict OpenCode read/write/tool access.
- `adversarial-test` is scaffolded as a future method but is not wired into runtime behavior yet.
- This version expects the repository dependencies to be installed before OpenCode can execute successfully.
