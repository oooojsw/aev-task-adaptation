# 2026-07-03 合并进入长程任务与 Blank Acceptance 统一设计方案

## 1. 这份方案解决什么问题

我们刚刚确认了一个核心偏差：旧图里把验证器画成了三块：

1. Lead / Merger 写完 skill 后的表面泛化验证器。
2. 空白 agent 做完单个任务后的产物验证器。
3. 合并完成后的训练集回撤验证器。

这个划分在“合并流程还是外部脚本”时勉强成立；但如果把“合并本身”也放进 long-task campaign，那么第 3 类不应该继续作为外部独立流程存在。

新的正确抽象是：

```text
Surface Validator
  检查 skill 本身：结构、泄露、格式、不可泛化内容。

Blank Acceptance Validator
  检查 skill 是否真的能教会空白 agent 完成任务。
  单 case 验收、顺序多 case 验收、并行多 case 回撤、测试集盲测，本质都是它的不同模式。
```

也就是说，旧图里的“合并后回撤验证器”应该收敛为 `Blank Acceptance Validator` 的一个变体，而不是第三套验证体系。

## 2. 当前系统已经有哪些底座

| 底座 | 当前状态 | 说明 |
|---|---|---|
| 单 case long-task campaign | 已有 | 能跑 planner / executor / worker / lead / reviewer / blank eval 多轮闭环。 |
| Surface Validator | 已有 | 支持 validator profile、surface generalization、skill structure profile。 |
| Blank Eval Sandbox | 已有 | 空白 agent 物理闭卷，只看 clean skill、材料、workspace。 |
| `blank_eval_plan` | 已有 | 支持 `single / sequence / parallel`，可以作为 long-task validator 挂载。 |
| Blank Acceptance Diagnosis Profile | 已有 | 支持 `single-case / plan-replay / infra-triage / auto`。 |
| 合并 prompt 通用化 | 部分已有 | flat / hierarchical prompt 已开始通用化，数据集差异通过 merge contract 注入。 |
| 合并验收策略 | 已有 | `merge_only / replay_report / repair_promote / final_replay / strict_all_pass` 已可配置。 |
| 旧合并脚本 | 已有 | `run-existing-campaigns-merge-replay.ts` 能跑合并、回撤、repair，但不是 long-task campaign。 |

## 3. 当前还缺什么

| 缺口 | 为什么重要 | 不补会怎样 |
|---|---|---|
| 合并任务还不是 long-task spec | 合并本身不能进入 worker/lead 多轮学习闭环 | 只能单次合并 + 单次 repair，不能像普通长程任务一样反复改进 |
| 合并输入还没有标准 task-pack 格式 | 25 个单 case skill、回撤清单、目标 contract 还不能被普通 long-task 直接消费 | 每次合并都要靠外部脚本拼参数 |
| Merger 还没作为 long-task executor/lead 产物 | 当前 merger 是外部多实例模块，不在 round 内被诊断和修正 | 合并失败证据不能完整进入 campaign working memory / exploration tree |
| 合并回撤结果还没完全作为 blank acceptance evidence | 旧脚本的 replay/repair 统计和 campaign 证据体系分开 | worker/lead 不能统一读取“空白验收失败证据”来修 skill |
| Blank Acceptance 模式还没在总控里表达清楚 | 单题、顺序、多题并行、strict/all-pass 等控制散在 spec/validator | 后续新增数据集容易再次写出第三套回撤逻辑 |

## 4. 新总体架构

合并进入 long-task 后，流程应变成：

```text
输入：多个单 case skill + 每个 case 的材料/spec + merge contract + replay plan
        ↓
Long-Task Campaign: Merge Task
        ↓
Round 内 Merger/Lead 写 merged skill
        ↓
Surface Validator
        检查 merged skill 是否结构正确、无泄露、满足 contract
        ↓
Blank Acceptance Validator
        用 blank_eval_plan 并行/顺序回撤多个 case
        ↓
失败证据进入 workers / diagnostician / lead
        ↓
下一轮继续修 merged skill
        ↓
直到 strict_all_pass 或达到 round 上限
```

大白话：以后“合并”也变成一道长程题。它的答案不是 `answer.json`，而是一份 `merged skill`。验收方式不是人工看，而是让一批空白 agent 拿这份 merged skill 回头做题。

## 5. 两类验证器的最终边界

### 5.1 Surface Validator

负责检查“教材本身有没有问题”。

| 检查内容 | 示例 |
|---|---|
| 文件结构 | 必须有 `INDEX.md`、`CORE.md`、`casebook/`、`surface_contract.json` 等。 |
| 表面泄露 | 不能写具体答案、任务 ID、私有答案路径、gold answer、reference answer。 |
| 格式约束 | 某些文件必须是 JSON，某些文件必须是 Markdown，某些章节必须存在。 |
| 数据集专用反作弊 | paper-review 禁止论文标题/作者/具体 rating 泄露；spreadsheet 禁止具体目标数值泄露。 |

它不负责判断空白 agent 最后做对没做对。

### 5.2 Blank Acceptance Validator

负责检查“教材能不能真的教会空白 agent”。

| 模式 | 用途 |
|---|---|
| `single` | 单个 case 的最终验收。 |
| `sequence` | 多 case 顺序验收，适合想快速遇错停止。 |
| `parallel` | 多 case 并行验收，适合合并后训练集回撤。 |
| `strict_all_pass` | 所有 case 都过才算成功。 |
| `allow_partial` | 允许产出报告，不作为硬成功门。 |
| `report_only` | 只统计，不阻断后续。 |

