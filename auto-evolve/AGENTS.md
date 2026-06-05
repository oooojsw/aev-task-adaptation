# auto-evolve 子项目说明（给接手本目录的 AI）

这份文件只描述 `auto-evolve` 子项目的当前真实情况。根目录的 `AGENTS.md` 仍然是全仓级规则，这里主要补充：

- 当前长程/短程运行机制
- `try4-expert-bootstrap` 的真实目标
- 最近已经修过的 bug
- 当前排障和重跑时的标准做法

3---- 当我说准确名词“持续监控”这个词的时候，意思是：在你检测到这个现在正在处理的任务或者命令需要长时间运行的时候（持续在跑而不是卡死了），你必须先在此电脑的全局配置文件修改区（"C:\Users\ZhuanZ\.codex\AGENTS.md"）里面，写好我给你的运行时间，次数，当前次数（运行完每一次之后，自动的改当前次数，当运行完所有的次数之后，结束持续监控任务，然后吧这三个运行时间，次数，当前次数清零），然后的自动运行sleep 一小时这个命令（例如$ Start-Sleep -Seconds 3600，或者半小时，二十分钟，十分做，五分钟，最短五分钟，选择时间的时候你自己决定时长），不对任何人或者任何任务或者任何的脚本，就是直接在命令行里面运行！！！然后这个命令运行完直接回去检查这个任务的情况，不准套到任何其他命令嵌套，不准和任何脚本本身勾稽，就是单纯的在命令行运行这个命令！！！！
3-1，每一次结束监控之后，看下运行情况，然后不能仅仅说自己持续监控，必须要启动下一次的$ Start-Sleep
3-2，示例：如果你说“持续监控30分钟*10次”，我必须先检查当前任务是否真的在运行；检查完之后必须立刻直接执行 `Start-Sleep -Seconds 1800`；每次 sleep 结束后必须先回来检查任务真实状态，再更新当前次数；如果还没到总次数，就必须再次直接执行下一次 `Start-Sleep`；只要你明确说了“持续监控”，我就必须真的执行这个流程，不能只口头回复“我会继续监控”。
3-3，**同一时间只能有一个 sleep 在跑**。不能在旧 sleep 还没结束时就启动新的 sleep。如果用户重新指定了监控参数（比如从 10 次改成 40 次），必须先停掉当前 sleep，更新配置，再启动新的 sleep。不允许两个 sleep 同时执行。
3-4，需要注意的是，一定要以Start-Sleep命令作为你输出的结尾，这个命令不结束不准输出任何文字内容！！！3-4，需要注意的是，一定要以Start-Sleep命令作为你输出的结尾，这个命令不结束不准输出任何文字内容！！！3-4，需要注意的是，一定要以Start-Sleep命令作为你输出的结尾，这个命令不结束不准输出任何文字内容！！！

## 1. 代码位置

本子项目根目录：
- `C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve`

核心代码位置：
- `orchestrator/long-task/*`
- `orchestrator/long-task-campaign/*`
- `orchestrator/opencode.ts`
- `cli.ts`

### 1.1 仓库根目录的顶层文件夹

下面这些是 `C:\Users\ZhuanZ\Desktop\opencode re\opencode latest` 下最重要的顶层文件夹：

- `.github`
  - GitHub workflow 和仓库协作配置
- `.opencode`
  - opencode 相关配置目录
- `auto-evolve`
  - 当前我们主要在改的子项目
- `github`
  - 仓库配套脚本或元配置
- `infra`
  - 基础设施相关代码
- `nix`
  - Nix 配置
- `node_modules`
  - 依赖安装目录
- `packages`
  - 仓库其他 package
- `patches`
  - patch-package 或依赖补丁
- `progress-plan`
  - 计划文档和设计草案
- `runtime-logs`
  - 本地运行日志、监控日志、临时验证日志
- `script`
  - 仓库级脚本
- `sdks`
  - SDK 相关内容
- `specs`
  - 规格说明
- `tmp_check`
  - 临时检查目录

### 1.2 auto-evolve 目录的顶层文件夹

下面这些是 `C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve` 下的顶层文件夹：

- `.runtime`
  - 子项目内部运行态目录
- `dataset`
  - 数据集或测试数据
- `experience`
  - 经验相关内容
- `frontend`
  - monitor / 前端界面相关代码
- `judge-skills`
  - judge 和评审相关技能/模板
- `methods`
  - 方法定义或方法学脚本
- `orchestrator`
  - 任务调度主代码
