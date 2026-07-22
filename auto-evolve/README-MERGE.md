> 本文件由原 README.md 按主题拆分而来，正文尽量保留原文。
> 本文件负责：合并链路、merge-as-old、merge-as-long-task、merge-as-opt、分层合并、merge contract、回撤 repair/promote。

## merge-as-opt 可拔插后端（2026-07-22）

`merge-as-opt` 是统一 benchmark orchestrator 的第三个合并后端。它不使用 SkillOpt 自己的 rollout 轨迹代替 AEV 训练，而是只消费 AEV 已经产出并通过单 case 闭卷验收的 skill。

```text
AEV verified per-case skills
  -> 多文件 Skill 严格边界编码
  -> SkillOpt full_rewrite_minibatch 分层合并
  -> 解码为标准 mergedSkillDir
  -> AEV post_merge 表面验证
  -> 现有 merge acceptance profile（回撤 / repair / final replay）
  -> held-out test 和实验总账
```

总控位置：

```text
config.json > mergeConfig.mode = skillopt
config.json > mergeConfig.asSkillOpt
```

`asSkillOpt` 集中管理 SkillOpt root、YAML、Python、batch size、workers、timeout 和模型覆盖。API key 只能通过 `optimizerApiKeyEnv` 指向环境变量，禁止将密钥写进总控或运行产物。CLI 可用 `--merge-execution-mode skillopt` / `merge-as-opt` / `opt` 覆盖本次 run。

多文件 Skill 不会被粗暴压成单个 `CORE.md`。AEV 使用可逆文件边界把相对文件名和内容交给 SkillOpt，返回后严格还原。绝对路径、`..`、隐藏路径、重复文件名、symlink、二进制文件或边界外文本都会在调用回撤前 fail closed。

烟测：

```powershell
bun run auto-evolve/scripts/smoke-merge-as-opt.ts
```

原始完整备份：README-FULL-ARCHIVE-20260709-015413.md。

<!-- 原 README 行 1-92 -->

## Merge Acceptance Pipeline 可拔插规则（2026-07-01）

Multi-instance 合并现在分成两层：合并生成器和合并后验收流水线。

- 合并生成器只负责产出 `mergedSkillDir`，可以是 flat merge、hierarchical merge 或未来的新合并器。
- 数据集差异不再通过复制一份专用 merge prompt 解决，而是通过 `task-packs/merge-contracts/<dataset>/*.json` 注入“最终 skill 应该长什么样、哪些文件必须存在、哪些 casebook 命名规则必须遵守”。
- 合并后验收由 `mergeAcceptancePreset` 控制，默认是 `repair_promote`，保持旧行为：初次训练集回撤，失败 case 单点 repair，repair 通过后把修复 skill 提升为新 baseline。

总控配置位于 `config.json > mergeConfig`：

```text
merge_only       只合并，不回撤。
replay_report    合并后只做初次回撤并记录失败。
repair_promote   初次回撤 + 单点 repair/promote，兼容旧行为。
final_replay     repair 后再对最终 skill 做一次完整训练集回撤。
strict_all_pass  final replay 后要求全过，失败则标记 merge_acceptance_failed。
```

CLI 可覆盖：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts ... --merge-acceptance-preset strict_all_pass --merge-success-criterion all_pass
```

注意：`state.phase=completed` 只表示流程结束，不代表合并成功。真正结论看 `train-replay-output.json` 与 `orchestrator-state.json` 里的 `acceptanceStatus / accepted / initialReplay / finalReplay`。如果是 `strict_all_pass`，最终报告会明确写 `merge_acceptance_success` 或 `merge_acceptance_failed`，避免把 `5/6` 误读成成功。

回归烟测：

```powershell
bun run auto-evolve/scripts/smoke-merge-acceptance-policy.ts
```

## Merge-as-Long-Task 可选路径（2026-07-03）

旧合并流程仍然完整保留，默认仍走 `config.json > mergeConfig.mode = legacy_script`。

新增路径是：把一批已经训练出来的单 case skill 打包成一个新的 long-task 数据集，让“合并 skill”本身也像普通长程任务一样被执行、被表面检查、被空白 agent 回撤验证。

大白话流程：

1. `scripts/create-merge-long-task-pack.ts` 读取 split、已有 campaign/skill 清单，把单 case skill 复制到一个新的 merge task-pack。
2. 生成的 merge task 要求 agent 把多个 source skill 合成 `workspace/merged-skill`。
3. 合并完成后先跑表面硬门：标准 skill 文件结构 + merged skill 防泄漏检查。
4. 表面检查通过后，再跑 `blank_eval_plan`：同一份 merged skill 发给多道训练 case 的空白 agent 做闭卷回撤。
5. 回撤结果会变成这个 long-task 的完成验证结果，后续可以进入普通 campaign 的下一轮修复。

总控开关：

```text
mergeConfig.mode
  legacy_script  保留旧合并脚本。
  long_task      后续接入后，合并走 long-task task-pack。
  both_smoke     只用于对照烟测。

