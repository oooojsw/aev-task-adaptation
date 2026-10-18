> 本文件由原 README.md 按主题拆分而来，正文尽量保留原文。
> 本文件负责：Auto-Evolve 总体架构、核心哲学、角色分工、验证层次、通用系统设计。

当前任务适配分支的总定位见[系统定位与总体流程](README-SYSTEM.md)，实现状态见[系统架构探索树](进度报告/系统架构探索树.md)。以下保留原 Skill 工作流的详细设计；其中固定空白验收和包结构要求按原工作流适用，不代表所有报告、软件、策略任务必须采用同一配置。

原始完整备份：README-FULL-ARCHIVE-20260709-015413.md。

<!-- 原 README 行 311-565 -->

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

### 验证器分类共识

系统里的 validator 不是一类东西，必须先问三个问题：**验谁、怎么验、发生在哪个阶段**。如果这三点混掉，就会把“查小抄”“改试卷”“开卷学习”“闭卷证明”搅成一团。

#### 1. 按验证对象分：Surface vs Product

*   **Surface Validator（表面验证 / 查小抄）**：检查专家经验区、skill、pending expert package。它不看最终答案文件，而是看“教材”本身有没有作弊，例如是否写死答案数字、泄露题目特有字符串、把答案藏进脚本或文件名、缺少入口文件、文件结构混乱。
*   **Product Validator（产物验证 / 改试卷）**：检查 Agent 在 `workspace/` 下真正做出来的产物，例如 `answer.txt`、`answer.json`、Excel、Word、审计意见、报告等。它回答的问题是：这个产物对不对、格式是否合格、是否满足业务要求。

二者不能互相替代：Surface 通过只说明“教材没有明显小抄”，不说明 Blank Agent 一定会做题；Product 通过只说明“这份产物对”，不说明专家经验没有过拟合或泄露。

#### 2. 按验证机制分：Hard vs Soft

*   **Hard Check（硬验证）**：由 Python / PowerShell / TS 等脚本执行，适合数字容差、JSON 格式、文件存在、正则扫描、防泄露、答案比对、矩阵比较等确定性判断。它的特点是冷酷、客观、可复现。
*   **Soft Check（软验证）**：由另一个模型按 rubric 审阅，适合审计意见是否行动性强、报告是否合理、文字是否完整、业务逻辑是否能被接受等难以写成固定脚本的问题。

Hard/Soft 只是“怎么验”，Surface/Product 才是“验什么”。所以可以有 hard surface、soft surface、hard product、soft product 四种组合。

#### 3. 按生命周期分：Local、Blank Eval、Post-Merge

*   **Local Validation（长程任务内部验证）**：开卷学习阶段。Executor / workers 可以利用更多上下文甚至答案相关信息，目标是找到可行路径、制造失败教训、帮助 Lead 修专家经验。Local 通过不等于任务最终成功。
*   **Blank Eval Final Acceptance（单题闭卷验收）**：单道训练题能否记为 `verified_success` 的核心证明。流程必须是：先跑 Surface 防作弊，再启动完全隔离的 Blank Agent，只给它专家经验和原始材料，最后用 Product Validator 验它做出的真实产物。
*   **Post-Merge Validation（合并后全域验证）**：多实例合并后的最终考试。Train replay 用来防止合并后退化；held-out test 用来验证未知题泛化能力。

核心原则：**Local 是为了学习，Blank Eval 才是证明；Surface 是查专家经验有没有小抄，Product 是改最终产物这张试卷。**

绝对红线：不能用 Surface 静态扫描替代 Blank Agent 闭卷执行，不能用 Executor 的开卷产物替代 Blank Agent 的闭卷产物，也不能把 Product Validator 直接拿去证明专家经验区没有泄露。

### Validation Engine + Result Router

新增 `orchestrator/validation-engine/` 作为统一验证执行与结果路由底座。它和现有模块的关系是：

*   **validation-engine**：负责跑验证器、生成 `private/training/sanitized/score_only` 四种结果视图、控制谁能看哪一版结果。
*   **blank-eval**：负责启动闭卷 Blank Agent 做题。Blank Agent 不调用验证器，也不能读取任何验证结果视图。
*   **acceptance-framework**：负责把某次验证或盲测在系统语义上记成“判决书”，例如 local、candidate、deployment 等层级的 acceptance record。