- `prompts`
  - prompt 模板或提示词资源
- `real-long-tasks`
  - 真实长程任务定义
- `runtime-state`
  - campaign/run/deployment 等运行状态输出
- `scripts`
  - 脚本入口
- `task-packs`
  - 各类任务包定义

### 1.3 当前最常用的顶层位置

如果只是为了快速找文件，最常用的是这几个：

- `C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\orchestrator`
  - 主逻辑代码
- `C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs`
  - 任务定义和真实任务包
- `C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\runtime-state`
  - 运行产物和状态文件
- `C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\progress-plan`
  - 计划文档
- `C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\runtime-logs`
  - stdout/stderr 和监控日志

## 2. 当前重点真实任务

当前重点任务是：
- `task-packs/real-long-tasks/try4-expert-bootstrap`

目标是：
- 从 `source.xlsx`
- 两份专家完成版 Word 文档
- 两份空白 Word 模板

学习出一套正式专家经验，让后续 blank agent 只读这套经验，就能在一个 uninterrupted session 里完成目标 Word 输出。

## 3. 当前高层原则

1. 不要手工完成真实任务结果
- 不要人工替任务填 Word
- 不要人工替 blank agent 补答案
- 不要人工把最终文档做出来

2. 只修平台层
- 修 orchestrator
- 修状态机
- 修 prompt
- 修 JSON 提取
- 修进程生命周期
- 修经验传递

3. 原始材料必须保持完整
- 每次重跑真实任务前，先清 `runtime-state`
- `expert-workspace` 必须从 `seed-expert-workspace` 恢复
- `workspace / outputs / deployment/work` 应清空重建

4. 文档处理必须 headless-only
- 禁止打开 Word / Excel GUI
- 禁止 `Start-Process`
- 禁止 `Invoke-Item`
- 禁止 `explorer.exe`
- 禁止任何文件关联方式拉起桌面程序

## 4. 当前长程架构

### A. pending expert package

路径形式：
- `runtime-state/long-task-campaigns/<campaign>/pending-expert-package/current`

作用：
- 当前“待转正”的正式专家经验包
- blank agent 最终应该只读它
- 下一轮 planner 也读取它

### B. exploration tree

当前规则：
- 只保留 **一份 JSON 真源**
- 文件名：`exploration-tree.json`
- 不再把 Markdown 树当作真源传递

### C. campaign working memory

文件：
- `campaign-working-memory.json`

作用：
- 保存压缩后的工作记忆
- 给 campaign / 后续轮次使用
- 不是原始大仓库

### D. routing control

文件：
- `routing-control.json`

作用：
- 给下一轮建图提供直接控制信号
- 它应决定下一轮往哪里走、避开哪里

## 5. 最近已经修过的重要问题

### 5.1 结构化 JSON 输出提取更鲁棒

问题：
- LLM 常在 JSON 前后加文字
- 以前容易被判 `invalid_execution_output`

现状：
- 现在能从大段文本、fenced code block、多对象混合文本里提取目标 JSON
- 对字段别名做了兼容

相关代码：
- `orchestrator/long-task/json-extract.ts`
- `orchestrator/long-task/runner.ts`
- `orchestrator/long-task/validators.ts`

### 5.2 round 结束后统一清理旧进程

问题：
- 旧 unit / blank-agent / worker / reviewer 可能残留到下一轮
- 会造成资源竞争和监控混乱

现状：
- 每轮使用自己的 `runtimeScope`
- 在 round `finally` 里统一清理旧进程
- 重点：**必须是 round 结束后清，不要提前清**

相关代码：
- `orchestrator/runtime-process-registry.ts`
- `orchestrator/opencode.ts`
- `orchestrator/long-task/validators.ts`
- `orchestrator/long-task/runner.ts`
- `orchestrator/long-task-campaign/runner.ts`

### 5.3 状态机从“假 running”改成“先 bootstrapping，确认 spawn 后再 running”

问题：
- 以前 campaign / run 还没真正起线程，就先写 `running`
- 前端会看到假活跃状态

现状：
- campaign 和 long-task 先写 `bootstrapping`
- 只有真实子线程 `spawn` 成功后才切 `running`

相关代码：
- `orchestrator/opencode.ts`
- `orchestrator/long-task/contract.ts`
- `orchestrator/long-task/runner.ts`
- `orchestrator/long-task/validators.ts`
- `orchestrator/long-task-campaign/contract.ts`
- `orchestrator/long-task-campaign/runner.ts`

