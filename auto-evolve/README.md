这是一份完整的、为你量身定制的、面向未来 AI 智能体（或接手代码的人类）的 **全景架构与红线备忘录 (CRITICAL_ARCHITECTURE_MEMO.md)**。

它不仅保留了严厉的“防偏航”警告，还完整、准确地重构了系统的全貌图景。你可以直接将这段文本保存到项目根目录下，作为整个项目的**最高指导纲领**。

***

# 🚨 CRITICAL ARCHITECTURE MEMO: Auto-Evolve 系统全景蓝图与绝对红线

**To All Future AI Agents / Code Maintainers:**

当你被唤醒并要求修改这个代码库时，请首先完整阅读这份文档。
本系统（Auto-Evolve）的终极目标是：**通过让大语言模型在试错中自我迭代，提炼出能让“空白智能体”一次性通关的高阶专家经验（Expert Experience Workspace / Skill Package），并最终实现跨任务泛化。**

为了防止架构在后续迭代中发生“降级”（例如用静态扫描代替动态盲测），本文件定义了系统的核心图景、流转逻辑与不可触碰的红线。

---

## 🛑 第一部分：系统的真正灵魂与红线定义 (The Soul & Red Lines)

### 1. 核心公理：闭环的 Blank Agent 真实反馈
系统 80% 的进化动力，来自于**“分析 Blank Agent（空白智能体）闭卷盲测失败的轨迹，并以此改进下一轮经验”**这一反馈闭环。
**红线：** 绝对禁止用静态的代码扫描（Linting/RegEx）或“带着记忆的 Executor 的成功”来代替 Blank Agent 的最终验收。没有 Blank Agent 真实运行并被判定通过的经验包，绝对不能标记为 `verified_success`！

### 2. 验证器的物理隔离 (Separation of Validators)
*   **Surface Validator (表面验证器)**：只作用于 `Lead` 写出的 **Markdown 经验包**。职责是防作弊（抓取硬编码的具体答案数字）和检查目录结构完整性。
*   **Product Validator (产物验证器)**：只作用于 `Blank Agent` 根据经验包操作后输出的 **最终业务产物**（如 `answer.txt`）。职责是判卷子（对了还是错了）。
*   **红线**：严禁 Product Validator 越权去验收 Executor（探索者）的产物并以此宣布本轮经验进化成功。

### 3. 角色的绝对界限 (Role Boundaries)
*   **Blank Agent (空白智能体)**：最纯粹的打工人。它**绝不能**知道自己在参与“实验”或“战役”。给它的 Prompt 必须极简，绝不能包含“如果经验教不会你，你就失败并反馈”等上帝视角的指令。它只管按照经验包去干活。
*   **Executor (探索者/执行者)**：拥有上帝视角、全部历史记忆和试错权限的先遣队。它的成功只是为了证明“这题能解”，它的产出是供给 Lead 提炼经验的**素材**，不是最终成果。
*   **Campaign Lead (主导者/编纂者)**：负责阅读 Executor 探出的路、历史记忆，以及**上一轮 Blank Agent 的失败轨迹**，写出下一版的经验包（Markdown）。
*   **Campaign Reviewer (审稿人)**：发射前的安全员。检查 Lead 写的经验包有没有明显的逻辑硬伤，如果没有，放行给 Blank Agent 盲测。它不负责判定经验是否最终有效。
*   **Campaign Workers (分析师群)**：在第一轮（Round 1）**不介入**。从第二轮（Round 2）开始，它们拿着上一轮 Blank Agent 的失败轨迹，从工具、路径、防偏离等角度切片分析，输出具体的修复建议给这一轮的 Lead。

---

## 🗺️ 第二部分：全局进化生命周期 (Global Evolution Lifecycle)

整个进化生命周期通常由 CLI (`cli.ts`) 触发，按以下宏观阶段不断向上攀升：

