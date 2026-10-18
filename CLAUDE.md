# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository is a monorepo consisting of two interconnected systems:
1. **OpenCode** (`packages/`): An AI-powered development platform, agent runtime, CLI, TUI, and desktop/web applications.
2. **Auto-Evolve** (`auto-evolve/`): An outer orchestration framework running evaluation-driven refinement loops, multi-round campaigns, and blind evaluation. It includes the **Task-Driven Adaptation** subsystem (`auto-evolve/orchestrator/task-adaptation/`).

The core development mainline is tracked in `MAINLINE.md`.

## Development Commands

### Package Management & Runtime
- **Runtime**: Bun (`bun@1.3.11` / `v1.3.14`).
- **Install dependencies**: `bun install`

### Testing
- **Root guard**: Do NOT run `bun test` from the repository root (root tests are blocked by `bunfig.toml` pointing to `./do-not-run-tests-from-root`).
- **Run Auto-Evolve / Task-Adaptation tests**:
  ```bash
  # Run task-adaptation suite
  bun test --cwd auto-evolve orchestrator/task-adaptation

  # Run a single test file
  bun test --cwd auto-evolve orchestrator/task-adaptation/intake-three-track.test.ts

  # Run the task-adaptation regression suite
  bun test --cwd auto-evolve orchestrator/task-adaptation orchestrator/protocol-plugins/training-invocation.test.ts orchestrator/protocol-plugins/host-permissions.test.ts orchestrator/protocol-plugins/campaign-lifecycle.test.ts
  ```
- **Run OpenCode package tests**:
  ```bash
  # Must run with package directory as cwd or from inside the package
  bun test --cwd packages/opencode ./test/agent/agent.test.ts
  ```

### Type Checking & Build
- **Typecheck monorepo**: `bun turbo typecheck`
- **Typecheck single package**: `bun --cwd packages/opencode typecheck` (uses `tsgo --noEmit`; never run bare `tsc` directly without package config).
- **Regenerate JS SDK**: `./packages/sdk/js/script/build.ts`

### Dev Servers
- **CLI dev**: `bun run dev` (or `bun run --cwd packages/opencode --conditions=browser src/index.ts`)
- **Desktop (Tauri)**: `bun run dev:desktop`
- **Web app**: `bun run dev:web`

### Auto-Evolve CLI & Workflows
All Auto-Evolve commands run via `bun run auto-evolve/cli.ts <command>`:
- `bun run auto-evolve/cli.ts init`: Ensure workspace, templates, and knowledge files exist.
- `bun run auto-evolve/cli.ts validate`: Validate config and dataset cases.
- `bun run auto-evolve/cli.ts bootstrap`: Generate/refresh experience workspace from labeled cases.
- `bun run auto-evolve/cli.ts run-case --case <id>`: Run single case learn/eval.
- `bun run auto-evolve/cli.ts run-long-task --spec <path>`: Run single long task.
- `bun run auto-evolve/cli.ts run-long-task-campaign --spec <path>`: Run multi-round campaign.
- `bun run auto-evolve/cli.ts resume-long-task --run <run-id>`: Resume existing long-task run.

### Benchmark & Run Management
- **List resume candidates**: `bun run auto-evolve/scripts/resume-auto-evolve-run.ts --list`
- **Auto-resume highest progress run**: `bun run auto-evolve/scripts/resume-auto-evolve-run.ts --auto`
- **Stop run**: `powershell -ExecutionPolicy Bypass -File script/stop-auto-evolve-sessions.ps1`
- **Update run dashboard**: `bun run auto-evolve/scripts/update-run-dashboard.ts`

## Code Architecture

### 1. OpenCode Core (`packages/`)
- `packages/opencode/src/`: Core engine.
  - `cli/` & `cli/cmd/tui/`: CLI entrypoints and Solid-based terminal UI (`@opentui`).
  - `session/` & `agent/`: Session management, message processing, agent loops, prompt compaction.
  - `provider/`: Model providers (OpenAI, Anthropic, Bedrock, Copilot, Azure, custom OpenAI-compatible).
  - `permission/`: File and shell execution permission control.
  - `tool/`: Native tools (read, write, edit, bash, glob, grep, etc.).
  - `acp/` & `mcp/`: Agent Control Protocol and Model Context Protocol integrations.