### 5.4 activeUnitID 不再提前切换

问题：
- 以前会出现：
  - `progress_state.json` 已显示切到下一个 unit
  - 但这个 unit 还没真正启动
  - 目录里只有 `retry_input_bundle.json`
  - 没有 `execute/response.txt`

现状：
- 现在只有在真实子线程 spawn 后，才会：
  - 切 `activeUnitID`
  - 切 `activeAttempt`
  - 递增 `totalUnitAttempts`
  - 写运行中的 `progress_state`

关键文件：
- `orchestrator/long-task/runner.ts`

## 6. 仍需注意的已知问题

### 6.1 monitor-server 可能因 Bun 自身问题崩溃

这不一定意味着真实任务也崩了。

所以：
- monitor 崩了 ≠ campaign 崩了
- 要分别检查真实 `run-long-task-campaign` 和 live unit 进程

### 6.2 campaign-lead 的 exitCode 可能不稳定

有过这种情况：
- `campaign-lead/run.json` 里 `exitCode = 255`
- 但实际上已经产出了 `response.txt`
- 也已经成功写出 package/tree/routing-control

因此：
- 不要只看 `exitCode`
- 要结合实际产物判断

### 6.3 如果只有状态文件是 running，但没有真实进程，那就是 stale

判定标准：
- 有 `campaign.json = running`
- 有 `progress_state.json = running`
- 但没有真实的：
  - `run-long-task-campaign`
  - 当前 `Long Task Execute ...`
  - 或其它对应子线程

这种情况应认定为：
- 假活跃 / stale running

## 7. 重跑 try4 前的标准清理流程

1. 先停旧的
- 停旧 campaign
- 停旧 unit
- 停旧 blank-agent
- 停旧 worker / reviewer / lead

2. 清 runtime-state
- 删 `runtime-state/long-task-campaigns/*try4*`
- 删 `runtime-state/long-task/runs/*try4*`
- 删 `runtime-state/acceptance-framework/deployment-runs/*try4*`
- 也清掉 `campaign-pending-smoke` 相关目录

3. 恢复 live workspace
- 删 `expert-workspace`
- 从 `seed-expert-workspace` 重新复制
- 清空 `workspace`
- 清空 `outputs`
- 清空 `deployment/work`

4. 确认原始材料完整
- `materials/source.xlsx`
- `materials/report-reference.doc`
- `materials/explanation-reference.doc`
- `materials/report-template.docx`
- `materials/explanation-template.docx`

5. 从 `round-001` 重新启动真实任务

## 8. 本项目里“持续监控”的含义

“持续监控”不是口头承诺，而是：

- 当真实任务仍在正常推进
- 必须在命令行里 **独立执行**
  - `Start-Sleep -Seconds 300`
  - 或更长 / 更短，但不少于 5 分钟
- sleep 不能嵌进别的脚本里假装监控
- sleep 结束后必须回查：
  - `campaign.json`
  - `progress_state.json`
  - 真实进程
  - 当前 active unit 是否真的已有 `execute/` 产物

## 9. 如何判断这轮是真跑还是假跑

真跑：
- 有 `run-long-task-campaign`
- 有当前 active unit 的真实子进程
- active unit 目录里能看到：
  - `execute/response.txt`
  - `execute/events.json`
  - `execute/run.json`

假跑 / stale：
- 只有 `campaign.json = running`
- 只有 `progress_state.json = running`
- 没有真实进程
- 或 active unit 只有 `retry_input_bundle.json`，没有 `execute/`

## 10. 给接手 AI 的建议

如果接手时遇到问题，优先检查：

1. 先看真实进程，不要先相信前端卡片
2. 再看 `campaign.json`
3. 再看 `progress_state.json`
4. 再看 active unit 目录里有没有 `execute/`
5. 再看 stdout/stderr 日志

优先修：
- 状态机
- 进程生命周期
- round 切换
- JSON 输出鲁棒性
- working memory / routing control / tree 的质量

不要优先做：
- 手工补真实任务结果
- 手工补最终 Word
- 直接改材料或专家参考件

## 11. 深读代码后的补充信息

### 11.1 运行上下文约束

- `auto-evolve` 这套 CLI 和大部分路径解析，默认假设 **cwd 是包含 `auto-evolve/` 的仓库根目录**
- 关键原因：`orchestrator/fs.ts` 里的 `autoEvolvePath(cwd, ...)` 会拼成 `cwd/auto-evolve/...`
- 所以日常应优先从仓库根运行：
  - `bun run auto-evolve/cli.ts ...`
  - 或根 `package.json` 里的 `auto-evolve:*` 脚本
