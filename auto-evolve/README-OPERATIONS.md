> 本文件由原 README.md 按主题拆分而来，正文尽量保留原文。
> 本文件负责：日常运行、断点续传、停止、持续监控、看板、Windows 运行红线、入口脚本。

原始完整备份：README-FULL-ARCHIVE-20260709-015413.md。

<!-- 原 README 行 93-247 -->

## Git 推送主链规则（2026-06-26）

以后本项目默认推送到干净主链仓库：

```text
C:\Users\ZhuanZ\Desktop\opencode re\opencode-auto-evolve-mainline
https://github.com/oooojsw/opencode-auto-evolve-mainline
```

`C:\Users\ZhuanZ\Desktop\opencode re\opencode latest` 只作为运行宿主和完整混合本地仓库；它包含 OpenCode 官方上游历史、运行数据和历史大文件，禁止再从这里直接 push 作为默认同步方式。需要上云时，先把核心源码、配置、文档、smoke、进度记录同步到 `opencode-auto-evolve-mainline`，确认没有 `runtime-state`、`task-packs` 大材料、`private-answers`、workspace、outputs、缓存、PDF/视频/Office 材料、Cookie、API key 和运行产物，再从干净主链提交并推送。

## 断点续传主线红线（2026-06-26）

用户说“继续训练 / 断点续传 / 续传 / 重启外层 orchestrator / 恢复训练”时，默认含义是续传已有最高进度 benchmark run，而不是新建一个新的 `--out` 目录。

执行前必须先枚举：

```text
auto-evolve/runtime-state/benchmark-runs
```

并按同一 label / task-pack / split 对历史 run 做对比，至少查看：

- `orchestrator-state.json` 里的 `verified_success` 数量。
- `queued`、`running`、`recovery_pending`、`failed` 数量。
- `task-ledger.json` 的血统与 generation。
- `scorecard.md` 和最后更新时间。

只有确认用户明确要求“新实验 / 从零开始 / fresh-all / 新建 run / 不继承旧进度”时，才允许创建新的 `--out`。否则必须使用已有最高进度 run 目录作为唯一训练主线。

大白话：如果旧 run 已经是 `27/80`，就不能因为修了代码或重启 orchestrator 又开一个 `6/80` 的新 run。修复后的代码应该接到旧账本上继续跑；新 run 只会重复烧模型额度、污染实验血统，并让后续接手 AI 误判真实进度。

## 统一断点续传入口（2026-07-06）

Auto-Evolve 现在新增 benchmark 续传薄封装：

```powershell
bun run auto-evolve/scripts/resume-auto-evolve-run.ts --auto
```

这个脚本不替代 `run-benchmark-orchestrator.ts`，而是在它外面做安全准备：

- 扫描 `runtime-state/benchmark-runs`，默认选择最高进度主线。
- 支持 `--out <run-dir>`、`--run-id <run-id>`、`--task-pack <name>`，因此可以明确续传非最高进度 run。
- 支持 `--list` 只列候选，不启动。
- 支持 `--dry-run` 只生成计划和 launcher，不启动。
- 自动归档 `<out>/STOP_REQUESTED.json` 到 `stop-reports/cleared-stop-requests/`。
- 自动把 `<out>/benchmark-leases/*.json` 移到 `stop-reports/cleared-benchmark-leases/`，避免旧认领票卡住新外层。
- 从 `benchmark-plan.json`、`orchestrator-state.json`、`run-manifest.json` 恢复 task-pack、split、并发、rounds、stopAfter、merge/test 跳过策略等参数。
- 在 `<out>/resume-logs/resume-*/launcher.mjs` 写入文件化启动器，再由 launcher 调用真实 `bun.exe`，避免 Windows 把 `opencode re/opencode latest` 这种带空格路径撕裂。
- 启动后等待约 12 秒，检查外层 PID 是否仍存活、stderr 是否出现严格参数错误、状态文件是否被触碰，并写 `launch-result.json`。
- launcher 会用 detached 后台子进程启动真实 benchmark，并避免在子进程仍活着时主动关闭日志句柄；这是为了防止 Windows/Bun 下出现“自检通过但训练控制面无声退出”的假成功。

常用方式：

```powershell
# 只看候选
bun run auto-evolve/scripts/resume-auto-evolve-run.ts --list

# 自动续传最高进度 run
bun run auto-evolve/scripts/resume-auto-evolve-run.ts --auto

# 只在某个数据集里自动选
bun run auto-evolve/scripts/resume-auto-evolve-run.ts --task-pack spreadsheetbench

# 精确指定，不让系统自动选择
bun run auto-evolve/scripts/resume-auto-evolve-run.ts --out "auto-evolve/runtime-state/benchmark-runs/<run-id>"
```

大白话：以后 benchmark 断点续传不要手写一长串 `run-benchmark-orchestrator.ts --task-pack-root ... --train-split ... --out ...`。先用统一入口，让它选 run、清暂停标记、写 launcher、启动后自检。只有这个入口坏了，才手工调用底层 orchestrator。

2026-07-07 补强：统一续传入口现在会在每次启动前写一份血统审计：

```text
<out>/resume-logs/resume-*/lineage-audit.json
<out>/resume-logs/resume-*/lineage-audit.md
```

这份报告会列出候选 run、选中理由、verified/running/recovery/failed/queued 分布、STOP 状态、`task-ledger.json` 的 generation/status 摘要和 warnings。大白话：续传前先查户口本，避免把旧 run、新 run、暂停遗留和 recovery 分支混成一条实验主线。

## Benchmark 训练 Supervisor 调度红线（2026-06-26）

`scripts/run-benchmark-orchestrator.ts` 的训练阶段不是单一 todo 队列，而是小型 supervisor，必须同时管理：

- `todo`：需要启动、恢复或接管的任务。
- `active`：当前外层自己启动并正在等待的子进程。
- `watch`：已经由别的进程健康运行、外层只负责观察的 campaign。

健康运行中的 campaign 不能进入 todo 调 `resume-long-task-campaign`。否则 resume 发现同 campaign 已 live 会秒退，外层会误以为这个训练项已处理，导致 `todo/active` 清空后提前结束训练阶段。现在调度规则是：

- `healthy_running` / `long_running` / 短启动宽限内的 `bootstrapping` 进入 `watch`。
- `recovery_pending` / `stale_running` 进入 `resume_recovery`。
- `stuck_running` 进入 `takeover_recovery`。
- 无 campaign 才 `start_new`。
- 训练阶段退出必须同时满足 `todo` 已耗尽、`active` 为空、`watch` 为空。

`run-health` 也同步收紧：无 ownerPID 的 `running` 不再算 healthy，直接按 stale/resume 处理；无 ownerPID 的 `bootstrapping` 只给默认 2 分钟启动宽限。

回归烟测：

```powershell
bun run auto-evolve/scripts/smoke-benchmark-supervisor.ts
```

## 统一停止模块（2026-06-30）

Auto-Evolve 现在新增统一 Stop Manager，用来替代“手动杀一堆进程”的粗暴停止方式。默认停止不是废弃实验，而是 `pause`：先保存现场，再把运行中的任务标成可断点续传，再释放 benchmark lease / OpenCodeGate 占位，最后只停止能证明属于本 run 的进程。

常用命令：

```powershell
cd "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest"
bun run auto-evolve/scripts/stop-auto-evolve.ts --out "auto-evolve/runtime-state/benchmark-runs/<run-dir>" --mode pause
```

