# Auto-Evolve README

> 本文件是 Auto-Evolve 项目的主入口。原始完整 README 已备份为 `README-FULL-ARCHIVE-20260709-015413.md`。
> 其他同级 `README-*.md` 由原 README 按主题拆分，正文尽量保留原文。

## 先读顺序

1. `README-OPERATIONS.md`：继续训练、停止、断点续传、持续监控、看板与排错。
2. `README-BLANK-EVAL.md`：空白 agent 闭卷验收、沙盒、private answers、产品验证器。
3. `README-ARCHITECTURE.md`：系统架构、角色分工、验证层次与核心哲学。
4. `README-MERGE.md`：合并链路、merge-as-old、merge-as-long-task、分层合并与 repair。
5. `README-BENCHMARK.md`：SpreadsheetBench、OfficeQA、Direct Chat 等实验跑法。
6. `README-COST-LEDGER.md`：token、成本、论文级实验账本。
7. `README-HISTORY.md`：历史变更记录和旧事故上下文。

## 维护原则

这个主 README 只做入口和路标，不再堆长篇历史记录。以后新增内容按主题写到对应的 `README-*.md`，这里只补链接、最高红线或读文档顺序。

拆分文件的正文主要来自旧版 README 原文。除非是在修错别字、补清晰说明或新增事实，否则不要重写旧段落；历史原因、事故语气和原始判断要尽量保留。

## 最高红线

- 用户说“继续训练 / 断点续传 / 续传 / 重启外层 orchestrator / 恢复训练”时，默认续传已有最高进度 benchmark run，禁止误开新 `--out`。
- Blank Eval 必须是物理闭卷沙盒，空白 agent 不能看见 private answers、历史 campaign、worker 轨迹、validator 私有路径或宿主工作目录。
- 运行侧 OpenCode 必须使用 `auto-evolve/.opencode-private` 私有配置快照，禁止被本机实时 MCP/plugin/provider 配置污染。
- JSONL 账本追加必须加锁，核心 JSON 状态必须走统一原子写。
- Windows 上不能只用 PID 判断进程归属，必须走强身份识别。
- 运行宿主 `C:\Users\ZhuanZ\Desktop\opencode re\opencode latest` 很脏，默认不要直接推云端；核心代码同步到干净主链仓库后再提交。

## 常用入口

```powershell
cd "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest"

# 查看续传候选
bun run auto-evolve/scripts/resume-auto-evolve-run.ts --list

# 自动续传最高进度 run
bun run auto-evolve/scripts/resume-auto-evolve-run.ts --auto

# 停止/暂停一个 benchmark run
bun run auto-evolve/scripts/stop-auto-evolve.ts --out "auto-evolve/runtime-state/benchmark-runs/<run-dir>" --mode pause

# 更新运行看板
bun run auto-evolve/scripts/update-run-dashboard.ts
Get-Content auto-evolve/runtime-state/run-dashboard/active-runs.md
```

## 文件分工

- `README-FULL-ARCHIVE-20260709-015413.md`：拆分前完整原文备份。
- `README-ARCHITECTURE.md`：写系统设计、角色关系、验证层次、提示词体系和统一架构抽象。以后讨论“这个系统本质是什么、要怎么泛化到新任务形态”，放这里。
- `README-OPERATIONS.md`：写运行手册、停止脚本、断点续传、持续监控、看板、Windows 进程规则和常用排错。以后讨论“怎么跑、怎么停、怎么续、怎么看真假运行”，放这里。
- `README-BLANK-EVAL.md`：写空白 agent 闭卷验收、sandbox、private answers、产品验证器、权限隔离和反作弊边界。以后改 blank eval 或验证器路径，放这里。
- `README-BENCHMARK.md`：写数据集接入、训练/回撤/测试口径、SpreadsheetBench、OfficeQA、Direct Chat、ALFWorld 等任务包规则。以后新增数据集或改实验口径，放这里。
- `README-MERGE.md`：写 `merge-as-old`、`merge-as-long-task`、分层合并、merge contract、replay repair/promote 和合并验收策略。以后改合并链路，放这里。
- `README-COST-LEDGER.md`：写 token、输入/输出区分、角色成本、论文级实验账本、cost per point 和性价比统计。以后补成本审计，放这里。
- `README-HISTORY.md`：写历史变更、事故复盘、旧实验脉络和“为什么当时这么设计”。以后只用于追溯，不作为第一入口。