- 如果直接在 `.../auto-evolve` 子目录里运行很多命令，路径会被解析成 `.../auto-evolve/auto-evolve/...`

### 11.2 当前 campaign 真正依赖的控制面

- 当前 round 生成时，真实会被下一轮读取的核心控制面是：
  - `pending-expert-package/current`
  - `exploration-tree.json`
  - `campaign-working-memory.json`
  - `routing-control.json`
- `campaign-lead` 的职责不是只给建议，而是实际写下一轮的：
  - pending package
  - exploration tree draft
  - routing control draft
- `reviewer` 是在 promote 之后才运行的“是否可以进 final acceptance”判断层
- final acceptance 只会在 reviewer 明确给出 `readyForFinalAcceptance = true` 后触发

### 11.3 当前代码里已经能确认的缺口 / 风险

- `collectCarryoverContext()` 现在直接返回空数组
  - 这意味着 `campaign.json` / contract 里的 carryover 开关目前还没有真正接线
  - 当前跨轮传递主要还是依赖 current package/tree/working memory/routing control，而不是额外拼接的 carryover context 文件
- `monitor-server.ts` 当前只扫描：
  - `runtime-state/runs`
  - `runtime-state/propagation/workspaces`
  - 没有把 `runtime-state/long-task/*` 和 `runtime-state/long-task-campaigns/*` 作为 artifact 扫描根
  - 所以 long-task / campaign 的监控更依赖 live session；排障时仍要直接看运行目录
- long-task 在 `restricted` 权限模式下有潜在缺口：
  - 执行阶段的 `permissionEditPaths` 目前只取 `editablePaths`
  - `targetPaths` 虽然会在 fresh run 阶段被当作可变目标归档/清空，但不会自动加入执行期 edit permission
  - 当前默认 `permission-config.json = open`，所以平时不一定暴露；一旦切到 restricted，要优先检查这里
- 已完成 run 的幂等性还不够稳：
  - `continueLongTaskLoop()` 在读到终态时仍会再次走 `finalizeLongTaskRun()`
  - 这会再次追加 archive / shadow memory / candidate / maintenance request
  - 所以不要反复 `resume-long-task` 一个已经结束的 run，除非先确认去重逻辑已补齐

### 11.4 工程化现状

- `auto-evolve` 子树目前没有成体系的单元测试 / 集成测试文件
- 现在更像是“验证驱动”而不是“测试驱动”：
  - `cli.ts validate`
  - long-task validators
  - acceptance framework
  - blank-agent deployment acceptance
- 改 orchestrator 时，默认要把“状态机 + 进程生命周期 + validator 真实产物”当成第一验证面，而不是只看 TypeScript 能不能编译

## 12. 新增并发回归脚本（2026-05-22）

- 脚本路径：
  - `C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\scripts\smoke-concurrency-regression.ts`
- 作用：
  - 小型并发回归检查，覆盖以下三个关键点：
    - 进程注册表并发注册/清理是否正常，防止遗漏子进程记录
    - `healStaleRuntimeStates` 的状态写入重试接线是否存在（`retryWriteJson`）
    - multi-instance merger 的长文本截断阈值与截断警告是否存在
- 运行命令（在 `auto-evolve` 目录）：
  - `bun run scripts/smoke-concurrency-regression.ts`
- 通过标志：
  - 输出 `smoke-concurrency-regression: PASS`

## 13. OpenCode 基础设施故障备忘（2026-05-22）

- 现象：
  - long-task/campaign 在 `inspect-shared-materials` 首单元卡住，`run.json` 停留 `status=running`，`updatedAt` 只更新 1 秒左右。
  - `events.json` 为 `[]`，`response.txt` 为 1 字节或为空，几乎没有真实会话输出。
- 核心根因（已验证）：
  - 当前本地仓库 `packages/opencode` 在源码运行路径下无法稳定启动：
    - `bun run src/index.ts ...` 报 `TypeError: The superclass is not a constructor`（minipass-pipeline 链路）。
    - `bun packages/opencode/bin/opencode --version` 报缺少平台二进制包（`opencode-windows-x64`）。
  - 即：不是 campaign 业务逻辑本身，而是 OpenCode 基础设施可执行链路已损坏。
