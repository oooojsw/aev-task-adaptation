> 本文件由原 README.md 按主题拆分而来，正文尽量保留原文。
> 本文件负责：Blank Eval 闭卷验收、沙盒隔离、private answers、产品验证器、权限与反作弊红线。

原始完整备份：README-FULL-ARCHIVE-20260709-015413.md。

<!-- 原 README 行 248-310 -->

## Blank Eval 物理闭卷沙盒红线（2026-06-26）

Blank Eval 现在必须按“物理闭卷考试”运行，而不是只靠提示词或元数据声明不能看答案。每次空白 agent 验收都会在 `runtime-state/blank-eval-runs/<run>/sandbox/` 下构建独立考场：

- `sandbox/materials/`：只复制该题允许读取的原始材料。
- `sandbox/skill/`：只复制去掉隐藏缓存、`.opencode`、`node_modules`、软链接/junction 的 clean skill。
- `sandbox/workspace/`：唯一可写输出区。
- `sandbox/bundle.json`：只记录 sandbox 内路径，不记录原始 spec、private answers、旧 campaign、worker、validator 输入等路径。

实现要点：`runOpencodeTask` 新增 `workDir` 和 `allowShell`，因此 repo 根目录仍可用于加载本地 OpenCode 源码和依赖，但传给 `opencode run --dir` 的任务目录必须是 sandbox 根目录。Blank Eval 默认 `allowShell: false`；如果以后确实需要 shell，必须先实现只能在 sandbox 内执行、并防 symlink/junction 逃逸的安全 wrapper，不能直接打开普通 shell。

清考场也必须 fail closed：Blank Eval 的 reset 只能备份、删除、重建 `sandbox/` 内的 `editablePaths/targetPaths`。如果 spec 写了绝对路径或 `../` 逃逸路径，系统必须在启动模型前报错停止，不能帮它清理宿主机上的真实文件。

## Blank Eval Plan Runner（2026-07-03）

`runBlankEval()` 仍然是“单题闭卷考试”：给一个 case spec 和一份 skill，让一个空白 agent 在独立 sandbox 里做题。

新增 `runBlankEvalPlan()` 是它上面的一层“考试编排器”：同一份 skill 可以按计划跑一组 case，并把每题的闭卷结果汇总成一个总判决。它不替代单题 Blank Eval，只负责把多题 replay 变成可复用基础设施。

当前支持三种模式：

- `single`：只跑第一条 case，兼容旧的单题验收语义。
- `sequence`：按顺序跑多条 case，可配置失败即停，适合省钱排查。
- `parallel`：并行跑多条 case，适合合并后训练集回撤或测试集批量闭卷验收。

可作为 long-task completion validator 使用：

```json
{
  "id": "merged-skill-replay",
  "type": "blank_eval_plan",
  "placement": "completion_only",
  "planPath": "materials/replay-plan.json",
  "skillRootPath": "workspace/merged-skill",
  "mode": "parallel",
  "concurrency": 3,
  "successCriterion": "all_pass"
}
```

红线：Plan Runner 可以读取 replay plan 和 case 列表，但每个空白 agent 仍然只通过原有 Blank Eval 沙盒看到当前 case 的原始材料、clean skill 和自己的 workspace。`replay-plan`、其他 case workspace、private answers、训练轨迹、input skills 不能暴露给空白 agent。

## PID Owner 强身份判断补丁（2026-06-26）

Windows 会复用 PID，所以 Auto-Evolve 不能只看“这个 PID 活着”或“命令行里出现 run-long-task-campaign”。现在 `process-identity.ts` 提供统一的 owner hint 分类：

- `strongProcessOwnerHints(...)`：只保留可证明具体任务归属的强上下文，例如完整命令、campaignID、campaign 目录名、baseSpecPath、runID。
- `optionalProcessOwnerHints(...)`：只放旧状态里残留的泛用命令名，例如 `run-long-task-campaign`、`resume-long-task-campaign`、`run-long-task`。

run-health、benchmark 外层恢复、OpenCodeGate、campaign takeover 都必须使用这组 helper。泛用 hint 不能进入 `requiredAnyCommandHints`，否则旧状态可能把别的 campaign 进程误认成当前任务，造成看板假健康、断点续传不启动或错误 takeover。