旧的“合并后回撤验证器”应该被表达为：

```json
{
  "type": "blank_eval_plan",
  "mode": "parallel",
  "successCriterion": "all_pass",
  "skillRootPath": "workspace/merged-skill",
  "planPath": "materials/replay-plan.json"
}
```

## 6. 数据结构设计

### 6.1 Merge-as-LongTask task-pack

新增一种 task-pack 生成方式，不一定先写大量业务代码，可以先用脚本生成：

```text
task-packs/real-long-tasks/<dataset>-merge-learnbench/
  tasks/
    merge-group-001/
      spec.json
      campaign.json
      materials/
        merge-inputs/
          case-001-skill/
          case-002-skill/
          ...
        replay-plan.json
        merge-contract.json
      workspace/
        merged-skill/
      expert-workspace/
```

其中：

- `merge-inputs/`：多个单 case skill，只读。
- `replay-plan.json`：告诉 `blank_eval_plan` 要回撤哪些 case。
- `merge-contract.json`：告诉 merger 最终 skill 要长什么样。
- `workspace/merged-skill/`：long-task 的目标产物。

### 6.2 replay-plan.json

建议格式：

```json
{
  "id": "spreadsheetbench-merge25-replay",
  "mode": "parallel",
  "concurrency": 5,
  "successCriterion": "all_pass",
  "cases": [
    {
      "id": "32438",
      "specPath": "../../spreadsheetbench-learnbench/tasks/32438/spec.json"
    }
  ]
}
```

注意：这个 plan 可以被系统读取，但不能原样暴露给 blank agent。每个 blank agent 仍然只拿自己那一道 case 的材料和 clean skill。

## 7. Long-task spec 设计

合并任务的 `completionValidators` 应该有两类：

```json
[
  {
    "id": "merged-skill-surface",
    "type": "validation_profile",
    "stage": "pre_blank",
    "target": "surface",
    "profileID": "spreadsheet/surface-generalization-v1",
    "blocking": true
  },
  {
    "id": "merged-skill-replay",
    "type": "blank_eval_plan",
    "placement": "completion_only",
    "mode": "parallel",
    "concurrency": 5,
    "successCriterion": "all_pass",
    "planPath": "materials/replay-plan.json",
    "skillRootPath": "workspace/merged-skill",
    "blocking": true
  }
]
```

这样合并是否成功，不再由外部脚本判定，而是由 long-task 自己的 completion gate 判定。

## 8. Worker / Lead 如何利用失败证据

当 `blank_eval_plan` 失败时，它应该产出统一 evidence：

```text
plan-result.json
evidence-bundle.json
summary.md
cases/<case-id>/blank-eval-result.json
cases/<case-id>/candidate-output
```

然后 campaign workers 读取的是压缩后的证据：

| worker | 应该看什么 |
|---|---|
| Failure worker | 哪些 case 失败，失败类型是什么。 |
| Success worker | 哪些 case 通过，它们依赖了 merged skill 的哪些规则。 |
| Forbidden path worker | 是否有试图读 private answer、历史路径、旧 workspace。 |
| Memory worker | 哪些经验应写入 CORE，哪些只应进 casebook。 |
| Lead | 根据 worker 结论修改 `workspace/merged-skill`。 |

诊断器不应该成为一个神秘独立系统；它本质上是“把 blank acceptance evidence 翻译成 lead 能用的修复建议”的 worker/profile。

## 9. 总控配置应该怎么表达

在 `auto-evolve/config.json` 里建议最终形成这种层次：

```json
{
  "blankAcceptanceConfig": {
    "defaultMode": "single",
    "modes": {
      "single-case": {
        "runner": "single"
      },
      "train-replay-parallel": {
        "runner": "blank_eval_plan",
        "mode": "parallel",
        "successCriterion": "all_pass"
      },
      "train-replay-report": {
        "runner": "blank_eval_plan",
        "mode": "parallel",
        "successCriterion": "report_only"
      }
    }
  },
  "mergeConfig": {
    "asLongTask": {
      "enabled": false,
      "groupSize": 25,
      "replayConcurrency": 5,
      "acceptanceMode": "train-replay-parallel"
    }
  }
}
```

短期可以不一次性改总控格式，但最终目标是：用户不需要记脚本名，只改总控就能决定“合并是不是作为 long-task 跑、回撤并发是多少、是否 strict all pass”。

## 10. 实施阶段

### Phase 1：只做数据集包装器

新增脚本：

```text
scripts/create-merge-long-task-pack.ts
```

输入：

- 已有 benchmark run。
- 已成功 case skill 清单。
- group size。
- merge contract。
- replay concurrency。

输出：

- 一个 merge-as-long-task task-pack。

这一阶段尽量不改 long-task 核心，只用现有 `blank_eval_plan`。

### Phase 2：跑第一个真实 merge campaign

用 SpreadsheetBench 的 25 个成功 skill 生成一个：

```text
spreadsheetbench-merge-learnbench/tasks/merge-group-001
```

然后直接跑：

```text
run-long-task-campaign --spec .../merge-group-001/campaign.json
```

目标：