- 诊断结论：
  - 本机存在“全局安装 opencode”和“本地仓库源码 opencode”两套链路，不能混用。
  - 当前阶段必须先修复本地仓库这套 opencode 启动能力，再继续 long-task。

## 14. audit-point-learnbench 长期项目记忆（2026-05-24）

### 14.1 当前核心目标

当前重点实验是 `audit-point-learnbench`。
目标不是一次生成完整审计报告，而是把一份大型审计/评估材料拆成多条“单点人类审核意见”学习任务。
每个训练实例只学习一条人类审核意见，产出：
- 一个该审计点对应的局部 skill / expert-workspace
- 一个 `workspace/audit-point-output.md`，内容必须是 exactly one audit opinion item

最终目标是：
1. 所有训练实例分别学到通过验收
2. 合并所有成功实例的 skill
3. 用合并 skill 回测训练集
4. 训练集全过后再测测试集
5. 测试集不过则回到合并经验修正，而不是直接结束

### 14.2 泛化能力主要看合并后

训练阶段主要是积累局部成功经验，不要把单点任务成功误报成系统已经泛化成功。
系统泛化主要在合并之后验证：
- 合并 skill 是否保留共性规则
- 回测训练集是否全过
- 测试集是否能过
- 失败样本是否能被转化为“特殊案例规则”而不是硬背答案

合并包应分两部分：
- 通用规则：跨任务抽象出来的方法
- 特殊案例规则：训练回测失败时保留的场景化细节、证据定位模式和易错点

特殊案例规则不应写成“题号答案”，而应写成可迁移的场景规则。

### 14.3 当前训练调度方式

`audit-point-learnbench` 已从固定 `4x5` 分轮模式改为全局队列模式。
脚本：
- `C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\scripts\run-audit-point-batches.ts`

当前行为：
- 默认最多同时跑 5 个训练 campaign
- 已经 `verified_success` 的任务不重跑
- `running / bootstrapping / recovery_pending` 的任务走 `resume-long-task-campaign`
- 队列有空位就补下一个未完成任务
- 不再等待一整轮全部结束才开下一轮

环境变量：
- `AUDIT_POINT_QUEUE_CONCURRENCY=5` 可调整总并发
- `AUDIT_POINT_QUEUE_DRY_RUN=1` 只生成计划，不启动训练

### 14.4 合并门槛

合并必须严格等待所有训练实例成功。
当前训练集共 20 条：
- `audit-point-001` 到 `audit-point-020`

合并前必须满足：
- 每个任务 ID 都有且只有一个被选中的成功 campaign
- campaign 状态必须是 `verified_success`
- 必须存在 `pending-expert-package/current`
- 旧失败、旧中断、被重新拉起替代的 campaign 一律不能进入合并

典型例子：
- 旧失败 `audit-point-004` 因 `EPERM active-processes.json rename` 崩溃，不能进入合并
- 新的 `audit-point-004` 续跑成功后，才可以作为 `004` 的唯一合并输入

如果不是 `20/20` 成功，脚本应跳过合并并写 `merge-skipped.json`，不能用部分训练集强行合并。

### 14.5 当前已知成功/未完成情况

最近一次队列启动前，系统识别到：
- 已成功：`001, 002, 003, 006, 007, 008`
- 待继续：`004, 005, 009-020`

这只是当时状态，后续要以 `runtime-state` 最新状态为准。

### 14.6 软验证设计

当前软验证是 `prompt_json`，但核心结果以文件为准。
软验证读取：
- `validator_input.json`

软验证必须写：
- `result.json`

验证重点：
- `same_issue`
- `specific_evidence`
- `actionable`

判定规则：
- 只有 `same_issue=true`
- 且 `specific_evidence=true`
- 且 `actionable=true`
- 才允许 `passed=true`

人类指导文件 `human-guidance.md` 是背景约束，不是验证器主要任务。验证器主要任务是判断候选审计意见是否匹配隐藏专家答案。
失败分类建议使用：
- `missing_candidate`
- `issue_mismatch`
- `evidence_missing`
- `not_actionable`
- `infra_error`
- `schema_invalid`
- `candidate_missing`
- `candidate_format_invalid`
- `score_below_threshold`

### 14.7 训练失败常见类型

当前常见失败不是系统全崩，而是最终验收不过。
`004` 类问题：
- 候选输出可能是模板占位内容
- 或 `surface_contract.json` 引用了不存在的 `audit-point-output.md`
- 重点查是否真的生成了 `workspace/audit-point-output.md`
- 重点查它是否是有效的一条审计意见
- 重点查 `surface_contract.json` 里的路径是否和真实文件一致

