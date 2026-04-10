# 通俗计划：Judge 层与本地 Judge Skill 工具包

## 这次要解决什么问题

现在系统已经有了：

- solve agent
- 经修 agent
- 经验工作区

但“判断”这层还不够独立。

现在的判断很多还散在代码里，或者只是一些局部判断规则，还没有真正形成一套独立系统。

这会带来几个问题：

- 很难给不同项目切换不同判断方式
- 很难给不同反向传播方法接不同判断逻辑
- 很难让经修 agent 明确知道“为什么现在应该修”

所以这次要做的是：

**把判断层独立出来，做成 Soft Judge Agent + 本地 Judge Skill 工具包。**

---

## 新系统大概长什么样

后面系统会变成这样：

1. solve / bootstrap / verify 这些 session 先运行
2. 它们留下标准记录
3. Judge 层读取这些记录
4. Judge 层输出一份统一判断结果
5. 再决定要不要启动经修 agent

也就是说：

**Judge 层处在 worker session 和经修 agent 之间。**

---

## Judge 层内部怎么分

Judge 层分两部分：

### 1. Soft Judge Agent

这是一个专门分析的 agent。

它负责：

- 读取 session 记录
- 读取失败上下文
- 总结失败原因
- 判断是否值得启动经修
- 告诉经修 agent 应该重点看哪里

### 2. Judge Skill 工具包

这是本地的判断工具集合。

每个硬判断工具都做成：

- 一个独立 skill 文件夹
- 一个 `SKILL.md`
- 一个对应的 Python 脚本

这些 skill：

- 不全局暴露
- 不接进全局 skill 系统
- 只把路径暴露给 Soft Judge Agent

这样 Soft Judge Agent 如果需要，就能自己去读说明、运行脚本。

---

## 为什么要用本地 Judge Skill 工具包

因为你前面已经说得很清楚：

- 不同项目的硬判断不一样
- 不能把硬判断永远写死在主流程
- 也不能强迫每个项目都自动跑同一套硬判断

所以最合理的是：

- 把硬判断做成一组本地工具
- Soft Judge Agent 可以自己调用
- 系统再通过一个开关控制：
  - 是只跑 soft judge
  - 还是先自动跑部分 hard judge，再给 soft judge

---

## Judge 的两种模式

这次计划固定成两种模式：

### `soft_only`

- 不自动跑硬判断脚本
- Soft Judge Agent 自己决定要不要调用 Judge Skill

### `soft_plus_hard`

- 系统先自动跑一组指定的硬判断脚本
- 再把结果交给 Soft Judge Agent
- Soft Judge Agent 仍然可以继续自己调用其他 Judge Skill

---

## Judge Skill 工具包会有什么

第一版先做最实用的几类：

### 1. exact-output

作用：

- 读取 `evaluation.json`
- 输出一个更适合 judge 消化的结果摘要

### 2. tool-failures

作用：

- 读取 `tool_failures.json`
- 总结失败工具、失败次数、失败类型

### 3. session-behavior

作用：

- 读取 `events.json` 和 `session_execution_report.md`
- 给出一些行为层摘要
- 例如：
  - 是否大量重复 read
  - 是否有明显空探索
  - 是否存在重复无效行为

每个 skill 后面都可以继续增加，不需要改 Judge 核心。

---

## 文件结构会变成什么样

后面会新增一个目录：

- `auto-evolve/judge-skills/`

里面会有：

- 一个总入口索引文件
- 多个 skill 文件夹

例如：

- `judge-skills/INDEX.md`
- `judge-skills/exact-output/SKILL.md`
- `judge-skills/exact-output/scripts/run.py`
- `judge-skills/tool-failures/SKILL.md`
- `judge-skills/tool-failures/scripts/run.py`
- `judge-skills/session-behavior/SKILL.md`
- `judge-skills/session-behavior/scripts/run.py`

这样 Soft Judge Agent 只要拿到：

- Judge Skill 根目录路径
- `INDEX.md` 路径

就知道有哪些工具、各自大概怎么用。

---

## Soft Judge Agent 会输出什么

Judge 层后面统一只产出两份东西：

### 1. `judge_summary.json`

给系统读。

至少包括：

- failure class
- key issues
- tool issues
- behavior issues
- should start maintainer
- recommended session reports
- suggested workspace targets
- judge mode

### 2. `judge_report.md`

给人和经修 agent 读。

内容是：

- 这次为什么失败
- 行为上哪里有问题
- 有没有明显工具误用
- 为什么建议或不建议启动经修

这样后面 maintainer 就不是直接面对一堆零碎原始记录，而是先看 judge 的统一总结。

---

## 对顺序法会怎么接

当前第一种方法 `sequential-refine` 后面会改成：

1. solve
2. prepare feedback
3. regression-before-maintain
4. pre-judge
5. 如果 judge 建议维护，就启动经修
6. verify / regression / acceptance

也就是说：

**Judge 会插在“失败上下文整理完之后、经修开始之前”。**

---

## 这次实现后的直接价值

如果这次做完，你马上会得到这些好处：

- 判断层终于独立出来
- 硬判断不再硬写死在主流程
- Soft Judge Agent 可以统一分析 session 行为
- 不同项目以后可以换 Judge Skill 工具包
- 不同反向传播方法以后可以换 judge 模式

---

## 这次不会做的事情

这次先不做：

- post-judge 完整收编 acceptance
- judge 权限细分
- judge skill 的全局注册
- 非当前项目的通用 judge marketplace

这次只先把：

**前置 Judge 层 + 本地 Judge Skill 工具包 + 顺序法接入**

先跑通。