- Merger/Lead 能产出 `workspace/merged-skill`。
- Surface validator 能先挡住泄露/结构问题。
- `blank_eval_plan` 能并行回撤 25 个 case。
- 失败证据能进入下一轮。

### Phase 3：把旧合并脚本降级为兼容工具

`run-existing-campaigns-merge-replay.ts` 以后只作为：

- smoke。
- 低成本快速检测。
- 旧实验兼容。

正式实验默认走 merge-as-long-task。

### Phase 4：把合并验收策略迁移到 Blank Acceptance Mode

旧的：

```text
mergeAcceptancePreset = repair_promote / strict_all_pass
```

长期应映射到：

```text
blankAcceptanceMode = train-replay-parallel / train-replay-strict / report-only
```

也就是说，验收策略不再是“合并器自己的私有配置”，而是 blank acceptance 的通用配置。

### Phase 5：支持分层 merge-as-long-task

第一层：

```text
25 个单 case skill -> 5 个 merge task
```

第二层：

```text
5 个 merged skill -> 1 个 merge task
```

每一层都是 long-task campaign，每一层都用同一套 surface + blank acceptance 验收。

## 11. 风险点和防护

| 风险 | 防护 |
|---|---|
| replay-plan 泄露给 blank agent | plan 只给系统 runner，不能放进 blank agent sandbox。 |
| merged skill 偷写答案 | Surface validator 必须在 blank_eval_plan 前执行。 |
| 多 case 回撤成本太高 | 支持 concurrency、failFast、reportOnly、sample mode。 |
| 合并任务无限修 | 仍然受 campaign maxRounds 控制。 |
| 旧合并脚本和新合并任务混淆 | README 和总控里明确：旧脚本是 compatibility/smoke，新模式是正式实验。 |
| worker 看不到多 case 失败全貌 | `plan-result.compact.json` 必须进入 blank acceptance evidence。 |

## 12. 成功标准

第一版真正完成时，应满足：

1. 能从已有 25 个单 case skill 自动生成一个 merge-as-long-task task。
2. 能用普通 long-task campaign 跑这个 merge task。
3. Round 内产出的 `workspace/merged-skill` 会先过 surface validator。
4. 然后 `blank_eval_plan` 并行跑 25 个空白 agent 回撤。
5. 失败证据进入 campaign workers / lead。
6. 下一轮能基于这些证据继续修改 `merged-skill`。
7. 最终用 `strict_all_pass` 判断 25/25 是否成功。

## 13. 一句话总结

这次方案的核心是：把旧图里“合并后回撤验证器”从第三套独立流程中拿掉，统一并入 `Blank Acceptance Validator`，让单题验收、合并回撤、测试集盲测都成为空白验收的不同模式；然后把“合并”包装成一个真正的 long-task campaign，让系统用同一套 surface gate + blank acceptance gate 多轮训练 merged skill，而不是继续依赖外部一次性合并脚本。

---

## 14. 补充设计：失败 case 如何进入下一轮

当前旧合并 repair 的真实逻辑是：

```text
initial replay 找到失败 case
        ↓
对每个失败 case：
  复制当前 mergedSkillDir -> attempt/draft-merged-skill
  repair agent 只允许读：失败 case 原任务、当前基线 skill、merge contract
  repair agent 只允许改：draft-merged-skill
  append-only check 通过后
  只对这个失败 case 回撤一次
  如果通过：state.mergedSkillDir = draft-merged-skill
```

迁移到 merge-as-long-task 后，不能丢掉这个优点。新的设计是：

1. `blank_eval_plan` 每轮结束时输出 `failedCases`。
2. 系统把失败 case 写入 `workspace/replay-failures/current.json`。
3. 同时保留完整多 case 结果到 `workspace/replay-failures/history/round-XXX.json`。
4. 下一轮 planner / lead / worker 只能优先处理 `current.json` 里的失败 case。
5. 如果本轮是 `strict_all_pass`，只要 `failedCases` 非空，completion gate 就失败，campaign 自动进入下一轮。

推荐失败清单格式：

```json
{
  "schema": "merge-replay-failures/v1",
  "round": 3,
  "sourcePlanResultPath": ".../blank-eval-plan.../plan-result.json",
  "baselineSkillPath": "workspace/merged-skill",
  "failedCases": [
    {
      "id": "52216",
      "failureKind": "product_failure",
      "summary": "blank agent wrote wrong answer.json",
      "caseResultPath": ".../cases/018-52216/result.json",
      "blankEvalRunDir": ".../cases/018-52216/blank-eval/..."
    }
  ],
  "passedCases": ["32438", "48365"],
  "infraFailedCases": [],
  "createdAt": "..."
}
```

大白话：失败 case 不应该只是 summary 里的文字，而应该成为下一轮的正式输入清单。下一轮不是盲目重合全部，而是围绕这些失败点修 merged skill。

## 15. 补充设计：只回撤失败 case 与最终全量回撤

这里要分两种验收模式，不能混在一起：

| 模式 | 下一轮回撤范围 | 用途 |
|---|---|---|
| `focused_failures` | 只回撤上一轮失败 case | 省钱，适合训练中间轮次快速修补。 |
| `full_replay` | 回撤全部训练 case | 最终确认，防止修了后面的 case 又弄坏前面的 case。 |

推荐规则：

```text
训练中间轮次：focused_failures
最终验收轮次：full_replay + strict_all_pass
```

