# 2026-07-04 分层 merge-as-long-task 完整执行计划

## 1. 这份计划要解决什么

上一个阶段已经完成了“分层合并任务包生成”：

```text
25 个单 case skill
  -> level-01 生成 5 个 merge long-task
  -> level-02 生成 1 个 final merge long-task
```

但是目前还缺 4 个能力：

| 缺口 | 当前状态 | 本计划目标 |
|---|---|---|
| 每层任意配置 | 只能统一 `groupSize` 递归到 1 | 支持 level-01=5、level-02=3、level-03=2 这类 per-level 配置 |
| 真实启动/等待/续传 | 只生成 task-pack，不跑 campaign | 增加 live supervisor：启动每组 campaign、等待、恢复、进入下一层 |
| `groupConcurrency` 真正生效 | 已写入总控，但只是记录 | 每层按配置控制同时跑几个 group campaign |
| 固定层数 | 目前是自动合到 1，受 `maxLevels` 限制 | 支持 `until_one` 和 `configured_levels` 两种层数策略 |

大白话：现在系统能“排好考场”，但还不会“真的安排学生进考场、等考完、收卷、再安排下一轮考场”。这份计划就是把后半截补上。

## 2. 代码现状检查结果

### 2.1 已有分层生成器

文件：

```text
auto-evolve/scripts/create-hierarchical-merge-long-task-pack.ts
```

现在它做的事情：

1. 读取原始 split 和 campaign manifest。
2. 按统一 `groupSize` 生成 level-01 task-pack。
3. 读取 level-01 每组的 `input-manifest.json` 和 `replay-plan.json`。
4. 把 level-01 组 skill 整理成 level-02 输入。
5. 重复直到只剩一个最终 merge task。

当前限制：

- `groupSize` 是全局统一的。
- 没有 `levels[]`。
- 没有真实启动 campaign。
- `groupConcurrency` 不参与执行。
- 如果只剩 1 个输入，目前直接报错，尚未实现 promote/wrap 策略。

### 2.2 普通 merge-as-long-task 生成器

文件：

```text
auto-evolve/scripts/create-merge-long-task-pack.ts
```

现在已经支持：

- 输入是单 case skill。
- 输入是上层 group merged skill。
- manifest row 可以带 `sourceCases` 和 `replayCases`。
- 二级合并时，一个 group skill 可以作为一个输入，但 replay plan 展开回原始 cases。

这部分是后续 live supervisor 的数据基础，不需要推倒重来。

### 2.3 总控配置

文件：

```text
auto-evolve/config.json
auto-evolve/orchestrator/schema.ts
```

现在已经有：

```json
mergeConfig.asLongTask.hierarchical
```

但还缺：

- `levels[]`
- `levelPlanningMode`
- `singleInputMode`
- `finalizationMode`
- 每层独立 `groupConcurrency`
- 每层独立 `blankReplayConcurrency`
- 每层独立 `blankAcceptanceScenario`
- 每层独立 `replayScope`

### 2.4 现有 benchmark supervisor 可借鉴

文件：

```text
auto-evolve/scripts/run-benchmark-orchestrator.ts
```

已有成熟机制：

```text
todo   = 需要启动/恢复的任务
active = 当前外层自己启动并等待的子进程
watch  = 已由别的进程健康运行，外层只观察的 campaign
```

这套思路应该复用到分层 merge supervisor，而不是重新写一个简单 `Promise.all`。

原因：

- campaign 可能已经在跑。
- resume 可能秒退。
- ownerPID 可能假活。
- Windows 会 PID 复用。
- 用户可能中途停止再续传。

### 2.5 long-task campaign 启动入口

文件：

```text
auto-evolve/cli.ts
```

真实启动命令是：

```powershell
bun run auto-evolve/cli.ts run-long-task-campaign --spec <campaign.json>
```

恢复命令是：

```powershell
bun run auto-evolve/cli.ts resume-long-task-campaign --campaign <campaign-id> --spec <campaign.json>
```

生成的 merge task 目录里同时有：

```text
spec.json
campaign.json
```

supervisor 应该传 `campaign.json` 给 `--spec`，这和 benchmark 训练的单 case campaign 一致。

### 2.6 benchmark 里 long_task merge 还没接通

文件：

```text
auto-evolve/scripts/run-benchmark-orchestrator.ts
```

当前逻辑：

```text
mergeExecutionMode === "long_task" -> 直接 throw
```

也就是说：即使总控写 `mergeConfig.mode = long_task`，现在 benchmark 主流程仍然不会自动执行 long-task merge。这是后续必须接通的地方。

## 3. 总控配置设计

