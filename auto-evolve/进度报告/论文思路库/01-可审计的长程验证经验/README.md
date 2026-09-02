# 思路一：可审计的长程验证经验

## 一句话定位

Auto-Evolve 先生产经过验证、可回查来源的长程案例经验，再把经验合并成可部署 Skill；它研究的是经验如何形成、如何验收和何时能迁移，而不是宣称所有模型都会变强。

## 现有论文入口

当前投稿式初稿保持在原位置，不能在本目录复制或覆盖：

- 可编辑论文源：`../../2026-08-16-Auto-Evolve论文初稿/submission-v0.2/Auto-Evolve-submission-v0.2.html`
- PDF：`../../2026-08-16-Auto-Evolve论文初稿/submission-v0.2/Auto-Evolve-submission-v0.2.pdf`
- 主写作稿：`../../2026-08-16-Auto-Evolve论文初稿/submission-v0.2/paper_rewriting_output/journal_cn/paper.cn.md`
- 交接说明：`../../2026-08-16-Auto-Evolve论文初稿/submission-v0.2/交接说明-给下一个Agent.md`

## 已有主张

- 在 OfficeQA 固定单轮、无工具、Oracle 文本口径下，AEV 产物在 GPT-5.4-mini、GPT-5.4、GPT-5.5 三个消费者上优于同为 MiniMax M2.7 训练来源的原生 `optMiniMax M2.7 Skill`。
- 在 SpreadsheetBench 修正 cohort 上，`merge-as-old` 在 GPT-5.4-mini 和 GPT-5.4 条件下优于 `optMiniMax M2.7 Skill`。
- MiniMax M2.7 与最新 Qwen 结果显示效果存在明显消费者边界；这不是“所有模型都提升”的论文。

## 与思路二的关系

思路一研究“可审计经验是否形成有用 Skill”。思路二单独研究“增加长程验证计算能否弥补较弱生产模型”。两者可以共享部分数据，但不能混用结论。
