# 2026-07-03 分层 merge-as-long-task 设计

## 1. 这份文档解决什么问题

当前 `merge-as-long-task` 已经能把一批已有单 case skill 打包成一个“合并长程任务”，让系统在 long-task campaign 内产出一个 `merged-skill`，再用两道门验收：

- Surface Validator：检查 skill 表面是否泄露答案、结构是否合规、是否写死具体案例。
- Blank Acceptance Validator：把 merged skill 发给空白 agent，回测对应案例，验证它是否真的能用。

但现在的 `merge-as-long-task` 主要是“一次性把 N 个 skill 合成 1 个”。它还没有把旧分层合并里的：

```text
25 个单 case skill
  -> 第一层：5 个一组，得到 5 个小组 merged skill
  -> 第二层：再把 5 个 merged skill 合成最终 1 个 skill
```

自然接进 long-task campaign。

这份设计的目标是：**不新增新的合并哲学，不再写一套专门合并 prompt，而是递归复用当前 merge-as-long-task，把分层合并变成一组可调度的长程任务。**

## 2. 核心原则

### 2.1 合并仍然由两道门逼出来

分层合并不要依赖“聪明合并 prompt”。每一层都只做最小任务定义：

```text
输入：若干个 source skill
输出：一个新的 merged skill
验收 1：surface 不能泄露、不能结构乱
验收 2：blank agent 回测必须过
```

如果 surface 不过，说明 skill 写得太像小抄或格式不合规。

如果 blank agent 不过，说明 skill 虽然没作弊，但还没教会空白 agent。

系统就在这两个门中间自动拟合。

### 2.2 分层合并不是新系统

分层合并只是 `merge-as-long-task` 的递归调度：

```text
Level 1:
  group-001: case skill 1-5    -> merged skill A
  group-002: case skill 6-10   -> merged skill B
  group-003: case skill 11-15  -> merged skill C
  group-004: case skill 16-20  -> merged skill D
  group-005: case skill 21-25  -> merged skill E

Level 2:
  final-group-001: A/B/C/D/E -> final merged skill
```

每个 group 都是一个普通 long-task campaign。

每个 group 自己有 surface gate、blank replay、失败证据、下一轮修复。

### 2.3 旧合并模式必须保留

现在系统里已经有三条合并路径：

| 路径 | 保留原因 |
|---|---|
| legacy flat merge | 快速 smoke、兼容旧实验 |
| legacy hierarchical merge | 旧分层脚本已有实用价值 |
| merge-as-long-task | 新的正式研究路线，把合并本身纳入 long-task 学习 |

本设计只新增第四种调度方式：

```text
hierarchical merge-as-long-task
```

它不删除旧合并，不改变旧默认行为。通过总控配置选择。

## 3. 总体流程

以 25 个输入 skill、每组 5 个为例：

```text
输入：25 个已经训练出的单 case skill
  |
  |-- Level 1 任务分发
  |     group-001: 5 个 skill -> long-task campaign -> merged skill A
  |     group-002: 5 个 skill -> long-task campaign -> merged skill B
  |     group-003: 5 个 skill -> long-task campaign -> merged skill C
  |     group-004: 5 个 skill -> long-task campaign -> merged skill D
  |     group-005: 5 个 skill -> long-task campaign -> merged skill E
  |
  |-- Level 1 每组局部回撤
  |     每组只回撤自己覆盖的 5 个原始 case
  |     如果失败，只针对失败 case 做下一轮修复
  |     每组独立结束，产出一个通过本组验收的 group merged skill
  |
  |-- Level 2 最终合并
        输入：A/B/C/D/E 五个 group merged skill
        输出：final merged skill
        先跑全局回撤：覆盖全部 25 个原始 case
        如果有失败，只对失败 case 做 focused replay 修复
        最后可以不再跑第二次全局回撤，按配置决定
```

用户当前想要的是：

```text
第一层：每组 5 个，自己回撤自己的 5 个。
第二层：5 个 group skill 合成 1 个，先全局回撤，再只回撤错误的。
最后不用再次全局回撤。
```

这对应旧策略里的：

```text
repair_promote
```

而不是：

```text
strict_all_pass
```