目标：所有策略优先从 `config.json` 控制，CLI 只做临时覆盖。

建议结构：

```json
{
  "mergeConfig": {
    "asLongTask": {
      "hierarchical": {
        "enabled": true,
        "levelPlanningMode": "until_one",
        "groupSize": 5,
        "maxLevels": 8,
        "groupConcurrency": 2,
        "blankReplayConcurrency": 5,
        "singleInputMode": "promote",
        "finalizationMode": "require_single_final",
        "levels": [
          {
            "level": 1,
            "groupSize": 5,
            "groupConcurrency": 5,
            "replayScope": "group_cases",
            "blankReplayConcurrency": 5,
            "blankAcceptanceScenario": "merge_initial_replay"
          },
          {
            "level": 2,
            "groupSize": 3,
            "groupConcurrency": 3,
            "replayScope": "union_source_cases",
            "blankReplayConcurrency": 5,
            "blankAcceptanceScenario": "merge_initial_replay"
          },
          {
            "level": 3,
            "groupSize": 2,
            "groupConcurrency": 1,
            "replayScope": "union_source_cases",
            "blankReplayConcurrency": 5,
            "blankAcceptanceScenario": "merge_initial_replay"
          }
        ]
      }
    }
  }
}
```

### 3.1 `levelPlanningMode`

| 值 | 含义 |
|---|---|
| `until_one` | 没有写死层数，按默认或最后一个 level 配置反复合并，直到剩 1 个 |
| `configured_levels` | 只跑 `levels[]` 明确列出的层数；跑完还不剩 1 个就按 `finalizationMode` 处理 |

### 3.2 `levels[]`

每一层可以单独控制：

- 这一层几个输入合成一组。
- 这一层同时跑几个 group campaign。
- 这一层空白回撤并发是多少。
- 这一层回撤范围是本组 cases 还是下层所有 source cases。
- 这一层使用哪个 blank acceptance scenario。

例子：

```text
25 个输入
level 1 groupSize=5 -> 5 个 group
level 2 groupSize=3 -> 2 个 group
level 3 groupSize=2 -> 1 个 final group
```

### 3.3 `singleInputMode`

当某层输入只有 1 个时怎么处理：

| 值 | 行为 |
|---|---|
| `promote` | 不再启动模型，直接把这个 skill 提升为最终 skill |
| `wrap` | 包装成 1 输入 merge task，仍跑 surface + blank replay |
| `fail` | 直接报错，避免误以为做了合并 |

默认建议：

```text
promote
```

### 3.4 `finalizationMode`

固定层数模式跑完后，如果还不是 1 个怎么办：

| 值 | 行为 |
|---|---|
| `require_single_final` | 必须只剩 1 个，否则失败 |
| `merge_remaining_to_one` | 额外自动开一层，把剩余全部合成 1 个 |
| `promote_best_effort` | 不建议正式实验用；只记录多个输出 |

正式实验建议：

```text
require_single_final
```

或者用户明确要求自动收尾时用：

```text
merge_remaining_to_one
```

## 4. 生成器改造计划

文件：

```text
auto-evolve/scripts/create-hierarchical-merge-long-task-pack.ts
```

### 4.1 增加 level plan resolver

新增逻辑：

```text
resolveLevelPlan(levelIndex, inputCount, hierarchicalConfig)
```

它负责决定当前层：

- groupSize
- groupConcurrency
- replayConcurrency
- replayScope
- blankAcceptanceScenario
- 是否 final level

规则：

1. 如果 `levels[levelIndex]` 存在，用它。
2. 如果不存在且 `levelPlanningMode=until_one`，复用最后一个 level 配置或全局默认配置。
3. 如果不存在且 `levelPlanningMode=configured_levels`，停止或按 `finalizationMode` 收尾。

### 4.2 支持每层不同 groupSize

当前代码：

```text
const groupSize = ... hierarchical.groupSize
while currentIDs.length > 1:
  createMergeLongTaskPack({ groupSize })
```

要改成：

```text
while currentIDs.length > 1:
  const levelPlan = resolveLevelPlan(...)
  createMergeLongTaskPack({ groupSize: levelPlan.groupSize })
```

### 4.3 支持固定层数

新增状态字段：

```json
{
  "levelPlanningMode": "configured_levels",
  "plannedLevels": 3,
  "actualLevels": 3,
  "finalizationMode": "require_single_final"
}
```

如果 `configured_levels` 跑完还剩多个 group：

- `require_single_final`：fail closed。
- `merge_remaining_to_one`：自动生成一层 final merge。
- `promote_best_effort`：只用于调试，不建议默认启用。

