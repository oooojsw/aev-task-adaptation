# Resource / Cost Audit 实施计划

日期：2026-06-24

目标：把 Auto-Evolve 的训练、空白验收、合并、回撤、Direct Chat 测试全部纳入同一套资源账本。最终能生成论文可用的统计：输入 token、输出 token、reasoning token、总 token、估算成本、skill 长度、成功率、相对基线增益、每点增益成本。

## 0. 当前实现状态

2026-06-24 已完成第一版最小可用闭环：

- 新增 `orchestrator/resource-audit/contract.ts`、`usage.ts`、`recorder.ts`。
- OpenCode 侧已接入 `runOpencodeTask(...)`，每个 OpenCode 子会话结束后会写 `resource-usage.json` 和全局 shard。
- Direct Chat 侧已接入 `runOneCase(...)`，每题结束后会写 `resource-usage.json` 和全局 shard。
- `taskArtifactPaths(stageDir)` 已新增 `resourceUsagePath`。
- Direct Chat 总表脚本已增加 reasoning/prompt/skill/material usage 字段。
- 新增 `scripts/smoke-resource-audit.ts`，用 mock events / mock Direct Chat result 做不调用模型的烟测。
- 新增 `scripts/update-resource-cost-report.ts`，可扫描 `resource-usage.json` 并输出全局总账、任务级账单、轮次级账单和角色级账单。
- `update-resource-cost-report.ts --benchmark-out <run>` 已支持读取 `task-ledger.json / orchestrator-state.json / campaign.json`，把流水账归并到具体 task / campaign / round。
- 指定 `--benchmark-out` 时，会在该 benchmark 目录旁边同步写 `resource-task-summary.json/md/csv` 和 `resource-round-summary.csv`，方便单次实验自带成本报告。

已通过烟测：

```powershell
bun --check auto-evolve/orchestrator/resource-audit/contract.ts
bun --check auto-evolve/orchestrator/resource-audit/usage.ts
bun --check auto-evolve/orchestrator/resource-audit/recorder.ts
bun --check auto-evolve/orchestrator/opencode.ts
bun --check auto-evolve/orchestrator/direct-chat/runner.ts
bun --check auto-evolve/orchestrator/task-artifacts.ts
bun run auto-evolve/scripts/smoke-resource-audit.ts
python -m py_compile auto-evolve/scripts/update-direct-chat-master-report.py
python auto-evolve/scripts/smoke-direct-chat-master-report.py
bun run auto-evolve/scripts/update-resource-cost-report.ts --root auto-evolve/.tmp-resource-audit-smoke --out-dir auto-evolve/.tmp-resource-audit-smoke/report --json
bun run auto-evolve/scripts/update-resource-cost-report.ts --root auto-evolve/.tmp-resource-audit-smoke --benchmark-out auto-evolve/.tmp-resource-audit-smoke/benchmark-out --out-dir auto-evolve/.tmp-resource-audit-smoke/report --json
```

仍未完成：

- 模型价格表和 USD 成本精算。
- Excel 版 `resource-cost-report.xlsx`。
- initial/final skill tokens 和 accepted/rejected edits 的论文口径统计。
- cost-per-point / cost-benefit curve。

## 1. 本次代码调查结论

### 1.1 OpenCode 训练侧真实情况

所有 OpenCode 子会话最终都会走：

```text
auto-evolve/orchestrator/opencode.ts
runOpencodeTask(...)
runOpencodeTaskOnce(...)
```

`runOpencodeTaskOnce()` 负责真实启动 OpenCode CLI，随后把 stdout 解析成 events：

```text
parseEvents(stdout)
collectResponseText(events)
collectToolFailures(events)
```

OpenCode 的资源信息已经在事件里存在，主要是：

```text
event.type === "step_finish"
event.part.cost
event.part.tokens
```

现有代码已经把这些信息写进文字报告：

```text
auto-evolve/orchestrator/action-trace.ts
auto-evolve/orchestrator/session-execution-report.ts
```

但现在的问题是：这些信息只是写在日志里，没有进入一个机器可汇总的资源账本。

### 1.2 OpenCode artifacts 真实落点

每个 OpenCode stage 目录现在会写：

```text
prompt.txt
stdout.log
stderr.log
response.txt
action_trace.md
session_execution_report.md
session_learning_log.md
session_task_manifest.md
events.json
tool_failures.json
run.json
```

