> 本文件由原 README.md 按主题拆分而来，正文尽量保留原文。
> 本文件负责：Token、资源成本、论文级实验账本、性价比统计与实验追踪。

原始完整备份：README-FULL-ARCHIVE-20260709-015413.md。

<!-- 原 README 行 1648-1784 -->

### Resource / Cost Audit 资源成本账本

Auto-Evolve 现在开始把模型调用资源消耗写成统一账本，目标是支持论文里的 token / cost / cost-per-point 统计。

OpenCode 长程训练侧会在每个子会话 stage 目录旁边写：

```text
resource-usage.json
```

它从 OpenCode JSON events 的 `step_finish.part.tokens` 和 `step_finish.part.cost` 抽取输入、输出、reasoning、total token 与原始 cost。这个记录由 `orchestrator/opencode.ts -> runOpencodeTask()` 统一落账，所以 executor、lead、reviewer、blank eval、merge repair 等 OpenCode 子会话都会自动覆盖。

Direct Chat 测试侧也会在每题目录旁边写：

```text
resource-usage.json
```

它同时保留两类信息：供应商真实返回的 `usage`，以及 `prompt-audit.json` 里的估算 prompt token、skill token、material token。二者不能互相替代，论文分析时都要保留。

全局汇总脚本：

```powershell
bun run auto-evolve/scripts/update-resource-cost-report.ts
```

默认扫描：

```text
auto-evolve/.runtime
```

也可以指定根目录：

```powershell
bun run auto-evolve/scripts/update-resource-cost-report.ts --root auto-evolve/runtime-state --out-dir auto-evolve/runtime-state/resource-audit
```

如果要把账单和某一次 benchmark 训练绑定起来，传入该次运行目录：

```powershell
bun run auto-evolve/scripts/update-resource-cost-report.ts `
  --root auto-evolve/runtime-state `
  --benchmark-out auto-evolve/runtime-state/benchmark-runs/<run-id> `
  --out-dir auto-evolve/runtime-state/resource-audit
```

输出：

```text
aggregate-summary.json
aggregate-summary.md
usage-records.csv
aggregate-by-group.csv
task-summary.json
task-summary.md
task-summary.csv
round-summary.csv
task-role-summary.csv
```

其中：

- `usage-records.csv` 是最细流水账：一次 OpenCode 子会话或一次 Direct Chat case 一行。
- `aggregate-by-group.csv` 按模型、供应商、阶段、角色聚合。
- `task-summary.*` 按单个长程任务聚合，能看每个 case 总共花了多少 token、跑了几轮、是否通过、失败摘要是什么。
- `round-summary.csv` 按任务轮次聚合，用来看第几轮最烧 token。
- `task-role-summary.csv` 按任务和角色聚合，用来看 executor、lead、blank eval、repair、merge 等各自成本。

传入 `--benchmark-out` 时，还会在该 benchmark 目录旁边写一份随运行携带的任务账单：

```text
resource-task-summary.json
resource-task-summary.md
resource-task-summary.csv
resource-round-summary.csv
```

注意：当前版本做 token/raw cost 账本、Direct Chat prompt 构成统计、任务级/轮次级/角色级聚合。模型美元价格未知时不会乱算 USD；价格表、Excel 美化表和论文级 cost-per-point 表会在后续阶段基于这份账本继续做。

### 本机 Qwen 网页桥接

本机另有一个真实浏览器驱动的 Qwen 网页桥接：

```text
E:\project\260410各种反代\6\universal-web-api
```

它使用独立 Chrome profile 操作 `chat.qwen.ai`，对 Auto-Evolve 暴露标准接口：

```text
http://127.0.0.1:8199/v1/chat/completions
```

Direct Chat 总控中的模型 ID 是 `qwen-web-current`。这个名称故意不绑定具体模型：请求使用受控 Qwen 网页中当前选中的模型，因此正式实验前必须先在受控网页确认模型名称。该通道单标签运行，配置并发固定为 `1`；PDF/图片仍按 Direct Chat 的本地 OCR fallback 转成文本后发送，不能把它记录成原生 PDF/视觉输入实验。

启动方式：

```powershell
cd "E:\project\260410各种反代\6\universal-web-api"
python .\start.py
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8199/health
```

独立 Direct Chat 调用时可用：

```powershell
bun run auto-evolve/scripts/run-direct-chat-eval.ts `
  --models qwen-web-current `
  --global-concurrency 1 `
  <其他 task-pack、split、skill 参数>
```

