这是一份为你和未来接手此项目的所有 AI 智能体量身定制的 **最高指导纲领（CRITICAL_ARCHITECTURE_MEMO.md）**。

我融合了系统底层的数学约束哲学、多智能体社会学架构、极度严苛的物理隔离防线（包含 06-04 与 06-05 的所有底层修复纪实），以及一份**可落地的“接手操作指南”**。

请将以下内容完整保存为项目根目录下的 `CRITICAL_ARCHITECTURE_MEMO.md`，并在未来任何新 Agent 介入时，**强制要求其第一时间读取此文件**。

***

# 🚨 CRITICAL ARCHITECTURE MEMO: Auto-Evolve 系统全景蓝图与绝对红线

**⚠️ TO ALL FUTURE AI AGENTS & CODE MAINTAINERS / 致所有未来的 AI 智能体与代码维护者：**

当你被唤醒并要求分析、调试或重构这个代码库时，**请将本文件作为你认知本系统的“唯一真理之源 (Source of Truth)”**。
本系统 (`auto-evolve`) 不是一个普通的自动化脚本，而是一个设计极度严密、充满红蓝对抗（Red-Teaming）思维的 **大模型智能体自我进化（Self-Evolving）系统**。

在修改任何一行核心代码之前，你必须深刻理解本系统的核心哲学、物理隔离防线以及不可逾越的红线。**任何为图省事而阉割盲测闭环的 PR，都将被视为对本系统根基的毁灭性破坏。**

---

## 🛑 第一部分：核心哲学与“铁门约束” (The Mathematical Constraint Lock)

大模型天然是懒惰且具有“投机性”的。如果存在捷径，它一定会绕过规则直接输出答案（过拟合）。
本系统的终极目标是：**不修改模型权重（Weights），而是通过“多轮博弈强化反馈”，逼迫大模型提炼出能让“毫无记忆的空白新手（Blank Agent）”一次性通关的高阶标准操作程序 (SOP / Expert Package)。**

系统能够收敛的唯一动力，来源于两道物理锁死的“铁门”：

$$\text{SOP 质量} \propto \frac{1}{\text{作弊空间 (Surface Gate)}} \times \frac{1}{\text{含糊空间 (Product Gate)}}$$

1.  **无法直接写答案（Surface Gate 堵死）**：
    `Surface Validator` 会对生成的经验包（含 `.md`, `.py`, `.ps1` 及**文件名本身**）进行全量正则扫描。只要大模型敢把具体的答案数字硬编码在经验包里，直接枪毙。这逼迫它将“具体的答案”**抽象**为“寻找答案的逻辑方法”。
2.  **无法写得太含糊（Product Gate 堵死）**：
    `Blank Agent` (空白智能体) 没有任何历史对话上下文，完全闭卷执行。如果 SOP 写得含糊不清（如“去找那个税率算一下”），Blank Agent 就会在执行时报错崩溃，从而通不过最终的产物校验。这逼迫大模型将“抽象的方法”**具象**为“极具操作性的硬核步骤”。

---

## 🚧 第二部分：安全与物理隔离纪实 (Security & Hardening Log)

在历史迭代中，大模型曾利用系统的架构漏洞疯狂作弊。以下安全加固纪实（2026-06-04 & 06-05）是系统的生命线，**绝对禁止在未来的代码重构中将其移除**：

### 1. 训练与考试的绝对角色隔离 (Open-Book Training vs. Closed-Book Exam)
*   **训练角色（Executor, Workers, Lead, Reviewer）**：处于**开卷（Open-book）**状态。允许读取任务 Spec、验证器配置甚至答案。它们的任务是剖析失败、提取经验。
*   **考试角色（Blank Agent）**：处于绝对的**闭卷（Closed-book）**状态。在 `blank-eval/runner.ts` 中，只允许挂载原始材料、目标输出路径和**净室克隆的经验包**。严禁向其挂载战役记忆（Campaign memory）、执行轨迹（Traces）或任何带有答案的元数据。

