# Validation Engine + Result Router 实施计划

## 背景

当前 Auto-Evolve 的验证逻辑分散在多个位置：

- `orchestrator/long-task/validators.ts` 负责执行长程任务的脚本验证器和 `prompt_json` 软验证器。
- `orchestrator/judge/run.ts` 负责短程反向传播里的 soft judge。
- `orchestrator/long-task-campaign/runner.ts` 自己拼接每轮 surface precheck、blank eval、final acceptance。
- `orchestrator/blank-eval/runner.ts` 负责空白 agent 闭卷执行，但产物验证仍调用 long-task validator。
- `orchestrator/acceptance-framework/*` 已经统一了“判决书/验收政策”的记录方式，但不是统一的验证执行引擎。

因此现在的问题不是“没有验证器”，而是“验证器执行、权限、结果流向、脱敏视图没有统一”。

## 核心共识

系统不是要防所有训练 agent 看答案。训练侧 agent 的任务就是开卷学习、诊断失败、修专家经验。真正的红线是：

> 答案、答案路径、答案推导提示、验证器内部机密，不能进入 Blank Agent 可见面，也不能进入最终专家经验区。

所以统一验证系统必须同时解决四件事：

1. 验证器怎么执行。
2. 验证器能不能看 private answers。
3. 验证结果分成哪些视图。
4. 哪些角色/阶段能看到哪一版结果。

## 第一阶段目标

本阶段先建立通用底座，不大规模重写业务流程：

1. 新增 `orchestrator/validation-engine/`。
2. 定义通用验证对象：
   - `ValidationTargetKind`: `surface | product | behavior | regression | transaction | layout`
   - `ValidationMechanism`: `hard_script | soft_llm`
   - `ValidationStage`: `local_training | pre_blank | post_blank | post_merge | rollback | train_replay | heldout_test | judge`
   - `ValidationAudience`: `executor | worker | lead | reviewer | merger | repair_agent | dashboard | blank_agent | memory | audit`
3. 定义结果分层：
   - `private`: 系统审计用，可包含完整 stdout/stderr、答案路径、命中片段。
   - `training`: 给 lead/worker/reviewer/repair agent 用，默认脱敏答案字面值和 private 路径，但保留可修复信息。
   - `sanitized`: 给 dashboard/carryover/长期记忆用，只保留类别化原因。
   - `score_only`: 给测试集/统计用，只保留分数和通过状态。
4. 新增 `runValidation()` 执行入口，先支持现有 long-task 的 `script` 与 `prompt_json` contract。
5. 保留旧的 `runLongTaskValidator()` 外部接口，但内部改为调用新引擎适配层，避免破坏现有 long-task、blank-eval、campaign。
6. 新增 smoke test，验证：
   - hard script validator 能正常执行并返回旧格式结果。
   - 结果视图能产生 private/training/sanitized/score_only。
   - `blank_agent` 不允许读取任何验证结果视图。
7. 保持验证模块可拔插：不同数据集通过 `task-packs/validator-profiles/*.json` 挂载自己的 layout、surface、product、soft、rollback、regression 验证器。profile 可声明 `validation.target`、`validation.stage`、`validation.answerAccess`、`validation.allowedAudiences` 等元数据；平台层不得把 OfficeQA 或任一数据集的布局写成全局默认硬门。

## 后续阶段

第二阶段：

- 把 campaign surface precheck 明确改成 validation-engine profile。
- 支持各数据集按 profile 在 `pre_blank` 挂载自己的硬布局验证、硬防泄漏验证或软验证；本阶段不默认把 OfficeQA 的布局/requiredFiles 变成平台硬门。
- 把 validation result 的 training/sanitized 视图接入 round feedback。

第三阶段：

- 把 `judge/run.ts` 的 soft judge 改成 validation-engine 的 `soft_llm` adapter。
- 把 merge、rollback、train replay、held-out test 的验证 profile 化。

第四阶段：

- 将 `acceptance-framework` 与 validation-engine 串起来：验证执行由 validation-engine 完成，系统语义和判决记录由 acceptance-framework 完成。

## 非目标

本阶段不做以下事情：

- 不删除 `long-task/validators.ts`。
- 不重写 `blank-eval/runner.ts`。
- 不改变现有 spec/campaign JSON 的配置格式。
- 不默认改变 OfficeQA 当前运行任务的验证策略。

## 验收标准

- `bun build` 能通过新增模块和旧入口。
- 现有 `runLongTaskValidator()` 调用方不需要改签名。
- smoke test 能证明新引擎可以执行脚本验证器并生成分层结果。
- README / AGENTS 记录这次架构边界，避免未来把 validation-engine、blank-eval、acceptance-framework 混为一谈。

## 2026-06-08 补充完成项

- 新增 `runValidationStage()` 阶段级入口。
- Campaign final acceptance 的 Blank Agent 前验证已接入 `pre_blank` stage。
- Blank Eval 结束后的产物验证已接入 `post_blank` stage。
- `stage-result.json` 会汇总本阶段 validator results 和 training/sanitized/score_only 视图路径。
- `smoke-validation-engine.ts` 已覆盖：
  - 单个旧 validator 通过 validation-engine 执行。
  - profile 元数据加载与 `pre_blank + layout` 选择。
  - `runValidationStage()` 实际执行 profile validator。
  - `post_merge + surface`、`rollback + transaction`、`heldout_test + product` 的 profile 选择。
  - `heldout_test` stage 的实际执行。
  - `blank_agent` 无权读取验证结果视图。
