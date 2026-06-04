# 全局空白 agent 验收基础设施设计

日期：2026-06-04

## 一句话结论

`blank agent` 验收不应该由某个数据集手工选择是否挂载，而应该成为所有 `long-task campaign` 每轮结束时的强制基础设施。否则系统只能证明“带上下文的 executor 做出来了”，不能证明“经验包真的教会了空白 agent”。

## 当前真实问题

现在 `runCampaignFinalAcceptance` 的逻辑是：

1. 从任务 `spec.validators` 里找 `placement = completion_only` 的验证器。
2. 把当前 `pending-expert-package/current` 复制到本轮 `final-acceptance` 目录。
3. 对这些 completion validators 调 `runLongTaskValidator`。

这导致结果取决于每个任务怎么配置：

- 如果任务挂了 `blank-agent-deployment`，比如 `try4-expert-bootstrap`，每轮会跑真正的空白 agent。
- 如果任务只挂了答案脚本，比如 OfficeQA 当前任务，每轮只会校验普通 executor 写出的 `workspace/answer.txt`。

问题不是 blank agent 模块不存在，而是它不是全局强制 gate。

## 正确的系统语义

每一轮 campaign 的核心闭环应该是：

1. executor 带着历史、记忆、探索树做题。
2. lead 把经验写进 `pending-expert-package/current`。
3. 系统启动一个全新 blank agent。
4. blank agent 只能读取当前正式经验包、任务材料、声明的能力资产。
5. blank agent 重新完成任务并写产物。
6. 验证器只检查 blank agent 的产物是否合格。
7. 如果失败，失败轨迹进入 `blank_acceptance_diagnostician` 和下一轮 lead。

也就是说，验证器是裁判，不是运动员。真正的运动员必须是 blank agent。

## 设计目标

1. 所有 long-task campaign 默认强制跑 blank agent 验收。
2. 不要求每个数据集手工写 `blank-agent-deployment`。
3. 保留原有验证器能力：答案脚本、布局脚本、泛化脚本、软 judge 都继续可用。
4. 让这些验证器默认验证 blank agent 产物，而不是普通 executor 产物。
5. 保持断点续传、并发、多轮、诊断 worker、reviewer 现有能力。
6. 对已有任务尽量无侵入：老 spec 不改也能走全局 blank gate。

## 基础设施改造方案

### 1. 新增统一 blank acceptance adapter

新增模块建议：

`auto-evolve/orchestrator/long-task-campaign/blank-acceptance.ts`

职责：

- 根据当前 `baseSpec` 和 `pendingPackageRoot` 自动构造 blank-eval 输入。
- 自动调用已有的 `runBlankEval`。
- 把结果转换成当前 `runCampaignFinalAcceptance` 能理解的结果结构。
- 保存 blank agent 的 `session/action_trace.md`、`response.txt`、`blank_eval_result.json`。

### 2. 自动生成 blank-eval spec

不要要求每个数据集写 deployment spec。系统根据原任务 spec 自动生成一份“空白验收 spec”：

- `goal`：沿用原任务目标。
- `materials`：沿用原任务材料。
- `targetPaths`：沿用原任务目标产物。
- `editablePaths`：沿用原任务可编辑目录。
- `capabilities`：沿用原任务能力资产。
- `initialExpertContextPaths`：只放当前 `pending-expert-package/current`。
- `formalPackageRoots`：只放当前 `pending-expert-package/current`。
- `validators`：使用原任务 validators 中可用于产物验收的 validators。

关键原则：

- 不传 `campaign-working-memory.json`。
- 不传 `exploration-tree.json`。
- 不传 `routing-control.json`。
- 不传 retry bundle。
- 不传 run trace。
- 不传普通 executor 的输出作为可读材料。

### 3. completion validators 分层

现有 completion validators 拆成两类语义：

- `surface validators`：检查经验包本身，比如 workspace layout、surface generalization、防硬编码。
- `product validators`：检查任务产物，比如 OfficeQA answer、SpreadsheetBench xlsx、docx 结果。

全局 final acceptance 应按顺序跑：

