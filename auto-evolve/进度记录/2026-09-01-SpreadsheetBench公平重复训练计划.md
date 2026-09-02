# SpreadsheetBench 公平重复训练计划

## 目的

这次只补论文所需的 AEV `merge-as-opt` 训练稳定性证据，不改动 AEV 长程训练主线，也不改写任何旧结果。

## 固定条件

- 生产模型：MiniMax M2.7（沿用 AEV 私有配置快照的 Coding Plan 凭据）。
- 输入经验：原 SpreadsheetBench 训练中 69 份 `verified_success` 的冻结 AEV Skill，只读使用。
- SkillOpt 划分：官方 train80 / val40 / test280；训练只读 train80 与 val40，test280 不进入训练。
- 合并方式：现有 `runSkillOptMerger` 的原生 `native_train` / `merge-as-opt` 流程。
- 每次训练：4 epoch、8 step、batch 40、target workers 2。

## 执行与报告

1. 在三个独立输出目录依次训练三次；任何失败停止序列，不能静默跳过。
2. 每次启动前记录 69 个源 Skill 的文件树 SHA-256，防止训练输入被悄悄改变。
3. 训练完成后，三个 Skill 将在同一个固定评测器和同一官方 test280 上分别测试。
4. 论文报告全部三次结果、平均值、标准差和最低值；禁止再用“三次取最高”作为稳定性结论。

## 隔离边界

- 新序列：`runtime-state/experiment-sequences/20260901-spreadsheetbench-fair-aev-mergeopt-repeats`。
- 新输出：`runtime-state/benchmark-runs/20260901-spreadsheetbench-fair-aev-mergeopt-repeats-repeat-01..03`。
- 旧的 `20260811-*` 训练和 AEV 主训练均保持不动。