mergeConfig.asLongTask.surfaceProfileSet
  控制合并后、空白回撤前挂哪组表面验证器，默认 merge-surface-standard。

blankAcceptanceConfig.modes
  single-case                 旧单题空白验收。
  merge-final-full-replay     合并后全量多题回撤。
  merge-focused-failures      后续 repair 用，只回撤上一轮失败案例。
  merge-replay-report         只报告，不作为硬门。
```

无模型烟测：

```powershell
bun run auto-evolve/scripts/smoke-merge-as-long-task-pack.ts
```

2026-07-05 接入状态：

- `run-benchmark-orchestrator.ts` 已经把 `mergeConfig.mode = long_task` 从“直接报未实现”改成可选执行分支。
- 默认仍是 `legacy_script`，不会影响原有合并、回撤、测试链路。
- `long_task` 分支会从当前 benchmark 训练结果生成 `merge-as-long-task/_benchmark-inputs`，再调用现有分层/单层 merge long-task runner，最终把 `finalSkillPath` 写回 benchmark 的 `state.merge.mergedSkillDir`。
- 非分层模式会强制包装成单个 merge group，避免静默产出多个半成品；真正多组多层应开启 `mergeConfig.asLongTask.hierarchical.enabled`。
- 当前 `long_task` 分支的训练集回撤结果来自 merge long-task 内部的 `blank_eval_plan` completion validator；外层 `train-replay-output.json` 只是镜像这次验收结果，不再重复跑旧 replay。
- 当前 `long_task` 分支的 held-out test 只支持 `evalRunner=direct-chat`；如果需要 `blank-opencode` 测试集验收，仍应使用 `legacy_script`，或后续补 coordinator-state 桥接。

2026-07-03 鲁棒性补强：

- `create-merge-long-task-pack.ts` 现在会在启动前拒绝危险输出目录，只有空目录或带 `merge-long-task-pack-summary/v1` 标记的旧生成目录才允许覆盖，避免误删真实数据集或人工目录。
- split / manifest 会做强校验：重复 ID、manifest 缺行、manifest 重复行、非法 `inputSelection`、非法 `groupSize`、非法 `replayConcurrency` 都会直接失败，不再静默生成错误训练血统。
- 合并 long-task 的 `completion_validator_ids` 不再写死，而是从实际挂载的 validator profile JSON 展开得到；以后切换 surface 模块时，初始图会跟着真实验证器走。
- `smoke-merge-as-long-task-pack.ts` 已覆盖成功路径和 8 类负向错误，确保“错配置先炸，不烧模型额度”。

2026-07-03 自动挂载补强：

- `blankAcceptanceConfig.autoMount.rules` 现在负责把场景名映射到空白验收模式。调用方可以只说 `merge_initial_replay`、`merge_repair_replay`、`merge_report_only`、`single_long_task_final`、`heldout_test` 或 `smoke`，不用手动选择 `single / sequence / parallel`。
- `create-merge-long-task-pack.ts` 默认使用 `merge_initial_replay`，自动挂到 `merge-final-full-replay`。如果传 `--blank-acceptance-scenario merge_report_only`，会自动挂到非阻塞报告模式。只有显式传 `--blank-acceptance-mode` 时才覆盖自动路由。
- 未知 scenario 会 fail closed，防止拼错场景名后静默回退到错误模式。

\n

<!-- 原 README 行 973-1127 -->

## 2026-06-08: Phase 2 Post-Merge Validation Engine Hook

Multi-instance Phase 2 merge is now connected to the unified validation engine.

Previous behavior:

- `orchestrator/multi-instance/merger.ts` only checked that the merged skill output had a few required files such as `INDEX.md`, `CORE.md`, and `meta.json`.
- Validator profiles could define `validation.stage = "post_merge"`, and `smoke-validation-engine.ts` proved the stage runner worked, but the real merger did not invoke that stage.

Current behavior:

- After the merger writes `phase2-merge/output`, Phase 2 loads validator modules from the contributing training task specs.
- It selects every module whose metadata resolves to `stage: "post_merge"`.
- It runs those modules through `runValidationStage({ stage: "post_merge" })` with the merged skill directory exposed as `targetPaths[0]` and `expectedArtifacts[0]`.
- If no `post_merge` module is configured, Phase 2 logs a compatible `skipped` status and continues.
- If configured required modules fail, Phase 2 records the result path/summary in coordinator state and throws before train replay or held-out test begins.

State fields added to `merge-and-validate/coordinator-state.json`:

- `postMergeValidationStatus`: `passed`, `failed`, or `skipped`.
- `postMergeValidationResultPath`: path to `phase2-merge/post-merge-validation/stage-result.json` when a stage ran.
- `postMergeValidationSummary`: human-readable stage summary.

This keeps post-merge validation pluggable. Dataset-specific file layout checks, leakage checks, soft surface review, or other merged-skill validators should be attached through validator profiles instead of hardcoded in `merger.ts`.

---

## 2026-06-14: Hierarchical Merge Strategy In Unified Benchmark Orchestrator

## 2026-07-22: merge-as-opt 原生训练模式

`merge-as-opt` 现在明确区分两个不能混报的口径：

- `aggregate_only`：历史快速模式。把 AEV 单案例 skill 作为完整候选交给 SkillOpt `merge_patches()` 聚合，只能称“SkillOpt 聚合器实验”。
- `native_train`：先聚合 AEV skills 得到 warm-start，再把这份 warm-start 交给 SkillOpt 原生 `ReflACTTrainer`，完整运行真实 rollout、minibatch reflection、patch aggregate、rank/clip、apply、selection gate、rejected-step buffer、slow update 和 meta skill。

总控入口是 `config.json > mergeConfig.asSkillOpt.pipelineMode`。`native_train` 还必须显式配置数据集专用 `nativeTrainConfigPath`、真实 `nativeTrainSplitDir` 和材料目录；预检要求 train/validation split 均非空，错误路径在模型调用前 fail closed。训练阶段默认 `nativeTrainEvalTest=false`，避免训练时触碰 held-out test。

需要诚实记录：AEV skills 只负责形成 warm-start，之后的循环是 SkillOpt 原生训练；它不是把 AEV skill 文件伪装成论文 rollout trajectory。报告会分别保存 warm-start aggregate 与 native train 的 token/summary，禁止把两者混成“完全原生 SkillOpt 从空白初始化”的结果。

### Merge-only 输入血统绑定（2026-07-19）

`scripts/run-hierarchical-merge-only.ts` 默认仍兼容历史行为：按任务 ID 查找最新 campaign。对于存在重复重跑历史的数据集，新实验应显式传入 `--source-benchmark-run <benchmark-run-dir>`，让每个任务的状态和 campaignDir 严格来自该 benchmark 的 `orchestrator-state.json`，避免较新的失败重跑覆盖正式主线中已经验证成功的 campaign。

正式运行前可追加 `--preflight-only`。预检只生成并校验 `merge-only-input-summary.json` 与 `preflight-result.json`，检查 task-pack、split、任务数量、campaign/spec 对应关系和 pending skill 是否存在，不启动 merger 模型。

```powershell
bun auto-evolve/scripts/run-hierarchical-merge-only.ts `
  --task-pack-root "auto-evolve/task-packs/real-long-tasks/spreadsheetbench-learnbench" `
  --train-split "auto-evolve/task-packs/real-long-tasks/spreadsheetbench-learnbench/splits/train-skillopt-official.json" `
  --source-benchmark-run "auto-evolve/runtime-state/benchmark-runs/<source-run>" `
  --out "auto-evolve/runtime-state/hierarchical-merge-only/<merge-run>" `
  --merge-group-size 5 `
  --preflight-only