Windows 包装入口：

```powershell
.\script\stop-auto-evolve-sessions.ps1 -Out "auto-evolve/runtime-state/benchmark-runs/<run-dir>" -Mode pause
```

也可以只停单个 campaign：

```powershell
bun run auto-evolve/scripts/stop-auto-evolve.ts --campaign "<campaign-id-or-dir>" --mode pause
```

停止模块会写：

```text
<out>/STOP_REQUESTED.json
<out>/run-manifest.json
<out>/artifact-manifest.stop.json
<out>/stop-transactions/<timestamp>/transaction.json
<out>/stop-snapshots/<timestamp>/
<out>/stop-reports/<timestamp>-stop-report.json
<out>/stop-reports/<timestamp>-stop-report.md
```

重要规则：

- 用户日常说“停止任务”，默认用 `pause`，不要用 `abort`。
- `pause` 会保留 verified skill、round history、blank eval evidence、Direct Chat result.json、summary 和 cost 账本。
- 对 benchmark 训练，running/watch/recovery 会被写回 `recovery_pending`；queued 保持 queued；verified_success 保持 verified_success。
- 对 Direct Chat，续传依赖同一个 `--out-dir` 加 `--resume-existing`，已有每题 `result.json` 不会被改坏。
- Stop Manager 的进程停止按身份分级：只有能通过 ownerPID、ownerCreationTick、campaignID、scope、outDir 等证明归属的进程才会停止；`unknown_owner` 只能警告，不能杀。

回归烟测：

```powershell
bun run auto-evolve/scripts/smoke-stop-manager.ts
```

大白话：以后停止训练不要再“拔电源”。先让 Stop Manager 正规关机，它会把成果放好、座位释放、现场写清楚，下次才能稳定从原 `--out` 断点续传。

\n

<!-- 原 README 行 518-925 -->

## 🛠️ 第五部分：接手操作指南 (Operator's Manual)

如果你是一个新接入此工作区的 Agent，请按照以下指南进行开发或排查：

### 1. 目录结构导航 (Where things live)
*   `orchestrator/`: 系统的核心 Node.js/TS 调度引擎。
    *   `long-task-campaign/runner.ts`: 核心强化循环（Lead -> Surface -> Blank -> Review）。
    *   `blank-eval/runner.ts`: 负责构建净室环境并启动空白智能体。
    *   `multi-instance/`: 并发扇出与经验融合（Phase 1~3）。
*   `scripts/`: 入口脚本与 Python/Powershell 验证器。
    *   `validate-experience-surface-generalization.py`: 核心防作弊扫描枪。
*   `runtime-state/`: 所有的运行状态、日志、缓存。（**排错首选阵地**）。
*   `task-packs/real-long-tasks/`: 具体的任务题库、Private Answers 及环境。

### 2. 核心排错命令 (How to debug)
当遇到跑批挂死、假性成功或状态混乱时，请使用以下工具：

*   **重置/清理系统僵尸状态** (极度重要，处理进程死锁)：
    ```bash
    bun run scripts/verify-try4-clean-state.ps1
    ```
*   **启动/恢复一个任务战役**：
    ```bash
    bun run cli.ts run-long-task-campaign --spec <spec.json> --force-new
    # 如果要断点续跑：
    bun run cli.ts resume-long-task-campaign --campaign <ID> --spec <spec.json>
    ```
*   **执行端到端并发基准跑批**：
    ```bash
    bun run scripts/run-officeqa-pro-experiment.ts
    ```
*   **执行系统底层 Smoke Tests (提交代码前的必过门槛)**：
    ```bash
    bun run scripts/smoke-concurrency-regression.ts
    bun run scripts/smoke-experience-surface-contract.ts
    bun run scripts/smoke-blank-agent-task-deployment-acceptance.ts
    ```

### 3. 修改代码的“军规”
1.  **涉及文件读取/沙盒的地方**：必须确保使用 `path.resolve()` 并仔细检查是否会越界逃逸到 `private-answers`。
2.  **涉及状态文件更新（JSON）**：必须使用封装好的 `retryWriteJson` 或原子操作，避免高并发下文件损坏。
3.  **涉及 Prompt 修改**：绝对不要给 Blank Agent 添加额外的智力要求；如果 Lead 表现不佳，增强 Worker 的诊断 Prompt，而不是放宽 Surface Validator 的防作弊底线。

---
**铭记：系统的生命力在于对 LLM 投机取巧本能的绝对物理镇压。不要相信模型的承诺，只相信验证器的冷酷判决。**

---

## 第六部分：通用任务包批跑脚本

现在新增了一个通用任务包级批跑脚本：

- `auto-evolve/scripts/run-benchmark-orchestrator.ts`

它的定位不是替代 long-task/campaign/blank-agent 主链路，而是做 **外层编排**：

- 读取 `task-packs/real-long-tasks/<pack>/tasks/<id>/campaign.json`
- 并发启动或续跑多个 training campaign
- 只把 `verified_success` 且存在 `pending-expert-package/current` 的任务当作可合并输入
- 在需要时进入 merge
- 在需要时进入训练回测（Phase 3 train replay，可带 append-only repair）
- 在需要时进入 held-out test
- 在需要时再跑 blank/no-skill baseline

这个脚本 **不会绕开** 现有每轮验收链路。每个 campaign 内部仍然是：

- lead 写 pending package
- surface validator 先查经验包表面
- blank agent 闭卷跑真实任务
- product validator 验空白 agent 产物
- 失败结果再回流给下一轮

### 6.1 为什么要加这层脚本

以前：

- OfficeQA、SpreadsheetBench 各自有一份单独批跑脚本
- 能跑，但控制粒度不一致
- 想停在“训练结束 / 合并结束 / 回测结束 / 测试结束”这种中间点时不统一

现在：

- 通用 orchestrator 把这些外层控制统一起来
- 但不碰底层 campaign、blank eval、validator、merge-repair 的核心机制

### 6.2 这个脚本支持停在任意阶段

核心控制项：

- `--mode campaign-only`
  - 只跑 training campaign，不进入 merge
- `--stop-after training`
  - 跑完训练就停
- `--stop-after merge`
  - 合并完成就停
- `--stop-after train-replay`
  - 训练回测完成就停
- `--stop-after test`
  - 测试集完成就停，不跑 baseline
- `--stop-after baseline`
  - 全部跑完再停

另外也支持单独关步骤：

- `--skip-merge`
- `--skip-train-replay`
- `--skip-test`
- `--skip-baseline`

单任务/少量任务调试可以不写临时 split 文件，直接覆盖训练 ID：

- `--task-id <id>`：只跑一个训练任务
- `--task-ids <id1,id2,...>`：只跑指定几个训练任务
- `--test-task-id <id>` / `--test-task-ids <id1,id2,...>`：只跑指定测试任务

如果只是调试单个长程任务，推荐搭配：

- `--concurrency 1`
- `--mode campaign-only` 或 `--stop-after training`

### 6.3 典型用法

OfficeQA 训练后直接停：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts `
  --task-pack-root auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench `
  --train-split auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench/splits/train-20.json `
  --test-split auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench/splits/test-10.json `
  --concurrency 5 `
  --stop-after training
```

