# 专业计划书：Judge 层与本地 Judge Skill 工具包

## 1. 目标

在现有 `worker session -> maintainer -> acceptance` 的基础上，引入一个独立的前置 Judge Layer。

该 Judge Layer 由两部分构成：

1. `Soft Judge Agent`
2. `Local Judge Skill Toolkit`

Judge Layer 负责在 maintainer 启动前完成：

- 失败归因
- 行为总结
- 工具失效总结
- 是否建议启动 maintainer
- 建议向 maintainer 暴露哪些记录与焦点

---

## 2. 设计原则

### 2.1 Judge 与 Maintainer 分层

- Judge 不修改经验工作区
- Maintainer 不承担前置判定职责
- Method Layer 决定是否调用 Judge 以及 Judge 采用何种模式

### 2.2 Hard Checks 不再硬编码为主流程固定判断

- 客观判断能力保留
- 但实现为可调用的本地 Judge Skill
- 是否自动运行由 Judge 模式决定

### 2.3 Judge Skill 只做项目内局部暴露

- 不注册到全局 skill 系统
- 不作为全局默认工具暴露
- 只把路径暴露给 Soft Judge Agent

### 2.4 统一 Judge 产物

不论模式是：

- `soft_only`
- `soft_plus_hard`

最后统一产出：

- `judge_summary.json`
- `judge_report.md`

Maintainer 只读取这两个统一 judge 产物及必要原始记录。

---

## 3. Judge 模式

### 3.1 `soft_only`

- 系统不自动运行 hard judge scripts
- Soft Judge Agent 可自行阅读 `judge-skills/INDEX.md`
- Soft Judge Agent 可按需运行局部 judge skill 脚本

### 3.2 `soft_plus_hard`

- 系统先自动运行预配置的 hard judge skill 脚本
- 脚本结果保存到 `judge/hard-checks/...`
- Soft Judge Agent 再读取这些结果并继续综合分析

---

## 4. Judge Skill Toolkit 结构

建议结构：

```text
auto-evolve/judge-skills/
  INDEX.md
  exact-output/
    SKILL.md
    scripts/
      run.py
  tool-failures/
    SKILL.md
    scripts/
      run.py
  session-behavior/
    SKILL.md
    scripts/
      run.py
```

### 4.1 `INDEX.md`

作用：

- 作为 Judge Skill 总入口
- 告诉 Soft Judge Agent：
  - 有哪些 skill
  - 各自大概用途
  - 一般输入是什么
  - 大概何时使用

### 4.2 单个 Skill

每个 skill 保持：

- `SKILL.md`
- `scripts/run.py`

脚本读统一输入 JSON，输出统一结果 JSON。

---

## 5. 第一版 Judge Skill 清单

### 5.1 `exact-output`

输入：

- `evaluation.json`
- `actual_output.txt`
- `expected/output.txt`

输出：

- 输出比较摘要
- mismatch 列表
- 模式与最终判定摘要

### 5.2 `tool-failures`

输入：

- `tool_failures.json`

输出：

- 失败工具列表
- 失败数量
- 按工具名聚合摘要

### 5.3 `session-behavior`

输入：

- `events.json`
- `session_execution_report.md`

输出：

- 工具调用次数
- 重复 read 情况
- 空探索信号
- 明显重复无效行为摘要

---

## 6. Judge Agent Prompt 分层

Soft Judge Agent Prompt 分三层：

### 6.1 Judge Core Prompt

定义：

- 你是判断 agent
- 你不修改经验工作区
- 你负责分析失败与行为
- 你可以阅读并运行本地 judge skills

### 6.2 Method Judge Extension

由具体方法提供，例如 `sequential-refine` 的 judge 扩展：

- 关注最小修复
- 关注 regression 稳定性
- 关注已有成功行为不要被破坏

### 6.3 Runtime Context

包括：

- 当前 case 失败上下文
- routing 信息
- session execution reports
- regression-before-maintain reports
- judge skill index 路径
- hard check 结果路径
- judge 输出目标路径

---

## 7. Judge 产物

### 7.1 `judge_summary.json`

建议字段：

- `judgeMode`
- `shouldStartMaintainer`
- `failureClass`
- `keyIssues`
- `toolIssues`
- `behaviorIssues`
- `suggestedWorkspaceTargets`
- `recommendedSessionReports`
- `hardChecksUsed`
- `hardCheckResultPaths`
- `riskLevel`

### 7.2 `judge_report.md`

自然语言总结：

- 失败原因
- 行为问题
- 工具问题
- 为什么建议/不建议启动 maintainer
- 如果启动 maintainer，最应该修什么

---

## 8. 顺序法接入点

当前 `sequential-refine` 建议调整为：

1. `solve_case`
2. `finish_if_passed`
3. `finish_if_eval_mode`
4. `finish_if_max_retries_reached`
5. `prepare_feedback_packet`
6. `run_regression_before_maintenance`
7. `run_pre_judge`
8. `finish_if_judge_skipped_maintenance`
9. `invoke_knowledge_maintainer`
10. 后续 verify / regression / acceptance 保持原样

说明：

- Judge 放在 maintain 前
- Judge 能读取失败上下文和 regression-before-maintain 结果
- Judge 决定是否进入 maintainer

---

## 9. 对 Maintainer 的影响

Maintainer 新增输入：

- `judge_summary.json` 路径
- `judge_report.md` 路径

Maintainer Prompt 将新增：

- Judge Results Block

Maintainer 后续主要读取：

- judge 输出
- 必要原始 session 报告
- 当前经验工作区
- 模板库

---

## 10. 配置建议

新增项目级 Judge 配置文件，例如：

- `auto-evolve/judge-config.json`

建议字段：

- `mode`
  - `soft_only`
  - `soft_plus_hard`
- `autoRunSkillIDs`
- `enabledMethods`

第一版可先最小化为：

- `mode`
- `autoRunSkillIDs`

---

## 11. 第一阶段实施范围

本阶段只做：

- Judge 配置
- Judge Skill Toolkit
- Soft Judge Agent
- 顺序法前置 Judge 接入
- Maintainer 读取 Judge 输出

本阶段暂不做：

- post-judge 接管 acceptance
- 多项目 judge pack marketplace
- judge 权限细分
- 多方法复杂后置 judge 比较

---

## 12. 预期结果

完成后，系统将从：

`worker -> maintain -> acceptance`

推进为：

`worker -> judge -> maintain -> acceptance`

并具备：

- 可切换的 judge 模式
- 可拔插的本地 hard judge skills
- 可统一沉淀的 judge 结果
- 更清晰的 worker / judge / maintainer 分工
