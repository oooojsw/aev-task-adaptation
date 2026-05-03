# auto-evolve 子项目说明（给接手本目录的 AI）

这份文件只描述 `auto-evolve` 子项目的当前真实情况。根目录的 `AGENTS.md` 仍然是全仓级规则，这里主要补充：

- 当前长程/短程运行机制
- `try4-expert-bootstrap` 的真实目标
- 最近已经修过的 bug
- 当前排障和重跑时的标准做法

3---- 当我说准确名词“持续监控”这个词的时候，意思是：在你检测到这个现在正在处理的任务或者命令需要长时间运行的时候（持续在跑而不是卡死了），你必须先在此电脑的全局配置文件修改区（"C:\Users\ZhuanZ\.codex\AGENTS.md"）里面，写好我给你的运行时间，次数，当前次数（运行完每一次之后，自动的改当前次数，当运行完所有的次数之后，结束持续监控任务，然后吧这三个运行时间，次数，当前次数清零），然后的自动运行sleep 一小时这个命令（例如$ Start-Sleep -Seconds 3600，或者半小时，二十分钟，十分做，五分钟，最短五分钟，选择时间的时候你自己决定时长），不对任何人或者任何任务或者任何的脚本，就是直接在命令行里面运行！！！然后这个命令运行完直接回去检查这个任务的情况，不准套到任何其他命令嵌套，不准和任何脚本本身勾稽，就是单纯的在命令行运行这个命令！！！！


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
