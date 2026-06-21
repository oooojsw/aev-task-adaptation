# auto-evolve 子项目说明（给接手本目录的 AI）

## 0. Auto-Evolve 正式开发主链（最高优先级）

- **云端正式主链（私有仓库）**：`https://github.com/oooojsw/auto-evolve-mainline`
- **本机主链仓库**：`C:/Users/ZhuanZ/Desktop/opencode re/auto-evolve-mainline`
- **实际运行宿主**：`C:/Users/ZhuanZ/Desktop/opencode re/opencode latest/auto-evolve`
- **正式分支**：`main`

以后 Auto-Evolve 的长期开发历史以 `auto-evolve-mainline/main` 为准。OpenCode 大仓中的 `auto-evolve/` 仍是当前实际运行位置，因为它依赖 OpenCode 宿主的 Bun、Node 依赖和本地源码；但它不再承担干净云端主链的职责。

修改核心流程时必须遵守：

1. 开始前读取本文件、`README.md` 和主链仓库的 `MAINLINE.md`，确认当前主链状态。
2. 可以在 OpenCode 宿主目录内开发和真实烟测，但验证通过后，必须把源码、配置模板、提示词、验证器、烟测和架构文档同步到本机主链仓库，形成清晰 commit，并推送 `origin/main`。
3. 禁止再把整个 `opencode latest` 大仓当作 Auto-Evolve 主链推送；它混有 OpenCode 上游历史和本机运行数据，会产生数 GB Git 包。
4. 主链禁止提交 `runtime-state`、runtime logs、benchmark 原始材料、PDF/视频/Office 数据、private answers、标准答案、真实任务 workspace/outputs、Cookie、API Key、认证文件、模型缓存和 Agent 生成产物。
5. 新增数据集时，主链只保存适配器、spec 模板、验证脚本、提示词和不含真实答案的小型测试夹具；完整数据集继续放本机或独立数据盘。
6. 主链是从原大仓按 `auto-evolve/` 路径抽取并清理后的历史，因此 commit hash 与原大仓不同是正常现象；不要按 hash 强行对齐，按文件内容和提交说明同步。
7. 推送后必须用 `git ls-remote origin refs/heads/main` 核对远端 commit 与本地 `main` 一致，并确认主链工作区干净。

全局有多个角色，他们都是工作节点，只有空白agent节点无法看到答案任何相关内容，其他的任何节点都可以完全或者部分看到答案内容，因为专家经验区就是他们在写，只有空白agent是完全利用专家经验区进行任务，以此来考验专家经验区写的是不是没有过拟合以及泛化，整个系统的目的是产出一份泛化的（不过拟合任何案例）、完备的（可以让空白agent通过大量测试集）的专家经验区（skill）。

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

这是一份关于本项目最新架构（截至 2026.06,07）的任务与项目说明文档。文档详细梳理了当前的核心代码结构、重点真实任务、系统设计红线以及关键架构机制。

---
以下为你重新编写的**完整版系统规范与架构技术白皮书**。内容严格保留了原版 14 个核心章节的完整脉络与详尽程度，将所有条款升级为对应当前最新代码库（包含 `opencode-gate.ts` Concurrency 锁、`blank-eval` 隔离运行、SpreadsheetBench 新验证器等）的最新设计，并且**去除了所有涉及人称代词、指导语气、上一任交接的措辞，转为纯粹客观、结构化的系统技术 spec 文档**。

---

# Auto-Evolve 自动化经验演进系统技术规范与架构白皮书

## 1. 代码位置与拓扑关系

本自动化演进系统部署于统一的工程拓扑结构中。

### 1.1 仓库根目录级拓扑 (`C:\Users\ZhuanZ\Desktop\opencode re\opencode latest`)
- `.github`：持续集成与仓库协作策略配置。
- `.opencode`：运行期全局偏好设置。
- `auto-evolve`：自动化演进系统的核心代码子项目。
- `node_modules` / `packages`：依赖包与工作区内联模块（包含本地维护的 `opencode` 源码包）。
- `patches`：针对上游依赖的本地修补补丁（Patch-package 存储区）。
- `progress-plan`：系统设计白皮书与阶段性架构演进备忘。
- `runtime-logs`：集中存放外部执行器、后台队列监视器以及并发锁的运行期 stdout/stderr 日志。

### 1.2 系统子项目级拓扑 (`auto-evolve/`)
- `.runtime`：子项目私有运行时。存放跨进程全局锁 `opencode-gate` 的物理锁目录（`lock/`）和状态描述文件（`state.json`）。
- `dataset`：包含基准测试的输入定义与样本拆分清单。
  - `cases/`：结构化短程测试用例。
  - `SPLIT.md`：训练集与测试集的静态划分真源。
- `experience`：
  - `workspace/`：活跃的规范专家经验目录，即控制面读取与维护的物理目标。
  - `archive/`：历史经验版本库，保留归档索引 `index.json`，支持一键式冷归档与回滚。
  - `templates/`：经验模块参考模板库，严禁被主流程直接挂载。