也就是说，每轮 lead 修完 skill 后，可以先只用失败 case 做快速确认；如果失败 case 都修好了，再跑一次全量回撤。这个设计等价于旧 repair/promote 的思路，但进入 long-task 后变成更统一的 blank acceptance mode。

总控建议：

```json
"blankAcceptanceConfig": {
  "modes": {
    "merge-focused-failures": {
      "runner": "blank_eval_plan",
      "mode": "parallel",
      "caseSelection": "previous_failed_only",
      "successCriterion": "all_pass"
    },
    "merge-final-full-replay": {
      "runner": "blank_eval_plan",
      "mode": "parallel",
      "caseSelection": "all_cases",
      "successCriterion": "all_pass"
    }
  }
}
```

边界条件：

- 如果没有上一轮失败清单，却选择了 `previous_failed_only`，这是配置错误，必须 fail closed，不能悄悄跑 0 个 case 然后说成功。
- 如果 `caseSelection=previous_failed_only` 且上一轮失败清单为空，应该直接转入 `final_full_replay`，而不是继续 focused replay。
- 如果 `successCriterion=all_pass` 但 case 数为 0，必须失败，不允许 0/0 通过。

## 16. 补充设计：上一版 skill 如何传给下一版

长程合并任务里必须有一个“当前基线 skill”的固定路径，不能每轮到处找。

推荐目录：

```text
workspace/
  merged-skill/                 当前轮正在编辑的 skill
  baselines/
    round-001-before/
    round-001-after/
    round-002-before/
    round-002-after/
  replay-failures/
    current.json
    history/round-001.json
```

每一轮开始：

```text
如果 workspace/merged-skill 存在：
  它就是上一轮留下来的当前基线。
否则：
  从 materials/initial-merged-skill 或 merge-inputs 生成第一版。
```

每一轮结束：

```text
Surface 通过 + Blank Acceptance 通过：
  workspace/merged-skill 直接成为成功产物。

Surface 通过 + Blank Acceptance 失败：
  保留 workspace/merged-skill 作为下一轮基线。
  失败证据写入 replay-failures/current.json。

Surface 失败：
  不跑 blank agent。
  保留 workspace/merged-skill。
  失败证据写入 surface-failures/current.json。
```

这样下一轮不是重新合并，也不是丢掉旧 skill，而是在上一轮 `workspace/merged-skill` 的基础上继续改。

必须注意：

- `workspace/merged-skill` 是 long-task 的正式可编辑目标。
- `materials/merge-inputs/*` 是只读历史单 case skill。
- `pending-expert-package/current` 可以在 campaign 层同步最终候选，但合并任务内部的主产物应以 `workspace/merged-skill` 为准。
- Blank agent 验收时只能读 clean copy 后的 `workspace/merged-skill`，不能读 `baselines/`、`replay-failures/`、worker 记录。

## 17. 补充设计：多个长程任务产出的 skill 如何变成合并数据集

这一步需要一个正式的“合并数据集构建器”，不能靠手工复制。

输入：

```text
benchmark run 目录
  trainResults / orchestrator-state.json
  每个成功 campaign 的 pending-expert-package/current
  原 task-pack 的 tasks/<id>/spec.json
  原 split 文件
```

输出：

```text
task-packs/real-long-tasks/<dataset>-merge-learnbench/
  tasks/merge-group-001/
  tasks/merge-group-002/
  ...
```

构建规则：

1. 先枚举训练结果。
2. 根据配置选择输入：`success_only` / `failed_only` / `success_and_failed`。
3. 对每个 case 生成一条 manifest：

```json
{
  "id": "52216",
  "sourceTaskID": "52216",
  "sourceCampaignDir": "...",
  "skillRoot": ".../pending-expert-package/current",
  "originalSpecPath": ".../tasks/52216/spec.json",
  "status": "verified_success",
  "roundsUsed": 4,
  "evidenceSummaryPath": "..."
}
```

4. 按 `groupSize` 分组，比如 25 个一组。
5. 每组生成一个 merge long-task。
6. 每个 merge long-task 的 `materials/merge-inputs/` 只放该组的 skill 快照。
7. 每个 merge long-task 的 `materials/replay-plan.json` 指向该组对应的原始 case spec。

总控建议：

```json
"mergeConfig": {
  "mode": "legacy_script",
  "asLongTask": {
    "enabled": false,
    "sourceRun": "auto",
    "inputSelection": "success_only",
    "groupSize": 25,
    "grouping": "sequential",
    "replayScope": "group_cases",
    "replayConcurrency": 5,
    "surfaceProfileSet": "skill-structure-standard",
    "blankAcceptanceMode": "merge-final-full-replay"
  }
}
```

这里 `mode` 很重要：

| mode | 行为 |
|---|---|
| `legacy_script` | 完整保留现在的旧合并流程，走 flat/hierarchical merge + phase3 validate/repair。 |
| `long_task` | 生成 merge-as-long-task task-pack，然后用 campaign 跑合并。 |
| `both_smoke` | 两套都跑，只用于调试对比，正式实验不建议。 |

## 18. 补充设计：旧合并模式必须完整保留

这点是硬要求：新模式不能替换旧模式。

原因：

1. 旧模式成本低，适合 smoke。
2. 旧模式已经能复现实验中的旧结果。
3. 旧模式能快速判断合并 prompt / contract 是否明显坏掉。
4. 新 long-task merge 成本更高，适合正式训练，不适合每次都跑。