```

The benchmark orchestrator now supports a second merge strategy without adding a parallel runner.

Existing default behavior is unchanged:

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts ... --merge-strategy flat
```

To run tree-style skill merging, use the same orchestrator and switch only the merge strategy:

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts `
  --task-pack-root "auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench" `
  --train-split "auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench/splits/train-50.json" `
  --merge-strategy hierarchical `
  --merge-group-size 5 `
  --merge-input all `
  --failure-policy negative-evidence `
  --merge-grouping status-balanced `
  --hierarchical-local-replay level1 `
  --hierarchical-repair-attempts 1
```

Conceptually this supports flows like:

```text
50 single-case skills -> 10 group skills -> 2 cluster skills -> 1 final skill
```

Important semantics:

- Successful skills are positive method evidence.
- Failed / round-limit skills can be included as negative evidence or diagnostics, but must not be promoted as proven solution paths.
- The benchmark orchestrator now harvests an existing `pending-expert-package/current` from failed or round-limited campaigns when hierarchical merge includes failures. If that package is absent, the instance is explicitly downgraded to metadata-only diagnostics instead of silently pretending its skill was merged.
- 2026-06-22: SpreadsheetBench official SkillOpt train run was switched from Alibaba Qwen3.7 Plus to `minimax-cn-coding-plan/MiniMax-M2.7` because the Alibaba coding-plan token expired during training. MiniMax uses a dedicated adaptive profile with requested train concurrency 5. The bottom OpenCode gate starts from the last safe value and can now climb from 3 toward max 5 through AIMD after repeated successful calls; online backoff still applies on timeout/rate-limit/auth failures.
- Level-1 local replay tests only the cases that were originally successful inside that group.
- If a formerly successful case fails after group merge, the system may run one repair pass to restore the missed method.
- Repair policy is path-aware: `CORE.md` / `INDEX.md` are append-only; `casebook/*.md` can be rewritten; `meta.json` and `surface_contract.json` can be regenerated.
- Every hierarchical group output runs the same pluggable `post_merge` validation-engine stage used by the flat merger. If a configured required validator fails, the group is blocked before replay or upward merge.
- Higher-level merge currently merges upward without mandatory replay by default; final train replay and held-out test still use the existing Phase 3 validator path.

