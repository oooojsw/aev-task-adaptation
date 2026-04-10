# 专业计划书：任务化 Bootstrap 与 Session 双记录系统

## 1. 目标

在当前“代码方法策略 + primitive ops + Knowledge Maintainer + Experience Workspace”架构基础上，进一步完成三项核心升级：

1. **Task Model 化**
   - 将 `bootstrap`、训练、评估、验证、回归、探测统一纳入任务系统
   - 不再把 `bootstrap` 视为系统外部的特殊阶段
2. **Session Dual Records**
   - 每个关键 session 必须产出：
     - `session_execution_report.md`
     - `session_learning_log.md`
3. **Knowledge Maintainer Feedback Upgrade**
   - 经修 agent 不再只读取失败摘要
   - 而是读取：
     - 行为时间流
     - 运行中增量学习记录
   - 再决定如何维护最终经验工作区

本次设计的目标是为后续这些能力提供稳定底座：

- 多种反向传播方法
- 不同 bootstrap 策略
- 大型经验体系
- 对抗测试
- 分支比较
- Git-tree 版本化

---

## 2. 当前问题

### 2.1 `bootstrap` 仍然被当成系统级固定阶段

当前基线方法中：

- `bootstrap` 默认直接读取 train split
- 一次性喂给一个 session
- 生成第一版经验

这个设计能工作，但问题是：

- 不同方法可能不需要 bootstrap
- 不同方法可能只需要 1 个样本 bootstrap
- 不同方法可能需要分批 bootstrap
- 不同方法可能边学边建结构

因此：

**`bootstrap` 不能继续留在“公共主流程外层”，必须变成方法编排的一部分。**

### 2.2 当前 session 只保留“行为报告”，没有保留“运行中学习记录”

当前已经有：

- `session_execution_report.md`

但这还不够。

缺少：

- session 在运行中即时写下的学习笔记
- 已验证 / 未验证线索
- 死路记录
- 工具使用教训
- 刚发现的模式 / 例外

如果不保留这些信息，经修 agent 只能看到：

- 它做了什么

但看不到：

- 它在做的过程中具体学到了什么

### 2.3 当前反馈包仍然过于“事后化”

现在经修 agent 主要拿到：

- `actual_output`
- `evaluation`
- `action_trace`
- 选中的 `session_execution_report`

但后续更合理的反馈包应同时包含：

- 行为路径
- 运行中学习记录
- 当前方法的维护意图

---

## 3. 总体设计

## 3.1 新的统一抽象：Task

以后系统中凡是一次“明确目标 + 路径输入 + session 执行 + 标准产物”的运行单元，统一称为 **Task**。

每个 Task 至少应有：

- `taskType`
- `method`
- `mode`
- `goal`
- `inputRefs`
- `sessionOutputs`
- `result`

Task 是编排单位。
Session 是 Task 的执行载体。

### 3.1.1 推荐 Task Types

建议现在就固定这些一级 Task 类型：

- `seed_workspace`
- `bootstrap_from_examples`
- `learn_case`
- `eval_case`
- `verify_case`
- `run_regression`
- `maintain_experience`
- `adversarial_probe`
- `branch_compare`

后续允许新增，但不建议删除已有类型语义。

### 3.1.2 核心结论

**`bootstrap` 将被重新定义为一种 Task Type，而不是系统初始化阶段的硬编码流程。**

---

## 4. Session Dual Records 设计

每个关键 session 后续必须产出两份正式主记录。

## 4.1 `session_execution_report.md`

作用：

- 提供单文件、顺序化、可截断的行为报告
- 供人类、方法层、经修 agent 统一读取

要求：

- 存在于 session 自己的产物目录中
- 单文件
- 按时间顺序
- 保留关键输入输出摘要
- 保留错误、失败工具、最终结果

建议内容结构：

```md
# Session Execution Report

## Session Meta
## Task Meta
## Input References
## Final Outcome
## Ordered Timeline
## Tool Failure Summary
## Behavior Summary
```

### 建议新增字段

为了适配 Task 模型，后续报告中建议显式增加：

- `taskType`
- `taskGoal`
- `taskMode`
- `method`

而不只保留 phase 概念。

## 4.2 `session_learning_log.md`

作用：

- 记录 session 运行中的增量学习内容
- 作为后续维护经验体系的重要输入

要求：

- 同样放在 session 自己的目录中
- 运行过程中追加写入
- 不是结束时才一次性总结

推荐内容类别：

- `observed_pattern`
- `tentative_rule`
- `confirmed_rule`
- `rejected_hypothesis`
- `tool_lesson`
- `dead_end`
- `workspace_discovery`
- `output_constraint_lesson`

建议格式示例：

```md
# Session Learning Log

## Entry 1
- time: ...
- kind: tentative_rule
- note: ...

## Entry 2
- time: ...
- kind: tool_lesson
- note: ...
```

### 关键原则

这份文件不是日志复制品，而是：

**由当前 session 中的 agent 主动维护的“现场学习记录”。**

---

## 5. Task 与 Session 的关系

一个 Task 可以有一个或多个 Session。

