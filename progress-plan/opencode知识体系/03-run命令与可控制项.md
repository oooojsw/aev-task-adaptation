# run 命令与可控制项

## 1. 为什么 run 命令最重要

因为大部分时候，真正启动 OpenCode 工作的入口就是 `run`。

无论你是：

- 新开一次 solve
- 继续一个已有 session
- fork 一个 session
- 指定模型
- 指定 agent
- 指定运行目录

本质都围绕 `run` 展开。

## 2. run 命令大致能控制什么

当前已知最重要的控制项包括：

- `message`
- `command`
- `continue`
- `session`
- `fork`
- `share`
- `model`
- `agent`
- `format`
- `file`
- `attach`
- `password`
- `dir`
- `port`
- `variant`
- `thinking`

## 3. 最常用的一组控制项

### 3.1 `--model`

作用：

- 指定本次运行用哪个模型

这通常是最重要的运行控制之一。

### 3.2 `--agent`

作用：

- 指定本次运行用哪个 agent 配置

### 3.3 `--dir`

作用：

- 指定这次运行在什么目录下工作

这非常重要，因为 agent 对文件系统的大部分感知都和目录有关。

### 3.4 `--title`

作用：

- 给本次 session 一个标题

这个标题后面会直接出现在：

- session 列表
- 监控页
- dashboard

### 3.5 `--format json`

作用：

- 让 OpenCode 以 JSON 事件流方式输出运行过程

这对我们自己的实验系统特别重要，因为我们需要解析：

- `tool_use`
- `text`
- `step_start`
- `step_finish`
- `error`

### 3.6 `--continue`

作用：

- 在最近一次 session 上继续

### 3.7 `--session`

作用：

- 指定某个 session id 继续

### 3.8 `--fork`

作用：

- 基于已有 session 开一个新分支

### 3.9 `--variant`

作用：

- 指定 provider 相关的模型变体或推理强度

例如高推理、低推理、max 等。

### 3.10 `--thinking`

作用：

- 显示 reasoning blocks

要注意：

- 只有 provider 支持时它才真正有意义
- 它也不等于能拿到完整私有思维链

## 4. `--file` 是什么

这是一个很关键的点。

`--file` 表示：

**把文件或目录作为附件传给 OpenCode。**

这里有两个重要事实：

### 4.1 文件和目录都会被识别

- 普通文本文件会变成 `text/plain`
- 目录会变成 `application/x-directory`

### 4.2 这不等于只是传路径

这是特别容易误解的地方。

虽然命令行上看起来只是：

- `--file path`

但对 OpenCode 来说，这代表：

- 这是一个正式附件
- 后续很可能会被进一步转换成模型上下文的一部分

所以：

**`--file` 和“只在 prompt 里告诉它路径”不是一回事。**

## 5. 为什么我们项目现在强调“纯路径模式”

因为如果大量使用 `--file`，很容易让：

- 文件内容被预先塞进模型上下文
- agent 自己不再主动探索文件
- 真正的文件读取行为不再可观测

所以我们当前项目在很多关键环节上已经改成：

- prompt 里给路径
- 运行时记 `referencePaths`
- 不给 `attachedFiles`

这样 OpenCode agent 必须自己 `read` / `list`。

## 6. `attach` 和本地 server 是什么

OpenCode 还支持附着到一个运行中的 server。

这意味着：

- OpenCode 不只是一条本地命令
- 它还支持 client / server 运行形态

不过当前 `auto-evolve` 的主链不是走这个模式。

## 7. 当前我们最常控制的是哪些项

在我们自己的系统里，最常控制的是：

- `model`
- `agent`
- `variant`
- `dir`
- `title`
- `format=json`

而我们当前**刻意避免**使用的是：

- 大量 `--file` 预塞正文

## 8. 一句话总结

`run` 命令是 OpenCode 的主启动器。  
你后面如果要控制 OpenCode，最重要的不是背命令，而是理解：

- 哪些参数控制 session
- 哪些参数控制模型
- 哪些参数控制可观测性
- 哪些参数会改变文件输入方式

