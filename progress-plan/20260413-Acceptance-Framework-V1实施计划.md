# 20260413 Acceptance Framework V1 实施计划

更新时间：2026-04-13

## 1. 这次重构要解决什么

当前系统里已经有：

- `acceptancePolicyID`
- `Experience Transaction Gate`
- `verify / regression / post-judge`
- 长程 `validators / summary / candidate package / maintenance request`

但这些能力还没有被统一抽象成真正的 `Acceptance Framework（验收框架）`。

当前真实问题是：

1. `acceptance` 主要还停留在“事务验收”语义。
2. `acceptancePolicyID` 目前主要映射到 `post-judge strategy`，还不是完整的标准对象。
3. 长程和短程没有共享统一的 acceptance 抽象。
4. 更高等级的验收标准，例如：
   - 空白 agent 从零开始
   - 单 session
   - 从头到尾跑完
   还没有作为正式可注册、可调用、可记录的 acceptance 类型接入系统。

这次重构的目标不是增加专用任务执行器，而是把：

`Acceptance（验收）`

升级成整个系统里统一的、抽象的、可插拔的成功判定框架。

---

## 2. 这次重构后的目标状态

### 2.1 核心定义

系统里的任何“是否通过”判断，统一抽象成四个维度：

1. `Acceptance Target`
   - 验收对象是什么
2. `Acceptance Standard`
   - 到底什么叫通过
3. `Acceptance Harness`
   - 用什么执行器去测这个标准
4. `Acceptance Effect`
   - 通过 / 不通过之后系统怎么处理

### 2.2 这次必须支持的 acceptance 层级

- `local`
  - 局部验收
  - 例如 unit compare、局部描述性检查
- `transaction`
  - 事务验收
  - 例如 verify / regression / post-judge / accept / rollback
- `candidate`
  - 候选验收
  - 例如经验候选是否值得进入 canonical 或继续治理
- `deployment`
  - 部署验收
  - 例如“空白 agent 从零开始、单 session、从头到尾跑完”

### 2.3 这次不会做的事

- 不把 deployment acceptance 硬编码成某个任务专用脚本
- 不把 acceptance 变成新的独立大平面
- 不让执行层直接内置某个具体任务的检查逻辑
- 不把 Layer 2 maintainer 和 acceptance framework 重新混在一起

---

## 3. 架构调整原则

### 3.1 不侵入执行层

短程和长程执行层仍然负责：

- 产生结果
- 产生证据
- 产生候选

它们不负责定义“什么叫最终成功”。

### 3.2 验收框架是跨层抽象

Acceptance Framework 不是某个单独执行层，而是统一成功判定框架。

它可以被：

- Layer 1 执行结果
- Layer 2 maintainer 事务
- Layer 3 candidate / promotion
- Layer 4 optimizer 结果

共同调用。

### 3.3 harness 可插拔，standard 可层级化

具体的 compare 脚本、prompt review、regression suite、blank-agent single-session run，都只是 harness。

系统不能把某个 harness 当成 acceptance 本体。

---

## 4. 代码层计划

### 4.1 新增 acceptance-framework 目录

新增：

- `orchestrator/acceptance-framework/contract.ts`
- `orchestrator/acceptance-framework/registry.ts`
- `orchestrator/acceptance-framework/repository.ts`
- `orchestrator/acceptance-framework/run.ts`

职责：

- 定义 acceptance 对象结构
- 注册 acceptance policy / standard / harness
- 统一写 acceptance records
- 统一执行 acceptance plans

### 4.2 扩展 reverse-propagation-control 合同

现有 recipe 的：

- `acceptancePolicyID`

保留，但它不再只表示 post-judge strategy，而是指向完整 acceptance policy。

必要时补充：

- acceptance level
- default harness set
- required outcomes

### 4.3 将现有事务验收挂入 acceptance framework

当前短程里的：

- verify
- regression
- post-judge
- accept / rollback

不废弃，而是重解释为：

- `transaction acceptance harnesses`

也就是说，旧链路继续工作，但输出进入统一 acceptance record。

### 4.4 长程接入 acceptance framework

当前长程里的：

- unit validator
- completion validator
- run summary
- maintenance request

继续保留。

但增加：

- acceptance target
- acceptance level
- acceptance records

让长程不再只停留在“validator passed / maintainer-ready”，而能进入统一验收语义。

### 4.5 增加 deployment acceptance 的抽象类型

先不做任务专用实现。

先把以下抽象挂进去：

- standard id
- harness type id
- required inputs
- allowed readable surfaces
- effect mapping

并提供一个最小的 `blank-agent-single-session` harness 骨架。

这个 harness 第一版只做框架接线与最小 smoke-test，不写任务专用逻辑。

### 4.6 保持 maintainer 纯化

Layer 2 maintainer 只负责：

- 读取维护请求
- 产出经验改动候选

它不直接决定最终 acceptance 标准。

---

## 5. 测试计划

### 5.1 配置与注册层测试

验证：

- acceptance policy 注册合法
- recipe 能正确引用 acceptance policy
- registry 校验能识别新 acceptance 对象

### 5.2 短程回归测试

目标：

- 旧短程方法仍可运行
- transaction acceptance 仍能 accept / retry / rollback
- acceptance records 正确写入

至少覆盖：

- `sequential-refine`
- `add-only`

### 5.3 长程回归测试

目标：

- 旧长程 run 仍可运行
- unit / completion validator 不被破坏
- 长程 acceptance record 能正确落地

使用现有最小长程任务包做 smoke-test。

### 5.4 新 acceptance harness 最小案例

新增一个最小测试案例，只验证：

- deployment acceptance harness 能被注册
- harness 能运行
- harness outcome 能写入 acceptance record
- recipe / runner 能识别这个 acceptance 类型

这个测试案例只验证框架抽象，不做任务专用能力建设。

---

## 6. 成功标准

这次改造完成后，至少要满足：

1. 系统里存在统一的 acceptance framework 合同与 registry。
2. `acceptancePolicyID` 不再只是 post-judge strategy 的别名。
3. 短程与长程都能写统一 acceptance records。
4. 事务验收被收编进统一 acceptance 框架，而不是被推翻。
5. deployment acceptance 作为高等级标准已被系统抽象接纳。
6. 所有变更不依赖某个专用任务脚手架。
7. 现有短程和长程基线测试继续通过。

---

## 7. 风险与控制

### 风险 1：把 acceptance 抽象做得太大，导致短程链路断裂

控制：

- 保留现有 verify / regression / post-judge 逻辑
- 先包一层 framework，而不是一次性重写全部行为

### 风险 2：把 deployment acceptance 做成任务专用器

控制：

- 第一版只落抽象合同和最小 harness 骨架
- 不写任何与特定材料格式强绑定的执行逻辑

### 风险 3：maintainer 再次被污染

控制：

- maintainer 不直接消费 deployment acceptance
- deployment acceptance 只作用于 acceptance framework 与 transaction / governance 出口

---

## 8. 一句话收束

这次不是“再加一个验收脚本”，而是把：

**Acceptance**

从当前的事务后置判断，升级成整个平台统一的、分层的、可插拔的成功判定框架。
