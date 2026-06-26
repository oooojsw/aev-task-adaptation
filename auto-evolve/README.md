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

## Blank Eval 物理闭卷沙盒红线（2026-06-26）

Blank Eval 现在必须按“物理闭卷考试”运行，而不是只靠提示词或元数据声明不能看答案。每次空白 agent 验收都会在 `runtime-state/blank-eval-runs/<run>/sandbox/` 下构建独立考场：

- `sandbox/materials/`：只复制该题允许读取的原始材料。
- `sandbox/skill/`：只复制去掉隐藏缓存、`.opencode`、`node_modules`、软链接/junction 的 clean skill。
- `sandbox/workspace/`：唯一可写输出区。
- `sandbox/bundle.json`：只记录 sandbox 内路径，不记录原始 spec、private answers、旧 campaign、worker、validator 输入等路径。

实现要点：`runOpencodeTask` 新增 `workDir` 和 `allowShell`，因此 repo 根目录仍可用于加载本地 OpenCode 源码和依赖，但传给 `opencode run --dir` 的任务目录必须是 sandbox 根目录。Blank Eval 默认 `allowShell: false`；如果以后确实需要 shell，必须先实现只能在 sandbox 内执行、并防 symlink/junction 逃逸的安全 wrapper，不能直接打开普通 shell。

清考场也必须 fail closed：Blank Eval 的 reset 只能备份、删除、重建 `sandbox/` 内的 `editablePaths/targetPaths`。如果 spec 写了绝对路径或 `../` 逃逸路径，系统必须在启动模型前报错停止，不能帮它清理宿主机上的真实文件。

## PID Owner 强身份判断补丁（2026-06-26）

Windows 会复用 PID，所以 Auto-Evolve 不能只看“这个 PID 活着”或“命令行里出现 run-long-task-campaign”。现在 `process-identity.ts` 提供统一的 owner hint 分类：

- `strongProcessOwnerHints(...)`：只保留可证明具体任务归属的强上下文，例如完整命令、campaignID、campaign 目录名、baseSpecPath、runID。
- `optionalProcessOwnerHints(...)`：只放旧状态里残留的泛用命令名，例如 `run-long-task-campaign`、`resume-long-task-campaign`、`run-long-task`。

run-health、benchmark 外层恢复、OpenCodeGate、campaign takeover 都必须使用这组 helper。泛用 hint 不能进入 `requiredAnyCommandHints`，否则旧状态可能把别的 campaign 进程误认成当前任务，造成看板假健康、断点续传不启动或错误 takeover。

补充规则：campaign runner 内部也不能只看旧 `ownerCommandHint`。恢复、自愈和 takeover 必须带上 campaignID、campaign 目录名、baseSpecPath 或 runID 这类强上下文。`unknown_owner` 只能在心跳新鲜时短暂观察，不能长期阻止 stale recovery；更不能作为 `terminateProcessTree(...)` 的依据。只有 `ownership === "owned"` 才允许杀进程。

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

## 2026-06-07: Core Code Export Ignore Rules

`scripts/export-core-code-to-desktop.py` now has embedded export-ignore rules. This is intentionally self-contained: future agents only need to run/copy this one script and cannot forget a second ignore file.

The embedded list works like a small `.gitignore` for core-code exports only. It does not delete or hide files from the repository; it only prevents temporary debug payloads from being copied into the exported `auto-evolve-core-code-*.txt` bundle.

Current intent:

- keep real reusable validators, orchestrators, prompts, and frontend monitor code;
- exclude old one-off JSON payloads such as `scripts/*_input.json`, round-specific validation inputs, UID-specific rerun helpers, and temporary `_*.py` verifier stubs;
- allow `!pattern` exceptions for reusable files that match a broad ignore rule.

When a future debug helper is created only for one run, add its pattern to `IGNORE_PATTERNS` inside `scripts/export-core-code-to-desktop.py` instead of relying on manual cleanup before export.

---

## 2026-06-08: Script Validator Stage-Local Candidate Paths

Post-merge train replay / held-out test blank evals write outputs into stage-local directories such as:

```text
runtime-state/benchmark-runs/<run>/merge-and-validate/phase3-validate/<case>/task-work/workspace/...
```

Script validators must validate that stage-local output, not an old `./workspace/...` file under the repo or task root. This matters for OfficeQA, SpreadsheetBench, and ALFWorld because their specs use script validators with arguments like `--candidate ./workspace/answer.txt`, `--candidate ./workspace/answer.json`, or `--candidate ./workspace/plan.json`.

Current safeguards:

- `orchestrator/multi-instance/validator.ts` rewrites script validator `--candidate` to the generated stage-local target path when building blank-eval specs.
- `--answer`, `--answer-path`, and `--expected` script arguments are resolved against the source task root when they are relative paths.
- `scripts/validate-officeqa-answer.py`, `scripts/validate-spreadsheetbench-answer.py`, and `scripts/validate-alfworld-plan.py` now load the validator payload and prefer `targetPaths` / `expectedArtifacts` for candidate resolution.
- 2026-06-23 SpreadsheetBench validator fix: many official SpreadsheetBench rows have `answer_sheet=null` and only provide `answer_position`. The task generator must not emit `--sheet null`; the spreadsheet hard validator now accepts missing `--sheet`, infers the sheet from `Sheet!Range`, candidate `answer_sheet`, or a single-sheet answer workbook, reads candidate JSON with `utf-8-sig`, and supports single-cell / rectangular / comma-separated ranges. It also supports comma-separated cross-sheet references like `'Sheet1!'A1:A50,'Sheet2!'A1:E20`, strips dirty quotes around sheet/range fragments, tolerates answer workbook sheet names with accidental leading/trailing spaces, normalizes full-width colons such as `G12：J15`, handles full-column ranges such as `A:G`, and repairs missing end columns such as `BD2:308` -> `BD2:BD308`. Candidate JSON remains strict by default but accepts unambiguous common forms: scalar `value/answer/result` for 1x1 ranges, flat lists for single-row or single-column ranges, and `values/matrix/data` for matrix outputs. Local zero-quota smoke now covers all official `train=80 / val=40 / test=280` items with `failures=0`. Any pre-fix run that failed with `argument --sheet: expected one argument` or range parsing errors is an infrastructure failure, not model failure.

### Validator infrastructure circuit breaker (2026-06-23)

Campaign final acceptance now distinguishes `product_failure` from `validator_infrastructure` in code rather than asking Lead/diagnosis agents to infer it from prose.

- Ordinary answer mismatches remain `product_failure`: the diagnosis workers and Lead may improve the skill and continue to another round.
- Validator timeout/bootstrap failure, non-JSON abnormal exit, argparse/usage failure, missing required argument, or explicit `Validator crashed` becomes `validator_infrastructure`.
- A blank-agent process that exits non-zero or times out is also infrastructure failure.
- When pass-01 hits validator infrastructure failure, the campaign skips pass-02, skips the blank-acceptance diagnosis worker, does not feed the failure to Lead, records `closed_infra_failure / infrastructure_failure`, and stops as terminal `failed` instead of consuming another round.
- The stopped state keeps a same-round `harvest_round_run` recovery marker. A deliberate resume after the platform is fixed reuses the completed inner run instead of starting a new learning round.
- The benchmark orchestrator treats this `failed` state as terminal and does not auto-requeue it. Pending skills from infrastructure-failed campaigns are quarantined and excluded from hierarchical merge, even when failed skills are otherwise configured as negative evidence.
- Zero-quota regression command: `bun run auto-evolve/scripts/smoke-validator-infrastructure-circuit-breaker.ts`.

Do not interpret a replay/test failure as a model failure until checking the validator read path. If the blank agent wrote the correct stage-local answer but the validator reports a different predicted value, inspect `validator_input.json`, `targetPaths`, and the script `--candidate` argument first.

## 2026-06-08: Phase 2 Post-Merge Validation Engine Hook

Multi-instance Phase 2 merge is now connected to the unified validation engine.

Previous behavior:

- `orchestrator/multi-instance/merger.ts` only checked that the merged skill output had a few required files such as `INDEX.md`, `CORE.md`, and `meta.json`.
- Validator profiles could define `validation.stage = "post_merge"`, and `smoke-validation-engine.ts` proved the stage runner worked, but the real merger did not invoke that stage.

Current behavior:

- After the merger writes `phase2-merge/output`, Phase 2 loads validator modules from the contributing training task specs.
- It selects every module whose metadata resolves to `stage: "post_merge"`.
- It runs those modules through `runValidationStage({ stage: "post_merge" })` with the merged skill directory exposed as `targetPaths[0]` and `expectedArtifacts[0]`.
- If no `post_merge` module is configured, Phase 2 logs a compatible `skipped` status and continues.
- If configured required modules fail, Phase 2 records the result path/summary in coordinator state and throws before train replay or held-out test begins.

State fields added to `merge-and-validate/coordinator-state.json`:

- `postMergeValidationStatus`: `passed`, `failed`, or `skipped`.
- `postMergeValidationResultPath`: path to `phase2-merge/post-merge-validation/stage-result.json` when a stage ran.
- `postMergeValidationSummary`: human-readable stage summary.

This keeps post-merge validation pluggable. Dataset-specific file layout checks, leakage checks, soft surface review, or other merged-skill validators should be attached through validator profiles instead of hardcoded in `merger.ts`.

---

## 2026-06-14: Hierarchical Merge Strategy In Unified Benchmark Orchestrator

The benchmark orchestrator now supports a second merge strategy without adding a parallel runner.

Existing default behavior is unchanged:

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts ... --merge-strategy flat
```

To run tree-style skill merging, use the same orchestrator and switch only the merge strategy:

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts `
  --task-pack-root "auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench" `
  --train-split "auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench/splits/train-50.json" `
  --merge-strategy hierarchical `
  --merge-group-size 5 `
  --merge-input all `
  --failure-policy negative-evidence `
  --merge-grouping status-balanced `
  --hierarchical-local-replay level1 `
  --hierarchical-repair-attempts 1
