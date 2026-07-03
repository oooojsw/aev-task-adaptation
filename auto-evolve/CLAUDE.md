# CLAUDE.md
0.最重要的规则，任何时候，你都不能只调用工具然后不给任何文本解释，你要在跟我对话的最后又结论的时候，给我一个文本的回答，而不是直接结束我们的对话，我是说多次对话而不是单次对话。
0.5-每次回答我问题之后，经过一系列工具调用，后必须在最后根据这些信息给出文字解释，再进入 sleep 或等待 loop，不能工具调用完就直接 silence。任何情况都不能不解释不回答我的问题，直接工具调用结尾，必须跟一段文字说明当前状态和下一步才能进入最后的sleep或者loop。
1----当我要求你生成任何新文件或者是解包这些，默认地址都是现在工作文件夹


2----文件本身是 UTF-8 编码，没问题。终端显示乱码通常是终端编码问题。
解决方案：
Windows CMD/Terminal 设置UTF-8：
chcp 65001

3---- 当我说准确名词“持续监控”这个词的时候，意思是：在你检测到这个现在正在处理的任务或者命令需要长时间运行的时候（持续在跑而不是卡死了），你必须先在此电脑的全局配置文件修改区（"C:\Users\ZhuanZ\.codex\AGENTS.md"）里面，写好我给你的运行时间，次数，当前次数（运行完每一次之后，自动的改当前次数，当运行完所有的次数之后，结束持续监控任务，然后吧这三个运行时间，次数，当前次数清零），然后的自动运行sleep 一小时这个命令（例如$ Start-Sleep -Seconds 3600，或者半小时，二十分钟，十分做，五分钟，最短五分钟，选择时间的时候你自己决定时长），不对任何人或者任何任务或者任何的脚本，就是直接在命令行里面运行！！！然后这个命令运行完直接回去检查这个任务的情况，不准套到任何其他命令嵌套，不准和任何脚本本身勾稽，就是单纯的在命令行运行这个命令！！！！
3-1，每一次结束监控之后，看下运行情况，然后不能仅仅说自己持续监控，必须要启动下一次的$ Start-Sleep
3-2，示例：如果你说“持续监控30分钟*10次”，我必须先检查当前任务是否真的在运行；检查完之后必须立刻直接执行 `Start-Sleep -Seconds 1800`；每次 sleep 结束后必须先回来检查任务真实状态，再更新当前次数；如果还没到总次数，就必须再次直接执行下一次 `Start-Sleep`；只要你明确说了“持续监控”，我就必须真的执行这个流程，不能只口头回复“我会继续监控”。
3-3，**同一时间只能有一个 sleep 在跑**。不能在旧 sleep 还没结束时就启动新的 sleep。如果用户重新指定了监控参数（比如从 10 次改成 40 次），必须先停掉当前 sleep，更新配置，再启动新的 sleep。不允许两个 sleep 同时执行。
3-4，需要注意的是，一定要以Start-Sleep命令作为你输出的结尾，这个命令不结束不准输出任何文字内容！！！3-4，需要注意的是，一定要以Start-Sleep命令作为你输出的结尾，这个命令不结束不准输出任何文字内容！！！3-4，需要注意的是，一定要以Start-Sleep命令作为你输出的结尾，这个命令不结束不准输出任何文字内容！！！

3.5----当我说"前端"或"前端页面"时，特指 auto-evolve 监控面板页面（frontend/monitor/index.html），不是 OpenCode 主应用（packages/app/）。不要修改 packages/ 下的任何前端文件。


4，我不是一个专业的软件工程师，我只是略懂一些简单的编程语言，懂一些agent设计，所以你跟我解释的各种专业变化我看不懂，你只需要告诉我是怎么回事，让我明白这个逻辑就行了，可以略微穿插一些专业术语

5，常用脚本位置：
- 导出源码：在文件夹上右键 → "收集所有代码文件"（工具位置：E:\project\收集某个文件下所有代码文件右键项目\）
- 一键安装右键菜单：运行 install_right_click.bat
- 停止并核查所有运行 session：C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\script\stop-auto-evolve-sessions.ps1
- try4 环境初始化（含影子经验清理）：C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\scripts\init-try4-clean-state.ps1