因此代码层必须保留两条入口：

```text
run-existing-campaigns-merge-replay.ts      旧合并/回撤/repair 脚本
run-long-task-campaign + merge task-pack    新长程合并模式
```

总控只能选择默认走哪条，不能删除旧入口。

## 19. 补充设计：Blank Acceptance 可拔插模式和配置互斥

空白验收模式必须可拔插，但不是所有组合都合法。

### 19.1 合法模式示例

| 场景 | runner | mode | case 数 | 合法性 |
|---|---|---|---:|---|
| 单 case 最终验收 | `single` | `single` | 1 | 合法 |
| 多 case 顺序验收 | `blank_eval_plan` | `sequence` | 2+ | 合法 |
| 多 case 并行回撤 | `blank_eval_plan` | `parallel` | 2+ | 合法 |
| 合并最终严格回撤 | `blank_eval_plan` | `parallel` | 2+ | 合法 |
| 测试集盲测 | `blank_eval_plan` | `parallel` | 1+ | 合法 |

### 19.2 必须禁止的组合

| 配置 | 问题 | 处理 |
|---|---|---|
| `mode=sequence` 但 case 数只有 1 | 没意义，通常说明用户想跑 single 却配置错 | 报 warning 或 fail closed，建议改 `single`。 |
| `mode=parallel` 但 case 数只有 1 | 不致命但配置不合理 | 允许降级为 `single`，但必须在结果里记录 autoDowngrade。 |
| `caseSelection=previous_failed_only` 但没有 previous failures | 没有输入，不能 0/0 通过 | fail closed 或自动切 final_full_replay，必须由 profile 明确。 |
| `successCriterion=all_pass` 且 case 数为 0 | 会产生虚假成功 | 必须失败。 |
| `successCriterion=min_pass_rate` 但未配置 `minPassRate` | 语义不完整 | 默认 1.0 或 fail closed，推荐 fail closed。 |
| `runner=single` 但配置了多个 cases | 会丢 case | 必须失败，不允许只跑第一条假装通过。 |
| `blankAcceptanceMode` 指向不存在 profile | 配置错 | 启动前失败。 |
| `long_task merge` 但没有 `mergeContract` | merger 不知道产物格式 | 启动前失败。 |
| `long_task merge` 但没有 replay plan | 没法验收 | 启动前失败。 |
| `legacy_script` 但配置了 long-task-only 字段 | 容易误会 | 忽略但写 warning 到 run config。 |

### 19.3 推荐新增配置校验器

新增一个纯校验函数：

```text
validateBlankAcceptanceMode(profile, caseCount, context)
```

职责：

- 在真正启动 OpenCode 之前发现错配。
- 把错误写成清楚的人话。
- 不允许“看起来跑了，其实什么都没验”。

## 20. 补充设计：失败证据进入下一轮时的权限边界

失败证据分两类：

| 证据 | 谁能看 | 谁不能看 |
|---|---|---|
| `plan-result.compact.json` | workers、lead、reviewer、merger | blank agent |
| 单 case blank eval runDir 摘要 | workers、lead | blank agent |
| private answer / validator private input | product validator | blank agent、surface validator、普通 skill writer |
| 失败 case 的原材料 | workers、lead、blank agent 当前 case | 其他无关 case 的 blank agent |

尤其注意：合并任务的 lead 可以看失败摘要和训练答案结果，因为 lead 要修 skill；但最终 blank agent 不能看这些证据。只要 blank agent 不看答案和历史证据，就不算泄露。

## 21. 补充设计：合并 long-task 的 Round 内工作图

一个 merge long-task 的工作图可以很简单，第一版不要过度复杂：

```text
unit-1: inspect-input-skills
  读取 merge-inputs 和 merge contract，总结共性/差异。

unit-2: draft-merged-skill
  生成或修改 workspace/merged-skill。

unit-3: self-check-surface
  自查文件结构和明显泄露。

completion validators:
  surface validator
  blank_eval_plan validator
```

如果 blank_eval_plan 失败，下一轮不需要重新 inspect 所有输入，而是：

```text
unit-1: inspect-replay-failures
unit-2: patch-merged-skill-on-current-baseline
unit-3: self-check-changed-areas
completion validators
```

这可以通过 prompt 和 `replay-failures/current.json` 控制，不必一开始写很复杂的动态 planner。

## 22. 补充设计：分层合并如何复用同一套机制

分层合并不是新系统，只是 merge-as-long-task 的递归使用：

```text
Level 1:
  单 case skill 25 个 -> merge-task-001 -> merged skill A
  单 case skill 25 个 -> merge-task-002 -> merged skill B

Level 2:
  merged skill A/B/C... -> merge-task-final -> final merged skill
```

每一层的输入 manifest 都一样，只是 `inputType` 不同：

```json
{
  "inputType": "case_skill" | "merged_skill",
  "skillRoot": "...",
  "sourceCases": ["..."]
}
```

Level 2 的 replay plan 可以有两种：

| replayScope | 说明 |
|---|---|
| `union_source_cases` | 回撤所有下层 skill 覆盖的原始 case，最严格。 |
| `sampled_source_cases` | 每个下层 merged skill 抽样回撤，省成本。 |

正式实验建议最终层必须 `union_source_cases + strict_all_pass`，中间层可以先用 sample/focused 模式省钱。