```

Conceptually this supports flows like:

```text
50 single-case skills -> 10 group skills -> 2 cluster skills -> 1 final skill
```

Important semantics:

- Successful skills are positive method evidence.
- Failed / round-limit skills can be included as negative evidence or diagnostics, but must not be promoted as proven solution paths.
- The benchmark orchestrator now harvests an existing `pending-expert-package/current` from failed or round-limited campaigns when hierarchical merge includes failures. If that package is absent, the instance is explicitly downgraded to metadata-only diagnostics instead of silently pretending its skill was merged.
- 2026-06-22: SpreadsheetBench official SkillOpt train run was switched from Alibaba Qwen3.7 Plus to `minimax-cn-coding-plan/MiniMax-M2.7` because the Alibaba coding-plan token expired during training. MiniMax uses a dedicated adaptive profile with requested train concurrency 5. The bottom OpenCode gate starts from the last safe value and can now climb from 3 toward max 5 through AIMD after repeated successful calls; online backoff still applies on timeout/rate-limit/auth failures.
- Level-1 local replay tests only the cases that were originally successful inside that group.
- If a formerly successful case fails after group merge, the system may run one repair pass to restore the missed method.
- Repair policy is path-aware: `CORE.md` / `INDEX.md` are append-only; `casebook/*.md` can be rewritten; `meta.json` and `surface_contract.json` can be regenerated.
- Every hierarchical group output runs the same pluggable `post_merge` validation-engine stage used by the flat merger. If a configured required validator fails, the group is blocked before replay or upward merge.
- Higher-level merge currently merges upward without mandatory replay by default; final train replay and held-out test still use the existing Phase 3 validator path.

Relevant files:

- `orchestrator/multi-instance/hierarchical-merger.ts`
- `methods/recipes/multi-instance/prompts/hierarchical-merge-generic.md`
- `methods/recipes/multi-instance/prompts/hierarchical-merge-repair.md`
- `scripts/validate-append-only-skill-patch.ts`
- `scripts/run-benchmark-orchestrator.ts`
- `scripts/run-officeqa-pro-benchmark.ts`

OfficeQA wrapper environment variables:

```powershell
$env:OFFICEQA_PRO_MERGE_STRATEGY = "hierarchical"
$env:OFFICEQA_PRO_MERGE_GROUP_SIZE = "5"
$env:OFFICEQA_PRO_MERGE_INPUT = "all"
$env:OFFICEQA_PRO_FAILURE_POLICY = "negative-evidence"
$env:OFFICEQA_PRO_HIERARCHICAL_LOCAL_REPLAY = "level1"
$env:OFFICEQA_PRO_HIERARCHICAL_REPAIR_ATTEMPTS = "1"
```

### Direct Chat 单题筛选与结果分类

`scripts/run-direct-chat-eval.ts` 支持：

```text
--case-ids UID0006
--case-ids UID0001,UID0006
```

筛选在统一 Direct Chat runner 中执行。指定 UID 不存在时必须报错，禁止静默运行整个 split；实际 UID 会写入 `config.snapshot.json -> caseIDs`。

Direct Chat 失败至少要分成三类：

1. `validation`：材料完整、答案成功提取，但外部 product validator 判错。
2. `answer_extraction/output_truncation`：模型推理中已有明确最终值但旧提取器漏抓，或输出额度耗尽导致没有写出最终答案。
3. `missing_external_material`：题目明确要求额外公共数据源，但 task spec / source_docs 没有提供该材料。此类不能计作纯模型失败。

答案提取器只接受 `<answer>`、明确 final-answer 句和 “I will output/provide/return/go with” 这类强收口表达。长推理文本不会再用“最后一个数字”猜答案。思考模型必须保留足够输出预算，让其最终写出 `<answer>`；Qwen3.6-35B-A3B 当前为 `maxOutputTokens: 4096`。

对于输出额度耗尽但推理正文已经明确给出最终舍入值的情况，提取器也允许识别强语义收口形式，例如：

```text
rounded to the nearest ...: 32.703
39,482.0286 -> 39,482.03
```

不能把 `Total Value = ...`、页码、年份或任意最后一个数字当最终答案。历史运行若因提取器版本产生假失败，应保留原始 `summary.json`，另行记录修复后离线重放结果，不篡改历史原始响应。

Direct Chat 答案提取现在采用候选评分，而不是固定正则顺序。大致优先级是：

```text
完整 <answer> 标签
不完整但可恢复的 <answer> 标签
Final answer / 最终答案
I will output / return / provide
Rounded to nearest / 箭头后的最终值
The answer/result is
Average / difference / percent change
普通 sum
独立 JSON 或独立数字行
```

每题会保存：

```text
results/<model>/<case>/answer-extraction.json
```

其中包含：

- 最终选择的答案。
- 命中来源，例如 `answer_tag`、`rounded_result`、`arrow_result`。
- `high / medium / low` 置信度。
- 排名前 20 的候选值、分数和原文位置。

如果模型返回很长的推理文本，却没有任何可信的最终答案表达，系统不再把整段推理写入 `answer.txt` 交给 product validator，而是直接记录：

```text
errorCategory: answer_extraction
```

这样模型答错、验证器失败和答案提取失败可以分别统计。

---

## 2026-06-16: Direct Chat 可拔插单轮评测

新增 Direct Chat 辅助评测链路。它不替代 `blank-opencode`，只用于论文里的单轮问答 baseline、跨厂商横向测试和 skill prompt 迁移测试。

核心边界：

- `blank-opencode` 仍然是主证明：启动空白 OpenCode agent，真实读材料、用工具、写 workspace，再由 product validator 判分。
- `direct-chat` 是辅助评测：把训练/合并后的 skill 压成一个文本 bundle，把测试题压成 `question + materials`，直接调用目标模型一次，让模型输出最终答案。
- Direct Chat prompt 只能包含三块：`skill`、`question`、`materials`。
- Direct Chat prompt 允许额外有一层通用说明，告诉模型这三块分别是什么、它要做什么、最终答案必须如何输出；这层说明不能包含答案、validator 参数、private path 或任务历史。
- Direct Chat prompt 禁止包含：private answer、private answer 路径、validator 参数、原始 spec 全文、campaign memory、worker/lead/reviewer 轨迹、blank-agent 轨迹。
- Direct Chat 模型不能自己判自己；输出仍由系统外部 product validator 判分。

新增核心文件：

- `orchestrator/direct-chat/contract.ts`
- `orchestrator/direct-chat/skill-bundler.ts`
- `orchestrator/direct-chat/dataset-bundler.ts`
- `orchestrator/direct-chat/provider-client.ts`
- `orchestrator/direct-chat/providers/*`
- `orchestrator/direct-chat/runner.ts`
- `scripts/run-direct-chat-eval.ts`
- `scripts/smoke-direct-chat-eval.ts`
- `scripts/smoke-direct-chat-siliconflow-capabilities.ts`
- `direct-chat-models.example.json`

第一版支持：

- OfficeQA task pack 打包为 `direct-chat-dataset.bundle.jsonl`。
- Skill 目录打包为 `skill.bundle.txt` 和 manifest。
- OfficeQA PDF 不做任何本地文本抽取；PDF 作为 `document_asset`，只交给已声明并认证 `fileInputMode` 的模型。模型没有声明或该 provider 未认证 PDF 输入时，该 case 记为 `config` 失败。
- Direct Chat 材料路由现在支持本地 OCR fallback：目标模型能原生读取图片/PDF 时，继续发送原始 asset；目标模型不能稳定读取时，先由本地 `PyMuPDF + Umi-OCR(PaddleOCR-json)` 把材料识别成 Markdown 文本，再把这份 OCR 文本作为材料发给目标模型。这个 fallback 发生在 `orchestrator/direct-chat/ocr-fallback.ts`，并调用 `scripts/direct-chat-local-ocr.py`。
- OfficeQA 多 PDF 会全部作为模型原生 PDF/file 材料进入请求；不再使用 Fraser `page=...` 在本地抽页。硅基流动普通文本/VLM 配置不能直接吃 PDF；只有 `siliconflow-deepseek-ocr-pdf` 这类 OCR/document 模型配置会把 PDF 按官方 `image_url` PDF/base64 方式发送。
- 默认 `direct-chat-models.example.json` 已开启本地 `ocrFallback.mode = local-umi`。因此像 `siliconflow-qwen3-6-35b-a3b` 这类不能直接处理 OfficeQA PDF 的模型，也可以通过“先本地 OCR、后回答”的方式参与 Direct Chat 测试，不依赖云端 OCR fallback。
- 通用 task-pack materializer 支持 `.md/.txt/.json/.jsonl/.yaml/.yml/.pdf/.xlsx/.xlsm`：文本直接进入材料，PDF 作为模型原生 file asset，Excel 仍抽 workbook/sheet/preview/formula 摘要。
- 每次模型调用都会写 `prompt-audit.json`，记录 skill/material 原始 token、实际进入 prompt 的 token、是否截断和材料能力警告。
- 每题还会写 `material-routing.json` / `material-routing.md`，明确记录每份材料是“直接保留文本”“原生 asset 直送模型”还是“改走 OCR fallback”，并记录 OCR 引擎与缓存命中情况。
- 每个模型可配置 `contextWindowTokens`、`promptBudgetTokens`、`skillBudgetTokens`、`materialBudgetTokens`，不同厂商按各自上下文预算裁剪。
- Provider 错误会分类记录：`auth`、`quota`、`rate_limit`、`context_length`、`provider_5xx`、`timeout`、`network`、`bad_request`、`validation` 等，不再把模型调用失败和答案验证失败混在一起。
- 答案文件由 validator contract 统一决定：文本题写 `answer.txt`，JSON 题写 `answer.json`，Markdown 题写 `answer.md`，validator 的 `--candidate` 会被替换到对应路径。
- 可启用无 skill 对照：同一模型会额外生成 `<model>__no-skill` 结果目录。
- 图片材料不做 OCR；adapter 只传递 image pointer 和 “需要模型图片能力” 标记。文本模型不能把这类材料视为已读。
- 数据集 adapter 入口已独立：`officeqa`、`spreadsheetbench`、`alfworld`、`generic`。SpreadsheetBench/ALFWorld 当前复用通用 materializer，但调用入口已按数据集命名，后续可逐个增强。
- 厂家已拆成可切换 provider module：`providers/siliconflow.ts`、`providers/openai-compatible.ts`、`providers/mock.ts`。`provider-client.ts` 只负责路由和重试，不再把所有厂家写死在一个大分支里。
- `openai-compatible` `/chat/completions` 模型调用仍作为通用兜底。硅基流动已单独配置为：文本模型 `imageInputMode=fileInputMode=none`；视觉模型可用 `imageInputMode=openai-image-url`；OCR/document 模型可用 `fileInputMode=siliconflow-image-url-pdf`，把 PDF 作为 `image_url` content part 发送。
- `Qwen/Qwen3.6-35B-A3B` 已加入为 `siliconflow-qwen3-6-35b-a3b`，并发 2，256K 上下文，使用 OpenCode `siliconflow-cn` auth 兜底。真实探测显示普通文本请求可用，但 PDF 作为 `image_url` data URL 会被硅基流动返回 `cannot identify image file`，因此不能直接跑 OfficeQA PDF 测试集。
- `mock` transport 本地烟测。
- 统一 benchmark orchestrator 支持 `--eval-runner direct-chat`，训练、合并、train replay 仍走原链路，held-out test 可切换为 Direct Chat。
- 每题保存 `prompt.system.txt`、`prompt.user.txt`、`response.txt`、`answer.txt`、`validator-result.json`、`result.json`。
- Direct Chat 会要求模型用 `<answer>...</answer>` 包住最终答案。答案提取器优先读取该标签；若模型没遵守标签，也会尝试从 `Final answer:`、JSON 数组/对象行、纯数字行或末尾数字中提取最终答案，避免整段推理直接进入 validator。
- 总表保存 `summary.json`、`summary.csv`、`summary.md`。
- 材料遗漏默认阻断；如果只是做 OfficeQA instruction-only 文本 baseline，必须显式加 `--allow-omitted-materials` 或 `--direct-chat-allow-omitted-materials`。

典型命令：

```powershell
bun run auto-evolve/scripts/run-direct-chat-eval.ts `
  --skill-root "<merged-skill-dir>" `
  --task-pack-root auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench `
  --split auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench/splits/test-selected.json `
  --models-config auto-evolve/direct-chat-models.example.json `
  --models dashscope-qwen-plus `
  --allow-omitted-materials `
  --global-concurrency 4
```

统一 benchmark orchestrator 中使用：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts `
  --task-pack-root auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench `
  --train-split auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench/splits/train-selected.json `
  --test-split auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench/splits/test-selected.json `
  --eval-runner direct-chat `
  --direct-chat-models-config auto-evolve/direct-chat-models.example.json `
  --direct-chat-models dashscope-qwen-plus `
  --direct-chat-global-concurrency 4
```

本地烟测：

```powershell
bun run auto-evolve/scripts/smoke-direct-chat-eval.ts
bun run auto-evolve/scripts/smoke-direct-chat-siliconflow-capabilities.ts
```

这个烟测验证：

- prompt 不泄漏 `private-answers` 路径。
- mock 模型输出能被现有 OfficeQA validator 判分。
- 有 PDF source 但未转文本时，默认会被材料遗漏门阻断。
- 硅基流动视觉配置会把图片材料编码为 OpenAI-compatible `image_url`；普通视觉/文本模型的 PDF 会被拦截；DeepSeek-OCR/PaddleOCR-VL 类配置的 PDF 会按 `image_url` PDF/base64 方式进入请求。

相关参数：

- `--eval-runner blank-opencode|direct-chat`：默认 `blank-opencode`。
- `--direct-chat-models-config <json>`：Direct Chat 模型配置。
- `--direct-chat-models <id1,id2>`：只跑指定模型。
- `--direct-chat-global-concurrency <n>`：Direct Chat 总并发。
- `--direct-chat-max-pdf-chars <n>`：历史兼容参数；当前 Direct Chat 不本地抽 PDF 文本，PDF 走原生 file asset 能力。
- `--direct-chat-allow-omitted-materials`：允许材料遗漏，只适合显式 baseline。
- `--direct-chat-no-skill-baseline`：在 held-out test 里同时跑 no-skill 对照。
- `--direct-chat-adapter officeqa|spreadsheetbench|alfworld|generic`：手动指定数据集 adapter。

材料完整性规则：

- 对 PDF/图片任务，Direct Chat 依赖厂商模型自己的文件/图像能力；本地不 OCR、不抽 PDF 文本。
- 文本、JSON、Excel 摘要仍作为普通文本 prompt 发送。
- `material-audit/*.json` 记录 task spec 期望材料、实际进入 bundle 的材料、遗漏材料和转换警告。
- `omittedSources` 非空时默认阻断；除非显式允许 omitted materials。
- 多材料不会被静默丢弃；文本材料进入 prompt 前如果超过模型预算，会在 `prompt-audit.json` 标记 `truncated=true`。PDF/图片材料作为原生 asset，不做本地文本截断。
- Direct Chat 分数必须结合 `prompt-audit.json` 看：如果模型预算太小导致关键材料被截断，这属于材料预算/模型上下文限制，不应直接解释成 skill 无效。
- Direct Chat 结果必须结合 `errorCategory` 看：`validation` 是答案没过，`auth/quota/rate_limit/context_length` 是供应商或配置问题，不能混成同一类失败。

## 2026-06-17: SkillOpt OfficeQA 测试层桥接

新增 SkillOpt 旁路评测桥接脚本：

```text
auto-evolve/scripts/export-officeqa-skillopt-bridge.ts
```

用途：

- 把 Auto-Evolve 的 OfficeQA task-pack split 转成 SkillOpt `eval_only.py` 可读取的 `split_dir`。
- 把 Auto-Evolve 多文件 skill / expert workspace 合并成 SkillOpt 需要的单个 `merged-skill.md`。
- 先旁路复用 SkillOpt 的 OfficeQA 测试层，不直接替换 Auto-Evolve 主链路。

典型导出命令：

```powershell
$out = "auto-evolve/runtime-state/skillopt-bridge/officeqa-test10"
bun run auto-evolve/scripts/export-officeqa-skillopt-bridge.ts `
  --task-pack-root "auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench" `
  --split "auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench/splits/test-10.json" `
  --out-dir $out `
  --split-name test `
  --skill-root "auto-evolve/runtime-state/benchmark-runs/<run>/merge-and-validate/phase2-merge/output"
```

如果当前 SkillOpt 没有官方 OfficeQA parsed/text corpus，可显式让桥接脚本生成一个本地文本语料目录：

```powershell
$out = "auto-evolve/runtime-state/skillopt-bridge/officeqa-test10-with-docs"
bun run auto-evolve/scripts/export-officeqa-skillopt-bridge.ts `
  --task-pack-root "auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench" `
  --split "auto-evolve/task-packs/real-long-tasks/officeqa-pro-learnbench/splits/test-10.json" `
  --out-dir $out `
  --split-name test `
  --skill-root "auto-evolve/runtime-state/benchmark-runs/<run>/merge-and-validate/phase2-merge/output" `
  --build-local-text-corpus `
  --corpus-mode page-window `
  --ocr-page-window 0
```

这个模式会额外生成：

```text
<out>/docs/transformed/*.txt
<out>/docs/raw-ocr/*.json
<out>/docs/corpus-manifest.json
```

`page-window` 是推荐默认：只围绕 Fraser URL 的 `page=` 页码生成 OCR 文本，避免整本 PDF 扫描过慢。`--corpus-mode full` 会扫整本 PDF，只适合小文件或离线预处理。

导出后会生成：

```text
<out>/split/train/items.json
<out>/split/val/items.json
<out>/split/test/items.json
<out>/split/split_manifest.json
<out>/merged-skill.md
<out>/bridge-summary.json
```

`bridge-summary.json` 里会写出可直接复制执行的 SkillOpt 命令。形态如下：

```powershell
cd "C:\Users\ZhuanZ\Desktop\SkillOpt"
$env:OFFICEQA_DOCS_DIR = "<out>\docs"   # 使用 --build-local-text-corpus 或已有 docs corpus 时需要
python scripts/eval_only.py `
  --config configs/officeqa/default.yaml `
  --skill "<out>\merged-skill.md" `
  --split test `
  --split_dir "<out>\split" `
  --out_root "<out>\skillopt-eval-run"
```

桥接 item 字段约定：

- `question` 从每个 task 的 `instruction.md` 提取。
- `ground_truth` 从 task-pack 的 `private-answers/<UID>/answer.txt` 读取，只供 SkillOpt evaluator 使用；SkillOpt 的 OfficeQA prompt 不会把该字段发给目标模型。
- `source_docs` 从 `instruction.md` 的 Fraser URL 提取。
- `source_files` 把本地 PDF 文件名转换成同 stem 的 `.txt` 文件名，例如 `treasury_bulletin_1980_06.pdf` -> `treasury_bulletin_1980_06.txt`，以匹配 SkillOpt 的 parsed/text document corpus。
- `source_pdf_paths` 和 `page_hints` 是桥接脚本内部字段，用于可选本地 corpus 生成；SkillOpt prompt 不会把这些内部路径直接发给目标模型。

重要边界：

- 这个桥接脚本只是旁路评测入口，用来快速验证 SkillOpt 的交互式 OfficeQA rollout 是否优于 Auto-Evolve 当前 single-shot Direct Chat。
- 它不修改 task-pack、private answers、validator，也不改变 blank-opencode 主证明链路。
- 真正跑 SkillOpt 前仍需要确认 `SkillOpt` 的 `OFFICEQA_DOCS_DIR` / `env.data_dirs` 指向可用的 OfficeQA parsed/text corpus，否则 SkillOpt 只能看到 source hints，交互式检索优势发挥不出来。
- 本地文本 corpus 生成是 SkillOpt 旁路测试的材料适配层，不是 Direct Chat 的默认路径。Direct Chat 的“是否本地 OCR”仍由 `direct-chat` 自己的模型能力路由决定。

---

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

## 2026-06-19: Direct Chat 厂家配置纳入总控

Direct Chat 的厂家、模型、能力声明和默认选择现在统一放在：

```text
auto-evolve/config.json -> directChatConfig
```

这里可以直接配置：

- `defaultModelIDs`：默认跑哪些模型。
- `models`：各厂家模型的 API 地址、鉴权环境变量、OpenCode auth provider、上下文窗口、输出预算、图片/PDF 能力、单模型并发和厂家专用请求参数。
- `concurrency` / `retry`：Direct Chat 全局并发与重试策略。
- `ocrFallback`：本地 OCR 路由和缓存位置。
- `adapterID`、`officeqaMaterialMode`、`officeqaDocsDir`：数据集和 OfficeQA 材料模式。
- `allowOmittedMaterials`、`includeNoSkillBaseline`：材料遗漏和无 skill 对照策略。

统一读取优先级：

```text
命令行临时参数
  > config.json 的 directChatConfig
  > direct-chat-models.example.json 兼容配置
  > 代码默认值
```

因此以后使用通用 benchmark 运行 Direct Chat，只需要指定：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts `
  --task-pack-root "<task-pack>" `
  --train-split "<train-split>" `
  --test-split "<test-split>" `
  --eval-runner direct-chat
```

不再强制传 `--direct-chat-models-config`。独立入口 `run-direct-chat-eval.ts` 也不再强制传 `--models-config`；它会使用总控中的 `defaultModelIDs`。如果某次实验想临时换厂家或模型，仍可用 `--models`、`--direct-chat-models` 或外部 models config 覆盖，不会修改总控。

注意：总控只保存鉴权引用，例如 `apiKeyEnv` 或 `opencodeAuthProviderID`，不应把真实 API key 明文写进仓库。

### 无 Skill 基线提示隔离

本机 Codex OAuth 反代可通过 `codex-proxy-gpt-5-4-mini` 模型项接入 Direct Chat。它使用 `http://127.0.0.1:8318/v1`，账号由反代项目的同步守护进程自动跟随本机 Codex 登录切换；模型并发默认是 3。

GPT-5.4-mini 的 OfficeQA 对照实验使用同一份 SkillOpt 对齐 test-172 和官方 oracle 页面文本，分别保存 `no-skill` 与 `with-skill` 两组，不允许相互覆盖；反代当前默认推理强度为 `medium`。

`--no-skill-only` 现在使用独立的纯基线提示路径。该路径不会再注入空的 `<SKILL>` 区块，也不会出现 `follow the skill`、`expert guidance` 或 `DIRECT CHAT OVERRIDE AFTER SKILL` 等暗示。模型只收到通用初始说明、当前问题、当前材料和输出格式约束。

正式基线结果必须满足：

- `config.snapshot.json -> noSkillOnly = true`
- 结果目录模型名带 `__no-skill`
- 每题 `result.json -> skillMode = no-skill`
- `prompt.system.txt` 不包含 `<SKILL>` 或 skill 专用指令

带 skill 与无 skill 结果不得混合聚合。新测试集基线应保存独立的 split 快照和 cohort provenance，明确列出被排除的旧测试运行。

### Direct Chat 自动补跑临时故障

Direct Chat 整批首轮结束后，会自动筛选基础设施类临时失败并补跑，不再人工复制 UID。默认只补跑：

```text
network / timeout / rate_limit / provider_5xx
```

默认最多补跑 2 轮，每轮前等待 30 秒。`validation` 和 `answer_extraction` 不自动补跑，因为它们属于模型答案或输出问题，重复调用会不公平地增加答题次数。配置位置：

```text
auto-evolve/config.json -> directChatConfig.transientRecovery
```

每轮补跑前的原始文件会保存到 `transient-recovery-history/`，补跑审计保存在 `transient-recovery.json`。最终 `summary.json` 只统计补跑收口后的每题最终结果。

### 2026-06-21: Direct Chat Skill 层级与可信性硬门

Direct Chat 不再把多文件经验区按字母顺序拼接后静默截断。`buildSkillBundle()` 会生成完整归档和可选择的注入层级：

- `full`：把全部可发布经验内容完整注入。正式 SkillOpt 对齐实验默认使用这一模式。
- `head-tail`：只对 Skill 做显式头尾截取，中间插入截断标记；适合上下文较小的模型。
- `core-files`：完整注入 `INDEX.md` 和 `CORE.md`，不在文件内部裁切。

总控配置：

```json
{
  "directChatConfig": {
    "skillInput": {
      "mode": "full",
      "headRatio": 0.65
    }
  }
}
```

临时覆盖：

```powershell
bun run auto-evolve/scripts/run-direct-chat-eval.ts --skill-input-mode full <其他参数>
bun run auto-evolve/scripts/run-direct-chat-eval.ts --skill-input-mode head-tail <其他参数>
bun run auto-evolve/scripts/run-direct-chat-eval.ts --skill-input-mode core-files <其他参数>
```

关键规则：

- 问题全文和数据集 adapter 已发布的材料永远不在 prompt 层截断。
- `full` / `core-files` 放不下时，在第一条模型请求前失败，不自动降级。
- 只有显式选择 `head-tail` 时才允许截 Skill。
- 同一模型整批测试固定使用同一个层级，并按材料最大的题目预检。
- `run-preflight.json`、`config.snapshot.json`、`prompt-audit.json` 和逐题 `result.json` 会记录层级、hash、原始/注入 token 和截断状态。
- 可用 `--preflight-only` 对整批题目做容量检查，不调用目标模型。

当前总控已设置为全局 `full`，模型配置中没有单独的 `head-tail` 覆盖。`Qwen/Qwen3.5-4B` 的上下文按官方模型配置修正为 262,144 tokens；当前 OfficeQA 172 条中最重 prompt 预计 59,412 tokens，可以完整注入 110,754 字节的最终 Skill，无需截断。

OfficeQA `skillopt-oracle-json` 现在按 FRASER URL 的年月匹配本地文档，同一 PDF 的多个页码不会再按数组下标错配。单页 24,000 字符、总 oracle context 80,000 字符的发布上限与本机 SkillOpt 实现一致；URL 无法映射、parsed JSON 缺失或页面无文本会进入 `omittedSources` 并阻断正式运行。

总表只把 `summary.json -> validity.status=valid` 的来源视为正式完成。旧运行没有新预检证明时保留历史数据，但标记为 `legacy-unverified/invalid`，不能继续作为正式成功率。

### Direct Chat 命名运行模式

Direct Chat 现在支持在总控配置中定义命名模式，位置：

```text
auto-evolve/config.json -> directChatConfig.runModes
```

独立入口使用：

```powershell
bun run auto-evolve/scripts/run-direct-chat-eval.ts --run-mode skill-full <其他参数>
```

总控 benchmark 的 Direct Chat 测试使用：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts --eval-runner direct-chat --direct-chat-run-mode skill-full <其他参数>
```

当前内置模式：

- `skill-full`：正式技能评测。完整注入最终 skill；题目和材料必须完整保留。
- `skill-core`：紧凑技能评测。只注入 `core-files` 版本 skill；题目和材料必须完整保留。
- `skill-head-tail`：显式压缩技能评测。只允许压缩 skill 中段；题目和材料必须完整保留。
- `no-skill-full-materials`：无技能基线。不注入训练得到的 skill，只给任务提示和完整材料。
- `paired-skill-vs-noskill`：成对对照。同一批题同时跑完整 skill 和无 skill 基线。
- `native-pdf-skill-full`：原生材料链路。完整注入 skill，并使用数据集原始 PDF/材料路由能力。

优先级规则：命令行显式参数最高，例如 `--skill-input-mode`、`--officeqa-material-mode`、`--no-skill-only` 会覆盖 `--run-mode` 展开的默认行为；未传 `--run-mode` 时使用 `directChatConfig.defaultRunMode`。每次运行的 `config.snapshot.json` 会记录 `runModeID` 和 `runModeDescription`，后续查历史时不用再反推当时到底是带 skill、无 skill 还是 paired。

### Direct Chat 统一总表自动汇总

每次 `runDirectChatEvaluation()` 完成临时故障补跑并写出本次 `summary.json/csv/md` 后，系统会自动刷新统一 Excel 总表：

```text
auto-evolve/runtime-state/direct-chat-reports/direct-chat-evaluation-master.xlsx
```

刷新脚本：

```text
auto-evolve/scripts/update-direct-chat-master-report.py
```

它会扫描 `runtime-state/direct-chat-runs/` 下所有已经完成且存在 `summary.json` 的运行。原始运行目录和各自的 summary 文件保持不变；统一总表只是追加式总账视图。刷新采用文件锁、同目录临时文件和原子替换，多个 Direct Chat 进程同时结束时不会互相覆盖。总表更新失败只会在当前运行目录留下 `master-report-update-error.log`，不会把已经完成的模型评测改判为失败。

总表工作表：

- `Dashboard`：总运行数、逐题结果数、正式实验数量和正式成功率图。
- `Official Experiments`：经过明确来源组合的正式实验总结果。
- `Run Ledger`：每个运行、模型占一行；正式整批、子集、烟测、补跑、旧聚合全部保留并分类。
- `Case Results`：所有历史运行的逐题结果，不因后续补跑而删除旧行。
- `Official Case Results`：正式组合实验按 UID 收口后的结果；来源顺序靠后的补跑覆盖同 UID 的旧基础设施失败。
- `Errors`：所有模型答错、解析失败和供应商基础设施失败。
- `Fields`：字段与状态说明。

正式组合实验及补跑覆盖顺序配置在：

```text
auto-evolve/direct-chat-master-report.json
```

普通新运行不需要修改这个配置，也会自动进入 `Run Ledger` 和 `Case Results`。只有需要在论文或正式报告中把主跑与多个补跑合成一个最终成功率时，才需要新增一个 `experiments` 配置项。验证总表结构和当前正式数字：

```powershell
python auto-evolve/scripts/smoke-direct-chat-master-report.py
```

总表鲁棒性规则：

- 损坏的 `summary.json`、`config.snapshot.json` 或单题 `result.json` 不会打崩整张表；对应运行会进入警告行或 `result_json_read_error`。
- 正式组合默认使用 `replacePolicy: prefer-non-infrastructure`。后续补跑如果仍是额度、鉴权、网络、超时等基础设施失败，不会覆盖先前已有的真实模型结果。
- 组合实验可用 `modelIDs`、`providers`、`skillModes` 显式限制来源，防止同一运行目录中的多模型或带/不带 skill 结果串线。
- 模型输出会移除 Excel 不允许的控制字符，限制超长单元格，并把 `= / + / - / @` 开头的文本按普通文本写入，防止公式注入。
- `Case Results`、`Official Case Results` 和 `Errors` 超过单个 Excel Sheet 容量时自动拆成续表，不丢弃历史记录。
- 如果用户正在 Excel 中打开总表，刷新结果会先保存到 `direct-chat-evaluation-master.pending.xlsx`，状态写入 `master-report-status.json`。关闭 Excel 后，下一次刷新会自动转正，不会覆盖或丢失已完成测试。
- 生成过程使用跨进程锁、过期锁回收、临时文件和原子替换；多个测试同时结束时按顺序刷新。

独立入口支持 `--resume-existing`：同一输出目录恢复时，已有 `result.json` 的题目不会重跑；整批补齐后仍会自动处理其中的临时基础设施失败。统一 benchmark 的 Direct Chat 测试默认开启该断点续跑能力。

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