## 4. 数据如何从单个长程任务进入分层合并

### 4.1 单个长程任务输出什么

每个原始 case campaign 成功后，至少要提供：

```text
case id
case spec path
case task pack root
case skill root
status: verified_success / failed / round_limit_reached ...
round count
surface result
blank acceptance result
campaign dir
```

这些信息已经在 benchmark manifest / orchestrator state / campaign.json / pending package 路径中存在。

分层合并只需要把它们整理成一个统一 manifest。

### 4.2 Level 1 输入 manifest

第一层每组 manifest 里每行是一个单 case skill：

```json
{
  "schema": "merge-hierarchical-input/v1",
  "level": 1,
  "groupID": "level-01-group-001",
  "inputType": "case_skill",
  "items": [
    {
      "id": "32438",
      "sourceKind": "case_skill",
      "skillRoot": ".../pending-expert-package/current",
      "specPath": ".../spreadsheetbench-learnbench/tasks/32438/spec.json",
      "status": "verified_success",
      "sourceCases": ["32438"],
      "replayCases": ["32438"]
    }
  ]
}
```

大白话：第一层每个输入就是“某道题训练出来的一份 skill”。

### 4.3 Level 2 输入 manifest

第二层每行不再是单 case skill，而是第一层的 group merged skill：

```json
{
  "schema": "merge-hierarchical-input/v1",
  "level": 2,
  "groupID": "level-02-group-001",
  "inputType": "merged_skill",
  "items": [
    {
      "id": "level-01-group-001",
      "sourceKind": "merged_skill",
      "skillRoot": ".../level-01-group-001/workspace/merged-skill",
      "sourceCases": ["32438", "48365", "52216", "55060", "6239"],
      "replayCases": ["32438", "48365", "52216", "55060", "6239"],
      "levelResultPath": ".../level-01-group-001/result.json"
    }
  ]
}
```

大白话：第二层每个输入是“第一层某个小组学出来的一份综合 skill”，但它还必须携带自己覆盖了哪些原始 case。

## 5. 每一层的验收怎么跑

### 5.1 Level 1：局部回撤

每个 Level 1 group 只回撤自己负责的 5 个 case。

例如：

```text
level-01-group-001 输入 5 个原始 skill
replay plan 也只包含这 5 个原始 case
```

它的 blank eval plan 是：

```json
{
  "schema": "auto-evolve-blank-eval-plan/v1",
  "cases": [
    {"id": "32438", "specPath": ".../tasks/32438/spec.json"},
    {"id": "48365", "specPath": ".../tasks/48365/spec.json"}
  ]
}
```

如果 5 个里有 2 个失败：

```text
失败 case -> replay-failures/current.json
下一轮只围绕这 2 个修 skill
focused blank replay 只跑这 2 个
```

如果 focused replay 过了，这个 group merged skill 就可以作为 Level 2 输入。

### 5.2 Level 2：全局回撤 + 失败定向修复

Level 2 的输入是 5 个 group merged skill。

但 Level 2 的 replay plan 不是只跑 5 个 group，而是展开到全部原始 case：

```text
group skill A 覆盖 case 1-5
group skill B 覆盖 case 6-10
...
final replay plan = case 1-25
```

先跑一次全局回撤：

```text
final merged skill -> blank agents -> 25 个原始 case
```

如果失败 4 个：

```text
失败 case 4 个 -> replay-failures/current.json
下一轮只 focused replay 这 4 个
```

用户当前设计是：**focused 修复过后，最后不用再强制跑一次全局回撤。**

也就是说 Level 2 默认策略是：

```text
initial full replay
  -> if failures:
       one or multi-round focused repair
       focused replay passed => promote
  -> stop
```

如果以后需要更严，可以切换成：

```text
initial full replay
  -> focused repair
  -> final full replay
  -> strict all pass
```

## 6. 失败 case 怎么进入下一轮

每次 blank_eval_plan 结束后，系统必须产出一个标准失败清单：

