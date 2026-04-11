# auto-evolve 如何对接 OpenCode

## 1. 为什么这部分必须单独看

因为 OpenCode 本身是一套通用 agent 运行环境，  
而 `auto-evolve` 是我们自己的实验系统。

你后面要真正控制系统，必须知道：

- OpenCode 本身能做什么
- 我们自己又额外包了一层什么

## 2. `auto-evolve` 的基本做法

`auto-evolve` 并不是直接自己实现一个 agent。

它的做法是：

1. 先整理任务信息
2. 决定模型、agent、目录、权限、监控参数
3. 调用 OpenCode 的 `run`
4. 接收 JSON 事件流
5. 整理为实验产物

也就是说：

**它是 OpenCode 的实验编排层。**

## 3. `auto-evolve` 传给 OpenCode 的典型内容

通常包括：

- prompt
- 运行目录
- 标题
- 模型
- agent
- variant
- 一组参考路径
- 一组权限路径

## 4. 当前最关键的一点：纯路径模式

这是我们系统和很多普通脚本最不一样的地方之一。

当前主链上，`auto-evolve` 已经尽量改成：

- 不预塞任务文件正文
- 不直接把大量文本文件作为附件交给模型
- 只把路径告诉 OpenCode
- 让 OpenCode agent 自己去 `read` / `list`

所以现在要分清两个概念：

### 4.1 `referencePaths`

作用：

- 告诉系统这次涉及哪些路径
- 用于记录和权限边界

它**不等于**正式附件。

### 4.2 `attachedFiles`

作用：

- 真正会转成 `--file`

这会改变 OpenCode 接收输入的方式。

当前我们主链上通常故意让：

- `attachedFiles = []`

这样才保持“纯路径模式”。

## 5. 我们是如何拿到 OpenCode 输出的

`auto-evolve` 运行 OpenCode 时，会要求：

- `--format json`

所以 OpenCode 运行时的 stdout 会被解析成：

- 事件数组
- 最终 responseText
- toolFailures

之后这些会被整理成：

- `run.json`
- `events.json`
- `response.txt`
- `tool_failures.json`
- `session_execution_report.md`

## 6. 我们额外加了哪些实验层能力

在 OpenCode 之上，我们又加了这些东西：

### 6.1 实验任务封装

例如：

- solve
- bootstrap
- judge
- maintain
- verify
- regression

### 6.2 运行记录标准化

例如：

- session execution report
- session learning log
- task manifest

### 6.3 Judge 层

运行结束后，不是直接就经修，而是可以先过 Judge。

### 6.4 经修 Agent

经修 Agent 不是 OpenCode 自带概念，而是我们在 OpenCode 上建立的经验维护角色。

### 6.5 监控系统

我们现在还额外有：

- 终端监控
- 外部浏览器 dashboard

## 7. 为什么说 OpenCode 是底座，auto-evolve 是实验层

因为像这些能力：

- 经验工作区
- 模板库
- Judge Layer
- 经修 Agent
- 反向传播模块
- 维护回滚
- 基线评分

都不是 OpenCode 原生概念。

这些是我们在 OpenCode 之上搭出来的实验系统。

## 8. 你后面学习时最重要的理解方式

不要把 OpenCode 和 auto-evolve 混成一个东西。

最好的理解方式是：

- OpenCode：负责跑 agent
- auto-evolve：负责组织实验

## 9. 一句话总结

我们现在不是“直接控制模型”，而是：

**通过 `auto-evolve` 去控制 OpenCode，再由 OpenCode 去控制模型和工具。**

