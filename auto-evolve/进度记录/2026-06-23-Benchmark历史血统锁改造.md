# 2026-06-23 Benchmark 历史血统锁改造

## 背景

SpreadsheetBench 训练中暴露出一个平台层问题：失败、假活、错误模型、错误平台产生的旧 campaign 会残留在 `runtime-state`，后续断点续传可能继续捞这些旧历史。这样会把已经污染的上下文带进新一轮训练，造成“明明说重跑，实际上还在续旧脏历史”。

用户要求先停止现有训练，再改造历史管理机制。

## 已停止的训练

已停止当前 SpreadsheetBench 训练相关进程，包括：

- `run-benchmark-orchestrator`
- `run-long-task-campaign`
- `resume-long-task-campaign`
- 相关 `opencode.exe` SpreadsheetBench 子会话

全局 `C:\Users\ZhuanZ\.codex\AGENTS.md` 中对应 monitor 状态已更新为 `STOPPED_FOR_HISTORY_LINEAGE_REFACTOR`。

## 核心改造

新增统一户口本：

```text
<benchmark out>/task-ledger.json
```

每个训练任务现在有明确的：

- `runID`
- `generationID`
- `taskID`
- `attemptID`
- `campaignID`
- `campaignDir`
- `specHash`
- `status`

自动续传只允许续传当前户口本授权的 campaign。没有血统信息、代际不匹配、任务不匹配、attempt 不匹配的旧 campaign，即使磁盘上还存在，也不会被外层批跑自动复用。

## 新增代码

新增：

```text
auto-evolve/orchestrator/history-manager.ts
auto-evolve/scripts/smoke-benchmark-history-manager.ts
```

改动：

```text
auto-evolve/orchestrator/long-task-campaign/contract.ts
auto-evolve/orchestrator/long-task-campaign/runner.ts
auto-evolve/scripts/run-benchmark-orchestrator.ts
auto-evolve/scripts/run-officeqa-pro-benchmark.ts
auto-evolve/cli.ts
auto-evolve/README.md
```

## 新增历史策略

通用批跑入口新增：

```powershell
--history-policy <policy>
```

2026-06-24 已进一步接入总控：

```json
{
  "historyConfig": {
    "policy": "fresh-non-verified",
    "allowLegacyAutoResume": false,
    "keepVerified": true,
    "requireLineageForAutoResume": true
  }
}
```

现在不传 `--history-policy` 时，`run-benchmark-orchestrator.ts` 会默认读取 `auto-evolve/config.json` 里的 `historyConfig.policy`。命令行参数仍然可以临时覆盖。

策略含义：

- `resume-current-generation`：默认，只续当前户口本当前代际。
- `fresh-non-verified`：保留可信 `verified_success`，其他任务新代际重跑。
- `fresh-all`：全部新代际重跑。
- `resume-explicit-only`：外层不自动捞旧任务，只允许显式人工恢复。
- `audit-only`：只盘点，不应启动新训练。

## 推荐恢复 SpreadsheetBench 的方式

下一次恢复 SpreadsheetBench 官方 80 条训练时，推荐使用：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts `
  --task-pack-root auto-evolve/task-packs/real-long-tasks/spreadsheetbench-learnbench `
  --train-split auto-evolve/task-packs/real-long-tasks/spreadsheetbench-learnbench/splits/train-skillopt-official.json `
  --out auto-evolve/runtime-state/benchmark-runs/20260622-171219-spreadsheetbench-official80-minimax27-hier5 `
  --history-policy fresh-non-verified `
  <原训练/合并/回撤参数>
```

这会保留已经真实 `verified_success` 且产物仍存在的任务，例如之前记录的 `32438`、`48365`、`32255`；其他未成功项会新建 attempt 重跑，不再续传旧污染历史。

## 烟测结果

已通过：

```powershell
bun run auto-evolve/scripts/smoke-benchmark-history-manager.ts
```

确认点：

- 旧无血统 campaign 不会被新 benchmark 自动授权。
- 匹配当前 `runID/generationID/taskID/attemptID` 的 campaign 可以授权续传。
- `fresh-non-verified` 会进入新代际，并保留可信已成功项。

已做一次 dry-run，确认 `task-ledger.json` 与 `train-plan.json` 会生成 expected attempt。

## 后续注意

- 不要再靠全局扫描旧 campaign 目录来决定是否续传。
- 正式实验默认不要开启 `AUTO_EVOLVE_ALLOW_LEGACY_CAMPAIGN_RESUME=1`。
- 如果用户要求“除了成功的，其他全部重跑”，优先使用 `--history-policy fresh-non-verified`，不要手工删目录来赌状态。

## 额外发现：bun --check 误启动入口脚本

改造收尾时发现 `bun --check auto-evolve/scripts/run-officeqa-pro-benchmark.ts` 会把入口脚本当成 `import.meta.main` 执行，从而误启动 OfficeQA 训练。原因是 Bun 把 `--check` 放在 `process.execArgv`，不是 `process.argv`。

已给以下入口加保护：

```text
auto-evolve/scripts/run-officeqa-pro-benchmark.ts
auto-evolve/scripts/run-benchmark-orchestrator.ts
```