SpreadsheetBench 跑到训练回测结束：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts `
  --task-pack-root auto-evolve/task-packs/real-long-tasks/spreadsheetbench-learnbench `
  --train-split auto-evolve/task-packs/real-long-tasks/spreadsheetbench-learnbench/splits/train-skillopt-official.json `
  --test-split auto-evolve/task-packs/real-long-tasks/spreadsheetbench-learnbench/splits/test-skillopt-official.json `
  --concurrency 5 `
  --stop-after train-replay
```

SpreadsheetBench 当前标准数据集口径是 SkillOpt 官方 split，不再使用旧的 `all_data_912` 前 40 条 selected 子集。生成/刷新任务包时使用：

```powershell
$env:SPREADSHEETBENCH_SPLIT_MODE = "skillopt"
Remove-Item Env:\SPREADSHEETBENCH_TRAIN_LIMIT -ErrorAction SilentlyContinue
Remove-Item Env:\SPREADSHEETBENCH_TEST_LIMIT -ErrorAction SilentlyContinue
bun run auto-evolve/scripts/create-spreadsheetbench-experiment.ts
```

该模式会物化官方 `train=80 / val=40 / test=280` 共 400 条任务，并写出 `train-skillopt-official.json`、`val-skillopt-official.json`、`test-skillopt-official.json`。`train-selected.json`、`val-selected.json`、`test-selected.json` 在该模式下也等同官方 split。

单个 ALFWorld 任务，只跑 campaign、不合并：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts `
  --task-pack-root auto-evolve/task-packs/real-long-tasks/alfworld-learnbench `
  --task-id train-pick-two-obj-and-place-spraybottle-none-toilet-402-trial-t20190911-213113-817208 `
  --concurrency 1 `
  --mode campaign-only
```

### 6.4 与旧脚本的关系

旧入口 `auto-evolve/scripts/run-officeqa-pro-benchmark.ts` 现在只是这个通用脚本的薄包装，保留旧入口是为了兼容你之前已经在用的命令和环境变量。

如果以后新接一个同结构的数据集，优先直接接这个通用 orchestrator，而不是再复制一份 OfficeQA/SpreadsheetBench 风格的专用批跑脚本。

---

## 第七部分：Campaign Recovery 规则

`recovery_pending` 不是终点。恢复时只能使用三种动作：

- `restart_round`：源 run 已经不可读，重启当前 round。
- `resume_round_run`：源 run 仍在运行态，继续 inner long-task。
- `harvest_round_run`：源 run 已经到达终态，把已有 run 重新收割，然后继续 lead / reviewer / final acceptance / 下一轮逻辑。

历史上曾出现过 `resume_round_postrun`，它会把 `stagnation_failure` 这类终态 run 误当成“只补 final acceptance”的半成品，导致同一轮反复验收、无法推进下一轮。该动作已经废弃；以后不要重新引入。

特别注意：如果 round record 缺少 `finalAcceptanceSignal`，必须先读取对应 inner run 的 `progress_state.json`。如果 inner run 是 `stagnation_failure`、`blocked_failure`、`verified_success`、`exhausted_failure` 等终态，应走 `harvest_round_run`，让 campaign 完成收割、诊断、lead 修 skill、blank-agent 验收，并在失败时自然进入下一轮。

2026-06-07 加固：

- `healStaleRuntimeStates(...)` 会主动清洗历史残留的 `recovery.action = resume_round_postrun`，重算为当前合法动作并写回 `campaign.json`。
- `resumeLongTaskCampaign(...)` 直接恢复旧目录时，也会在真正进入 round 前把旧 recovery 标记改写为当前合法动作。
- 通用 benchmark orchestrator 不再只相信 `campaign.json` 里写着 `running`。它会同时看 owner PID 是否还活、heartbeat 是否新鲜；没有真实进程且心跳过期的旧 running 不再当作可直接续跑对象。
- 修改这块后至少跑 `bun run auto-evolve/scripts/smoke-campaign-recovery-decision.ts`。这个烟测包含旧 `resume_round_postrun` 脏状态复现，必须输出 `harvest_round_run`。

---

## 第八部分：ALFWorld 长程任务接入

2026-06-07 已新增 ALFWorld 长程任务包：

- 生成脚本：`auto-evolve/scripts/create-alfworld-experiment.ts`
- 产物任务包：`auto-evolve/task-packs/real-long-tasks/alfworld-learnbench`
- Product validator：`auto-evolve/scripts/validate-alfworld-plan.py`
- 默认规模：`20` 个 train，`10` 个 eval_in_distribution test

当前第一版是“离线 walkthrough planning”接入：

- 原始数据来自 `C:\Users\ZhuanZ\Desktop\experiment\datasets\ALFWorld`
- 每个 `.tw-pddl` 原始文件包含 `walkthrough` 标准动作序列
- 生成任务时，`tasks/<id>/problem.json` 只保留 task、PDDL domain/problem、solvable 等可见信息
- `walkthrough` 只写入 `private-answers/<id>/answer.json`
- 空白 agent 需要写 `workspace/plan.json`
- `validate-alfworld-plan.py` 比较 `workspace/plan.json` 和私有 walkthrough

安全边界：

- 不要把原始 `.tw-pddl` 直接作为材料挂给空白 agent，因为里面带 `walkthrough`
- `private-answers` 只允许 product validator 读取
- 这个版本证明的是多步动作规划和经验泛化，不是完整 simulator 在线交互；后续如果需要在线环境交互，再增加环境 wrapper

典型 dry-run：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts `
  --task-pack-root auto-evolve/task-packs/real-long-tasks/alfworld-learnbench `
  --train-split auto-evolve/task-packs/real-long-tasks/alfworld-learnbench/splits/train-selected.json `
  --test-split auto-evolve/task-packs/real-long-tasks/alfworld-learnbench/splits/test-selected.json `
  --concurrency 2 `
  --stop-after training `
  --dry-run
```

---

## 第九部分：Runtime Root 默认位置

2026-06-07 起，OpenCode 临时会话运行根目录不再默认优先写入 D 盘。

默认位置：

```text
auto-evolve/.runtime
```

仍然保留环境变量覆盖：

```powershell
$env:AUTO_EVOLVE_RUNTIME_ROOT = "D:\opencode-auto-evolve-runtime"
```

也就是说，默认回到项目内本地运行；只有显式设置 `AUTO_EVOLVE_RUNTIME_ROOT` 时，才会把临时运行缓存放到外部盘。

---

## 第十部分：核心代码导出规则

2026-06-07 加固：

- 当前核心代码导出脚本是 `auto-evolve/scripts/export-core-code-to-desktop.py`。
- 导出产物会生成到桌面，文件名形如 `auto-evolve-core-code-YYYYMMDD_HHMMSS.txt`。
- 导出范围必须包含 `README.md` 和 `AGENTS.md`。这两个文件不是普通文档，而是接手 AI 理解系统目标、运行红线、恢复规则和长期维护约定的入口。
- 如果以后调整导出范围，不要只导出 `.ts/.py` 代码；必须保留这些架构和接手说明，否则迁移包会变成“有发动机但没有驾驶手册”。

---

## 第十一部分：本机安装版 OpenCode 保护规则

2026-06-07 加固：