### OpenCode 训练模型解析与防 fallback

Auto-Evolve 的 OpenCode 子会话不能只相信 `model-config.json` 或 `run.json` 里的“请求模型名”。每个 session 启动前现在会做模型解析校验：

- 目标模型必须是 `provider/model` 格式。
- 先检查本次临时 `opencode.json` 的 provider/model 是否存在。
- 如果临时配置缺 provider，会从本机 OpenCode `models.json` 缓存把对应 provider 物化进临时配置。
- 再检查隔离 runtime 的 `cache/opencode/models.json` 与宿主 `~/.cache/opencode/models.json`。
- 三处都解析不到目标模型时，直接拒绝启动，避免 OpenCode 静默 fallback 到宿主默认模型。
- 每个完成的 run 会在 `run.json` 里写入 `modelResolution`，临时运行目录会写入 `model-resolution.json`，用于区分“请求模型”和“解析到的模型定义”。

如果用户在 UI 中看到的模型名与 `modelResolution.requestedModel` 不一致，不要继续跑正式实验；应先检查 provider 代理层是否把同名模型映射或 fallback 到了别的真实模型。

回归烟测：

```powershell
bun run auto-evolve/scripts/smoke-opencode-model-resolution.ts
```

\n

<!-- 原 README 行 2519-2557 -->

## 论文级实验账本（2026-07-07）

每个 benchmark run 或 Direct Chat run 现在会自动生成一份统一实验账本：

```text
<run>/experiment-ledger/
```

它不是替代 `orchestrator-state.json`、每题 `result.json`、campaign 轨迹或 blank-eval 证据，而是把论文/复现实验最需要的字段集中成一份“总账”。主要文件包括：

- `experiment-manifest.json`：本次实验的来源、数据集、split、代码 commit、运行目录和关键配置摘要。
- `config-fingerprint.json`：模型、并发、轮次、合并策略、验证策略、Direct Chat 模式等配置指纹。
- `dataset-splits.json`：train/test/baseline 的 UID 清单和 split hash。
- `task-results.jsonl`：每个 case 的状态、是否通过、模型、skill 模式、材料模式、token、耗时和证据路径。
- `cost-ledger.jsonl`：按调用/任务记录 token 与耗时；Direct Chat 优先使用 provider 返回的 token。
- `run-summary.json` / `paper-table-ready.csv`：汇总成功率、baseline 对比、token 成本和可比性 warning，方便直接做论文表格。

自动刷新入口：

- `run-benchmark-orchestrator.ts` 每次保存外层状态时会旁路刷新账本；账本失败只写 `experiment-ledger-update-error.log`，不打断训练。
- `run-direct-chat-eval.ts` 在评测完成后刷新账本。
- 也可以手动刷新：

```powershell
bun run auto-evolve/scripts/update-experiment-ledger.ts --out "auto-evolve/runtime-state/benchmark-runs/<run-id>"
bun run auto-evolve/scripts/update-experiment-ledger.ts --out "auto-evolve/runtime-state/direct-chat-runs/<run-id>"
```

大白话：以后写论文时，不要只看零散 scorecard 或聊天记录。先看 `experiment-ledger/run-summary.json` 和 `paper-table-ready.csv`，再回到原始 evidence 解释失败案例。

合并结果口径也会进入账本：`mergePath` 使用正式名称 `merge-as-old` / `merge-as-long-task` / `merge-both-smoke`，`internalMergeMode` 保留代码内部名 `legacy_script` / `long_task` / `both_smoke`。不要在论文表格里混用内部名和正式实验名。

烟测：

```powershell
bun --check auto-evolve/orchestrator/experiment-ledger/contract.ts auto-evolve/orchestrator/experiment-ledger/writer.ts auto-evolve/scripts/update-experiment-ledger.ts auto-evolve/scripts/smoke-experiment-ledger.ts
bun run auto-evolve/scripts/smoke-experiment-ledger.ts
```

\n