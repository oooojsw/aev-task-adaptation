# Next Steps

Date: 2026-04-09

## Best Next Move

Do not keep growing the current system only by expanding `expert_rules.md`.

The best next move is to turn the current loop into an experiment framework with a Markdown-first knowledge pack.

## Recommended Priority Order

1. Add targeted refinement routing inside the knowledge pack
2. Add Git-tree-style knowledge branching
3. Separate refinement strategy from knowledge storage
4. Introduce experiment config and isolated experiment runs
5. Add regression validation
6. Add parallel experiment scheduling

## Phase 1: Knowledge Pack

The first Markdown-first knowledge-pack structure is now in place:

- `knowledge-pack/manifest.md`
- `knowledge-pack/core/expert_rules.md`
- `knowledge-pack/core/output_contract.md`
- `knowledge-pack/core/execution_checklist.md`
- `knowledge-pack/patterns/general_rules.md`
- `knowledge-pack/patterns/exceptions.md`
- `knowledge-pack/lessons/failure_lessons.md`

Goal:

- separate stable knowledge from case-specific lessons
- make future refinement less chaotic
- keep the knowledge source human-readable and Markdown-first

Immediate gap after this implementation:

- the files exist, but refine is not yet routed strongly enough to update the right file by failure type
- most learned content still tends to remain concentrated in `core/expert_rules.md`

### `scripts/` Design Direction

The `scripts/` layer should stay separate from the knowledge files, but it should become more self-describing.

Preferred approach:

- keep reusable capabilities under `auto-evolve/scripts/`
- make each capability folder carry a Markdown descriptor with YAML frontmatter
- prefer compatibility with OpenCode's existing `SKILL.md` convention
- aim for "copy folder into scripts and it becomes available" behavior

Important constraint:

- Markdown remains the source of truth for instructions and usage
- code files remain implementation details or helper tools
- TypeScript should not become the hidden storage format of the script rules or capability descriptions

### Git Tree Requirement

This phase should be designed with Git-tree-style branching in mind:

- multiple experiments will share most knowledge files
- only a small subset of files may differ between experiments
- future experiment branching should operate like lightweight knowledge branches, not uncontrolled file mutation

### Markdown-First Rule

Knowledge source of truth should stay in Markdown documents.

Allowed:

- scripts that read Markdown and assemble prompts
- scripts that copy, branch, diff, or compare Markdown knowledge packs

Not preferred:

- hard-coding expert rules inside TypeScript modules
- moving the real knowledge into code structures while Markdown becomes decorative

## Phase 2: Refinement Strategy Modules

Introduce named refinement strategies, for example:

- `local-refine`
- `trace-aware-refine`
- `evaluation-heavy-refine`
- later: user-designed backprop variants

Goal:

- make refinement / backprop methods pluggable
- support fair comparison across strategies
- keep refinement outputs targeted at Markdown knowledge files, not hidden code-side state

Current status:

- the baseline method has now been externalized as `methods/sequential-refine`
- the next concrete implementation target should be making method selection affect runtime flow, not only prompt source files

## Phase 3: Experiment Config

Add an experiment descriptor, for example:

- experiment name
- model
- bootstrap prompt variant
- solve prompt variant
- refine strategy
- dataset slice
- retry budget
- logging options

Goal:

- stop mutating one global workflow blindly
- make experiments repeatable and comparable

## Phase 4: Parallel Experiments

Parallelize at the experiment layer, not inside one learning chain.

Preferred rule:

- one experiment = one isolated knowledge state
- different experiments may run in parallel
- one experiment's cases should still usually run in sequence
- experiments should ideally branch from a shared base knowledge tree instead of copying everything blindly

Goal:

- compare strategies without corrupting a shared expert knowledge state

## Concrete Immediate Build Items

If we start coding the next phase right now, the best first implementation steps are:

1. add failure-type-to-file routing for refine
2. create `auto-evolve/experiments/`
3. add `experiment.example.json`
4. add isolated knowledge branch per experiment run
5. route `run-case` and `run-round` through an experiment context
6. define the first pluggable refiner interface
7. only after that, begin wiring the first runnable `adversarial-test` flow

## Recorded Follow-Up

- verify that the default runtime model now resolves to `minimax-cn-coding-plan/MiniMax-M2.7` on real runs
- use the `.com` provider route from `minimaxi.com`
- apply the model switch only after current debugging / validation work is stable, so model changes do not blur the source of current failures

## What To Avoid Next

- do not keep piling more and more rules into one giant `expert_rules.md`
- do not test multiple refinement methods on one shared knowledge file
- do not add parallelism before knowledge isolation
- do not let TypeScript become the hidden source of truth for the rules
# 下一步（2026-04-09 更新）

1. 跑一轮正式基线评分板：
   - `train = 5`
   - `test = 5`
   - 视需要决定是否先 `bootstrap --force`
2. 观察 scorecard 和知识库快照，确认当前顺序方法的正式基线表现。
3. 在正式基线稳定后，再开始做 Git-tree v1。
# Next Steps (Updated 2026-04-10)

1. 验证“自动启动 dashboard / 重复运行复用 dashboard”这条链路
2. 评估是否需要在 dashboard 中显式展示 `case / attempt / phase`
3. 考虑后续是否切换为 `opencode-monitor` 项目作为更强的前端外壳