1. **环境初始化 (Init)**: 创建标准的目录隔离区（运行状态区、缓存区、方法/Prompt 模板库等）。
2. **经验冷启动 (Bootstrap)**: 读取少量带标签的“训练案例”，让大模型提炼出初始规则，生成一个基础的经验工作区。
3. **单例/短任务学习 (Short-Task Loop)**: 针对简单的 QA 或文件处理任务。采用快速试错循环（Solve -> Eval -> Judge -> Maintain -> Verify -> Regression -> Accept）。
4. **长任务与战役 (Long-Task Campaigns)**: 针对需要几十步操作的复杂任务。启动强化学习循环。智能体自己规划工作图（Work Graph），通过多个回合（Rounds）的试错和盲测反馈，打磨出一份极高质量的“待定专家包（Pending Expert Package）”。
5. **多实例融合 (Multi-Instance Coordinator)**: 同一类任务的多个实例并发打磨出各自的经验包后，由融合器（Merger）提取共性（`CORE.md`）和特性（`casebook/`）形成全局技能，并分发给 Held-out 测试集做最终的泛化盲测。
6. **最终出厂验收 (Deployment Acceptance)**: 全局最高门控。一个没有任何历史包袱的空白智能体，仅凭最终的经验包和原始题目，测试其能否在一次 Session 内完美通关。

---

## ⚙️ 第三部分：核心模块流程分解 (Core Modules Flow)

### 1. 短任务执行与反向传播模块 (Short-Task & Reverse Propagation)
*处理简单任务的基础反馈环。*
*   **Solve (解答)**: 智能体带着当前“经验工作区”去解题。
*   **Evaluate (评估)**: 判断业务产物是否正确。如果正确，结束。
*   **Pre-Judge (预审)**: 提取错误信息和执行轨迹，交给 Soft Judge 分析失败类型，决定是否启动维护。
*   **Maintain (维护)**: Knowledge Maintainer 读取 Judge 报告，修改/重写经验工作区（Markdown 文件）。
*   **Regression (回归测试)**: 跑一遍以前通过的案例，确保刚才的修改没有导致“灾难性遗忘”（退化）。
*   **Post-Judge (复审)**: 综合修复情况和回归测试情况，决定是 **接受 (Accept)** 还是 **回滚 (Rollback)** 并重试。

### 2. 长任务与工作图模块 (Long-Task & Work Graph)
*复杂任务的单次单步执行引擎。*
*   **Plan (规划)**: 将大目标拆分为多个“工作单元 (Work Units)”组成的 DAG（有向无环图）。
*   **Execute Unit (执行单元)**: Executor 执行一个 Unit，生成“主张 (Claim)”和业务产物。
*   **Validate (验证)**: 调用硬编码脚本对当前 Unit 产生的 Artifacts 打分。
*   **Local Reflection (局部反思)**: 若失败，生成局部失败包（Failure Packet）、暂存记忆（Scratch）。
*   **Replan (重规划)**: 若某个 Unit 重试预算耗尽，根据失败教训动态重构后续的工作图。

### 3. 长任务战役模块 (Long-Task Campaign) —— 【系统的核心引擎】
*跨轮次的强化学习循环，负责把 Executor 跑通的杂乱轨迹，提炼成 Blank Agent 能看懂的严谨技能。*
*   **Round 1（摸着石头过河）**:
    *   `Executor` 跑通长任务，留下成功轨迹和探索树。
    *   `Lead` 根据 Executor 的轨迹，凭空写出 **V1 版本**的专家经验包。
    *   `Surface Validator` 扫一下 V1 有没有硬编码答案（作弊）。
    *   `Reviewer` 检查格式。
    *   **`Blank Agent`** 拿着 V1 经验包和原始材料去盲测。由于是初稿，大概率**失败**，留下失败轨迹。