保护逻辑：

```ts
if (import.meta.main && !process.execArgv.includes("--check")) {
  await main()
}
```

复测结果：两个入口在 `bun --check` 下都会直接退出，不再启动训练子进程。

## 2026-06-24：失败恢复模式接入总控

这次继续补了“失败任务不要无脑续传”的控制层。背景是 SpreadsheetBench 训练中，旧的外层调度会把已经进入 `failed / round_limit_reached` 的任务重新捞起来，导致带着错误历史继续烧额度。新的逻辑把恢复分成三类：

- 已经 `verified_success`：按 `historyConfig.keepVerified=true` 保留，不重复训练。
- 非终态或基础设施失败：可以自动恢复或重跑，例如假活、进程崩、锁、spawn、平台超时。
- 真实产物失败：默认先保留为失败，不自动反复重跑，除非用户显式打开。

新增总控字段位于 `auto-evolve/config.json`：

```json
{
  "historyConfig": {
    "policy": "fresh-non-verified",
    "resumeMode": "safe-non-terminal",
    "allowLegacyAutoResume": false,
    "keepVerified": true,
    "requireLineageForAutoResume": true,
    "excludedTaskIDs": [],
    "retryInfraFailed": true,
    "retryProductFailed": false,
    "maxAttemptsPerTask": 2
  }
}
```

字段解释：

- `resumeMode=safe-non-terminal`：默认安全模式，只自动救非终态和基础设施失败。
- `excludedTaskIDs`：本轮临时排除的 task id，排除后状态会显示 `excluded_for_now`。
- `retryInfraFailed=true`：基础设施失败允许自动重跑。
- `retryProductFailed=false`：产物/答案失败默认不自动重跑。
- `maxAttemptsPerTask=2`：每个 task 最多自动尝试两次。

命令行覆盖示例：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts `
  --resume-mode safe-non-terminal `
  --exclude-task-ids 398-14,10747,56274 `
  --retry-infra-failed true `
  --retry-product-failed false `
  --max-attempts-per-task 2
```

已做烟测：

```powershell
bun run auto-evolve/scripts/smoke-benchmark-history-manager.ts
```

已做 dry-run：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts `
  --task-pack-root auto-evolve/task-packs/real-long-tasks/spreadsheetbench-learnbench `
  --train-split auto-evolve/task-packs/real-long-tasks/spreadsheetbench-learnbench/splits/train-skillopt-official.json `
  --out auto-evolve/runtime-state/benchmark-runs/_dry-run-resume-control-smoke `
  --train-limit 3 `
  --dry-run `
  --skip-test `
  --skip-merge `
  --skip-train-replay `
  --exclude-task-ids 398-14 `
  --resume-mode safe-non-terminal
```

dry-run 结果中 `398-14` 被标记为 `excluded_for_now`，没有被启动，说明排除名单和安全恢复模式已经生效。

## 2026-06-25 补充：SpreadsheetBench 训练真实退出原因与队列兜底

现象：`20260622-171219-spreadsheetbench-official80-minimax27-hier5` 停在 `training`，没有 `final-report.json`，但真实 `run-benchmark-orchestrator` 和 `opencode.exe` 都已经不存在。

直接证据：

- `train-queue-results.json` 出现 `code=9` 的 running/recovery 任务。
- `36097.stderr.log` 只有 `EUNKNOWN: unknown error, uv_spawn`，说明 Windows/Bun 当时启动子进程失败。
- `66-24`、`58949` 被标成 `running`，但没有对应 `train-queue-logs`，说明外层刚标记 running 后，启动子进程时抛错，队列没有兜底。
- 同时机器出现过严重内存/虚拟内存压力，PowerShell 报 paging file / OutOfMemory，属于触发 `uv_spawn` 的环境因素。

根因：

- 单个训练子任务启动失败时，外层队列没有把异常转成可恢复记录，可能导致整个外层 runner 退出。
- 队列在 active 清空后会直接结束，没有在退出前再扫一遍 stale/recovery，因此会留下“状态 running，实际 PID dead”的假活。

已修复：

- `runOneCampaign` 增加 try/catch，启动异常会写入该 task 的 stderr，并返回 `code=-1/status=unknown`，不再炸掉整个队列。
- 对 `code!=0` 且没有 `campaignDir` 的基础设施失败，按 `maxAttemptsPerTask` 自动重新入队。
- `queueTrain` 退出前增加最后一次健康扫描；如果发现 stale/recovery，会继续入队，不再留下假 running。

已烟测：

```powershell
bun run auto-evolve/scripts/smoke-benchmark-history-manager.ts
bun run auto-evolve/scripts/smoke-run-health-takeover.ts
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts --task-pack-root auto-evolve/task-packs/real-long-tasks/spreadsheetbench-learnbench --train-split auto-evolve/task-packs/real-long-tasks/spreadsheetbench-learnbench/splits/train-skillopt-official80.json --task-ids 36097 --out auto-evolve/runtime-state/.tmp-smoke-run-benchmark-exit-guard --dry-run --stop-after training
```