补充规则：campaign runner 内部也不能只看旧 `ownerCommandHint`。恢复、自愈和 takeover 必须带上 campaignID、campaign 目录名、baseSpecPath 或 runID 这类强上下文。`unknown_owner` 只能在心跳新鲜时短暂观察，不能长期阻止 stale recovery；更不能作为 `terminateProcessTree(...)` 的依据。只有 `ownership === "owned"` 才允许杀进程。

OpenCodeGate 的 active slot 不能只看“持有 permit 的父进程还活着”。长任务 campaign 父进程可能还在，但某个 OpenCode worker 已经 `done`，如果 permit release 因 Windows 文件锁/状态竞争没写回，就会出现“座位牌没撤、后面全排队”的假满员。现在每个 gate permit 都带 `heartbeatAt/heartbeatAtMs`，`runOpencodeTask` 通过 managed-process pulse 刷新心跳；真实 `opencode.exe` 子进程结束后必须立刻释放 gate，后续 JSON 解析、报告写入和 worker suggestion 后处理不能继续占用 OpenCode 并发位。没有心跳的旧 active slot 超过 30 分钟会被 cleanup 当作 legacy stale slot 清掉。排查并发卡死时要同时看 `state.json.active[*].heartbeatAt` 和对应 worker 的 `run.json`，不能只看 ownerPID。队列也有同类问题：旧排队项的 campaign 父进程还活着，不代表当初等待 permit 的 acquire 协程还活着；如果 gate 是空的，队头超过 30 秒仍没拿到 permit，当前仍在真实轮询的请求可以越过旧队头；如果 gate 非空，队头超过 15 分钟仍没拿到 permit，也允许活请求绕行。这样避免一个孤儿队列项把整个 OpenCodeGate 压成单并发或零并发。

这是一份为你和未来接手此项目的所有 AI 智能体量身定制的 **最高指导纲领（CRITICAL_ARCHITECTURE_MEMO.md）**。

我融合了系统底层的数学约束哲学、多智能体社会学架构、极度严苛的物理隔离防线（包含 06-04 与 06-05 的所有底层修复纪实），以及一份**可落地的“接手操作指南”**。

请将以下内容完整保存为项目根目录下的 `CRITICAL_ARCHITECTURE_MEMO.md`，并在未来任何新 Agent 介入时，**强制要求其第一时间读取此文件**。

***

\n

<!-- 原 README 行 1334-1449 -->

## 2026-06-18: Task-Pack Purity And Runtime Workspace Isolation

测试集和训练集的 task-pack 目录必须保持“题库只读”。原始题目目录只应该保存：

- `instruction.md`
- `spec.json`
- `campaign.json`
- `materials/` 下由 `spec.materials` 明确声明的原始材料

运行产物不能再写回：

```text
task-packs/real-long-tasks/<dataset>/tasks/<UID>/workspace
task-packs/real-long-tasks/<dataset>/tasks/<UID>/expert-workspace
task-packs/real-long-tasks/<dataset>/tasks/<UID>/materials/page*.txt
```

平台层现在在 long-task 和 blank-eval 启动时，把 task-local runtime path 隔离到 run 目录：

```text
runtime-state/long-task/runs/<runID>/task-workspace/workspace
runtime-state/long-task/runs/<runID>/task-workspace/expert-workspace
runtime-state/blank-eval-runs/<runID>/task-workspace/workspace
runtime-state/blank-eval-runs/<runID>/task-workspace/expert-workspace
```

材料路径仍然指向原始 task-pack PDF，只读使用；答案输出、临时 notes、专家经验草案和 validator candidate 路径会进入 runtime workspace。

相关代码：

- `orchestrator/long-task/repository.ts`：`isolateLongTaskRuntimePaths()` 负责把 `./workspace`、`./expert-workspace`、`./validation-expert-workspace` 重定向到 run-local workspace。
- `orchestrator/long-task/runner.ts`：新 long-task run 初始化后使用隔离后的运行态 spec。
- `orchestrator/blank-eval/runner.ts`：blank agent 闭卷产物也写入 blank-eval run-local workspace。
- `orchestrator/long-task-campaign/runner.ts`：campaign seed/reset 不再写回 base spec 旁边的 task-local runtime paths。

如果未来发现 task-pack 里又出现 `page*.txt`、`analysis.txt`、`workspace/answer.txt` 等文件，优先怀疑是手工调试脚本或新 adapter 绕过了平台层，直接写进了题库目录。正式实验前要按 `spec.materials` 白名单清理材料目录，只保留声明材料。

## 2026-06-18: OpenCode Isolated Runtime Uses Alibaba Coding Plan

