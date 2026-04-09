# Decisions

Date: 2026-04-09

## Current Working Decisions

### 1. Active Repository

All current work should stay inside:

- `C:\Users\ZhuanZ\Desktop\opencode re\opencode latest`

### 2. Active Workflow Root

The current experiment subsystem lives in:

- `auto-evolve/`

### 3. Current Model Choice

Current default model:

- `minimax-cn-coding-plan/MiniMax-M2.7`

Current config source:

- `auto-evolve/config.json`

Recorded future switch request:

- default runtime model is `minimax-cn-coding-plan/MiniMax-M2.7`
- this should use the existing `MiniMax Coding Plan (minimaxi.com)` provider route, not SiliconFlow
- provider target should be the `.com` route from `minimaxi.com`
- this is now the active default in `auto-evolve/config.json`

### 4. Current Learning Object

The current main persistent learning target is the Markdown knowledge pack:

- `auto-evolve/knowledge-pack/`

Current files:

- `manifest.md`
- `core/expert_rules.md`
- `core/output_contract.md`
- `core/execution_checklist.md`
- `patterns/general_rules.md`
- `patterns/exceptions.md`
- `lessons/failure_lessons.md`
- `change_log.md`

This is a better intermediate structure than the old single-file design, but it is not yet the final branching / experiment-ready architecture.

### 5. Current Refine Scope

Each refine pass currently uses only the current failed case context plus the current expert knowledge.

It does not consume the full historical event stream of all previous cases.

### 6. Current Trace Policy

We now preserve a simplified solve action trace for every solve run.

This trace is:

- stored in `solve/action_trace.md`
- also passed into refine when a case fails

### 7. Current Concurrency Policy

We should not yet parallelize learning within one shared knowledge file.

Future parallelism should happen through isolated experiment contexts.

### 8. Strategic Direction

The next architectural step should be:

- experiment isolation
- stronger knowledge-pack routing
- pluggable refinement strategies

not:

- falling back to endlessly expanding one giant `expert_rules.md`

### 9. Knowledge Format Direction

The intended long-term rule representation should be:

- Markdown-first
- human-editable
- human-reviewable
- composable as a file system

Current explicit preference:

- the expert knowledge itself should not be hidden inside TypeScript code
- scripts may orchestrate and assemble the knowledge
- scripts should not become the primary storage format of the rules

### 10. Git-Tree-Oriented Knowledge Management

Future expert knowledge management should support Git-tree-like branching.

Reason:

- multiple experiments may share most of the same expert knowledge
- only a few files may differ between experiments
- we want efficient branching, comparison, and rollback of knowledge states

This suggests the future system should treat the knowledge pack as a versioned tree, not as one mutable flat document.

### 11. Role Of `scripts/`

The `scripts/` layer is considered a good design and should remain.

Its role should be:

- preserve helper scripts we design
- provide execution-time tools for the model
- assemble or process Markdown knowledge files when needed

Its role should not be:

- silently store the real expert rules in code while Markdown files become secondary

### 12. Preferred `scripts/` Packaging Style

The preferred future `scripts/` packaging style is:

- Markdown-described
- YAML-frontmatter-based for metadata
- compatible with OpenCode's existing skill-loading style where practical

Target user experience:

- a reusable capability can be dropped into the scripts area as a folder
- if that folder follows the agreed convention, it should become available without custom manual wiring

This means we should prefer a layout like:

- capability folder
- `SKILL.md` or equivalent Markdown descriptor
- optional helper code under subfolders such as `scripts/`, `templates/`, or `reference/`

The descriptor should remain the human-readable source of truth for usage and intent, while code remains implementation support.
# 2026-04-09

- auto-evolve 的默认模型入口改为单文件集中管理：
  - `auto-evolve/model-config.json`
- `config.json` 不再承担默认模型真源，只保留 `modelConfigFile` 指向模型配置文件。
- 当前默认模型固定为 `minimax-cn-coding-plan/MiniMax-M2.7`。
- 模型选择按阶段解析，支持：
  - `bootstrap`
  - `solve`
  - `refine`
  - `verify`
  - `regression`
- 现有系统主链保持不变，只是在现有链路上增加“单文件模型管理”能力。
