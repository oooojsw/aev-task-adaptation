# Resource / Cost Audit 统一资源成本统计计划

日期：2026-06-24

适用项目：`C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve`

目标：把 Auto-Evolve 的训练、空白验收、合并、回撤测试、Direct Chat 测试里的模型调用消耗，统一统计成论文可用的资源账本。最终要能回答审稿人最关心的问题：这套 skill 到底用了多少 token、多少钱、每一点提升成本多少、部署时多了多少提示词开销。

## 1. 代码调查结论

### 1.1 OpenCode 长程训练侧已经能拿到 token / cost

OpenCode 的 JSON event 里已经有全局用量信息，主要出现在 `step_finish` 事件：

```text
event.type === "step_finish"
event.part.cost
event.part.tokens
```

现有代码已经会把这些信息写进 action trace / session report：

- `auto-evolve/orchestrator/action-trace.ts`
- `auto-evolve/orchestrator/session-execution-report.ts`

结论：我们不需要自己估算 OpenCode 训练 token。正确做法是在统一 OpenCode 调用入口处，把这些 `step_finish` 里的 usage 抽出来落账。

### 1.2 OpenCode 统一入口位置

所有长程训练、worker、lead、reviewer、blank eval、merger、repair 等智能体，最终都会走：

```text
auto-evolve/orchestrator/opencode.ts
runOpencodeTask(...)
```

里面实际执行一次 OpenCode CLI 的函数是：

```text
runOpencodeTaskOnce(...)
```

保存实时 artifacts 的函数是：

```text
writeLiveTask(...)
```

保存最终 artifacts 的函数是：

```text
auto-evolve/orchestrator/task-artifacts.ts
writeTaskArtifacts(...)
```

结论：资源统计模块应该接在 `runOpencodeTask` 层，而不是分散塞进 long-task / campaign / merger / blank-eval 各个业务模块。

### 1.3 Direct Chat 测试侧已经有逐题 usage

Direct Chat 现在每题已经写：

```text
prompt-audit.json
provider-response.json
result.json
```

其中：

- `prompt-audit.json`：估算 prompt tokens、skill tokens、material tokens、是否截断、预算。
- `provider-response.json`：供应商返回的 usage。
- `result.json`：每题结果、usage、latency、errorCategory、skillMode、skillTier。

Provider 兼容层已经把 OpenAI-compatible usage 规整成：

```ts
usage: {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}
```

相关文件：

- `auto-evolve/orchestrator/direct-chat/contract.ts`
- `auto-evolve/orchestrator/direct-chat/providers/openai-compatible.ts`
- `auto-evolve/orchestrator/direct-chat/runner.ts`

### 1.4 Direct Chat Excel 总表已有部分 token 列

现有总表脚本：

```text
auto-evolve/scripts/update-direct-chat-master-report.py
```

`Case Results` sheet 已经有：

```text
inputTokens
outputTokens
totalTokens
```

但缺：

```text
reasoningTokens
estimatedPromptTokens
skillTokens
materialTokens
costUSD
```

结论：Direct Chat 成本统计只需要增强，不需要重做。

### 1.5 现有缺口

现在没有统一训练期资源总账。具体缺口：

- 没有 `resource-ledger.jsonl`。
- 没有把 OpenCode 每次 session 的 token/cost 汇总到 task / round / role / phase。
- 没有 model pricing 配置。
- 没有自动计算 USD 成本。
- 没有 initial skill tokens / final skill tokens。
- 没有 accepted edits / rejected edits 的统一口径。
- 没有 cost-per-point / cost-per-correct / cost-benefit curve。

## 2. 最终需要产出的论文级指标

### 2.1 对齐 SkillOpt Table 6 的基础指标

每个数据集 / 实验 run 需要统计：

