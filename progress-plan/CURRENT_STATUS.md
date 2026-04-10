# Current Status

Date: 2026-04-09

## Repo Scope

Current active repo:

- `C:\Users\ZhuanZ\Desktop\opencode re\opencode latest`

Current active subsystem:

- `C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve`

## What Works Now

The current system already supports a usable 3-phase loop:

1. `bootstrap`
   - OpenCode reads labeled examples and writes the Markdown knowledge pack
2. `solve`
   - a fresh run reads the current knowledge pack and solves a case
3. `refine`
   - on failure, another run reads the failed output, expected output, evaluation result, and action trace, then updates the knowledge pack

## Current Prompt Architecture

Implemented prompt stages:

- bootstrap prompt
- solve prompt
- refine prompt

Current prompt source:

- `auto-evolve/orchestrator/prompts.ts`

## Current Data / Knowledge State

Current dataset size:

- 10 text cases in `auto-evolve/dataset/cases`

Current persistent expert knowledge target:

- `auto-evolve/knowledge-pack/`

Current knowledge-pack files:

- `manifest.md`
- `core/expert_rules.md`
- `core/output_contract.md`
- `core/execution_checklist.md`
- `patterns/general_rules.md`
- `patterns/exceptions.md`
- `lessons/failure_lessons.md`
- `change_log.md`

Current per-run artifacts include:

- prompt
- stdout
- stderr
- response
- events
- tool failures
- evaluation
- action trace

## Current Execution / Logging State

Current solve runs now save:

- `solve/action_trace.md`
- `knowledge_pack.before_solve/`
- `knowledge_pack.after_solve/`

Current refine input now includes:

- expected output
- actual failed output
- evaluation result
- simplified solve action trace

## What Is Still Weak

The current system is still too primitive in these ways:

- the knowledge pack exists, but most actual learned content still sits inside `core/expert_rules.md`
- there is not yet a Git-tree-style knowledge branching model
- refinement strategy is no longer purely hidden in TS, but runtime still only supports the baseline method `sequential-refine`
- there is no experiment config system yet
- parallel testing of different refinement strategies is not yet implemented
- round execution is still serial and can be slow
- no explicit regression validation layer exists yet
- file responsibilities inside the knowledge pack are not yet strongly enforced by routing logic

## Newly Landed Foundation

The system now has the first layer of a method system:

- prompt instructions for the baseline method now live in:
  - `auto-evolve/methods/sequential-refine/`
- a future second route is scaffolded in:
  - `auto-evolve/methods/adversarial-test/`
- CLI and runners now accept a method context
- routine round testing now defaults to 5 cases through `roundCaseLimit`
- the system now also has a first explicit data-boundary layer:
  - `auto-evolve/dataset/SPLIT.md`
  - `auto-evolve/baseline.md`
- bootstrap now uses the train split
- round execution now supports:
  - `split = train|test|all`
  - `mode = learn|eval`
- test split runs in evaluation mode and does not refine the knowledge pack
- runtime permission control now has an explicit switch file:
  - `auto-evolve/permission-config.json`
- current default permission mode is:
  - `open`
- in `open` mode, auto-evolve no longer imposes its own read/write/tool restrictions on OpenCode
- a first live session monitor now exists in the OpenCode CLI:
  - `opencode session monitor`
  - supports one-shot snapshot and `--watch` refresh mode
  - shows running / retry / done / error / archived state and the current step summary

## Most Important Architectural Reality

The current system proves that the loop works.

It does not yet prove that the knowledge structure is the right long-term structure.

The next phase should focus on:

- targeted knowledge-pack refinement
- Git-tree-friendly knowledge branching
- experiment isolation
- strategy modularization
- parallel experiment support
- preserving Markdown as the source of truth for rules while keeping `scripts/` as a separate capability layer

## Current Status (2026-04-10 update)

- The system is no longer conceptually tied only to a fixed `knowledge-pack`.
- A first `Experience Workspace` abstraction now exists in code.
- A separate template library now exists at:
  - `auto-evolve/experience-templates/`
- The template library is reference-only and is not part of the final expert experience by default.
- The baseline sequential method now treats failed refinement as a dedicated `knowledge maintainer agent` task.
- The knowledge maintainer currently operates under prompt-only constraints:
  - no hard structural permissions yet
  - no hard file-authority matrix yet
  - risk is currently controlled by:
    - acceptance checks
    - current-case verification
    - regression verification
    - rollback on rejection
- Method execution has started shifting from `FLOW.md` runtime control to code-defined method strategies.
- `FLOW.md` remains useful as human-readable documentation, but the intended long-term runtime source is code strategies calling primitive ops.

## Verified This Round

- `bun run auto-evolve/cli.ts validate`
  - passed
- `bun run auto-evolve/cli.ts run-case --case case-001 --method sequential-refine --mode eval --split test`
  - executed successfully through the new strategy path
- `bun run auto-evolve/cli.ts run-case --case case-001 --method sequential-refine --mode learn --split train`
  - executed successfully through the new strategy path
- `bun run auto-evolve/cli.ts run-case --case case-006 --method sequential-refine --mode learn --split test`
  - executed successfully through the new strategy path

## What Is True Right Now

- The new architecture is partially implemented and runnable.
- The system already knows about:
  - experience workspace
  - template library
  - knowledge maintainer prompt
  - code-defined method strategy for `sequential-refine`
- The next important gap is that the primitive-op layer still lives mostly inside `case-runner.ts`.
- The second important gap is that only the baseline method has a real strategy implementation.
# 当前状态更新（2026-04-09）

- 已有统一的“基线评分板”入口：
  - `bun run auto-evolve/cli.ts run-baseline`
- 评分板会输出一份完整的 scorecard，而不是只看零散的 train/test round。
- 默认模型继续保持：
  - `minimax-cn-coding-plan/MiniMax-M2.7`
- 当前仍然是纯路径模式，solve/refine 由 OpenCode 自己读取文件。
# Current Status

- `auto-evolve` 已接入“自动外部监控面板”能力。
- 监控配置单独放在 `auto-evolve/monitor-config.json`。
- 实验命令启动时会自动确保 `session dashboard` 在线。
- 如果 dashboard 服务已在线，则会直接复用。
