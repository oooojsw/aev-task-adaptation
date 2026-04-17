# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the **auto-evolve** sub-project: an outer orchestration layer that treats OpenCode as a controllable execution engine. It runs evaluation-driven refinement loops to improve OpenCode's task performance across a dataset of labeled cases.

The project root is: `C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve`

## Runtime

- **Bun** is the runtime and package manager. Use `bun run cli.ts <command>` for all CLI invocations.
- **TypeScript** throughout — no separate build step needed.

## CLI Commands

All commands run from the project root (`C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve`).

```bash
bun run cli.ts init              # Ensure workspace, templates, and knowledge files exist
bun run cli.ts validate          # Validate config.json and all dataset cases
bun run cli.ts bootstrap [--force] [--method <id>]  # Generate/refresh experience workspace from labeled cases
bun run cli.ts run-case --case <id> [--method <id>] [--mode learn|eval] [--split train|test|all]
bun run cli.ts run-round [--method <id>] [--limit <n>] [--split <split>] [--mode <mode>]
bun run cli.ts run-baseline [--train-limit <n>] [--test-limit <n>] [--skip-bootstrap] [--force-bootstrap]
bun run cli.ts run-long-task --spec <path>
bun run cli.ts run-long-task-campaign --spec <path>
bun run cli.ts resume-long-task --run <run-id>
bun run cli.ts run-propagation [--method <id>] [--branch <name>] [--train-limit <n>] [--test-limit <n>]
bun run cli.ts reset-experience [--note <text>]  # Archive current experience, reset to seed
bun run cli.ts restore-experience                  # Restore from latest archive snapshot
```

## Architecture

### Core Layers

1. **CLI** (`cli.ts`) — Entry point, dispatches to orchestrator modules.
2. **Orchestrator** (`orchestrator/`) — All pipeline logic. Key modules:
   - `opencode.ts` — Spawns OpenCode as a subprocess via JSON event mode. Handles permission overrides (open/restricted mode), read/edit path allowlisting, and tool-failure collection.
   - `bootstrap.ts` — Asks OpenCode to generate the initial experience workspace from labeled dataset cases.
   - `case-runner.ts` — Runs a single case: solve phase → evaluate → (if failed in learn mode) refine/maintain phase → retry loop.
   - `round-runner.ts` — Traverses cases in order, evolving the experience workspace across the round.
   - `baseline-runner.ts` — Full baseline: train round + test round + knowledge snapshot.
   - `knowledge-maintainer/` — OpenCode agent that refines experience files after case failures.
   - `long-task/` — Validator-driven long-running task framework. Bootstraps a work graph from a spec file and validators.
   - `long-task-campaign/` — Multi-round long-task campaign that harvests failure evidence and carries it forward.
   - `acceptance-framework/` — Framework for deploying and validating OpenCode agents against a defined acceptance contract.
   - `reverse-propagation-control/` — Layer-3 propagation control plane with state channels and recipes.
   - `propagation/` — Layer-3 propagation campaign runner.

### Method / Recipe System

Methods are Markdown-first packs under `methods/recipes/`. Each method defines:
- `METHOD.md` — Metadata (id, version, description)
- `FLOW.md` — Execution flow
- `prompts/` — Phase prompts (bootstrap, solve, judge_extension, maintain_extension, etc.)

Current methods:
- `sequential-refine` — Default. Single-case iterative solve + maintain loop.
- `add-only` — Knowledge is only appended, never rewritten.
- `parallel-batch-5-add-only` — 5-case parallel solve + batch maintain.
- `adversarial-test` — Scaffolded but not fully wired.

### Experience Workspace

Located at `experience/workspace/`. Contains Markdown expert knowledge files. Persistence target: `experience/workspace/manifest.md`. Experience can be archived (to `experience/archive/history/`) and restored via CLI.

### Data Model

- **Cases** (`dataset/cases/case-NNN/`) — `case.json` (instruction, materials, expected), `material/`, `expected/`.
- **Run artifacts** — Written to `runtime-state/runs/`, `runtime-state/acceptance-framework/deployment-runs/`, `runtime-state/propagation/`.
- **Split** — Train/test split defined in `dataset/SPLIT.md`.

### Configuration

- `config.json` — Main config (paths, limits, defaults). `maxRetriesPerCase`, `maxMaintenanceRoundsPerAttempt`, `roundCaseLimit`, `regressionSampleSize`.
- `permission-config.json` — `"open"` (no restrictions) or `"restricted"` (phase-based read/write boundaries).
- `judge-config.json` — Judge mode (`soft_only` or `soft_plus_hard`) and auto-run skill IDs.
- `model-config.json` — Per-phase model selection.

### OpenCode Integration

OpenCode is spawned as a subprocess. Key patterns:
- JSON event mode for structured output parsing.
- Permission overrides via generated `permission-overrides.json` per run.
- Tool failures are collected from `tool_use` events with error/nonzero-exit status.
- Response text is collected from `text` events.
- Timeout: 30 minutes per task.

### Long-Task System

Long tasks differ from case-based tasks:
- Work graph is bootstrapped from a `spec.ts` file and validator definitions.
- Validators run against the workspace output after each work node.
- Supports resumption from existing run directories.
- Campaigns run multiple rounds, each harvesting failure evidence into carryover context.

### Evaluation Modes

- `text_exact` — Exact text match.
- `text_contains` — Substring presence.
- `json_exact` — Exact JSON match.

## Patterns to Follow

- Phase prompts are loaded from `methods/recipes/<method>/prompts/` and `prompts/` (core prompts).
- Maintenance ops are Markdown files under `methods/maintenance-ops/`.
- Permission overrides follow the deny-by-default pattern: `"*": "deny"` then explicit allow rules per phase.
- Run artifacts use timestamp-prefixed directory names for ordering.
- The solve phase is intended to be read-only on experience workspace files; violations are detected and cause run failure.
