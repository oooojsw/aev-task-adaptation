# OpenCode 总体认识

## 1. OpenCode 是什么

可以把 OpenCode 理解成一个“带工具和 session 管理能力的 agent 运行环境”。

它不是单纯的模型接口封装，也不是一个只有聊天功能的 CLI。

它同时负责：

- 管理 session
- 组织 prompt
- 决定 agent 运行上下文
- 调用工具
- 记录消息和事件
- 处理重试、权限、状态、监控

所以从系统层面看，OpenCode 更像是：

**一个可运行、多 session、带工具调用能力的 agent 操作系统。**

## 2. 我们为什么要专门学习 OpenCode

因为 `auto-evolve` 并不是自己发明了一套 agent。

它做的事情是：

- 把任务整理成 prompt 和路径输入
- 把模型、权限、目录、监控这些运行参数准备好
- 然后交给 OpenCode 去运行
- 再把 OpenCode 跑出来的结果，变成实验产物

所以如果你后面想真正控制系统，你必须清楚：

- OpenCode 能做什么
- Session 是怎么工作的
- 工具调用是怎么发生的
- 我们自己对 OpenCode 加了哪些包装

## 3. OpenCode 在我们系统里的位置

从高层看，关系是这样的：

`auto-evolve 任务系统 -> OpenCode -> 模型 + 工具 + Session -> 产物与记录`

也就是说：

- `auto-evolve` 负责“实验逻辑”
- OpenCode 负责“agent 执行逻辑”

## 4. OpenCode 的核心组成

如果只抓最重要的概念，可以把 OpenCode 看成 5 个部分：

### 4.1 run 命令

这是最常见的入口。

它负责：

- 启动一次运行
- 续接已有 session
- fork 一个新 session
- 指定模型、agent、variant、目录、文件等

### 4.2 session 系统

这是 OpenCode 的长期记忆与运行单位。

一个 session 包含：

- 标题
- 目录
- 时间信息
- 父子关系
- 消息
- 各种 part
- 当前状态

### 4.3 工具系统

OpenCode 的 agent 不只是输出文本，它还会调用工具。

常见工具包括：

- `read`
- `list`
- `glob`
- `grep`
- `edit`
- `write`
- `bash`
- `webfetch`
- `websearch`
- `codesearch`
- `task`
- `skill`
- `todowrite`

### 4.4 事件系统

运行过程中会不断产生事件。

我们现在最关心的事件包括：

- `step_start`
- `step_finish`
- `tool_use`
- `text`
- `reasoning`
- `error`

### 4.5 状态系统

OpenCode 会维护 session 的实时状态。

底层最核心的状态是：

- `idle`
- `busy`
- `retry`

在监控界面里会进一步被整理成：

- `running`
- `retry`
- `done`
- `error`
- `archived`
- `idle`

## 5. 你现在最应该记住的一个事实

OpenCode 不是“一个 prompt 一次性扔给模型然后等结果”的简单工具。

它是：

- 有 session
- 有状态
- 有工具
- 有事件
- 有监控
- 有继续运行和 fork 能力

所以如果你后面要控制它，你真正要理解的是：

**它的运行机制，而不是只记住几个命令。**

