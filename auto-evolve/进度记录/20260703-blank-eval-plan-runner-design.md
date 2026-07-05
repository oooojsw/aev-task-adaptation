# Blank Eval Plan Runner 设计计划

日期：2026-07-03

## 背景

现有 `blank-eval` 模块只支持单个 case 闭卷验收：

```text
runBlankEval(specPath + skillRoots) -> BlankEvalResult
```

这对单个 long-task/campaign 足够，但对合并后的 skill 不够。合并后的 skill 需要在多个训练 case 或测试 case 上回撤，才能证明它没有丢失单 case skill 的能力，也没有只写出一个看起来格式正确但不能执行的 merged skill。

当前 multi-instance 的回撤逻辑散落在 `orchestrator/multi-instance/validator.ts`，未来如果 merge-as-long-task、测试集评估、baseline 对照都各自写一套循环，会越来越分散。

## 目标

把空白验收升级成可组合模块：

```text
runBlankEvalPlan(plan) -> BlankEvalPlanResult
```

底层继续复用现有 `runBlankEval()`，不重写单题 blank agent。新增一层 plan runner，负责按计划顺序或并发调用多个单题 blank eval，并汇总结果。

第一版只实现三种模式：

- `single`：兼容旧单题行为。
- `sequence`：多个 case 顺序跑，可配置失败即停，适合省钱验收。
- `parallel`：多个 case 并行跑，适合合并后训练集回撤。

后续预留但暂不实现：

- `matrix`：多个 skill x 多个 case 对照。
- `cascade`：先小样本烟测，通过后再全量。

## 核心设计

### 1. 类型层

修改：

```text
auto-evolve/orchestrator/blank-eval/contract.ts
```

新增：

```text
BlankEvalPlanMode = "single" | "sequence" | "parallel"
BlankEvalPlanSuccessCriterion = "all_pass" | "allow_partial" | "min_pass_rate"
BlankEvalPlanCase
BlankEvalPlanInput
BlankEvalPlanCaseResult
BlankEvalPlanResult
```

关键字段：

```text
mode                single / sequence / parallel
skillRoots          被测 skill 根目录
cases               要跑的 case 列表，每个 case 至少包含 id/specPath
concurrency         parallel 模式并发数
stopOnFirstFailure  sequence 模式是否失败即停
successCriterion    总结果判定标准
minPassRate         successCriterion=min_pass_rate 时使用
runRoot             plan 级输出根目录
```

### 2. 执行层

新增：

```text
auto-evolve/orchestrator/blank-eval/plan-runner.ts
```

职责：

1. 为整个 plan 创建独立 run 目录。
2. 每个 case 调用现有 `runBlankEval()`。
3. 每个 case 写入自己的 `case-result.json`。
4. 汇总所有 case 的结果。
5. 写出：

```text
plan-result.json
evidence-bundle.json
summary.md
```

结果示例：

```json
{
  "passed": false,
  "mode": "parallel",
  "total": 5,
  "passedCount": 4,
  "failedCount": 1,
  "failedCases": ["case-003"],
  "summary": "4/5 blank eval cases passed.",
  "caseResults": []
}
```

### 3. 权限与闭卷红线

Plan runner 可以读取计划文件和 case 列表，但每个 blank agent 仍然只能看到：

- 当前 case 的 spec/materials
- 当前被测 skill
- 当前 case 的 sandbox/workspace

每个 blank agent 不能看到：

- 全部 input-skills
- training-results
- private-answers
- replay-plan 里的隐藏字段
- 其他 case 的 workspace

实现方式：

- `runBlankEvalPlan()` 不直接把 plan 文件传给 blank agent。
- 每个 case 调用 `runBlankEval()` 时，只传 `case.specPath` 和统一 `skillRoots`。
- 每个 case 使用独立 `runtimeScope` 和独立 `runRoot` 子目录。

### 4. Validator 接入层

第一版先支持系统内置验证器类型：

```text
type: "blank_eval_plan"
```

修改：