### 4.4 支持单输入 promote/wrap

当前：

```text
currentIDs.length === 1 && !finalGroup -> throw
```

改成：

- `promote`：写 `finalSkillPath` 指向该输入 skill。
- `wrap`：生成 1 输入 merge task，回撤照跑。
- `fail`：保留当前报错。

## 5. Live Supervisor 设计

建议新增文件：

```text
auto-evolve/orchestrator/hierarchical-merge-long-task/supervisor.ts
auto-evolve/scripts/run-hierarchical-merge-long-task.ts
```

也可以先只做脚本级 supervisor，后续再沉到 orchestrator。为了降低风险，建议：

```text
第一版：scripts/run-hierarchical-merge-long-task.ts
第二版：抽到底层 orchestrator/hierarchical-merge-long-task/
```

### 5.1 状态目录

每次真实运行写入：

```text
runtime-state/hierarchical-merge-long-task-runs/<run-id>/
  plan.json
  state.json
  levels/
    level-01/
      task-pack/
      queue-results.json
      groups/
        merge-group-001.json
        merge-group-002.json
    level-02/
      task-pack/
  final/
    merged-skill
```

### 5.2 `state.json` 样子

```json
{
  "schema": "hierarchical-merge-long-task-state/v1",
  "status": "running",
  "currentLevel": 1,
  "levels": [
    {
      "level": 1,
      "groupSize": 5,
      "groupConcurrency": 5,
      "status": "running",
      "groups": [
        {
          "groupID": "merge-group-001",
          "specPath": ".../campaign.json",
          "campaignID": "...",
          "campaignDir": "...",
          "status": "running",
          "outputSkillPath": null,
          "sourceCases": ["case-001", "case-002"]
        }
      ]
    }
  ],
  "finalSkillPath": null
}
```

### 5.3 队列模型

复用 benchmark supervisor 思想：

```text
todo   = 需要启动/恢复/接管的 group campaign
active = 当前 supervisor 启动并正在等待的子进程
watch  = 已经健康运行，只观察的 group campaign
```

任何健康运行的 campaign 不准塞回 todo 后让 resume 秒退。

### 5.4 真实启动逻辑

每个 group 对应一个生成出的：

```text
tasks/merge-group-xxx/campaign.json
```

启动：

```powershell
bun run auto-evolve/cli.ts run-long-task-campaign --spec <campaign.json>
```

恢复：

```powershell
bun run auto-evolve/cli.ts resume-long-task-campaign --campaign <campaignID> --spec <campaign.json>
```

### 5.5 如何判断 group 成功

成功条件不要只看进程 exit code。

优先判断：

1. campaign 终态是 `verified_success` 或等价成功状态。
2. 最终 skill 路径存在。
3. surface + blank replay 已通过。

输出 skill 路径优先级：

```text
1. campaignDir/pending-expert-package/current
2. taskDir/workspace/merged-skill
```

说明：

- `campaignDir/pending-expert-package/current` 更像 campaign 最终认可版本。
- `taskDir/workspace/merged-skill` 是生成任务里的工作区路径，可作为 fallback。

### 5.6 如何进入下一层

当某一层所有 group 都成功：

1. 收集每个 group 的 outputSkillPath。
2. 读取该 group 的 replay plan，拿到它覆盖的原始 cases。
3. 生成下一层 manifest：

```json
{
  "id": "level-01-merge-group-001",
  "sourceKind": "merged_skill",
  "skillRoot": "<group output skill>",
  "sourceCases": ["case-001", "case-002"],
  "replayCases": [
    {"id": "case-001", "specPath": ".../tasks/case-001/spec.json"}
  ]
}
```

4. 调用生成器生成下一层 task-pack。
5. 继续进入下一层 supervisor loop。

### 5.7 失败策略

`failedGroupPolicy`：

| 策略 | 行为 |
|---|---|
| `fail_fast` | 任一 group 真失败，整个分层合并停止 |
| `exclude_failed_group` | 不进入下一层，记录覆盖缺口 |
| `negative_evidence` | 把失败 group 作为负例信息带入下一层 |

正式实验默认：

```text
fail_fast
```

原因：合并目标是覆盖所有输入；随便丢组会让论文结果不好解释。

## 6. `groupConcurrency` 真正生效设计

当前 `groupConcurrency` 只是配置值。

live supervisor 要在每一层这样使用：

```text
effectiveGroupConcurrency =
  min(
    levelPlan.groupConcurrency,
    stageConcurrency.hierarchicalMerge,
    global safety cap
  )
```

说明：

