# 20260413 try4 专家经验学习与 deployment 验收真实实验计划

## 目标

- 用真实材料 `1 个 Excel + 2 个专家成品 Word + 2 个空模板 Word` 跑一轮新的长程任务。
- 长程任务本身不直接把领域步骤硬编码进执行层，而是输出一套正式结构合法的专家经验工作区。
- 最终是否算成功，不由“平台里看起来差不多”决定，而由更高层的 deployment acceptance 决定：
  - 一个空白 agent
  - 只读正式专家经验 + 正式能力资产 + Excel + 空模板
  - 单 session 从头到尾生成两个 Word 成品
- 最终文档不要求和专家成品逐字相同，但要求：
  - 目标文件存在
  - 没有占位符残留
  - 关键数据高度一致
  - 整体内容在意义层面足够接近

## 设计原则

- 不在 orchestrator 内部写死“先读 Excel、再读 Word、再写模板”的任务专用流程。
- 任务专用知识只存在于 task pack 本身，作为输入/材料/验收配置，而不是代码路径。
- deployment acceptance 作为抽象验收框架的一个高等级实例接入，而不是另起一套任务专用执行器。
- 最终交付面 = 正式专家经验工作区 + 正式能力资产；影子经验、runtime-state、candidate 包都不暴露给 blank agent。

## 本轮实施

1. 补强已有 Word 对比 validator  
   从“近似文本相同”升级到“数据一致 + 内容大体相似”，允许措辞和版面微差。

2. 新建真实 task pack `try4-expert-bootstrap`  
   - 学习材料：Excel、2 个成品 doc、2 个空模板 docx
   - 正式能力资产：`minimax-docx`、`minimax-xlsx`
   - 目标：生成正式专家经验工作区

3. 新建 deployment spec  
   只给 blank agent：
   - 正式专家经验工作区
   - 正式能力资产
   - Excel
   - 空模板
   然后用脚本 validator 做最终验收。

4. 真实跑通并修 bug  
   - 先跑 smoke
   - 再跑真实 long-task
   - 中途如果暴露系统级 bug，直接修复
   - 不补任务专用脚手架

## 成功判据

- 长程任务本体 `verified_success`
- completion validator 里的 blank-agent deployment acceptance 通过
- 生成的 2 份 Word：
  - 存在
  - 无占位符
  - 与专家成品在数字覆盖和整体内容上满足阈值
