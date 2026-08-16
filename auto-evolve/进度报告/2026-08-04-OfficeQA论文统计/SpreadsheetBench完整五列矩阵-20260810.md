# SpreadsheetBench 完整五列矩阵

统一测试口径：官方 test 280、SkillOpt 原生多轮工具模式、`max_turns=30`。GPT-5.4-mini 沿用既有固定公平队列 276 题，GPT-5.4 沿用既有固定公平队列 278 题，GPT-5.5 按既有表述使用原始 280 题。

| 测试模型 | 无 Skill | AEV merge-as-old | optMiniMax M2.7 Skill | AEV merge-as-opt | SkillOpt 官方 Skill |
|---|---:|---:|---:|---:|---:|
| GPT-5.4-mini | 67/276 = **24.28%** | 83/276 = **30.07%** | 76/276 = **27.54%** | 80/276 = **28.99%** | 110/276 = **39.86%** |
| GPT-5.4 | 62/278 = **22.30%** | 87/278 = **31.29%** | 69/278 = **24.82%** | 106/278 = **38.13%** | 119/278 = **42.81%** |
| GPT-5.5 | 69/280 = **24.64%** | 96/280 = **34.29%** | 80/280 = **28.57%** | 126/280 = **45.00%** | 146/280 = **52.14%** |
| MiniMax M2.7 | 67/280 = **23.93%** | 83/280 = **29.64%** | 73/280 = **26.07%** | 98/280 = **35.00%** | 89/280 = **31.79%** |

## 口径与基础设施说明

- GPT-5.4-mini 固定排除既有 4 个基础设施异常 UID：`516-46`、`60-7`、`283-32`、`53161`。新 merge-as-opt 条件中的任务超时按模型失败保留，不额外缩小分母。
- GPT-5.4 固定排除既有 2 个基础设施异常 UID：`60-7`、`283-32`。
- GPT-5.5 按原表要求使用原始 280 题，不做公平队列缩减。
- MiniMax M2.7 行统一使用修复后的当前评测器和官方 280 题。旧评测器会在 `answer_sheet` 为空且答案位置写成 `H2:H8` 这类裸范围时解析出零个单元格，并因空循环错误判为通过；该问题影响 161/280 题，旧 MiniMax 行及三次运行最初显示的异常高分全部作废。
- 修复后的评测器会把裸范围映射到标准答案工作簿的第一个工作表，并对零范围、零单元格、缺失工作表全部 fail closed。无 Skill、AEV merge-as-old、optMiniMax M2.7 Skill、SkillOpt 官方 Skill均在修复后重新得到完整 280 题结果；AEV merge-as-opt 三次 Skill 的修正分数为 repeat01 `98/280`、repeat02 `71/280`、repeat03 `57/280`，按预设“三次取最高”规则采用 repeat01。
- SkillOpt 官方 Skill 首轮有 19 个 MiniMax 传输失败（8 个 SSL EOF、10 个连接拒绝、1 个连接重置）。系统保留原账本备份，只移除这 19 条基础设施失败并定向补跑；最终为 280 个唯一 UID、`llm_ok=false` 为 0。
- 运行中曾出现 GPT-5.4 的 132 条和 GPT-5.5 merge-as-old 的 152 条上游 HTTP 502 EOF。系统已立即停止，备份原账本，只移除这些基础设施失败后断点续跑；最终六个补缺条件均为 280 个唯一 UID，结果账本中残留 `llm-call-failed` 为 0。

## 结果目录

- GPT-5.4-mini merge-as-opt：`C:\Users\ZhuanZ\Desktop\SkillOpt\outputs\spreadsheetbench-gpt54mini-mergeopt-63384-20260809`
- GPT-5.4 merge-as-opt：`C:\Users\ZhuanZ\Desktop\SkillOpt\outputs\spreadsheetbench-gpt54-mergeopt-63384-20260809`
- GPT-5.5 merge-as-old：`C:\Users\ZhuanZ\Desktop\SkillOpt\outputs\spreadsheetbench-gpt55-aev-minimax-m27-skill-63384-20260722`
- GPT-5.5 optMiniMax M2.7：`C:\Users\ZhuanZ\Desktop\SkillOpt\outputs\spreadsheetbench-gpt55-optminimax-m27-skill-63384-20260722`
- GPT-5.5 merge-as-opt：`C:\Users\ZhuanZ\Desktop\SkillOpt\outputs\spreadsheetbench-gpt55-mergeopt-63384-20260809`
- GPT-5.5 SkillOpt 官方 Skill：`C:\Users\ZhuanZ\Desktop\SkillOpt\outputs\spreadsheetbench-gpt55-skillopt-official-gpt55-skill-63384-20260722`
- MiniMax M2.7 无 Skill：`C:\Users\ZhuanZ\Desktop\SkillOpt\outputs\spreadsheetbench-minimax27-current-runtime-noskill-20260815`
- MiniMax M2.7 修复后对照组（AEV merge-as-old、optMiniMax M2.7、SkillOpt 官方）：`C:\Users\ZhuanZ\Desktop\SkillOpt\outputs\spreadsheetbench-minimax27-corrected-controls-20260815`
- MiniMax M2.7 AEV merge-as-opt 三次运行：`C:\Users\ZhuanZ\Desktop\SkillOpt\outputs\spreadsheetbench-three-repeat-minimax27-test280-20260814`