6，我没看过代码，你说的那些文件名称，什么狗皮英文名称，我一个都不知道，直接给我大白话讲这个节点是什么节点，这个函数是什么函数位于什么逻辑之内




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
   - `long-task/` — Validator-driven long-running task framework. Bootstraps a work graph (`work-graph.ts`) from a spec file (`spec.ts`) and validators (`validators.ts`). Key files: `contract.ts` (state/status types), `runner.ts` (main loop), `repository.ts` (persistence), `json-extract.ts` (robust JSON extraction from LLM output).
   - `long-task-campaign/` — Multi-round long-task campaign (`spec.ts`, `contract.ts`, `runner.ts`, `repository.ts`, `prompts.ts`). Produces: `pending-expert-package/current`, `exploration-tree.json`, `campaign-working-memory.json`, `routing-control.json`.
   - `acceptance-framework/` — Framework for deploying and validating OpenCode agents against a defined acceptance contract.
   - `reverse-propagation-control/` — Layer-3 propagation control plane with state channels and recipes.
   - `propagation/` — Layer-3 propagation campaign runner.
   - `runtime-process-registry.ts` — Tracks all spawned subprocess lifetimes with runtime scopes; round-end cleanup via scopes.
   - `monitor.ts` — Monitor integration for process health checks.
   - `session-execution-report.ts`, `session-learning-log.ts`, `session-task-manifest.ts` — Per-session artifact tracking.
   - `fs.ts` — Path resolution utilities; note: `autoEvolvePath()` appends `auto-evolve/` to cwd, meaning commands may need to run from the parent repo root.
   - `primitive-ops/`, `primitives.ts` — Low-level operation building blocks.
   - `batch-*` — Parallel batch execution and post-judge infrastructure.
   - `execution-strategies.ts`, `method-runtime.ts`, `method-strategies.ts`, `method-strategy-helpers.ts` — Method dispatching and execution strategy resolution.

### Task Packs

Real task definitions live in `task-packs/real-long-tasks/`. Current primary task: `try4-expert-bootstrap` — learns expert experience from source materials (`.xlsx`, reference Word docs, blank Word templates) to produce a reusable expert package. Also contains `campaign-smoke` for lightweight campaign validation.

### Monitor Server

`monitor-server.ts` — Standalone HTTP server for real-time monitoring. Scans `runtime-state/runs` and `runtime-state/propagation/workspaces`. Does **not** natively scan `runtime-state/long-task/` or `runtime-state/long-task-campaigns/` — long-task/campaign monitoring relies on live session inspection.

### Runtime State

`runtime-state/` is a **symlink** to `/e/opencode-auto-evolve-history/runtime-state` (large historical artifacts stored externally). Contains:
- `runs/` — Run artifacts by timestamp
- `long-task/` — Long-task runs, candidates, archive, shadow memory
- `long-task-campaigns/` — Campaign runs with control surfaces
- `maintenance-gateway/` — Maintenance requests and transactions
- `acceptance-framework/` — Deployment runs and validation
- `propagation/` — Layer-3 propagation workspaces
- `experience-transaction/` — Experience workspace change transactions

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

- `config.json` — Main config (paths, limits, defaults). `maxRetriesPerCase: 3`, `maxMaintenanceRoundsPerAttempt: 3`, `roundCaseLimit: 5`, `regressionSampleSize: 3`, `defaultMethod: "sequential-refine"`.
- `permission-config.json` — `"open"` (no restrictions) or `"restricted"` (phase-based read/write boundaries). Default: `"open"`.
- `judge-config.json` — Judge mode (`soft_only` or `soft_plus_hard`) and auto-run skill IDs. Default: `"soft_plus_hard"` with skills `exact-output`, `tool-failures`, `session-behavior`.
- `model-config.json` — Per-phase model selection (bootstrap, solve, refine, verify, regression). Default model: `alibaba-coding-plan-cn/qwen3.7-plus`, rate limit: 14 RPM.

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

## Implementation Details (AGENTS.md Reference)

The file `AGENTS.md` at project root contains deep implementation notes, particularly about:
- **Long-task campaign control surfaces**: `pending-expert-package/current`, `exploration-tree.json`, `campaign-working-memory.json`, `routing-control.json` — these are the 4 files that carry state between campaign rounds.
- **Known risks**: `collectCarryoverContext()` returns empty (carryover not wired); monitor-server doesn't scan long-task/campaign directories; restricted-mode edit permission gaps; resumption idempotency issues.
- **Stale-running detection**: Check for real subprocesses (not just `campaign.json`/`progress_state.json` set to "running").
- **Campaign cleanup before rerun**: Kill old processes → delete `runtime-state` directories → restore seed workspace → verify source materials.

## Patterns to Follow

- Phase prompts are loaded from `methods/recipes/<method>/prompts/` and `prompts/` (core prompts).
- Maintenance ops are Markdown files under `methods/maintenance-ops/`.
- Permission overrides follow the deny-by-default pattern: `"*": "deny"` then explicit allow rules per phase.
- Run artifacts use timestamp-prefixed directory names for ordering.
- The solve phase is intended to be read-only on experience workspace files; violations are detected and cause run failure.