## 23. 补充设计：最小实现顺序

为了不要一次改爆，推荐下一步按这个顺序：

1. 只新增 `create-merge-long-task-pack.ts`，把已有成功 skill 打包成 merge long-task task-pack。
2. 增加 `blankAcceptanceConfig.modes` 的 schema 和校验，不改变旧默认。
3. 增加 `mergeConfig.mode = legacy_script | long_task`，默认仍是 `legacy_script`。
4. 用 SpreadsheetBench 25 个成功 skill 生成一个 merge task。
5. 跑一次真实 long-task campaign，验证它是否能产出 `workspace/merged-skill` 并触发 `blank_eval_plan`。
6. 再把失败清单写入下一轮工作区，验证第二轮能基于失败 case 修。
7. 最后才考虑分层自动调度。

## 24. 补充设计：验收标准

这次新设计真正算完成，不能只看“代码能跑”。必须至少通过这些 smoke/真实小测：

| 测试 | 要求 |
|---|---|
| config 校验 smoke | 非法 blank acceptance 组合会启动前报错。 |
| pack 生成 smoke | 25 个输入 skill 能生成 merge task-pack，路径都存在。 |
| sandbox smoke | blank agent 看不到 replay-failures、private answers、merge-inputs 全量历史。 |
| single merge campaign smoke | 一个 3-case 小组合并能跑进 blank_eval_plan。 |
| failure carryover smoke | 第一轮失败 case 会写入 `replay-failures/current.json`，第二轮 prompt 能看到。 |
| baseline carryover smoke | 第二轮是在上一轮 `workspace/merged-skill` 基础上改，不是重建。 |
| legacy compatibility smoke | 旧 `run-existing-campaigns-merge-replay.ts` 还能原样跑。 |

## 25. 补充后的最终大白话

新系统不是把旧合并删掉，而是多一条更正式的路：旧合并脚本继续保留，用来快速 smoke 和复现实验；正式研究时可以通过总控切到 `long_task` 合并模式，把多个单 case skill 自动打包成一个“合并长程任务”。这个合并任务每一轮都在上一版 `workspace/merged-skill` 上继续改，先过 surface 检查，再用可拔插的 blank acceptance 模式回撤；中间轮次可以只回撤失败 case 省钱，最终轮次必须全量回撤。所有失败证据会写成下一轮可读的正式输入，但不会暴露给 blank agent。

## 26. 补充设计：merge-as-long-task 的两道验证门如何挂载

这部分是对前面第 7 节的实现层修正：当前代码里真正可执行的 long-task validator 类型只有 `script`、`prompt_json`、`blank_eval_plan`。`validatorProfiles` 是可拔插包装层，会在 `loadLongTaskSpec()` 时展开成这些真实 validator。因此计划里写的 `type = validation_profile` 只能作为概念说明，落地时不要新增这个执行类型，优先使用现有的 `validatorProfiles + script / blank_eval_plan`。

### 26.1 第一门：Surface Validator

职责：检查合并后的 `workspace/merged-skill` 本身有没有作弊、结构错误、格式错误、路径泄露、答案泄露。

挂载位置：merge long-task 的 `completion_only` 阶段，必须在任何 blank agent 回撤之前运行。

推荐实现：

```json
{
  "validatorProfiles": [
    "skill-surface/standard-hard-v1",
    "spreadsheetbench/merge-surface-v1"
  ]
}
```

其中：

- `skill-surface/standard-hard-v1` 负责通用结构硬门，例如必须有 `INDEX.md`、`CORE.md`、`meta.json`、`casebook/` 等。
- `spreadsheetbench/merge-surface-v1` 或其他数据集专属 surface profile 负责该数据集的反泄露规则，例如禁止具体答案数字、private answer 路径、ground truth 字样、特定任务 ID、不可泛化的单题结论。
- 如果是 paper-review，就挂 `paper-review/surface-generalization-v2`；如果是 OfficeQA，就挂 OfficeQA 专属 surface profile；不同数据集可以各自有专门 profile，不需要强行写一个万能正则。

关键 spec 约束：merge long-task 必须把合并产物声明成 experience workspace，否则现有结构/泛化脚本找不到检查对象。

```json
{
  "targetPaths": [
    {
      "path": "./workspace/merged-skill",
      "role": "experience-workspace",
      "label": "merged-skill"
    }
  ]
}
```

权限规则：

- `validation.target = "surface"`
- `validation.stage = "pre_blank"`
- `validation.answerAccess = "none"`
- `validation.allowedAudiences` 只能包含 `lead`、`reviewer`、`merger`、`repair_agent`、`dashboard`、`audit`、`memory` 等系统/写 skill 的角色。
- 禁止包含 `blank_agent`。
- Surface validator 不能读 private answers，因为它的目的不是改卷，而是查 skill 表面是否作弊；让它读答案会增加“检查器自己把答案带入 skill 反馈链”的污染风险。

不挂载场景：

- 普通单题训练如果该数据集不启用 surface 分支，则不挂。
- 旧 `legacy_script` 合并 smoke 默认不强制挂新 merge surface，除非用户显式打开。
- 测试集盲测阶段不挂 surface 修 skill，因为测试集只评估，不训练、不修补。

### 26.2 第二门：Blank Acceptance Validator