例如：

### `bootstrap_from_examples`

可能只有 1 个 session。

### `learn_case`

可能包含：

- solve session
- maintain session
- verify session
- regression sessions

因此后续目录建议继续保持“task 下含 session 目录”的形态。

每个 session 目录中保留：

- `prompt.txt`
- `run.json`
- `response.txt`
- `events.json`
- `tool_failures.json`
- `session_execution_report.md`
- `session_learning_log.md`

---

## 6. Knowledge Maintainer 输入升级

## 6.1 现有输入不足点

当前 maintainer 主要读取：

- 当前工作区
- 模板库
- baseline
- case 失败上下文
- session execution reports

但没有正式读取：

- session 增量学习记录

## 6.2 新输入契约

建议在 `KnowledgeMaintainerRequest` 中稳定增加：

- `sessionExecutionReportPaths: string[]`
- `sessionLearningLogPaths: string[]`

并要求路径均相对于当前运行目录记录，便于：

- portability
- run artifact consistency
- method-level selection

### 关键原则

- 只传路径
- 不预塞全文
- 经修 agent 必须自己决定读哪些

---

## 7. Knowledge Maintainer Prompt Stack 设计

后续 maintainer prompt 固定为三层结构。

## 7.1 Layer A: `knowledge-maintainer-core`

职责：

- 定义经修 agent 的稳定身份
- 定义它维护的是最终经验工作区
- 定义 Experience Workspace 的基础不变量
- 定义通用经验维护元操作

建议通用经验维护元操作：

- create_module
- split_module
- merge_modules
- rewrite_entry_navigation
- add_tool_guide
- add_failure_lesson
- create_partition_index
- deprecate_module
- reorganize_structure

注意：

这里的“元操作”是经验维护层的语义元操作，不是代码 primitive op。

## 7.2 Layer B: `method_maintenance_extension`

职责：

- 表达当前反向传播方法的特殊维护要求

例如：

- 是否允许大结构变更
- 是否优先保守修复
- 是否允许多版本并存
- 是否只保留一个最终版本
- 是否优先吸收工具失败教训

## 7.3 Layer C: `runtime_context_blocks`

职责：

- 动态注入本次任务实际上下文

应包括：

- task meta
- workspace refs
- template library refs
- baseline ref
- current failure packet refs
- selected session execution report refs
- selected session learning log refs

---

## 8. 方法层职责升级

后续方法代码不仅要编排 primitive ops，还要编排：

1. 是否需要 bootstrap
2. bootstrap 使用哪种 Task
3. 选择哪些 session execution reports
4. 选择哪些 session learning logs
5. 采用哪种 maintainer extension

### 推荐方法接口新增能力

建议每个方法策略支持：

- `buildBootstrapPlan(...)`
- `selectExecutionReports(...)`
- `selectLearningLogs(...)`
- `buildMaintenanceExtension(...)`

这样不同方法可以自然地表达：

- 全量 bootstrap
- 单样本 bootstrap
- 无 bootstrap
- 边学边建结构

---

## 9. Experience Workspace 长期不变量

即使结构允许演化，仍建议固定这些不变量：

1. 最终经验区只保存最终有效经验
2. 模板库不并入最终经验区
3. 必须存在单入口文件
4. solve agent 应从入口开始选择性读取
5. Markdown 仍然是经验真源
6. 允许分区、工具说明、任务导航、规则拆分和合并

这意味着：

- 工作区结构可变
- 但“可导航”和“可维护”必须始终成立

---

## 10. 还需要新增的一个深层要素

除了双记录之外，我建议再正式引入一个轻量级文件：

## `session_task_manifest.md`

作用：

- 明确记录该 session 原本被要求做什么

因为后续经修 agent 不只是要知道“它做了什么”，还要知道：

- 它原本应该做什么

推荐包含：

- task type
- task goal
- method
- mode
- supplied path refs
- expected outcome kind

这份文件会让后续维护分析更稳：

- execution report 讲实际行为
- learning log 讲运行中的学习
- task manifest 讲最初任务意图

如果你希望更稳的长期架构，我建议把它也纳入统一标准产物。

---

## 11. 与当前系统的衔接顺序

### Phase 1

把 `bootstrap` 纳入 method strategy，作为 Task Type 而不是系统固定阶段。

### Phase 2

让所有关键 session 自动生成：

- `session_execution_report.md`
- `session_learning_log.md`

### Phase 3

新增 `session_task_manifest.md`

### Phase 4

扩展 maintainer 契约：

- execution reports
- learning logs
- task manifests

### Phase 5

方法层实现：

- bootstrap strategy selection
- report/log selection
- maintainer extension selection

---

## 12. 长期价值

这套设计会让系统从“会跑一条顺序 refine 链”升级成：

**一个以 Task 为统一执行单位、以双记录为反馈材料、以经修 agent 为经验维护核心、以方法代码控制反向传播路径的长期演化系统。**

它是后续这些能力的稳定底座：

- 多 bootstrap 策略
- 多维护策略
- 对抗测试
- 分支比较
- 经验分区扩展
- Git-tree 版本化