*   **Round N (N > 1)（基于反馈的强化）**:
    *   **`Workers` (Diagnostician 等)** 读取上一轮 `Blank Agent` 真实的失败轨迹，分析它卡在哪了。
    *   `Lead` 综合 Workers 的建议、历史记忆，修改出 **V(N) 版本**的专家经验包。
    *   `Surface Validator` 检查是否作弊。
    *   `Reviewer` 审查。
    *   **`Blank Agent`** 拿着 V(N) 去盲测。
    *   `Product Validator` 验收 Blank Agent 的产物。如果通过 -> 战役宣告 `verified_success`，结束循环。如果不通过，进入 Round N+1。

### 4. 多实例协同与泛化模块 (Multi-Instance Coordinator)
*防止智能体对单个案例过拟合，追求全局泛化。*
*   **Phase 1 - Fanout (扇出)**: 针对 $N$ 个不同训练实例，并行启动 $N$ 个上述的长任务战役，收集 $N$ 个经验包。
*   **Phase 2 - Merge (融合)**: `Merger` 读取 $N$ 个经验包，提取共性规则放入 `CORE.md`，特性规则放入 `casebook/`。
*   **Phase 3 - Validate (回测)**: 将融合后的全局技能包下发给所有训练集和测试集（Held-out Test）实例，进行“空白智能体”盲测，收集泛化数据。
*   **Phase 4 - Repair (修复)**:（仅针对增量模式）若回测有退化，追加补丁（Append Only）修复 `CORE.md`。

### 5. 验收框架模块 (Acceptance Framework)
*系统的铁面判官，维护不同维度的验证语义。*
*   **Local Guard**: 针对单个 Work Unit 的产物验证。
*   **Transaction Guard**: 针对 Short-Task 经验修改的回归验证。
*   **Candidate Guard**: 针对 Long-Task Campaign 每轮生成的经验包的表面检查（Surface Validation）和空白盲测验证。
*   **Deployment Guard**: 最终全局出厂验收，单会话、绝对隔离条件下的空白代理通关测试。

### 6. 监控与基础设施 (Infrastructure & Monitor)
*保证系统稳定、可观测、防雪崩的底层基建。*
*   **Process Registry**: 严格管理大模型生成的子进程（如执行 Python/Powershell 脚本），防止僵尸进程耗尽系统资源，支持进程树级别清理。
*   **OpenCode Gate**: 全局并发锁。精细控制同时运行的 LLM Session 数量，防止触发 API Rate Limits 导致级联崩溃。
*   **Two Planes (双平面数据隔离)**:
    *   *Tracked Experience Plane*: 经验平面（Markdown、JSON），最终要提交和复用的纯净知识。
    *   *Runtime Sidecar Plane*: 运行平面（如 `.opencode` 下的缓存、临时执行文件），这部分物理隔离，绝对不允许被吸纳进经验平面污染知识库。
*   **Monitor Dashboard**: 提供 Web 仪表盘，实时观测各 Session 的状态、工具调用流和思考日志。
## 2026-06-04 Implementation Note: per-round blank-agent acceptance is now infrastructure

本次代码层变更把 long-task campaign 的每一轮最终验收改回真实闭环：

- Lead/Reviewer 写完本轮 pending expert package 后，系统先跑 surface validators，只检查经验包表面是否泄漏答案、结构是否合格。
- surface 通过后，系统必须启动 clean blank agent，让它只拿当前经验包、原始材料、允许的输出路径去完成任务。
- blank agent 产物再交给 product validators。只有这个链路通过，本轮 final acceptance 才能 passed。
- 如果任务没有 product validator，也没有旧的 blank-agent deployment wrapper，本轮会失败并提示缺少产物验收，不能再靠静态检查冒充成功。
- blank agent prompt 已降噪成普通任务提示，不再告诉它自己处在实验、战役或验收体系里。

对应核心代码：

- `auto-evolve/orchestrator/long-task-campaign/runner.ts`
- `auto-evolve/orchestrator/blank-eval/runner.ts`

维护要求：

- 后续改 campaign / validator / blank-eval 时，必须同步维护本 README。
- 不允许再把 surface validator、product validator、blank agent acceptance 混成同一个概念。