Auto-Evolve 默认 OpenCode 模型已从 MiniMax 切换到：

```text
alibaba-coding-plan-cn/qwen3.7-plus
```

2026-06-22 起，新的 Auto-Evolve/OpenCode 隔离 session 使用 Qwen3.7 Plus；旧 runtime session 保留其启动时的模型，不会被中途切换。

这个切换现在可以直接在项目总配置里改：

```text
auto-evolve/config.json -> modelConfig.defaults.model
```

`config.json` 也已经内联了常用运行配置：

```text
modelConfig
judgeConfig
permissionConfig
monitorConfig
concurrencyConfig
stageConcurrency
```

读取优先级是：`config.json` 内联配置 > 对应外部小配置文件 > 代码默认值。外部的 `model-config.json`、`concurrency-config.json` 等文件仍保留，主要为了兼容旧脚本和旧迁移包；新实验优先改总配置。

并发现在分两层：

- `concurrencyConfig` 是机器级总闸门，控制同一时间最多允许多少 OpenCode 子会话进入系统，例如总并发、单 scope 上限、队列深度和获取锁超时。
- `stageConcurrency` 是流程级阶段并发，控制训练、合并、层级合并、训练回测、测试集 blank eval、Direct Chat 测试和 baseline 各自开多少路。

推荐以后优先在 `auto-evolve/config.json` 改这些键：

```json
{
  "stageConcurrency": {
    "training": 5,
    "merge": 1,
    "hierarchicalMerge": 2,
    "trainReplay": 3,
    "testBlank": 3,
    "testDirectChat": 4,
    "baseline": 3
  }
}
```

通用启动脚本仍支持命令行临时覆盖：

```text
--train-concurrency / --concurrency
--merge-concurrency
--hierarchical-merge-concurrency / --merge-group-concurrency
--replay-concurrency / --validate-concurrency
--test-concurrency / --blank-test-concurrency
--direct-chat-global-concurrency / --direct-chat-test-concurrency
--baseline-concurrency
```

OfficeQA 包装脚本也会读取同一个 `stageConcurrency`，并允许用环境变量临时覆盖，例如 `OFFICEQA_PRO_TRAIN_CONCURRENCY`、`OFFICEQA_PRO_REPLAY_CONCURRENCY`、`OFFICEQA_PRO_TEST_CONCURRENCY`、`OFFICEQA_PRO_DIRECT_CHAT_CONCURRENCY`。这样以后“训练几并发、合并几并发、回撤测试几并发、测试集几并发”都属于总控配置，不需要再去散落脚本里找。

这个切换只影响本项目配置和平台默认兜底，不修改宿主机主配置：

```text
C:\Users\ZhuanZ\.config\opencode\opencode.json
```

OpenCode 子会话仍通过隔离运行时启动。`orchestrator/opencode.ts` 会把宿主机的 OpenCode auth 和模型缓存复制到每个 run-local 的隔离目录：

```text
runtime-state/opencode-isolated-env/<runLabel>/data/opencode/auth.json
runtime-state/opencode-isolated-env/<runLabel>/cache/opencode/models.json
```

因此阿里 Coding Plan 的 provider/model 能在隔离子进程内解析，但不会把 auto-evolve 的运行时改动写回本机 OpenCode 配置。当前本机模型缓存中 `alibaba-coding-plan-cn` 可用模型包括 `qwen3.6-plus`、`qwen3.7-plus`、`qwen3.7-max`、`qwen3-coder-plus`、`qwen3-coder-next`、`glm-4.7`、`glm-5`、`kimi-k2.5`、`MiniMax-M2.5`。

\n

<!-- 原 README 行 1959-2124 -->

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
\n

<!-- 原 README 行 2246-2380 -->

## Blank Acceptance Diagnosis Profiles（2026-07-03）

空白 agent 验收失败后的诊断器现在也纳入总控配置。总控入口是 `config.json > blankAcceptanceConfig`：

```json
"blankAcceptanceConfig": {
  "enabled": true,
  "defaultDiagnosisProfile": "auto",
  "taskPackDiagnosisProfiles": {},
  "diagnosisProfiles": {
    "auto": { "mode": "auto", "enabledModules": ["single-case", "plan-replay", "infra-triage"] },
    "single-case": { "mode": "single_case", "enabledModules": ["single-case"] },
    "plan-replay": { "mode": "plan_replay", "enabledModules": ["plan-replay", "infra-triage"] }
  }
}
```