`005` 类问题：
- 主要是 `same_issue=false`
- 曾经把专家答案要点“设备综合评价净残值/成新率 90 vs 93 差异”学偏成别的问题类型
- 重点查 skill 的 PRIMARY finding type 是否和专家答案一致
- 重点查重新部署 skill 后是否真的重新生成了 `audit-point-output.md`

### 14.8 Windows 文件锁风险

Windows 中 `.runtime/active-processes.json` 仍可能出现 `EPERM rename` 文件锁竞争。
现象：
- campaign 启动即失败
- `lastSummary` 出现 `EPERM: operation not permitted, rename active-processes.json.tmp -> active-processes.json`
- `.runtime` 下面残留 `active-processes.json.tmp-*`

这类问题是基础设施文件锁竞争，不是任务内容失败。
短期处理：
- 失败 campaign 不进入合并
- 重新拉起同一任务的新 campaign
- 合并按任务 ID 只取成功版本

长期建议：
- 将进程注册表从单 JSON 覆写改为 append-only JSONL
- 或将运行态迁移到 SQLite/WAL

### 14.9 当前运行和排障路径

常用位置：
- 项目根：`C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve`
- 训练任务包：`task-packs/real-long-tasks/audit-point-learnbench`
- campaign 状态：`runtime-state/long-task-campaigns`
- batch 状态：`runtime-state/audit-point-batches`
- 日志：`C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\runtime-logs`

判断真实状态时，不要只看前端或表格，要看：
1. `campaign.json`
2. `round-summary.md`
3. final-acceptance 的 `result.json`
4. 是否有真实 `bun run cli.ts run-long-task-campaign` 进程
5. `pending-expert-package/current` 是否存在

### 14.10 当前最近启动的队列

最近一次启动：
- 队列目录：`runtime-state/audit-point-batches/20260524-011119742`
- 运行模式：全局队列，最大 5 个并发
- 启动日志：
  - `runtime-logs/audit-point-queue-20260524-011119.out.log`
  - `runtime-logs/audit-point-queue-20260524-011119.err.log`

该运行不要求持续监控，但后续检查时优先看这个队列目录。

### 14.11 audit-point 当前流程纪律

- 测试集当前只做 `targeted-blind`，暂缓 `open-discovery`。
- `targeted-blind` 的含义是：给 merged skill、全量材料、一般审核方向/focus；不给 hidden answer、人类答案原句、Generalizable Rule 原句。
- 测试集只验收空白 agent 是否能写出 `workspace/audit-point-output.md` 这一条审核意见。
- 测试集不得要求产出 skill 包，不得要求 `manifest.md/change_log.md/surface_contract.json`，不得跑 `workspace-layout` 或 surface generalization。
- 测试集失败只记录为泛化失败，不现场修 skill，不自动进入 append-only repair。
- 合并后训练回测才允许开启 append-only repair gate；repair 只能单增 merged skill 内容，不能删除或重写旧内容。
- 训练回测必须在全部训练 case 成功且完成 merge 后进行；训练回测不过，不进入测试集。

### 14.12 通用任务包批跑脚本

现在新增了一个通用外层编排脚本：

- `auto-evolve/scripts/run-benchmark-orchestrator.ts`

它是“任务包级 orchestrator”，不是新的 campaign 内核。它只负责：

- 读取某个 `task-packs/real-long-tasks/<pack>` 下的 `splits`
- 并发启动或续跑多个 `tasks/<id>/campaign.json`
- 统计哪些 training case 已经 `verified_success`
- 达标后进入 merge
- 再按需要进入训练回测、测试集、baseline

必须记住：

- 它不能替代每轮 round 内部的 blank agent 验收
- 它不能自己发明新的成功判据
- 它只能信现有 campaign 产出的 `campaign.json`、`pending-expert-package/current`、final acceptance 结果

这个脚本现在支持停在任意阶段：

- `--mode campaign-only`
- `--stop-after training`
- `--stop-after merge`
- `--stop-after train-replay`
- `--stop-after test`
- `--stop-after baseline`

也支持单独关步骤：

- `--skip-merge`
- `--skip-train-replay`
- `--skip-test`
- `--skip-baseline`

旧脚本 `auto-evolve/scripts/run-officeqa-pro-benchmark.ts` 现在只是这个通用脚本的兼容包装。以后如果是同结构任务包，优先接这个通用 orchestrator，不要再复制一份新的专用批跑脚本。