- `groupConcurrency` 控制同一层同时跑几个 group campaign。
- 每个 group campaign 内部还会启动 blank eval plan。
- blank eval plan 内部并发由 `blankReplayConcurrency` 控制。
- 底层 OpenCodeGate 仍然是最终保护，防止 session 爆炸。

大白话：

```text
groupConcurrency = 同时开几个合并任务
blankReplayConcurrency = 每个合并任务验收时同时开几个空白 agent
OpenCodeGate = 最底层总闸门
```

这三个不能混为一个数字。

## 7. 接入 benchmark 总流程

当前 `run-benchmark-orchestrator.ts` 中：

```text
mergeExecutionMode === "long_task" -> throw
```

后续要改成：

```text
if mergeExecutionMode === "legacy_script":
  走旧 mergeReplayAndTest

if mergeExecutionMode === "long_task" && hierarchical.enabled:
  调 runHierarchicalMergeLongTaskSupervisor

if mergeExecutionMode === "long_task" && !hierarchical.enabled:
  调单层 merge-as-long-task supervisor

if mergeExecutionMode === "both_smoke":
  只生成/对照，不消耗模型
```

但第一版建议先做独立脚本，不立刻接主 benchmark：

```text
scripts/run-hierarchical-merge-long-task.ts
```

原因：

- 更容易 smoke。
- 不会影响现有训练/合并主线。
- 确认真跑稳定后，再把 benchmark 的 throw 替换成调用。

## 8. 断点续传设计

supervisor 必须支持：

```powershell
bun run auto-evolve/scripts/run-hierarchical-merge-long-task.ts --out-root <existing-run>
```

续传规则：

1. 如果 `state.json` 存在，先读 state。
2. 对每个 running/watch group 调 `readCampaignHealth`。
3. 健康的进入 watch。
4. stale/recovery_pending 进入 todo resume。
5. verified_success 的直接作为下一层输入。
6. 只在当前层全部完成后生成下一层。

不允许：

- 新建一个同 label 的新 run。
- 忽略已有 level 结果。
- 把 running campaign 当已经处理完。

## 9. 边界条件

### 9.1 输入数量小于 groupSize

```text
输入 3 个，groupSize=5
```

行为：

- 如果输入 >1：生成 1 个 merge group。
- 如果输入 =1：按 `singleInputMode`。

### 9.2 固定层数跑完仍剩多个

```text
25 -> groupSize 4 -> 7
只配置 1 层
```

行为：

- `require_single_final`：失败。
- `merge_remaining_to_one`：自动收尾。
- `promote_best_effort`：只调试用。

### 9.3 某层产生 0 个成功 group

直接失败。不能进入下一层。

### 9.4 某层有失败 group

按 `failedGroupPolicy`。

正式默认 fail_fast。

### 9.5 已经健康运行的 group

进入 watch，不进入 todo。

### 9.6 resume 秒退

不能当完成。

如果 resume 返回 watch_live，放回 watch。

### 9.7 OpenCodeGate 并发耗尽

supervisor 只负责 group 并发；底层 gate 仍负责 session 总闸门。

如果 gate 满，group campaign 会等待，不应判失败。

## 10. 测试计划

### 10.1 生成器 smoke

新增/扩展：

```text
smoke-hierarchical-merge-as-long-task-pack.ts
```

覆盖：

- 25 -> 5 -> 1
- 25 -> 5 -> 2 -> 1
- per-level groupSize: [5, 3, 2]
- configured_levels 跑完没剩 1 个时 fail closed
- singleInputMode=promote
- singleInputMode=wrap

### 10.2 supervisor fake runner smoke

新增：

```text
smoke-hierarchical-merge-supervisor.ts
```

不启动模型，用 fake runner 模拟：

- group 成功。
- group 失败。
- group stale 后 resume。
- watch_live 不退出。
- level-01 完成后生成 level-02。
- level-02 完成后写 finalSkillPath。

### 10.3 真实小样本 smoke

只在用户明确下令后跑：

```text
SpreadsheetBench 已成功 skill 前 10 个
groupSize=5
level-01: 2 groups
level-02: 1 final
groupConcurrency=1 或 2
blankReplayConcurrency=1
```

先低并发，确认状态机和断点续传，再提高并发。

## 11. 实施顺序

### Step 1：扩展 schema/config

文件：

```text
auto-evolve/orchestrator/schema.ts
auto-evolve/config.json
```

增加：

- `levelPlanningMode`
- `levels[]`
- `singleInputMode`
- `finalizationMode`
- per-level group config normalizer

### Step 2：扩展生成器

文件：

```text
auto-evolve/scripts/create-hierarchical-merge-long-task-pack.ts
```

实现：