大白话：`blank_eval_plan` 控制“空白 agent 怎么验收”，`blankAcceptanceConfig` 控制“验收失败后诊断器怎么分析”。以前诊断器默认只像单题失败分析；现在它可以按 profile 识别多 case 回撤、合并后回撤、平台路径/validator 故障，并把这些区别明确反馈给 lead。

证据包 `blank-agent-evidence` 也新增了 `plan-replay.compact.json`。当 final acceptance 里出现 `blank_eval_plan` 的 `plan-result.json` 时，系统会自动生成安全摘要：总 case 数、通过数、失败数、失败 case id、每个失败 case 的摘要与 failureKind。这个摘要不包含 private answer，也不会把标准答案暴露给 blank agent。

新增烟测：

```powershell
bun run auto-evolve/scripts/smoke-blank-acceptance-diagnosis-profiles.ts
```

这个 smoke 不启动真实模型，只验证：总控 profile 可读取、诊断 prompt 会注入 plan-replay/infra-triage 规则、多 case 回撤证据能被压缩进可读证据包。

## Hierarchical Merge-As-Long-Task Pack Generation (2026-07-03)

`merge-as-long-task` now has a hierarchical pack-generation path controlled by `config.json > mergeConfig.asLongTask.hierarchical`.

Plain meaning: many single-case skills can be packed into level-01 merge long-tasks, those level-01 group skills can then be packed into level-02 merge long-tasks, and this repeats until one final merge task remains. A next-level row carries both `sourceCases` and `replayCases`, so a group skill can be one merge input while its blank replay still expands back to all original cases.

Current implemented boundary:
- Implemented: dataset/task-pack generation and no-model smoke tests.
- Not yet implemented: a live supervisor that starts all group campaigns, waits for real completions, then resumes the next level from actual completed outputs.

Key scripts:
```powershell
bun run auto-evolve/scripts/create-hierarchical-merge-long-task-pack.ts --task-pack-root <pack> --split <split.json> --campaign-manifest <manifest.json> --out-root <out>
bun run auto-evolve/scripts/smoke-hierarchical-merge-as-long-task-pack.ts
```

Validated smoke:
```powershell
bun --check auto-evolve/orchestrator/schema.ts auto-evolve/scripts/create-merge-long-task-pack.ts auto-evolve/scripts/create-hierarchical-merge-long-task-pack.ts auto-evolve/scripts/smoke-hierarchical-merge-as-long-task-pack.ts
bun run auto-evolve/scripts/smoke-hierarchical-merge-as-long-task-pack.ts
bun run auto-evolve/scripts/smoke-merge-as-long-task-pack.ts
```

## Hierarchical Merge-As-Long-Task Live Supervisor (2026-07-04)

分层 merge-as-long-task 现在从“只生成任务包”升级为“可独立执行的 live supervisor”第一版。

总控入口：

```json
"mergeConfig": {
  "asLongTask": {
    "hierarchical": {
      "levelPlanningMode": "until_one",
      "singleInputMode": "promote",
      "finalizationMode": "require_single_final",
      "watchPollMs": 10000,
      "watchMaxPolls": 720,
      "levels": []
    }
  }
}
```

大白话：
- `levelPlanningMode=until_one`：一直按配置合并，直到只剩 1 个 final skill。
- `levelPlanningMode=configured_levels`：只跑 `levels[]` 里列出的层；如果跑完还剩多个 skill，就按 `finalizationMode` 收尾或 fail closed。
- `levels[]`：可以指定每层自己的 `groupSize`、`groupConcurrency`、`blankReplayConcurrency`、surface profile 和 blank acceptance scenario。
- `groupConcurrency`：现在在 live supervisor 里真正控制“同一层同时跑几个 group campaign”，不再只是记录字段。
- `watchPollMs / watchMaxPolls`：控制 supervisor 多久检查一次已经在跑的 group campaign、最多观察多少次；真实任务可以等久一点，smoke 可以调短。
- `singleInputMode`：当输入只有一个 skill 时，默认 `promote`，不浪费模型再跑一次合并。

新增脚本：

```powershell
bun run auto-evolve/scripts/run-hierarchical-merge-long-task.ts --task-pack-root <pack> --split <split.json> --campaign-manifest <manifest.json> --out-root <out>
```

新增 smoke：

```powershell
bun run auto-evolve/scripts/smoke-hierarchical-merge-as-long-task-pack.ts
bun run auto-evolve/scripts/smoke-hierarchical-merge-live-supervisor.ts
```