路径定义在：

```text
auto-evolve/orchestrator/task-artifacts.ts
taskArtifactPaths(stageDir)
writeTaskArtifacts(stageDir, task, input)
```

实时运行中也会反复写这些文件，入口是：

```text
auto-evolve/orchestrator/opencode.ts
writeLiveTask(...)
```

关键缺口：`run.json` 目前只保存模型、状态、sessionID、路径和权限，不保存资源统计；如果未来只靠回扫 `events.json`，能补，但不够稳。

### 1.3 Direct Chat 测试侧真实情况

Direct Chat 每题现在已经写：

```text
prompt.system.txt
prompt.user.txt
prompt-audit.json
request-audit.json
provider-response.json
response.txt
answer-extraction.json
answer.txt / answer.json
result.json
```

关键字段：

```text
result.json.usage.inputTokens
result.json.usage.outputTokens
result.json.usage.reasoningTokens
result.json.usage.totalTokens
prompt-audit.json.estimatedPromptTokens
prompt-audit.json.skill.includedTokens
prompt-audit.json.materials[*].includedTokens
```

相关文件：

```text
auto-evolve/orchestrator/direct-chat/contract.ts
auto-evolve/orchestrator/direct-chat/material-budget.ts
auto-evolve/orchestrator/direct-chat/runner.ts
auto-evolve/orchestrator/direct-chat/providers/openai-compatible.ts
auto-evolve/scripts/update-direct-chat-master-report.py
```

当前总表 `Case Results` 只有：

```text
inputTokens
outputTokens
totalTokens
```

缺少：

```text
reasoningTokens
estimatedPromptTokens
skillTokens
materialTokens
promptBudgetTokens
costUSD
usageSource
```

### 1.4 最适合的系统级切入点

训练侧不要改每个业务模块。不要分别去改 long-task、campaign、blank-eval、merger、repair。

最稳的切入点是：

```text
OpenCode 侧：runOpencodeTask(...) 结束前统一落账
Direct Chat 侧：runSingleCase(...) 写 result.json 后统一落账
总表侧：update-resource-cost-report.ts 扫描 stage/resource-usage.json 和 direct-chat results
```

这样不会漏掉新数据集，也不会和某个 OfficeQA / SpreadsheetBench 的业务逻辑绑死。

## 2. 最终产物

### 2.1 每个 OpenCode stage 旁边新增

```text
<stageDir>/resource-usage.json
```

用途：这个 stage 的一次 OpenCode session 用了多少资源。

### 2.2 全局资源账本目录

```text
auto-evolve/runtime-state/resource-audit/
  shards/
    opencode-*.jsonl
    direct-chat-*.jsonl
  aggregate-summary.json
  aggregate-summary.md
  usage-records.csv
  resource-cost-report.xlsx
```

说明：

- `resource-usage.json` 是本地真源，跟着 stage 走。
- `shards/*.jsonl` 是全局账本分片，避免 Windows 多进程同时 append 一个文件导致文件锁冲突。
- `aggregate-summary.*` 和 Excel 是汇总结果，可以反复重建。

### 2.3 每个 benchmark out 目录新增

```text
<benchmark-out>/resource-summary.json
<benchmark-out>/resource-summary.md
<benchmark-out>/resource-usage.csv
```

用途：单次实验自己的成本账，不必每次翻全局总账。

## 3. 新模块设计

新增目录：

```text
auto-evolve/orchestrator/resource-audit/
  contract.ts
  usage.ts
  recorder.ts
  price-table.ts
  aggregate.ts
```

新增脚本：

```text
auto-evolve/scripts/smoke-resource-audit.ts
auto-evolve/scripts/update-resource-cost-report.ts
```

### 3.1 contract.ts

定义统一记录：