第一阶段已把旧入口 `runLongTaskValidator()` 接到 validation-engine 的 long-task adapter。外部调用签名不变，但每次验证现在会额外写出：

*   `result.private.json`：系统审计视图，可保留完整原始信息。
*   `result.training.json`：训练侧 agent 可读视图，默认脱敏答案数字和 private answer 路径。
*   `result.sanitized.json`：dashboard / carryover / memory 可读视图，只保留类别化信息。
*   `result.score_only.json`：测试集统计视图，只保留通过状态和分数。

关键原则：验证器可以根据阶段读取 private answers 来完成反作弊或产物比对，但验证结果必须按视图分发；答案不能进入 Blank Agent 可见面，也不能进入最终专家经验区。

验证模块必须可拔插，不允许把某个数据集的布局写死到平台层。现有 `task-packs/validator-profiles/*.json` 仍然是推荐挂载方式；profile 内的 validator 可以额外声明 `validation` 元数据，例如：

```json
{
  "validation": {
    "target": "layout",
    "stage": "pre_blank",
    "answerAccess": "none",
    "allowedAudiences": ["lead", "reviewer", "dashboard", "memory", "audit"]
  }
}
```

业务层以后可以按 `stage` / `target` 选择验证模块，例如在 `pre_blank` 阶段加载某个项目自己的 layout validator、surface leak validator 或 soft validator。OfficeQA、SpreadsheetBench、AuditPoint、ALFWorld 都应该通过 profile 选择自己的验证体系，而不是在 runner 里硬编码。

### Benchmark Orchestrator 的 round-limit 后续流程

通用批跑脚本 `scripts/run-benchmark-orchestrator.ts` 支持“训练任务到达轮次上限但没有全部成功时，仍继续进入合并/回撤/测试”的实验流程。这个能力不是把失败任务伪装成成功，而是：

1. 训练阶段继续等待每个任务到达终态；如果还有任务仍在 running/recovery，则不会提前合并。
2. 已经 `verified_success` 的训练任务作为可信 contributor 进入 Phase 2 合并。
3. 未通过但已到达 `round_limit_reached` / `exhausted_failure` / 其他终态的训练任务不参与合并，但会保留为 train replay 的被测题。
4. Train replay 可以用合并后的 skill 回测全部训练题，并发由 `--replay-concurrency` 单独控制；本轮 OfficeQA 约定值是 `3`。
5. Train replay 失败后，若 `--repair-attempts` 大于 0，会自动走 add-only merge repair，修改合并后的 skill 草案，再重新验证失败题。
6. 如果开启 `--continue-after-train-replay-failure`，即使修复后仍有训练回测失败，也会继续跑 held-out test，用于记录真实泛化分数。

### 合并后专家经验区的最小格式

多实例合并后的 skill / expert workspace 必须保持一个可被 Blank Agent 直接读取的最小结构：

* `INDEX.md`：入口文件，说明 Blank Agent 应如何选择 `CORE.md` 和 `casebook/` 中的专项经验。
* `CORE.md`：全局通用流程、通用检查规则和跨任务不变的操作原则。
* `surface_contract.json`：表层防泄漏与泛化约束声明。
* `meta.json`：合并来源、版本、贡献实例和 casebook 映射信息。
* `casebook/`：任务特点专项经验。这里的文件名必须按任务特点命名，而不是按原始 case id 顺序命名。
* `patches/training-backtest-patches.md`：训练回测和 add-only repair 的补丁说明。
* `patches/patch-log.jsonl`：补丁追加记录。
* `open_observations.md`：仍未完全确认、但需要保留给后续分析的观察。

`casebook/` 的命名规则是：用小写 kebab-case 描述任务特征、材料类型、表格/字段定位方式、公式或证据路线，例如 `treasury-statement-line-total-reconciliation.md`、`quarterly-debt-table-cross-page-lookup.md`、`spreadsheet-formula-range-normalization.md`。原始任务 ID 可以写在文件正文和 `meta.json` 映射里；只有同类任务重名时，才允许把 ID 作为后缀，例如 `quarterly-debt-table-cross-page-lookup-uid0227.md`。禁止把 `case-001.md`、`audit-point-001.md`、`UID0227.md` 这类纯序号/纯 ID 名称作为默认 casebook 文件名。