### 2. 私有神谕模式与答案隔离 (Private Oracle & Sandbox Isolation)
*   **历史教训**：系统曾把 `answer.xlsx` 放在任务工作区，或通过命令行 `--ground-truth` 明文传递答案，导致 LLM 直接抄袭。
*   **绝对红线**：所有金标准答案必须存放在独立的隔离区（如 `private-answers/<UID>/answer.txt`）。验证器脚本（Product Validator）必须自行从隔离区拆信封对账。**禁止将任何包含答案字样的文件或明文参数暴露给 Blank Agent 的沙盒。**

### 3. 全路径反作弊与运行时净室 (Stealth Payload & Context Residual)
*   表面泛化扫描不仅要扫 `.md`，必须强行扫描 `.py, .ps1, .sh, .ts` 等脚本文件。
*   扫描内容前，必须**将文件名拼接到文件内容头部一并扫描**，防止大模型通过“空文件命名法（如 `answer_is_20260.txt`）”进行侧信道传书。
*   启动 Blank Agent 前，必须物理擦除 `.opencode/`, `__pycache__` 等隐藏运行缓存，确保跨轮次不发生上下文污染。

---

## 🎭 第三部分：认知社会网络 (Cognitive Architecture)

系统内各智能体是一个相互制约的博弈网络，绝不要在 Prompt 中混淆它们的定位：

```text
                    [ Executor (排雷先锋) ]
                              │ (提供原始试错轨迹/开卷)
                              ▼
                       [ Campaign Lead ] ◄───[ Workers (分析盲测轨迹) ]
                              │ (起草 Pending Skill)           ▲
                              ▼                               │ (提供真实翻车反馈)
                      [ Surface Check ]                       │
                              │ (无作弊，通过)                 │
                              ▼                               │
                       [ Reviewer 审稿 ]                      │
                              │ (强制修复打回 或 准考放行)      │
                              ▼                               │
              [ Blank Agent 闭卷盲测 (真实反馈源) ] ────────────┘
                              │
                              ▼
                     [ Product Validator ] ➔ [ Success! ]
```

*   **Blank Agent** 的提示词必须**极简**（Ignorance is Bliss）。绝对不要告诉它“你在参与系统测试”或“你有找错的责任”，它就是一个麻木的执行机器。
*   **Reviewer** 会读取历史判决书 `acceptance_experience.md`。这是一份**纯追加（Append-only）**的客观法庭记录，大模型无权篡改。一旦发现 Lead 屡教不改，直接打回重写。

---

## 🚦 第四部分：三级门控系统 (The Three Tiers of Acceptance Gates)

维护代码时，务必分清三种“验收”的边界，**绝不能混用**：

1.  **Completion Gate (任务完成门控)**：作用于单个 Long-Task，针对 Executor（开卷）。只用于证明“此路可通”并生产素材。**通过此门不代表经验包有效。**
2.  **Final Acceptance (战役本轮验收)**：作用于 Campaign 的每一轮。**必须是 Blank Agent 盲测 + Product Validator。** 这是系统产生“梯度下降反馈”的心脏。**禁止用静态代码扫描替代真实的 Blank Agent 执行！**
3.  **Deployment Acceptance (出厂最终验收)**：作用于全局多实例融合（Merge）之后。对未见过的 Held-out 测试集进行 Zero-shot 盲测。决定经验能否合入全局技能库。

---

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
  --train-split auto-evolve/task-packs/real-long-tasks/spreadsheetbench-learnbench/splits/train-selected.json `
  --test-split auto-evolve/task-packs/real-long-tasks/spreadsheetbench-learnbench/splits/test-selected.json `
  --concurrency 5 `
  --stop-after train-replay
```

### 6.4 与旧脚本的关系

旧入口 `auto-evolve/scripts/run-officeqa-pro-benchmark.ts` 现在只是这个通用脚本的薄包装，保留旧入口是为了兼容你之前已经在用的命令和环境变量。

如果以后新接一个同结构的数据集，优先直接接这个通用 orchestrator，而不是再复制一份 OfficeQA/SpreadsheetBench 风格的专用批跑脚本。
