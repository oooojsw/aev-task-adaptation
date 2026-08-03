> 本文件由原 `README.md` 按主题拆分而来，正文尽量保留原文。
> 本文件负责：历史变更记录、日期化补丁说明、旧事故与修复脉络；用于保留原始上下文。

原始完整备份：`README-FULL-ARCHIVE-20260709-015413.md`。


<!-- 原 README 行 926-1450 -->

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


<!-- 原 README 行 1451-1784 -->


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


<!-- 原 README 行 2128-2411 -->

## Skill Structure Profile Hard Gate

AEV supports a pluggable hard gate for generated skill / expert-workspace structure.

- Validator script: `auto-evolve/scripts/validate-skill-structure-profile.ts`
- Example validator profile: `auto-evolve/task-packs/validator-profiles/skill-surface/standard-hard-v1.json`
- Example structure profile: `auto-evolve/task-packs/validator-profiles/skill-surface/profiles/standard-structure-v1.json`
- Smoke test: `bun run auto-evolve/scripts/smoke-skill-structure-profile.ts`

The hard gate is intended for objective structure checks only: required files, required directories, allowed file globs, Markdown headings, JSON parseability, and required JSON keys. It should be mounted through `validatorProfiles` with `validation.target = "layout"` and `validation.stage = "pre_blank"` so it runs after Lead writes the pending skill and before Blank Eval starts. Soft skill-quality review remains a separate future validator and should not be mixed into this hard gate.

`auto-evolve/config.json` also has a global `validationConfig` control plane. Validator modules stay under `task-packs/validator-profiles`, and the config can select named profile sets without editing every dataset spec. The default config defines `skill-structure-standard` but leaves `enabledProfileSets` empty to avoid suddenly blocking older experiments. To enable the standard skill structure hard gate globally, set:

```json
"validationConfig": {
  "enabled": true,
  "enabledProfileSets": ["skill-structure-standard"]
}
```

Task-local `validatorProfiles` still work and are merged with global profiles. The global config is appended at spec load time, so original task-pack files remain clean and benchmark history/base spec paths are not rewritten.

### Paper-Review Surface Generalization Profile (2026-06-30)

Paper-review now has a dataset-specific pluggable surface gate. The general rule is: the platform owns the slot, while each dataset owns its leak rules. Do not turn this into a universal regex validator for every benchmark.

The paper-review module is:

```text
task-packs/validator-profiles/paper-review/surface-generalization-v1.json
task-packs/validator-profiles/paper-review/profiles/surface-generalization-v1.json
task-packs/validator-profiles/paper-review/surface-generalization-v2.json
task-packs/validator-profiles/paper-review/profiles/surface-generalization-v2.json
scripts/validate-paper-review-surface-generalization.ts
```

It is a `target = surface`, `stage = pre_blank`, `answerAccess = none`, blocking hard validator. It scans the formal skill surface, including file names and script/config files, before Blank Eval starts. It blocks paper-review task IDs, private/gold/oracle answer-source words, concrete final rating leaks, and obvious single-paper names/methods/datasets from the current paper-review learnbench. It does not block generic rating rubric text such as explaining what `Borderline` means.

The no-surface baseline remains available through `paper-review/train-v1`. The surface-enabled local profile is `paper-review/train-v2`, which now adds `paper-review/surface-generalization-v2` before the existing hard/soft product validators. `surface-generalization-v1` is preserved only as a rollback/reference profile.

Surface v2 accepted the useful part of the long-context design proposal: a fuller six-paper high-risk term list, explicit `forbiddenLiterals`, word-window contextual checks, and warning/block severity separation. It deliberately does **not** ban rating labels or generic output-format instructions. For example, "the final answer should include one Paper Rating selected from the standard rubric" is valid; "output Borderline as the final answer" is not. It also deliberately did **not** enable "warnings >= 3 means blocking" by default, because table/figure and baseline examples can be legitimate generic review guidance. Soft surface validation is not enabled yet; it is a later optional module because it costs model calls and needs separate result-routing discipline.

The global config also defines an opt-in profile set:

```json
"paper-review-surface-generalization": {
  "validatorProfiles": ["paper-review/surface-generalization-v2"],
  "blankEvalValidatorProfiles": []
}
```

It is intentionally not enabled by default. For a paper-review surface branch, enable that set in `validationConfig.enabledProfileSets` or with `AUTO_EVOLVE_VALIDATION_PROFILE_SETS=paper-review-surface-generalization`. Keep old no-surface runs as comparison baselines.