1. surface validators 检查 pending expert package。
2. blank agent 用 pending expert package 重新做任务。
3. product validators 检查 blank agent 产物。

如果第 1 步失败，不启动 blank agent，因为经验包表面已经不合格。
如果第 2 或第 3 步失败，必须记录 blank agent 轨迹，进入诊断 worker。

### 4. 兼容老 spec

为了不破坏已有数据集，先用规则自动分类：

- 如果 validator 的目标是经验包，例如 id 包含 `surface`、`workspace-layout`、`generalization`，归为 surface validator。
- 其他 completion-only validator 默认归为 product validator。

后续可以在 validator contract 里正式新增字段：

```ts
acceptanceTarget?: "experience_surface" | "blank_agent_product"
```

但第一版不要求所有旧 spec 立刻改。

### 5. runCampaignFinalAcceptance 的新流程

旧逻辑：

```text
completion validators -> passed -> verified_success
```

新逻辑：

```text
surface validators
  -> failed: final_acceptance_failed(surface)
  -> passed:
      runBlankEval
        -> blank agent session failed or product validators failed:
             final_acceptance_failed(blank_agent)
             feed trace to blank_acceptance_diagnostician
        -> passed:
             verified_success
```

### 6. OfficeQA 的具体效果

现在 OfficeQA 是：

```text
executor writes task/workspace/answer.txt
officeqa-answer-validate checks it
```

改造后应该是：

```text
lead writes pending expert package
blank agent reads pending expert package + OfficeQA materials
blank agent writes task/workspace/answer.txt
officeqa-answer-validate checks blank agent's answer.txt
```

这样答案脚本仍然有用，但它不再替代空白 agent。

### 7. 失败反馈进入下一轮

blank eval 失败时，必须把这些路径写进 final acceptance result：

- blank eval run dir
- `session/session_execution_report.md`
- `session/response.txt`
- `session/events.json`
- `blank_eval_result.json`
- failed validator summaries

`blank_acceptance_diagnostician` 必须优先读取这些真实空白 agent 失败轨迹，而不是只读静态 validator 报错。

## 建议实施顺序

### Phase 1：基础设施接入

1. 新增 `blank-acceptance.ts`。
2. 在 `runCampaignFinalAcceptance` 中强制调用 blank acceptance。
3. 保留原 result schema，但增加 `blankEval` 字段。
4. 失败时把 blank eval 轨迹传给现有诊断 worker。

### Phase 2：验证器分类

1. 增加自动分类函数。
2. surface validator 先跑。
3. product validator 只在 blank eval 内或 blank eval 后跑。
4. OfficeQA 答案脚本归为 product validator。

### Phase 3：烟测

必须至少做三类烟测：

1. try4：已有 `blank-agent-deployment` 的任务不能双跑或破坏。
2. OfficeQA：原本没 blank agent 的任务必须自动启动 blank eval。
3. 一个只有静态 surface validator 的任务：必须明确失败，提示缺少 product validator 或使用默认目标产物检查。

### Phase 4：严格默认

默认策略：

- `autoBlankAcceptance.enabled = true`
- `autoBlankAcceptance.required = true`
- 没有可用产物验证器时，不允许静默成功。

允许临时调试绕过，但必须显式写：

```json
"autoBlankAcceptance": {
  "enabled": false,
  "reason": "debug only"
}
```

## 风险点

1. 成本会上升：每轮都会多一次 blank agent。
2. 长任务会更慢：但这是系统目标必须付出的成本。
3. 部分旧任务没有清晰 targetPaths：需要默认 artifact existence check。
4. 旧 validator 可能默认读错产物路径：需要像 OfficeQA 一样基于 `validator_input.json` 定位当前任务目录。
5. 如果 blank agent 读取权限放太宽，会污染闭卷测试；必须只给经验包、材料、能力资产、目标路径。

## 最终判定标准

一轮 campaign 只有满足下面条件，才可以标记 `verified_success`：

1. 当前 pending expert package 通过 surface checks。
2. blank agent 在隔离会话中完成任务。
3. blank agent 产物通过 required product validators。
4. final acceptance result 里有 blank eval run evidence。

如果没有 blank eval evidence，不允许 `verified_success`。