```text
auto-evolve/orchestrator/long-task/contract.ts
auto-evolve/orchestrator/long-task/validators.ts
auto-evolve/orchestrator/validation-engine/registry.ts
auto-evolve/orchestrator/validation-engine/long-task-adapter.ts
```

新增 contract 形态：

```json
{
  "id": "merged-skill-replay",
  "type": "blank_eval_plan",
  "title": "Merged skill replay",
  "placement": "completion_only",
  "planPath": "materials/replay-plan.json",
  "skillRootPath": "workspace/merged-skill",
  "mode": "parallel",
  "concurrency": 3,
  "successCriterion": "all_pass"
}
```

验证器执行逻辑：

1. 读取 validator payload/bundle。
2. 解析当前 long-task 产物中的 `skillRootPath`。
3. 读取 `planPath`。
4. 调用 `runBlankEvalPlan()`。
5. 把 plan 总结果转换为 `LongTaskValidatorResult`。

### 5. Merge-as-LongTask 使用方式

新增数据集时可以这样挂：

```text
task-packs/real-long-tasks/merge-skill-learnbench/tasks/<merge-task>/
  spec.json
  campaign.json
  materials/
    input-skills/
    input-manifest.json
    replay-plan.json
    merge-contract.json
  workspace/
    merged-skill/
```

任务目标：

```text
读取 input-skills 和 merge-contract，产出 workspace/merged-skill。
```

最终 validator：

```text
blank_eval_plan validator 对 workspace/merged-skill 批量跑 replay-plan。
```

这样合并任务可以直接复用 long-task campaign 的多轮机制：

```text
合并初稿 -> 批量 blank replay 失败 -> worker 分析 -> lead 修 merged-skill -> 下一轮
```

## 实现步骤

### Step 1：类型和 plan runner

- 扩展 `blank-eval/contract.ts`。
- 新增 `blank-eval/plan-runner.ts`。
- 提供 `runBlankEvalPlan()`。
- 支持 `single/sequence/parallel`。

### Step 2：long-task validator contract

- 扩展 `LongTaskValidatorType`。
- 新增 `LongTaskBlankEvalPlanValidatorContract`。
- 更新 union 类型。
- 注意保持现有 script/prompt_json 完全兼容。

### Step 3：validator 执行

- 在 `long-task/validators.ts` 里增加分支。
- 在 validation-engine adapter 里增加 descriptor 推断，目标为 `product`，stage 默认 `post_blank`。
- 结果写入 validator 目录，evidenceRefs 包含 plan result 和失败 case 证据。

### Step 4：smoke 测试

新增：

```text
auto-evolve/scripts/smoke-blank-eval-plan.ts
```

烟测只测 plan runner 的控制逻辑，不调用真实模型：

- 可用 dependency injection 或 fake runner 模拟 case pass/fail。
- 验证 sequence 失败即停。
- 验证 parallel 汇总。
- 验证 all_pass / min_pass_rate。

如果不方便注入 fake runner，则至少做类型级和纯函数级 smoke。

### Step 5：文档更新

更新：

```text
auto-evolve/README.md
```

说明：

- `runBlankEval()` 是单题底座。
- `runBlankEvalPlan()` 是批量验收调度器。
- blank agent 仍然闭卷，plan runner 不把 replay-plan 暴露给 blank agent。

## 关键风险

1. 不能让 blank agent 读到 replay-plan 或全部 input skill。
2. `parallel` 并发必须受 OpenCodeGate 控制，不能绕过全局并发。
3. 每个 case 必须独立 sandbox，不能共享 workspace。
4. validator 失败必须返回清晰证据，否则 campaign worker/lead 无法修。
5. 旧 `runBlankEval()` 调用路径不能破坏。

## 成功标准

- 旧 `runBlankEval()` 类型检查通过。
- 新 `runBlankEvalPlan()` 可以汇总多 case 结果。
- `blank_eval_plan` validator 可以作为 long-task completion validator 返回标准 `LongTaskValidatorResult`。
- smoke 覆盖 sequence/parallel 判定逻辑。
- 不启动真实训练即可通过静态检查和 smoke。