- 本机安装版 OpenCode 位于 `E:\OpenCode`，主进程通常是 `OpenCode.exe`，本地服务 sidecar 可能是 `opencode-cli.exe`。
- auto-evolve 项目运行时使用的是项目内 CLI，例如 `packages/opencode/node_modules/opencode-windows-x64/bin/opencode.exe`，它和本机桌面安装版不是同一个进程族。
- 进程清理只允许清理 auto-evolve 自己登记、自己启动的子进程。即使 PID 被错误写入 `.runtime/active-processes.json`，只要该 PID 或它的父进程链属于 `E:\OpenCode`，也必须跳过，不得 `taskkill`。
- 底层保护位于 `auto-evolve/orchestrator/runtime-process-registry.ts`：
  - `isProtectedDesktopOpenCodeProcess(...)` 会沿 Windows 父进程链检查 `E:\OpenCode`。
  - `terminateProcessTree(...)` 在真正 `taskkill /T /F` 前会先调用保护判断。
  - `cleanupRuntimeProcessScope(...)` 遇到受保护桌面版进程时只跳过并清掉错误登记，不保留为反复清理目标。
- try4 清理和核查脚本也带同样保护：
  - `auto-evolve/scripts/init-try4-clean-state.ps1`
  - `auto-evolve/scripts/verify-try4-clean-state.ps1`
- 如果本机安装目录以后不再是 `E:\OpenCode`，可以用环境变量 `AUTO_EVOLVE_PROTECTED_OPENCODE_ROOTS` 覆盖，多个目录用分号分隔。

判断桌面版断联时要分清两类现象：

- `OpenCode.exe` 还在，但 `localhost:4096` 没监听：通常是桌面版本地 server / sidecar 掉了，不等于主程序被 auto-evolve 杀掉。
- 项目内 `opencode.exe` 子任务被清理：这是 auto-evolve 正常清理自己的运行子进程，不应影响 `E:\OpenCode` 桌面版。

---

## 第十二部分：统一运行看板与长任务预算

2026-06-07 加固：

接手正在跑的 benchmark 时，第一步不要先翻聊天记录，也不要只看前端卡片。先刷新并打开统一看板：

```powershell
bun run auto-evolve/scripts/update-run-dashboard.ts
Get-Content auto-evolve/runtime-state/run-dashboard/active-runs.md
```

看板是当前任务运行状态的集中入口，会把分散在 `scorecard.md`、`campaign.json`、进程 owner、心跳和恢复状态里的信息汇总成一张表。

以前排查长程任务需要同时翻 `scorecard.md`、`campaign.json`、`progress_state.json`、进程表和手动恢复日志。现在新增统一运行看板：

```text
auto-evolve/runtime-state/run-dashboard/active-runs.md
auto-evolve/runtime-state/run-dashboard/active-runs.json
```

刷新命令：

```powershell
bun run auto-evolve/scripts/update-run-dashboard.ts
```

通用批跑脚本 `auto-evolve/scripts/run-benchmark-orchestrator.ts` 每次写外层状态时也会自动刷新这份看板。

看板含义：

- `healthy_running`：owner 进程存在，任务正常运行。
- `long_running`：运行时间较长，但未证明卡死，只观察。
- `stale_running`：状态文件写着 running，但 owner PID 不存在，应恢复。
- `stuck_running`：owner PID 存在，但心跳和产物长时间不动，应执行 `takeover`。
- `recovery_pending`：已经进入恢复状态，外层应调用 `resume-long-task-campaign`。
- `completed`：终态任务。

通用批跑脚本现在会在训练队列中周期性执行 watchdog：

- 补位前扫描 active campaign 健康状态。
- 发现 `stale_running`、`stuck_running` 或 `recovery_pending` 时，把该任务重新放入恢复队列。
- `stale_running` / `recovery_pending` 的动作是 `resume`；`stuck_running` 的动作是 `takeover`，含义是旧 owner 还活着但已经假死，需要先安全终止旧 owner，再从磁盘断点续跑。
- 恢复方式仍然是磁盘断点续传：新进程读取 `campaign.json`、round history、long-task progress 和已有产物继续，不恢复旧 OpenCode 对话 session。
- 内外层现在共用 `auto-evolve/orchestrator/run-health.ts` 的健康判断，不再允许外层 45 分钟判 stuck、内层 2 小时内仍当 live 而拒绝接管。

OpenCode 子 session 运行预算也改成 profile：

```text
short:  soft 30m,  hard 60m
medium: soft 90m,  hard 120m
long:   soft 120m, hard 180m
unbounded-with-watchdog: soft 120m, hard 720m
```

默认 profile 是 `long`，适合 OfficeQA / SpreadsheetBench / DocVQA 这类真实长程任务。可以用环境变量覆盖：

```powershell
$env:AUTO_EVOLVE_OPENCODE_RUNTIME_PROFILE = "medium"
$env:AUTO_EVOLVE_OPENCODE_SOFT_DEADLINE_MS = "7200000"
$env:AUTO_EVOLVE_OPENCODE_HARD_TIMEOUT_MS = "10800000"
```

## 模型并发 Smoke 探测

新增 `scripts/probe-model-concurrency.ts`，使用真实隔离 OpenCode session 探测某个 provider/model 的可用并发，而不是只做 HTTP ping。正式 probe 状态会同时约束通用 benchmark 的任务并发和 OpenCodeGate 的按模型子 session 并发。

```powershell
bun run auto-evolve/scripts/probe-model-concurrency.ts `
  --model alibaba-coding-plan-cn/qwen3.7-plus `
  --min 1 `
  --max 3 `
  --rounds 2
```

总控配置位于 `config.json` 的 `adaptiveConcurrency`。探测结果写入：

```text
runtime-state/model-concurrency/state.json
runtime-state/model-concurrency/report.md
runtime-state/model-concurrency/probes/<timestamp>-<model>.json
```

支持 `--dry-run` 验证状态机，不会调用模型；dry-run 写 `state-dry-run.json`，不会污染正式 `state.json`。真实探测按并发等级逐级运行，遇到 `rate_limit`、`provider_busy`、`timeout`、认证错误或模型不可用会停止上探并给出退避建议。

2026-06-22 对 `alibaba-coding-plan-cn/qwen3.7-plus` 的单轮真实 smoke 已确认并发 1 和并发 2 均通过。当前保守建议是：

```text
safeOpenCodeConcurrency = 2
safeTaskConcurrency = 1
safeRequestSpacingMs = 20000
```

该结果只证明短 session 的并发 2 可用，不等于长程 campaign 可以直接按任务并发 2 运行。因此当前自动折算为任务并发 1。通用 benchmark 请求 `--concurrency 5` 时会记录 requested=5、effective=1；可用 `--no-adaptive-concurrency` 显式关闭保护。

`loadConfig()` 会读取正式 `state.json` 并给 OpenCodeGate 注入按模型限制：当前 Qwen3.7 Plus 同时最多 2 个 OpenCode session，新 session 最小间隔 20 秒。探测脚本会在本进程临时放宽目标模型上限，因此仍能继续向更高级别上探。较低上限的成功复测不会覆盖历史已验证的更高安全并发，只有真实失败会降级。

在线 AIMD 也已接入所有真实 `runOpencodeTask()`：

- 正常返回只代表 provider 传输成功；即使后续任务 validator 判错，也不会错误降低并发。
- `429/rate_limit` 会将 OpenCode/任务窗口乘性降低、请求间隔翻倍并进入冷却。
- `provider_busy/timeout` 会减一窗口、增加请求间隔并短暂冷却。
- `auth_error/model_unavailable` 会把窗口置零并阻断外层补位。
- 每累计 `successesToIncrease` 个传输成功，OpenCode 窗口加一；达到 3 后任务窗口可从 1 增到 2。
- 外层 benchmark 在每次补位前重新读取 state；冷却时不启动新 campaign，窗口降低时等待现有任务自然结束。
- OpenCodeGate 对已排队请求每秒刷新共享模型状态，确保其他进程发生 429 后，旧进程也能及时看到新窗口和 cooldown。

