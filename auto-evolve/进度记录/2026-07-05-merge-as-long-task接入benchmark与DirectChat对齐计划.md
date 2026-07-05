# 2026-07-05 merge-as-long-task 接入 benchmark 与 Direct Chat 对齐计划

## 0. 目标

本计划只做设计梳理，当前不改代码。

用户明确要求：

- 统一续传模块先不做，先把停止/续传经验写进 `AGENTS.md`。
- 保留原有合并链路，新的 `merge-as-long-task` 只能作为可选模式。
- 先看清楚 `merge-as-long-task 接入 benchmark` 是什么。
- 分层 `merge-as-long-task live supervisor` 需要重新设计清楚。
- Direct Chat 停止/续传不优先做，因为单轮评测成本低。
- Direct Chat adapter 先对照 SkillOpt 原项目实现，再决定怎么补。

## 1. 当前系统真实状态

### 1.1 旧合并链路

旧链路仍然是主路径，默认配置是：

```text
config.json > mergeConfig.mode = legacy_script
```

流程是：

```text
训练单 case skill
-> legacy merge 脚本合并
-> train replay / repair / final replay / test
```

这条链路必须完整保留，不能被新链路替换掉。

### 1.2 新 merge-as-long-task 链路

新链路的目标是把“合并 skill”本身也变成一个长程任务：

```text
多个单 case skill
-> 生成一个 merge task-pack
-> 启动 long-task campaign
-> agent 产出 workspace/merged-skill
-> 表面泛化验证
-> 空白 agent 多 case replay
-> replay 失败进入下一轮修 skill
```

现在已经有的零件：

- `scripts/create-merge-long-task-pack.ts`
- `scripts/create-hierarchical-merge-long-task-pack.ts`
- `scripts/run-hierarchical-merge-long-task.ts`
- `scripts/smoke-merge-as-long-task-pack.ts`
- `scripts/smoke-hierarchical-merge-live-supervisor.ts`
- `config.json > mergeConfig.asLongTask`
- `config.json > mergeConfig.asLongTask.hierarchical`

但 `run-benchmark-orchestrator.ts` 当前还没有正式接入。

目前代码中如果选择：

```text
mergeConfig.mode = long_task
```

主入口会直接报错：

```text
mergeConfig.mode=long_task is configured but automatic benchmark execution is not enabled yet.
```

所以现在是：

```text
可以手动生成/手动跑 merge long-task
但不能在 benchmark 主流程里自动训练后接上
```

## 2. “merge-as-long-task 接入 benchmark”到底是什么

它不是再写一个新的独立脚本，而是让统一 benchmark 主入口在训练结束后，按配置选择合并方式。

目标形态：

```text
run-benchmark-orchestrator.ts
  -> training
  -> if mergeConfig.mode == legacy_script:
       走旧合并
     if mergeConfig.mode == long_task:
       自动生成 merge task-pack
       自动启动 merge campaign
       自动监督/续传/等待
       拿 final merged skill 继续后续 replay/test
     if mergeConfig.mode == both_smoke:
       只做对照烟测，不作为正式主线
```

关键要求：

- `legacy_script` 必须保持默认。
- `long_task` 只能显式配置或 CLI 指定时启用。
- 新链路不能污染旧链路产物。
- 新链路的输出必须写回 benchmark state，让后续阶段知道 merged skill 在哪里。
- 如果 long-task merge 没完成，benchmark 不能假装 merge 完成。

## 3. 分层 merge-as-long-task live supervisor 设计

### 3.1 为什么需要 live supervisor

分层合并不是一次性合并所有 skill，而是：

```text
25 个单 case skill
-> 第 1 层：5 个一组，跑 5 个 merge campaign
-> 得到 5 个 group skill
-> 第 2 层：5 个 group skill 合成 1 个 final skill
```

问题是，每个 group 本身都是一个 long-task campaign，可能出现：

- 已经健康运行
- stale running
- recovery_pending
- round_limit_reached
- verified_success
- 子进程秒退
- ownerPID 假活
- 用户中途停止后续传

所以不能简单 `Promise.all` 启动一堆进程就算完。

### 3.2 正确 supervisor 模型

应该复用 benchmark training 的思想：

```text
todo   = 需要启动/恢复/接管的 group campaign
active = 当前 supervisor 自己启动并等待的子进程
watch  = 已经由别的进程健康运行，supervisor 只观察
done   = 已成功产出 group skill
failed = 终态失败或策略放弃
```

退出当前 level 的条件必须是：

```text
todo 为空
active 为空
watch 为空
所有 group 都进入 done 或 failed
```

不能因为某个 resume 秒退就把 group 当处理完。

### 3.3 每层执行流程

每一层应该这样跑：