| 指标 | 含义 | 来源 |
|---|---|---|
| initialSkillTokens | 初始 skill / seed expert workspace token 数 | 训练开始时扫描 seed skill |
| finalSkillTokens | 最终 merged / best skill token 数 | 训练结束后扫描最终 skill |
| acceptedEdits | 被系统接受并进入下一阶段的 skill 修改次数 | campaign / merge / replay 记录 |
| rejectedEdits | 被 reviewer / validator / replay 拒绝的修改次数 | final acceptance / reviewer / replay 失败记录 |
| trainInputTokens | 训练期输入 tokens | OpenCode step_finish |
| trainOutputTokens | 训练期输出 tokens | OpenCode step_finish |
| trainReasoningTokens | 训练期 reasoning tokens | OpenCode step_finish |
| trainTotalTokens | 训练期总 tokens | OpenCode step_finish |
| trainCostUSD | 训练期估算美元成本 | tokens * price table |
| baselineScore | 无 skill 基线分数 | baseline 或 Direct Chat no-skill |
| finalScore | 有 skill 最终分数 | test / direct-chat / blank eval |
| deltaScorePoints | finalScore - baselineScore | 汇总计算 |
| costPerPoint | trainTotalTokens / deltaScorePoints 或 USD / deltaScorePoints | 汇总计算 |

### 2.2 训练期更细粒度指标

需要支持按以下维度聚合：

```text
dataset
runID
taskID / caseID
campaignID
roundNumber
phase
role
model
provider
sessionID
```

典型 role：

```text
planner
executor
validator_llm
campaign_worker
campaign_lead
campaign_reviewer
blank_eval
merger
merge_repair
train_replay
test_blank
direct_chat
```

典型 phase：

```text
training
long_task_plan
long_task_execute
long_task_validate
campaign_worker
campaign_lead
campaign_review
blank_eval
hierarchical_merge
merge_repair
train_replay
heldout_test
direct_chat_eval
```

### 2.3 部署阶段指标

用于回答“部署时是不是很贵”：

| 指标 | 含义 |
|---|---|
| finalSkillTokens | 最终 skill token 长度 |
| noSkillPromptTokensAvg | 无 skill 平均 prompt tokens |
| withSkillPromptTokensAvg | 带 skill 平均 prompt tokens |
| inferenceTokenOverhead | withSkillPromptTokensAvg - noSkillPromptTokensAvg |
| inferenceOverheadRatio | withSkillPromptTokensAvg / noSkillPromptTokensAvg |
| deploymentExtraCalls | Direct Chat 是 0；OpenCode blank eval 另算 |

## 3. 新增模块设计

### 3.1 新目录

建议新增：

```text
auto-evolve/orchestrator/resource-audit/
  contract.ts
  usage.ts
  recorder.ts
  price-table.ts
  aggregate.ts
```

脚本：

```text
auto-evolve/scripts/update-resource-cost-report.ts
auto-evolve/scripts/smoke-resource-audit.ts
```

输出目录：

```text
auto-evolve/runtime-state/resource-audit/
  opencode-usage.jsonl
  direct-chat-usage.jsonl
  aggregate-summary.json
  aggregate-summary.md
  resource-cost-report.xlsx
```

每个 benchmark run 目录下也保存一份局部汇总：

```text
<benchmark-out>/
  resource-summary.json
  resource-summary.md
  resource-usage.csv
```

### 3.2 统一 usage 数据结构

核心记录建议：

```ts
export type ResourceUsageRecord = {
  schema: "auto-evolve-resource-usage/v1"
  createdAt: string
  source: "opencode" | "direct-chat" | "validator" | "manual-import"
  runID?: string
  benchmarkOutDir?: string
  datasetID?: string
  taskPackRoot?: string
  caseID?: string
  taskID?: string
  campaignID?: string
  roundNumber?: number
  phase?: string
  role?: string
  title?: string
  sessionID?: string
  model?: string
  provider?: string
  providerModelID?: string
  usage: {
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  cost?: {
    rawCost?: number
    rawCurrency?: string
    estimatedUSD?: number
    priceSource?: string
  }
  status?: "ok" | "error" | "partial"
  exitCode?: number
  passed?: boolean
  score?: number
  refs: {
    eventsPath?: string
    runJsonPath?: string
    resultPath?: string
    promptAuditPath?: string
    providerResponsePath?: string
    stageDir?: string
  }
}
```

### 3.3 OpenCode usage 提取函数

新增函数：

```ts
summarizeOpencodeUsage(events: OpencodeEvent[])
```