Relevant files:

- `orchestrator/multi-instance/hierarchical-merger.ts`
- `methods/recipes/multi-instance/prompts/hierarchical-merge-generic.md`
- `methods/recipes/multi-instance/prompts/hierarchical-merge-repair.md`
- `scripts/validate-append-only-skill-patch.ts`
- `scripts/run-benchmark-orchestrator.ts`
- `scripts/run-officeqa-pro-benchmark.ts`

OfficeQA wrapper environment variables:

```powershell
$env:OFFICEQA_PRO_MERGE_STRATEGY = "hierarchical"
$env:OFFICEQA_PRO_MERGE_GROUP_SIZE = "5"
$env:OFFICEQA_PRO_MERGE_INPUT = "all"
$env:OFFICEQA_PRO_FAILURE_POLICY = "negative-evidence"
$env:OFFICEQA_PRO_HIERARCHICAL_LOCAL_REPLAY = "level1"
$env:OFFICEQA_PRO_HIERARCHICAL_REPAIR_ATTEMPTS = "1"
```

### Direct Chat 单题筛选与结果分类

`scripts/run-direct-chat-eval.ts` 支持：

```text
--case-ids UID0006
--case-ids UID0001,UID0006
```

筛选在统一 Direct Chat runner 中执行。指定 UID 不存在时必须报错，禁止静默运行整个 split；实际 UID 会写入 `config.snapshot.json -> caseIDs`。

Direct Chat 失败至少要分成三类：

1. `validation`：材料完整、答案成功提取，但外部 product validator 判错。
2. `answer_extraction/output_truncation`：模型推理中已有明确最终值但旧提取器漏抓，或输出额度耗尽导致没有写出最终答案。
3. `missing_external_material`：题目明确要求额外公共数据源，但 task spec / source_docs 没有提供该材料。此类不能计作纯模型失败。

答案提取器只接受 `<answer>`、明确 final-answer 句和 “I will output/provide/return/go with” 这类强收口表达。长推理文本不会再用“最后一个数字”猜答案。思考模型必须保留足够输出预算，让其最终写出 `<answer>`；Qwen3.6-35B-A3B 当前为 `maxOutputTokens: 4096`。

对于输出额度耗尽但推理正文已经明确给出最终舍入值的情况，提取器也允许识别强语义收口形式，例如：

```text
rounded to the nearest ...: 32.703
39,482.0286 -> 39,482.03
```

不能把 `Total Value = ...`、页码、年份或任意最后一个数字当最终答案。历史运行若因提取器版本产生假失败，应保留原始 `summary.json`，另行记录修复后离线重放结果，不篡改历史原始响应。

