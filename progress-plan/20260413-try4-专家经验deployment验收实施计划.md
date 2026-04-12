# 20260413 try4 专家经验 deployment 验收实施计划

## 目标

把当前系统升级到可以承接下面这类任务：

- 学习输入：一个 Excel、两个专家完成版 Word、两个空白 Word 模版、已有格式规则说明、可选脚本能力包
- 学习输出：一版正式可读的专家经验工作区
- 最终最高验收：一个空白 agent 只能读取正式允许内容与材料时，能够在单 session 中从 Excel + Word 模版直接跑到目标 Word 产物

本次重点是：

- 不做 try4 专用生成器
- 不把领域步骤硬编码进执行层
- 把 blank-agent deployment 验收升级成可复用系统能力

## 本次系统级改造

### 1. 补通用 deployment harness

新增一套面向任务包的 blank-agent deployment harness：

- 输入：正式允许内容、材料、目标路径、可编辑路径、通用 capability、deployment validators
- 运行：一个空白 agent 单 session 独立执行
- 输出：标准 acceptance record + deployment run artifact

这套 harness 不依赖短程 case 结构，也不依赖 try4 私有逻辑。

### 2. 补通用专家经验 workspace 校验器

新增一个脚本型 validator，用于校验：

- 经验工作区结构是否合法
- 是否有 entry/change_log
- 是否混入非法文件

该校验器既能给长程学习任务用，也能给后续 candidate / canonical 验收复用。

### 3. 补通用 Word 产物验收器

围绕 Word 产物增加抽象、可配置、非任务专用的脚本型 validator：

- 目标文件存在校验
- 占位符残留校验
- 参考成品文本对齐校验

实现原则：

- 脚本本身通用
- task-specific 只放在 mapping/config 数据文件里
- 不把某个任务的填充规则写死到 validator 代码里

### 4. 用长程任务直接学习专家经验

新建一个隔离 task pack：

- 材料中包含 Excel、两个专家成品、两个空白模版、旧格式总结、技能包
- target/editable 指向 pack 内隔离 expert workspace
- 长程任务的 completion validator 直接接 deployment harness

也就是说，这个长程任务不是“生成目标 Word 就结束”，而是：

- 先长出专家经验
- 再用 blank-agent deployment 验收去验证这版专家经验是否真的能独立执行

## try4 实验策略

### 阶段 A：构建隔离 pack

- 从 `C:\Users\ZhuanZ\Desktop\try4 - 副本` 同步必要材料到工作区 task pack
- 保留原始材料，不在源目录内试错
- 生成 deployment validator 所需的 reference config / reference normalization 产物

### 阶段 B：长程学习

- 从空 expert workspace 种子开始
- 只给 agent 材料、目标、capabilities、validators
- 允许它生成专家经验文档与必要的正式允许辅助文件

### 阶段 C：blank-agent deployment 验收

- deployment harness 只读取：
  - pack 内正式 expert workspace
  - pack 内正式允许 capability surface
  - 原始任务材料
- 不读取：
  - runtime-state
  - shadow memory
  - candidate package
  - maintenance request
  - 历史 run 记录

### 阶段 D：回归修复

如果 deployment acceptance 不通过：

- 优先修系统级抽象 bug
- 其次修 validator/harness 接缝问题
- 最后才考虑 pack 内提示词或任务数据组织问题

不做：

- 直接替任务写死 Excel -> Word 专用生成脚本
- 直接把领域步骤塞进 orchestrator 代码

## 通过标准

本次通过标准分三层：

1. 学习长程任务本身能稳定跑完，输出合法专家经验工作区
2. deployment harness 能被长程 completion validator 调起并给出标准 acceptance result
3. blank agent 单 session 能根据这版专家经验，从 Excel + Word 模版生成可通过内部小验收的 Word 成品

## 约束

- 不触碰监控线
- 不把 runtime 产物混入 git 提交
- 修改尽量集中在 acceptance framework、generic validators、task-pack 数据层
- 所有 try4 专有信息都尽量下沉为 task-pack 配置，而不是系统代码分支
