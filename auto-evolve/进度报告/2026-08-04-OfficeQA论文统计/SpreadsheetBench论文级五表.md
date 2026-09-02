# SpreadsheetBench 论文级五表

统一口径：官方 test 280；使用 SkillOpt 原生 SpreadsheetBench 执行与裁判链路。平台/裁判崩溃不算模型答错，逐题比较只使用双方共同有效的题。

## 表 1：总矩阵

| 测试模型 | 无 Skill | AEV merge-as-old | optMiniMax M2.7 Skill | SkillOpt 官方 Skill |
|---|---:|---:|---:|---:|
| GPT-5.4-mini | 67/276 = 24.28% [19.59%, 29.66%] | 83/276 = 30.07% [24.97%, 35.73%] | 76/276 = 27.54% [22.60%, 33.09%] | 110/276 = 39.86% [34.26%, 45.73%] |
| GPT-5.4 | 62/278 = 22.30% [17.81%, 27.55%] | 87/278 = 31.29% [26.13%, 36.97%] | 69/278 = 24.82% [20.11%, 30.22%] | 119/278 = 42.81% [37.13%, 48.68%] |

## 表 2：关键配对结论

| 测试模型 | 对比 | 共同有效题数 | 净提升 | 提升百分点 | 95% 配对区间 | McNemar p | Holm p |
|---|---|---:|---:|---:|---:|---:|---:|
| GPT-5.4-mini | AEV merge-as-old vs 无 Skill | 276 | +16 | +5.80% | [1.81%, 9.78%] | 0.007 | 0.028 |
| GPT-5.4-mini | optMiniMax M2.7 Skill vs 无 Skill | 277 | +9 | +3.25% | [0.00%, 6.50%] | 0.07835 | 0.2351 |
| GPT-5.4-mini | SkillOpt 官方 Skill vs 无 Skill | 276 | +43 | +15.58% | [10.14%, 21.01%] | 3.382e-08 | 3.044e-07 |
| GPT-5.4-mini | optMiniMax M2.7 Skill vs AEV merge-as-old | 277 | -7 | -2.53% | [-6.86%, 2.17%] | 0.3489 | 0.4201 |
| GPT-5.4-mini | SkillOpt 官方 Skill vs AEV merge-as-old | 277 | +27 | +9.75% | [4.69%, 14.80%] | 0.0002685 | 0.001611 |
| GPT-5.4 | AEV merge-as-old vs 无 Skill | 278 | +25 | +8.99% | [5.04%, 13.31%] | 4.126e-05 | 0.0002888 |
| GPT-5.4 | optMiniMax M2.7 Skill vs 无 Skill | 278 | +7 | +2.52% | [-0.72%, 5.76%] | 0.21 | 0.4201 |
| GPT-5.4 | SkillOpt 官方 Skill vs 无 Skill | 278 | +57 | +20.50% | [15.11%, 25.90%] | 3.231e-12 | 3.231e-11 |
| GPT-5.4 | optMiniMax M2.7 Skill vs AEV merge-as-old | 278 | -18 | -6.47% | [-10.07%, -2.88%] | 0.0009122 | 0.004561 |
| GPT-5.4 | SkillOpt 官方 Skill vs AEV merge-as-old | 278 | +32 | +11.51% | [6.47%, 16.55%] | 1.401e-05 | 0.0001121 |

## 表 3：逐题差异

完整逐题配对共 2773 行，见 `SpreadsheetBench表3-逐题配对明细.csv`。

## 表 4：基础设施审计

共记录 19 个运行-题目级基础设施失败。`60-7` 与 `283-32` 是 SkillOpt 自身裁判解析答案位置时崩溃，并非模型答错；其他为超时或 Windows 编码错误。

## 表 5：训练成本

SkillOpt 的 optMiniMax 训练完整记录为 4,723,319 tokens、1,018 次调用、4.55 小时。AEV 历史 SpreadsheetBench 训练与 merge-as-old 没有完整 token 记录，因此标记未知。

## 大白话结论

- AEV merge-as-old 相比无 Skill，在 GPT-5.4-mini 和 GPT-5.4 上都明显更好，说明 AEV 训练出的经验可以跨测试模型发挥作用。
- SkillOpt 官方 GPT-5.5 Skill 在这两个测试模型上分数最高，但它的训练模型和训练成本与 AEV 不同，不能把这一列直接写成合并算法胜负。
- 同训练模型的公平比较应优先看 AEV merge-as-old 与 optMiniMax M2.7 Skill；详细显著性以表 2 为准。
- GPT-5.5 的 SpreadsheetBench 四组矩阵没有补齐，但对论文当前核心结论不是必要条件；已有两个完整测试模型比继续烧 784 次调用更划算。