职责：检查合并后的 `workspace/merged-skill` 是否真的能教会空白 agent。旧流程里的“合并后回撤验证器”在新抽象里就是这一门的多 case 模式。

挂载位置：merge long-task 的 `completion_only` 阶段，必须排在 Surface Validator 之后。

推荐实现：

```json
{
  "id": "merged-skill-train-replay",
  "type": "blank_eval_plan",
  "title": "Merged skill train replay with blank agents",
  "placement": "completion_only",
  "planPath": "./materials/replay-plan.json",
  "skillRootPath": "./workspace/merged-skill",
  "mode": "parallel",
  "concurrency": 5,
  "successCriterion": "all_pass",
  "required": true,
  "blocking": true,
  "validation": {
    "target": "regression",
    "stage": "train_replay",
    "answerAccess": "private_oracle",
    "allowedAudiences": [
      "lead",
      "reviewer",
      "merger",
      "repair_agent",
      "dashboard",
      "audit",
      "memory"
    ]
  }
}
```

这里的 `blank_eval_plan` 不是把答案交给 agent，而是系统层调度器。它会对 replay plan 里的每个 case 启动独立 blank eval sandbox。每个空白 agent 只看到：

- 当前 case 的原始材料；
- clean copy 后的 `workspace/merged-skill`；
- 自己的 `workspace/` 输出区。

每个空白 agent 不能看到：

- `private-answers`；
- `materials/replay-plan.json` 全量内容；
- `materials/merge-inputs/` 里的所有历史 skill；
- `workspace/replay-failures/`；
- 其他 case 的 blank eval 结果；
- worker、lead、validator 的历史证据。

产品验证器仍然使用每个原始 case spec 自己声明的 hard/soft product validators。也就是说，第二门不是新写一个“万能改卷器”，而是一个多 case blank eval 调度器：它负责把同一份 merged skill 发给多个空白 agent，再让每个 case 自己的产品验证器判分。

### 26.3 focused replay 与 final replay 的同一个接口

中间轮次为了省钱，可以把 `blank_eval_plan` 的 `planPath` 指向上一轮失败 case 生成的 focused plan：

```text
workspace/replay-failures/current.json
        -> 生成 materials/replay-plan.focused.json
        -> blank_eval_plan 只跑失败 case
```

最终验收必须切回全量 replay：

```text
materials/replay-plan.json
        -> blank_eval_plan 跑全部训练 case
        -> successCriterion = all_pass
```

因此建议总控里区分两个 mode：

```json
{
  "blankAcceptanceConfig": {
    "modes": {
      "merge-focused-failures": {
        "runner": "blank_eval_plan",
        "mode": "parallel",
        "caseSelection": "previous_failed_only",
        "successCriterion": "all_pass"
      },
      "merge-final-full-replay": {
        "runner": "blank_eval_plan",
        "mode": "parallel",
        "caseSelection": "all_cases",
        "successCriterion": "all_pass"
      }
    }
  }
}
```

### 26.4 合法性校验必须启动前完成

merge-as-long-task 生成 spec 或启动 campaign 前必须 fail fast：

- `Surface Validator` 的 `answerAccess` 不是 `none`：失败。
- 任意 validator 的 `allowedAudiences` 包含 `blank_agent`：失败。
- `workspace/merged-skill` 没在 `targetPaths` 标为 `experience-workspace`：失败。
- `blank_eval_plan` 的 `planPath` 不存在：失败。
- `blank_eval_plan` 的 `skillRootPath` 不存在或不是 `workspace/merged-skill`：失败。
- `runner=single` 但 replay plan 有多个 case：失败。
- `successCriterion=all_pass` 但 case 数为 0：失败。
- `caseSelection=previous_failed_only` 但没有 previous failures：不能静默 0/0 成功，必须失败或显式切到 final full replay。
- `mode=parallel` 但只有 1 个 case：可以降级成 single，但必须写入结果记录，不能假装是并行回撤。

### 26.5 总控开关建议

旧模式必须保留，新模式只在总控选择时启用：

```json
{
  "mergeConfig": {
    "mode": "legacy_script",
    "asLongTask": {
      "enabled": false,
      "surfaceProfileSet": "spreadsheetbench-merge-surface",
      "focusedBlankAcceptanceMode": "merge-focused-failures",
      "finalBlankAcceptanceMode": "merge-final-full-replay",
      "replayConcurrency": 5
    }
  }
}
```

大白话：这两个验证器不是全局常驻的。只有当我们把“合并”包装成一个长程任务时，才把 `surface profile` 和 `blank_eval_plan` 写进这个 merge task 的 spec。别的数据集、别的阶段是否挂载，由总控和 task-pack 自己决定，不能因为新增 merge-as-long-task 就挤掉原来的验证体系。
## 2026-07-03 Implementation Update

本轮已经把“合并也能作为长程任务跑”的第一层基础设施落地，旧合并流程没有删除，仍由总控配置决定走哪条路。

已完成：