在线变化审计日志：

```text
runtime-state/model-concurrency/online-events.jsonl
```

当前 benchmark 不会在 probe TTL 过期时自动调用探测脚本；有正式 state 时直接使用，没有 state 时从 profile 的初始任务并发 1 开始，并由在线 AIMD 继续调整。

注意：

- soft deadline 不是运行中给 agent 追加消息，而是在 session 启动 prompt 中预置自我收敛规则。
- hard timeout 是系统层进程超时，超过后会终止进程树并把失败写回运行产物。
- 接手正在跑的任务时，先看 `active-runs.md`，不要只看前端或旧 `scorecard.md`。
- takeover 回归烟测脚本：`auto-evolve/scripts/smoke-run-health-takeover.ts`。它会验证“PID 活着但 50 分钟无心跳/无产物”必须变成 `stuck_running/takeover`，而 5 分钟新鲜任务仍是 `healthy_running/watch`。
---

\n

<!-- 原 README 行 1785-2127 -->

## 完整项目独立开发主链（2026-06-21）

- 本机独立仓库：`C:/Users/ZhuanZ/Desktop/opencode re/opencode-auto-evolve-mainline`
- 云端私有仓库：`https://github.com/oooojsw/opencode-auto-evolve-mainline`
- 正式分支：`main`

该仓库不是只抽取 `auto-evolve/` 的子项目仓库，而是完整项目主线：保留 OpenCode 源码形态、本机对 OpenCode 的修改、Auto-Evolve 核心系统和本地开发提交顺序。为了摆脱原始上游 `sst/opencode` 的超长历史，主链把最初克隆到本机的 OpenCode 源码树压缩成一条基线提交，然后重放本机开发提交；因此 commit hash 与原宿主仓不同是正常现象。

主链只保存源码、配置模板、提示词、验证器、烟测、轻量 task spec/split 和架构文档。禁止提交 `runtime-state`、运行日志、benchmark 原始材料、PDF/视频/Office 数据、private answers、真实任务 workspace/outputs、模型缓存、Cookie、API Key、认证文件和 Agent 生成产物。实际运行和重型数据仍留在 `opencode latest` 宿主目录或独立数据盘；完整主链负责长期开发历史和云端备份。

## Benchmark 历史血统锁与防污染重跑（2026-06-23）

训练任务的历史不能再只靠“目录里有没有旧 campaign”来判断能不能续传。现在通用批跑脚本会在每个 benchmark 输出目录下维护一份户口本：

```text
<out>/task-ledger.json
```

这份文件记录本次 benchmark 的：

- `runID`：本次批跑身份。
- `currentGenerationID`：当前训练代际。
- `historyPolicy`：本次允许怎么复用历史。
- 每个 task 的 `attemptID`、`campaignID`、`campaignDir`、`specHash`、状态和失败原因。

核心原则是：只有 `task-ledger.json` 授权的 campaign 才能被本次批跑自动续传。磁盘上残留的旧 campaign、旧 running 状态、旧 recovery 状态，如果没有匹配当前 `runID + generationID + taskID + attemptID`，都会被外层批跑视为“不属于本次实验”，不会被自动捞起来继续跑。

### 可选历史策略

通用入口 `auto-evolve/scripts/run-benchmark-orchestrator.ts` 新增：

```powershell
--history-policy <policy>
```

如果命令行没有传 `--history-policy`，则读取总控配置：

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

也就是说，正式批跑不需要每次手写历史策略；总控默认就是“保留成功项，其他进入新代际重跑”。命令行参数只用于临时覆盖。

当前支持：

- `resume-current-generation`：默认策略。只续传当前户口本里的当前代际任务。
- `fresh-non-verified`：保留已经 `verified_success` 且产物仍存在的任务；其他未成功、失败、假活、污染过的任务全部进入新代际重新跑。
- `fresh-all`：全部进入新代际重跑，不复用任何旧成功项。
- `resume-explicit-only`：不给外层自动捞旧任务；只允许显式指定 campaign 的人工恢复链路。
- `audit-only`：只用于盘点，不应启动新训练。

SpreadsheetBench 这类重新跑非成功任务的推荐方式是：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts `
  --task-pack-root auto-evolve/task-packs/real-long-tasks/spreadsheetbench-learnbench `
  --train-split auto-evolve/task-packs/real-long-tasks/spreadsheetbench-learnbench/splits/train-skillopt-official.json `
  --out auto-evolve/runtime-state/benchmark-runs/<run-dir> `
  --history-policy fresh-non-verified `
  <其他训练/合并/回撤参数>
```

这样做的含义是：之前已经闭卷验收成功的 skill 可以保留，其他所有失败、假活、错误模型、错误平台、污染过的历史都不再续传，而是作为新 attempt 重新开始。

### CLI 断点续传的边界

`run-long-task-campaign` / `resume-long-task-campaign` 现在可以通过环境变量接收外层传入的历史作用域：

```text
AUTO_EVOLVE_HISTORY_SCOPE
```

外层批跑会自动传入这个变量，普通使用者不需要手写。它的作用是把单个 campaign 绑定到本次 benchmark 的 `task-ledger.json`，避免旧目录被误续传。

保留一个兼容开关：

```powershell
$env:AUTO_EVOLVE_ALLOW_LEGACY_CAMPAIGN_RESUME = "1"
```

只有确实要兼容非常旧的无户口 campaign 自动续传时才使用。正式实验默认不要开。

### 回归烟测

历史管理基础烟测：

```powershell
bun run auto-evolve/scripts/smoke-benchmark-history-manager.ts
```

这个烟测会确认：

- 没有血统信息的旧 campaign 不会被新批跑自动复用。
- 同一 `runID/generationID/taskID/attemptID` 的 campaign 可以被授权续传。
- `fresh-non-verified` 会进入新代际，同时保留明确可信的 `verified_success` 项。

### 失败恢复总控

`auto-evolve/config.json` 的 `historyConfig` 现在也控制失败任务的自动恢复方式：

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

- `resumeMode`：推荐 `safe-non-terminal`。系统只自动恢复非终态任务和基础设施类失败，不再默认把已经失败的答案任务反复重跑。
- `excludedTaskIDs`：临时跳过某些任务。跳过项会写成 `excluded_for_now`，不会被外层补位逻辑误启动。
- `retryInfraFailed`：进程崩溃、假活、锁、spawn、平台超时这类基础设施失败可以自动重跑。
- `retryProductFailed`：答案/产物确实做错的失败默认不自动重跑，除非用户明确打开。
- `maxAttemptsPerTask`：单个任务最多自动尝试次数，防止无限烧额度。

命令行仍可以临时覆盖总控：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts `
  --resume-mode safe-non-terminal `
  --exclude-task-ids 398-14,10747,56274 `
  --retry-infra-failed true `
  --retry-product-failed false `
  --max-attempts-per-task 2
```

大白话：以后“断点续传”不是见到失败就继续旧脏历史，而是先查户口本，再看失败类型。系统故障可以救，真实做错默认先记失败，避免反复浪费额度。

## OpenCode 私有配置隔离

从 2026-06-25 起，auto-evolve 训练侧 OpenCode 会话默认不再读取本机实时 OpenCode 配置。