```json
{
  "schema": "merge-replay-failures/v1",
  "level": 2,
  "groupID": "level-02-group-001",
  "round": 3,
  "baselineSkillPath": "./workspace/merged-skill",
  "sourceReplayPlanPath": "./materials/replay-plan.json",
  "failedCases": [
    {
      "id": "52216",
      "failureKind": "product_failure",
      "summary": "blank agent produced wrong output",
      "specPath": ".../tasks/52216/spec.json",
      "blankEvalRunDir": ".../blank-eval-runs/...",
      "caseResultPath": ".../cases/52216/result.json"
    }
  ],
  "passedCases": ["32438", "48365"],
  "infraFailedCases": []
}
```

下一轮 planner / worker / lead 读取这个文件。

它不需要猜“哪些失败了”，也不需要从长日志里挖。

大白话：**失败 case 要从日志文字变成正式输入文件。**

## 7. 上一版 skill 如何传给下一版

长程合并任务必须始终有一个固定路径：

```text
workspace/merged-skill
```

每一轮都在这个路径上继续改，而不是重新生成一份新目录再丢给下一轮猜。

推荐内部结构：

```text
workspace/
  merged-skill/                 当前基线，下一轮直接继续改
  merged-skill-history/
    round-001/
    round-002/
  replay-failures/
    current.json
    history/
      round-001.json
      round-002.json
```

每轮开始：

```text
读取 workspace/merged-skill 作为当前基线
读取 replay-failures/current.json 作为本轮重点
```

每轮结束：

```text
如果 surface + blank acceptance 通过：
  workspace/merged-skill 就是新基线
如果失败：
  失败信息写入 replay-failures/current.json
  下一轮继续基于同一个 workspace/merged-skill 修
```

## 8. Core 单增、casebook 可重写怎么保持

用户要求：

```text
CORE / INDEX 这类核心文件：append-only，不能随便改旧内容。
casebook 具体案例文件：可以全量修改。
```

这个规则应该作为合并长程任务的一个 surface/patch policy validator，而不是写死在 prompt 里。

推荐规则：

| 区域 | 策略 |
|---|---|
| `CORE.md` | append-only |
| `INDEX.md` | append-only 或 limited-edit，按 contract 决定 |
| `casebook/*.md` | rewrite allowed |
| `patches/*.md` | append-only |
| `meta.json` | rewrite allowed，但必须保留 provenance |
| `surface_contract.json` | rewrite allowed，但必须通过结构 validator |
| `open_observations.md` | append-only |

执行方式：

```text
每轮结束时，比较本轮前后的 workspace/merged-skill
如果 CORE 删除或改写旧段落 => surface/patch policy fail
如果 casebook 修改 => 允许
```

大白话：**规则不是靠提醒 agent 乖一点，而是靠验证器卡住。**

## 9. 分层任务调度器怎么设计

需要一个上层调度器，不是新的合并器。

它只负责：

```text
1. 收集输入 skill
2. 按 groupSize 分组
3. 为每组生成 merge-as-long-task task pack
4. 并发启动这些 long-task campaign
5. 等它们结束
6. 收集每组输出 skill
7. 生成下一层输入
8. 直到只剩一个 final skill
```

调度器自己不判断 skill 好坏。

skill 好坏仍由每个 long-task 内部的：

```text
surface validator + blank_eval_plan
```

判断。

### 9.1 调度状态文件

推荐每次分层合并生成一个根目录：

```text
runtime-state/hierarchical-merge-long-task/<run-id>/
  plan.json
  state.json
  level-01/
    group-001/
    group-002/
  level-02/
    group-001/
  final/
    merged-skill -> 指向/复制最终输出
```

`state.json` 示例：

```json
{
  "schema": "hierarchical-merge-long-task-state/v1",
  "status": "running",
  "currentLevel": 1,
  "levels": [
    {
      "level": 1,
      "groupSize": 5,
      "groups": [
        {
          "groupID": "level-01-group-001",
          "campaignID": "...",
          "status": "running",
          "outputSkillPath": null,
          "sourceCases": ["32438", "48365"]
        }
      ]
    }
  ]
}
```

### 9.2 并发控制

有两层并发：

| 并发 | 含义 |
|---|---|
| group campaign 并发 | 同时跑几个合并长程任务 |
| blank replay 并发 | 每个合并长程任务内部同时跑几个 blank agent |