- `judge-skills`：软研判（Soft Judge）执行期按需加载的地方性判定技能包。
- `methods/recipes`：第二层反向传播（Reverse Propagation）的配方与算子流定义。
- `orchestrator`：核心状态机与控制面调度代码。
  - `long-task/`：长程任务图（Work Graph）生成与单兵执行内核。
  - `long-task-campaign/`：跨轮次战役控制器、工作记忆合成器、路由调节器。
  - `multi-instance/`：多实例 Fan-out 并发与 Fan-in 合并校验引擎。
  - `blank-eval/`：空白隔离环境下的独立评估沙盒。
  - `global-optimization/`：第四层（Layer 4）全局优化策略。
- `prompts`：集中管理系统核心 Prompt 模板（如 `knowledge-maintainer-core.md`、`soft-judge-core.md`）。
- `runtime-state`：运行态物理沙盒。包含 `runs/` (短程运行态)、`long-task/runs/` (长程独立运行态)、`long-task-campaigns/` (战役历史快照)、`multi-instance-runs/` (多实例编排状态) 以及 `acceptance-framework/` (全局验收凭证存储库)。

---

## 2. 当前活跃的核心长程基准测试任务

系统当前主要攻坚三个高复杂度的长程基准测试，这些任务要求执行 Agent 在无外部干预的情况下，通过阅读规范经验完成复杂交付：

### 2.1 `audit-point-learnbench` (审计意见点生成)
- **输入物料**：评估报告定稿、评估电子底稿（多 Sheet 表格与公式）。
- **任务目标**：针对具体的审计风险点（如“P26 房屋耐用年限与土地剩余年限不匹配”、“建筑重置价 PPI 换算错误”），生成 exactly one 结构化的审计意见项。
- **校验标准**：输出格式必须精确为单项 Markdown 格式，通过软验证器比对隐藏答案在“问题、证据、行动性”三个维度的符合度。

### 2.2 `officeqa-pro-learnbench` (研报定量推理)
- **输入物料**：数份 Treasury Bulletin PDF 原始报表。
- **任务目标**：针对特定年份或季度的复杂财务问题，进行多页检索、数据提取与勾稽计算。
- **校验标准**：严格输出单值答案至 `workspace/answer.json`，由外部验证器执行高精度的数学容差比对（Tolerance: 0.01）。

### 2.3 `spreadsheetbench-learnbench` (Excel 矩阵变换 - 最新)
- **输入物料**：包含复杂计算公式的 Excel 工作薄。
- **任务目标**：根据指令定位目标 Sheet 与单元格区间，执行自动化数据清洗，并生成精确的行列矩阵。
- **校验标准**：输出格式要求为严格的矩阵 JSON 格式。验证器将对输出范围、Sheet 名称和数值单元格执行全量校验。

---

## 3. 运行红线与系统开发原则

### 3.1 绝对禁止人工干预输出结果
- 严禁人工修改基准测试目录下的 `workspace/` 或 `expert-workspace/` 来伪造成功。
- 严禁在专家经验模块中写入针对特定题目的硬编码数值或答案原句。

### 3.2 严格实行平台与内容剥离原则
- 所有的优化、重试和纠偏工作，必须通过修改系统平台层（编排器、调度状态机、Prompt 模板、并发机制、JSON 提取、进程控制等）实现。
- 严禁针对单个测试用例编写特异性写死逻辑。

### 3.3 原始物料完整性
- 每次重新启动运行或战役前，必须对运行环境进行初始化清理。
- 重置后的演进工作区（`expert-workspace`）必须确保与指定的种子（`seed-expert-workspace`）完全一致，防止历史运行的经验残留造成交叉污染。

### 3.4 Headless-only 约束
- 本地执行环境严禁通过任何方式拉起微软 Word、Excel、Acrobat Reader 或其他图形化桌面应用程序。所有文件（特别是 `.docx`, `.xlsx`, `.pdf`）的解析、计算与修改，必须完全通过 headless-only 脚本（如 Python 科学计算库或 OpenXML 库）在内存中闭环执行。