训练专用配置快照位置：

```text
auto-evolve/.opencode-private/
```

这个目录包含：

- `config/opencode/opencode.json`：只保留 provider/model 相关配置。
- `data/opencode/auth.json`：训练专用 auth key 快照。
- `cache/opencode/models.json`：训练专用模型列表缓存。
- `config/opencode/AGENTS.md`：最小训练专用说明，不复制本机 OpenCode AGENTS。

刷新快照时运行：

```powershell
cd "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest"
bun run auto-evolve/scripts/import-opencode-private-profile.ts
```

红线：

- 运行时只能读 `.opencode-private` 或 `AUTO_EVOLVE_OPENCODE_PRIVATE_PROFILE_ROOT` 指向的目录。
- 不能再从 `C:\Users\ZhuanZ\.config\opencode`、`.local/share/opencode`、AppData OpenCode 目录或桌面版 OpenCode 实时读配置。
- `.opencode-private` 已被 gitignore，里面可能有 API key，禁止提交。

大白话：本机 OpenCode 是用户日常使用的客户端；auto-evolve 是训练机器。两边以后只允许通过“手动导入快照”同步一次，不允许运行时互相渗透。

## Blank Eval 进程清理红线

2026-06-25 修复了一个严重问题：Blank Eval 曾在运行中启动 10 秒轮询并调用 `cleanupRuntimeProcessScope(scope)`。这个函数不是健康检查，而是破坏性清理，会终止同一 `runtimeScope` 下登记的进程树。由于 `runOpencodeTask` 正好会把空白 agent 的 OpenCode 子进程注册到同一个 scope，这会导致 Blank Eval 自己杀掉自己。

症状包括：

- `Blank agent session infrastructure failed`
- `candidate file not found`
- `silent/no signal`
- 空白 agent 未写出 `workspace/answer.json`
- final acceptance 被误判为基础设施失败

当前规则：

- Blank Eval 运行中禁止调用 `cleanupRuntimeProcessScope(scope)`。
- 只允许在 `finally` 阶段做 scope cleanup。
- 如果未来要清理逃逸子进程，必须新增安全接口，例如 `excludePids` 或 `orphans_only`，不能复用全量 cleanup 当 poll/probe。

## Windows 状态写入与进程身份底座

2026-06-25 继续修复了两个基础设施级风险：

- `OpenCodeGate` 原来写 `state.json` 时会先写 tmp，再删除旧 state，再 rename。Windows 高并发或杀软扫描时如果 rename 被 EPERM/EBUSY 卡住，旧 state 已经被删掉，gate 会短暂失忆。
- `run-health`、benchmark 外层补位和 gate 清理原来主要靠 `process.kill(pid, 0)` 判断 PID 是否活着。Windows 会复用 PID，只看 PID 容易把“别人正在用的同一个 PID”误当成自己的旧 owner。

当前底座：

- `orchestrator/atomic-write.ts`
  - 统一提供 `writeFileAtomic` / `writeJsonAtomic`。
  - 规则是同目录临时文件 + rename + EPERM/EBUSY/EACCES 退避重试。
  - 禁止状态文件再写“先删旧文件再 rename”或“失败后直接覆盖目标文件”的逻辑。
- `orchestrator/process-identity.ts`
  - 统一提供 `identifyProcessOwner(...)`。
  - 判断时同时看 PID、Windows commandLine、owner hint、ownerCreationTick、heartbeat/updatedAt 新鲜度。
  - `run-long-task-campaign` / `resume-long-task-campaign` / scope / model / caller 只能作为 optional hint，不能单独证明归属。
  - 真正确认 owner 必须依赖完整 `ownerCommandHint`、campaignID/baseSpecPath/目录名等强 hint，或 Windows 进程创建时间 `ownerCreationTick` 匹配。
  - `owned` 才是明确属于我们；`wrong_owner` 要当作 stale；`unknown_owner` 只在心跳仍新鲜时保守观察。

已接入位置：

- `fs.writeJsonFile(...)` 统一走 `writeJsonAtomic(...)`。
- `OpenCodeGate` 的 `state.json` 走 `writeJsonAtomic(...)`，gate active/queue 清理走 `identifyProcessOwner(...)`。
- `runtime-process-registry` 的 `active-processes.json` 走 `writeFileAtomic(...)`，不再失败后直接覆盖。
- `run-health` 和 `run-benchmark-orchestrator` 不再裸用 PID 判活，改为进程身份识别。
- `campaign.json`、`progress_state.json`、`OpenCodeGate` active/queue slot 会记录 `ownerCreationTick`，防止 Windows PID 复用或并发任务命令相似导致假 healthy、拒绝续传、错误 takeover 或误杀。
- `multi-instance/repository.ts` 的 `coordinator-state.json` 也走统一原子写。

烟测：

```powershell
bun run auto-evolve/scripts/smoke-atomic-write.ts
bun run auto-evolve/scripts/smoke-process-identity.ts
bun run auto-evolve/scripts/smoke-concurrency-regression.ts
bun run auto-evolve/scripts/smoke-run-health-takeover.ts
```

大白话：以后状态文件写入是“换新文件”而不是“先撕掉旧账本再赌新账本写成功”；进程判断是“看是不是我们的人”而不是“这个 PID 号码有没有人占着”。

## JSONL 账本追加锁

2026-06-26 修复了另一类 Windows/多进程高并发账本风险：很多模块原来追加 `index.jsonl`、history、claims、validator-results、failure-packets、learning/scratch/retry lessons 时，会先读取完整文件，再写回 `existing + newLine`。多个进程同时写时，后写的人可能基于旧内容覆盖前写的人，导致验收记录、失败证据或学习记录“凭空消失”。

当前底座：

- `orchestrator/jsonl.ts`
  - `appendJsonlLocked(...)`：同一个 JSONL 文件追加一行时，先拿文件级锁，再 append。
  - `appendJsonlLinesLocked(...)`：同一个 JSONL 文件追加多行时，先拿文件级锁，再一次性 append。
  - `appendJsonlIfMissingLocked(...)`：需要按 id/逻辑记录去重时，查重和追加必须在同一把锁里完成。
  - `withJsonlLock(...)`：少数必须整文件 rewrite 的 JSONL，也必须在这把锁内读、改、原子写回。
  - `ensureJsonlFileLocked(...)` / `readJsonlFile(...)`：统一创建和读取 JSONL。

已接入位置：

- `acceptance-framework/repository.ts`
- `experience-transaction/repository.ts`
- `maintenance-gateway/repository.ts`
- `maintenance-gateway/short-task.ts`
- `long-task/repository.ts`
- `long-task-campaign/repository.ts`
- `long-task-campaign/runner.ts`
- `long-task-campaign/blank-agent-evidence.ts`

强制规则：

- 禁止新增 `existing + JSON.stringify(...)` 再写回目标 JSONL 的逻辑。
- 禁止把“先查 index 是否存在，再 append”拆成无锁的两步；这会在并发时重复或丢账。
- 禁止对 JSONL 做无锁整文件 rewrite；例如 campaign `history.jsonl` 修改某一轮记录时，必须先拿 `withJsonlLock(...)`。
- 普通文本聚合日志可以继续用 `appendFile`，但 JSONL 状态账本必须走 `orchestrator/jsonl.ts`。

烟测：

```powershell
bun run auto-evolve/scripts/smoke-jsonl-append-lock.ts
```