```ts
export type ResourceUsageRecord = {
  schema: "auto-evolve-resource-usage/v1"
  recordID: string
  createdAt: string
  source: "opencode" | "direct-chat" | "scan-existing"
  runID?: string
  benchmarkOutDir?: string
  datasetID?: string
  taskID?: string
  caseID?: string
  campaignID?: string
  roundNumber?: number
  stageDir?: string
  phase?: string
  role?: string
  title?: string
  sessionID?: string
  model?: string
  provider?: string
  resolvedModel?: string
  usage: {
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  cost: {
    rawCost?: number
    rawCurrency?: string
    estimatedUSD?: number
    priceStatus: "ok" | "missing" | "subscription" | "raw-only"
    priceSource?: string
  }
  status: "ok" | "error" | "partial"
  passed?: boolean
  score?: number
  exitCode?: number
  usageSource: "opencode_event" | "provider" | "estimate" | "missing"
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

### 3.2 usage.ts

实现两个核心函数：

```ts
summarizeOpencodeUsage(events: OpencodeEvent[]): ResourceUsageSummary
summarizeDirectChatUsage(resultJson, promptAuditJson, providerResponseJson): ResourceUsageSummary
```

OpenCode 规则：

- 只累计 `step_finish`。
- 优先读 `event.part.tokens`。
- `event.part.cost` 单独累加为 raw cost。
- 如果 `totalTokens` 缺失，用 `input + output + reasoning` 兜底。
- 如果某个 step 没有 usage，不报错，记录 `partial`。

Direct Chat 规则：

- `result.json.usage` 是供应商真实 usage。
- `prompt-audit.json.estimatedPromptTokens` 是估算 prompt usage。
- 两者同时保留，不能互相覆盖。
- 如果供应商不返回 usage，则 usageSource 标记为 `estimate` 或 `missing`。

### 3.3 recorder.ts

职责：

- 写 `<stageDir>/resource-usage.json`。
- 写全局 shard：

```text
runtime-state/resource-audit/shards/opencode-<pid>-<timestamp>.jsonl
runtime-state/resource-audit/shards/direct-chat-<pid>-<timestamp>.jsonl
```

Windows 规则：

- 不多个进程共同 append 同一个文件。
- shard 文件名带 pid 和 timestamp。
- 单条 JSONL 写入失败不能打断正式训练，只能写 warning 到 stderr 或当前 stage。

### 3.4 price-table.ts

新增价格配置：

```text
auto-evolve/config/model-prices.json
```

第一版价格未知也能用：

```json
{
  "schema": "auto-evolve-model-prices/v1",
  "currency": "USD",
  "models": {
    "minimax-cn-coding-plan/MiniMax-M2.7": {
      "priceMode": "subscription",
      "inputPerMillion": null,
      "outputPerMillion": null,
      "reasoningPerMillion": null,
      "note": "Coding plan subscription; token usage is counted but USD cost is not directly comparable."
    }
  }
}
```

原则：

- 不知道价格时，不能乱编 USD。
- token 必须照样统计。
- 报告里标记 `price_missing` 或 `subscription`。

### 3.5 aggregate.ts

职责：

- 从 `resource-usage.json`、shards、旧 `events.json`、Direct Chat `result.json` 统一收集记录。
- 按 run、dataset、phase、role、model、case 聚合。
- 输出 JSON / Markdown / CSV 的中间结果。

Excel 可以在脚本层做，不必塞进 orchestrator 库。

## 4. 代码改造顺序

### Phase 1：OpenCode session 级落账

改动文件：

```text
auto-evolve/orchestrator/resource-audit/contract.ts
auto-evolve/orchestrator/resource-audit/usage.ts
auto-evolve/orchestrator/resource-audit/recorder.ts
auto-evolve/orchestrator/opencode.ts
auto-evolve/orchestrator/task-artifacts.ts
auto-evolve/scripts/smoke-resource-audit.ts
```

具体做法：

1. `taskArtifactPaths(stageDir)` 增加：

```text
resourceUsagePath: path.join(stageDir, "resource-usage.json")
```

2. `writeLiveTask(...)` 在写 `run.json` 时附带轻量字段：

```json
"resourceUsagePath": ".../resource-usage.json"
```

实时运行中可以不反复计算完整 usage，避免频繁写大文件。

3. `runOpencodeTask(...)` 最终 return 前构造 `taskRun`，然后调用：

```ts
await recordOpencodeResourceUsage({ cwd: input.cwd, taskRun, live: input.live })
```

4. `recordOpencodeResourceUsage(...)`：

- 从 `taskRun.result.events` 汇总 token。
- 从 `input.live.stageDir` 写 `resource-usage.json`。
- 同时写 shard。
- 如果没有 `input.live`，只写 shard。

验收命令：

```powershell
bun --check auto-evolve/orchestrator/resource-audit/contract.ts
bun --check auto-evolve/orchestrator/resource-audit/usage.ts
bun --check auto-evolve/orchestrator/resource-audit/recorder.ts
bun --check auto-evolve/orchestrator/opencode.ts
bun --check auto-evolve/orchestrator/task-artifacts.ts
bun run auto-evolve/scripts/smoke-resource-audit.ts
```

验收标准：

- mock 事件里多个 `step_finish` 能正确累计。
- `input/output/reasoning/total` 都能读。
- `total` 缺失时能兜底。
- 没有 usage 的事件不崩。
- stage 目录能看到 `resource-usage.json`。
- 全局 shard 能看到一条 JSONL。

### Phase 2：Direct Chat 逐题落账和总表增强

改动文件：

```text
auto-evolve/orchestrator/direct-chat/runner.ts
auto-evolve/scripts/update-direct-chat-master-report.py
auto-evolve/scripts/smoke-direct-chat-master-report.py
```

具体做法：

1. `runSingleCase(...)` 写完 `result.json` 后调用：

```ts
await recordDirectChatResourceUsage({ outDir, caseDir, result, promptAuditPath, providerResponsePath })
```

2. Direct Chat 总表 `Case Results` 增加列：

```text
reasoningTokens
estimatedPromptTokens
promptBudgetTokens
skillTokens
materialTokens
materialCount
skillTruncated
materialTruncated
usageSource
costUSD
```

3. `Run Ledger` 增加聚合列：

```text
inputTokens
outputTokens
reasoningTokens
totalTokens
estimatedPromptTokens
costUSD
priceStatus
```

4. 读取失败要降级为 warning，不能让一个坏 `prompt-audit.json` 打崩整张总表。

验收命令：

```powershell
bun --check auto-evolve/orchestrator/direct-chat/runner.ts
python auto-evolve/scripts/smoke-direct-chat-master-report.py
```

额外烟测：

```powershell
bun run auto-evolve/scripts/run-direct-chat-eval.ts --preflight-only <现有 smoke 参数>
```

### Phase 3：全局资源成本报告

新增：

```text
auto-evolve/scripts/update-resource-cost-report.ts
```

能力：

```powershell
bun run auto-evolve/scripts/update-resource-cost-report.ts --scan-existing
bun run auto-evolve/scripts/update-resource-cost-report.ts --benchmark-out auto-evolve/runtime-state/benchmark-runs/<run>
bun run auto-evolve/scripts/update-resource-cost-report.ts --direct-chat-runs-root auto-evolve/runtime-state/direct-chat-runs
```

输出：

```text
auto-evolve/runtime-state/resource-audit/aggregate-summary.json
auto-evolve/runtime-state/resource-audit/aggregate-summary.md
auto-evolve/runtime-state/resource-audit/usage-records.csv
auto-evolve/runtime-state/resource-audit/resource-cost-report.xlsx
```

Excel sheet：

```text
Dashboard
Run Summary
Usage Records
By Phase
By Role
By Model
By Task
Direct Chat
Skill Size
Cost Benefit
Missing Prices
Warnings
```

第一版即使不做漂亮图，也必须把表格数据做全。

### Phase 4：论文指标层

新增统计：

```text
initialSkillTokens
finalSkillTokens
acceptedSkillTransactions
rejectedSkillTransactions
negativeEvidenceTransactions
repairAttempts
baselineScore
finalScore
deltaScorePoints
costPerPointTokens
costPerPointUSD
```

数据来源：

- 初始 skill：seed expert workspace / initial skill bundle。
- 最终 skill：merged skill / final skill output。
- accepted / rejected：campaign final acceptance、surface gate、blank eval、train replay、merge repair。
- baseline / final score：Direct Chat official experiments 或 held-out test。

这一步容易涉及口径争议，建议在 Phase 1-3 稳定后做。

## 5. 旧数据回扫策略

### 5.1 OpenCode 旧数据

扫描：

```text
auto-evolve/runtime-state/**/events.json
auto-evolve/runtime-state/**/run.json
```

如果旁边没有 `resource-usage.json`：

- 从 `events.json` 提取 usage。
- 从 `run.json` 提取 title、model、sessionID、status。
- 从路径推断 phase / role / campaign / round / case。
- 写入汇总时 `source = "scan-existing"`，不要伪装成实时落账。

### 5.2 Direct Chat 旧数据

扫描：

```text
auto-evolve/runtime-state/direct-chat-runs/*/summary.json
auto-evolve/runtime-state/direct-chat-runs/*/results/**/result.json
auto-evolve/runtime-state/direct-chat-runs/*/results/**/prompt-audit.json
auto-evolve/runtime-state/direct-chat-runs/*/results/**/provider-response.json
```

能读多少算多少：

- `result.json.usage` 有真实 usage。
- `prompt-audit.json` 有估算 prompt 和 skill/material 组成。
- 缺文件时写 warning，不丢整条结果。

## 6. 去重规则

每条记录需要 deterministic `recordID`。

OpenCode：

```text
opencode:<stageDirHash>:<sessionID>:<eventsHash>
```

Direct Chat：

```text
direct-chat:<runID>:<modelID>:<caseID>:<skillMode>:<resultHash>
```

汇总时按 `recordID` 去重。

如果同一个 case 有多次补跑，保留所有原始 usage records，但在 “Official Cost Benefit” 里按官方组合规则选择最终计分版本。

## 7. 角色与阶段归因

第一版采用三层兜底：

### 7.1 优先读 live descriptor

`input.live` 里已有：

```text
phase
caseID
attempt
maintenanceRound
methodID
```

这是最可信来源。

### 7.2 再看 title

示例：

```text
Long Task Execute -> role=executor
Long Task Validator -> role=validator
Campaign Worker -> role=campaign_worker
Campaign Lead -> role=campaign_lead
Campaign Reviewer -> role=campaign_reviewer
Blank Eval -> role=blank_eval
mi-append-repair -> role=merge_repair
```

### 7.3 最后看路径

路径中如果有：

```text
long-task-campaigns/<campaignID>/rounds/round-003/
phase4-repair
blank-eval
hierarchical-merge
```

就补 campaignID、roundNumber、phase。

不要追求第一版 100% 归因完美。第一优先级是 usage 不丢。

## 8. 失败和鲁棒性

资源统计不能影响训练主流程。

规则：

- 统计写失败，只写 warning，不把任务判失败。
- Excel 汇总失败，不影响已有 summary/result。
- JSON 读取使用 UTF-8 BOM 兼容。
- Windows 写文件使用临时文件 + rename 或 shard。
- 不把 API key、cookie、auth、private answers 写入资源账本。
- 路径可以写，但统一正斜杠，避免 JSON 反斜杠灾难。

## 9. 和现有总控配置的关系

建议在 `auto-evolve/config.json` 里新增：

```json
{
  "resourceAuditConfig": {
    "enabled": true,
    "writeStageUsage": true,
    "writeGlobalShards": true,
    "priceTablePath": "auto-evolve/config/model-prices.json",
    "scanExistingByDefault": false
  }
}
```

第一版也可以不加配置，默认开启；但长期最好纳入总控。

原因：

- 用户已经要求“所有配置相关尽量进总控”。
- 训练跑很久，资源账本不能靠临时命令记忆。
- 未来可以关闭 Excel 自动生成，只保留 JSON/CSV。

## 10. 最小可用版本定义

最小可用版本完成后，必须能回答：

```text
这次 SpreadsheetBench 训练到目前消耗多少 input/output/reasoning/total token？
这些 token 分别花在 executor、lead、blank eval、merge repair 等哪些角色？
Direct Chat 每道题用了多少真实 input/output/reasoning token？
每道题估算 prompt 有多大，其中 skill 和材料分别占多少？
当前哪些模型价格缺失，哪些是订阅制不能直接折美元？
最终 skill 有多少 token，部署时比 no-skill 多塞了多少 token？
```

## 11. 推荐执行顺序

推荐直接按下面顺序做：

1. 先做 Phase 1：OpenCode `resource-usage.json` + shard。
2. 再做 Phase 2：Direct Chat 总表增强。
3. 再做 Phase 3：全局 `update-resource-cost-report.ts`。
4. 最后做 Phase 4：SkillOpt Table 6 风格论文指标。

不要一开始就追求论文表格全部完美。先让每次模型调用都不丢账，再做聚合和美化。

## 12. 一句话给接手 Agent

这件事不是“重新估算 token”，而是把系统已经产生的 OpenCode `step_finish` usage 和 Direct Chat `result.json/prompt-audit.json` 接成统一资源账本；先在每个 session 旁边落 `resource-usage.json`，再用全局脚本扫描汇总，最后才算论文里的成本增益。

## 13. 追加方案：任务级 / 轮次级资源账单

日期：2026-06-24

### 13.1 为什么需要这一层

当前第一版资源账本的粒度是：

```text
一个 OpenCode 子会话 = 一条 resource-usage.json
一个 Direct Chat case = 一条 resource-usage.json
```

这个粒度适合“不漏账”，但不适合人直接看，也不够论文级。真实长程任务不是一次调用，而是一串调用：

```text
round-001 executor
round-001 validator
round-001 workers
round-001 lead
round-001 reviewer
round-001 blank eval
round-002 ...
```

所以需要在流水账上再做一层“任务级账单”，把同一个 `caseID / campaignID` 下所有 session 汇总成一张可读报告。

目标问题：

```text
某一道长程任务一共跑了几轮？
每轮花了多少 token？
executor / lead / blank eval / repair 分别花了多少？
最终有没有 verified_success？
如果失败，是 round_limit、completion gate、blank eval 失败，还是基础设施失败？
哪个阶段最烧 token？
成功任务和失败任务的成本差异是多少？
```

### 13.2 代码调查后的可用真源

不要新增一套训练状态。任务级账单应该从已有真源派生。

#### A. Benchmark 层真源

```text
<benchmark-out>/task-ledger.json
<benchmark-out>/orchestrator-state.json
<benchmark-out>/scorecard.md
```

相关代码：

```text
auto-evolve/orchestrator/history-manager.ts
auto-evolve/scripts/run-benchmark-orchestrator.ts
```

其中：

- `task-ledger.json` 记录 `taskID -> activeCampaignID / activeCampaignDir / attempts / generationID / status`。
- `orchestrator-state.json` 记录 train queue 的 `id / status / campaignDir`。
- `scorecard.md` 是人看的简表，但不适合机器汇总。

#### B. Campaign 层真源

```text
runtime-state/long-task-campaigns/<campaignID>/campaign.json
runtime-state/long-task-campaigns/<campaignID>/history.jsonl
runtime-state/long-task-campaigns/<campaignID>/rounds/round-xxx/round-summary.md
runtime-state/long-task-campaigns/<campaignID>/rounds/round-xxx/run-trace.json
runtime-state/long-task-campaigns/<campaignID>/rounds/round-xxx/final-acceptance/result.json
```

相关代码：

```text
auto-evolve/orchestrator/long-task-campaign/contract.ts
auto-evolve/orchestrator/long-task-campaign/repository.ts
auto-evolve/orchestrator/long-task-campaign/runner.ts
```

其中：

- `campaign.json` 有 `id/title/baseSpecPath/maxRounds/currentRound/status/lastSummary/lastFinalAcceptancePassed/runLineage/reuse/recovery`。
- `LongTaskCampaignRoundRecord` 里有每轮 `finalStatus/summary/failurePacketCount/retryLessonCount/learningUnitCount/finalAcceptanceSignal/gateFailureKind`。
- `run-trace.json` 有本轮长程执行内部 attempt、工具命令、失败教训、成功路径等。
- `final-acceptance/result.json` 能判断 blank-agent 闭卷验收是否通过。

#### C. Resource Audit 层真源

```text
**/resource-usage.json
runtime-state/resource-audit/shards/*.jsonl
```

其中第一版记录已包含：

```text
caseID
campaignID
roundNumber
phase
role
title
sessionID
model
provider
usage
cost
status
exitCode
refs.stageDir
```

这足够按 `campaignID + roundNumber + role` 做汇总。

### 13.3 新增输出结构

建议由 `scripts/update-resource-cost-report.ts` 在扫描后额外输出：

```text
auto-evolve/runtime-state/resource-audit/
  task-summary.json
  task-summary.md
  task-summary.csv
  round-summary.csv
  task-role-summary.csv
```

如果指定了 `--benchmark-out <path>`，还应该在 benchmark 目录旁边写：

```text
<benchmark-out>/
  resource-task-summary.json
  resource-task-summary.md
  resource-task-summary.csv
  resource-round-summary.csv
```

### 13.4 任务级记录结构

建议新增类型：

```ts
export interface ResourceTaskSummary {
  schema: "auto-evolve-resource-task-summary/v1"
  taskID: string
  caseID?: string
  campaignID?: string
  campaignDir?: string
  benchmarkRunID?: string
  generationID?: string
  attemptID?: string
  historyPolicy?: string
  taskStatus: string
  campaignStatus?: string
  finalStatus?: string
  verified: boolean
  roundCount: number
  maxRounds?: number
  firstSeenAt?: string
  lastSeenAt?: string
  modelRequested?: string
  modelResolved?: string
  totals: {
    sessions: number
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    totalTokens: number
    rawCost: number
  }
  byRole: Record<string, ResourceUsageRollup>
  byPhase: Record<string, ResourceUsageRollup>
  byRound: ResourceRoundSummary[]
  failure: {
    kind?: string
    summary?: string
    lastFinalAcceptancePassed?: boolean
    lastFinalAcceptanceResultPath?: string
    recoveryAction?: string
    recoveryReason?: string
  }
  refs: {
    campaignJson?: string
    taskLedger?: string
    orchestratorState?: string
    pendingExpertPackage?: string
  }
}
```

辅助类型：

```ts
export interface ResourceRoundSummary {
  roundNumber: number
  roundID?: string
  finalStatus?: string
  gateFailureKind?: string
  finalAcceptancePassed?: boolean
  sessions: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  rawCost: number
  byRole: Record<string, ResourceUsageRollup>
  refs: {
    roundSummaryPath?: string
    runTracePath?: string
    finalAcceptanceResultPath?: string
  }
}

export interface ResourceUsageRollup {
  sessions: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  rawCost: number
}
```

### 13.5 汇总算法

#### Step 1：读取资源流水账

沿用现有 `update-resource-cost-report.ts`：

```text
扫描 root 下所有 resource-usage.json
按 recordID 去重
得到 ResourceUsageRecord[]
```

#### Step 2：读取 benchmark 户口本

如果传入：

```powershell
--benchmark-out auto-evolve/runtime-state/benchmark-runs/<run>
```

读取：

```text
<benchmark-out>/task-ledger.json
<benchmark-out>/orchestrator-state.json
```

建立映射：

```text
campaignID -> taskID
campaignDir -> taskID
taskID -> activeCampaignID / activeCampaignDir / status / attemptID / generationID
```

如果没有 benchmark-out，也可以从 `record.campaignID` 和 campaign.json 做弱汇总，但 taskID 可能缺失。

#### Step 3：读取 campaign 状态

对每个 campaign：

```text
campaign.json
history.jsonl
rounds/round-xxx/final-acceptance/result.json
rounds/round-xxx/run-trace.json
```

提取：

```text
campaignStatus
currentRound
maxRounds
lastSummary
lastGateFailureKind
lastFinalAcceptancePassed
recovery.action/reason
runLineage.benchmarkRunID/generationID/taskID/attemptID
```

#### Step 4：按 campaignID + roundNumber 聚合 usage

聚合键：

```text
taskKey = taskID || caseID || campaignID
roundKey = campaignID + roundNumber
roleKey = role || phase || "unknown"
```

角色建议规整：

```text
long_task_execute -> executor
long_task_validate -> validator
campaign_worker -> worker
campaign_lead -> lead
campaign_review -> reviewer
deployment_acceptance / blank_eval -> blank_eval
merge / hierarchical_merge -> merger
repair / merge_repair -> repair
direct_chat_eval -> direct_chat
```

注意：原始 `role` 不要丢，规整角色只作为 `normalizedRole`。

#### Step 5：输出三张表

`task-summary.csv` 每个任务一行：

```text
taskID,campaignID,status,verified,roundCount,maxRounds,totalSessions,inputTokens,outputTokens,reasoningTokens,totalTokens,rawCost,executorTokens,leadTokens,blankEvalTokens,workerTokens,validatorTokens,repairTokens,lastFailureKind,lastSummary
```

`round-summary.csv` 每轮一行：

```text
taskID,campaignID,roundNumber,finalStatus,finalAcceptancePassed,sessions,totalTokens,executorTokens,leadTokens,blankEvalTokens,workerTokens,validatorTokens,gateFailureKind,summary
```

`task-role-summary.csv` 每任务每角色一行：

```text
taskID,campaignID,role,sessions,inputTokens,outputTokens,reasoningTokens,totalTokens,rawCost
```

### 13.6 是否要写回旧 stage

建议分两层做：

#### 默认：只汇总，不回写

```powershell
bun run auto-evolve/scripts/update-resource-cost-report.ts --root auto-evolve/runtime-state --benchmark-out <run>
```

只扫描已有 `resource-usage.json`，不改旧目录。

#### 可选：旧数据回填

后续增加：

```powershell
--backfill-stage-files
```

做法：

- 扫描旧 `events.json`。
- 读取同目录 `run.json`。
- 生成同目录 `resource-usage.json`。
- 标记 `source: "scan-existing"` 或在 record 里加 `backfilled: true`。

注意：回填会修改旧运行目录，所以默认不要开启。正式论文统计前可以单独跑一次，并保留 `backfill-report.json`。

### 13.7 对当前 SpreadsheetBench 续跑的意义

现在 SpreadsheetBench run 是：

```text
auto-evolve/runtime-state/benchmark-runs/20260622-171219-spreadsheetbench-official80-minimax27-hier5
```

下一步若补任务级账单，推荐命令应该是：

```powershell
bun run auto-evolve/scripts/update-resource-cost-report.ts `
  --root auto-evolve/runtime-state `
  --benchmark-out auto-evolve/runtime-state/benchmark-runs/20260622-171219-spreadsheetbench-official80-minimax27-hier5 `
  --out-dir auto-evolve/runtime-state/resource-audit
```

它应该能给出：

```text
80 个训练任务各自花了多少
已成功 17 个任务平均多少 token
未成功任务平均多少 token
每个失败任务最多烧在哪个角色
round_limit / recovery / infrastructure_failure 各自成本
```

这会直接帮助判断“某些任务为什么贵、为什么失败、是否值得继续跑”。

### 13.8 为什么不直接把所有明细塞进一张总表

不能只做一张大表。原因：

- 流水账太细，人看不懂。
- 任务级账单适合决策：哪道题贵、哪道题失败、哪道题值得重跑。
- 轮次级账单适合分析系统：第几轮开始空白验收、哪轮 lead 烧最多、哪轮进入重复失败。
- 角色级账单适合论文：我们的成本主要花在学习、验证、盲测还是合并。

所以最终应该是四层：

```text
Raw usage records      每次模型调用
Round summary          每轮
Task summary           每道长程任务
Run / experiment table 整个数据集实验
```

### 13.9 最小实现建议

当前已实现的最小改造主要集中在：

```text
auto-evolve/scripts/update-resource-cost-report.ts
auto-evolve/scripts/smoke-resource-audit.ts
```

训练 runner 没有再改；任务级账单完全从已有真源派生，不影响断点续传和训练状态机。

已新增参数：

```text
--benchmark-out <path>
```

已新增输出：

```text
task-summary.json
task-summary.md
task-summary.csv
round-summary.csv
task-role-summary.csv
```

指定 `--benchmark-out` 时，额外写回：

```text
<benchmark-out>/resource-task-summary.json
<benchmark-out>/resource-task-summary.md
<benchmark-out>/resource-task-summary.csv
<benchmark-out>/resource-round-summary.csv
```

烟测：

```text
用 .tmp-resource-audit-smoke 构造一个 fake benchmark-out：
- task-ledger.json
- orchestrator-state.json
- long-task-campaigns/campaign-smoke/campaign.json
- round-003/resource-usage.json
确认 task-summary 里 taskID、campaignID、roundNumber、role、totalTokens 全部正确。
```

已通过烟测：

```powershell
bun --check auto-evolve/scripts/update-resource-cost-report.ts
bun --check auto-evolve/scripts/smoke-resource-audit.ts
bun run auto-evolve/scripts/smoke-resource-audit.ts
```

### 13.10 一句话总结

第一版资源账本已经解决“不漏每次调用”；下一步任务级账单要解决“每道长程任务到底花了多少、失败在哪里、哪一轮最贵”。实现时不要改训练状态机，只从 `task-ledger.json + campaign.json + round records + resource-usage.json` 派生汇总。