- `config.json > mergeConfig.mode`：新增 `legacy_script / long_task / both_smoke`，默认仍是 `legacy_script`，不会挤掉旧流程。
- `config.json > mergeConfig.asLongTask`：新增合并长程任务参数，包括输入选择、组大小、回撤范围、回撤并发、表面验证 profile set、focused/final blank acceptance mode。
- `config.json > blankAcceptanceConfig.modes`：新增可执行空白验收模式。`single-case` 保留旧单题闭卷；`merge-final-full-replay` 和 `merge-focused-failures` 对应合并后的多题闭卷回撤。
- `task-packs/validator-profiles/merge-surface/standard-v1.json`：新增合并 skill 的通用表面泛化硬门，检查 merged skill 的结构、防私有答案路径、防 validator 私有产物、防 runtime 绝对路径。
- `scripts/create-merge-long-task-pack.ts`：新增生成器，把已有单 case skill + split + campaign manifest 打包成一个标准 long-task task-pack。它只生成数据集和 spec，不调用模型。
- `scripts/smoke-merge-as-long-task-pack.ts`：新增无模型烟测，生成 2 个假的 source skill，打包成 merge long-task，然后用 `loadLongTaskSpec()` 真加载生成 spec，确认验证器和 blank_eval_plan 都能挂载。

已验证：

```powershell
bun --check auto-evolve/orchestrator/schema.ts auto-evolve/scripts/create-merge-long-task-pack.ts auto-evolve/scripts/smoke-merge-as-long-task-pack.ts
bun run auto-evolve/scripts/smoke-merge-as-long-task-pack.ts
```

烟测结果：

```text
validators = skill-structure-hard, merge-surface-generalization-hard, merged-skill-blank-eval-plan
blank_agent is not included in validator allowedAudiences
generated spec loads successfully
```

当前边界：

- 本轮只完成“把合并输入变成 long-task 可跑数据集”的底座，不自动替代旧 benchmark 合并入口。
- `previous_failed_only` 需要上一轮 blank replay 的失败列表，生成器会 fail closed，不能在没有失败列表时假装能跑 focused repair。
- 旧流程仍用于正式合并；长程合并入口后续可以通过 `mergeConfig.mode=long_task` 接入 benchmark orchestrator。

## 2026-07-03 Robustness Update

本轮继续补强了 merge-as-long-task 生成器的“启动前失败”能力，目标是让错误配置在生成 task-pack 时就暴露，而不是等模型跑了几轮才发现。

新增防护：

- 输出目录保护：`scripts/create-merge-long-task-pack.ts` 只允许覆盖空目录或带 `dataset-summary.json.schema = merge-long-task-pack-summary/v1` 标记的旧生成目录。非空人工目录、源 task-pack、auto-evolve 根目录、当前工作目录等都会被拒绝。
- split/manifest 保护：split ID 重复、manifest ID 重复、split 中有 manifest 缺行，默认全部 fail closed。只有显式传 `--allow-missing-manifest-rows` 才允许过滤清单。
- 参数保护：`inputSelection` 只允许 `success_only / failed_only / success_and_failed` 及少量别名；`groupSize / maxGroups / replayConcurrency` 必须是正整数。
- profile 同步保护：生成 spec 时不再硬编码 `skill-structure-hard` 和 `merge-surface-generalization-hard`，而是读取真实 validator profile JSON，展开 `use` 后把实际 validator id 写入 `initialGraph.completion_validator_ids`。

已补烟测：

```powershell
bun run auto-evolve/scripts/smoke-merge-as-long-task-pack.ts
bun --check auto-evolve/orchestrator/schema.ts auto-evolve/scripts/run-benchmark-orchestrator.ts auto-evolve/scripts/smoke-merge-as-long-task-pack.ts
```

烟测覆盖：

- 正常生成 2 case merge long-task pack。
- 真实 `loadLongTaskSpec()` 后确认 profile validator 和 `blank_eval_plan` 都存在。
- 确认 `blank_agent` 不在 validator `allowedAudiences`。
- 确认初始图里的 completion validators 与真实加载后的 validators 对齐。
- 负向检查覆盖：未知 profile set、危险非空输出目录、manifest 缺行、split 重复 ID、manifest 重复 ID、非法 inputSelection、非法 groupSize、非法 replayConcurrency。

## 2026-07-03 Auto-Mount Update

本轮把“空白验收模式”从手动选择升级为按场景自动挂载。原因是实际场景就几种：单题最终验收、合并后全量回撤、合并 repair 后只回撤失败项、只报告不阻塞、测试集盲测、smoke。以后调用方优先传场景名，不直接关心 `single / sequence / parallel`。

新增总控：

```json
"blankAcceptanceConfig": {
  "autoMount": {
    "enabled": true,
    "rules": {
      "single_long_task_final": "single-case",
      "merge_initial_replay": "merge-final-full-replay",
      "merge_repair_replay": "merge-focused-failures",
      "merge_report_only": "merge-replay-report",
      "heldout_test": "merge-final-full-replay",
      "smoke": "merge-replay-report"
    }
  }
}
```

生成器行为：

- `scripts/create-merge-long-task-pack.ts` 默认场景是 `merge_initial_replay`，自动挂载 `merge-final-full-replay`。
- CLI 可传 `--blank-acceptance-scenario merge_report_only` 等场景。
- CLI 仍保留 `--blank-acceptance-mode`，它是显式覆盖，用于临时实验或回滚。
- 如果传了未知 scenario，生成器会 fail closed，不能静默回退。

新增烟测覆盖：

- 默认 scenario 必须是 `merge_initial_replay`。
- 默认 mode 必须自动挂成 `merge-final-full-replay`。
- `merge_report_only` 必须自动挂成 `merge-replay-report`，并且 blank eval plan 非阻塞。
- 未知 scenario 必须失败。