例如用户说“并发五”时必须明确：

```text
第一层 group campaign 可以 5 并发；
每个 group 内部 blank replay concurrency 也可能是 5；
但底层 OpenCodeGate 必须统一限流，避免实际 opencode session 爆炸。
```

建议总控字段：

```json
{
  "mergeConfig": {
    "asLongTask": {
      "hierarchical": {
        "enabled": true,
        "groupSize": 5,
        "groupConcurrency": 5,
        "blankReplayConcurrency": 5,
        "levels": "until_one"
      }
    }
  }
}
```

## 10. 每层验收策略怎么配置

需要把不同层的验收策略分开：

```json
{
  "mergeConfig": {
    "asLongTask": {
      "hierarchical": {
        "levelPolicies": {
          "intermediate": {
            "initialReplay": "group_cases",
            "repairReplay": "failed_cases_only",
            "finalReplay": "none",
            "acceptance": "repair_promote"
          },
          "final": {
            "initialReplay": "union_source_cases",
            "repairReplay": "failed_cases_only",
            "finalReplay": "none",
            "acceptance": "repair_promote"
          }
        }
      }
    }
  }
}
```

如果以后想变严格：

```json
"final": {
  "initialReplay": "union_source_cases",
  "repairReplay": "failed_cases_only",
  "finalReplay": "union_source_cases",
  "acceptance": "strict_all_pass"
}
```

## 11. 和旧 hierarchical merge 的一一对应

| 旧 hierarchical merge | 新 hierarchical merge-as-long-task |
|---|---|
| `runCoordinatorHierarchicalMerge()` 分组 | 新调度器分组 |
| `runMergeGroup()` 单次合并 | 每组启动一个 merge long-task campaign |
| `runLocalSuccessReplay()` 组内回撤 | 每组 long-task 内部 blank_eval_plan 回撤 |
| `runOneShotRepair()` 单次修复 | campaign 下一轮基于 replay-failures/current.json 修 |
| append-only policy check | surface/patch policy validator |
| post_merge validation | surface validator |
| level outputDir | group campaign 的 `workspace/merged-skill` |
| itemFromGroup() | 下一层 manifest 的 `sourceKind=merged_skill` |

核心区别：

```text
旧系统：脚本自己合并、自己 repair。
新系统：脚本只分发任务；合并和 repair 都发生在 long-task campaign 内。
```

## 12. 边界条件

### 12.1 输入不足一组

如果输入少于 groupSize，但大于 1：

```text
仍然可以生成一个 merge group。
```

如果输入只有 1 个：

```text
可以直接 promote 这个 skill 为最终 skill，不必启动合并任务。
但如果要求统一过 surface + blank replay，也可以包装成 1 输入 merge task。
```

### 12.2 某个 Level 1 group 失败

如果某个 group 达到 maxRounds 仍失败：

根据配置决定：

| 策略 | 行为 |
|---|---|
| `fail_fast` | 整个分层合并失败 |
| `exclude_failed_group` | 不进入下一层，但记录覆盖 case 缺失 |
| `negative_evidence` | 把失败 group 作为 negative evidence 进入下一层 |

正式实验建议默认：

```text
fail_fast
```

否则最终 skill 覆盖范围会不完整，论文里不好解释。

### 12.3 focused repair 没有失败 case

如果配置要求 `previous_failed_only`，但失败列表为空：

```text
不能 0/0 成功。
应该直接跳过 focused replay，并把当前 skill promoted。
```

### 12.4 infra failure

如果 blank replay 失败是 infra：

```text
不应该让 lead 改 skill。
应该进入平台修复/重试路径。
```

比如：

- candidate file not found 是路径错误；
- validator crashed 是验证器基础设施错误；
- OpenCode spawn failed 是运行基础设施错误。

这些不能混进 `failedCases` 当作产品失败。

## 13. 实施顺序建议

### Phase 1：只做文档和配置设计

本文件就是 Phase 1。

先不要急着改代码，避免把旧合并、当前真实训练和 merge-as-long-task 搅在一起。

### Phase 2：生成器支持多组输出

增强 `create-merge-long-task-pack.ts` 或新增一个包装脚本：