Smoke:

```powershell
bun run auto-evolve/scripts/smoke-paper-review-surface-validator.ts
bun run auto-evolve/scripts/smoke-validation-config-profiles.ts
bun run auto-evolve/scripts/smoke-skill-structure-profile.ts
```
## 2026-07-01 可拔插 Merge Contract

Multi-instance flat merge / train-replay repair 现在采用“通用 prompt + 可拔插 merge contract”的结构。默认 `methods/recipes/multi-instance/prompts/merge.md` 与 `merge-repair.md` 必须保持数据集无关，不能写死 audit-point、OfficeQA、SpreadsheetBench、paper-review 等专用输出路径或领域模板。

任务差异通过 `auto-evolve/config.json > mergeConfig` 控制：

```json
"mergeConfig": {
  "contractsRoot": "task-packs/merge-contracts",
  "defaultContract": "generic/standard-skill-v1",
  "taskPackContracts": {
    "paper-review-learnbench": "paper-review/review-skill-v1"
  }
}
```

新增数据集时，优先新增小型 JSON contract，并在 `taskPackContracts` 中挂载；不要复制整份专用 merge prompt。Contract 负责说明 required files、文件职责、CORE headings、final product、repair policy 和禁止跨数据集污染词。合并器和修复器会把 contract 注入 prompt，并把 contract 文件加入只读权限。

分层合并 `--merge-strategy hierarchical` 也走同一套 contract。`mergeConfig.defaultHierarchicalPrompt` 和 `defaultHierarchicalRepairPrompt` 只控制分层合并流程本身；每一层 group 应该产出哪些文件、哪些字段、哪些文件可 append-only 或 rewrite，都由同一个 `mergeContractPath` 决定。这样 flat merge 和 hierarchical merge 不会再分裂成两套任务专用 prompt。

### Merge Acceptance Profile

合并后验收现在也有可拔插 profile 层。三层职责必须分开：

- `merge contract` 管最终 skill 长什么样。
- `merge generator` 管 flat / hierarchical 怎么合并。
- `merge acceptance profile` 管合并后验收到哪一步。

总控位置：

```json
"mergeConfig": {
  "defaultAcceptanceProfile": "repair_promote",
  "acceptanceProfiles": {
    "merge_only": {},
    "replay_report": {},
    "repair_promote": {},
    "final_replay": {},
    "strict_all_pass": {}
  }
}
```

CLI 可覆盖：

```powershell
bun run auto-evolve/scripts/run-benchmark-orchestrator.ts ... --merge-acceptance-profile strict_all_pass
```

优先级从高到低是：

1. `--merge-acceptance-stages`
2. `--merge-acceptance-preset`
3. `--merge-acceptance-profile`
4. `mergeConfig.defaultAcceptanceProfile`
5. 旧字段 `mergeConfig.acceptancePreset`

大白话：以后想“只合并”“回撤一次就停”“repair 后作为新基线”“最后必须全量回撤全过”，优先换 profile，不要再复制 prompt 或写一份数据集专用合并脚本。Scorecard / final report 会记录实际使用的 `mergeAcceptanceProfile`、`mergeAcceptanceStages` 和 `mergeAcceptanceSuccessCriterion`。
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

## Merge Replay Policy (2026-07-06)

`single / sequence / parallel` are execution modes only. They decide how a selected batch of blank-agent cases runs, but they do not decide which cases should be tested next.

`merge-as-long-task` now mounts a replay policy above `blank_eval_plan`:

```json
"replayPolicy": {
  "strategy": "failures_then_regression",
  "statePath": "./materials/.blank-eval-replay-policy/merged-skill-blank-eval-plan.json"
}
```

Plain meaning:

- First pass tests the full replay set covered by the current merge group.
- If some cases fail, the next final-acceptance round tests only those failed cases.
- Once those failed cases pass, the same validator immediately regression-tests the previously passed/protected cases.
- If protected cases regress, those regressed cases become the next focused failed set.
- A merge group is accepted only when the focused failures pass and the protected regression set also passes.

This keeps the expensive blank-agent replay focused during repair, without losing the guarantee that previously successful cases were not broken.

The replay policy state must stay under the replay plan directory. Paths such as `../outside.json` or absolute paths that escape the plan directory are rejected before any state file is read or written.

Smoke:

```powershell
bun run auto-evolve/scripts/smoke-merge-replay-policy.ts
```



<!-- 原 README 行 2412-2664 -->

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

