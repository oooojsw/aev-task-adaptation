> 本文件由原 README.md 按主题拆分而来，正文尽量保留原文。
> 本文件负责：Benchmark 数据集、SpreadsheetBench、OfficeQA、Direct Chat、训练/回撤/测试口径。

原始完整备份：README-FULL-ARCHIVE-20260709-015413.md。

<!-- 原 README 行 566-749 -->

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

\n

<!-- 原 README 行 1000-1647 -->

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

\n

<!-- 原 README 行 1795-1926 -->

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

\n

<!-- 原 README 行 2500-2518 -->

## Benchmark Campaign Rounds Resume Guard (2026-07-06)

When resuming an existing benchmark run, `run-benchmark-orchestrator.ts` must not silently fall back to the task-pack's original `tasks/<id>/campaign.json` round count. Existing runs may contain run-local `campaign-spec-overrides/<id>.campaign.json` files, and those overrides are the run's active training contract.

Current rule:

- Explicit `--campaign-rounds` / `--rounds` wins.
- If not provided, the orchestrator infers the round count from existing `<out>/campaign-spec-overrides/*.campaign.json`.
- If no override exists, the benchmark default campaign round count is `7`.

Plain-language reason: if a run previously trained with 7 rounds, a later breakpoint resume must continue with 7 rounds. It must not start new fill-in campaigns with the raw task-pack default of 3 rounds, because that creates a split bloodline and wastes model quota.

Smoke:

```powershell
bun --check auto-evolve/scripts/run-benchmark-orchestrator.ts auto-evolve/scripts/smoke-benchmark-supervisor.ts
bun run auto-evolve/scripts/smoke-benchmark-supervisor.ts
```

\n