### Train Replay / Repair 收口规则

合并后的 train replay 如果失败，repair 阶段可能继续运行很久。此阶段必须持续刷新 `merge-and-validate/coordinator-state.json` 的 `heartbeatAt`，并在 repair 时把 `phase` 标记为 `phase4_repair`，否则外部看板会把仍在修复的 owner 误判成假活或异常停止。

`merge-repair.md` 必须保持数据集无关：不要默认所有任务都是 audit opinion；修复前要先看 task instruction、目标输出文件和 validator contract。OfficeQA 数值题通常要写 `workspace/answer.txt` 的纯数字，审计意见类任务才写 `workspace/audit-point-output.md`。

`patches/patch-log.jsonl` 是 JSON Lines，不是 JSON array。历史合并产物里若误初始化为 `[]` 或 `{}`，append-only 检查允许它迁移成第一条 JSONL；但一旦已有真实 JSONL 内容，任何覆盖旧日志的行为仍会被拒绝。

OfficeQA 这类“20 轮上限后仍要进入合并/回撤/测试”的推荐命令形态：

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

相关参数：

* `--continue-after-round-limit`：训练没全过但都到终态时，允许继续进入合并/回撤/测试。
* `--train-replay-scope all-train|verified-only`：回撤回测范围。启用 `--continue-after-round-limit` 时默认是 `all-train`。
* `--replay-concurrency 3`：训练回撤回测/rollback 验证并发，不再绑死训练并发。
* `--continue-after-train-replay-failure`：回撤和 add-only 修复后仍失败时，仍继续 held-out test。启用 `--continue-after-round-limit` 时默认开启。
* `--test-limit 10`：只跑 10 个测试集样本。

现在已有阶段级入口 `runValidationStage()`：

*   Campaign final acceptance 的 Blank Agent 前验证已接入 `pre_blank` stage。它会按 profile/validator 元数据执行 `surface/layout/behavior` 类验证，失败时阻断后续 Blank Agent。
*   Blank Eval 的产物验证已接入 `post_blank` stage。Blank Agent 只负责写产物，验证器由系统在外部调用，验证结果继续生成四视图。
*   `stage-result.json` 会汇总本阶段所有 validator 的结果，并包含 training/sanitized/score_only 视图路径，供后续 lead、worker、reviewer、dashboard 或 memory 使用。

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

\n

<!-- 原 README 行 2589-2621 -->

## Unified Access Profiles (2026-07-06)

OpenCode task permissions now flow through `orchestrator/access-profile.ts` for
the main Auto-Evolve roles. The profile modes are:

- `open_book`: executor / worker / lead / reviewer / merger / repair roles may
  read task evidence and oracle paths for learning and repair.
- `closed_book`: blank agent must stay inside the sandbox-visible materials,
  clean skill, and workspace; private answers, validator inputs, campaign
  memory, routing control, and oracle bundles are rejected.
- `readonly_audit`: third-party audit agents may read broad real run state but
  receive no edit paths.
- `maintenance`: bootstrap, judge, and knowledge-maintainer roles can read their
  failure/expected/context packet and write only their maintenance output.
- `validator`: system validators can read candidate / answer / context paths and
  write only their validator result directory.

Practical rule: prompt references and runtime read permissions should be
generated together by an access profile. Do not hand-build a new
`referencePaths` / `permissionReadPaths` pair unless it is a smoke-only harness
or there is a documented reason. This prevents the old bug class where a role
was told about a file but not granted permission to read it, or where a blank
agent accidentally received answer-bearing runtime paths.

Smoke:

```powershell
bun run auto-evolve/scripts/smoke-access-profile.ts
bun run auto-evolve/scripts/smoke-campaign-role-access-view.ts
bun run auto-evolve/scripts/smoke-campaign-worker-blank-evidence-permissions.ts
bun run auto-evolve/scripts/smoke-campaign-expert-oracle-permissions.ts
bun run auto-evolve/scripts/smoke-blank-agent-task-acceptance.ts
```
\n