- `packages/app/`: SolidJS web and desktop frontend.
- `packages/desktop/`: Tauri container wrapping the web frontend.

### 2. Auto-Evolve Orchestration (`auto-evolve/orchestrator/`)
Auto-Evolve treats OpenCode as a controllable execution engine, wrapping it in an iterative refinement loop:
- `task-adaptation/`: Task-driven adaptation layer (`aev.task-adaptation.v1`):
  - **Three intake tracks** (`intake.ts`): `auto` (model-interpreted task plan), `manual_decision` (human-specified plan decision), and `manual_plan` (pre-compiled plan path).
  - **Catalogue & Compilation** (`catalogue.ts`, `plan.ts`, `approved-plan.ts`): Compiles task intents into strict plans with roles, stages, capability requirements, and deliverable schemas.
  - **Resource & Material Binding** (`binding.ts`): Binds materials by cryptographic hash, enforces read-only sources, snapshot claims, and source-drift detection.
  - **Execution Window & Invocation** (`invocation.ts`, `context.ts`): Isolates model contexts per role so agents only see declared objective, output contract, and scoped resources without leaking prior broad grants.
  - **Request Budget & Quotas** (`request-budget.ts`, `budget-stop.ts`): In-flight token and call counters, budget transport headers, and hard stopping probes.
  - **Deterministic Scoped Tools** (`local-search.ts`, `recompute.ts`): Scoped text search and exact AST arithmetic evaluation without granting shell access.
- `long-task/` & `long-task-campaign/`: Multi-round campaign execution (`runner.ts`), DAG work graphs (`work-graph.ts`), candidate exploration trees, and working memory.
- `blank-eval/`: Physical blind evaluation harness. Zero-context blank agents attempt tasks using only learned expert rules (`expert_rules.md`) and sanitized public contracts (`materials/spec.json`).
- `knowledge-maintainer/`: Maintenance agents that inspect failures and refine expert rules and scripts.
- `opencode.ts`: Spawns OpenCode CLI subprocesses with private configuration (`auto-evolve/.opencode-private`).

## Critical Architectural Constraints

- **Blind Validation Purity**: Blank agents must NEVER access ground truth, private answers (`private-answers/`), validator source code, historical campaign traces, or host workspace paths. Blank Eval only exposes sanitized task contracts.
- **Runtime Snapshot Isolation**: Subprocesses must execute against isolated configuration profiles (`auto-evolve/.opencode-private`) and isolated evidence directories. Do not leak host credentials, real provider configs, or desktop plugin states into runs.
- **Atomic Persistence**: Core JSON states, manifests, and claims must use atomic writes (`writeJsonAtomic` / `writeFileAtomic`). JSONL logs require file locking.
- **Windows Process Identification**: On Windows, process tracking cannot rely on PID alone due to PID recycling; use strong process identification and runtime process registries.
- **Git Commit Boundary**: Never commit `runtime-state/`, run logs, `.claim` locks, raw benchmark materials (`.docx`, `.xlsx`, `.pdf`), private answers, or generated model outputs. Code changes must be verified against offline tests before pushing.

## Coding Style Guide (Mandatory for Generated Code)

- **Naming**: Use concise single-word identifiers by default (`pid`, `cfg`, `err`, `opts`, `dir`, `root`, `child`, `state`, `timeout`). Only use multi-word names when a single word is ambiguous. Inline variables that are only used once.
- **Functions & Flow**: Prefer early returns; avoid `else` branches. Avoid `try`/`catch` where not strictly required.
- **TypeScript**: Rely on type inference. Avoid explicit `any`.
- **Arrays**: Prefer functional array methods (`filter`, `map`, `flatMap`) with type guards over `for` loops.
- **Bun APIs**: Prefer native Bun APIs (e.g. `Bun.file()`) over Node equivalents when working in Bun runtime files.
- **Drizzle Schemas**: Use `snake_case` column names to avoid redundant string mappings.