### 5.5 路径反斜杠规避
- 在任何系统级配置文件（如 `surface_contract.json`）中写入路径时，必须将所有反斜杠 `\` 统一转换为正斜杠 `/`，以规避多层嵌套调用时发生的转义字符丢失。

---

## 4. 战役控制面核心架构

长程自动化战役通过四大核心控制面文件在轮次之间传递高价值信息，确保经验迭代不出现发散或退化：

```
+-----------------------------------------------------------------------------------+
|                                 LONG-TASK CAMPAIGN                                |
|                                                                                   |
|  +--------------------+   +-----------------------+   +------------------------+  |
|  |   Pending Package  |   |   Exploration Tree    |   |    Routing Control     |  |
|  |  (Markdown Skill)  |   | (exploration-tree.json)|   | (routing-control.json) |  |
|  +---------+----------+   +-----------+-----------+   +-----------+------------+  |
|            |                          |                           |               |
|            +--------------------------+---------------------------+               |
|                                       |                                           |
|                                       v                                           |
|                           +-----------------------+                               |
|                           |   Campaign Lead AI    |                               |
|                           +-----------------------+                               |
+-----------------------------------------------------------------------------------+
```

### A. Pending Expert Package
- **物理路径**：`runtime-state/long-task-campaigns/<campaign>/pending-expert-package/current`
- **定位**：当前迭代生成的专家经验包，是 Blank Agent 最终部署时唯一能读取的知识平面。它在生成时必须通过 layout 验证。

### B. Exploration Tree
- **真源定义**：系统严格使用单 JSON 文件作为探索树的真源：`exploration-tree.json`。废弃过去的 Markdown 格式树，避免多进程读写时的格式丢失。
- **作用**：记录已探索节点的状态（`validated_success`, `strong_fail`, `unexplored` 等）和尝试频次，为下一轮的 Planner 提供底层图规划的客观数据。

### C. Campaign Working Memory
- **文件**：`campaign-working-memory.json`
- **定位**：对各运行单元产出的局部 `learning_units` 和 `failure_packets` 进行高度压缩和高信度提炼后形成的“高维记忆体”，用于辅助战役 Lead 总结跨轮次规律。

### D. Routing Control
- **文件**：`routing-control.json`
- **定位**：系统为下一轮建图提供的硬性路由控制。例如：强制执行特定修复区域（`requiredNextRegions`）或将已耗尽的单元加入禁区（`forbiddenRegions`），使重新建图（Replan）具备明确的方向性。

---

## 4.5 验证器分类共识

系统内所有验证器都必须先按两个维度归类：

- **按对象分**：
  - `Surface Validator`：验证专家经验区 / skill / pending expert package，目标是防作弊、防答案泄露、防结构混乱。
  - `Product Validator`：验证 `workspace/` 下的真实产物，目标是确认空白 Agent 或执行 Agent 产出的答案、文件、报告是否正确。
- **按机制分**：
  - `Hard Check`：脚本级确定性检查，适合数字容差、格式、文件存在、正则、防泄露、答案比对。
  - `Soft Check`：模型裁判按 rubric 审阅，适合文本质量、业务合理性、审计意见行动性等主观判断。

生命周期上也必须分清：

- `Local Validation` 是长程任务内部的开卷学习，允许用于发现路径和提炼失败教训。
- `Blank Eval Final Acceptance` 是单题闭卷证明，必须让空白 Agent 只看专家经验和原始材料，再由 Product Validator 验产物。
- `Post-Merge Validation` 是合并后的全域验证，包括训练集回测防退化和测试集盲测测泛化。

核心原则：**Local 是为了学习，Blank Eval 才是证明；Surface 是查专家经验有没有小抄，Product 是改最终产物这张试卷。**

### 4.6 Validation Engine 与结果路由

新增 `orchestrator/validation-engine/` 作为验证执行与结果路由底座。它不是 blank agent，也不是 acceptance-framework：

- `validation-engine` 负责执行验证器，并生成 `private/training/sanitized/score_only` 四种结果视图。
- `blank-eval` 负责启动闭卷空白 Agent。空白 Agent 不允许调用验证器，也不允许读取任何验证结果视图。
- `acceptance-framework` 负责记录验收政策和判决书，不直接承担通用验证执行。

旧入口 `runLongTaskValidator()` 已接到 validation-engine 的 long-task adapter，外部调用签名保持不变。后续新增布局验证、防泄漏验证、软验证、合并后验证、回撤验证、测试集验证时，应优先通过 validation-engine 加载模块，而不是在业务 runner 里继续散写执行逻辑。

验证模块必须可拔插。不同数据集/项目可以通过 `task-packs/validator-profiles/*.json` 挂载不同的 layout、surface、product、soft、rollback、regression 验证器。profile 内的 validator 可声明 `validation.target`、`validation.stage`、`validation.answerAccess`、`validation.allowedAudiences` 等元数据，业务层再按 stage/target 选择模块。不得把 OfficeQA 或任何单一数据集的文件布局硬编码成平台默认硬门。

阶段级入口为 `runValidationStage()`：

- Campaign final acceptance 的 Blank Agent 前验证使用 `pre_blank` stage，主要承载 surface/layout/behavior 类验证。
- Blank Eval 结束后的产物验证使用 `post_blank` stage，主要承载 product/behavior/regression 类验证。
- 每个 stage 会写 `stage-result.json`，汇总 validator result 以及 training/sanitized/score_only 视图路径。后续给 lead/worker/reviewer 的反馈应优先使用 training view，给 dashboard/carryover/memory 的反馈应优先使用 sanitized view。

结果流向红线：

- `private` 视图只给系统审计和必要 debug。
- `training` 视图可给 executor / worker / lead / reviewer / merger / repair agent，用于开卷学习和修经验。
- `sanitized` 视图可给 dashboard、carryover、长期记忆。
- `score_only` 视图可给测试集统计。
- `blank_agent` 对所有验证结果视图都没有读取权限。

---

## 5. 历史技术攻坚与已验证的机制

以下为系统中已稳定实现的工程级改进，后续修改必须在此基础上进行：

### 5.1 全局并发锁机制 (`opencode-gate.ts`)
- **实现方案**：在子项目物理运行时 `.runtime/opencode-gate` 下建立基于目录创建（`mkdir`）的排他性排队锁。
- **并发策略**：
  - 支持设置全局最大并发（`maxConcurrent`）和单个 Task-family 并发上限（`perScopeMaxConcurrent`）。
  - 支持 FIFO 队列排序与 Stale 锁强行释放（基于 PID 存活检查与心跳文件检测，防止单次超时阻塞整条队列）。
  - 所有 OpenCode 任务调用强制在 `gate.run()` 闭环内执行。

### 5.2 结构化输出容错器 (`json-extract.ts`)
- **实现方案**：内置多层级 JSON 提取器。当 LLM 输出非纯净 JSON（带 Fenced code block、前缀叙述语、或多余字元）时，系统自动执行平衡大括号匹配算法，定位首个闭合的 JSON 对象并进行结构化转译。
- **转义修复**：支持对 Windows 路径中的 `\n`, `\t` 进行二次清洗，杜绝因基础格式报错导致的 `schema_invalid` 任务终结。

### 5.3 运行时进程精准清理机制 (`runtime-process-registry.ts`)
- **实现方案**：系统在每次启动 OpenCode 任务、运行验证器或起草图规划时，会通过 `registerRuntimeProcess` 在私有注册表记录子进程 PID 及其 Windows 启动 tick 时间戳。
- **清理逻辑**：在单次用例（Case Attempt）或一轮战役结束的 `finally` 阶段，主动触发 `cleanupRuntimeProcessScope`，通过 Windows 的 `taskkill /PID <pid> /T /F` （或类 Unix 的 `SIGKILL`）强行阻断整个衍生进程树，从物理上杜绝运行环境与文件读写冲突。

### 5.4 动态进度标记与延迟写状态
- **实现方案**：修复了过去在 Campaign 运行中过早写入 `running` 和切换 `activeUnitID` 的设计缺陷。现在系统在 Bootstrap 或 Replan 期间将进度置为 `bootstrapping` 或 `planning`，只有在底层 OpenCode 子线程成功 Spawn 且接收到首个运行期事件后，才写入 `running` 状态并正式在 `progress_state.json` 中激活 `activeUnitID`，大幅减少由于启动失败导致的“幻觉活跃”。

---

## 6. 运行时已知不确定性与脆弱行为记录

系统运行在复杂的分布式/本地多进程状态下，需要时刻对以下非稳定性因素保持警惕：

### 6.1 Windows 文件重命名冲突 (EPERM / EBUSY)
- **原因**：PowerShell 的并发写入或某些杀毒软件在扫描 `.runtime/active-processes.json` 等高频修改的 JSON 时，会锁死该文件，导致 Bun 进程在进行 `rename(tmp, target)` 时抛出 `EPERM` 异常。
- **排查路径**：如果任务在启动瞬间报错，提示 `EPERM`，需首先检查文件锁释放状况，并清理 `.runtime` 下的 `.tmp-*` 遗留文件。

### 6.2 编排器 Lead 的退出码波动
- **现象**：由于某些底层终端控制符或输出流缓冲问题，`campaign-lead` 进程的 `exitCode` 有时会被操作系统记为 `255`。
- **判定标准**：不能仅根据 `exitCode !== 0` 判定失败。必须校验 `campaign-lead` 的运行成果——即目标 `rounds/round-NNN/` 目录下是否已成功输出 `exploration-tree.json` 和 `routing-control.json`，且格式可被 JSON 解析。

### 6.3 假死与虚假运行状态的判定
- **研报规范**：当 `campaign.json` 或 `progress_state.json` 处于 `running`，但系统中完全检索不到对应的 `bun run`、`python` 或 `Long Task Execute` 进程，且 `execute/response.txt` 超过 15 分钟无增量修改时，系统即处于 Stale 状态。在重新启动前，必须通过清理流程将其纠偏。

---

## 7. 基准测试完整重置与清理流程

在开发、调测或发生虚假死锁需要彻底重置系统状态时，必须严格执行以下标准清理流程（已封装至 `scripts/init-try4-clean-state.ps1`）：

```text
[1. 进程清理] 强行终止所有残留的 bun.exe, node.exe, powershell.exe 和 opencode-cli.exe
    |
[2. State 移除] 物理清理 runtime-state/long-task-campaigns/ 目录下包含当前任务关键字的子文件夹
    |
[3. 沙盒重置] 移除 task-packs/real-long-tasks/<task-name> 下的：
    |         - workspace/ (完全清空)
    |         - expert-workspace/ (物理删除)
    |         - deployment/work/ & deployment/outputs/ (完全清空)
    |
[4. 经验复原] 复制 seed-expert-workspace 至 expert-workspace 目录，作为零点快照
    |
[5. 经验索引核查] 打开 runtime-state/acceptance-framework/index.jsonl，
                  手工或通过脚本剔除包含当前用例 ID 的历史验收记录。
```

---

## 8. 本自动化系统中“持续监控”的工程定义

本系统中定义的“持续监控”是具有明确规范的工程机制，严禁进行任何形式的静默等待：

- **轮询控制**：必须独立运行监控脚本。设置不低于 180 秒（建议 300 秒）的 `Start-Sleep` 间隔。
- **断言回查**：每次 Sleep 唤醒后，必须执行物理文件扫描：
  - 检查目标 `campaign.json` 的 `updatedAt` 时间戳是否仍在推进。
  - 检查当前 active unit 的 `execute/events.json` 尺寸是否增长。
  - 确认主线程 PID 依然存在于操作系统的活动进程清单中。
- **防死锁**：若连续 3 次轮询（15分钟）未检测到任何指标变化，监控程序应抛出异常，并触发全局进程猎杀。

---

## 9. 运行时进程状态真伪研判标准

```
                       [Is Process PID Alive?]
                              /       \
                            YES        NO
                            /            \
               [Is Heartbeat Fresh?]    [STALE STATE]
                     /       \
                   YES        NO
                   /            \
            [TRUE RUNNING]     [STALE RUNNING]
```

- **TRUE RUNNING (真跑)**：
  - 进程表中存在真实的活动 PID，且其创建时间 tick 校验与注册表完全一致。
  - 活动单元的 `execute/response.txt` 或 `stdout.log` 存在实质的文件大小变动。
  - `progress_state.json` 处于 `running` 状态。
- **STALE RUNNING (假跑)**：
  - 文件系统中的 `campaign.json` 或 `progress_state.json` 指示 `running`。
  - 进程表中完全查询不到对应的 PID，或虽然 PID 存在，但其实际 CommandLine 已不包含该任务的任何上下文特征。
  - 发生此情况时，必须首先将 `status` 修正为 `recovery_pending`，通过 Stale Healing 机制进行抢救。

---

## 10. 系统后续迭代与全局优化方向

本架构在设计之初为后续的高级功能预留了接口，演进时需遵循以下方向：

### 10.1 第四层（Layer 4）全局优化接线
- **位置**：`orchestrator/global-optimization/`
- **目的**：通过 `experience-compression` 实现经验文件的精简和合并。减少冗余文字。
- **约束**：优化产生的 candidate 必须挂载到 `campaign-working-memory.json` 通道进行第三层盲测（Propagation），通过盲测后方可由事务门（Transaction Gate）合并至主干。

### 10.2 Concurrency 数据库化
- **方向**：目前并发注册表 `active-processes.json` 采用单 JSON 覆写，存在 Windows 文件锁瓶颈。未来需逐步重构为 Append-only JSONL 或嵌入式 SQLite 数据库（启用 WAL 模式）。

### 10.3 Prompt 文本内联优化
- **方向**：由于 Windows Command Length 限制，目前通过 `promptInlineFiles` 直接在 CLI 层面注入了大文本。后续演进应将其转化为本地 OpenCode 沙盒内部的文件系统挂载，减少主 CLI 的参数负荷。

---

## 11. 源码深度剖析与运行上下文约束

### 11.1 执行路径上下文约束 (CWD)
- **底层特性**：Orchestrator 内部的大量路径解析，强依赖于运行命令时的 `process.cwd()` 为包含 `auto-evolve/` 的仓库根目录。
- **异常风险**：若在终端中直接 `cd auto-evolve` 然后执行命令，会导致 `autoEvolvePath` 将路径错误地解析为 `.../auto-evolve/auto-evolve/...` 从而导致文件加载异常。在所有脚本编写中，必须确保 CWD 维持在仓库顶层。

### 11.2 空白评估 (Blank-Eval) 与权限限制模式 (Restricted Mode)
- **核心逻辑**：当系统的 `permission-config.json` 处于 `restricted` 时，OpenCode 任务的 `permissionEditPaths` 会严格收窄。
- **潜在缺口**：在 `restricted` 模式下，执行阶段如果漏掉将任务输出目标文件夹加入可写权限（`permissionEditPaths`），Agent 将在执行 `write` 时抛出物理权限拒绝。开发新的验证阶段时，必须优先排查该项。

### 11.3 事务写入幂等性保护
- **已知问题**：在 `continueLongTaskLoop` 状态机执行中，当检测到工作流到达终态后，会直接触发 `finalizeLongTaskRun` 进行落盘、归档并生成 Candidate 申请包。
- **开发约束**：目前该阶段的幂等（Idempotency）去重保护较为薄弱，重复执行 resume 可能会在 `index.jsonl` 中写入重复的归档记录。

---

## 12. 并发回归机制与验证

为防止底层多进程通信、文件锁、进程注册表逻辑在修改后发生退化，系统配备了全自动并发回归验证器：
- **测试脚本**：`auto-evolve/scripts/smoke-concurrency-regression.ts`
- **验证手段**：
  1. 并发拉起 4 个高延迟的后台休眠测试进程，高频写入注册表以检验文件锁在高竞争下的鲁棒性。
  2. 测试 `healStaleRuntimeStates` 对应的状态回滚重试链路（`retryWriteJson`）是否通畅。
  3. 通过 `cleanupRuntimeProcessScope` 验证是否能精准剔除该作用域（Scope）下的全部衍生子进程，而不发生误杀。
- **发布门槛**：所有对状态机或底层调用的修改，必须在此脚本跑出 `smoke-concurrency-regression: PASS` 后方可提交。

---

## 13. 基础设施调用故障备忘

系统依赖本地物理安装的 `opencode` 可执行程序，该链路容易受到外部系统环境的干扰：

- **VPN/代理断开导致模型列表空白**：
  - **故障特征**：OpenCode 启动时报 `ECONNRESET` 并闪退，或提示 `TypeError: The superclass is not a constructor`。
  - **应对机制**：系统在启动前会探测本地 `127.0.0.1:7890` 的可达性。若不可达，将强制清空环境变量中的 `HTTP_PROXY` / `HTTPS_PROXY`，直接使用直连国内 MiniMax 等服务。同时会尝试读取本地 `models.json` 缓存，通过设置 `OPENCODE_DISABLE_MODELS_FETCH` 避开联网查询。
- **本地二进制包缺失**：
  - **故障特征**：Windows 环境下提示找不到 `opencode.exe`。
  - **应对机制**：`resolveOpencodeCommand` 会依次检索本地 `opencode-windows-x64` 的 node_modules 路径和 npm 全局 Roaming 路径。若全局缺失，须确保使用工程内部锁定的版本。

---

## 14. 核心学堂：基准测试特定领域记忆

### 14.1 `audit-point-learnbench` (单点意见生成训练)
- **回测双轴验收指标**：
  - 在盲测（Trained-test）时，Blank Agent 绝对不允许生成包含 `CORE.md` 的任何 skill 目录，仅允许在工作区生成唯一产物：`workspace/audit-point-output.md`。
  - 软研判 validator 会严格将生成的意见与隐藏的专家标准进行多维度语义勾稽（`same_issue=true`, `specific_evidence=true`, `actionable=true`），任何一个假阳性都将导致用例不予通过。
- **修剪与合并规则**：
  - 合并脚本在 Phase 2 收集到 20 个训练实例全部成功（`verified_success`）后方可开启。
  - 一旦启动训练集回测且失败，允许启动 `append-only-skill-patch` 修复流程。该修复程序使用 `validate-append-only-skill-patch.ts` 进行物理守门。若修复 Agent 试图删除 `CORE.md` 的既有行或修改历史配置，该次 Patch 将直接被判违规。

### 14.2 `officeqa-pro-learnbench` (财务数据推理)
- **校验边界**：
  - 研报问答的核心逻辑必须是逻辑闭环，禁止硬编码答案。
  - 战役 Lead 写入 `pending-expert-package/current` 时，验证器会进行 Forbidden 模式扫描：若检测到具体的研报数据（如 `20665.20` 或 `10.13`），直接判定不予通过。
  - 它必须被强制提炼为泛化的检索规则（如：“定位到 Page X 表格，取得 A 项与 B 项执行加和计算”）。

### 14.3 `spreadsheetbench-learnbench` (表格矩阵处理)
- **校验边界**：
  - 表格的校验依赖对整个矩阵数据的解析。
  - 写入的 `workspace/answer.json` 必须严丝合缝地与隐藏的答案 Sheet 在特定 range（如 `A1:D10`）进行全量单元格值比对。一个单元格值有歧义或存在空值都将导致失败。

### 14.14 核心代码导出脚本

导出核心代码时不要去根目录 `script/` 里找旧脚本，当前真实脚本是：

- `auto-evolve/scripts/export-core-code-to-desktop.py`

运行方式：

```powershell
cd "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve"
python .\scripts\export-core-code-to-desktop.py
```

脚本会把核心代码导出到桌面，文件名类似：

- `C:\Users\ZhuanZ\Desktop\auto-evolve-core-code-YYYYMMDD_HHMMSS.txt`

### 14.15 ALFWorld 长程任务接入

ALFWorld 已接成 auto-evolve 长程任务包：

- 生成脚本：`auto-evolve/scripts/create-alfworld-experiment.ts`
- 任务包：`auto-evolve/task-packs/real-long-tasks/alfworld-learnbench`
- 验证器：`auto-evolve/scripts/validate-alfworld-plan.py`
- 默认 split：`splits/train-selected.json` 20 条，`splits/test-selected.json` 10 条

当前版本是“离线 walkthrough planning”：

- 原始 `.tw-pddl` 里有 `walkthrough`，不能直接给 blank agent 当材料
- 生成后的 `problem.json` 已去掉 walkthrough
- 标准动作序列只在 `private-answers/<id>/answer.json`
- blank agent 输出 `workspace/plan.json`
- product validator 比较 `workspace/plan.json` 和私有 walkthrough

重新生成：

```powershell
cd "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest"
bun run auto-evolve/scripts/create-alfworld-experiment.ts
```

外层 dry-run：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts `
  --task-pack-root auto-evolve/task-packs/real-long-tasks/alfworld-learnbench `
  --train-split auto-evolve/task-packs/real-long-tasks/alfworld-learnbench/splits/train-selected.json `
  --test-split auto-evolve/task-packs/real-long-tasks/alfworld-learnbench/splits/test-selected.json `
  --concurrency 2 `
  --stop-after training `
  --dry-run
```

单任务/少量任务调试不需要手写临时 split 文件，统一脚本已支持：

- `--task-id <id>`
- `--task-ids <id1,id2,...>`
- `--test-task-id <id>`
- `--test-task-ids <id1,id2,...>`

只跑一个长程任务且不合并时，推荐：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts `
  --task-pack-root auto-evolve/task-packs/real-long-tasks/alfworld-learnbench `
  --task-id <任务ID> `
  --concurrency 1 `
  --mode campaign-only
```

### 14.16 runtimeRoot 默认位置

2026-06-07 起，`auto-evolve/orchestrator/fs.ts` 不再默认优先使用 `D:\opencode-auto-evolve-runtime`。

默认 runtimeRoot 是项目内：

```text
auto-evolve/.runtime
```

只有显式设置环境变量时才写外部盘：

```powershell
$env:AUTO_EVOLVE_RUNTIME_ROOT = "D:\opencode-auto-evolve-runtime"
```

后续排查空间占用时，不要再默认假设 auto-evolve 会自动导航到 D 盘；先看 `AUTO_EVOLVE_RUNTIME_ROOT` 是否存在。

### 14.17 本机安装版 OpenCode 保护

本机桌面安装版 OpenCode 默认位于：

- `E:\OpenCode`

auto-evolve 清理进程时必须遵守：

- 只能清理项目自己登记、自己启动的子进程。
- 不得杀 `E:\OpenCode\OpenCode.exe`。
- 不得杀父进程链属于 `E:\OpenCode` 的 `opencode-cli.exe`、`opencode.exe` 或其子进程。
- 新增清理脚本时，必须复用同类父进程链保护逻辑，不能只按进程名粗暴 `Stop-Process`。

如果本机安装版 OpenCode 红点断联，但 `OpenCode.exe` 仍在、`localhost:4096` 没监听，应优先判断为桌面版本地 server / sidecar 掉线，而不是直接认定 auto-evolve 杀了主程序。

如果安装目录变化，用环境变量覆盖保护根：

```powershell
$env:AUTO_EVOLVE_PROTECTED_OPENCODE_ROOTS = "E:\OpenCode;D:\OtherOpenCode"
```

### 14.18 统一运行看板与长任务预算

接手正在跑的 benchmark、campaign 或 long-task 时，第一步不要先翻聊天记录，也不要只看前端卡片或旧 `scorecard.md`。必须先刷新并打开统一运行看板：

```powershell
cd "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest"
bun run auto-evolve/scripts/update-run-dashboard.ts
Get-Content auto-evolve/runtime-state/run-dashboard/active-runs.md
```

统一看板位置：

```text
auto-evolve/runtime-state/run-dashboard/active-runs.md
auto-evolve/runtime-state/run-dashboard/active-runs.json
```

看板会把分散在 `scorecard.md`、`campaign.json`、owner PID、heartbeat 和恢复状态里的信息集中成一张表。判断真实运行状态时，以统一看板 + `campaign.json` + owner/heartbeat 为准。

健康状态含义：

- `healthy_running`：owner 进程存在，任务正常运行。
- `long_running`：运行时间较长，但未证明卡死，只观察。
- `stale_running`：状态文件写着 running，但 owner PID 不存在，应恢复。
- `stuck_running`：owner PID 存在，但心跳和产物长时间不动，应执行 `takeover`。
- `recovery_pending`：已经进入恢复状态，外层应调用 `resume-long-task-campaign`。
- `completed`：终态任务。

通用批跑脚本 `auto-evolve/scripts/run-benchmark-orchestrator.ts` 已接入 watchdog：

- 训练队列中周期性扫描 active campaign 健康状态。
- 发现 `stale_running`、`stuck_running` 或 `recovery_pending` 时，把该任务重新放入恢复队列。
- `stuck_running` 对应 `takeover`，不是普通空转 resume：旧 owner 还活着但已经假死，恢复进程需要先安全终止旧 owner，再从磁盘断点续跑。
- 恢复方式是磁盘断点续传：新进程读取 `campaign.json`、round history、long-task progress 和已有产物继续，不恢复旧 OpenCode 对话 session。
- 内外层共用 `auto-evolve/orchestrator/run-health.ts` 的健康判断，不能再出现外层判 stuck、内层仍按 live 拒绝接管。

OpenCode 子 session 运行预算现在是 profile，不再默认 30 分钟：

```text
short:  soft 30m,  hard 60m
medium: soft 90m,  hard 120m
long:   soft 120m, hard 180m
unbounded-with-watchdog: soft 120m, hard 720m
```

默认 profile 是 `long`，适合 OfficeQA / SpreadsheetBench / DocVQA 真实长程任务。可以用环境变量覆盖：

```powershell
$env:AUTO_EVOLVE_OPENCODE_RUNTIME_PROFILE = "medium"
$env:AUTO_EVOLVE_OPENCODE_SOFT_DEADLINE_MS = "7200000"
$env:AUTO_EVOLVE_OPENCODE_HARD_TIMEOUT_MS = "10800000"
```

注意：

- soft deadline 不是运行中给 agent 追加消息，而是在 session 启动 prompt 中预置自我收敛规则。
- hard timeout 是系统层进程超时，超过后会终止进程树并把失败写回运行产物。
- 看板默认过滤旧 smoke campaign；如需排查 smoke，可设置 `AUTO_EVOLVE_DASHBOARD_INCLUDE_SMOKE=1`。
- takeover 回归烟测脚本是 `auto-evolve/scripts/smoke-run-health-takeover.ts`。

### 14.19 Benchmark round-limit 后续流程

通用批跑脚本 `auto-evolve/scripts/run-benchmark-orchestrator.ts` 支持“训练任务到达轮次上限但没有全部 `verified_success` 时，继续进入合并、回撤回测、add-only 修复和测试集”的流程。不要再把 `trainVerified < trainTotal` 自动理解成必须 abort；要看是否启用了 `--continue-after-round-limit`。

OfficeQA 当前约定命令核心参数：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts `
  --task-pack-root auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench `
  --train-split auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench/splits/train-selected.json `
  --test-split auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench/splits/test-selected.json `
  --train-limit 20 `
  --test-limit 10 `
  --concurrency 5 `
  --continue-after-round-limit `
  --replay-concurrency 3 `
  --repair-attempts 3
```

行为含义：

- `--continue-after-round-limit`：训练没全过但都到终态时，继续进入合并。
- 合并只吃 `verified_success` 的可信 skill；未通过训练题不贡献合并，但保留给 train replay 检验。
- 启用该参数时，train replay 默认 `all-train`，即合并后的 skill 要回测全部训练题。
- `--replay-concurrency 3`：回撤/训练回测并发为 3，独立于训练并发。
- `--repair-attempts 3`：回撤失败后自动走 add-only merge repair。
- `--test-limit 10`：最后只跑 10 个 held-out test。


# ⚠️ Windows 基础设施防坑强制纪律（Agent 必读）

**警告：本项目运行在 Windows 高并发环境下。任何 Agent 在编写脚本、处理路径、读写文件时，必须严格遵守下表中的防坑方案，违者将导致系统严重崩溃！**

| 序号 | 基础设施雷区 (Bug 类型) | 典型报错 / 表现症状 | 强制解决方案 (Action) |
| :---: | :--- | :--- | :--- |
| **1** | **PowerShell 语法限制** | 报错 `The token '&&' is not a valid statement separator`；脚本参数被截断。 | **禁用 `&&`**，多条命令必须用 `;` 或换行执行；**严禁使用 `$PID` 或 `$Args`** 作为自定义变量名，改用 `$MyPID` / `$CmdArgs`。 |
| **2** | **命令行引号撕裂与中文乱码** | `bun -e "..."` 传参时引号或中文目录名（如 `定稿`）在终端被解析成乱码，导致找不到文件。 | **禁用长 Inline 脚本**：复杂的 JS/Python 逻辑必须先写入临时文件（`.mjs` / `.py`），执行后再删除；避免直接在命令行中拼接带中文或多层引号的参数。 |
| **3** | **JSON 反斜杠 `\` 转义灾难** | Windows 路径直接写入 JSON 后，反序列化时 `\` 被吃掉，导致深层路径寻址全部失败。 | **强制转换正斜杠 `/`**：在生成配置文件、Prompt 注入和 JSON 序列化前，必须确保所有路径字符串已被替换为 Linux 风格的正斜杠 `/`。 |
| **4** | **UTF-8 BOM 头解析异常** | PowerShell 创建的文件默认带 BOM，Python (`json.load`) 或 Node.js 解析时直接引发 `SyntaxError`。 | **强制兼容 BOM 读取**：Python 读文件一律使用 `encoding="utf-8-sig"`；Node.js 解析 JSON 前，一律先执行 `.replace(/^\uFEFF/, "")` 清理不可见字符。 |
| **5** | **文件锁冲突竞争 (`EPERM`)** | 多进程同时读写 `active-processes.json` 等状态文件，抛出 `EPERM rename` 异常打崩进程。 | **强制原子写 + 退避重试**：严禁直接覆盖文件。必须先写入 `.tmp` 结尾文件，再使用 `rename`，且外部必须包裹 `try-catch` 与 **指数退避重试（重试 3~5 次）** 逻辑。 |
| **6** | **参数长度上限 (`ENAMETOOLONG`)** | 试图将超长 Prompt 或 Skill 文件内容直接拼接到命令行传给子进程，导致 `uv_spawn` 秒退。 | **改用文件驱动通信**：严禁把大段文本作为命令参数传递。所有超过 500 字符的内容，必须落盘为临时文件，命令中**只传递绝对路径**。 |
| **7** | **PID 快速复用导致的误杀/假活** | 依靠 `process.kill(pid, 0)` 判断存活，因 Windows 极快复用 PID 而误杀系统进程，或导致死锁任务被视为 `running`。 | **联合校验存活状态**：回收进程或判断任务活性时，必须结合 `campaign.json` 的 `heartbeatAt` 时间戳进行双重验证，心跳过期超 2 小时即视为假活（Stale）。 |