```text
读取当前层输入 skills
-> 按 groupSize / levels[] 切组
-> 为每组生成 merge long-task spec
-> 对每组 classify：
     没跑过 -> todo.start_new
     recovery_pending/stale -> todo.resume
     healthy running -> watch
     verified_success -> done
     terminal failed -> failed
-> 按 groupConcurrency 启动 todo
-> 周期检查 active/watch
-> group 完成后收集 workspace/merged-skill
-> 如果本层只剩一个 skill，结束
-> 否则把本层 done skill 生成下一层 manifest
```

### 3.4 分层配置

总控文件中已经有雏形：

```text
mergeConfig.asLongTask.hierarchical.enabled
mergeConfig.asLongTask.hierarchical.levelPlanningMode
mergeConfig.asLongTask.hierarchical.groupSize
mergeConfig.asLongTask.hierarchical.groupConcurrency
mergeConfig.asLongTask.hierarchical.levels[]
```

推荐语义：

```text
levelPlanningMode = until_one
  按默认 groupSize 或 levels[] 逐层合到 1 个 skill。

levelPlanningMode = configured_levels
  只跑 levels[] 指定的层数；如果最后不剩 1 个，按 finalizationMode 处理。

singleInputMode = promote
  某层只有 1 个输入时直接提升，不浪费模型。

finalizationMode = require_single_final
  配置层跑完后如果还不是 1 个 final skill，直接失败。
```

### 3.5 失败策略

第一版建议保守：

```text
failedGroupPolicy = fail_fast
```

原因：

- merge-as-long-task 本身还在变成正式链路。
- 先保证不会把半残 skill 静默送到下一层。
- 后面可以扩展为：
  - record_negative
  - promote_verified_only
  - retry_failed_groups
  - include_failed_as_negative_evidence

## 4. 表面验证与空白验收在新合并链路里的位置

merge-as-long-task 里面仍然只有两个核心控制力：

```text
表面泛化验证器
空白 agent 产物验证器 / replay 验收器
```

流程是：

```text
agent 写 merged skill
-> surface validator 检查 merged skill 是否结构正确、是否泄漏答案、是否写死 case
-> surface 过了才启动 blank replay
-> blank replay 用多个空白 agent 验证 merged skill 能否教会原始 cases
-> replay 失败变成 long-task completion validator 失败
-> 下一轮 campaign 根据失败证据修 merged skill
```

也就是说，新链路不应该写一堆任务专用合并 prompt 来强控结果。

正确控制方式是：

```text
通用合并任务说明 + 可拔插 merge contract + 可拔插 surface validator + 可拔插 blank replay validator
```

## 5. Direct Chat 与 SkillOpt 对齐检查

### 5.1 SkillOpt 不是一个统一 Direct Chat 脚本

SkillOpt 的 Direct Chat / no-tools 逻辑藏在各 benchmark adapter 里。

OfficeQA 关键文件：

```text
C:\Users\ZhuanZ\Desktop\SkillOpt\skillopt\envs\officeqa\rollout.py
C:\Users\ZhuanZ\Desktop\SkillOpt\skillopt\envs\officeqa\tool_runtime.py
C:\Users\ZhuanZ\Desktop\SkillOpt\configs\officeqa\default.yaml
```

OfficeQA 默认配置：

```text
search_mode: offline
workers: 4
max_tool_turns: 24
max_completion_tokens: 16384
data_dirs:
  - data/officeqa_docs_official
```

### 5.2 SkillOpt OfficeQA 的几种模式

从 `rollout.py` 看，它至少有几条路径：

```text
offline + local tools
  模型可用 glob/read/grep 工具查本地 parsed 文档。

offline + no local tools
  单次 chat，system 里放 skill，user 里放 question + oracle parsed pages + hints。

custom_search
  模型多轮输出 <search_queries>，控制器返回搜索证据。

azure_search
  使用模型内置搜索。

exec backend
  Codex/Claude Code 类工具型 agent。
```

论文里的 Direct Chat 更接近：

```text
offline + no local tools
```

也就是：

```text
system = 通用 OfficeQA 指令 + skill
user = question + oracle parsed pages + source hints
单次模型回答 <answer>...</answer>
```

### 5.3 我们现在的 Direct Chat 和 SkillOpt 的差异

我们自己的 Direct Chat 已经有：

- provider module
- skill bundle
- dataset bundle
- prompt audit
- OCR fallback
- error category
- master report
- OfficeQA adapter
- generic adapter

但是和 SkillOpt 对齐还有差异：