大白话：JSONL 账本现在像排队盖章，一个人写完下一个人再写；不是所有人同时拿旧账本复印一份再互相覆盖。

## autoEvolvePath 入口目录兼容

2026-06-26 修复了 `autoEvolvePath(cwd, ...)` 的入口目录问题。以前它默认 `cwd` 一定是项目根目录，然后无条件拼 `auto-evolve/...`。如果调用方已经在 `opencode latest\auto-evolve` 目录下启动，就会变成 `auto-evolve\auto-evolve\...`，导致 runtime-state、config、task-packs 等路径全部错位。

当前规则：

- `cwd = opencode latest` 时，根目录解析为 `opencode latest\auto-evolve`。
- `cwd = opencode latest\auto-evolve` 时，根目录仍解析为 `opencode latest\auto-evolve`。
- `cwd = opencode latest\auto-evolve\.` 时，也必须解析到同一个位置。

烟测：

```powershell
bun run auto-evolve/scripts/smoke-auto-evolve-path.ts
```

大白话：以后从项目根目录启动，或者从 `auto-evolve` 子目录启动，系统看到的是同一个 Auto-Evolve 根，不会再多套一层文件夹。

## Validator 文件参数路径解析与 infra 失败分类

2026-06-26 修复了长程任务验证器的文件参数解析问题。`loadLongTaskSpec(...)` 现在会把脚本验证器中明确表示文件路径的参数值解析到 spec 所在目录，例如 `--answer`、`--candidate`、`--ground-truth-path`、`--config` 等；不会改写 `--range D2:D13` 这类普通参数。

这次修复的直接背景是 SpreadsheetBench 的 `../../private-answers/<id>/answer.xlsx` 曾被错误锚定到桌面目录，导致空白 agent 验收阶段出现 `Validator crashed`。批跑外层现在也把 `Validator crashed`、`private-answers` 缺失这类错误归为基础设施失败（infra），在 `retryInfraFailed=true` 时允许重新跑，而不是当成模型真实做错。

大白话：验证器找不到答案文件，属于平台路径坏了，不是 agent 不会做题；这种失败要修平台并重跑，不能让任务白白烧到多轮。

## Blank Eval 产品验证器候选产物路径

2026-06-26 继续修复了 Campaign 每轮空白验收的产品验证器路径。`buildCampaignBlankEvalSpec(...)` 现在会把产品验证器里的 `--candidate`、`--candidate-path`、`--input`、`--output` 等运行期文件参数重写到 Blank Eval sandbox 内，例如 `./workspace/answer.json`。`--answer` 私有答案路径不会被搬进 sandbox，它只给系统验证器使用，不能让空白 agent 读取。

直接背景：SpreadsheetBench 某些轮次里空白 agent 在 sandbox 工作，但验证器仍去原始任务目录 `tasks/<id>/workspace/answer.json` 找候选答案，导致 `Candidate file not found`。这属于平台验收路径错误，不是模型真实不会做题。批跑外层已将 `Candidate file not found` / `missing candidate` 归为 infra failure，允许按 `retryInfraFailed=true` 重跑。

大白话：空白 agent 在隔离考场里答题，改卷老师也必须去隔离考场收卷，不能跑回旧教室找卷子。

## Benchmark Task Lease（2026-06-26）

通用批跑脚本 `auto-evolve/scripts/run-benchmark-orchestrator.ts` 现在会在 `<out>/benchmark-leases/<task-id>.json` 维护任务级 lease。lease 是外层 orchestrator 的“任务认领票”，记录 `ownerPID`、`ownerCreationTick`、`mode`、`campaignID/campaignDir`、`heartbeatAt` 和 `expiresAt`。

规则：启动或恢复训练任务前必须先拿到 lease；任务成功、终态或失败后释放；任务转入 `watch_live` 时刷新成 watch lease。lease 不用于杀进程，只用于防止外层重启或多个 agent 接手时重复启动同一个 task。大白话：内存里的 `activeIDs` 会随着外层进程退出而丢失，lease 是落盘的小票，用来告诉后来的调度器“这个训练项刚刚已经有人认领过”。

## OpenCodeGate Release Await（2026-06-26）

`OpenCodeGate.acquire()` 返回的 `permit.release()` 必须真正返回 `this.release(...)` 的 Promise，禁止 `void this.release(...)`。调用方在 `finally` 里 `await permit.release()` 后，`opencode-gate/state.json` 的 active slot 必须已经删除。否则任务结束后外层会以为锁已释放，但磁盘 state 仍占用并发名额，造成队列饿死、假卡住或长时间不补位。

对应 smoke：`bun run auto-evolve/scripts/test-opencode-gate.ts` 会直接读取 gate 的 `state.json`，断言单次 release 和 20 个并发 `gate.run(...)` 结束后 `active.length === 0`。

## 长程任务隔离边界（2026-06-26）

每个长程任务默认必须像独立考场。平台可以保存全局账本，但不能默认把别的任务、别的 spec、别的验收私有文件塞进当前任务上下文。

当前规则：

- `shadow-memory/index.jsonl` 仍可记录影子经验，但 retry bundle 默认不读取跨 run shadow memory。只有 spec 明确配置 `shadowMemoryScope.retrievalMode = "related_only"` 时，才允许按 namespace/tags 取相关记忆；`isolated` 和未配置都等于不注入。
- completion bundle 不再读取全局 shadow memory，只使用当前 run 的 claim、failure、learning、scratch 和 operational context。
- benchmark 复用旧 campaign 时必须同时满足 history lineage、taskID、generationID 和 specHash。无 historyContext 的旧全局 campaign 默认不复用；如确需兼容旧实验，必须显式设置 `AUTO_EVOLVE_ALLOW_LEGACY_CAMPAIGN_REUSE=1`。
- Blank Eval clean skill copy 会按路径过滤 `private-answers`、`answer-key`、`ground-truth`、`validators`、`validator_input.json`、`result.private.json`、`.opencode`、`.runtime`、cache/temp 等敏感目录或文件。
- Blank Eval 复制 `materials`、guidance 和 capability 文件时也走同一套敏感路径检查。若源目录本身或子路径包含 `private-answers`、`answer-key`、`ground-truth`、`validators`、`validator_input.json`、`result.private.json`、`result.json` 等，直接 fail closed，不能把大目录静默拷进 sandbox。
- Blank-agent evidence 给 worker 看的只应是训练视图和压缩证据，例如 `validation-training.compact.json`、工具调用摘要、workspace 文本 manifest；不能把 final acceptance 原始 result 或 private validator 输入直接放进 readable paths。
- `validation.allowedAudiences` 禁止包含 `blank_agent`。这个检查必须在 spec 加载/规范化阶段 fail fast，validation descriptor 生成时也会再防御一次。blank agent 是闭卷执行者，不允许读取任何 validation result view。
- long-task runID 和 blank-eval runID 都带随机盐，避免同毫秒并发时目录名撞车。

大白话：任务之间可以在系统账本里留下历史，但不能默认互相递小抄；真要复用，必须证明是同一轮实验、同一个 task、同一个 spec 版本。

对应 smoke：

```powershell
bun run auto-evolve/scripts/smoke-blank-eval-sensitive-material-guard.ts
bun run auto-evolve/scripts/smoke-validator-blank-agent-audience-guard.ts
```
## Monitor 看板减负规则（2026-06-26）