Direct Chat 答案提取现在采用候选评分，而不是固定正则顺序。大致优先级是：

```text
完整 <answer> 标签
不完整但可恢复的 <answer> 标签
Final answer / 最终答案
I will output / return / provide
Rounded to nearest / 箭头后的最终值
The answer/result is
Average / difference / percent change
普通 sum
独立 JSON 或独立数字行
```

每题会保存：

```text
results/<model>/<case>/answer-extraction.json
```

其中包含：

- 最终选择的答案。
- 命中来源，例如 `answer_tag`、`rounded_result`、`arrow_result`。
- `high / medium / low` 置信度。
- 排名前 20 的候选值、分数和原文位置。

如果模型返回很长的推理文本，却没有任何可信的最终答案表达，系统不再把整段推理写入 `answer.txt` 交给 product validator，而是直接记录：

```text
errorCategory: answer_extraction
```

这样模型答错、验证器失败和答案提取失败可以分别统计。

---

\n

<!-- 原 README 行 2188-2411 -->

## 2026-07-01 可拔插 Merge Contract

Multi-instance flat merge / train-replay repair 现在采用“通用 prompt + 可拔插 merge contract”的结构。默认 `methods/recipes/multi-instance/prompts/merge.md` 与 `merge-repair.md` 必须保持数据集无关，不能写死 audit-point、OfficeQA、SpreadsheetBench、paper-review 等专用输出路径或领域模板。

任务差异通过 `auto-evolve/config.json > mergeConfig` 控制：

```json
"mergeConfig": {
  "contractsRoot": "task-packs/merge-contracts",
  "defaultContract": "generic/standard-skill-v1",
  "taskPackContracts": {
    "paper-review-learnbench": "paper-review/review-skill-v1"
  }
}
```

新增数据集时，优先新增小型 JSON contract，并在 `taskPackContracts` 中挂载；不要复制整份专用 merge prompt。Contract 负责说明 required files、文件职责、CORE headings、final product、repair policy 和禁止跨数据集污染词。合并器和修复器会把 contract 注入 prompt，并把 contract 文件加入只读权限。

分层合并 `--merge-strategy hierarchical` 也走同一套 contract。`mergeConfig.defaultHierarchicalPrompt` 和 `defaultHierarchicalRepairPrompt` 只控制分层合并流程本身；每一层 group 应该产出哪些文件、哪些字段、哪些文件可 append-only 或 rewrite，都由同一个 `mergeContractPath` 决定。这样 flat merge 和 hierarchical merge 不会再分裂成两套任务专用 prompt。

### Merge Acceptance Profile

合并后验收现在也有可拔插 profile 层。三层职责必须分开：

- `merge contract` 管最终 skill 长什么样。
- `merge generator` 管 flat / hierarchical 怎么合并。
- `merge acceptance profile` 管合并后验收到哪一步。

总控位置：

```json
"mergeConfig": {
  "defaultAcceptanceProfile": "repair_promote",
  "acceptanceProfiles": {
    "merge_only": {},
    "replay_report": {},
    "repair_promote": {},
    "final_replay": {},
    "strict_all_pass": {}
  }
}
```