规则：

- 只读取 `event.type === "step_finish"`。
- 对每个 step 的 `part.tokens` 做累加。
- `part.cost` 做累加。
- 兼容字段：
  - `input`
  - `output`
  - `reasoning`
  - `total`
  - 如果未来出现 `cacheRead/cacheWrite` 也保留。
- 如果 `total` 缺失，用 input + output + reasoning 估算。
- 如果 step 没有 tokens，不报错，记为 partial。

### 3.4 OpenCode 落账位置

最小侵入方案：

1. `runOpencodeTask` 结束后，构造 `OpencodeTaskRun` 前，已经有：
   - title
   - selectedModel
   - selectedAgent
   - selectedVariant
   - result.events
   - result.modelResolution
   - input.live
   - runtimeScope

2. 在 return 前调用：

```ts
await recordOpencodeResourceUsage({
  cwd: input.cwd,
  task: finalTaskRun,
  input,
})
```

3. 如果有 `input.live.stageDir`，同时写：

```text
<stageDir>/resource-usage.json
```

4. 如果没有 stageDir，也至少写全局：

```text
runtime-state/resource-audit/opencode-usage.jsonl
```

为什么放这里：

- 所有 OpenCode session 都经过这个入口。
- 不用改 long-task / campaign / merger 各业务代码。
- 对旧任务和未来数据集都通用。

### 3.5 task / round / role 归因

优先从 `input.live` 取：

```text
phase
caseID
attempt
taskKind
methodID
```

从 title 兜底识别：

```text
Long Task Execute xxx -> role=executor, phase=long_task_execute
Long Task Validator xxx -> role=validator_llm, phase=long_task_validate
Campaign Worker xxx -> role=campaign_worker
Campaign Lead round-N -> role=campaign_lead
Campaign Reviewer round-N -> role=campaign_reviewer
Blank Eval xxx -> role=blank_eval
hierarchical-merge -> role=merger
hierarchical-repair -> role=merge_repair
```

从路径 / runtimeScope / campaignID 兜底解析：

```text
.../long-task-campaigns/<campaignID>/rounds/round-003/...
```

注意：第一版不用做到 100% 完美归因。只要 usage 不丢，归因可以后续修正。

## 4. Direct Chat 增强方案

### 4.1 现有表格增强

修改：

```text
auto-evolve/scripts/update-direct-chat-master-report.py
```

在 `Case Results` 增加：

```text
reasoningTokens
estimatedPromptTokens
promptBudgetTokens
skillTokens
materialTokens
questionTokens
outputInstructionTokens
skillTruncated
materialTruncated
costUSD
```

这些字段来自：

- `result.json.usage`
- `prompt-audit.json`
- `provider-response.json`

### 4.2 Direct Chat 单独 resource ledger

Direct Chat runner 每题结束时额外写：

```text
runtime-state/resource-audit/direct-chat-usage.jsonl
```

这样 Direct Chat 和 OpenCode 训练期可以进同一个总账。

### 4.3 避免重复统计

每条记录生成 deterministic id：

```text
source + runID + modelID + caseID + skillMode + attempt/resultPath hash
```

汇总时按 id 去重，避免补跑、多次更新总表造成重复。

## 5. 价格表设计

新增：

```text
auto-evolve/config/model-prices.json
```

示例：

```json
{
  "schema": "auto-evolve-model-prices/v1",
  "currency": "USD",
  "models": {
    "minimax-cn-coding-plan/MiniMax-M2.7": {
      "inputPerMillion": 0,
      "outputPerMillion": 0,
      "reasoningPerMillion": 0,
      "note": "Coding plan subscription; token cost unknown, record usage but USD is estimated as 0 unless manually configured."
    },
    "gpt-5.4-mini": {
      "inputPerMillion": null,
      "outputPerMillion": null,
      "reasoningPerMillion": null,
      "note": "Fill real price before paper reporting."
    }
  }
}
```

原则：

- 如果价格未知，token 仍然统计，USD 标记为 `price_missing`。
- 如果是订阅制 / coding plan，不硬算真实美元，单独标注 `subscription_plan`。
- 论文里可以同时报告：
  - raw token cost
  - estimated API cost
  - subscription-plan caveat