## 论文级实验账本（2026-07-07）

每个 benchmark run 或 Direct Chat run 现在会自动生成一份统一实验账本：

```text
<run>/experiment-ledger/
```

它不是替代 `orchestrator-state.json`、每题 `result.json`、campaign 轨迹或 blank-eval 证据，而是把论文/复现实验最需要的字段集中成一份“总账”。主要文件包括：

- `experiment-manifest.json`：本次实验的来源、数据集、split、代码 commit、运行目录和关键配置摘要。
- `config-fingerprint.json`：模型、并发、轮次、合并策略、验证策略、Direct Chat 模式等配置指纹。
- `dataset-splits.json`：train/test/baseline 的 UID 清单和 split hash。
- `task-results.jsonl`：每个 case 的状态、是否通过、模型、skill 模式、材料模式、token、耗时和证据路径。
- `cost-ledger.jsonl`：按调用/任务记录 token 与耗时；Direct Chat 优先使用 provider 返回的 token。
- `run-summary.json` / `paper-table-ready.csv`：汇总成功率、baseline 对比、token 成本和可比性 warning，方便直接做论文表格。

自动刷新入口：

- `run-benchmark-orchestrator.ts` 每次保存外层状态时会旁路刷新账本；账本失败只写 `experiment-ledger-update-error.log`，不打断训练。
- `run-direct-chat-eval.ts` 在评测完成后刷新账本。
- 也可以手动刷新：

```powershell
bun run auto-evolve/scripts/update-experiment-ledger.ts --out "auto-evolve/runtime-state/benchmark-runs/<run-id>"
bun run auto-evolve/scripts/update-experiment-ledger.ts --out "auto-evolve/runtime-state/direct-chat-runs/<run-id>"
```

大白话：以后写论文时，不要只看零散 scorecard 或聊天记录。先看 `experiment-ledger/run-summary.json` 和 `paper-table-ready.csv`，再回到原始 evidence 解释失败案例。

合并结果口径也会进入账本：`mergePath` 使用正式名称 `merge-as-old` / `merge-as-long-task` / `merge-both-smoke`，`internalMergeMode` 保留代码内部名 `legacy_script` / `long_task` / `both_smoke`。不要在论文表格里混用内部名和正式实验名。

烟测：

```powershell
bun --check auto-evolve/orchestrator/experiment-ledger/contract.ts auto-evolve/orchestrator/experiment-ledger/writer.ts auto-evolve/scripts/update-experiment-ledger.ts auto-evolve/scripts/smoke-experiment-ledger.ts
bun run auto-evolve/scripts/smoke-experiment-ledger.ts
```

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

## OpenCode 工具媒体能力硬门（2026-08-03）

OpenCode 在把 `read` 等工具产生的图片、PDF、音频或视频附件送入模型前，现在同时检查两层能力：供应商传输通道是否支持工具媒体，以及当前具体模型是否声明支持对应输入类型。文本模型（例如当前配置为纯文本的 MiniMax M2.7）不会再因为供应商协议本身支持附件，就被错误发送图片或 PDF；不支持的附件会被替换为明确的文本提示。视觉模型原有的图片传递行为保持不变。

本次修复同时覆盖两条入口：session 工具结果组装，以及 provider 发送前的最终防御过滤。AEV 默认 OpenCode 二进制已更新，替换前版本保存在 `packages/opencode/node_modules/opencode-windows-x64/bin/opencode.exe.pre-media-capability-20260803.bak`，便于紧急回滚。

真实 OfficeQA 单题烟测随后补出了两项运行侧兼容保护：

- 私有模型缓存中的 `doc`、界面标签等展示元数据不能整包写入运行时 `opencode.json`；现在只物化 OpenCode provider schema 接受的核心字段，避免严格配置校验在模型启动前失败。
- 明确授权的可编辑目录可能在会话启动时尚未创建；现在这种路径仍只以自身为安全边界，但会同时允许其后代文件，避免 agent 能创建目录却不能写入目录内产物。

烟测使用 OfficeQA UID0001 的真实 78 页 Treasury Bulletin 扫描 PDF。MiniMax M2.7 成功启动，没有接收不支持的图片/PDF输入，而是自动改走 PyMuPDF 与本地 Tesseract OCR；因此媒体硬门和纯文本降级链路已得到真实验证。该题后续因历史扫描表格定位困难和旧编辑目录权限问题产生大量 OCR 调用，在约 8.3 万 token 时主动止损，不能把这次烟测记为题目验证通过。