- per-level groupSize
- configured_levels
- until_one
- singleInputMode
- finalizationMode

### Step 3：新增 live supervisor 独立脚本

文件：

```text
auto-evolve/scripts/run-hierarchical-merge-long-task.ts
```

第一版先独立可用：

- `--task-pack-root`
- `--split`
- `--campaign-manifest`
- `--out-root`
- `--resume`
- `--dry-run`

### Step 4：新增 supervisor 状态文件

状态文件：

```text
state.json
plan.json
level-results.json
```

要求：

- 可断点续传。
- 可人工检查。
- 不依赖内存。

### Step 5：fake runner smoke

先保证逻辑对，不烧额度。

### Step 6：接入 benchmark 主流程

把：

```text
mergeExecutionMode === "long_task" -> throw
```

替换为：

```text
runHierarchicalMergeLongTaskSupervisor(...)
```

但只在：

```text
mergeConfig.asLongTask.hierarchical.enabled = true
```

时走分层 supervisor。

### Step 7：真实小样本 smoke

只跑 10 个或 25 个已成功 skill，低并发，确认链路。

## 12. 本轮最重要的原则

1. 不删旧 merge。
2. 不改旧 hierarchical merge 默认行为。
3. 新 live supervisor 必须能独立跑，也能后续接入 benchmark。
4. 所有配置优先走总控文件。
5. 真实运行必须可断点续传。
6. 健康运行的 campaign 只能 watch，不能被 todo 消耗掉。
7. 二级及以上的 replay 必须展开回原始 cases，而不是只测 group skill。

一句话总结：下一步不是再写一个“聪明合并器”，而是把现在已经生成好的分层 merge long-task 任务包，接上一个真正可靠的 supervisor，让它能按总控配置决定每层怎么分、同时跑几个、跑几层、怎么续传，并最终把多层结果稳定收敛成一个 final skill。

## 13. 2026-07-04 实施记录

本轮已完成 Patch 1：

| 项 | 状态 | 说明 |
|---|---|---|
| 总控 schema/config | 已完成 | `mergeConfig.asLongTask.hierarchical` 新增 `levelPlanningMode`、`singleInputMode`、`finalizationMode`、`levels[]`。 |
| per-level 生成 | 已完成 | `create-hierarchical-merge-long-task-pack.ts` 支持每层不同 `groupSize/groupConcurrency/blankReplayConcurrency/blankAcceptanceScenario`。 |
| 固定层数 | 已完成 | 支持 `configured_levels`；配置层结束但未收敛时按 `finalizationMode` 处理。 |
| 单输入处理 | 已完成 | 支持 `promote/wrap/fail`，默认 `promote`，避免只有一个 skill 时浪费模型。 |
| live supervisor 独立脚本 | 已完成第一版 | 新增 `scripts/run-hierarchical-merge-long-task.ts`，能逐层生成 task-pack、按 `groupConcurrency` 并发跑 group runner、上一层结束后生成下一层输入。 |
| fake runner smoke | 已完成 | 新增 `scripts/smoke-hierarchical-merge-live-supervisor.ts`，不调用模型，验证并发上限和层级推进。 |

本轮 smoke：

```powershell
bun run auto-evolve/scripts/smoke-hierarchical-merge-as-long-task-pack.ts
bun run auto-evolve/scripts/smoke-hierarchical-merge-live-supervisor.ts
```

结果：

```text
生成器 smoke：25 -> 5 -> 2 -> 1，通过；最终 replay 仍覆盖 25 个原始 case。
live supervisor smoke：10 -> 2 -> 1，通过；fake runner 最大并发=2，未超过配置。
```

仍需后续补的点：

1. 把独立 live supervisor 接入 `run-benchmark-orchestrator.ts` 的 `mergeExecutionMode=long_task` 分支，替换当前 throw。
2. live supervisor 当前第一版主要验证逐层执行和并发；后续要把 benchmark supervisor 的 `todo/active/watch`、`readCampaignHealth`、resume/takeover 逻辑完整迁入，做到真实断点续传和健康 watch。
3. `replayScope` 目前进入 per-level plan 和 summary，但单组生成器仍沿用安全默认“组内原始 case 展开”；如果以后要真正支持 `sampled_source_cases/union_source_cases` 的差异行为，需要继续接入 `create-merge-long-task-pack.ts`。

一句话复盘：本轮把“分层合并怎么分、每层并发多少、固定跑几层、只有一个输入怎么办”从纸面计划变成了可执行脚本和可验证 smoke；下一步主要是把这个独立执行器接进 benchmark 主流程，并增强真实运行中的 watch/resume。