`auto-evolve/monitor-server.ts` 不能再用 2 秒高频刷新和无限深度递归扫描 `runtime-state`。默认刷新间隔改为 15 秒、默认 limit 改为 30，artifact/lifecycle 扫描结果缓存 15 秒，并对递归扫描加入最大深度、最大目录数和重目录跳过规则（workspace、materials、outputs、private-answers、blank-eval-runs、node_modules 等）。`orchestrator/monitor.ts` 已加入启动锁，同一端口看板启动中时其他 orchestrator 必须等待/复用，不能并发拉起多个 monitor-server。训练监控优先读 `orchestrator-state.json`、`run-dashboard` 和真实进程；不要为了持续监控反复启动看板。
\n

<!-- 原 README 行 2412-2500 -->

## Benchmark CLI Argument Guard (2026-07-04)

`run-benchmark-orchestrator.ts` now refuses unexpected bare command-line arguments.

Why this exists:

- On Windows, paths like `C:\Users\ZhuanZ\Desktop\opencode re\...` are easy to split accidentally if `--out` is not quoted correctly.
- Before this guard, a split `--out` could silently become `C:\Users\ZhuanZ\Desktop\opencode`, creating the wrong run folder and wasting model quota.
- Now the orchestrator fails closed with a clear error if it sees leftover path fragments such as `re\opencode`.

Safe launch rule:

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts --out "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\runtime-state\benchmark-runs\<run-id>" ...
```

For background PowerShell launchers, pass arguments as an array inside a `.ps1` file, or quote the `-File` script path explicitly. Do not build one long unquoted command string for paths containing spaces.

## Managed Process Stdin Guard (2026-07-04)

`runManagedProcess` now treats stdin `EPIPE` / closed-pipe errors as controlled child-process failures instead of throwing through the orchestrator.

Why this matters:

- OpenCode or a wrapper process may exit before the parent finishes writing a large prompt through stdin.
- Before this guard, the parent Bun process could crash with `EPIPE: broken pipe, write`, leaving `campaign.json` stuck in `running` even though the owner PID was dead.
- Now the stderr includes a `[managed-process]` note and the caller receives a normal process result, so campaign/benchmark recovery can classify and resume instead of losing control.

Smoke:

```powershell
bun run auto-evolve/scripts/smoke-managed-process-stdin-epipe.ts
```

## Windows Process Identity Query Guard (2026-07-04)

`process-identity.ts` uses a short PowerShell probe to read Windows command lines and process creation ticks. That probe must stay bounded.

Why this matters:

- Health checks, gate checks, and benchmark supervisor polling may ask for process identity many times per minute under concurrency.
- If a PowerShell probe hangs or the same PID is queried repeatedly without caching, the monitor itself can accumulate helper processes and steal CPU/memory from real OpenCode sessions.
- The identity probe now has a hard timeout, stdout cap, and short per-PID cache. If the probe cannot answer quickly, ownership becomes `unknown_owner` / stale according to heartbeat rules instead of blocking the supervisor.

Smoke:

```powershell
# Start a short hidden PowerShell Start-Sleep process, then call identifyProcessOwner
# with requiredAnyCommandHints = ["Start-Sleep"]. It should return ownership = owned
# with command line and creation tick present.
```

## Non-Blank Open-Book Oracle Evidence (2026-07-05)

Only the blank agent is closed-book. Non-blank learning roles such as campaign
workers, lead, reviewer, merger, repair agent, and blank acceptance diagnostician
may use oracle evidence to diagnose failures and repair the skill.

Campaign final acceptance now writes an explicit `expert-oracle-bundle.json`.
The bundle is an index, not a copied answer dump. It points to exact allowed files
such as `result.private.json`, `result.training.json`, and private answer files
discovered from validator private/training views. These paths are added to both
the prompt and `permissionReadPaths`; a role does not merely see the path, it also
has permission to read it.

The oracle channel is for open-book learning only. The blank-eval sandbox never
receives this bundle or private answer paths. Surface validators remain the guard
that prevents hidden answers, private paths, and case-specific oracle literals from
entering the final skill.

Robustness rules:

- Embedded oracle paths discovered inside `result.private.json` / `result.training.json`
  must look like real paths and must resolve to existing exact files.
- The collector ignores directory-level private-answer roots, missing files, normal
  prose strings, `.runtime`, `.opencode`, `node_modules`, and non-view files under
  validator directories.
- The oracle bundle has a bounded path list and bounded JSON traversal so a huge
  private view cannot explode the campaign prompt/permission surface.
- Any blank-agent evidence channel is defensively checked again; if a private answer,
  `result.private.json`, ground-truth, or answer-key path is accidentally routed there,
  the campaign fails closed instead of leaking it to blank evaluation.

Smoke:

```powershell
bun run auto-evolve/scripts/smoke-expert-oracle-bundle.ts
```
## Benchmark Campaign Rounds Resume Guard (2026-07-06)
\n

<!-- 原 README 行 2622-2664 -->

## Init Assets 初始化资产（2026-07-07）

`orchestrator/fs.ts` 不再内嵌大段默认 Markdown / Python / JSON 模板。初始化用的默认文件现在放在：

```text
auto-evolve/init-assets/
```

大白话：`fs.ts` 只负责“检查目录、缺文件时复制种子文件”；真正的种子模板、默认 prompt、judge skill 脚本、task-pack 示例都在 `init-assets` 里作为普通文件维护。

注意：
- `init-assets` 是核心源码资产，不是缓存，不能从导出包或主链提交里排除。
- 修改默认模板时，优先改 `init-assets` 里的真实文件，不要再往 `fs.ts` 里塞大段字符串。
- `ensureLayout()` 仍然保持“只在目标文件缺失时写入”的行为，不会覆盖已有用户配置或已有模板。

## 干净全景代码导出（2026-07-07）

核心代码导出脚本保持单一入口和单一输出：

```powershell
python .\auto-evolve\scripts\export-core-code-to-desktop.py
```

导出文件仍写到桌面，命名为：

```text
auto-evolve-core-code-<timestamp>.txt
```

这份导出包的目标是“干净全景”：保留 orchestrator、methods、prompts、关键启动/管理脚本和 README/AGENTS；过滤 smoke/test、重复 `init-assets`、前端 UI、数据集专用 validator、OCR/物化/报表/运维脚本等外围噪音。

注意：`init-assets` 仍是源码仓库中的核心初始化资产，不能删除；只是因为它和 live methods/prompts/templates 内容重复，所以不进入这份阅读导出包。

### Benchmark 历史账本体检与自动隔离

`run-benchmark-orchestrator.ts` 在每次启动/续传 benchmark 前会先检查 `task-ledger.json`：

- 默认超过 20MB 会视为异常，避免旧版路径反斜杠重复转义把账本膨胀到 GB 级后导致 OOM。
- 会验证 JSON 可解析、schema 正确、任务 ID 和当前 split 完整匹配。
- 检测到异常时会把旧账本移动到 `history-quarantine/`，然后由初始化流程结合 `orchestrator-state.json` 中可信的 `verified_success` 记录重建小账本。
- 每次体检会写入 `history-health/*-task-ledger-preflight.json`；benchmark 计划阶段还会写 `history-health/*-state-consistency.json`，用于检查 `task-ledger.json` 和 `orchestrator-state.json` 是否分叉。

这层保护只处理平台账本健康，不改变已经成功的 skill/campaign 产物；如果体检报告显示 mismatch，需要优先排查是否误用了错误 split、错误 `--out` 或旧 run 血统。
\n