当前边界：
- 已实现：per-level groupSize、fixed/configured levels、single-input promote/wrap/fail、live supervisor 并发队列、fake runner smoke。
- 已实现：每层完成后把 group skill 变成下一层输入，并保留 `sourceCases/replayCases`，最终 replay 仍能展开回原始 cases。
- 已实现：`run-benchmark-orchestrator.ts` 的 `mergeExecutionMode=long_task` 可选分支已经能调用分层/单层 merge long-task runner；默认仍是 `legacy_script`，旧合并链路不受影响。
- 2026-07-06 增强：live supervisor 会按 `baseSpecPath` 识别已有 group campaign，健康运行只 watch，`recovery_pending/stale/takeover` 才 resume；子进程退出后如果 campaign 仍在 watch/recovery，不会被误当成已完成。
- 2026-07-06 增强：`hierarchical-live-state.json` 和 `hierarchical-live-report.json` 会记录每个 group 的状态、campaignID、campaignDir、health、summary 和 `outputSkillPath`。最终 `finalSkillPath` 优先指向 campaign 转正后的 `pending-expert-package/current`，避免误指临时 workspace。
- 当前边界：`long_task` 分支的 held-out test 仍优先支持 `direct-chat`；如果需要旧式 `blank-opencode` 测试集验收，继续用 `legacy_script`，或后续补 coordinator-state 桥接。

## Blank Eval Plan Guardrails (2026-07-04)

Blank agent acceptance now has two execution families:

- `runBlankEval`: original single-case closed-book test.
- `runBlankEvalPlan`: multi-case closed-book replay with `single`, `sequence`, or `parallel` mode.

Important rule:

```text
mode=single must receive exactly one case.
multi-case replay must use mode=sequence or mode=parallel.
```

If `mode=single` receives multiple cases, the plan now fails closed and writes a normal `plan-result.json` / `evidence-bundle.json` instead of silently testing only the first case. This prevents a dangerous false pass where a "full replay" accidentally validates only one item.

The long-task `blank_eval_plan` adapter also preserves `stopOnFirstFailure` from either the validator contract or the plan JSON, so sequence replay can stop after the first real failure when that is the intended mode.

Path and filename guardrails:

- Duplicate replay case IDs fail closed before any blank agent runs.
- Empty case IDs or empty `specPath` fail closed with normal evidence files.
- Case run directories are always composed as `cases/<index>-<safe-case-id>` and verified to stay inside the plan run directory.
- Windows-reserved names such as `CON`, `AUX`, `NUL`, `COM1`, and `LPT1`, plus newlines and unsafe filename characters, are sanitized before directory creation.
- Relative `promptInlinePaths` in replay plans are resolved relative to the replay-plan file, not the terminal cwd.

Smoke:

```powershell
bun run auto-evolve/scripts/smoke-blank-eval-plan.ts
bun run auto-evolve/scripts/smoke-blank-eval-plan-spec.ts
```

\n

<!-- 原 README 行 2558-2588 -->

## Blank Eval Public Task Spec (2026-07-06)

Blank Eval is physically closed-book: the blank agent must not see private
answers, validator private views, campaign traces, worker notes, or historical
runtime folders. However, a closed-book run still needs a public task contract.

Current rule:

- Every Blank Eval sandbox materializes `sandbox/materials/spec.json`.
- This is a redacted public spec, not the original task-pack spec.
- It may include task goal, public materials, output targets, editable paths,
  and public output constraints such as SpreadsheetBench ranges.
- It must not include `private-answers`, answer workbook paths, `--answer`,
  ground-truth fields, validator private input files, or campaign/runtime paths.
- Candidate output paths in the public spec are rewritten from sandbox
  `targetPaths`, not copied from original validator args.

Plain-language reason: the blank agent should not know the answer, but it must
know the exam instructions. SpreadsheetBench case `30930` exposed this gap: the
skill told the blank agent to read `spec.json`, but the sandbox did not provide a
safe spec. The model guessed the output range from the workbook and repeatedly
wrote `C1:C66` or other off-by-one outputs while the private validator expected
`C2:C66`.

Smoke:

```powershell
bun --check auto-evolve/orchestrator/blank-eval/runner.ts auto-evolve/scripts/smoke-blank-eval-public-spec.ts
bun run auto-evolve/scripts/smoke-blank-eval-public-spec.ts
```

\n