```text
输入 25 个 skill
groupSize=5
输出 5 个 merge task
```

这个阶段不需要递归，只要 Level 1。

### Phase 3：调度器跑 Level 1

新增/扩展一个 supervisor：

```text
启动 5 个 merge long-task campaign
等待全部结束
收集 5 个 outputSkillPath
```

### Phase 4：生成 Level 2

把 Level 1 的 5 个输出 skill 打包成新的 merge task：

```text
inputType=merged_skill
sourceCases=五组的 union
replayPlan=全部 25 个原始 case
```

### Phase 5：策略化验收

支持：

```text
intermediate: group_cases + failed_cases_only repair + no final replay
final: union_source_cases + failed_cases_only repair + no final replay
```

### Phase 6：严格模式

以后再支持：

```text
final: union_source_cases + failed_cases_only repair + final union replay + strict all pass
```

## 14. 最小 smoke 测试

### 14.1 无模型生成 smoke

构造 6 个假 skill：

```text
groupSize=3
Level 1 -> 2 个 group
Level 2 -> 1 个 final group
```

验证：

- 每组 manifest 正确；
- Level 2 输入能携带 Level 1 的 sourceCases；
- replay plan 能展开到原始 case；
- 输出目录不覆盖源 task-pack；
- 旧合并入口不受影响。

### 14.2 假 validator smoke

用 mock blank_eval_plan：

- 第一次 replay 人为失败 2 个 case；
- 确认 replay-failures/current.json 生成；
- 第二轮 focused plan 只包含这 2 个；
- focused pass 后 promoted。

### 14.3 真实小样本 smoke

用 SpreadsheetBench 前 10 个成功 skill：

```text
groupSize=5
Level 1: 2 个 group
Level 2: 1 个 final group
```

先只跑 report_only，确认链路。

再跑 blocking 模式。

## 15. 最终效果

实现后，系统会形成这样的能力：

```text
单 case 长程任务训练出很多小 skill
  ↓
分层调度器把它们按组变成多个 merge long-task
  ↓
每个 merge long-task 自己通过 surface + blank replay 拟合出小组 skill
  ↓
小组 skill 再作为下一层输入继续 merge-as-long-task
  ↓
最终得到一个 final merged skill
  ↓
整个过程不靠专门合并 prompt 作弊，而靠两道验证门逼出结果
```

最重要的是：

**合并不再是外部脚本的一次性动作，而是和普通长程任务一样，成为可以多轮失败、多轮诊断、多轮修复、可断点续传、可被统一看板管理的正式训练任务。**

## 16. 2026-07-03 implementation status

This phase implemented the platform-level pack generation path, not a real model-consuming campaign run.

Implemented:
- `config.json > mergeConfig.asLongTask.hierarchical` now has a dedicated config block for recursive merge-as-long-task defaults.
- `orchestrator/schema.ts` now loads and validates that hierarchical config without changing legacy merge defaults.
- `scripts/create-merge-long-task-pack.ts` now supports next-level merged-skill rows. A manifest row can carry `sourceCases` and `replayCases`, so a level-2 merge input can be "one group skill" while its blank replay still expands to the original cases.
- `scripts/create-hierarchical-merge-long-task-pack.ts` now generates recursive level task packs: level-01 groups, then level-02 input manifest from level-01 group outputs, repeating until one final merge task remains.
- `scripts/smoke-hierarchical-merge-as-long-task-pack.ts` verifies the 25 -> 5 -> 1 data flow without calling a model.

Validated:
- `bun --check auto-evolve/orchestrator/schema.ts auto-evolve/scripts/create-merge-long-task-pack.ts auto-evolve/scripts/create-hierarchical-merge-long-task-pack.ts auto-evolve/scripts/smoke-hierarchical-merge-as-long-task-pack.ts`
- `bun run auto-evolve/scripts/smoke-hierarchical-merge-as-long-task-pack.ts`
- `bun run auto-evolve/scripts/smoke-merge-as-long-task-pack.ts`

Important boundary:
- This implementation generates the hierarchical long-task datasets and proves the replay-plan data flow.
- It does not yet start real group campaigns, wait for real completions, or perform live cross-level resume. That remains the next supervisor phase.
