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

# 2026-04-10

- 经验体系的长期目标已从“固定 knowledge-pack”升级为：
  - `Experience Workspace`
- 当前 `knowledge-pack` 只视为 Experience Workspace v1 的默认实现，不视为最终唯一结构。
- 系统中应同时存在：
  - 模板库（供经修 agent 参考）
  - 最终经验工作区（只保留真实有效经验）
- 经验工作区未来必须支持：
  - 单入口文件
  - 分区存储
  - 选择性读取
  - 任务专用工具说明文档
- 反向传播方法不直接维护经验体系，而是：
  - 通过方法代码组织元操作
  - 构造反馈包
  - 调用经修 agent
- 经修 agent 的职责是：
  - 在约束内维护和重组经验体系
  - 不是固定写文件器
  - 不是策略制定者
- 当前阶段的权限策略明确为：
  - 经修 agent 先不做严格硬权限切分
  - 主要通过提示词契约约束
  - 通过验证 / 回滚控制风险
  - 当前目标是先把整条系统链路跑通
- 未来权限控制计划明确为：
  - 先加工作区边界
  - 再加方法授权边界
  - 再加结构性规则边界
  - 例如单入口、索引维护、分区可导航性等
# 2026-04-10 Session 执行报告与经修 Agent 分层提示

- 每个关键 session 后续必须生成一个单文件、按顺序、截断版的 `session_execution_report.md`。
- 该报告放在具体实验 / case / attempt 的 session 目录中，不再要求经修 agent 自己拼接多个碎片文件。
- 经修 agent 后续拿到哪些 session 报告，由具体反向传播方法定义。
- 经修 agent 提示系统后续固定拆成三层：
  - 通用内核提示词
  - 方法专属维护扩展提示词
  - 运行时上下文块
- Experience Workspace 继续作为最终专家经验工作区；模板库只作参考，不并入最终经验。
# 2026-04-10 Taskized Bootstrap And Session Dual Records

- `bootstrap` should no longer be treated as a system-global special phase
- `bootstrap` should become a method-level task / primitive op
- the system should gradually move from "init vs train" thinking to a unified task model
- core task categories should include:
  - `seed_workspace`
  - `bootstrap_from_examples`
  - `learn_case`
  - `eval_case`
  - `verify_case`
  - `run_regression`
  - `maintain_experience`
  - `adversarial_probe`
  - `branch_compare`
- every key session should ultimately preserve two first-class artifacts:
  - `session_execution_report.md`
  - `session_learning_log.md`
- `session_learning_log.md` is intended to be appended during the session, not generated only at the end
- the knowledge maintainer should later read both:
  - execution reports
  - learning logs
- which reports and logs are provided to the knowledge maintainer should be selected by each reverse-propagation method, not hard-coded globally
- the knowledge maintainer prompt stack should remain layered as:
  - stable maintainer core
  - method-specific maintenance extension
  - runtime context
- long-term design should also introduce a lightweight `session_task_manifest.md` so later agents can distinguish:
  - what a session was supposed to do
  - what it actually did