## 6. accepted / rejected edits 口径

我们系统不是 SkillOpt 的“单文件 prompt edit”结构，所以不能机械照搬。建议定义为：

### 6.1 长程 campaign 单任务层

accepted edit：

- 某一轮 lead 修改 pending expert package 后，最终 blank-agent acceptance 通过。
- 或 merge repair 后 replay 通过，补丁被保留。

rejected edit：

- lead/reviewer/pass 产生修改，但 final acceptance 失败。
- surface validator blocking 失败。
- blank eval product validator 失败。
- replay/regression 失败且该版本未被采纳。

### 6.2 合并层

accepted edit：

- 一个 merge group 输出通过该组 local replay / required gate，被进入下一层。

rejected edit：

- merge group 输出失败并触发 repair。
- repair 后仍失败但保留为 negative evidence 的，标为 `rejected_or_negative_evidence`，不要和 accepted 混淆。

### 6.3 输出字段

```text
acceptedSkillTransactions
rejectedSkillTransactions
negativeEvidenceTransactions
repairAttempts
repairAccepted
repairRejected
```

## 7. 汇总脚本设计

新增：

```text
auto-evolve/scripts/update-resource-cost-report.ts
```

输入：

```powershell
bun run auto-evolve/scripts/update-resource-cost-report.ts --out auto-evolve/runtime-state/resource-audit/resource-cost-report.xlsx
```

可选：

```powershell
--benchmark-out <path>
--direct-chat-runs-root <path>
--prices auto-evolve/config/model-prices.json
```

输出：

```text
resource-cost-report.xlsx
aggregate-summary.json
aggregate-summary.md
usage-records.csv
```

Excel sheets：

| Sheet | 内容 |
|---|---|
| Dashboard | 总 token、总 cost、按数据集/模型/阶段图表 |
| Run Summary | 每个 benchmark/direct-chat run 一行 |
| Usage Records | 每次模型 session / 每题 direct-chat 一行 |
| By Phase | 按 phase 聚合 |
| By Role | 按 role 聚合 |
| By Model | 按模型聚合 |
| By Task | 按 case/task 聚合 |
| Skill Size | initial/final skill tokens |
| Cost Benefit | baseline、final、delta、cost-per-point |
| Missing Prices | 哪些模型缺价格 |

## 8. 兼容旧运行数据

### 8.1 旧 OpenCode events 回扫

新增脚本支持回扫：

```powershell
bun run auto-evolve/scripts/update-resource-cost-report.ts --scan-existing
```

扫描：

```text
runtime-state/**/events.json
runtime-state/**/run.json
```

从 `events.json` 抽 token/cost，从邻近 `run.json` 抽 title/model/sessionID/status。

这样可以把之前已经跑过的 OfficeQA / SpreadsheetBench 尽量补进总账。

### 8.2 旧 Direct Chat run 回扫

扫描：

```text
runtime-state/direct-chat-runs/*/summary.json
runtime-state/direct-chat-runs/*/results/**/result.json
```

已有字段足够生成 usage rows。

## 9. 鲁棒性要求

### 9.1 Windows 并发写入

所有 JSONL 追加必须避免并发撕裂：

- 不直接多个进程 append 同一个 JSONL。
- 第一版推荐每个 session 先写本地 stage 文件：

```text
<stageDir>/resource-usage.json
```

- 全局汇总脚本再扫描收集。

如果要实时写全局 JSONL，则必须：

- 使用临时文件 + 原子 rename
- 或使用 per-process shard：

```text
runtime-state/resource-audit/shards/<pid>-<timestamp>.jsonl
```

第一版建议用 shard，最稳。

### 9.2 BOM / JSON 读取

Node 读取 JSON 前：

```ts
.replace(/^\uFEFF/, "")
```

Python 读取：

```py
encoding="utf-8-sig"
```

### 9.3 缺字段不失败

有些供应商不返回 usage。处理方式：

- `usageSource = "provider"`：真实 usage
- `usageSource = "opencode_event"`：OpenCode step_finish
- `usageSource = "estimate"`：按字符估算
- `usageSource = "missing"`：完全没有