CLI 可覆盖：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts ... --merge-acceptance-profile strict_all_pass
```

优先级从高到低是：

1. `--merge-acceptance-stages`
2. `--merge-acceptance-preset`
3. `--merge-acceptance-profile`
4. `mergeConfig.defaultAcceptanceProfile`
5. 旧字段 `mergeConfig.acceptancePreset`

大白话：以后想“只合并”“回撤一次就停”“repair 后作为新基线”“最后必须全量回撤全过”，优先换 profile，不要再复制 prompt 或写一份数据集专用合并脚本。Scorecard / final report 会记录实际使用的 `mergeAcceptanceProfile`、`mergeAcceptanceStages` 和 `mergeAcceptanceSuccessCriterion`。
## Blank Acceptance Diagnosis Profiles（2026-07-03）

空白 agent 验收失败后的诊断器现在也纳入总控配置。总控入口是 `config.json > blankAcceptanceConfig`：

```json
"blankAcceptanceConfig": {
  "enabled": true,
  "defaultDiagnosisProfile": "auto",
  "taskPackDiagnosisProfiles": {},
  "diagnosisProfiles": {
    "auto": { "mode": "auto", "enabledModules": ["single-case", "plan-replay", "infra-triage"] },
    "single-case": { "mode": "single_case", "enabledModules": ["single-case"] },
    "plan-replay": { "mode": "plan_replay", "enabledModules": ["plan-replay", "infra-triage"] }
  }
}
```

大白话：`blank_eval_plan` 控制“空白 agent 怎么验收”，`blankAcceptanceConfig` 控制“验收失败后诊断器怎么分析”。以前诊断器默认只像单题失败分析；现在它可以按 profile 识别多 case 回撤、合并后回撤、平台路径/validator 故障，并把这些区别明确反馈给 lead。

证据包 `blank-agent-evidence` 也新增了 `plan-replay.compact.json`。当 final acceptance 里出现 `blank_eval_plan` 的 `plan-result.json` 时，系统会自动生成安全摘要：总 case 数、通过数、失败数、失败 case id、每个失败 case 的摘要与 failureKind。这个摘要不包含 private answer，也不会把标准答案暴露给 blank agent。

新增烟测：

```powershell
bun run auto-evolve/scripts/smoke-blank-acceptance-diagnosis-profiles.ts
```

这个 smoke 不启动真实模型，只验证：总控 profile 可读取、诊断 prompt 会注入 plan-replay/infra-triage 规则、多 case 回撤证据能被压缩进可读证据包。

## Hierarchical Merge-As-Long-Task Pack Generation (2026-07-03)

`merge-as-long-task` now has a hierarchical pack-generation path controlled by `config.json > mergeConfig.asLongTask.hierarchical`.

Plain meaning: many single-case skills can be packed into level-01 merge long-tasks, those level-01 group skills can then be packed into level-02 merge long-tasks, and this repeats until one final merge task remains. A next-level row carries both `sourceCases` and `replayCases`, so a group skill can be one merge input while its blank replay still expands back to all original cases.

Current implemented boundary:
- Implemented: dataset/task-pack generation and no-model smoke tests.
- Not yet implemented: a live supervisor that starts all group campaigns, waits for real completions, then resumes the next level from actual completed outputs.

Key scripts:
```powershell
bun run auto-evolve/scripts/create-hierarchical-merge-long-task-pack.ts --task-pack-root <pack> --split <split.json> --campaign-manifest <manifest.json> --out-root <out>
bun run auto-evolve/scripts/smoke-hierarchical-merge-as-long-task-pack.ts
```

Validated smoke:
```powershell
bun --check auto-evolve/orchestrator/schema.ts auto-evolve/scripts/create-merge-long-task-pack.ts auto-evolve/scripts/create-hierarchical-merge-long-task-pack.ts auto-evolve/scripts/smoke-hierarchical-merge-as-long-task-pack.ts
bun run auto-evolve/scripts/smoke-hierarchical-merge-as-long-task-pack.ts
bun run auto-evolve/scripts/smoke-merge-as-long-task-pack.ts
```

## Hierarchical Merge-As-Long-Task Live Supervisor (2026-07-04)

分层 merge-as-long-task 现在从“只生成任务包”升级为“可独立执行的 live supervisor”第一版。

总控入口：

```json
"mergeConfig": {
  "asLongTask": {
    "hierarchical": {
      "levelPlanningMode": "until_one",
      "singleInputMode": "promote",
      "finalizationMode": "require_single_final",
      "watchPollMs": 10000,
      "watchMaxPolls": 720,
      "levels": []
    }
  }
}
```

大白话：
- `levelPlanningMode=until_one`：一直按配置合并，直到只剩 1 个 final skill。
- `levelPlanningMode=configured_levels`：只跑 `levels[]` 里列出的层；如果跑完还剩多个 skill，就按 `finalizationMode` 收尾或 fail closed。
- `levels[]`：可以指定每层自己的 `groupSize`、`groupConcurrency`、`blankReplayConcurrency`、surface profile 和 blank acceptance scenario。
- `groupConcurrency`：现在在 live supervisor 里真正控制“同一层同时跑几个 group campaign”，不再只是记录字段。
- `watchPollMs / watchMaxPolls`：控制 supervisor 多久检查一次已经在跑的 group campaign、最多观察多少次；真实任务可以等久一点，smoke 可以调短。
- `singleInputMode`：当输入只有一个 skill 时，默认 `promote`，不浪费模型再跑一次合并。

新增脚本：

```powershell
bun run auto-evolve/scripts/run-hierarchical-merge-long-task.ts --task-pack-root <pack> --split <split.json> --campaign-manifest <manifest.json> --out-root <out>
```

新增 smoke：

```powershell
bun run auto-evolve/scripts/smoke-hierarchical-merge-as-long-task-pack.ts
bun run auto-evolve/scripts/smoke-hierarchical-merge-live-supervisor.ts
```

当前边界：
- 已实现：per-level groupSize、fixed/configured levels、single-input promote/wrap/fail、live supervisor 并发队列、fake runner smoke。
- 已实现：每层完成后把 group skill 变成下一层输入，并保留 `sourceCases/replayCases`，最终 replay 仍能展开回原始 cases。
- 已实现：`run-benchmark-orchestrator.ts` 的 `mergeExecutionMode=long_task` 可选分支已经能调用分层/单层 merge long-task runner；默认仍是 `legacy_script`，旧合并链路不受影响。
- 2026-07-06 增强：live supervisor 会按 `baseSpecPath` 识别已有 group campaign，健康运行只 watch，`recovery_pending/stale/takeover` 才 resume；子进程退出后如果 campaign 仍在 watch/recovery，不会被误当成已完成。
- 2026-07-06 增强：`hierarchical-live-state.json` 和 `hierarchical-live-report.json` 会记录每个 group 的状态、campaignID、campaignDir、health、summary 和 `outputSkillPath`。最终 `finalSkillPath` 优先指向 campaign 转正后的 `pending-expert-package/current`，避免误指临时 workspace。
- 当前边界：`long_task` 分支的 held-out test 仍优先支持 `direct-chat`；如果需要旧式 `blank-opencode` 测试集验收，继续用 `legacy_script`，或后续补 coordinator-state 桥接。

## Blank Eval Plan Guardrails (2026-07-04)

Blank agent acceptance now has two execution families:

- `runBlankEval`: original single-case closed-book test.
- `runBlankEvalPlan`: multi-case closed-book replay with `single`, `sequence`, or `parallel` mode.

Important rule:

```text
mode=single must receive exactly one case.
multi-case replay must use mode=sequence or mode=parallel.
```

If `mode=single` receives multiple cases, the plan now fails closed and writes a normal `plan-result.json` / `evidence-bundle.json` instead of silently testing only the first case. This prevents a dangerous false pass where a "full replay" accidentally validates only one item.

The long-task `blank_eval_plan` adapter also preserves `stopOnFirstFailure` from either the validator contract or the plan JSON, so sequence replay can stop after the first real failure when that is the intended mode.

Path and filename guardrails:

- Duplicate replay case IDs fail closed before any blank agent runs.
- Empty case IDs or empty `specPath` fail closed with normal evidence files.
- Case run directories are always composed as `cases/<index>-<safe-case-id>` and verified to stay inside the plan run directory.
- Windows-reserved names such as `CON`, `AUX`, `NUL`, `COM1`, and `LPT1`, plus newlines and unsafe filename characters, are sanitized before directory creation.
- Relative `promptInlinePaths` in replay plans are resolved relative to the replay-plan file, not the terminal cwd.

Smoke:

```powershell
bun run auto-evolve/scripts/smoke-blank-eval-plan.ts
bun run auto-evolve/scripts/smoke-blank-eval-plan-spec.ts
```

## Merge Replay Policy (2026-07-06)

`single / sequence / parallel` are execution modes only. They decide how a selected batch of blank-agent cases runs, but they do not decide which cases should be tested next.

`merge-as-long-task` now mounts a replay policy above `blank_eval_plan`:

```json
"replayPolicy": {
  "strategy": "failures_then_regression",
  "statePath": "./materials/.blank-eval-replay-policy/merged-skill-blank-eval-plan.json"
}
```

Plain meaning:

- First pass tests the full replay set covered by the current merge group.
- If some cases fail, the next final-acceptance round tests only those failed cases.
- Once those failed cases pass, the same validator immediately regression-tests the previously passed/protected cases.
- If protected cases regress, those regressed cases become the next focused failed set.
- A merge group is accepted only when the focused failures pass and the protected regression set also passes.

This keeps the expensive blank-agent replay focused during repair, without losing the guarantee that previously successful cases were not broken.

The replay policy state must stay under the replay plan directory. Paths such as `../outside.json` or absolute paths that escape the plan directory are rejected before any state file is read or written.

Smoke:

```powershell
bun run auto-evolve/scripts/smoke-merge-replay-policy.ts
```

\n