| 项 | SkillOpt | 我们当前 |
|---|---|---|
| OfficeQA 文档材料 | 主要用 official parsed docs / oracle parsed pages | 支持 native PDF、oracle-json、OCR fallback |
| Direct Chat 形态 | benchmark adapter 内部实现 | 独立 direct-chat runner |
| 多数据集 adapter | 每个 env 自己实现 rollout | 现在只有 officeqa 专用，其它多是 generic |
| 答案格式 | `<answer>...</answer>` | 已支持 `<answer>`，也有 fallback 提取 |
| 结果汇总 | predictions/results | 有 summary/master xlsx |

结论：

```text
我们不是完全复用了 SkillOpt Direct Chat。
我们是参考了它的思路，并额外做了一个通用 direct-chat 平台。
如果要和 SkillOpt 论文公平对齐，OfficeQA 应优先提供 skillopt-oracle-json / oracle parsed pages 模式。
```

## 6. Direct Chat adapter 待补清单

当前代码中：

```text
adapterID = officeqa | spreadsheetbench | alfworld | generic
```

但真实专用程度是：

| adapter | 当前状态 |
|---|---|
| officeqa | 专用程度最高 |
| spreadsheetbench | 只识别名字，实际走 generic |
| alfworld | 只识别名字，实际走 generic |
| generic | 通用兜底 |
| searchqa | 没有专用 adapter |
| docvqa | 没有专用 adapter |
| livemath | 没有专用 adapter |

后续优先级：

1. OfficeQA：先和 SkillOpt oracle parsed pages 模式对齐，确保论文对照公平。
2. SpreadsheetBench：做专用 adapter，把 Excel workbook preview / sheet / formula / task instruction 压成稳定文本。
3. LiveMath：做选择题/数学题专用 adapter。
4. SearchQA：做检索证据/问题上下文专用 adapter。
5. DocVQA：做图片/PDF 多模态材料 adapter。
6. ALFWorld：如果要 direct-chat，只能做“状态+动作规划”的弱评测，不等价于真实环境交互。

## 7. 下一步建议

### 7.1 优先改造项

第一优先级：

```text
把 merge-as-long-task 正式接入 run-benchmark-orchestrator.ts，但默认仍是 legacy_script。
```

第二优先级：

```text
把分层 merge-as-long-task live supervisor 改成 todo/active/watch 模型。
```

第三优先级：

```text
Direct Chat 先只对齐 SkillOpt OfficeQA oracle parsed pages 模式，其他 adapter 暂缓。
```

### 7.2 不建议现在做

暂不做：

- 全局统一续传模块。
- Direct Chat 复杂停止/续传。
- 给每个数据集复制一份专用 merge prompt。
- 把新 long_task 合并设为默认。

## 8. 一句话总结

现在最重要的是：旧合并继续保留为默认主链，新 `merge-as-long-task` 作为可选模式接入 benchmark；分层版本要用真正的 live supervisor 管理每层 group campaign；Direct Chat 不要急着扩所有数据集，先确认并复刻 SkillOpt OfficeQA 的 oracle parsed pages 单轮评测方式，避免实验口径不一致。

## 9. 2026-07-05 第一版代码落地结果

已经完成的最小改造：

- `run-benchmark-orchestrator.ts` 不再在 `mergeExecutionMode=long_task` 时直接报“未实现”。
- 新增 benchmark 内部的 `merge-as-long-task` 可选分支。
- 旧链路 `legacy_script` 完整保留，默认仍走旧链路。
- 新分支会从当前训练结果写出：
  - `merge-as-long-task/_benchmark-inputs/campaign-manifest.json`
  - `merge-as-long-task/_benchmark-inputs/split.json`
- 新分支会调用 `runHierarchicalMergeLongTask(...)` 生成并运行 merge long-task。
- 新分支会把最终 `finalSkillPath` 写回：
  - `orchestrator-state.json > merge.mergedSkillDir`
  - `merge-output.json`
- 非分层 long-task merge 目前被安全地包装成“单个 merge group”，不会悄悄产出多个半成品。

当前保守边界：

- `legacy_script` 仍是默认。
- `long_task` 的训练集回撤来自 merge long-task 内部的 `blank_eval_plan` completion validator，外层只写镜像记录。
- `long_task` 分支暂时只支持 Direct Chat held-out test；如果要用 `blank-opencode` 对测试集验收，仍先走旧链路。
- 真正完整的 `todo / active / watch` live supervisor 还没接进 `runHierarchicalMergeLongTask.ts`，当前分层 runner 仍是“启动子进程并等待退出”的第一版。

已跑烟测：

```powershell
bun --check auto-evolve/scripts/run-benchmark-orchestrator.ts
bun run auto-evolve/scripts/smoke-merge-as-long-task-pack.ts
bun run auto-evolve/scripts/smoke-hierarchical-merge-live-supervisor.ts
bun run auto-evolve/scripts/smoke-hierarchical-merge-as-long-task-pack.ts
```

结果：全部通过。