论文报告里必须区分真实统计和估算统计。

## 10. 分阶段实现计划

### Phase 1：OpenCode session 级落账

目标：之后所有训练 session 都自动记录 token/cost。

改动：

- 新增 `resource-audit/contract.ts`
- 新增 `resource-audit/usage.ts`
- 新增 `resource-audit/recorder.ts`
- 修改 `opencode.ts`，在 `runOpencodeTask` 返回前记录 usage。
- 修改 `task-artifacts.ts`，把 `resourceUsage` 写进 `run.json` 或旁边 `resource-usage.json`。

烟测：

```powershell
bun --check auto-evolve/orchestrator/resource-audit/*.ts
bun --check auto-evolve/orchestrator/opencode.ts
bun run auto-evolve/scripts/smoke-resource-audit.ts
```

验收：

- mock events 里有 input/output/reasoning/cost 时能正确汇总。
- 没有 tokens 时不崩。
- 一个 session 多个 step_finish 时能累加。

### Phase 2：Direct Chat usage 补强

目标：Direct Chat 每题 token/cost 更完整，Excel 总表增加 reasoning / prompt audit 列。

改动：

- 修改 `direct-chat/runner.ts`，每题写 resource usage record。
- 修改 `update-direct-chat-master-report.py`，读取 `prompt-audit.json` 和 `provider-response.json`。
- `Case Results` 增加 reasoningTokens、estimatedPromptTokens、skillTokens、materialTokens、costUSD。

烟测：

```powershell
bun run auto-evolve/scripts/run-direct-chat-eval.ts --preflight-only ...
python auto-evolve/scripts/update-direct-chat-master-report.py
```

### Phase 3：全局 Resource Cost Report

目标：训练 + 测试 + Direct Chat 统一总表。

改动：

- 新增 `scripts/update-resource-cost-report.ts`
- 扫描 resource usage shards + existing events/result。
- 输出 JSON/CSV/Markdown/XLSX。

烟测：

```powershell
bun run auto-evolve/scripts/update-resource-cost-report.ts --scan-existing --dry-run
bun run auto-evolve/scripts/update-resource-cost-report.ts --benchmark-out auto-evolve/runtime-state/benchmark-runs/<run>
```

### Phase 4：论文指标层

目标：自动生成 SkillOpt Table 6 类似指标。

改动：

- skill token counter：
  - initial skill
  - final skill
  - merged skill
- accepted/rejected transaction counter。
- cost-per-point 计算。
- cost-benefit curve 数据导出。

输出：

```text
paper-resource-table.json
paper-resource-table.csv
paper-resource-table.md
cost-benefit-curve.csv
```

## 11. 推荐优先级

第一优先级：

1. OpenCode session 级 usage 落账。
2. Direct Chat 表格增加 reasoning / prompt audit / cost 字段。
3. 全局 resource-cost-report 能扫旧数据。

第二优先级：

1. accepted/rejected edit 统一口径。
2. Skill size 自动统计。
3. cost-per-point。

第三优先级：

1. 画图。
2. 论文专用 LaTeX table 导出。
3. 多价格版本对比。

## 12. 最小可用版本定义

最小可用版本完成后，必须能生成：

```text
auto-evolve/runtime-state/resource-audit/aggregate-summary.json
auto-evolve/runtime-state/resource-audit/usage-records.csv
auto-evolve/runtime-state/resource-audit/resource-cost-report.xlsx
```

并至少能回答：

```text
这次 SpreadsheetBench 训练已经消耗多少 input/output/reasoning/total tokens？
这些 tokens 分别花在 executor、lead、worker、blank eval、merge 哪些角色？
Direct Chat 每题实际使用多少 input/output/reasoning tokens？
最终 skill 有多少 tokens？
当前模型价格未知时，哪些 cost 字段是缺失估算？
```

## 13. 一句话总结

OpenCode 和 Direct Chat 底层都已经能拿到输入/输出 token；现在缺的是一个统一资源账本。正确做法是在 `runOpencodeTask` 这个总入口自动落账，再用全局汇总脚本把训练、合并、空白验收、Direct Chat 全部聚合成论文级资源成本报告。
